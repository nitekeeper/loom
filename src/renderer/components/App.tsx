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
import { TitleBar } from './TitleBar.js';
import { StatusBar } from './StatusBar.js';
import { Explorer } from './Explorer.js';
import { Viewer } from './Viewer.js';
import { Chat } from './Chat.js';

/** Subscribe a React component to the store via useSyncExternalStore. */
function useViewModel(store: LoomStore): ViewModel | null {
  return useSyncExternalStore(store.subscribe, store.getViewModel, store.getViewModel);
}

/** Resolve FileContent for the selected path via the readFile bridge.
 *  Returns null while empty or loading; ignores stale responses. */
function useFileContent(selected: string | null): FileContent | null {
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
  }, [selected]);

  return content;
}

/** Containers whose innerHTML is agent-authored, renderer-sanitized markdown
 *  (Viewer `.md`, chat `.msg-body`, inbox `.ib-body`). Neutralized links in
 *  these already carry NO href, but we belt-and-braces preventDefault any
 *  anchor activation (mouse click OR keyboard Enter/Space) globally so a
 *  link can never navigate even if a future sink slips an href through
 *  (AC-21 / FR-52 / SEC-5). */
const RENDERED_MARKDOWN_SELECTOR = '.md, .msg-body, .ib-body';

function installGlobalAnchorGuard(): () => void {
  const onActivate = (e: Event): void => {
    if (e instanceof KeyboardEvent) {
      const k = e.key;
      if (k !== 'Enter' && k !== ' ' && k !== 'Spacebar') return;
    }
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const anchor = target.closest('a');
    if (anchor && anchor.closest(RENDERED_MARKDOWN_SELECTOR)) {
      e.preventDefault();
    }
  };
  // Capture phase so we run before any bubbling default-navigation occurs.
  document.addEventListener('click', onActivate, true);
  document.addEventListener('keydown', onActivate, true);
  return () => {
    document.removeEventListener('click', onActivate, true);
    document.removeEventListener('keydown', onActivate, true);
  };
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

/** Persisted localStorage key for the chat-pane width (px). */
const CHAT_WIDTH_KEY = 'loom-chat-width';
/** Default chat width when nothing is persisted (matches the CSS fallback). */
const CHAT_WIDTH_DEFAULT = 400;
/** Hard minimum chat width (px) — keeps the chat usable. */
const CHAT_WIDTH_MIN = 300;
/** Keyboard nudge step (px) for ArrowLeft / ArrowRight. */
const CHAT_WIDTH_STEP = 24;

/** Upper bound: never wider than 720px, and never more than 60% of the
 *  window so the Viewer always keeps usable width (FR — viewer never
 *  collapses). Recomputed on every clamp so window resize is honored. */
function chatWidthMax(): number {
  const vw =
    typeof window !== 'undefined' && window.innerWidth > 0
      ? window.innerWidth
      : 1440;
  return Math.min(720, Math.round(vw * 0.6));
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

interface SplitterProps {
  /** Current chat width (px) — drives aria-valuenow. */
  width: number;
  /** Clamped+persisting width setter. */
  setWidth: (next: number, persist: boolean) => void;
}

/** The draggable Viewer/Chat divider. Pointer drag (capture-based, robust to
 *  fast moves leaving the element) plus full keyboard control. Dragging LEFT
 *  widens the chat (delta = startWidth - (clientX - startX)). */
function Splitter({ width, setWidth }: SplitterProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  // Drag origin, captured on pointerdown so the move math is delta-based.
  const origin = useRef<{ x: number; w: number } | null>(null);

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
      // Drag LEFT (clientX decreases) → wider chat.
      const next = o.w - (e.clientX - o.x);
      setWidth(next, false); // live, un-persisted update
    },
    [setWidth],
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
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowLeft': // widen chat
          next = width + CHAT_WIDTH_STEP;
          break;
        case 'ArrowRight': // narrow chat
          next = width - CHAT_WIDTH_STEP;
          break;
        case 'Home': // max width
          next = chatWidthMax();
          break;
        case 'End': // min width
          next = CHAT_WIDTH_MIN;
          break;
        default:
          return;
      }
      e.preventDefault();
      setWidth(next, true);
    },
    [width, setWidth],
  );

  const max = Math.max(CHAT_WIDTH_MIN, chatWidthMax());

  return (
    <div
      className={dragging ? 'splitter dragging' : 'splitter'}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      aria-valuemin={CHAT_WIDTH_MIN}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
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

  const content = useFileContent(vm?.selected ?? null);

  // Resizable chat width (FR-54). Hook lives above the early return so the
  // hook order stays stable across the pre-boot / booted renders.
  const { width: chatWidth, setWidth: setChatWidth } = useChatWidth();

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
      <StatusBar
        liveState={vm.liveState}
        counters={vm.counters}
        theme={vm.theme}
        onTogglePause={() => void store.togglePause()}
        onToggleTheme={() =>
          void store.setTheme(vm.theme === 'dark' ? 'light' : 'dark')
        }
      />
      <div
        className="body"
        style={{ ['--chat-w' as string]: chatWidth + 'px' } as CSSProperties}
      >
        <Explorer
          rootName={vm.rootName}
          tree={vm.tree}
          selected={vm.selected}
          onSelect={(path) => store.selectFile(path)}
          flashing={vm.flashing}
          justModified={vm.justModified}
          newlyAdded={vm.newlyAdded}
        />
        <Viewer content={content} />
        <Splitter width={chatWidth} setWidth={setChatWidth} />
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
      </div>
    </div>
  );
}
