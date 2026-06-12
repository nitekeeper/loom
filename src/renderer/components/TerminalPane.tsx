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

export interface TerminalPaneProps {
  /** Current dock height (px) — re-fits the grid when it changes. */
  height: number;
  /** True while the dock fills the whole `.body` (terminal-max). */
  maximized: boolean;
  /** Flip maximize <-> restore (App owns the state; height is preserved). */
  onToggleMaximize(): void;
  /** Close the dock (kills the PTY via unmount cleanup). */
  onClose(): void;
  /** Bumped by App when the dock (re)opens via keyboard so focus lands in
   *  the terminal (mirrors the fold/copy command-nonce idiom). */
  focusNonce: number;
}

/** Resolve a CSS color token to an rgb() string xterm's color parser accepts.
 *  The theme tokens are oklch(), which xterm cannot parse — a hidden probe
 *  element lets the browser serialize the used color as rgb(). Falls back to
 *  the raw value (xterm logs + keeps its default on a parse failure). */
function resolveCssColor(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  try {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb.length > 0 ? rgb : value;
  } catch {
    return value;
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
  focusNonce,
}: TerminalPaneProps): JSX.Element {
  // The xterm mount target (.term-body).
  const hostRef = useRef<HTMLDivElement>(null);
  // Live xterm instance + fit addon + session id, for the re-fit effect.
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
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
          setUnavailable(true); // graceful "terminal unavailable" state
          return;
        }
        sessionRef.current = sessionId;
        term.onData((d) => void window.loom.terminal.input(sessionId, d));
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

  // Re-fit + refocus when the dock geometry changes (splitter height,
  // maximize/restore) or App bumps the focus nonce (keyboard reopen). The
  // ResizeObserver also fires on real size changes; fit() is idempotent.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (term === null || fit === null) return;
    fit.fit();
    const id = sessionRef.current;
    if (id !== null) void window.loom.terminal.resize(id, term.cols, term.rows);
    term.focus();
  }, [height, maximized, focusNonce]);

  return (
    <section className="pane terminal" aria-label="Terminal">
      <div className="pane-head">
        <span>Terminal</span>
        <span className="grow" />
        <button
          type="button"
          className="iconbtn"
          onClick={onToggleMaximize}
          aria-pressed={maximized}
          aria-label={maximized ? 'Restore terminal size' : 'Maximize terminal'}
          title={maximized ? 'Restore terminal size' : 'Maximize terminal'}
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
