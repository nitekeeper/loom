/* ============================================================
 * Loom — App shell (FR-34, AC-17)
 * ------------------------------------------------------------
 * The window root: a CSS grid of rows `auto auto 1fr` —
 * TitleBar (chrome) / StatusBar (chrome) / body of three content
 * panes (Explorer | Viewer | Chat), plus an OPTIONAL bottom-dock
 * terminal row spanning all three columns (status-bar toggle /
 * Ctrl|Cmd+`, resizable via a row splitter, maximizable, session
 * killed on close — a human-invoked surface, never agent-reachable).
 * Owns top-level UI state: selected file, active channel, theme,
 * derived from the LoomStore (FR-14 single source of truth).
 * ============================================================ */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  CSSProperties,
  JSX,
  PointerEvent as ReactPointerEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { FileContent, Theme } from '../../shared/types.js';
import { createStore } from '../lib/client.js';
import type { LoomStore, ViewModel } from '../lib/client.js';
import { decideEscapeClose } from '../lib/closefile.js';
import { eventToCombo, isReserved, resolveBindings } from '../lib/keybindings.js';
import type { CommandId } from '../lib/keybindings.js';
import { TitleBar } from './TitleBar.js';
import { WindowResizeHandles } from './WindowResizeHandles.js';
import { StatusBar } from './StatusBar.js';
import { Explorer } from './Explorer.js';
import { SearchView } from './SearchView.js';
import { ChangesView } from './ChangesView.js';
import { Viewer } from './Viewer.js';
import { Chat } from './Chat.js';
import { ShortcutsPanel } from './ShortcutsPanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import { TerminalPane } from './TerminalPane.js';
import {
  clampTerminalHeight,
  terminalHeightMax,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_HEIGHT_KEY,
  TERMINAL_HEIGHT_STEP,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_OPEN_KEY,
} from '../lib/terminal-pane.js';
import {
  readInitialMdWidth,
  persistMdWidth,
  toggleWidthMode,
  MD_WIDTH_ANNOUNCE_FIT,
  MD_WIDTH_ANNOUNCE_FULL,
} from '../lib/md-width.js';
import type { WidthMode } from '../lib/md-width.js';
import {
  clampSplitRatio,
  coerceStoredRatio,
  paneForSelection,
  effectiveActivePane,
  activePaneOnSplitOn,
  isSplitRendered,
  nudgeRatio,
  VIEWER_DIVIDER_W,
  VIEWER_SPLIT_DEFAULT,
  VIEWER_SPLIT_KEY,
  VIEWER_SPLIT_RATIO_KEY,
} from '../lib/viewer-split.js';
import type { ActivePane } from '../lib/viewer-split.js';
import { installGlobalAnchorGuard } from '../lib/anchor-guard.js';

/** Subscribe a React component to the store via useSyncExternalStore. */
function useViewModel(store: LoomStore): ViewModel | null {
  return useSyncExternalStore(store.subscribe, store.getViewModel, store.getViewModel);
}

/** Resolve FileContent for the selected path via the readFile bridge.
 *  Returns null while empty or loading; ignores stale responses. Re-reads
 *  whenever `rev` bumps (the open file changed on disk, or was re-selected) so
 *  the Viewer never shows stale contents after an agent edits the file. */
function useFileContent(selected: string | null, rev: number): FileContent | null {
  const [content, setContent] = useState<FileContent | null>(null);
  // Track the latest request so an out-of-order resolve can't clobber state.
  const requestId = useRef(0);

  useEffect(() => {
    if (selected === null) {
      setContent(null);
      return;
    }
    const id = ++requestId.current;
    let cancelled = false;
    void window.loom
      .readFile(selected)
      .then((c) => {
        if (!cancelled && id === requestId.current) setContent(c);
      })
      .catch(() => {
        if (!cancelled && id === requestId.current) setContent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, rev]);

  return content;
}

/** True when an event target is a text-editable element (input, textarea, or
 *  a contenteditable host). Used to NOT hijack Ctrl/Cmd+B when the user is
 *  editing text — future text fields keep native bold (A11Y-EXP-05). The chat
 *  is read-only for the human today, so this is a forward-safety guard. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/* ============================================================
 * Chat-pane resize (FR-54 / WCAG 2.4.7, 2.1.1)
 * ------------------------------------------------------------
 * The Chat pane is horizontally resizable via a splitter on its
 * LEFT edge (Viewer/Chat boundary). The center Viewer (`1fr`)
 * absorbs the delta; the Explorer stays fixed. Width is driven by
 * the `--chat-w` custom property on `.body`, clamped so the Viewer
 * never collapses, persisted in localStorage, and overridable by a
 * capture-only `?chatw` URL hint for headless verification.
 * ============================================================ */

/** Persisted localStorage key for the chat collapsed state ("1"/"0"). */
const CHAT_HIDDEN_KEY = 'loom-chat-hidden';
/** Persisted localStorage key for the chat-pane width (px). */
const CHAT_WIDTH_KEY = 'loom-chat-width';
/** Default chat width when nothing is persisted (matches the CSS fallback). */
const CHAT_WIDTH_DEFAULT = 400;
/** Hard minimum chat width (px) — keeps the chat usable. */
const CHAT_WIDTH_MIN = 300;
/** Keyboard nudge step (px) for ArrowLeft / ArrowRight. */
const CHAT_WIDTH_STEP = 24;

/** Floor reserved for the center Viewer so the Explorer + Chat at their maxes
 *  can never starve it to ~0px (UX-2). Each pane's max subtracts the sibling
 *  pane's CURRENT width and this floor, so the three always coexist. */
const VIEWER_MIN = 320;

/** Read the current width (px) the OTHER resizable pane occupies, from the
 *  live custom property on `.body`. Returns 0 when the Explorer is collapsed
 *  (its column is dropped), or its default when unread/pre-mount. Window-
 *  relative maxes use this so neither pane can starve the Viewer (UX-2). */
function siblingWidth(prop: '--explorer-w' | '--chat-w', fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const body = document.querySelector('.body');
  if (prop === '--explorer-w' && body?.classList.contains('explorer-hidden')) {
    return 0; // collapsed → the Explorer track is gone, frees its space
  }
  if (prop === '--chat-w' && body?.classList.contains('chat-hidden')) {
    return 0; // collapsed → the Chat track is gone, frees its space
  }
  if (body instanceof HTMLElement) {
    const raw = getComputedStyle(body).getPropertyValue(prop).trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

/** Upper bound: never wider than 720px, never more than 60% of the window,
 *  AND never so wide that the Explorer's current width + the Viewer floor are
 *  squeezed out. Recomputed on every clamp so window resize is honored (UX-2). */
function chatWidthMax(): number {
  const vw =
    typeof window !== 'undefined' && window.innerWidth > 0
      ? window.innerWidth
      : 1440;
  const explorer = siblingWidth('--explorer-w', EXPLORER_WIDTH_DEFAULT);
  const siblingBudget = vw - explorer - VIEWER_MIN;
  return Math.min(720, Math.round(vw * 0.6), siblingBudget);
}

/** Clamp a candidate width to [MIN, MAX]. MAX is window-relative. */
function clampChatWidth(w: number): number {
  const max = Math.max(CHAT_WIDTH_MIN, chatWidthMax());
  return Math.min(max, Math.max(CHAT_WIDTH_MIN, w));
}

/** Read the capture-only `?chatw=<px>` hint, or null when absent/invalid.
 *  Parallel to the existing select/channel/inbox/theme capture hints; this
 *  one is read here (not in the store) since width is renderer-local UI. */
function readChatWidthHint(): number | null {
  if (typeof location === 'undefined') return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return null;
  }
  const raw = params.get('chatw');
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Read the persisted width from localStorage, or null when unset/invalid. */
function readPersistedChatWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(CHAT_WIDTH_KEY);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Read the capture-only `?chathidden` hint (presence ⇒ collapsed), or null
 *  when absent so localStorage/default can take over. Mirror of the explorer
 *  hidden-hint reader. */
function readChatHiddenHint(): boolean | null {
  if (typeof location === 'undefined') return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return null;
  }
  if (!params.has('chathidden')) return null;
  const raw = params.get('chathidden');
  // `?chathidden` (no value) or `=1`/`=true` ⇒ hidden; `=0`/`=false` ⇒ shown.
  return raw !== '0' && raw !== 'false';
}

/** Read the persisted chat collapsed state from localStorage, or null when
 *  unset. Mirror of readPersistedExplorerHidden. */
function readPersistedChatHidden(): boolean | null {
  try {
    const raw = window.localStorage.getItem(CHAT_HIDDEN_KEY);
    if (raw === null) return null;
    return raw === '1';
  } catch {
    return null;
  }
}

/** Compute the initial chat collapsed state: capture hint wins, else
 *  persisted, else shown (default). */
function initialChatHidden(): boolean {
  const hint = readChatHiddenHint();
  if (hint !== null) return hint;
  const persisted = readPersistedChatHidden();
  if (persisted !== null) return persisted;
  return false;
}

/** Compute the initial chat width: capture hint wins, else persisted, else
 *  default — all clamped to the current window. */
function initialChatWidth(): number {
  const hint = readChatWidthHint();
  if (hint !== null) return clampChatWidth(hint);
  const persisted = readPersistedChatWidth();
  if (persisted !== null) return clampChatWidth(persisted);
  return clampChatWidth(CHAT_WIDTH_DEFAULT);
}

/** Manage the resizable chat width: state + persistence + window-resize
 *  re-clamp. Returns the live width and a clamped+persisting setter. */
function useChatWidth(): {
  width: number;
  setWidth: (next: number, persist: boolean) => void;
} {
  // Lazy init so the hint/localStorage read happens once, pre-paint.
  const [width, setWidthState] = useState<number>(() => initialChatWidth());

  const setWidth = useCallback((next: number, persist: boolean): void => {
    const clamped = clampChatWidth(next);
    setWidthState(clamped);
    if (persist) {
      try {
        window.localStorage.setItem(CHAT_WIDTH_KEY, String(clamped));
      } catch {
        /* localStorage may be unavailable; width still applies in-session. */
      }
    }
  }, []);

  // Re-clamp when the window shrinks so the Viewer never collapses.
  useEffect(() => {
    const onResize = (): void => {
      setWidthState((w) => clampChatWidth(w));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { width, setWidth };
}

/* ============================================================
 * Explorer-pane resize + collapse (FR-54 / WCAG 2.4.7, 2.1.1)
 * ------------------------------------------------------------
 * Mirror of the chat resize on the OPPOSITE (left) edge: a splitter
 * on the Explorer's RIGHT edge (Explorer/Viewer boundary). The center
 * Viewer (`1fr`) absorbs the delta; the Chat stays fixed. Width is
 * driven by the `--explorer-w` custom property on `.body`, clamped so
 * neither pane collapses, persisted in localStorage, and overridable
 * by a capture-only `?explorerw` URL hint for headless verification.
 * The Explorer is also collapsible (StatusBar toggle / Ctrl|Cmd+B),
 * persisted via `?explorerhidden` / localStorage.
 * ============================================================ */

/** Persisted localStorage key for the explorer-pane width (px). */
const EXPLORER_WIDTH_KEY = 'loom-explorer-width';
/** Default explorer width when nothing is persisted (matches the CSS fallback). */
const EXPLORER_WIDTH_DEFAULT = 248;
/** Hard minimum explorer width (px) — keeps the tree usable. */
const EXPLORER_WIDTH_MIN = 180;
/** Keyboard nudge step (px) for ArrowLeft / ArrowRight. */
const EXPLORER_WIDTH_STEP = 24;
/** Persisted localStorage key for the explorer collapsed state ("1"/"0"). */
const EXPLORER_HIDDEN_KEY = 'loom-explorer-hidden';

/** Upper bound: never wider than 480px, never more than 40% of the window, AND
 *  never so wide that the Chat's current width + the Viewer floor are squeezed
 *  out. Recomputed on every clamp so window resize is honored (UX-2). */
function explorerWidthMax(): number {
  const vw =
    typeof window !== 'undefined' && window.innerWidth > 0
      ? window.innerWidth
      : 1440;
  const chat = siblingWidth('--chat-w', CHAT_WIDTH_DEFAULT);
  const siblingBudget = vw - chat - VIEWER_MIN;
  return Math.min(480, Math.round(vw * 0.4), siblingBudget);
}

/** Clamp a candidate width to [MIN, MAX]. MAX is window-relative. */
function clampExplorerWidth(w: number): number {
  const max = Math.max(EXPLORER_WIDTH_MIN, explorerWidthMax());
  return Math.min(max, Math.max(EXPLORER_WIDTH_MIN, w));
}

/** Read the capture-only `?explorerw=<px>` hint, or null when absent/invalid. */
function readExplorerWidthHint(): number | null {
  if (typeof location === 'undefined') return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return null;
  }
  const raw = params.get('explorerw');
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Read the capture-only `?explorerhidden` hint (presence ⇒ collapsed), or
 *  null when absent so localStorage/default can take over. */
function readExplorerHiddenHint(): boolean | null {
  if (typeof location === 'undefined') return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return null;
  }
  if (!params.has('explorerhidden')) return null;
  const raw = params.get('explorerhidden');
  // `?explorerhidden` (no value) or `=1`/`=true` ⇒ hidden; `=0`/`=false` ⇒ shown.
  return raw !== '0' && raw !== 'false';
}

/** Read the persisted explorer width from localStorage, or null when unset. */
function readPersistedExplorerWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(EXPLORER_WIDTH_KEY);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Read the persisted collapsed state from localStorage, or null when unset. */
function readPersistedExplorerHidden(): boolean | null {
  try {
    const raw = window.localStorage.getItem(EXPLORER_HIDDEN_KEY);
    if (raw === null) return null;
    return raw === '1';
  } catch {
    return null;
  }
}

/** Compute the initial explorer width: capture hint wins, else persisted, else
 *  default — all clamped to the current window. */
function initialExplorerWidth(): number {
  const hint = readExplorerWidthHint();
  if (hint !== null) return clampExplorerWidth(hint);
  const persisted = readPersistedExplorerWidth();
  if (persisted !== null) return clampExplorerWidth(persisted);
  return clampExplorerWidth(EXPLORER_WIDTH_DEFAULT);
}

/** Compute the initial collapsed state: capture hint wins, else persisted,
 *  else shown (default). */
function initialExplorerHidden(): boolean {
  const hint = readExplorerHiddenHint();
  if (hint !== null) return hint;
  const persisted = readPersistedExplorerHidden();
  if (persisted !== null) return persisted;
  return false;
}

/** Manage the resizable explorer width: state + persistence + window-resize
 *  re-clamp. Mirror of useChatWidth. */
function useExplorerWidth(): {
  width: number;
  setWidth: (next: number, persist: boolean) => void;
} {
  const [width, setWidthState] = useState<number>(() => initialExplorerWidth());

  const setWidth = useCallback((next: number, persist: boolean): void => {
    const clamped = clampExplorerWidth(next);
    setWidthState(clamped);
    if (persist) {
      try {
        window.localStorage.setItem(EXPLORER_WIDTH_KEY, String(clamped));
      } catch {
        /* localStorage may be unavailable; width still applies in-session. */
      }
    }
  }, []);

  // Re-clamp when the window shrinks so the Viewer never collapses.
  useEffect(() => {
    const onResize = (): void => {
      setWidthState((w) => clampExplorerWidth(w));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { width, setWidth };
}

/* ============================================================
 * Terminal-dock resize + open state (bottom row, FR-54 idiom)
 * ------------------------------------------------------------
 * Mirror of the chat resize rotated 90°: the optional terminal dock
 * is a SECOND `.body` grid row spanning all three columns, resized
 * via a horizontal splitter on its TOP edge. Height is driven by the
 * `--terminal-h` custom property on `.body`, clamped by the pure
 * helpers in lib/terminal-pane.ts (min 120px, max 80% of the body),
 * and persisted in localStorage; the open state persists too.
 * Maximize is session-only.
 * ============================================================ */

/** Read the live `.body` height (px) for the terminal-height clamp, falling
 *  back to the window height pre-mount so the lazy init never divides by a
 *  zero-height body. */
function bodyHeightNow(): number {
  if (typeof document !== 'undefined') {
    const body = document.querySelector('.body');
    if (body instanceof HTMLElement && body.clientHeight > 0) {
      return body.clientHeight;
    }
  }
  return typeof window !== 'undefined' && window.innerHeight > 0
    ? window.innerHeight
    : 800;
}

/** Clamp a candidate dock height against the CURRENT body height. */
function clampTerminalHeightNow(h: number): number {
  return clampTerminalHeight(h, bodyHeightNow());
}

/** Read the persisted dock height from localStorage, or null when unset. */
function readPersistedTerminalHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(TERMINAL_HEIGHT_KEY);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Compute the initial dock height: persisted, else default — clamped. */
function initialTerminalHeight(): number {
  const persisted = readPersistedTerminalHeight();
  if (persisted !== null) return clampTerminalHeightNow(persisted);
  return clampTerminalHeightNow(TERMINAL_DEFAULT_HEIGHT);
}

/** Read the persisted dock open state, or null when unset (default closed). */
function readPersistedTerminalOpen(): boolean | null {
  try {
    const raw = window.localStorage.getItem(TERMINAL_OPEN_KEY);
    if (raw === null) return null;
    return raw === '1';
  } catch {
    return null;
  }
}

/** Compute the initial dock open state: persisted, else closed (default). */
function initialTerminalOpen(): boolean {
  return readPersistedTerminalOpen() ?? false;
}

/** Manage the resizable terminal-dock height: state + persistence +
 *  window-resize re-clamp. Mirror of useChatWidth on the row axis. */
function useTerminalHeight(): {
  height: number;
  setHeight: (next: number, persist: boolean) => void;
} {
  // Lazy init so the localStorage read happens once, pre-paint.
  const [height, setHeightState] = useState<number>(() => initialTerminalHeight());

  const setHeight = useCallback((next: number, persist: boolean): void => {
    const clamped = clampTerminalHeightNow(next);
    setHeightState(clamped);
    if (persist) {
      try {
        window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(clamped));
      } catch {
        /* localStorage may be unavailable; height still applies in-session. */
      }
    }
  }, []);

  // Re-clamp when the window shrinks so the columns above never collapse.
  useEffect(() => {
    const onResize = (): void => {
      setHeightState((h) => clampTerminalHeightNow(h));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { height, setHeight };
}

/* ============================================================
 * Split reading pane (center track, vertical split — FR-54 idiom)
 * ------------------------------------------------------------
 * The VERTICAL analog of the bottom-dock terminal pane: when split
 * is ON the center Viewer track divides into two reading panes
 * (left | divider | right) so two documents can be compared side by
 * side. The split is driven by the `--viewer-split` custom property
 * on `.body` (the left pane's fraction of the splittable width),
 * clamped by the pure helpers in lib/viewer-split.ts so neither pane
 * collapses; the ratio AND the on/off state persist in localStorage.
 * Default is a SINGLE pane (split off) — byte-for-byte today.
 * ============================================================ */

/** Read the live splittable center-track width (px) for the split-ratio clamp.
 *  Prefers the REAL two-pane `.viewer-split-wrap` (the FULL center track the two
 *  panes share) when split is mounted; else the single `.pane.viewer`; else the
 *  window width pre-mount — so the lazy init / first toggle never divides by a
 *  zero-width or half-width track. (querySelector on `.pane.viewer` would return
 *  the LEFT pane in a split, which is only half the track — the wrap is the right
 *  host.) The `:not(.viewer-split-wrap--solo)` guard SKIPS the solo (full-width
 *  diff, split OFF) wrap: it has NO divider column, so the VIEWER_DIVIDER_W
 *  subtraction in viewerSplitWidthNow() would wrongly shave 8px off the true
 *  track. Skipping it falls through to the `.pane.viewer` branch (the diff pane
 *  IS a `.pane.viewer.changes`), which measures the full track with no divider to
 *  charge — closing the latent gap if a future caller clamps the ratio in the
 *  solo diff state (css-nit). */
function viewerWidthNow(): number {
  if (typeof document !== 'undefined') {
    const wrap = document.querySelector(
      '.viewer-split-wrap:not(.viewer-split-wrap--solo)',
    );
    if (wrap instanceof HTMLElement && wrap.clientWidth > 0) {
      return wrap.clientWidth;
    }
    const pane = document.querySelector('.pane.viewer');
    if (pane instanceof HTMLElement && pane.clientWidth > 0) {
      return pane.clientWidth;
    }
  }
  return typeof window !== 'undefined' && window.innerWidth > 0
    ? window.innerWidth
    : 1440;
}

/** The CURRENT splittable width (px) the two panes actually share: the center
 *  track minus the in-flow divider (VIEWER_DIVIDER_W). The grid gives the panes
 *  `(100% − divider)` and the divider its own width, so BOTH the ratio clamp
 *  and the drag px→fraction conversion must measure against this — else the
 *  right pane resolves ~8px under VIEWER_PANE_MIN at the upper bound (the
 *  divider would be silently charged to one pane). Never negative. */
function viewerSplitWidthNow(): number {
  return Math.max(0, viewerWidthNow() - VIEWER_DIVIDER_W);
}

/** Clamp a candidate split ratio against the CURRENT splittable width. */
function clampSplitRatioNow(ratio: number): number {
  return clampSplitRatio(ratio, viewerSplitWidthNow());
}

/** Read the persisted split ratio from localStorage, or null when unset. */
function readPersistedSplitRatio(): number | null {
  try {
    return coerceStoredRatio(window.localStorage.getItem(VIEWER_SPLIT_RATIO_KEY));
  } catch {
    return null;
  }
}

/** Compute the initial split ratio: persisted, else default — clamped. */
function initialSplitRatio(): number {
  const persisted = readPersistedSplitRatio();
  return clampSplitRatioNow(persisted ?? VIEWER_SPLIT_DEFAULT);
}

/** Read the persisted split-view on/off state, or null when unset (default
 *  off — a single pane). */
function readPersistedSplitView(): boolean | null {
  try {
    const raw = window.localStorage.getItem(VIEWER_SPLIT_KEY);
    if (raw === null) return null;
    return raw === '1';
  } catch {
    return null;
  }
}

/** Compute the initial split-view state: persisted, else off (single pane). */
function initialSplitView(): boolean {
  return readPersistedSplitView() ?? false;
}

/** Manage the resizable split ratio: state + persistence + re-clamp. Mirror of
 *  useTerminalHeight on the column axis (a fraction, not px). Returns the live
 *  ratio, a clamped+persisting setter, and `reclamp` — a re-clamp-against-the-
 *  current-track callback the caller wires to a ResizeObserver on the wrap so the
 *  VIEWER_PANE_MIN floor stays REAL no matter WHAT shrinks the center track. */
function useViewerSplit(): {
  ratio: number;
  setRatio: (next: number, persist: boolean) => void;
  reclamp: () => void;
} {
  // Lazy init so the localStorage read happens once, pre-paint.
  const [ratio, setRatioState] = useState<number>(() => initialSplitRatio());

  const setRatio = useCallback((next: number, persist: boolean): void => {
    const clamped = clampSplitRatioNow(next);
    setRatioState(clamped);
    if (persist) {
      try {
        window.localStorage.setItem(VIEWER_SPLIT_RATIO_KEY, String(clamped));
      } catch {
        /* localStorage may be unavailable; the ratio still applies in-session. */
      }
    }
  }, []);

  // Re-clamp the LIVE ratio against the CURRENT splittable track width so neither
  // pane collapses below VIEWER_PANE_MIN. A no-op when already in range (the
  // clamp is idempotent), and it never persists — the user's stored ratio is
  // preserved; this only constrains what is APPLIED for the current track width.
  const reclamp = useCallback((): void => {
    setRatioState((r) => clampSplitRatioNow(r));
  }, []);

  // Re-clamp when the window shrinks so neither pane collapses below its floor.
  // (The ResizeObserver below catches track-only shrinks — Explorer/Chat
  // drag/toggle, terminal dock — that dispatch NO window 'resize'; this covers
  // the window-level case and any pre-mount width change.)
  useEffect(() => {
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, [reclamp]);

  return { ratio, setRatio, reclamp };
}

/** Which pane edge a Splitter controls. 'left' = Explorer right edge
 *  (drag right widens), 'right' = Chat left edge (drag left widens). */
type SplitterEdge = 'left' | 'right';

interface SplitterProps {
  /** Current pane width (px) — drives aria-valuenow. */
  width: number;
  /** Clamped+persisting width setter. */
  setWidth: (next: number, persist: boolean) => void;
  /** Which pane this divider resizes. Defaults to the Chat ('right'). */
  edge?: SplitterEdge;
  /** Accessible label + min/max/step config for the controlled pane. */
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
}

/** A draggable pane divider. Pointer drag (capture-based, robust to fast moves
 *  leaving the element) plus full keyboard control. For the Chat ('right'),
 *  dragging LEFT widens (delta = startWidth − (clientX − startX)); for the
 *  Explorer ('left'), dragging RIGHT widens (delta = startWidth + (clientX −
 *  startX)). ArrowRight always widens the pane it visually grows toward. */
function Splitter({
  width,
  setWidth,
  edge = 'right',
  ariaLabel,
  min,
  max,
  step,
}: SplitterProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  // Drag origin, captured on pointerdown so the move math is delta-based.
  const origin = useRef<{ x: number; w: number } | null>(null);
  const isLeft = edge === 'left';

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      // Primary button / pen / touch only; ignore secondary clicks.
      if (e.button !== 0) return;
      e.preventDefault();
      origin.current = { x: e.clientX, w: width };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      document.querySelector('.win')?.classList.add('dragging');
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const o = origin.current;
      if (o === null) return;
      const delta = e.clientX - o.x;
      // Explorer (left edge): drag RIGHT widens. Chat (right edge): drag LEFT.
      const next = isLeft ? o.w + delta : o.w - delta;
      setWidth(next, false); // live, un-persisted update
    },
    [setWidth, isLeft],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (origin.current === null) return;
      origin.current = null;
      setDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be released (lostpointercapture). */
      }
      document.querySelector('.win')?.classList.remove('dragging');
      // Persist the settled width.
      setWidth(width, true);
    },
    [setWidth, width],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      // The arrow that WIDENS points toward the pane: Explorer (left edge)
      // grows rightward so ArrowRight widens; Chat (right edge) grows leftward
      // so ArrowLeft widens (preserving the original chat behavior verbatim).
      const widenKey = isLeft ? 'ArrowRight' : 'ArrowLeft';
      const narrowKey = isLeft ? 'ArrowLeft' : 'ArrowRight';
      let next: number | null = null;
      switch (e.key) {
        case widenKey:
          next = width + step;
          break;
        case narrowKey:
          next = width - step;
          break;
        case 'Home': // max width
          next = max;
          break;
        case 'End': // min width
          next = min;
          break;
        default:
          return;
      }
      e.preventDefault();
      setWidth(next, true);
    },
    [width, setWidth, step, min, max, isLeft],
  );

  return (
    <div
      className={
        (isLeft ? 'splitter left' : 'splitter') + (dragging ? ' dragging' : '')
      }
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      // Human-readable value so AT announces "248 pixels" not a bare integer
      // (APG window-splitter guidance — A11Y-EXP-03 / SC 1.3.1).
      aria-valuetext={`${Math.round(width)} pixels`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}

interface RowSplitterProps {
  /** Current dock height (px) — drives aria-valuenow. */
  height: number;
  /** Clamped+persisting height setter. */
  setHeight: (next: number, persist: boolean) => void;
  /** Accessible label + min/max/step config for the dock. */
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
}

/** The terminal dock's draggable TOP-edge divider — the horizontal mirror of
 *  Splitter. Pointer drag (capture-based) on clientY: dragging UP widens the
 *  dock (delta = startHeight − (clientY − startY)); ArrowUp widens / ArrowDown
 *  narrows by `step`; Home = max, End = min (matching the column splitters'
 *  Home-widens convention). role="separator" with aria-orientation
 *  "horizontal" — per APG the orientation names the SEPARATOR's axis. */
function RowSplitter({
  height,
  setHeight,
  ariaLabel,
  min,
  max,
  step,
}: RowSplitterProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  // Drag origin, captured on pointerdown so the move math is delta-based.
  const origin = useRef<{ y: number; h: number } | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      // Primary button / pen / touch only; ignore secondary clicks.
      if (e.button !== 0) return;
      e.preventDefault();
      origin.current = { y: e.clientY, h: height };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      document.querySelector('.win')?.classList.add('dragging-row');
    },
    [height],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const o = origin.current;
      if (o === null) return;
      const delta = e.clientY - o.y;
      // The dock grows UPWARD: dragging the seam up widens it.
      setHeight(o.h - delta, false); // live, un-persisted update
    },
    [setHeight],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (origin.current === null) return;
      origin.current = null;
      setDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be released (lostpointercapture). */
      }
      document.querySelector('.win')?.classList.remove('dragging-row');
      // Persist the settled height.
      setHeight(height, true);
    },
    [setHeight, height],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowUp': // the dock grows upward, so up widens
          next = height + step;
          break;
        case 'ArrowDown':
          next = height - step;
          break;
        case 'Home': // max height
          next = max;
          break;
        case 'End': // min height
          next = min;
          break;
        default:
          return;
      }
      e.preventDefault();
      setHeight(next, true);
    },
    [height, setHeight, step, min, max],
  );

  return (
    <div
      className={'splitter horizontal' + (dragging ? ' dragging' : '')}
      role="separator"
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(height)}
      // Human-readable value so AT announces "240 pixels" not a bare integer
      // (APG window-splitter guidance — A11Y-EXP-03 / SC 1.3.1).
      aria-valuetext={`${Math.round(height)} pixels`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}

interface ColSplitterProps {
  /** Current split ratio (left pane's fraction 0..1) — drives aria-valuenow. */
  ratio: number;
  /** Clamped+persisting ratio setter. */
  setRatio: (next: number, persist: boolean) => void;
  /** Accessible label for the divider. */
  ariaLabel: string;
}

/** The split reading-pane's draggable VERTICAL divider — the column-axis
 *  analog of RowSplitter, sitting BETWEEN the two reading panes. Pointer drag
 *  (capture-based) maps clientX delta over the center track to a fraction:
 *  dragging RIGHT widens the LEFT pane (ratio += delta/trackWidth). ArrowRight
 *  widens the left pane / ArrowLeft narrows it by VIEWER_SPLIT_STEP; Home = all
 *  to the right pane's min (left max), End = all to the left pane's min — the
 *  clamp keeps both panes usable. role="separator" with aria-orientation
 *  "vertical" (per APG the orientation names the SEPARATOR's axis, like the
 *  column splitters). Live-updates during drag, persists on release — the
 *  RowSplitter persist-on-end pattern. */
function ColSplitter({ ratio, setRatio, ariaLabel }: ColSplitterProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  // Drag origin, captured on pointerdown so the move math is delta-based. We
  // also capture the live center-track width so the px→fraction conversion is
  // stable for the whole drag.
  const origin = useRef<{ x: number; r: number; w: number } | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      // Primary button / pen / touch only; ignore secondary clicks.
      if (e.button !== 0) return;
      e.preventDefault();
      // Capture the SPLITTABLE width (track − divider) so a px drag delta maps
      // to a fraction of the same width the grid lays the panes out against.
      origin.current = { x: e.clientX, r: ratio, w: viewerSplitWidthNow() };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      document.querySelector('.win')?.classList.add('dragging');
    },
    [ratio],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const o = origin.current;
      if (o === null || o.w <= 0) return;
      const delta = e.clientX - o.x;
      // Dragging RIGHT widens the left pane: add the fractional delta.
      setRatio(o.r + delta / o.w, false); // live, un-persisted update
    },
    [setRatio],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (origin.current === null) return;
      origin.current = null;
      setDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be released (lostpointercapture). */
      }
      document.querySelector('.win')?.classList.remove('dragging');
      // Persist the settled ratio.
      setRatio(ratio, true);
    },
    [setRatio, ratio],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      // Home/End convention — INTENTIONALLY consistent with Splitter (Home=max
      // width / End=min width) and RowSplitter (Home=max height / End=min
      // height): "Home grows the PRIMARY pane to its max, End shrinks it to its
      // min." Here the primary pane is the LEFT one, so Home ⇒ ratio toward 1
      // (left to max) and End ⇒ ratio toward 0 (left to min). The clamp keeps
      // the OTHER pane at VIEWER_PANE_MIN at both ends, so 1/0 are upper/lower
      // requests, not literal full-collapse.
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowRight': // the left pane grows rightward, so right widens it
          next = nudgeRatio(ratio, 'inc');
          break;
        case 'ArrowLeft':
          next = nudgeRatio(ratio, 'dec');
          break;
        case 'Home': // left (primary) pane to its max (clamp keeps the right floor)
          next = 1;
          break;
        case 'End': // left (primary) pane to its min
          next = 0;
          break;
        default:
          return;
      }
      e.preventDefault();
      setRatio(next, true);
    },
    [ratio, setRatio],
  );

  // Whole-percent value so AT announces "50 percent" not a long fraction
  // (APG window-splitter guidance — A11Y-EXP-03 / SC 1.3.1).
  const pct = Math.round(ratio * 100);

  return (
    <div
      className={'splitter viewer-split-divider' + (dragging ? ' dragging' : '')}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct} percent`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}

/** Read the capture-only `?shortcuts` hint (presence ⇒ open the Keyboard
 *  Shortcuts panel on boot for a headless proof screenshot). `?shortcuts`
 *  (no value) or `=1`/`=true` ⇒ open; `=0`/`=false` ⇒ closed. Parallel to
 *  the select/theme/foldall capture hints. */
function readShortcutsHint(): boolean {
  if (typeof location === 'undefined') return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return false;
  }
  if (!params.has('shortcuts')) return false;
  const raw = params.get('shortcuts');
  return raw !== '0' && raw !== 'false';
}

/** Read the capture-only `?search=<query>` hint: a query string that opens
 *  search mode, prefills the input, and runs the search on boot for a headless
 *  proof screenshot. Returns the decoded query, or null when absent/empty. */
function readSearchHint(): string | null {
  if (typeof location === 'undefined') return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return null;
  }
  const raw = params.get('search');
  if (raw === null || raw.length === 0) return null;
  return raw;
}

/** Read the capture-only `?searchopen` hint (presence ⇒ open the FIRST result
 *  at its line on boot). `?searchopen` (no value) or `=1`/`=true` ⇒ open. */
function readSearchOpenHint(): boolean {
  if (typeof location === 'undefined') return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return false;
  }
  if (!params.has('searchopen')) return false;
  const raw = params.get('searchopen');
  return raw !== '0' && raw !== 'false';
}

/** Read the capture-only `?changes` hint (presence ⇒ open the branch Changes
 *  viewer on boot for a headless proof screenshot). `?changes` (no value) or
 *  `=1`/`=true` ⇒ open; `=0`/`=false` ⇒ closed. Parallel to the
 *  search/shortcuts capture hints. */
function readChangesHint(): boolean {
  if (typeof location === 'undefined') return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return false;
  }
  if (!params.has('changes')) return false;
  const raw = params.get('changes');
  return raw !== '0' && raw !== 'false';
}

export function App(): JSX.Element {
  // One store instance for the lifetime of the app.
  const store = useMemo(() => createStore(), []);
  const started = useRef(false);

  // Global belt-and-braces anchor-navigation guard (AC-21 / SEC-5).
  useEffect(() => installGlobalAnchorGuard(), []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void store.start();
  }, [store]);

  const vm = useViewModel(store);

  // Apply the persisted theme to <html data-theme> (FR-37, AC-20).
  const theme: Theme = vm?.theme ?? 'dark';
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const content = useFileContent(vm?.selected ?? null, vm?.fileRev ?? 0);

  // ---- Split reading pane (compare two documents side by side) ----
  // Default OFF (a single pane) — when off the behavior is byte-for-byte
  // today's. `splitView` + the ratio persist; `selectedRight` is the RIGHT
  // pane's document (App-local, NOT in the store, which owns only the left
  // `vm.selected`); `activePane` decides which pane an Explorer pick fills.
  // A SECOND useFileContent resolves the right pane's content (re-reads on the
  // same global fileRev so a disk edit refreshes it like the left pane).
  const [splitView, setSplitView] = useState<boolean>(() => initialSplitView());
  const [selectedRight, setSelectedRight] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<ActivePane>('left');
  const { ratio: splitRatio, setRatio: setSplitRatio, reclamp: reclampSplit } =
    useViewerSplit();
  const rightContent = useFileContent(
    splitView ? selectedRight : null,
    vm?.fileRev ?? 0,
  );

  // Resizable chat width (FR-54). Hook lives above the early return so the
  // hook order stays stable across the pre-boot / booted renders.
  const { width: chatWidth, setWidth: setChatWidth } = useChatWidth();

  // Resizable + collapsible Explorer (FR-54). Same placement rule: all hooks
  // above the pre-boot early return so the hook order never changes.
  const { width: explorerWidth, setWidth: setExplorerWidth } = useExplorerWidth();
  const [explorerHidden, setExplorerHidden] = useState<boolean>(() =>
    initialExplorerHidden(),
  );
  // Collapsible Chat (mirror of the Explorer collapse on the opposite edge).
  const [chatHidden, setChatHidden] = useState<boolean>(() =>
    initialChatHidden(),
  );

  // A single visually-hidden polite live region announces pane collapse/expand
  // so the change is perceivable to assistive tech regardless of focus location
  // (SC 4.1.3 Status Messages / A11Y-CHAT-02). aria-pressed on the toggle only
  // updates the toggle's own state and is announced only when it is focused —
  // not a status message. Both the Explorer and Chat toggles write here.
  const [statusMessage, setStatusMessage] = useState('');

  // ---- Terminal dock (bottom row): open/height/maximize state ----
  // Height mirrors useChatWidth (persisted, clamped); open state persists via
  // TERMINAL_OPEN_KEY; maximize is SESSION-ONLY (never persisted) so a relaunch
  // always starts with the three columns visible.
  const { height: terminalHeight, setHeight: setTerminalHeight } =
    useTerminalHeight();
  const [terminalOpen, setTerminalOpen] = useState<boolean>(() =>
    initialTerminalOpen(),
  );
  const [terminalMax, setTerminalMax] = useState<boolean>(false);
  // Bumped on (re)open so TerminalPane re-focuses xterm (the command-nonce
  // idiom — fold/copy commands use the same shape).
  const [terminalFocusNonce, setTerminalFocusNonce] = useState(0);
  // The StatusBar terminal toggle — focus returns here on close (SC 2.4.3).
  const terminalToggleRef = useRef<HTMLButtonElement>(null);
  // Latest open state in a ref so the toggle can read it without side effects
  // inside the state updater (StrictMode-safe — the toggleExplorer idiom).
  const terminalOpenRef = useRef(terminalOpen);
  terminalOpenRef.current = terminalOpen;

  const toggleTerminal = useCallback((): void => {
    const next = !terminalOpenRef.current;
    try {
      window.localStorage.setItem(TERMINAL_OPEN_KEY, next ? '1' : '0');
    } catch {
      /* localStorage may be unavailable; state still applies in-session. */
    }
    if (next) {
      // Opening: focus lands in the terminal (TerminalPane focuses xterm on
      // mount; the nonce also covers a re-open of an already-mounted pane).
      setTerminalFocusNonce((n) => n + 1);
    } else {
      // Closing: maximize is open-only, and focus must never strand inside
      // the unmounting pane — return it to the always-visible toggle.
      setTerminalMax(false);
      requestAnimationFrame(() => terminalToggleRef.current?.focus());
    }
    // Announce the change to assistive tech via the polite live region
    // (SC 4.1.3 / A11Y-CHAT-02) — perceivable regardless of focus location.
    setStatusMessage(next ? 'Terminal opened' : 'Terminal closed');
    setTerminalOpen(next);
  }, []);

  // Flip the terminal dock between maximized and restored (the same action the
  // pane-header maximize button performs). Maximize/restore is a deliberate
  // "give me the terminal" action, so bump the focus nonce to land focus in
  // xterm — matching the header button's inline handler. When the dock is
  // CLOSED, open it first (a closed dock has nothing to maximize), then
  // maximize so the keyboard command is a non-crashing, sensible no-op-or-open;
  // toggleTerminal already bumps the focus nonce in that path.
  const toggleMaximizeTerminal = useCallback((): void => {
    if (!terminalOpenRef.current) {
      toggleTerminal();
      setTerminalMax(true);
      return;
    }
    setTerminalMax((m) => !m);
    setTerminalFocusNonce((n) => n + 1);
  }, [toggleTerminal]);

  // Keyboard Shortcuts panel open state. App owns it; the fixed Ctrl/Cmd+Comma
  // opener, the Settings "Open Keyboard Shortcuts" button, and the `?shortcuts`
  // capture hint all set it.
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(() =>
    readShortcutsHint(),
  );
  // The control that opened the panel — focus returns here on close (SC 2.4.3).
  const shortcutsOpenerRef = useRef<HTMLElement | null>(null);
  // The StatusBar gear button — opens Settings (NOT Shortcuts) and is the focus
  // fallback when either panel closes.
  const gearButtonRef = useRef<HTMLButtonElement>(null);

  // Settings panel open state (mirrors the shortcuts pattern). App owns it; the
  // StatusBar gear opens it. No capture hint — Settings is gear-only.
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  // The control that opened Settings — focus returns here on close (SC 2.4.3).
  const settingsOpenerRef = useRef<HTMLElement | null>(null);

  // RENDERED-markdown reading-column width mode, LIFTED to App so the Settings
  // panel (a sibling of the Viewer) can drive it. Lazy init reads the capture
  // hint > localStorage > default ('fit') once, pre-paint (md-width.ts). The
  // setter persists across files + restarts; the Viewer applies it as
  // data-mdwidth on its <section>.
  const [mdWidth, setMdWidth] = useState<WidthMode>(() => readInitialMdWidth());
  const setMdWidthMode = useCallback((mode: WidthMode): void => {
    setMdWidth(mode);
    persistMdWidth(mode);
  }, []);
  // Quick toggle (fit↔full) shared by BOTH fast routes — the Viewer-header
  // reading-width button and the rebindable toggleReadingWidth command
  // (default Ctrl/Cmd+Shift+W). Persists via setMdWidthMode and announces the
  // resulting mode through the polite live region (SC 4.1.3) so the change is
  // perceivable regardless of focus location. The Settings radios reflect the
  // same lifted state, so they stay in sync automatically (they announce their
  // OWN changes inside the panel, so there is no double announcement here).
  const toggleMdWidth = useCallback((): void => {
    const next = toggleWidthMode(mdWidth);
    setMdWidthMode(next);
    setStatusMessage(
      next === 'full' ? MD_WIDTH_ANNOUNCE_FULL : MD_WIDTH_ANNOUNCE_FIT,
    );
  }, [mdWidth, setMdWidthMode]);

  // ---- Split reading-pane toggles (header button + toggleSplitView command) ----
  // Latest split state in a ref so the toggle reads it without side effects
  // inside a state updater (StrictMode-safe — the toggleTerminal idiom).
  const splitViewRef = useRef(splitView);
  splitViewRef.current = splitView;

  // Turn split OFF → restore the single (left) pane exactly: drop the right
  // doc, reset the active pane to 'left', persist the off state, announce.
  // Shared by the header × on the right pane, the header toggle, and the
  // toggleSplitView command. FOCUS RESCUE (SC 2.4.3, the closeFileFromButton /
  // toggleTerminal idiom): the right pane (its × button) and the divider both
  // UNMOUNT when split closes, so a close triggered from any of them — the
  // right pane's ×, Ctrl+\ while focus is on the divider or inside the right
  // pane — would strand focus on a detached node (falling back to document.body).
  // After the single pane re-renders (rAF) move focus to a surviving element:
  // the single pane's header Split toggle if a file is open (it re-mounts in the
  // populated header), else the Explorer's active treeitem, else the body —
  // always a valid target. Plain document.querySelector is sufficient (there is
  // exactly one Explorer / single Viewer once split is off).
  const closeSplit = useCallback((): void => {
    try {
      window.localStorage.setItem(VIEWER_SPLIT_KEY, '0');
    } catch {
      /* localStorage may be unavailable; the state still applies in-session. */
    }
    setSplitView(false);
    setSelectedRight(null);
    setActivePane('left');
    setStatusMessage('Split reading pane closed');
    requestAnimationFrame(() => {
      const target =
        document.querySelector<HTMLElement>('.pane.viewer .split-view-btn') ??
        document.querySelector<HTMLElement>(
          '.pane.explorer [role="treeitem"][tabindex="0"]',
        );
      (target ?? document.body).focus();
    });
  }, []);

  // Toggle split on/off. Turning ON sets the active pane to 'right' so the
  // user's NEXT Explorer pick naturally fills the empty comparison side
  // (spec §4 — activePaneOnSplitOn). Turning OFF routes through closeSplit so
  // the single-pane layout is restored exactly. Persists + announces.
  const toggleSplitView = useCallback((): void => {
    if (splitViewRef.current) {
      closeSplit();
      return;
    }
    try {
      window.localStorage.setItem(VIEWER_SPLIT_KEY, '1');
    } catch {
      /* localStorage may be unavailable; the state still applies in-session. */
    }
    setActivePane(activePaneOnSplitOn());
    setSplitView(true);
    setStatusMessage('Split reading pane opened — pick a file for the right pane');
    // ENTER focus rescue (spec §3/§4 — symmetric with closeSplit's EXIT rescue):
    // after the right pane mounts (rAF), move focus INTO it so a keyboard/AT user
    // lands in the pane they are told to fill — for BOTH the two-doc reading split
    // and the diff+file split (this is the only split-on path; the header buttons
    // and the Ctrl/Cmd+\ command all route through here). The freshly-mounted
    // right pane always renders a focusable control even when empty (its Split
    // toggle + the close-split ×), so target that; fall back to the pane section,
    // then document.body — never stranded.
    requestAnimationFrame(() => {
      const right = document.querySelector<HTMLElement>('.viewer-pane-right');
      const target =
        right?.querySelector<HTMLElement>('.split-view-btn, .viewer-close-split') ??
        right;
      (target ?? document.body).focus();
    });
  }, [closeSplit]);

  // Fold-command signal lifted to the Viewer/CodeView (foldAll / unfoldAll
  // shortcuts). An incrementing nonce so each press fires exactly once; the
  // intent picks fold vs unfold. CodeView no-ops when the file isn't foldable.
  const [foldCommand, setFoldCommand] = useState<{
    nonce: number;
    intent: 'fold' | 'unfold';
  } | null>(null);
  const foldNonceRef = useRef(0);
  const fireFoldCommand = useCallback((intent: 'fold' | 'unfold'): void => {
    foldNonceRef.current += 1;
    setFoldCommand({ nonce: foldNonceRef.current, intent });
  }, []);

  // Copy-command signal lifted to the Viewer (copyRendered shortcut). An
  // incrementing nonce so each press fires exactly once; ViewerContent no-ops
  // when the open file is not RENDERED markdown.
  const [copyCommand, setCopyCommand] = useState<{ nonce: number } | null>(null);
  const copyNonceRef = useRef(0);
  const fireCopyCommand = useCallback((): void => {
    copyNonceRef.current += 1;
    setCopyCommand({ nonce: copyNonceRef.current });
  }, []);

  /* ============================================================
   * Project-wide content search (Explorer SEARCH mode)
   * ------------------------------------------------------------
   * `searchMode` swaps the Explorer's file tree for the SearchView.
   * The `openSearch` command + the Explorer-header search button open
   * it; the SearchView's close affordance + Escape close it. A capture
   * `?search=<q>` hint opens it pre-filled (and `?searchopen` opens the
   * first result at its line for a headless proof).
   * ============================================================ */
  // Capture hints are read ONCE on mount (lazy init) — parallel to the other
  // capture hints. The query also forces searchMode open on boot.
  const initialSearchQuery = useMemo(() => readSearchHint(), []);
  const initialSearchOpen = useMemo(() => readSearchOpenHint(), []);
  const [searchMode, setSearchMode] = useState<boolean>(
    () => initialSearchQuery !== null,
  );
  // A "reveal line" signal lifted to the Viewer/CodeView: an incrementing nonce
  // so each reveal fires exactly once even when re-opening the SAME line; the
  // path lets the Viewer ignore a stale signal once a different file is open.
  const [targetLine, setTargetLine] = useState<{
    path: string;
    line: number;
    nonce: number;
  } | null>(null);
  const targetLineNonceRef = useRef(0);
  // The path of a WHOLE-FILE open originating from a file-NAME search row
  // (openSearchFile), as distinct from a line-level content open (openSearchMatch).
  // Drives the file row's "you are here" marker (A11Y-FN-01) WITHOUT lighting up
  // a file row merely because a content match in the SAME file is the active
  // match (UX-NAME-04). Cleared whenever a content match opens, so the two
  // markers are mutually exclusive and always reflect the LAST user action.
  const [activeSearchFile, setActiveSearchFile] = useState<string | null>(null);
  // The control that opened search — focus returns here on close (SC 2.4.3 /
  // A11Y-SEARCH-02), mirroring the shortcutsOpenerRef pattern. Falls back to the
  // Explorer header search button (which re-mounts when search closes) when
  // search was opened via the Ctrl/Cmd+Shift+F command with no DOM opener.
  const searchOpenerRef = useRef<HTMLElement | null>(null);
  const explorerSearchBtnRef = useRef<HTMLButtonElement>(null);

  // Open a search match in the Viewer at its line: select the file, then raise
  // the reveal-line signal. The Viewer scrolls the line into view + flashes it
  // (and CodeView unfolds any collapsed region containing it).
  const openSearchMatch = useCallback(
    (path: string, line: number): void => {
      store.selectFile(path);
      // A search-reveal targets the store-selected (LEFT/single) Viewer, which is
      // HIDDEN behind ChangesView while diffMode is on (the diff occupies the same
      // center track; in a diff+file split the right pane gets targetLine=null).
      // So the reveal flash would land nowhere and the file would change silently
      // behind the diff. Drop diffMode so the revealed line surfaces in a real
      // Viewer — exactly the precedent the Explorer onSelect already sets when it
      // opens a file while diffMode is on (regression-finding). setDiffMode(false)
      // directly (NOT closeChanges) so focus/announcement are owned by the reveal.
      //
      // DIFF+FILE NOTE (correctness-finding): unlike the Explorer onSelect — which
      // routes a pick to the RIGHT (file) pane via effectiveActivePane while a
      // diff+file split is rendered — a search-reveal here DELIBERATELY drops
      // diffMode and surfaces the line in the LEFT/store Viewer instead. The right
      // pane has no targetLine reveal pipeline (it is content-only, targetLine=null
      // by construction), so routing a LINE reveal into it would require a whole
      // new right-pane reveal mechanism — a speculative extra beyond the diff+file
      // capability (§7). Collapsing to a two-doc reading split (revealed file LEFT,
      // prior selectedRight RIGHT) surfaces the line in a real Viewer and never
      // strands focus, so it is the correct minimal behavior; the diff is restored
      // with one Ctrl/Cmd+Shift+G when the user wants it back.
      setDiffMode(false);
      const name = path.split('/').filter(Boolean).pop() ?? path;
      setStatusMessage(`Opened ${name} at line ${line}`);
      targetLineNonceRef.current += 1;
      setTargetLine({ path, line, nonce: targetLineNonceRef.current });
      // A line-level open is NOT a whole-file open — clear the file-row marker so
      // the active cue lands on the content row, not the file-NAME row (UX-NAME-04).
      setActiveSearchFile(null);
    },
    [store],
  );

  // Open a WHOLE file from a file-NAME search match: select it with NO target
  // line (there is no specific line to reveal). The Viewer renders the file
  // from the top; any prior reveal flash is irrelevant to a whole-file open.
  const openSearchFile = useCallback(
    (path: string): void => {
      store.selectFile(path);
      // Same reasoning as openSearchMatch: surface the opened file in a real
      // Viewer rather than leaving it hidden behind ChangesView (the Explorer
      // onSelect precedent). A whole-file open while diffMode is on must show the
      // file, not silently change the store selection behind the diff. DIFF+FILE
      // (correctness-finding): like openSearchMatch, this intentionally drops
      // diffMode (revealed file -> LEFT/store Viewer) rather than routing into the
      // RIGHT file pane the way Explorer onSelect does — kept symmetric with the
      // line-reveal path so search has ONE predictable surface, and avoiding a
      // speculative right-pane search-routing path (§7).
      setDiffMode(false);
      const name = path.split('/').filter(Boolean).pop() ?? path;
      setStatusMessage(`Opened ${name}`);
      // A11Y-FN-01: mark this file row as the live "current item". Drop any prior
      // content-row marker so the cue lands on the file-NAME row that opened it.
      setActiveSearchFile(path);
      targetLineNonceRef.current += 1;
      setTargetLine(null);
    },
    [store],
  );

  // Open + focus the Explorer search view. Ensures the Explorer pane is shown
  // (un-collapse it if needed) so the search input is actually visible. Records
  // the opener so focus returns to it on close (A11Y-SEARCH-02); the Explorer
  // header button passes itself, the keyboard command passes null (close then
  // falls back to the re-mounted Explorer search button).
  const openSearch = useCallback((opener?: HTMLElement | null): void => {
    searchOpenerRef.current = opener ?? null;
    setExplorerHidden((hidden) => {
      if (hidden) {
        try {
          window.localStorage.setItem(EXPLORER_HIDDEN_KEY, '0');
        } catch {
          /* localStorage may be unavailable; state still applies in-session. */
        }
      }
      return false;
    });
    setSearchMode(true);
    setStatusMessage('Search opened');
  }, []);

  // Close search and restore focus to a sensible location (A11Y-SEARCH-02 /
  // SC 2.4.3): the recorded opener if still in the DOM, else the Explorer header
  // search button which re-mounts when the tree returns. Deferred to rAF so the
  // target (the re-rendered Explorer button) exists before we focus it — mirrors
  // closeShortcuts. Never leaves focus stranded on document.body.
  const closeSearch = useCallback((): void => {
    setSearchMode(false);
    setStatusMessage('Search closed');
    requestAnimationFrame(() => {
      const opener = searchOpenerRef.current;
      const target =
        opener && opener.isConnected ? opener : explorerSearchBtnRef.current;
      target?.focus();
      searchOpenerRef.current = null;
    });
  }, []);

  /* ============================================================
   * Branch "Changes" viewer (center-pane MODE)
   * ------------------------------------------------------------
   * `diffMode` swaps the center 1fr track from the Viewer to the
   * ChangesView (the SearchView swap idiom, targeting the Viewer track).
   * The StatusBar Changes toggle + Ctrl/Cmd+Shift+G open it; the
   * ChangesView × button, the toggle, and Escape close it back to the
   * previously-selected file's Viewer. A capture `?changes` hint opens
   * it on boot for a headless proof. App-LOCAL UI state (like searchMode),
   * NOT part of the frozen InitialState. Fetched once on open.
   * ============================================================ */
  const initialDiffMode = useMemo(() => readChangesHint(), []);
  const [diffMode, setDiffMode] = useState<boolean>(() => initialDiffMode);
  // The StatusBar Changes toggle — focus returns here on close (SC 2.4.3),
  // mirroring the search opener pattern.
  const changesToggleRef = useRef<HTMLButtonElement>(null);

  // Open the Changes viewer and fetch the listing once (v1 = fetch-on-open).
  // FOCUS RESCUE (SC 2.4.3 + spec §3/§4): when a two-doc reading split is ALREADY
  // on, flipping diffMode true swaps the LEFT <Viewer> for ChangesView (the left
  // pane UNMOUNTS) while the RIGHT file pane is reused. If focus was on any
  // left-pane control (its ×, the Split / reading-width / copy / fold buttons —
  // all keyboard-reachable, then this fires via the StatusBar toggle or
  // Ctrl/Cmd+Shift+G), it would strand on document.body. So, mirroring
  // toggleSplitView's ENTER idiom, after the diff+file split paints (rAF) move
  // focus INTO the right (file) pane — the one document target now (the diff is
  // not), satisfying §3's "leave the RIGHT file pane focused on entering diff+
  // file" for THIS entry path too (toggleSplitView already covers the full-width-
  // Changes -> Ctrl+\ path). When split is OFF this is skipped entirely so the
  // full-width-Changes case keeps its existing behavior (focus stays put; close
  // returns to changesToggleRef) — byte-for-byte today's.
  const openChanges = useCallback((): void => {
    setDiffMode(true);
    setStatusMessage('Changes opened');
    void store.loadChanges();
    if (splitViewRef.current) {
      requestAnimationFrame(() => {
        const right = document.querySelector<HTMLElement>('.viewer-pane-right');
        const target =
          right?.querySelector<HTMLElement>('.split-view-btn, .viewer-close-split') ??
          right;
        (target ?? document.body).focus();
      });
    }
  }, [store]);

  // Close the Changes viewer → back to the selected file's Viewer. Restore focus
  // to the StatusBar toggle (it never unmounts), deferred to rAF for parity with
  // closeSearch. Never leaves focus stranded on document.body.
  const closeChanges = useCallback((): void => {
    setDiffMode(false);
    setStatusMessage('Changes closed');
    requestAnimationFrame(() => changesToggleRef.current?.focus());
  }, []);

  // The StatusBar toggle + the Ctrl/Cmd+Shift+G binding flip between the two.
  const toggleChanges = useCallback((): void => {
    if (diffMode) closeChanges();
    else openChanges();
  }, [diffMode, openChanges, closeChanges]);

  // Fire loadChanges once on boot when the capture hint opened the viewer (the
  // openChanges path is bypassed for the initial render).
  useEffect(() => {
    if (initialDiffMode) void store.loadChanges();
  }, [initialDiffMode, store]);

  // Open the panel, remembering the opener so focus returns to it on close.
  const openShortcuts = useCallback((opener: HTMLElement | null): void => {
    shortcutsOpenerRef.current = opener;
    setShortcutsOpen(true);
  }, []);
  // Close the panel and restore focus to the opener (fall back to the gear).
  const closeShortcuts = useCallback((): void => {
    setShortcutsOpen(false);
    const opener = shortcutsOpenerRef.current ?? gearButtonRef.current;
    requestAnimationFrame(() => opener?.focus());
  }, []);

  // Open Settings, remembering the opener so focus returns to it on close
  // (mirrors openShortcuts). The gear passes itself.
  const openSettings = useCallback((opener: HTMLElement | null): void => {
    settingsOpenerRef.current = opener;
    setSettingsOpen(true);
  }, []);
  // Close Settings and restore focus to the opener (fall back to the gear),
  // mirroring closeShortcuts.
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    const opener = settingsOpenerRef.current ?? gearButtonRef.current;
    requestAnimationFrame(() => opener?.focus());
  }, []);

  // Cross-pane coupling (UX-2): each pane's max depends on the OTHER pane's
  // current width (via siblingWidth), so after EITHER changes — a drag, a
  // keyboard nudge, a collapse/expand, or a window resize — re-clamp BOTH so
  // their combined width can never starve the Viewer below VIEWER_MIN. The
  // setters are no-ops when already within bounds, so this can't loop. The
  // effect runs AFTER paint, so siblingWidth reads the just-committed
  // `--explorer-w`/`--chat-w` custom properties + `.explorer-hidden` class.
  useEffect(() => {
    setChatWidth(chatWidth, false);
    setExplorerWidth(explorerWidth, false);
  }, [
    chatWidth,
    explorerWidth,
    explorerHidden,
    chatHidden,
    setChatWidth,
    setExplorerWidth,
  ]);

  // The always-visible StatusBar toggle button — focus lands here when the
  // Explorer collapses out from under the keyboard (no lost focus / no trap).
  const explorerToggleRef = useRef<HTMLButtonElement>(null);
  // The Chat toggle button — focus lands here when the Chat collapses out from
  // under the keyboard (mirror of explorerToggleRef).
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  // The body element — used to detect whether focus was inside the Explorer
  // at collapse time so we only steal focus when we actually orphaned it.
  const bodyRef = useRef<HTMLDivElement>(null);

  // Keep the VIEWER_PANE_MIN floor REAL no matter what shrinks the center track
  // (css-finding): the CSS grid columns are minmax(0, …) with NO min-width floor,
  // so the 240px floor is enforced ENTIRELY by clampSplitRatio — which only re-
  // fired on window 'resize' and divider drag. But the center track ALSO shrinks
  // when the Explorer/Chat splitter is dragged, when Explorer/Chat is shown/
  // hidden, or when the terminal dock opens — none of which dispatch a window
  // 'resize', so the ratio was never re-clamped and both halves could starve
  // below 240px (e.g. drag Chat wide until the track hits ~320px). A
  // ResizeObserver on the wrap re-clamps the LIVE ratio on EVERY track-width
  // change (it measures the same .viewer-split-wrap clientWidth the clamp reads),
  // closing the gap for ALL causes at once. Only attached while the split is on
  // (the wrap with two panes exists exactly then); re-runs on splitView so it
  // tracks the wrap mount/unmount. Guarded for environments without
  // ResizeObserver (it always exists in Electron's Chromium; the guard keeps the
  // module SSR-safe). reclampSplit is idempotent + non-persisting, so observing
  // can never loop or clobber the user's stored ratio.
  useEffect(() => {
    if (!splitView) return;
    if (typeof ResizeObserver === 'undefined') return;
    const wrap = bodyRef.current?.querySelector<HTMLElement>('.viewer-split-wrap');
    if (!wrap) return;
    const ro = new ResizeObserver(() => reclampSplit());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [splitView, reclampSplit]);

  // Keep the latest collapsed state in a ref so the toggle can read it without
  // side effects inside the state updater (StrictMode-safe).
  const explorerHiddenRef = useRef(explorerHidden);
  explorerHiddenRef.current = explorerHidden;
  // Set when the Explorer is RE-SHOWN via the keyboard, so the round-trip
  // moves focus into the freshly-mounted tree (UX-4) — never on a mouse click.
  const pendingExplorerFocus = useRef(false);

  const toggleExplorer = useCallback((viaKeyboard = false): void => {
    const next = !explorerHiddenRef.current;
    // Decide focus rescue BEFORE the state change (and before the controls
    // unmount): if focus was inside the about-to-vanish Explorer OR on the
    // left resize splitter (a sibling of the Explorer, also unmounted on
    // collapse — A11Y-EXP-02), move it to the always-visible toggle so the
    // keyboard user is never stranded (SC 2.4.3 / 2.1.2).
    if (next) {
      const active = document.activeElement;
      // `.splitter.left` is rendered OUTSIDE `.pane.explorer`, so an
      // explorerEl.contains() check alone misses it. Match BOTH the Explorer
      // pane and the left splitter — every control that unmounts on collapse.
      const orphaned =
        active instanceof Element &&
        bodyRef.current?.contains(active) === true &&
        active.closest('.pane.explorer, .splitter.left') !== null;
      if (orphaned) {
        // Defer until after the controls unmount this render tick.
        requestAnimationFrame(() => explorerToggleRef.current?.focus());
      }
    } else if (viaKeyboard) {
      // Re-showing via the keyboard: after the tree mounts, move focus into
      // its active treeitem so the keyboard round-trip is symmetric (UX-4).
      pendingExplorerFocus.current = true;
    }
    try {
      window.localStorage.setItem(EXPLORER_HIDDEN_KEY, next ? '1' : '0');
    } catch {
      /* localStorage may be unavailable; state still applies in-session. */
    }
    // Announce the change to assistive tech via the polite live region
    // (SC 4.1.3 / A11Y-CHAT-02) — perceivable regardless of focus location.
    setStatusMessage(next ? 'File explorer hidden' : 'File explorer shown');
    setExplorerHidden(next);
  }, []);

  // After a keyboard re-show, focus the Explorer's first/active treeitem once
  // it has mounted (UX-4). Roving tabindex marks exactly one row tabIndex=0.
  useEffect(() => {
    if (explorerHidden || !pendingExplorerFocus.current) return;
    pendingExplorerFocus.current = false;
    requestAnimationFrame(() => {
      const row = bodyRef.current?.querySelector<HTMLElement>(
        '.pane.explorer [role="treeitem"][tabindex="0"]',
      );
      row?.focus();
    });
  }, [explorerHidden]);

  // ---- Chat collapse: mirror of the Explorer-collapse machinery above ----

  // Latest collapsed state in a ref so the toggle can read it without side
  // effects inside the state updater (StrictMode-safe).
  const chatHiddenRef = useRef(chatHidden);
  chatHiddenRef.current = chatHidden;
  // Set when the Chat is RE-SHOWN via the keyboard, so the round-trip moves
  // focus into the freshly-mounted Chat (UX-4) — never on a mouse click.
  const pendingChatFocus = useRef(false);

  const toggleChat = useCallback((viaKeyboard = false): void => {
    const next = !chatHiddenRef.current;
    // Decide focus rescue BEFORE the state change (and before the controls
    // unmount): if focus was inside the about-to-vanish Chat OR on the right
    // resize splitter (a sibling of the Chat, also unmounted on collapse),
    // move it to the always-visible toggle so the keyboard user is never
    // stranded (SC 2.4.3 / 2.1.2).
    if (next) {
      const active = document.activeElement;
      // `.splitter.right` does not exist as a class — the chat splitter is the
      // default `.splitter` WITHOUT `.left`. Match the Chat pane plus that
      // right splitter (`.splitter:not(.left)`); both unmount on collapse.
      const orphaned =
        active instanceof Element &&
        bodyRef.current?.contains(active) === true &&
        active.closest('.pane.chat, .splitter:not(.left)') !== null;
      if (orphaned) {
        // Defer until after the controls unmount this render tick.
        requestAnimationFrame(() => chatToggleRef.current?.focus());
      }
    } else if (viaKeyboard) {
      // Re-showing via the keyboard: after the Chat mounts, move focus into
      // its first focusable control so the keyboard round-trip is symmetric.
      pendingChatFocus.current = true;
    }
    try {
      window.localStorage.setItem(CHAT_HIDDEN_KEY, next ? '1' : '0');
    } catch {
      /* localStorage may be unavailable; state still applies in-session. */
    }
    // Announce the change to assistive tech via the polite live region
    // (SC 4.1.3 / A11Y-CHAT-02) — perceivable regardless of focus location.
    setStatusMessage(next ? 'Agent chat hidden' : 'Agent chat shown');
    setChatHidden(next);
  }, []);

  // After a keyboard re-show, focus the Chat's first focusable control once it
  // has mounted (UX-4) in EXPLICIT PRIORITY order: the active/open inbox chip,
  // then the active channel tab, then any chip, then any tab. A single
  // comma-separated querySelector would return the first match in DOCUMENT
  // order (the Roster renders before ChannelTabs and its chips carry no roving
  // tabindex, so a plain earlier .rchip would always beat a later .rchip.active
  // — A11Y-CHAT-01 / SC 2.4.3). A fallback chain honors the intended priority
  // regardless of DOM order, restoring the symmetric UX-4 round-trip.
  useEffect(() => {
    if (chatHidden || !pendingChatFocus.current) return;
    pendingChatFocus.current = false;
    requestAnimationFrame(() => {
      const chat = bodyRef.current?.querySelector('.pane.chat');
      const first =
        chat?.querySelector<HTMLElement>('.rchip.active') ??
        chat?.querySelector<HTMLElement>('.chtab.on') ??
        chat?.querySelector<HTMLElement>('.rchip') ??
        chat?.querySelector<HTMLElement>('.chtab');
      first?.focus();
    });
  }, [chatHidden]);

  /* ============================================================
   * Close-file affordances (FR-42 / SC 2.4.3)
   * ------------------------------------------------------------
   * Three ways to dismiss the open file and return to the empty
   * Viewer state: the × button (below), Escape (document handler),
   * and re-selecting the open treeitem (Explorer onSelect, above).
   * Each manages focus so it is never stranded on a detached node.
   * ============================================================ */

  // Latest selected path in a ref so the document-level Escape handler (bound
  // once) always sees the current selection without re-binding every change.
  const selectedRef = useRef<string | null>(vm?.selected ?? null);
  selectedRef.current = vm?.selected ?? null;

  // Close via the × button: the button itself unmounts on close, so focus must
  // move to a live target post-render (rAF) — the Explorer's active treeitem if
  // present, else the body. Never leaves focus on a detached node (SC 2.4.3).
  // Announce the close to assistive tech via the polite live region so the
  // state change is perceivable regardless of focus location (SC 4.1.3 /
  // A11Y-CLOSE-02), mirroring the pane-collapse announcements.
  const closeFileFromButton = useCallback((): void => {
    store.closeFile();
    setStatusMessage('File closed');
    requestAnimationFrame(() => {
      // Prefer the Explorer's active treeitem (the roving-tabindex row). If the
      // Explorer is collapsed (no treeitem in the DOM), fall back to the body —
      // always a valid focus target — so focus is never stranded on the now-
      // unmounted × button (a detached node, SC 2.4.3). The `.pane.viewer` div
      // is not itself focusable, so we don't try it.
      const treeitem = bodyRef.current?.querySelector<HTMLElement>(
        '.pane.explorer [role="treeitem"][tabindex="0"]',
      );
      (treeitem ?? document.body).focus();
    });
  }, [store]);

  // The closeFile COMMAND (Escape by default) — preserves every nuance the
  // old standalone Escape handler carried. CRITICAL coordination with
  // ReceiptStrip: a receipt @here tooltip ALSO uses Escape and calls
  // e.stopPropagation() + e.preventDefault() when it consumes the key. The
  // unified dispatcher below binds on the document BUBBLE phase (the default),
  // so the inner ReceiptStrip handler runs FIRST; when it consumes Escape it
  // stops propagation and the dispatcher never fires. The `defaultPrevented`
  // guard inside decideEscapeClose is a second, independent barrier
  // (A11Y-CLOSE-05). FOCUS RESCUE (A11Y-CLOSE-01 / SC 2.4.3): when focus is on
  // the × close button (which UNMOUNTS on close), route through
  // closeFileFromButton() to rescue focus; any other close keeps focus put.
  // Returns true when it handled (so the dispatcher preventDefaults), false to
  // let the key fall through (nothing open / editable / tooltip consumed it).
  const runCloseFileCommand = useCallback(
    (e: KeyboardEvent): boolean => {
      const active = document.activeElement;
      const action = decideEscapeClose({
        isEscape: true, // the dispatcher only routes here on the bound combo
        defaultPrevented: e.defaultPrevented,
        hasOpenFile: selectedRef.current !== null,
        editableTarget: isEditableTarget(e.target),
        // Only the LEFT/single pane's × is the file-close button whose focus
        // must be rescued on close. The split RIGHT pane's × is a "close split"
        // control (.viewer-close-split) — it does NOT unmount on a file close,
        // so it must not be treated as the close-file button here.
        //
        // !diffMode guard (regression-nit hardening): ChangesView's close button
        // is a plain `.viewer-close` (no .viewer-close-split), so it MATCHES the
        // selector. Today the Changes-first Escape handler above intercepts every
        // Escape while diffMode is on, so this path never runs with the diff ×
        // focused — but if a user REBINDS closeFile OFF Escape, focus on the diff
        // × + a (hidden) store file open would otherwise close the WRONG (hidden)
        // store doc. Gate the match on !diffMode so the diff close button is never
        // treated as the file-close target; the Changes-first handler already owns
        // closing in diffMode.
        focusOnCloseButton:
          !diffMode &&
          active instanceof Element &&
          active.closest('.viewer-close:not(.viewer-close-split)') !== null,
      });
      if (action === 'ignore') return false;
      if (action === 'close-rescue-focus') {
        closeFileFromButton();
      } else {
        store.closeFile();
        setStatusMessage('File closed');
      }
      return true;
    },
    [store, closeFileFromButton, diffMode],
  );

  /* ============================================================
   * UNIFIED keyboard-shortcut dispatcher (FR-54)
   * ------------------------------------------------------------
   * ONE document-level keydown handler replaces the former hardcoded
   * Ctrl/Cmd+B, Ctrl/Cmd+J, and Escape handlers. It resolves the active
   * bindings (defaults merged with the persisted user overrides), turns the
   * event into a canonical combo, finds the command bound to that combo, and
   * invokes it.
   *
   * PRESERVED NUANCES:
   *   - isEditableTarget() guard applies to ALL commands EXCEPT it must never
   *     swallow normal typing (a bare key with no command match falls through).
   *   - closeFile keeps its full coordination (tooltip-consumed Escape skipped
   *     via the BUBBLE phase + defaultPrevented guard, only fires with a file
   *     open, rescues focus off the × button).
   *   - foldAll/unfoldAll lift a fold-command nonce to the Viewer/CodeView.
   *   - toggleTheme/togglePause call the existing store actions.
   *   - The fixed Ctrl/Cmd+Comma opener (NOT a rebindable command) opens the
   *     Shortcuts panel.
   *   - When the Shortcuts panel is OPEN the dispatcher is SUSPENDED — the
   *     panel handles its own keys (capture + Escape-to-close).
   * Bound on the BUBBLE phase so ReceiptStrip's stopPropagation can win.
   * ============================================================ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Suspend entirely while a modal panel (Shortcuts or Settings) owns the
      // keyboard — each handles its own keys (focus trap + Escape-to-close).
      if (shortcutsOpen || settingsOpen) return;

      const combo = eventToCombo(e);

      // Fixed, non-rebindable opener: Ctrl/Cmd+Comma opens the Shortcuts panel.
      // Skipped in editable controls so a future text field keeps native
      // behavior. RESERVED_COMBOS still holds this fixed opener (so the panel
      // hard-blocks any rebind onto it, KB-2); this branch matches it
      // SPECIFICALLY (not any reserved combo) so the defensive isReserved guard
      // below never has to short-circuit it.
      if (combo === 'Ctrl+,' && !isEditableTarget(e.target)) {
        e.preventDefault();
        openShortcuts(gearButtonRef.current);
        return;
      }

      // Escape closes the Changes viewer first (it is a center-pane MODE, like
      // search). Only when it is open; otherwise the key falls through to the
      // close-file / native handling below. Skipped in editable controls. The
      // !e.defaultPrevented re-check is the same "second, independent barrier"
      // the close-file path uses (A11Y-CLOSE-05): if a future Escape consumer
      // (e.g. a tooltip) preventDefaults WITHOUT stopPropagation, a consumed
      // Escape must not also close the viewer.
      //
      // INTENTIONAL PRIORITY (a-finding, SC 3.2.x): in a diff+file split a real
      // document lives in the RIGHT pane, so Escape from inside it ALSO closes
      // Changes (Changes-first, mirroring the search-pane priority) and focus
      // returns to the StatusBar Changes toggle (closeChanges' rescue). This is a
      // DELIBERATE trade-off, not a stray focus jump: the only fall-through here
      // is runCloseFileCommand -> store.closeFile(), which acts on the LEFT/store
      // document (hidden behind the diff in this state) — NOT the right pane's
      // App-local doc — so scoping Escape out of the right pane would close the
      // WRONG (hidden) file. Closing Changes first surfaces a real Viewer and
      // never strands focus, which is the predictable, correct outcome here. (§7:
      // no per-pane Escape routing — that would be a speculative extra.)
      if (
        e.key === 'Escape' &&
        diffMode &&
        !e.defaultPrevented &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        closeChanges();
        return;
      }

      const active = resolveBindings(vm?.keybindings);
      // Find the command whose binding matches this combo. A defensive guard:
      // never let a RESERVED combo (e.g. a corrupt persisted config that holds
      // 'Ctrl+,') match a command — the opener owns it (KB-2).
      let matched: CommandId | null = null;
      if (!isReserved(combo)) {
        for (const id of Object.keys(active) as CommandId[]) {
          if (active[id] === combo) {
            matched = id;
            break;
          }
        }
      }
      if (matched === null) return; // no command — let the key fall through

      // closeFile owns its editable/open-file/tooltip/focus nuances.
      if (matched === 'closeFile') {
        if (runCloseFileCommand(e)) e.preventDefault();
        return;
      }

      // Every other command is suppressed inside editable controls so normal
      // typing (and native combos like Ctrl/Cmd+B bold) is never swallowed —
      // EXCEPT toggleTerminal: xterm's hidden <textarea> IS an editable
      // target, and Ctrl/Cmd+` must close the dock from inside the terminal
      // (symmetric with opening it). The terminal swallows every OTHER combo
      // by design (a shell owns its keys); only its own toggle punches out.
      if (matched !== 'toggleTerminal' && isEditableTarget(e.target)) return;

      e.preventDefault();
      switch (matched) {
        case 'toggleExplorer':
          toggleExplorer(true);
          break;
        case 'toggleChat':
          toggleChat(true);
          break;
        case 'toggleTerminal':
          toggleTerminal();
          break;
        case 'toggleMaximizeTerminal':
          // Maximize/restore the terminal dock (opens it first when closed).
          toggleMaximizeTerminal();
          break;
        case 'toggleChanges':
          // Open/close the branch Changes viewer (the StatusBar toggle action).
          toggleChanges();
          break;
        case 'foldAll':
          fireFoldCommand('fold');
          break;
        case 'unfoldAll':
          fireFoldCommand('unfold');
          break;
        case 'copyRendered':
          // Copy the rendered Viewer content. ViewerContent no-ops unless the
          // open file is RENDERED markdown, so the shortcut is harmless on
          // source/image/binary/empty views. Ctrl+C stays native (selection
          // copy) — only the distinct Ctrl/Cmd+Shift+C combo maps here.
          fireCopyCommand();
          break;
        case 'toggleTheme':
          void store.setTheme(vm?.theme === 'dark' ? 'light' : 'dark');
          break;
        case 'toggleReadingWidth':
          // Flip the Viewer reading column fit↔full (persists + announces).
          // Global like toggleTheme — meaningful whatever file (if any) is
          // open, since the mode is sticky across files and restarts.
          toggleMdWidth();
          break;
        case 'toggleSplitView':
          // Open/close the second (side-by-side compare) reading pane. Global
          // like toggleReadingWidth — opening sets the right pane active so the
          // next Explorer pick fills it; closing restores the single pane.
          toggleSplitView();
          break;
        case 'togglePause':
          void store.togglePause();
          break;
        case 'openSearch':
          openSearch();
          break;
        case 'openSettings':
          // Open Settings the same way the StatusBar gear does — pass the gear
          // ref as the opener so focus returns there on close (mirrors how the
          // Ctrl/Cmd+Comma opener hands the gear to openShortcuts).
          openSettings(gearButtonRef.current);
          break;
        default:
          break;
      }
    };
    // Bubble phase (NOT capture) so ReceiptStrip's stopPropagation can win.
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [
    shortcutsOpen,
    settingsOpen,
    vm?.keybindings,
    vm?.theme,
    store,
    toggleExplorer,
    toggleChat,
    toggleTerminal,
    fireFoldCommand,
    fireCopyCommand,
    toggleMdWidth,
    toggleSplitView,
    openShortcuts,
    openSettings,
    runCloseFileCommand,
    openSearch,
    diffMode,
    closeChanges,
    toggleChanges,
    toggleMaximizeTerminal,
  ]);

  if (vm === null) {
    // Pre-boot: render the empty shell so the window is never blank.
    return (
      <div className="win" aria-busy="true">
        <TitleBar rootName="loom" />
      </div>
    );
  }

  // The EFFECTIVE split state — split is logically on AND actually rendered.
  // splitView and diffMode are now COMPOSABLE: when split is on AND diffMode is
  // on, the center track holds the diff pane (LEFT) beside a normal file pane
  // (RIGHT) — the split is genuinely rendered. So the split renders whenever
  // splitView is on, regardless of diffMode (the earlier N2 fix
  // `splitView && !diffMode` no longer holds — the diff no longer owns the
  // whole track in a split). This is what the Split toggle's aria-pressed must
  // reflect (it now reads "pressed" in the diff+file split too): every header
  // Split toggle (Viewer + ChangesView) reads this so the pressed state tracks
  // whether the split is TRULY rendered, including the diffMode case. Routed
  // through the pure isSplitRendered helper (NOT an inline `splitView`) so the
  // anti-N2-revert is PINNED by a DOM-free test (it returns true for BOTH
  // (true,false) and (true,true)) — re-introducing `splitView && !diffMode`
  // would turn that test RED rather than silently breaking the diff+file split.
  const splitRendered = isSplitRendered(splitView, diffMode);
  // The pane an Explorer pick / the active accent ring targets. While a diff+
  // file split is rendered the diff occupies the LEFT half and is NOT a document
  // target, so this is FORCED to the RIGHT (file) pane (effectiveActivePane);
  // otherwise the stored activePane stands (single doc / two-doc reading split).
  const liveActivePane = effectiveActivePane(splitView, diffMode, activePane);

  return (
    <div className="win">
      {/* Linux frameless edge-resize handles — 8 invisible border affordances so
          a Linux user can free-resize a window with no native resize border. The
          component itself gates to linux + not-maximized (renders null
          otherwise); the loading shell above needs none. */}
      <WindowResizeHandles />
      <TitleBar rootName={vm.rootName} />
      {/* Visually-hidden polite live region: announces pane collapse/expand to
          assistive tech regardless of focus location (SC 4.1.3 / A11Y-CHAT-02).
          role="status" implies aria-live="polite"; both are set explicitly for
          SR robustness. aria-atomic so the full phrase is read each change. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </span>
      <StatusBar
        liveState={vm.liveState}
        counters={vm.counters}
        theme={vm.theme}
        explorerHidden={explorerHidden}
        onToggleExplorer={toggleExplorer}
        explorerToggleRef={explorerToggleRef}
        diffMode={diffMode}
        onToggleDiff={toggleChanges}
        diffToggleRef={changesToggleRef}
        changedCount={vm.changes?.available ? vm.changes.files.length : null}
        chatHidden={chatHidden}
        onToggleChat={toggleChat}
        chatToggleRef={chatToggleRef}
        terminalOpen={terminalOpen}
        onToggleTerminal={toggleTerminal}
        terminalToggleRef={terminalToggleRef}
        onTogglePause={() => void store.togglePause()}
        onToggleTheme={() =>
          void store.setTheme(vm.theme === 'dark' ? 'light' : 'dark')
        }
        onOpenSettings={() => openSettings(gearButtonRef.current)}
        settingsButtonRef={gearButtonRef}
        settingsOpen={settingsOpen}
      />
      <div
        ref={bodyRef}
        // When collapsed, `.explorer-hidden` / `.chat-hidden` drop the
        // respective side track entirely so the Viewer (1fr) fills the freed
        // space — setting --explorer-w/--chat-w to 0 alone leaves a dead empty
        // column and shifts panes by one (UX-1 / A11Y-EXP-01).
        className={
          'body' +
          (explorerHidden ? ' explorer-hidden' : '') +
          (chatHidden ? ' chat-hidden' : '') +
          // The terminal dock adds a second grid ROW (terminal-open); maximize
          // collapses row 1 so the dock fills the body (terminal-max). The
          // row classes compose freely with the column-hiding classes above.
          (terminalOpen ? ' terminal-open' : '') +
          (terminalOpen && terminalMax ? ' terminal-max' : '')
          // NOTE: the split reading-pane layout lives entirely on the
          // .viewer-split-wrap grid (left | divider | right, using --viewer-split
          // inherited from .body's inline style) — the center track mounts that
          // wrap when the split is rendered. There is no `.body.viewer-split`
          // selector, so no state class is added to .body (the former one was a
          // dead/no-op hook with no CSS consumer; §7 — no speculative extras).
        }
        style={
          {
            ['--explorer-w' as string]: explorerWidth + 'px',
            ['--chat-w' as string]: chatWidth + 'px',
            ['--terminal-h' as string]: terminalHeight + 'px',
            // The left pane's fraction of the splittable center width (the
            // remainder goes to the right pane); ignored when split is off.
            ['--viewer-split' as string]: splitRatio,
            // Divider width fed from the SINGLE TS constant (VIEWER_DIVIDER_W),
            // read by BOTH the .viewer-split-wrap grid (which reserves it out of
            // the panes' shared 100%) and the .viewer-split-divider width — so
            // the layout and the ratio-clamp geometry can never drift.
            ['--viewer-divider-w' as string]: VIEWER_DIVIDER_W + 'px',
          } as CSSProperties
        }
      >
        {!explorerHidden && searchMode && (
          <SearchView
            initialQuery={initialSearchQuery ?? undefined}
            autoOpenFirst={initialSearchOpen}
            onOpenMatch={openSearchMatch}
            onOpenFile={openSearchFile}
            onCloseSearch={closeSearch}
            // UX-SEARCH-06: mark the currently-open match row. Only while its
            // file is still the selected file (closing the file clears it), so
            // the marker reflects the live Viewer selection, not a stale open.
            activeMatch={
              targetLine && vm.selected === targetLine.path
                ? { path: targetLine.path, line: targetLine.line }
                : null
            }
            // A11Y-FN-01 / UX-NAME-04: mark the open WHOLE-FILE row (a file-NAME
            // open) ONLY while that file is still the live Viewer selection.
            // Distinct from activeMatch so a content-match open never lights up
            // the file-NAME row, and vice versa.
            activeFilePath={
              activeSearchFile && vm.selected === activeSearchFile
                ? activeSearchFile
                : null
            }
          />
        )}
        {!explorerHidden && !searchMode && (
          <Explorer
            rootName={vm.rootName}
            tree={vm.tree}
            // The "you are here" marker tracks the ACTIVE pane: when split is
            // on and the right pane is active, the Explorer reflects the right
            // pane's document, so the user sees which file the next pick targets.
            // Off (or left active) ⇒ the store's selected (today's behavior).
            selected={
              splitView && liveActivePane === 'right' ? selectedRight : vm.selected
            }
            // Lazily fetch a folder's children the first time it is expanded
            // (idempotent in the store) so subfolders are never read until the
            // user opens them.
            onExpandDir={(path) => store.loadDir(path)}
            onOpenSearch={openSearch}
            searchBtnRef={explorerSearchBtnRef}
            // Re-activating the ALREADY-open file toggles it closed (FR-42);
            // any other path selects it. Explorer just calls onSelect(path) on
            // click/Enter/Space, so the toggle lives here. Focus stays on the
            // treeitem (it is not unmounted), and aria-selected goes false
            // because the active pane's selection becomes null (SC 4.1.2). Both
            // branches announce to the polite live region so the state change is
            // perceivable regardless of focus location (SC 4.1.3 /
            // A11Y-CLOSE-02 / UX-05); the selected row also carries a "close"
            // affordance (title + aria-label suffix) so the toggle-off is
            // discoverable, not a silent accidental action (UX-01 / SC 3.2.4).
            //
            // SPLIT: when split is on, a selection opens into the ACTIVE pane
            // (paneForSelection). The RIGHT pane is App-local state; the LEFT
            // pane (and the single-pane default) still flow through the store.
            onSelect={(path) => {
              // Route to the LIVE active pane: while a diff+file split is
              // rendered the diff owns the LEFT half and is NOT a doc target, so
              // effectiveActivePane forces the pick into the RIGHT (file) pane —
              // it can never land behind the diff. Otherwise the stored active
              // pane (or 'left' when split is off) stands.
              const target = paneForSelection(splitView, liveActivePane);
              const name = path.split('/').filter(Boolean).pop() ?? path;
              if (target === 'right') {
                // Right pane: toggle closed on re-select, else open it there.
                if (path === selectedRight) {
                  setSelectedRight(null);
                  setStatusMessage('Right pane closed');
                } else {
                  setSelectedRight(path);
                  setStatusMessage(`Opened ${name} in the right pane`);
                }
                return;
              }
              if (path === vm.selected) {
                store.closeFile();
                setStatusMessage('File closed');
              } else {
                store.selectFile(path);
                // The Changes viewer occupies the SAME center 1fr track as the
                // Viewer (unlike SearchView, which swaps the explorer column),
                // so a file genuinely opened from the Explorer while diffMode is
                // on would be HIDDEN behind ChangesView — the live region would
                // say "Opened X" but nothing changes on screen. Drop diffMode so
                // the opened file actually surfaces (SEC-2). We call
                // setDiffMode(false) directly (NOT closeChanges()) so focus stays
                // on the just-activated treeitem and the "Opened X" announcement
                // stands — closeChanges() would steal focus to the StatusBar
                // toggle and overwrite the message with "Changes closed".
                setDiffMode(false);
                setStatusMessage(`Opened ${name}`);
              }
            }}
            flashing={vm.flashing}
            justModified={vm.justModified}
            newlyAdded={vm.newlyAdded}
            gitStatus={vm.gitStatus}
          />
        )}
        {/* Center 1fr track. The spec's REQUIRED DESIGN words splitView as the
            OUTER condition with diffMode composed inside; we INVERT that — diffMode
            is the outer condition and splitView composes inside. This is a
            DELIBERATE deviation from the literal wording, not an accident: the net
            4-combination matrix (single doc / two-doc split / full-width Changes /
            diff+file split) is byte-for-byte identical to the required behavior,
            AND diffMode-outer keeps ChangesView at one STABLE JSX position inside
            .viewer-split-wrap so the Ctrl+\ solo<->split toggle never remounts it
            (already-expanded FileDiff blocks survive the toggle, F1). A literal
            splitView-outer structure would move ChangesView between two branches
            and remount it on every split toggle — strictly worse for the
            no-regression goal. So splitView composes INSIDE diffMode here.

            DIFF ON: the track ALWAYS holds a .viewer-split-wrap whose FIRST child
            is the branch Changes viewer — at one STABLE JSX position so toggling
            the split never changes ChangesView's DOM parent and never remounts it
            (so already-expanded FileDiff blocks survive Ctrl+\, M-finding F1).
            When split is also ON the wrap gets the divider + the App-local file
            pane on the RIGHT (diff LEFT, file RIGHT); when split is OFF the wrap
            collapses to a single full-width column (`--solo`) holding only the
            diff — byte-for-byte today's full-width Changes, just inside a
            single-column grid that lays out identically.

            DIFF OFF: splitView selects the two-doc reading split [left | divider
            | right] or a single Viewer — both byte-for-byte today's, untouched
            by the diff composability above. The diff+file wrap above renders the
            divider + right Viewer as FLAT gated children at the SAME positional
            slots (idx 1 + 2) this two-doc wrap uses, so React reuses the right
            <Viewer> across the two-doc<->diff+file transition (no scroll/fold/focus
            loss) — only ChangesView (idx 0) ever remounts. */}
        {diffMode ? (
          <div
            // The --solo modifier (full-width, no divider/right tracks) is keyed
            // off `splitRendered` — the SINGLE pure source of "is the split truly
            // rendered" (isSplitRendered) — NOT an inline `splitView`. In the
            // diffMode branch splitRendered === splitView, so this is identical
            // today; routing it (AND the divider/right-pane mount gates below)
            // through splitRendered makes the one helper genuinely GOVERN BOTH the
            // pane MOUNT and the aria-pressed prop, so the VSPLIT-SEL anti-revert
            // test (which pins isSplitRendered(true,true)===true) actually guards
            // the mount conditional it claims to — re-introducing the N2
            // `splitView && !diffMode` in the helper would now turn the right pane
            // off here too, not just flip aria-pressed (tests-finding).
            className={'viewer-split-wrap' + (splitRendered ? '' : ' viewer-split-wrap--solo')}
          >
            {/* The branch Changes viewer (the diff pane) — the STABLE first child
                in BOTH the solo (full-width) and split (diff LEFT) layouts, so it
                is never unmounted across the Ctrl+\ split toggle (F1). It is NOT a
                document target, so it carries no active-pane ring (the FILE pane
                owns the active state). aria-pressed on its header Split toggle
                reads `splitRendered` (the single "is the split truly rendered"
                source, shared with the Viewer toggles) so it reflects whether the
                split is truly rendered — now true in the diff+file split. */}
            <ChangesView
              changes={vm.changes}
              onClose={closeChanges}
              splitView={splitRendered}
              onToggleSplit={toggleSplitView}
            />
            {/* The divider + RIGHT file pane mount ONLY when the split is on; in
                solo mode they are absent and the wrap is a single column. Rendered
                as FLAT gated children (NOT wrapped in a Fragment) so the right
                Viewer keeps a STABLE positional slot (idx 2) shared with the
                two-doc reading split below: React then REUSES the same right
                <Viewer> instance across the two-doc<->diff+file transition
                (opening/closing Changes while split is on), preserving its scroll
                position, source fold state, and in-pane focus — only ChangesView
                (idx 0) remounts as intended (M-finding: an asymmetric Fragment at
                idx 1 here vs the flat [left|divider|right] below would force a type
                mismatch that remounts the right pane). */}
            {splitRendered && (
              <ColSplitter
                ratio={splitRatio}
                setRatio={setSplitRatio}
                // a-finding: in the diff+file split the LEFT half is the diff, not
                // a reading pane, so the divider's accessible name names what it
                // actually resizes here (diff | file) rather than the generic
                // two-doc "reading panes" label used by the reading split below.
                ariaLabel="Resize diff and file panes"
              />
            )}
            {/* RIGHT half — the App-local file pane. Its × turns split OFF and
                returns to the full-width diff (spec §7). The diff occupies the
                LEFT half, so this is the FORCED active/selection target
                (liveActivePane === 'right'): an Explorer pick opens here, never
                behind the diff. The fold/copy commands target it; targetLine is
                left-only (the store drives the reveal) so it is null here. */}
            {splitRendered && (
              <Viewer
                content={rightContent}
                onClose={closeSplit}
                foldCommand={liveActivePane === 'right' ? foldCommand : null}
                copyCommand={liveActivePane === 'right' ? copyCommand : null}
                targetLine={null}
                mdWidth={mdWidth}
                onToggleMdWidth={toggleMdWidth}
                splitView={splitRendered}
                onToggleSplit={toggleSplitView}
                splitRole="right"
                splitActive={liveActivePane === 'right'}
                onActivate={() => setActivePane('right')}
              />
            )}
          </div>
        ) : /* DIFF OFF: the two-doc reading split mounts on `splitRendered` (the
              single isSplitRendered source) — identical to `splitView` here since
              diffMode is false, but routed through the helper so EVERY split mount
              decision (this two-doc wrap + the diff+file divider/right gates above)
              flows from the one source the VSPLIT-SEL anti-revert test pins
              (tests-finding). */
          splitRendered ? (
          <div className="viewer-split-wrap">
            {/* LEFT half — the store's selected document. Its × closes the file
                (today's behavior); clicking/focusing it makes it active. The
                fold/copy keyboard commands target the ACTIVE pane; the
                search-reveal targetLine always points at the store-selected
                (left) file, so it only flows to the left Viewer. */}
            <Viewer
              content={content}
              onClose={closeFileFromButton}
              foldCommand={liveActivePane === 'left' ? foldCommand : null}
              copyCommand={liveActivePane === 'left' ? copyCommand : null}
              targetLine={targetLine}
              mdWidth={mdWidth}
              onToggleMdWidth={toggleMdWidth}
              splitView={splitRendered}
              onToggleSplit={toggleSplitView}
              splitRole="left"
              splitActive={liveActivePane === 'left'}
              onActivate={() => setActivePane('left')}
            />
            <ColSplitter
              ratio={splitRatio}
              setRatio={setSplitRatio}
              ariaLabel="Resize reading panes"
            />
            {/* RIGHT half — the App-local comparison file pane. Its × turns split
                OFF and returns to the single pane (spec §7). The fold/copy
                commands target it only when it is active; targetLine is left-only
                (the store drives the reveal). */}
            <Viewer
              content={rightContent}
              onClose={closeSplit}
              foldCommand={liveActivePane === 'right' ? foldCommand : null}
              copyCommand={liveActivePane === 'right' ? copyCommand : null}
              targetLine={null}
              mdWidth={mdWidth}
              onToggleMdWidth={toggleMdWidth}
              splitView={splitRendered}
              onToggleSplit={toggleSplitView}
              splitRole="right"
              splitActive={liveActivePane === 'right'}
              onActivate={() => setActivePane('right')}
            />
          </div>
        ) : (
          <Viewer
            content={content}
            onClose={closeFileFromButton}
            foldCommand={foldCommand}
            copyCommand={copyCommand}
            targetLine={targetLine}
            mdWidth={mdWidth}
            onToggleMdWidth={toggleMdWidth}
            splitView={splitRendered}
            onToggleSplit={toggleSplitView}
          />
        )}
        {!explorerHidden && (
          <Splitter
            width={explorerWidth}
            setWidth={setExplorerWidth}
            edge="left"
            ariaLabel="Resize file explorer"
            min={EXPLORER_WIDTH_MIN}
            max={Math.max(EXPLORER_WIDTH_MIN, explorerWidthMax())}
            step={EXPLORER_WIDTH_STEP}
          />
        )}
        {!chatHidden && (
          <Splitter
            width={chatWidth}
            setWidth={setChatWidth}
            edge="right"
            ariaLabel="Resize chat panel"
            min={CHAT_WIDTH_MIN}
            max={Math.max(CHAT_WIDTH_MIN, chatWidthMax())}
            step={CHAT_WIDTH_STEP}
          />
        )}
        {!chatHidden && (
          <Chat
            agents={vm.agents}
            channels={vm.channels}
            messages={vm.messages}
            paused={vm.liveState === 'PAUSED'}
            activeChannel={vm.activeChannel}
            inboxAgent={vm.inboxAgent}
            onSelectChannel={(name) => store.setActiveChannel(name)}
            onOpenInbox={(name) => store.openInbox(name)}
            onCloseInbox={() => store.closeInbox()}
            staleCount={vm.counters.staleAgents ?? 0}
            onRemoveAgent={(name) => {
              // Announce the outcome via the polite live region (the same
              // setStatusMessage idiom as close-file / pane toggles) so the
              // removal is perceivable regardless of focus (SC 4.1.3).
              void store.removeAgent(name).then((removed) => {
                if (removed) setStatusMessage(`Removed ${name} from the roster`);
              });
            }}
            onClearStale={() => {
              void store.clearStaleAgents().then((n) => {
                setStatusMessage(
                  n === 1 ? 'Cleared 1 stale agent' : `Cleared ${n} stale agents`,
                );
              });
            }}
          />
        )}
        {/* Terminal dock (bottom row, spans all columns). The row splitter on
            its top edge resizes it; hidden while maximized (the dock fills the
            body, so there is no seam to drag). Unmounting TerminalPane closes
            the PTY session — the dock's open state IS the session lifetime. */}
        {terminalOpen && !terminalMax && (
          <RowSplitter
            height={terminalHeight}
            setHeight={setTerminalHeight}
            ariaLabel="Resize terminal"
            min={TERMINAL_MIN_HEIGHT}
            max={Math.max(TERMINAL_MIN_HEIGHT, terminalHeightMax(bodyHeightNow()))}
            step={TERMINAL_HEIGHT_STEP}
          />
        )}
        {terminalOpen && (
          <TerminalPane
            height={terminalHeight}
            maximized={terminalMax}
            // Maximize/restore is a deliberate "give me the terminal" action —
            // bump the focus nonce so focus lands in xterm. (The geometry
            // effect in TerminalPane never focuses; only the nonce does.)
            onToggleMaximize={() => {
              setTerminalMax((m) => !m);
              setTerminalFocusNonce((n) => n + 1);
            }}
            onClose={toggleTerminal}
            focusNonce={terminalFocusNonce}
          />
        )}
      </div>
      {settingsOpen && (
        <SettingsPanel
          mdWidth={mdWidth}
          onMdWidthChange={setMdWidthMode}
          theme={vm.theme}
          // The radio's VALUE drives the store directly (not a binary toggle),
          // so the controlled checked state stays authoritative and the control
          // scales past two themes. (SettingsPanel's selectTheme already guards
          // a same-value re-click, so this only fires on a real change.)
          onSelectTheme={(next) => void store.setTheme(next)}
          // Hand off to the Keyboard Shortcuts panel: close Settings first
          // (without stealing focus back to the gear), then open Shortcuts with
          // the gear as the opener so closing Shortcuts returns focus there.
          onOpenShortcuts={() => {
            setSettingsOpen(false);
            settingsOpenerRef.current = null;
            openShortcuts(gearButtonRef.current);
          }}
          onClose={closeSettings}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsPanel
          bindings={vm.keybindings}
          onPersist={(resolved) => void store.setKeybindings(resolved)}
          onClose={closeShortcuts}
        />
      )}
    </div>
  );
}
