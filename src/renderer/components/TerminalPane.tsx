/* ============================================================
 * Loom — bottom-dock terminal pane (xterm.js renderer binding)
 * ------------------------------------------------------------
 * The thin DOM binding between @xterm/xterm and the frozen
 * `window.loom.terminal` bridge (loom:terminal:* — see CONTRACTS.md).
 * Mount opens the SINGLE PTY session in main (cwd = the launch root);
 * unmount closes it — the dock's open state IS the session lifetime
 * (close kills the shell; reopen spawns a fresh one, by design).
 *
 * Law-1 scope: nothing here executes content — the PTY is a deliberate,
 * HUMAN-invoked execution surface living in the main process, reached
 * only over the validated IPC bridge. Agents/MCP can never touch it.
 *
 * Rendering: xterm's DEFAULT DOM renderer only (no canvas/webgl addons),
 * so the CSP stays byte-identical. xterm's stylesheet is imported here
 * and bundled into dist/renderer.css by esbuild's css loader. Theme
 * colors are read live from the existing CSS custom properties (--win/
 * --text/--accent/--accent-soft) and re-applied when <html data-theme>
 * flips, so the terminal tracks the app theme without a remount.
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { eventToCombo } from '../lib/keybindings.js';

export interface TerminalPaneProps {
  /** Current dock height (px) — re-fits the grid when it changes. */
  height: number;
  /** True while the dock fills the whole `.body` (terminal-max). */
  maximized: boolean;
  /** Flip maximize <-> restore (App owns the state; height is preserved). */
  onToggleMaximize(): void;
  /** Close the dock (kills the PTY via unmount cleanup). */
  onClose(): void;
  /** 0-based index of this pane among the live terminals. Drives the unique
   *  `aria-label` (`Terminal N`) + `data-terminal-index` selector hook and the
   *  per-index focus targeting in `focusRequest`. Defaults to 0 (back-compat
   *  with the single-terminal layout). */
  slot?: number;
  /** Per-index focus request from App (replaces the old single shared
   *  `focusNonce`): `targetIndex` names which pane to focus, `nonce` bumps on
   *  each deliberate "give me the terminal" action (keyboard (re)open, maximize/
   *  restore, focus shortcut). This pane focuses its xterm ONLY when
   *  `targetIndex === slot` AND the nonce changed since it was last applied —
   *  never as a resize side effect. With 3 instances a shared nonce would focus
   *  the wrong pane (design R8). */
  focusRequest?: { targetIndex: number; nonce: number };
  /** Canonical combos (resolveBindings output) for the App commands that MUST
   *  fire from inside a focused terminal (toggleTerminal, focusTerminal1/2/3,
   *  cycleTerminalFocus). xterm CONSUMES some chords (notably Ctrl+Alt+`) and
   *  stops their propagation, so the App's bubble-phase dispatcher never sees
   *  them; the custom key handler returns false for these so xterm does NOT
   *  process them and they fall through to the App. RESOLVED (not default) so a
   *  rebound combo is deferred too. */
  appKeyCombos?: ReadonlySet<string>;
}

/** Shared 1×1 scratch canvas for color conversion, cached across reads (the
 *  MutationObserver re-reads all four tokens on every theme flip). */
let colorCanvas: HTMLCanvasElement | null = null;

/** Resolve a CSS color token to an rgb() string xterm's color parser accepts.
 *  The theme tokens are oklch(), which xterm cannot parse — and in Chromium
 *  130 neither a getComputedStyle probe nor a ctx.fillStyle read-back helps:
 *  modern color functions serialize VERBATIM (still oklch). The conversion
 *  that is guaranteed is painting the color onto a 1×1 canvas and reading the
 *  pixel back — getImageData is always 8-bit sRGB. Returns undefined when no
 *  2d context is available (xterm then keeps its built-in defaults). */
function resolveCssColor(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  try {
    colorCanvas ??= document.createElement('canvas');
    colorCanvas.width = 1;
    colorCanvas.height = 1;
    const ctx = colorCanvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return undefined;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  } catch {
    return undefined;
  }
}

/** Map the live app theme tokens onto xterm's theme. Read from the computed
 *  style of <html> so [data-theme] overrides are honored: --win (the viewer/
 *  terminal surface), --text (foreground), --accent (cursor), --accent-soft
 *  (selection) — the same tokens .pane.terminal uses in renderer.css. */
function readXtermTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const theme: ITheme = {};
  const background = resolveCssColor(style.getPropertyValue('--win'));
  const foreground = resolveCssColor(style.getPropertyValue('--text'));
  const cursor = resolveCssColor(style.getPropertyValue('--accent'));
  const selectionBackground = resolveCssColor(style.getPropertyValue('--accent-soft'));
  if (background !== undefined) theme.background = background;
  if (foreground !== undefined) theme.foreground = foreground;
  if (cursor !== undefined) theme.cursor = cursor;
  if (selectionBackground !== undefined) theme.selectionBackground = selectionBackground;
  return theme;
}

/** Maximize/restore glyph: outward corner arrows when restored (action =
 *  maximize), inward when maximized (action = restore) — a non-color,
 *  shape-based state cue (UX-3), drawn like the StatusBar icon set. */
function MaximizeIcon({ maximized }: { maximized: boolean }): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {maximized ? (
        // Restore: arrows pointing INWARD from two corners.
        <>
          <path d="M10 14H4m6 0v6m0-6-7 7" />
          <path d="M14 10h6m-6 0V4m0 6 7-7" />
        </>
      ) : (
        // Maximize: arrows pointing OUTWARD to two corners.
        <>
          <path d="M15 3h6v6m0-6-7 7" />
          <path d="M9 21H3v-6m0 6 7-7" />
        </>
      )}
    </svg>
  );
}

/** Close glyph — same 14px stroke idiom as the Viewer's CloseIcon. */
function CloseIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function TerminalPane({
  height,
  maximized,
  onToggleMaximize,
  onClose,
  slot = 0,
  focusRequest,
  appKeyCombos,
}: TerminalPaneProps): JSX.Element {
  // The xterm mount target (.term-body).
  const hostRef = useRef<HTMLDivElement>(null);
  // Live xterm instance + fit addon + session id, for the re-fit effect.
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  // App terminal-shortcut combos, mirrored to a ref so the (mount-once) xterm
  // custom key handler always reads the CURRENT set (rebinds change it).
  const appKeyCombosRef = useRef<ReadonlySet<string> | undefined>(appKeyCombos);
  appKeyCombosRef.current = appKeyCombos;
  // The pane-head maximize button — the Ctrl+Shift+Tab keyboard escape hatch
  // out of the terminal lands here (xterm swallows plain Tab by design).
  const maxBtnRef = useRef<HTMLButtonElement>(null);
  // Last focusRequest.nonce this pane actually applied. Tracked per-instance so
  // a request aimed at a sibling (targetIndex !== slot) or a re-render with an
  // unchanged nonce never re-steals focus (design R8). Starts null so the very
  // first matching request still focuses.
  const lastFocusNonceRef = useRef<number | null>(null);
  // sessionId === null from open() ⇒ the pty backend failed to load/spawn.
  const [unavailable, setUnavailable] = useState(false);
  // The PTY exited (e.g. the user typed `exit`) — the session id is dead.
  const [ended, setEnded] = useState(false);

  // Mount ONCE: create the terminal, open the PTY session, wire the push
  // streams (filtered by session id), observe container resizes and theme
  // flips. Cleanup closes the session (kills the PTY) and disposes xterm.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const term = new Terminal({ scrollback: 5000, theme: readXtermTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;

    // Wire local keystrokes IMMEDIATELY (before open() resolves) so nothing
    // typed during the PTY spawn is lost: queue until the session id arrives,
    // then flush in order; drop the queue if the open fails.
    let spawnFailed = false;
    const pendingInput: string[] = [];
    term.onData((d) => {
      const id = sessionRef.current;
      if (id !== null) {
        void window.loom.terminal.input(id, d);
      } else if (!spawnFailed) {
        pendingInput.push(d);
      }
    });

    // Keyboard escape hatch (the terminal swallows Tab by design — a shell
    // owns its keys): Ctrl+Shift+Tab moves focus out to the pane header.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Tab' && e.ctrlKey && e.shiftKey) {
        maxBtnRef.current?.focus();
        return false; // swallow — never reaches the shell
      }
      // Defer the App's terminal shortcuts (toggle/focus/cycle) to the App's
      // keydown dispatcher. xterm CONSUMES some chords (e.g. Ctrl+Alt+` cycle)
      // and stops propagation, so returning false here means xterm does NOT
      // process them — they bubble to App instead of being sent to the shell.
      // (Ctrl+1/2/3 already bubble; including them is harmless. Resolved combos
      // so a rebound focus command is deferred too.)
      if (e.type === 'keydown' && appKeyCombosRef.current !== undefined) {
        if (appKeyCombosRef.current.has(eventToCombo(e))) return false;
      }
      return true;
    });

    // Container resize (splitter drag, maximize, window resize) → re-fit the
    // grid, then tell the PTY its new cols/rows.
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      fit.fit();
      const id = sessionRef.current;
      if (id !== null) void window.loom.terminal.resize(id, term.cols, term.rows);
    });
    resizeObserver.observe(host);

    // Theme reactivity: re-read the tokens when <html data-theme> flips.
    const themeObserver = new MutationObserver(() => {
      if (!disposed) term.options.theme = readXtermTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    void window.loom.terminal
      .open({ cols: term.cols, rows: term.rows })
      .then(({ sessionId }) => {
        if (disposed) {
          // Unmounted before open resolved — kill the orphan session.
          if (sessionId !== null) void window.loom.terminal.close(sessionId);
          return;
        }
        if (sessionId === null) {
          spawnFailed = true;
          pendingInput.length = 0; // nothing to flush into
          setUnavailable(true); // graceful "terminal unavailable" state
          return;
        }
        sessionRef.current = sessionId;
        // Flush keystrokes typed while the PTY was spawning, in order.
        for (const d of pendingInput) void window.loom.terminal.input(sessionId, d);
        pendingInput.length = 0;
        unsubData = window.loom.terminal.onData((p) => {
          if (p.sessionId === sessionId) term.write(p.data);
        });
        unsubExit = window.loom.terminal.onExit((p) => {
          if (p.sessionId === sessionId) setEnded(true);
        });
        // A fit may have run while open() was in flight — sync the PTY grid.
        void window.loom.terminal.resize(sessionId, term.cols, term.rows);
        term.focus();
      })
      .catch(() => {
        spawnFailed = true;
        pendingInput.length = 0;
        if (!disposed) setUnavailable(true);
      });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      unsubData?.();
      unsubExit?.();
      const id = sessionRef.current;
      sessionRef.current = null;
      if (id !== null) void window.loom.terminal.close(id); // unmount kills the PTY
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Re-fit when the dock geometry changes (splitter height, maximize/
  // restore). NO focus here — a splitter ArrowUp nudge or drag must never
  // steal focus from the separator mid-resize. The ResizeObserver also fires
  // on real size changes; fit() is idempotent.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (term === null || fit === null) return;
    fit.fit();
    const id = sessionRef.current;
    if (id !== null) void window.loom.terminal.resize(id, term.cols, term.rows);
  }, [height, maximized]);

  // Deliberate, per-index focus hand-off ONLY: App issues a focusRequest on
  // keyboard (re)open, maximize/restore, and the per-terminal focus shortcuts.
  // This pane focuses its xterm only when the request targets THIS slot and
  // carries a nonce it has not already applied — so a shared bump aimed at a
  // sibling pane never steals focus here (design R8), and a re-render with an
  // unchanged nonce is a no-op (never a resize side effect).
  useEffect(() => {
    if (focusRequest === undefined) return;
    if (focusRequest.targetIndex !== slot) return;
    if (focusRequest.nonce === lastFocusNonceRef.current) return;
    lastFocusNonceRef.current = focusRequest.nonce;
    termRef.current?.focus();
  }, [focusRequest, slot]);

  return (
    <section
      // `terminal-maximized` marks the solo-maximized pane: the dock wrap's
      // `.solo-maximized > :not(.terminal-maximized){visibility:hidden}` rule
      // hides the OTHER terminals while this one spans the dock (grid-column
      // 1/-1 + visibility:visible). Without this class the maximized pane is
      // hidden along with its siblings (design §4 solo-maximize).
      className={'pane terminal' + (maximized ? ' terminal-maximized' : '')}
      aria-label={`Terminal ${slot + 1}`}
      data-terminal-index={slot}
    >
      {/* The title carries the keyboard escape hatch hint (Ctrl+Shift+Tab
          focuses the header from inside xterm — see the custom key handler). */}
      <div
        className="pane-head"
        title="Terminal — Ctrl+Shift+Tab moves focus out of the terminal"
      >
        <span>Terminal</span>
        <span className="sr-only">
          , Ctrl+Shift+Tab moves focus out of the terminal
        </span>
        <span className="grow" />
        <button
          type="button"
          className="iconbtn"
          ref={maxBtnRef}
          onClick={onToggleMaximize}
          aria-pressed={maximized}
          aria-label={maximized ? 'Restore terminal size' : 'Maximize terminal'}
          // The shortcut hint is the hard-coded DEFAULT (toggleMaximizeTerminal,
          // Ctrl/Cmd+Shift+M) — like the peer StatusBar toggles, which do not
          // thread the resolved binding through props; a rebind shows only in
          // the Shortcuts panel row, not here.
          title={
            (maximized ? 'Restore terminal size' : 'Maximize terminal') +
            ' (Ctrl/Cmd+Shift+M)'
          }
        >
          <MaximizeIcon maximized={maximized} />
        </button>
        <button
          type="button"
          className="iconbtn"
          onClick={onClose}
          aria-label="Close terminal"
          title="Close terminal (Ctrl/Cmd+`)"
        >
          <CloseIcon />
        </button>
      </div>
      {unavailable && (
        <div className="term-note" role="status">
          Terminal unavailable — the shell backend failed to start.
        </div>
      )}
      {ended && (
        <div className="term-note" role="status">
          Session ended — close and reopen the terminal for a fresh shell.
        </div>
      )}
      <div ref={hostRef} className="term-body" />
    </section>
  );
}
