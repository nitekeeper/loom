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
  InitialState,
  LiveState,
  LoomEvent,
  MessageView,
  ReceiptView,
  SessionCounters,
  Theme,
} from '../../shared/types.js';
import { diffOverrides } from './keybindings.js';

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
    const messages = [...current.messages, view];
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
    const existing = current.agents.find((x) => x.name === a.name);
    let agents: AgentView[];
    if (existing) {
      agents = current.agents.map((x) =>
        x.name === a.name ? { ...x, status: a.status } : x,
      );
    } else {
      agents = [...current.agents, { name: a.name, status: a.status, unread: 0 }];
    }
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
    if (e.action === 'add') {
      newlyAdded.add(path);
    } else if (e.action === 'change') {
      justModified.add(path);
    } else if (e.action === 'unlink') {
      // A removed file drops all of its activity markers.
      flashing.delete(path);
      justModified.delete(path);
      newlyAdded.delete(path);
    }

    // Schedule expiry timers (transient affordances, FR-39).
    const clearTimer = (key: string): void => {
      const t = timers.get(key);
      if (t) clearTimeout(t);
    };
    if (e.action !== 'unlink') {
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
    if (e.action === 'add') {
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
    return { ...current, flashing, justModified, newlyAdded, counters };
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
  };

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  const selectFile = (path: string): void => {
    set({ selected: path });
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
