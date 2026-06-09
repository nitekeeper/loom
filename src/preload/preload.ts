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
 * channel other than the frozen IPC constants enumerated in the
 * INVOKE_CHANNELS / PUSH_CHANNELS allow-lists below, and MUST NOT be able
 * to send on a push-only channel. Every method below is hard-pinned to
 * a single constant; there is no caller-supplied channel string. (No
 * literal channel COUNT is stated here on purpose — it would silently
 * drift from the sets as channels are added.)
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
  WindowBounds,
  GitFileStatus,
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
  IPC.COPY_TO_CLIPBOARD,
  IPC.WINDOW_MINIMIZE,
  IPC.WINDOW_TOGGLE_MAXIMIZE,
  IPC.WINDOW_CLOSE,
  IPC.WINDOW_IS_MAXIMIZED,
  IPC.WINDOW_GET_BOUNDS,
  IPC.WINDOW_SET_BOUNDS,
  IPC.GIT_STATUS,
]);

const PUSH_CHANNELS: ReadonlySet<string> = new Set([
  IPC.EVENT,
  IPC.COUNTERS,
  IPC.LIVE_STATE,
  IPC.WINDOW_MAXIMIZED,
  IPC.GIT_STATUS,
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
    copyToClipboard(payload: { html: string; text: string }): Promise<boolean> {
      // The payload is forwarded as-is; main is the authority — it RE-VALIDATES
      // the {html, text} shape and bounds the size before touching the OS
      // clipboard (never trust the renderer; mirror of openExternal). main
      // returns whether it WROTE (false = dropped/oversize) so the renderer can
      // give honest feedback instead of a false-positive "Copied".
      return ipcRenderer.invoke(assertInvoke(IPC.COPY_TO_CLIPBOARD), payload);
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
    getGitStatus(): Promise<Record<string, GitFileStatus>> {
      return ipcRenderer.invoke(assertInvoke(IPC.GIT_STATUS));
    },
    onGitStatus(handler: (s: Record<string, GitFileStatus>) => void): () => void {
      return subscribe<Record<string, GitFileStatus>>(IPC.GIT_STATUS, handler);
    },
    // Frameless custom-chrome window controls (win32/linux). Each method hard-
    // pins its single IPC.* constant via assertInvoke and sends NO arguments —
    // main resolves the target window from the SENDER, so a renderer cannot act
    // on any window but its own. onMaximizeChange reuses the same subscribe()
    // helper (assertPush) every other push uses, so the renderer never receives
    // the IpcRendererEvent — only the boolean payload.
    windowControls: {
      minimize(): Promise<void> {
        return ipcRenderer.invoke(assertInvoke(IPC.WINDOW_MINIMIZE));
      },
      toggleMaximize(): Promise<void> {
        return ipcRenderer.invoke(assertInvoke(IPC.WINDOW_TOGGLE_MAXIMIZE));
      },
      close(): Promise<void> {
        return ipcRenderer.invoke(assertInvoke(IPC.WINDOW_CLOSE));
      },
      isMaximized(): Promise<boolean> {
        // Pull the authoritative state on mount so the renderer seeds its glyph
        // deterministically instead of relying on the fire-and-forget initial
        // WINDOW_MAXIMIZED push (which can race past a not-yet-attached listener).
        return ipcRenderer.invoke(assertInvoke(IPC.WINDOW_IS_MAXIMIZED));
      },
      onMaximizeChange(cb: (maximized: boolean) => void): () => void {
        return subscribe<boolean>(IPC.WINDOW_MAXIMIZED, cb);
      },
      getBounds(): Promise<WindowBounds> {
        // Read the SENDER window's live screen rectangle at resize-drag start.
        // No args; main resolves the target from the sender (own window only).
        return ipcRenderer.invoke(assertInvoke(IPC.WINDOW_GET_BOUNDS));
      },
      setBounds(b: WindowBounds): Promise<void> {
        // The bounds are forwarded as-is; main is the authority — it RE-VALIDATES
        // x/y/width/height as finite integers and CLAMPS the size before applying
        // (never trust the renderer; mirror of openExternal/copyToClipboard).
        return ipcRenderer.invoke(assertInvoke(IPC.WINDOW_SET_BOUNDS), b);
      },
    },
  };
}

// Expose the SOLE privileged surface. contextBridge deep-clones across
// the isolated-world boundary, so the renderer receives a frozen copy
// with no prototype access back into preload/Node (FR-13, NFR-3, AC-5).
contextBridge.exposeInMainWorld('loom', createBridge());
