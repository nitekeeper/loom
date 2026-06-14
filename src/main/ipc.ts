/* ============================================================
 * Loom — IPC handlers + live-feed pump (FR-13, FR-14, FR-29/30)
 * ------------------------------------------------------------
 * Wires the preload bridge channels (shared/types IPC constants)
 * to main-process capability:
 *   - GET_INITIAL_STATE -> snapshot from db + sandbox + config
 *   - READ_FILE         -> sandbox.readFile (dispatch + content)
 *   - GET_TREE          -> sandbox.buildTree
 *   - SET_THEME         -> config.setTheme
 *   - SET_LIVE_STATE    -> live state machine
 * and pumps EVENT / COUNTERS / LIVE_STATE pushes to the renderer
 * by subscribing to the event bus.
 *
 * Live state machine (FR-36):
 *   - LIVE      while events are flowing
 *   - CAUGHT_UP after an idle window (~4s) with no events
 *   - PAUSED    when the human set it via SET_LIVE_STATE; PAUSED is
 *               sticky — it overrides LIVE/CAUGHT_UP until unset.
 * ============================================================ */
import { clipboard, ipcMain, shell } from 'electron';
import {
  IPC,
  type FileNode,
  type InitialState,
  type LiveState,
  type LoomEvent,
  type Theme,
  type AgentView,
  type ChannelView,
  type MessageView,
  type ReceiptView,
  type SessionCounters,
  type SearchQuery,
  type SearchResults,
  type GitFileStatus,
  type ChangeSet,
  type FileDiff,
  type TerminalOpenResult,
} from '../shared/types.js';
import { getGitStatus } from './git.js';
import {
  getChanges,
  getFileDiff,
  listChangesWithBase,
  resolveFileDiffRequest,
} from './git-diff.js';
import { removeAgentByName, clearStaleAgents, isStaleAgent } from './engine.js';
import type { ConfigStore } from './config.js';
import type { TerminalManager } from './terminal.js';
import type { LoomDb } from './db.js';
import type { EventBus } from './eventbus.js';
import type { Sandbox } from './sandbox.js';
import type { Search } from './search.js';
import { wsEnabled } from './ws.js';
// Pure (DOM/Node-free) keybinding core — merges persisted user overrides
// over the defaults so the boot snapshot carries the FULL resolved map.
import { resolveBindings } from '../renderer/lib/keybindings.js';
import { safeExternalUrl } from '../shared/url.js';

/** Debounce for COUNTERS recompute+push (telemetry tick). */
const COUNTERS_DEBOUNCE_MS = 100;
/** Idle window after which LIVE settles to CAUGHT_UP (FR-36). */
const CAUGHT_UP_IDLE_MS = 4000;
/** Hard cap (chars) on either clipboard field. Bounds a runaway / hostile
 *  serialize so a single copy cannot push multi-megabyte blobs at the OS
 *  clipboard. A real rendered .md doc is orders of magnitude below this. */
const MAX_CLIPBOARD_CHARS = 5_000_000;

export interface IpcWiring {
  /** Register ipcMain.handle handlers (call once, before window load). */
  register(): void;
  /** Begin pushing events/counters/live-state to the given webContents. */
  attachRenderer(send: (channel: string, payload: unknown) => void): () => void;
  /** Nudge a counters recompute+push OUTSIDE the bus. The MCP session reaper
   *  evicts sessions without publishing any bus event, yet eviction changes
   *  staleAgents — without this nudge the count froze at its last pushed
   *  value (dead chips beside a disabled "clear stale (0)"). Debounced
   *  exactly like every bus-driven counters push; a no-op when no renderer
   *  is attached. */
  nudgeCounters(): void;
}

export interface IpcDeps {
  db: LoomDb;
  sandbox: Sandbox;
  config: ConfigStore;
  bus: EventBus;
  /** Project-wide content search (confined to the sandbox + bounded). */
  search: Search;
  /** Absolute path of the sandbox root (for git status). */
  rootPath: string;
  /** The connection_ids bound to currently-LIVE MCP sessions (from
   *  McpServerHandle.liveConnectionIds). The stale-agent sweep + the
   *  staleAgents counter consult this; OPTIONAL and fail-soft — when absent
   *  (degraded boot with no MCP server, or tests) the live set is empty,
   *  which is CORRECT: with no agent transport, no agent can be live. */
  liveConnectionIds?: () => ReadonlySet<string>;
  /** The human-invoked terminal pane's PTY session manager (loom:terminal:*). */
  terminal: TerminalManager;
}

class IpcWiringImpl implements IpcWiring {
  /** Files written/observed this session (counters.files). */
  private fileCount = 0;
  /** The sticky human-set live state, or null when not paused. */
  private pausedState: LiveState | null = null;
  /** The current auto state (LIVE or CAUGHT_UP). */
  private autoState: LiveState = 'CAUGHT_UP';
  /** Debounce timer for git status pushes (300ms after a file event). */
  private gitDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: IpcDeps) {}

  // --- snapshot builders ---------------------------------------

  private buildAgentViews(): AgentView[] {
    const { db } = this.deps;
    // One GROUP BY over the partial unread index (O(unread)) instead of an
    // O(agents × messages × receipts) nested scan — the latter froze window
    // open as history grew and, fired on the counter tick, stalled every agent.
    const unread = db.unreadCountsByRecipient();
    // Deregistered ('gone') agents stay in the db (history + name-collision
    // accounting) but are NOT surfaced to the roster: a long project cycles
    // many agents and their names would otherwise stack up and bury the chat.
    return db
      .listAgents()
      .filter((a) => a.status === 'active')
      .map((a): AgentView => ({
        name: a.name,
        status: a.status,
        unread: unread.get(a.name) ?? 0,
      }));
  }

  private buildChannelViews(): ChannelView[] {
    const { db } = this.deps;
    return db.listChannels().map((c): ChannelView => {
      const members = db.listMemberships(c.id).map((m) => m.agent_name);
      const messageCount = db.listMessages(c.id).length;
      return { id: c.id, name: c.name, members, messageCount };
    });
  }

  private buildMessageViews(): MessageView[] {
    const { db } = this.deps;
    const channelName = new Map<number, string>();
    for (const c of db.listChannels()) channelName.set(c.id, c.name);
    return db.listMessages().map((m): MessageView => {
      const receipts: ReceiptView[] = db
        .listReceipts(m.id)
        .map((r): ReceiptView => ({ recipient: r.recipient, read_at: r.read_at }));
      return {
        id: m.id,
        channel: channelName.get(m.channel_id) ?? '',
        channelId: m.channel_id,
        sender: m.sender,
        body: m.body,
        addressing: m.addressing,
        target: m.target,
        created_at: m.created_at,
        receipts,
      };
    });
  }

  private computeCounters(): SessionCounters {
    const { db } = this.deps;
    // Aggregate counts only — the former version did listMessages() + one
    // listReceipts() per message (O(messages × receipts)) on every ~100ms tick,
    // synchronously blocking every agent's tool call. Now: an O(1) message
    // count + three single COUNT(*) queries.
    return {
      agents: db.countActiveAgents(),
      channels: db.listChannels().length,
      messages: db.countMessages(),
      receipts: db.countReceipts(),
      files: this.fileCount,
      // Drives the roster's "clear stale (N)" button: gone rows ∪ actives
      // with no live session — the SAME isStaleAgent definition the sweep
      // applies, over the SAME live-session set, so the count always equals
      // what the button would remove. Counters are pushed on every bus event
      // (remove/clear/deregister/register all publish), so it stays
      // authoritative without the renderer guessing from AgentEvents.
      staleAgents: db.listAgents().filter((a) => isStaleAgent(a, this.liveIds()))
        .length,
    };
  }

  /** Live MCP session connection_ids (empty when no MCP server — correct:
   *  with no agent transport nothing can be live). */
  private liveIds(): ReadonlySet<string> {
    return this.deps.liveConnectionIds?.() ?? new Set<string>();
  }

  private buildInitialState(): InitialState {
    const { sandbox, config } = this.deps;
    const cfg = config.read();
    return {
      rootName: sandbox.rootName,
      theme: cfg.theme,
      liveState: this.currentLiveState(),
      tree: sandbox.buildTree(),
      agents: this.buildAgentViews(),
      channels: this.buildChannelViews(),
      messages: this.buildMessageViews(),
      counters: this.computeCounters(),
      wsEnabled: wsEnabled(),
      // Resolve the persisted user OVERRIDES over the defaults so the
      // renderer receives the full commandId -> combo map (mirror of theme).
      keybindings: resolveBindings(cfg.keybindings),
      // Boot the renderer with the persisted terminal-pane count. The config
      // coercer already clamped it to [1,3] (default 1) on read — mirror of
      // theme: main is the single source of truth, the renderer just renders.
      terminalCount: cfg.terminalCount ?? 1,
    };
  }

  /** Resolved live state: human PAUSED is sticky and overrides auto. */
  private currentLiveState(): LiveState {
    return this.pausedState ?? this.autoState;
  }

  // --- request/response handlers -------------------------------

  register(): void {
    const { sandbox, config, search } = this.deps;

    ipcMain.handle(IPC.GET_INITIAL_STATE, (): InitialState => this.buildInitialState());

    ipcMain.handle(IPC.READ_FILE, (_evt, relPath: string) => sandbox.readFile(relPath));

    ipcMain.handle(IPC.GET_TREE, (): FileNode => sandbox.buildTree());

    ipcMain.handle(
      IPC.READ_DIR,
      (_evt, relPath: string): FileNode[] => sandbox.listDir(relPath),
    );

    ipcMain.handle(
      IPC.SEARCH,
      (_evt, query: SearchQuery): SearchResults => search.run(query),
    );

    ipcMain.handle(IPC.SET_THEME, (_evt, theme: Theme): void => {
      config.setTheme(theme);
    });

    ipcMain.handle(
      IPC.SET_KEYBINDINGS,
      (_evt, map: Record<string, string>): void => {
        config.setKeybindings(map);
      },
    );

    ipcMain.handle(IPC.SET_LIVE_STATE, (_evt, state: LiveState): void => {
      // The human can PAUSE (sticky) or release back to the auto machine.
      this.setHumanLiveState(state);
    });

    ipcMain.handle(IPC.OPEN_EXTERNAL, async (_evt, url: unknown): Promise<void> => {
      // RE-VALIDATE in main — never trust the renderer. Only an http/https/mailto
      // URL is ever handed to the OS; dangerous schemes (javascript:/file:/data:)
      // and non-strings are dropped silently. The renderer already vets links,
      // this is the authoritative gate.
      const safe = typeof url === 'string' ? safeExternalUrl(url) : null;
      if (safe !== null) await shell.openExternal(safe);
    });

    ipcMain.handle(IPC.COPY_TO_CLIPBOARD, (_evt, payload: unknown): boolean => {
      // RE-VALIDATE in main — never trust the renderer. Accept ONLY an object
      // with string `html` + `text`, each within the size cap; anything else is
      // a DROPPED write (return false) — the authoritative gate (mirror of
      // OPEN_EXTERNAL). The renderer has already allowlist-rebuilt + link-vetted
      // the html, but the clipboard is a privileged surface so we still bound the
      // shape here. We return whether we WROTE so the renderer gives honest UI
      // feedback (no "Copied" affordance on a dropped/oversize write).
      if (typeof payload !== 'object' || payload === null) return false;
      const { html, text } = payload as { html?: unknown; text?: unknown };
      if (typeof html !== 'string' || typeof text !== 'string') return false;
      if (html.length > MAX_CLIPBOARD_CHARS || text.length > MAX_CLIPBOARD_CHARS) return false;
      clipboard.write({ text, html });
      return true;
    });

    ipcMain.handle(IPC.GIT_STATUS, async (): Promise<Record<string, GitFileStatus>> => {
      const map = await getGitStatus(this.deps.rootPath);
      return Object.fromEntries(map);
    });

    // List every file changed vs. the base merge-base — committed branch work
    // UNION uncommitted working-tree changes (staged + unstaged + untracked).
    // main resolves rootPath itself — the renderer passes NO directory.
    // Fail-soft inside getChanges (never throws).
    ipcMain.handle(IPC.GET_CHANGES, (): Promise<ChangeSet> =>
      getChanges(this.deps.rootPath),
    );

    // HUMAN roster curation (UI-only — no MCP tool counterpart). main is the
    // authority: removeAgentByName RE-VALIDATES the renderer-supplied name
    // (string, trimmed non-empty, <= MAX_NAME_LENGTH, existing row) and is
    // fail-soft (false / 0, never a throw). Both delete the agents row(s) +
    // memberships/receipts while PRESERVING messages, and publish the same
    // 'gone' AgentEvent deregister publishes so the roster updates live.
    ipcMain.handle(IPC.REMOVE_AGENT, (_evt, name: unknown): boolean =>
      removeAgentByName(this.deps.db, this.deps.bus, name),
    );

    // Sweep STALE agents: gone rows ∪ actives with no live MCP session bound
    // (the dead chips the human actually sees — kaizen field report). A LIVE
    // connected agent is never swept. The whole sweep runs synchronously on
    // the event loop, so it cannot race a register() (which claims the row +
    // binds the session in one synchronous unit).
    ipcMain.handle(IPC.CLEAR_STALE_AGENTS, (): number =>
      clearStaleAgents(this.deps.db, this.deps.bus, this.liveIds()),
    );

    // The before->after unified diff for ONE changed file. SECURITY (Law 3):
    // `git show <sha>:<path>` reads git's OBJECT STORE, which bypasses the fs
    // sandbox — so we RE-CONFINE the renderer-supplied path (and a rename's
    // oldPath) via sandbox.resolveInRoot BEFORE any git read. A resolveInRoot
    // throw (escape / NUL / '..' / absolute / symlink) is caught and returned as
    // an empty FileDiff, so an out-of-root path can NEVER reach git. main stays
    // authoritative: it re-resolves the base to a SHA (no ref name flows into a
    // content command) and re-derives this file's changeKind/binary from a fresh
    // listing rather than trusting the renderer's shape.
    ipcMain.handle(
      IPC.READ_FILE_DIFF,
      async (_evt, relPath: unknown): Promise<FileDiff> => {
        if (typeof relPath !== 'string') {
          return {
            path: '',
            oldPath: null,
            changeKind: 'modified',
            binary: false,
            truncated: false,
            hunks: [],
          };
        }

        // Re-derive this file's row from the authoritative listing AND reuse the
        // merge-base SHA it already resolved (no second resolveBaseSha — main
        // stays authoritative without the redundant base resolution per expand).
        const { changeSet, mergeBase } = await listChangesWithBase(
          this.deps.rootPath,
        );

        // The find-by-path short-circuit, the Law-3 confine of path+oldPath
        // (sandbox.resolveInRoot — `git show/diff <sha>:<path>` reads the object
        // store, bypassing the fs sandbox), the catch→empty branch, and the
        // base-resolved guard all live in the PURE resolveFileDiffRequest so
        // production and the unit suite run the SAME decision. We inject the
        // Electron-bound sandbox gate + getFileDiff reader here.
        return resolveFileDiffRequest({
          changeSet,
          relPath,
          mergeBase,
          confine: (p) => this.deps.sandbox.resolveInRoot(p),
          readDiff: (rel, mb, kind, oldPath, binary) =>
            getFileDiff(this.deps.rootPath, rel, mb, kind, oldPath, binary),
        });
      },
    );

    // Terminal pane (loom:terminal:*): each handler delegates the RAW unknown
    // payload to the PURE session manager, which is the authoritative
    // re-validation gate (types, the per-spawn sessionId token, the
    // MAX_TERMINAL_INPUT_BYTES cap, cols/rows ranges — never trust the
    // renderer; unit-pinned in test/terminal.mjs). Invalid/stale input is a
    // silent no-op; a failed spawn returns { sessionId: null } (unavailable).
    ipcMain.handle(
      IPC.TERMINAL_OPEN,
      (_evt, p: unknown): TerminalOpenResult => this.deps.terminal.open(p),
    );
    ipcMain.handle(IPC.TERMINAL_INPUT, (_evt, p: unknown): void => this.deps.terminal.input(p));
    ipcMain.handle(IPC.TERMINAL_RESIZE, (_evt, p: unknown): void => this.deps.terminal.resize(p));
    ipcMain.handle(IPC.TERMINAL_CLOSE, (_evt, p: unknown): void => this.deps.terminal.close(p));

    // Persist the desired terminal-pane COUNT (layout state, not a PTY control —
    // no sessionId). main is the authority: pass only a finite number through to
    // config.setTerminalCount, which CLAMPS to [1,3] (default 1 on garbage);
    // anything not a number is dropped to the default so a hostile renderer can
    // never persist an out-of-range/typed-wrong value. Mirror of SET_THEME.
    ipcMain.handle(IPC.TERMINAL_SET_LAYOUT, (_evt, count: unknown): void => {
      config.setTerminalCount(typeof count === 'number' ? count : 1);
    });
  }

  // --- renderer pump -------------------------------------------

  attachRenderer(send: (channel: string, payload: unknown) => void): () => void {
    let countersTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const pushLiveState = (): void => {
      if (disposed) return;
      send(IPC.LIVE_STATE, this.currentLiveState());
    };

    const pushCounters = (): void => {
      if (countersTimer !== null) return;
      countersTimer = setTimeout(() => {
        countersTimer = null;
        if (disposed) return;
        send(IPC.COUNTERS, this.computeCounters());
      }, COUNTERS_DEBOUNCE_MS);
      (countersTimer as { unref?: () => void }).unref?.();
    };

    const armIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (disposed) return;
        // Idle window elapsed with no events -> settle to CAUGHT_UP.
        this.autoState = 'CAUGHT_UP';
        // Only surface the change when not human-paused.
        if (this.pausedState === null) pushLiveState();
      }, CAUGHT_UP_IDLE_MS);
      (idleTimer as { unref?: () => void }).unref?.();
    };

    // Allow SET_LIVE_STATE (human) to drive a push immediately.
    this.onHumanLiveStateChange = pushLiveState;
    // Allow out-of-bus sources (the MCP session reaper) to drive a counters
    // recompute+push — same debounce as the bus-driven path.
    this.onCountersNudge = pushCounters;

    // Terminal output/exit pushes flow to THIS renderer (the manager's
    // coalesced TERMINAL_DATA / TERMINAL_EXIT pump). Detached on dispose so
    // pushes stop after the renderer goes away (unit-pinned: detach => silence).
    const detachTerminal = this.deps.terminal.attachSink(send);

    const unsubscribe = this.deps.bus.subscribe((e: LoomEvent) => {
      if (disposed) return;
      // Fan every event out to the renderer (FR-29).
      send(IPC.EVENT, e);
      // Track session file activity for counters.
      if (e.kind === 'file') {
        if (e.action === 'add' || e.action === 'change') this.fileCount += 1;
      }
      // Events are flowing -> LIVE (unless the human has paused).
      const wasAuto = this.autoState;
      this.autoState = 'LIVE';
      if (this.pausedState === null && wasAuto !== 'LIVE') pushLiveState();
      armIdle();
      pushCounters();
      if (e.kind === 'file') this.pushGitStatus(send, () => disposed);
    });

    // Emit the starting live state once on attach.
    pushLiveState();

    // Push the initial git status on attach.
    void getGitStatus(this.deps.rootPath).then((map) => {
      if (disposed) return;
      send(IPC.GIT_STATUS, Object.fromEntries(map));
    });

    return () => {
      disposed = true;
      unsubscribe();
      detachTerminal();
      if (countersTimer !== null) clearTimeout(countersTimer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (this.gitDebounceTimer !== null) {
        clearTimeout(this.gitDebounceTimer);
        this.gitDebounceTimer = null;
      }
      this.onHumanLiveStateChange = null;
      this.onCountersNudge = null;
    };
  }

  nudgeCounters(): void {
    this.onCountersNudge?.();
  }

  /** Set by attachRenderer so the human's SET_LIVE_STATE pushes immediately. */
  private onHumanLiveStateChange: (() => void) | null = null;
  /** Set by attachRenderer so out-of-bus sources (the MCP reaper) can drive a
   *  debounced counters recompute+push (see IpcWiring.nudgeCounters). */
  private onCountersNudge: (() => void) | null = null;

  private pushGitStatus(
    send: (channel: string, payload: unknown) => void,
    isDisposed: () => boolean,
  ): void {
    if (this.gitDebounceTimer !== null) clearTimeout(this.gitDebounceTimer);
    this.gitDebounceTimer = setTimeout(() => {
      this.gitDebounceTimer = null;
      if (isDisposed()) return;
      void getGitStatus(this.deps.rootPath).then((map) => {
        if (isDisposed()) return;
        send(IPC.GIT_STATUS, Object.fromEntries(map));
      });
    }, 300);
    (this.gitDebounceTimer as { unref?: () => void }).unref?.();
  }

  private setHumanLiveState(state: LiveState): void {
    if (state === 'PAUSED') {
      this.pausedState = 'PAUSED';
    } else {
      // Releasing the pause: adopt the requested live/caught-up state and
      // hand control back to the auto machine.
      this.pausedState = null;
      this.autoState = state === 'LIVE' ? 'LIVE' : 'CAUGHT_UP';
    }
    this.onHumanLiveStateChange?.();
  }
}

export function createIpcWiring(deps: IpcDeps): IpcWiring {
  return new IpcWiringImpl(deps);
}
