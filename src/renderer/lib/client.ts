/* ============================================================
 * Loom — renderer-side state client
 * ------------------------------------------------------------
 * Thin wrapper around window.loom (LoomBridge) that the React tree
 * consumes. Fetches the InitialState snapshot, subscribes to the
 * live event feed / counters / live-state, and reduces incoming
 * LoomEvents into the in-memory view models (FR-14: renderer
 * derives all state from main — single source of truth, NFR-8).
 *
 * The store is immutable-snapshot + useSyncExternalStore-friendly:
 * every mutation replaces the top-level object so React can do a
 * cheap referential equality check. UI-local state (selected file,
 * active channel, open inbox) lives in the SAME snapshot so the
 * whole tree re-renders from one source.
 *
 * --capture hints: location.search may carry `select`, `channel`,
 * and `inbox` to drive deterministic screenshots; we apply them as
 * the initial selection / active channel / open inbox.
 * ============================================================ */
import type {
  AgentView,
  ChannelView,
  FileNode,
  InitialState,
  LiveState,
  LoomEvent,
  MessageView,
  ReceiptView,
  SessionCounters,
  Theme,
  GitFileStatus,
} from '../../shared/types.js';
import { diffOverrides } from './keybindings.js';
import { MAX_STORE_MESSAGES } from './window.js';
import { insertNode, removeNode, makeNode } from './filetree.js';

/** Capture hints parsed from location.search (used by --capture). */
export interface CaptureHints {
  /** Root-relative file path to pre-select in the Explorer/Viewer. */
  select: string | null;
  /** Channel name to make active in the Chat pane. */
  channel: string | null;
  /** Agent name whose inbox lens should be opened on boot. */
  inbox: string | null;
  /** Capture-only initial theme override ('dark' | 'light'), or null. */
  theme: Theme | null;
}

/** The full immutable view-model the React tree renders from. It is a
 *  superset of InitialState (so getSnapshot stays contract-compatible)
 *  plus renderer-local UI state. Every field is replaced wholesale on
 *  each reduce so reference identity tracks change. */
export interface ViewModel extends InitialState {
  /** Currently selected file path (root-relative POSIX), or null. */
  selected: string | null;
  /** Active channel name in the Chat pane. */
  activeChannel: string | null;
  /** Agent name whose inbox lens is open, or null for the thread view. */
  inboxAgent: string | null;
  /** Paths flashing from a recent FileEvent (transient, FR-39b). */
  flashing: ReadonlySet<string>;
  /** Paths recently modified — persistent "just modified" dot (FR-39c). */
  justModified: ReadonlySet<string>;
  /** Paths that appeared this session — NEW badge (FR-39a). */
  newlyAdded: ReadonlySet<string>;
  /** Git working-tree status map (path -> status). Persists until committed. */
  gitStatus: ReadonlyMap<string, GitFileStatus>;
  /** Monotonic revision for the SELECTED file's content. Bumped whenever the
   *  open file changes on disk (a change/add FileEvent for `selected`) or the
   *  user (re-)selects a file. The Viewer's content hook re-reads on every bump
   *  so a file edited by an agent (or re-opened) shows its fresh contents. */
  fileRev: number;
}

export interface LoomStore {
  /** Contract-frozen accessor (InitialState | null). */
  getSnapshot(): InitialState | null;
  /** Full view-model accessor used by the renderer tree. */
  getViewModel(): ViewModel | null;
  subscribe(listener: () => void): () => void;
  /** Begin: fetch initial state + attach feed listeners. */
  start(): Promise<void>;

  /* ---- observer actions (read-only navigation, FR-37/45/47/50) ---- */
  /** Lazily load a directory's children (one level) and merge them into the
   *  tree. Idempotent: a no-op if the dir is already loaded or a load is in
   *  flight. Called when the user expands a folder in the Explorer. */
  loadDir(path: string): void;
  selectFile(path: string): void;
  /** Dismiss the open file → return the Viewer to the empty state (FR-42). */
  closeFile(): void;
  setActiveChannel(name: string): void;
  openInbox(agentName: string): void;
  closeInbox(): void;
  /** Persist + apply theme via the bridge (FR-37, AC-20). */
  setTheme(theme: Theme): Promise<void>;
  /** Persist + apply the RESOLVED keyboard bindings: optimistically update
   *  the view-model, then write the sparse user-override map through the
   *  bridge (mirror of setTheme). The caller passes the full resolved map;
   *  this action persists only the entries differing from defaults. */
  setKeybindings(resolved: Record<string, string>): Promise<void>;
  /** Toggle PAUSED <-> LIVE through the main process (FR-36). */
  togglePause(): Promise<void>;
}

/** How long a row-flash persists after a FileEvent (ms). */
const FLASH_MS = 2400;
/** How long the "just modified" dot lingers after a change (ms). */
const JUST_MODIFIED_MS = 12_000;
/** How long the NEW badge lingers after a file is added (ms). */
const NEW_MS = 18_000;

function parseCaptureHints(search: string): CaptureHints {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    params = new URLSearchParams();
  }
  const rawTheme = params.get('theme');
  const theme: Theme | null =
    rawTheme === 'dark' || rawTheme === 'light' ? rawTheme : null;
  return {
    select: params.get('select'),
    channel: params.get('channel'),
    inbox: params.get('inbox'),
    theme,
  };
}

/** Strip a leading "/" so a hint path matches root-relative tree paths. */
function normalizePath(p: string): string {
  return p.replace(/^\/+/, '');
}

export function createStore(): LoomStore {
  let vm: ViewModel | null = null;
  const listeners = new Set<() => void>();
  const disposers: Array<() => void> = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const hints = parseCaptureHints(
    typeof location !== 'undefined' ? location.search : '',
  );

  const emit = (): void => {
    for (const l of listeners) l();
  };

  /** Replace the snapshot with a patched copy and notify subscribers. */
  const set = (patch: Partial<ViewModel>): void => {
    if (vm === null) return;
    vm = { ...vm, ...patch };
    emit();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  /* ---------------------------------------------------------------- */
  /* Reducers — fold a single LoomEvent into the immutable view model */
  /* ---------------------------------------------------------------- */

  const reduceMessage = (current: ViewModel, e: LoomEvent): ViewModel => {
    if (e.kind !== 'message') return current;
    const m = e.message;
    // De-dupe by id (a re-published event must not double-insert).
    if (current.messages.some((x) => x.id === m.id)) return current;
    const receipts: ReceiptView[] = e.recipients.map((recipient) => ({
      recipient,
      read_at: null,
    }));
    const view: MessageView = {
      id: m.id,
      channel: e.channel,
      channelId: m.channel_id,
      sender: m.sender,
      body: m.body,
      addressing: m.addressing,
      target: m.target,
      created_at: m.created_at,
      receipts,
    };
    // Bound the in-memory transcript so a marathon multi-agent session can't
    // grow the renderer process without limit (the full history stays in the
    // main-process db). Keeping only the newest N also bounds the per-event
    // filter+sort the Chat pane runs over this array. Drop oldest-first; the
    // thread already renders just the latest DEFAULT_RENDER_WINDOW of these.
    const appended = [...current.messages, view];
    const messages =
      appended.length > MAX_STORE_MESSAGES
        ? appended.slice(appended.length - MAX_STORE_MESSAGES)
        : appended;
    // Bump the channel's visible message count (FR-47).
    const channels = current.channels.map((c) =>
      c.id === m.channel_id ? { ...c, messageCount: c.messageCount + 1 } : c,
    );
    // Each recipient gains an unread (FR-28, FR-46).
    const recipientSet = new Set(e.recipients);
    const agents = current.agents.map((a) =>
      recipientSet.has(a.name) ? { ...a, unread: a.unread + 1 } : a,
    );
    return { ...current, messages, channels, agents };
  };

  const reduceAgent = (current: ViewModel, e: LoomEvent): ViewModel => {
    if (e.kind !== 'agent') return current;
    const a = e.agent;
    // A DEREGISTERED ('gone') agent is REMOVED from the roster so deregistered
    // names don't stack up and bury the chat over a long project. History is
    // untouched — the message thread still shows that agent's past messages by
    // sender name; the db keeps the row for name-collision accounting.
    if (a.status === 'gone') {
      if (!current.agents.some((x) => x.name === a.name)) return current;
      return { ...current, agents: current.agents.filter((x) => x.name !== a.name) };
    }
    const existing = current.agents.find((x) => x.name === a.name);
    const agents: AgentView[] = existing
      ? current.agents.map((x) => (x.name === a.name ? { ...x, status: a.status } : x))
      : [...current.agents, { name: a.name, status: a.status, unread: 0 }];
    return { ...current, agents };
  };

  const reduceChannel = (current: ViewModel, e: LoomEvent): ViewModel => {
    if (e.kind !== 'channel') return current;
    const ch = e.channel;
    const existing = current.channels.find((c) => c.id === ch.id);
    let channels: ChannelView[];
    if (existing) {
      channels = current.channels.map((c) =>
        c.id === ch.id ? { ...c, name: ch.name, members: e.members } : c,
      );
    } else {
      channels = [
        ...current.channels,
        { id: ch.id, name: ch.name, members: e.members, messageCount: 0 },
      ];
    }
    // Adopt the first channel as active if none chosen yet.
    const activeChannel = current.activeChannel ?? ch.name;
    return { ...current, channels, activeChannel };
  };

  const reduceReceipt = (current: ViewModel, e: LoomEvent): ViewModel => {
    if (e.kind !== 'receipt') return current;
    const r = e.receipt;
    let changedRecipient: string | null = null;
    const messages = current.messages.map((m) => {
      if (m.id !== r.message_id) return m;
      const receipts = m.receipts.map((rc) => {
        if (rc.recipient !== r.recipient) return rc;
        if (rc.read_at === null && r.read_at !== null) changedRecipient = r.recipient;
        return { ...rc, read_at: r.read_at };
      });
      return { ...m, receipts };
    });
    // A receipt transitioning to read decrements that agent's unread.
    let agents = current.agents;
    if (changedRecipient !== null) {
      const name = changedRecipient;
      agents = current.agents.map((a) =>
        a.name === name && a.unread > 0 ? { ...a, unread: a.unread - 1 } : a,
      );
    }
    return { ...current, messages, agents };
  };

  const reduceFile = (current: ViewModel, e: LoomEvent): ViewModel => {
    if (e.kind !== 'file') return current;
    const path = e.path;
    const flashing = new Set(current.flashing);
    flashing.add(path);
    const justModified = new Set(current.justModified);
    const newlyAdded = new Set(current.newlyAdded);
    if (e.action === 'add' || e.action === 'addDir') {
      newlyAdded.add(path);
    } else if (e.action === 'change') {
      justModified.add(path);
    } else if (e.action === 'unlink' || e.action === 'unlinkDir') {
      // A removed file/dir drops all of its activity markers.
      flashing.delete(path);
      justModified.delete(path);
      newlyAdded.delete(path);
    }

    // Keep the lazily-loaded FileNode tree in sync so a file/folder created (or
    // deleted) in an ALREADY-EXPANDED directory appears (or disappears)
    // immediately, not only after a relaunch. Insert into LOADED dirs only — a
    // collapsed dir re-reads from disk on expand (filetree helpers are no-ops
    // for an unloaded/absent parent).
    let tree = current.tree;
    if (e.action === 'add') tree = insertNode(tree, makeNode(path, false));
    else if (e.action === 'addDir') tree = insertNode(tree, makeNode(path, true));
    else if (e.action === 'unlink' || e.action === 'unlinkDir') tree = removeNode(tree, path);

    // Schedule expiry timers (transient affordances, FR-39).
    const clearTimer = (key: string): void => {
      const t = timers.get(key);
      if (t) clearTimeout(t);
    };
    if (e.action !== 'unlink' && e.action !== 'unlinkDir') {
      clearTimer(`flash:${path}`);
      timers.set(
        `flash:${path}`,
        setTimeout(() => {
          if (vm === null) return;
          const next = new Set(vm.flashing);
          next.delete(path);
          set({ flashing: next });
        }, FLASH_MS),
      );
    }
    if (e.action === 'change') {
      clearTimer(`mod:${path}`);
      timers.set(
        `mod:${path}`,
        setTimeout(() => {
          if (vm === null) return;
          const next = new Set(vm.justModified);
          next.delete(path);
          set({ justModified: next });
        }, JUST_MODIFIED_MS),
      );
    }
    if (e.action === 'add' || e.action === 'addDir') {
      clearTimer(`new:${path}`);
      timers.set(
        `new:${path}`,
        setTimeout(() => {
          if (vm === null) return;
          const next = new Set(vm.newlyAdded);
          next.delete(path);
          set({ newlyAdded: next });
        }, NEW_MS),
      );
    }

    const counters: SessionCounters = {
      ...current.counters,
      files: current.counters.files + (e.action === 'add' ? 1 : 0),
    };

    // If the file the user is VIEWING just changed (or was re-created) on disk,
    // bump fileRev so the Viewer's content hook re-reads it — fixing stale
    // contents after an agent edits the open file.
    const fileRev =
      e.path === current.selected && (e.action === 'change' || e.action === 'add')
        ? current.fileRev + 1
        : current.fileRev;

    return { ...current, tree, flashing, justModified, newlyAdded, counters, fileRev };
  };

  const reduce = (current: ViewModel, e: LoomEvent): ViewModel => {
    switch (e.kind) {
      case 'message':
        return reduceMessage(current, e);
      case 'agent':
        return reduceAgent(current, e);
      case 'channel':
        return reduceChannel(current, e);
      case 'receipt':
        return reduceReceipt(current, e);
      case 'file':
        return reduceFile(current, e);
      default:
        return current;
    }
  };

  // Events that arrived while PAUSED, replayed in order on resume so no
  // observed activity is lost when the human un-freezes the feed (FR-36).
  const pausedBuffer: LoomEvent[] = [];

  const onEvent = (e: LoomEvent): void => {
    if (vm === null) return;
    // PAUSED freezes the live VIEW for the human observer: buffer the event
    // (do not drop it) so the view stays a faithful catch-up on resume.
    if (vm.liveState === 'PAUSED') {
      pausedBuffer.push(e);
      return;
    }
    const next = reduce(vm, e);
    if (next !== vm) {
      vm = next;
      emit();
    }
  };

  /** Drain buffered events into the view model (called on resume). */
  const flushPaused = (): void => {
    if (vm === null || pausedBuffer.length === 0) return;
    let next = vm;
    for (const e of pausedBuffer) next = reduce(next, e);
    pausedBuffer.length = 0;
    vm = next;
    emit();
  };

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  const start = async (): Promise<void> => {
    const initial = await window.loom.getInitialState();
    const initialChannel =
      hints.channel ??
      (initial.channels.length > 0 ? (initial.channels[0]?.name ?? null) : null);
    vm = {
      ...initial,
      // Capture-only: ?theme overrides the persisted initial theme so a
      // single deterministic screenshot can pin dark/light (AC-20).
      theme: hints.theme ?? initial.theme,
      selected: hints.select !== null ? normalizePath(hints.select) : null,
      activeChannel: initialChannel,
      inboxAgent: hints.inbox,
      flashing: new Set<string>(),
      justModified: new Set<string>(),
      newlyAdded: new Set<string>(),
      gitStatus: new Map<string, GitFileStatus>(),
      fileRev: 0,
    };
    emit();

    disposers.push(window.loom.onEvent(onEvent));
    disposers.push(
      window.loom.onCounters((c: SessionCounters) => {
        if (vm === null) return;
        // Live counters from main override the locally-derived tallies.
        set({ counters: c });
      }),
    );
    disposers.push(
      window.loom.onLiveState((s: LiveState) => {
        if (vm === null) return;
        const wasPaused = vm.liveState === 'PAUSED';
        set({ liveState: s });
        // Catch up on anything buffered while the view was frozen.
        if (wasPaused && s !== 'PAUSED') flushPaused();
      }),
    );
    disposers.push(
      window.loom.onGitStatus((s) => {
        if (vm === null) return;
        set({ gitStatus: new Map(Object.entries(s)) });
      }),
    );
    // Populate initial git status
    void window.loom.getGitStatus().then((s) => {
      if (vm === null) return;
      set({ gitStatus: new Map(Object.entries(s)) });
    });
  };

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  // Paths whose lazy READ_DIR is in flight, so a double-expand (click + key)
  // can't fire two concurrent fetches.
  const dirLoadsInFlight = new Set<string>();

  /** Find a node by its root-relative path in the (possibly shallow) tree. */
  const findNode = (node: FileNode, targetPath: string): FileNode | null => {
    if (node.path === targetPath) return node;
    for (const child of node.children ?? []) {
      const found = findNode(child, targetPath);
      if (found) return found;
    }
    return null;
  };

  /** Immutably set `children` (and loaded:true) on the dir at `targetPath`,
   *  returning a new tree (or the same reference when nothing changed so React
   *  can skip the subtree). */
  const withChildren = (
    node: FileNode,
    targetPath: string,
    children: FileNode[],
  ): FileNode => {
    if (node.path === targetPath) {
      return { ...node, children, loaded: true };
    }
    if (!node.children) return node;
    let changed = false;
    const next = node.children.map((child) => {
      const updated = withChildren(child, targetPath, children);
      if (updated !== child) changed = true;
      return updated;
    });
    return changed ? { ...node, children: next } : node;
  };

  const loadDir = (path: string): void => {
    if (vm === null) return;
    if (dirLoadsInFlight.has(path)) return;
    const node = findNode(vm.tree, path);
    // Only load real, not-yet-loaded directories.
    if (node === null || node.type !== 'dir' || node.loaded === true) return;
    dirLoadsInFlight.add(path);
    void window.loom
      .readDir(path)
      .then((children) => {
        dirLoadsInFlight.delete(path);
        if (vm === null) return;
        set({ tree: withChildren(vm.tree, path, children) });
      })
      .catch(() => {
        // A vanished/again-unreadable dir: clear the in-flight guard so a
        // later retry can re-attempt. The folder simply stays empty.
        dirLoadsInFlight.delete(path);
      });
  };

  const selectFile = (path: string): void => {
    // Always bump fileRev — even re-selecting the SAME path forces the Viewer
    // to re-read from disk, so reopening a file an agent edited shows the fresh
    // contents (not a cached render of the old text).
    set({ selected: path, fileRev: (vm?.fileRev ?? 0) + 1 });
  };

  // Dismiss the open file: set UI-local `selected` back to null so the Viewer
  // re-renders its empty "Select a file to view it" state (FR-42). Mirrors
  // selectFile's set()+emit() path; no main-process round-trip (selection is
  // renderer-local UI state, not part of the frozen InitialState contract).
  const closeFile = (): void => {
    set({ selected: null });
  };

  const setActiveChannel = (name: string): void => {
    // Switching channels also leaves any open inbox lens.
    set({ activeChannel: name, inboxAgent: null });
  };

  const openInbox = (agentName: string): void => {
    set({ inboxAgent: agentName });
  };

  const closeInbox = (): void => {
    set({ inboxAgent: null });
  };

  const setTheme = async (theme: Theme): Promise<void> => {
    set({ theme });
    await window.loom.setTheme(theme);
  };

  // Optimistically apply the full resolved bindings to the view-model, then
  // persist ONLY the sparse overrides (entries differing from defaults)
  // through the bridge — mirror of setTheme. The renderer dispatcher reads
  // vm.keybindings, so the optimistic update takes effect immediately.
  const setKeybindings = async (
    resolved: Record<string, string>,
  ): Promise<void> => {
    set({ keybindings: resolved });
    await window.loom.setKeybindings(diffOverrides(resolved));
  };

  const togglePause = async (): Promise<void> => {
    if (vm === null) return;
    const wasPaused = vm.liveState === 'PAUSED';
    const next: LiveState = wasPaused ? 'LIVE' : 'PAUSED';
    // Optimistic local flip; main echoes the authoritative value back.
    set({ liveState: next });
    // Resuming: replay everything buffered while frozen.
    if (wasPaused) flushPaused();
    await window.loom.setLiveState(next);
  };

  return {
    getSnapshot: () => vm,
    getViewModel: () => vm,
    subscribe,
    start,
    loadDir,
    selectFile,
    closeFile,
    setActiveChannel,
    openInbox,
    closeInbox,
    setTheme,
    setKeybindings,
    togglePause,
  };
}
