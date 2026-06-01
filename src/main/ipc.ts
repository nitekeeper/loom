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
import { ipcMain } from 'electron';
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
} from '../shared/types.js';
import type { ConfigStore } from './config.js';
import type { LoomDb } from './db.js';
import type { EventBus } from './eventbus.js';
import type { Sandbox } from './sandbox.js';
import type { Search } from './search.js';
import { wsEnabled } from './ws.js';
// Pure (DOM/Node-free) keybinding core — merges persisted user overrides
// over the defaults so the boot snapshot carries the FULL resolved map.
import { resolveBindings } from '../renderer/lib/keybindings.js';

/** Debounce for COUNTERS recompute+push (telemetry tick). */
const COUNTERS_DEBOUNCE_MS = 100;
/** Idle window after which LIVE settles to CAUGHT_UP (FR-36). */
const CAUGHT_UP_IDLE_MS = 4000;

export interface IpcWiring {
  /** Register ipcMain.handle handlers (call once, before window load). */
  register(): void;
  /** Begin pushing events/counters/live-state to the given webContents. */
  attachRenderer(send: (channel: string, payload: unknown) => void): () => void;
}

export interface IpcDeps {
  db: LoomDb;
  sandbox: Sandbox;
  config: ConfigStore;
  bus: EventBus;
  /** Project-wide content search (confined to the sandbox + bounded). */
  search: Search;
}

class IpcWiringImpl implements IpcWiring {
  /** Files written/observed this session (counters.files). */
  private fileCount = 0;
  /** The sticky human-set live state, or null when not paused. */
  private pausedState: LiveState | null = null;
  /** The current auto state (LIVE or CAUGHT_UP). */
  private autoState: LiveState = 'CAUGHT_UP';

  constructor(private readonly deps: IpcDeps) {}

  // --- snapshot builders ---------------------------------------

  private buildAgentViews(): AgentView[] {
    const { db } = this.deps;
    return db.listAgents().map((a): AgentView => {
      // Per-agent unread = receipts addressed to this agent, still unread.
      let unread = 0;
      for (const m of db.listMessages()) {
        for (const r of db.listReceipts(m.id)) {
          if (r.recipient === a.name && r.read_at === null) unread += 1;
        }
      }
      return { name: a.name, status: a.status, unread };
    });
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
    let agents = 0;
    for (const a of db.listAgents()) if (a.status === 'active') agents += 1;
    const channels = db.listChannels().length;
    const messages = db.listMessages();
    let receipts = 0;
    for (const m of messages) receipts += db.listReceipts(m.id).length;
    return {
      agents,
      channels,
      messages: messages.length,
      receipts,
      files: this.fileCount,
    };
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
    });

    // Emit the starting live state once on attach.
    pushLiveState();

    return () => {
      disposed = true;
      unsubscribe();
      if (countersTimer !== null) clearTimeout(countersTimer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      this.onHumanLiveStateChange = null;
    };
  }

  /** Set by attachRenderer so the human's SET_LIVE_STATE pushes immediately. */
  private onHumanLiveStateChange: (() => void) | null = null;

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
