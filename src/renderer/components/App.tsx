/* ============================================================
 * Loom — App shell (FR-34, AC-17)
 * ------------------------------------------------------------
 * The window root: a CSS grid of rows `auto auto 1fr` —
 * TitleBar (chrome) / StatusBar (chrome) / body of three content
 * panes (Explorer | Viewer | Chat). NO terminal pane (OQ-6).
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
import { StatusBar } from './StatusBar.js';
import { Explorer } from './Explorer.js';
import { SearchView } from './SearchView.js';
import { Viewer } from './Viewer.js';
import { Chat } from './Chat.js';
import { ShortcutsPanel } from './ShortcutsPanel.js';
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

  // Keyboard Shortcuts panel open state. App owns it; the StatusBar gear, the
  // fixed Ctrl/Cmd+Comma opener, and the `?shortcuts` capture hint all set it.
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(() =>
    readShortcutsHint(),
  );
  // The control that opened the panel — focus returns here on close (SC 2.4.3).
  const shortcutsOpenerRef = useRef<HTMLElement | null>(null);
  const gearButtonRef = useRef<HTMLButtonElement>(null);

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
        focusOnCloseButton:
          active instanceof Element && active.closest('.viewer-close') !== null,
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
    [store, closeFileFromButton],
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
      // Suspend entirely while the Shortcuts panel owns the keyboard.
      if (shortcutsOpen) return;

      const combo = eventToCombo(e);

      // Fixed, non-rebindable opener: Ctrl/Cmd+Comma opens the panel. Skipped
      // in editable controls so a future text field keeps native behavior.
      // The panel hard-blocks binding any command to a RESERVED combo (KB-2),
      // so the opener can never be shadowed; this branch therefore wins
      // unconditionally for the reserved combo.
      if (isReserved(combo) && !isEditableTarget(e.target)) {
        e.preventDefault();
        openShortcuts(gearButtonRef.current);
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
      // typing (and native combos like Ctrl/Cmd+B bold) is never swallowed.
      if (isEditableTarget(e.target)) return;

      e.preventDefault();
      switch (matched) {
        case 'toggleExplorer':
          toggleExplorer(true);
          break;
        case 'toggleChat':
          toggleChat(true);
          break;
        case 'foldAll':
          fireFoldCommand('fold');
          break;
        case 'unfoldAll':
          fireFoldCommand('unfold');
          break;
        case 'toggleTheme':
          void store.setTheme(vm?.theme === 'dark' ? 'light' : 'dark');
          break;
        case 'togglePause':
          void store.togglePause();
          break;
        case 'openSearch':
          openSearch();
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
    vm?.keybindings,
    vm?.theme,
    store,
    toggleExplorer,
    toggleChat,
    fireFoldCommand,
    openShortcuts,
    runCloseFileCommand,
    openSearch,
  ]);

  if (vm === null) {
    // Pre-boot: render the empty shell so the window is never blank.
    return (
      <div className="win" aria-busy="true">
        <TitleBar rootName="loom" />
      </div>
    );
  }

  return (
    <div className="win">
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
        chatHidden={chatHidden}
        onToggleChat={toggleChat}
        chatToggleRef={chatToggleRef}
        onTogglePause={() => void store.togglePause()}
        onToggleTheme={() =>
          void store.setTheme(vm.theme === 'dark' ? 'light' : 'dark')
        }
        onOpenShortcuts={() => openShortcuts(gearButtonRef.current)}
        shortcutsButtonRef={gearButtonRef}
        shortcutsOpen={shortcutsOpen}
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
          (chatHidden ? ' chat-hidden' : '')
        }
        style={
          {
            ['--explorer-w' as string]: explorerWidth + 'px',
            ['--chat-w' as string]: chatWidth + 'px',
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
            selected={vm.selected}
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
            // because vm.selected becomes null (SC 4.1.2). Both branches
            // announce to the polite live region so the state change is
            // perceivable regardless of focus location (SC 4.1.3 /
            // A11Y-CLOSE-02 / UX-05); the selected row also carries a "close"
            // affordance (title + aria-label suffix) so the toggle-off is
            // discoverable, not a silent accidental action (UX-01 / SC 3.2.4).
            onSelect={(path) => {
              if (path === vm.selected) {
                store.closeFile();
                setStatusMessage('File closed');
              } else {
                store.selectFile(path);
                const name = path.split('/').filter(Boolean).pop() ?? path;
                setStatusMessage(`Opened ${name}`);
              }
            }}
            flashing={vm.flashing}
            justModified={vm.justModified}
            newlyAdded={vm.newlyAdded}
          />
        )}
        <Viewer
          content={content}
          onClose={closeFileFromButton}
          foldCommand={foldCommand}
          targetLine={targetLine}
        />
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
          />
        )}
      </div>
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
