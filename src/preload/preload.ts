/* ============================================================
 * Loom — preload bridge (FR-13, NFR-3, AC-5)
 * ------------------------------------------------------------
 * The ONLY conduit between the hardened renderer (contextIsolation:
 * true, nodeIntegration:false) and the main process. Exposes a
 * minimal, typed `window.loom` (LoomBridge) via contextBridge — and
 * NOTHING else. No raw ipcRenderer, no Node `require`, no process,
 * no Buffer leak to the renderer.
 *
 * Bundled as CJS (format=cjs) because Electron loads preload scripts
 * in a CommonJS sandbox context. 'electron' is external.
 *
 * Threat model: the renderer runs agent-authored, attacker-influenced
 * content (file bodies, chat bodies). It MUST NOT be able to reach any
 * channel other than the 8 frozen IPC constants, and MUST NOT be able
 * to send on a push-only channel. Every method below is hard-pinned to
 * a single constant; there is no caller-supplied channel string.
 * ============================================================ */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/types.js';
import type {
  FileContent,
  FileNode,
  InitialState,
  LiveState,
  LoomBridge,
  LoomEvent,
  SearchQuery,
  SearchResults,
  SessionCounters,
  Theme,
} from '../shared/types.js';

/* ------------------------------------------------------------------ */
/* Channel allow-list — defense in depth.                              */
/* The bridge methods already hard-code their channel constant, so no  */
/* renderer string ever reaches ipcRenderer. This set additionally     */
/* asserts, at module load, that every channel we wire is a known IPC  */
/* constant — a tripwire against a future typo widening the surface.   */
/* ------------------------------------------------------------------ */
const INVOKE_CHANNELS: ReadonlySet<string> = new Set([
  IPC.GET_INITIAL_STATE,
  IPC.READ_FILE,
  IPC.GET_TREE,
  IPC.READ_DIR,
  IPC.SEARCH,
  IPC.SET_THEME,
  IPC.SET_KEYBINDINGS,
  IPC.SET_LIVE_STATE,
  IPC.OPEN_EXTERNAL,
]);

const PUSH_CHANNELS: ReadonlySet<string> = new Set([
  IPC.EVENT,
  IPC.COUNTERS,
  IPC.LIVE_STATE,
]);

/** Assert a channel is the expected, allow-listed constant before use.
 *  Throws (fails closed) rather than silently invoking an unknown name. */
function assertInvoke(channel: string): string {
  if (!INVOKE_CHANNELS.has(channel)) {
    throw new Error(`preload: refusing to invoke unknown channel "${channel}"`);
  }
  return channel;
}
function assertPush(channel: string): string {
  if (!PUSH_CHANNELS.has(channel)) {
    throw new Error(`preload: refusing to subscribe to unknown channel "${channel}"`);
  }
  return channel;
}

/** Subscribe to a main->renderer push channel; return an unsubscribe fn.
 *  The wrapped listener drops the IpcRendererEvent so the renderer never
 *  receives a handle to sender/ports — only the typed payload. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const ch = assertPush(channel);
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    handler(payload);
  };
  ipcRenderer.on(ch, listener);
  return () => {
    ipcRenderer.removeListener(ch, listener);
  };
}

/** Construct the bridge object exposed on window.loom. */
export function createBridge(): LoomBridge {
  return {
    // Host OS, captured from process.platform in this Node-context preload and
    // deep-cloned across the contextBridge so the renderer can adapt chrome
    // (e.g. the macOS hiddenInset title bar) WITHOUT any access to `process`.
    // Read-only string; exposing it widens no privilege (ADDITIVE — FR-35).
    platform: process.platform,
    getInitialState(): Promise<InitialState> {
      return ipcRenderer.invoke(assertInvoke(IPC.GET_INITIAL_STATE));
    },
    readFile(filePath: string): Promise<FileContent> {
      // The path is forwarded as-is; the main-process sandbox is the
      // authority on containment (Law 3). The renderer cannot widen scope.
      return ipcRenderer.invoke(assertInvoke(IPC.READ_FILE), filePath);
    },
    getTree(): Promise<FileNode> {
      return ipcRenderer.invoke(assertInvoke(IPC.GET_TREE));
    },
    readDir(dirPath: string): Promise<FileNode[]> {
      // The path is forwarded as-is; the main-process sandbox is the authority
      // on containment (Law 3). The renderer cannot widen scope.
      return ipcRenderer.invoke(assertInvoke(IPC.READ_DIR), dirPath);
    },
    search(q: SearchQuery): Promise<SearchResults> {
      // The query is forwarded as-is; the main-process sandbox is the authority
      // on containment (Law 3). The renderer cannot widen scope.
      return ipcRenderer.invoke(assertInvoke(IPC.SEARCH), q);
    },
    setTheme(theme: Theme): Promise<void> {
      return ipcRenderer.invoke(assertInvoke(IPC.SET_THEME), theme);
    },
    setKeybindings(map: Record<string, string>): Promise<void> {
      return ipcRenderer.invoke(assertInvoke(IPC.SET_KEYBINDINGS), map);
    },
    setLiveState(state: LiveState): Promise<void> {
      return ipcRenderer.invoke(assertInvoke(IPC.SET_LIVE_STATE), state);
    },
    openExternal(url: string): Promise<void> {
      return ipcRenderer.invoke(assertInvoke(IPC.OPEN_EXTERNAL), url);
    },
    onEvent(handler: (e: LoomEvent) => void): () => void {
      return subscribe<LoomEvent>(IPC.EVENT, handler);
    },
    onCounters(handler: (c: SessionCounters) => void): () => void {
      return subscribe<SessionCounters>(IPC.COUNTERS, handler);
    },
    onLiveState(handler: (s: LiveState) => void): () => void {
      return subscribe<LiveState>(IPC.LIVE_STATE, handler);
    },
  };
}

// Expose the SOLE privileged surface. contextBridge deep-clones across
// the isolated-world boundary, so the renderer receives a frozen copy
// with no prototype access back into preload/Node (FR-13, NFR-3, AC-5).
contextBridge.exposeInMainWorld('loom', createBridge());
