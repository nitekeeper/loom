/* ============================================================
 * Loom — TitleBar chrome (FR-35)
 * ------------------------------------------------------------
 * Shows the sandbox root name with a lock/sandbox glyph and the
 * "Loom" product identity, plus the non-normative "loom ." label.
 *
 * Window controls (FR-35, custom frameless chrome):
 *   - macOS: the BrowserWindow uses titleBarStyle 'hiddenInset', so the
 *     NATIVE inset traffic-lights draw the controls — this bar renders NO
 *     custom controls (the .win-controls group is also hidden by CSS on
 *     darwin as a belt-and-braces guard).
 *   - Windows / Linux: the window is FRAMELESS (main.ts mainWindowChrome
 *     returns frame:false), so this bar draws our OWN minimize /
 *     maximize-restore / close controls, right-aligned. They are real
 *     <button>s (keyboard-operable, SR-labelled, :focus-visible ring) wired
 *     to window.loom.windowControls; the maximize button flips to a restore
 *     glyph + label while the window is maximized.
 *
 * Platform adaptation (see renderer.css, gated on `data-platform`
 * set on <html> from window.loom.platform):
 *   - On EVERY platform .win is now full-bleed (renderer.css) so this bar is
 *     FLUSH to the window's top-left and is a window drag region
 *     (-webkit-app-region: drag), with interactive children + the .win-controls
 *     opted back out (no-drag). Double-clicking the drag region toggles
 *     maximize (matching the OS convention), but a button click never does.
 *   - macOS additionally reserves left padding to clear the inset traffic
 *     lights (CSS, darwin only); win/linux get no inset and the controls sit
 *     on the RIGHT.
 *
 * Accessibility (A11Y-TB-01/02/03):
 *   - The bar is a `banner` landmark (the app's primary identity region,
 *     and on macOS the SOLE title bar) so SR users get a landmark to
 *     navigate to (SC 1.3.1 / SC 2.4.1).
 *   - The identity is exposed as the page <h1> with an explicit, clean
 *     accessible name ("<root> in Loom") instead of relying on em-dash
 *     punctuation concatenation (SC 1.3.1).
 *   - The sandbox indicator is an inline SVG (consistent rendering on
 *     EVERY OS — no emoji-font variance) with role="img" + a
 *     self-describing accessible name (SC 1.1.1).
 *   - Each window control is a real <button type="button"> with a clear
 *     aria-label and an aria-hidden inline-SVG glyph (SC 1.1.1, 2.1.1).
 * ============================================================ */
import { useEffect, useState, type JSX } from 'react';

export interface TitleBarProps {
  rootName: string;
}

/** The host platform string, read from the preload bridge with a typeof-window
 *  guard so a test harness without window.loom falls back to the safe default
 *  ('linux' ⇒ custom controls render, matching index.tsx applyPlatformAttr). */
function hostPlatform(): string {
  try {
    if (typeof window !== 'undefined' && typeof window.loom?.platform === 'string') {
      return window.loom.platform;
    }
  } catch {
    /* window.loom unavailable; keep the default. */
  }
  return 'linux';
}

/** The custom min / maximize-restore / close controls (frameless win/linux).
 *  Right-aligned, in OS order (minimize, maximize/restore, close rightmost).
 *  Tracks the live maximize state (seeded false, updated via the WINDOW_MAXIMIZED
 *  push) to flip the maximize<->restore glyph + aria-label. */
function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  // Capture the control surface ONCE so the effect AND the click handlers
  // reference the same optional-chained bridge uniformly (no effect-guards-but-
  // handlers-optional-chain asymmetry). A missing bridge (a future test harness)
  // silently no-ops every action and the controls render inertly. Read on each
  // render is cheap; the bridge identity is stable for the window's lifetime.
  const controls = typeof window !== 'undefined' ? window.loom?.windowControls : undefined;

  useEffect(() => {
    if (!controls) return undefined;
    let mounted = true;
    // SEED deterministically from the authoritative state (pull-based invoke)
    // rather than waiting to catch the fire-and-forget initial WINDOW_MAXIMIZED
    // push, which is sent on did-finish-load — potentially BEFORE this effect
    // subscribes — and is never replayed. This fixes the stale glyph on an
    // in-app reload while maximized. The `mounted` guard drops a late resolve
    // after unmount (React 18 StrictMode double-invoke / fast unmount safe).
    void controls
      .isMaximized()
      .then((m) => {
        if (mounted) setMaximized(m);
      })
      // The capture-only process never registers the window-control handlers, so
      // this seed invoke has no main-side handler there and rejects. Fail soft —
      // keep the default `false` seed — so it never surfaces as an unhandled
      // rejection on a capture/screenshot run; the normal app always registers the
      // handler and resolves the real state.
      .catch(() => {});
    // Subscribe to subsequent live maximize-state changes. The preload helper
    // hands us only the boolean payload (never the IpcRendererEvent) and returns
    // an unsubscribe fn we call on unmount.
    const unsubscribe = controls.onMaximizeChange(setMaximized);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [controls]);

  return (
    <div
      className="win-controls"
      role="group"
      aria-label="Window controls"
      // The titlebar (drag region) toggles maximize on double-click. A
      // double-click that lands on a control button bubbles up to it; stop it
      // here so a rapid double-tap on a button never ALSO toggles maximize
      // (KNOWN FRAMELESS GOTCHA: double-click-max must not fight a button).
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="win-ctl"
        aria-label="Minimize"
        onClick={() => void controls?.minimize()}
      >
        {/* A single horizontal stroke — the universal minimize glyph. */}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className="win-ctl"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        // Ignore the SECOND click of a double-click (detail > 1) so a rapid
        // double-tap directly on this button toggles maximize ONCE instead of
        // flip-flopping (maximize then immediately restore).
        onClick={(e) => {
          if (e.detail > 1) return;
          void controls?.toggleMaximize();
        }}
      >
        {maximized ? (
          // Restore (currently maximized): two offset squares. The back square is
          // drawn as an L-shaped open path tracing ONLY the top + right edges that
          // stick out beyond the front square (it stops where the front square's
          // top-left corner is), so the two glyphs NEVER overlap and there is no
          // region to mask. The front square is a normal outline rect on top.
          // Because nothing relies on a background-colored fill, the glyph reads
          // cleanly at rest AND on hover/active (button face --panel-3/-2) in both
          // themes — fixing the prior fill="var(--titlebar)" seam that mismatched
          // the hover background.
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            {/* Back square's protruding L: down the inner-left to the front
                square's top edge, up to its own top-left, across the top, then
                down the right side to where the front square's right edge meets. */}
            <path
              d="M2.5 3V1a0.5 0.5 0 0 1 0.5-0.5h6a0.5 0.5 0 0 1 0.5 0.5v6a0.5 0.5 0 0 1-0.5 0.5h-2"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* Front square: a normal outline rect, drawn on top. */}
            <rect x="0.5" y="2.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        ) : (
          // Maximize: a single square outline.
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
            <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="win-ctl win-ctl-close"
        aria-label="Close window"
        onClick={() => void controls?.close()}
      >
        {/* An X — the universal close glyph. */}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/** App-level window actions (ALL platforms, incl. darwin where the native
 *  traffic-lights replace .win-controls but these app actions still belong):
 *    - New window: open ANOTHER window onto the SAME folder (shared db/MCP).
 *    - Open folder…: pop the native folder picker -> a new window/process.
 *  Real <button>s mirroring WindowControls' a11y (aria-label + aria-hidden SVG
 *  glyph, no-drag via .titlebar button). A missing bridge silently no-ops. */
function WindowActions(): JSX.Element | null {
  const controls = typeof window !== 'undefined' ? window.loom?.windowControls : undefined;
  // Render nothing when the bridge (or the multi-window methods) is absent, so a
  // test harness / older preload never shows dead buttons.
  if (!controls || typeof controls.newWindow !== 'function') return null;
  return (
    <div className="title-actions" role="group" aria-label="Window actions">
      <button
        type="button"
        className="win-ctl"
        aria-label="New window (same folder)"
        title="New window (same folder)"
        onClick={() => void controls.newWindow()}
      >
        {/* A window outline with a plus — "open another window". */}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <rect x="0.5" y="1.5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
          <path d="M10 6.5v4M8 8.5h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className="win-ctl"
        aria-label="Open folder in new window"
        title="Open folder in new window…"
        onClick={() => void controls.openFolder()}
      >
        {/* A folder outline — "open another folder". */}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path
            d="M0.5 2.5h3l1 1.5h6a0 0 0 0 1 0 0v6a0 0 0 0 1 0 0h-10a0 0 0 0 1 0 0v-7z"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

export function TitleBar({ rootName }: TitleBarProps): JSX.Element {
  // Custom controls everywhere EXCEPT darwin (which keeps the native inset
  // traffic-lights). Read once at render — the platform never changes at runtime.
  const showControls = hostPlatform() !== 'darwin';

  return (
    <div
      className="titlebar"
      role="banner"
      // OS convention: double-clicking the (drag) title bar toggles maximize.
      // The .win-controls group stops double-click propagation (see below) so a
      // double-tap on a button never ALSO toggles maximize.
      onDoubleClick={() => {
        // Mirror WindowControls' uniform optional-chaining: chain BOTH .loom and
        // .windowControls so a partial bridge (loom present, windowControls
        // undefined) fail-softs to a no-op instead of throwing a TypeError.
        if (showControls) void window.loom?.windowControls?.toggleMaximize();
      }}
    >
      {/* The identity is the page heading. Give it an explicit accessible name
          so AT reads a clean "acme-api in Loom" rather than concatenating the
          em dash ("acme-api dash Loom"). The visible text stays unchanged. */}
      <h1
        className="title-center"
        aria-label={`${rootName} in Loom`}
      >
        {/* Inline SVG lock: renders identically on every OS (no emoji-font
            variance) and carries a self-describing, role="img" accessible name.
            aria-hidden visual mark would lose the sandbox signal, so it keeps
            an img role + label. */}
        <svg
          className="lock"
          role="img"
          aria-label="Sandboxed workspace"
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          focusable="false"
        >
          <title>Sandboxed workspace</title>
          <path
            d="M4 7V5a4 4 0 0 1 8 0v2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <rect
            x="3"
            y="7"
            width="10"
            height="7"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
        <b className="mono">{rootName}</b>
        {/* Visually the em-dash suffix; for AT the heading's aria-label above
            already conveys "<root> in Loom", so this run is aria-hidden to avoid
            a doubled/awkward announcement. */}
        <span aria-hidden="true" style={{ color: 'var(--text-faint)' }}>
          — Loom
        </span>
      </h1>
      <div className="title-right">
        {/* App-level window actions (new window / open folder) — shown on EVERY
            platform, including darwin (these are app actions, not frame controls). */}
        <WindowActions />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-faint)',
          }}
        >
          loom .
        </span>
        {/* Custom frameless controls (win32/linux). On darwin we render nothing
            here (native inset traffic-lights), and the CSS also hides the group
            as a guard. The group is a no-drag island inside the drag titlebar. */}
        {showControls ? <WindowControls /> : null}
      </div>
    </div>
  );
}
