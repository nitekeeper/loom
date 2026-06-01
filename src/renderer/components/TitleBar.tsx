/* ============================================================
 * Loom — TitleBar chrome (FR-35)
 * ------------------------------------------------------------
 * Shows the sandbox root name with a lock/sandbox glyph and the
 * "Loom" product identity, plus the non-normative "loom ." label.
 *
 * Window controls are the REAL OS controls on every platform
 * (FR-35: the controls are non-normative). The former faux
 * macOS-style traffic-light dots are GONE.
 *
 * Platform adaptation (see renderer.css, gated on `data-platform`
 * set on <html> from window.loom.platform):
 *   - macOS: the BrowserWindow uses titleBarStyle 'hiddenInset', so
 *     this custom bar IS the title bar. On darwin .win is full-bleed
 *     (renderer.css) so this bar is FLUSH to the window's top-left and
 *     the inset native traffic lights overlay it; CSS gives it left
 *     padding to clear those lights and makes it a window drag region
 *     (-webkit-app-region: drag), with interactive children + the
 *     non-interactive heading opted back out where needed.
 *   - Windows / Linux: the DEFAULT native frame draws the controls
 *     and handles dragging, so this is a plain identity row inside the
 *     centered rounded window panel.
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
 * ============================================================ */
import type { JSX } from 'react';

export interface TitleBarProps {
  rootName: string;
}

export function TitleBar({ rootName }: TitleBarProps): JSX.Element {
  return (
    <div className="titlebar" role="banner">
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
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-faint)',
          }}
        >
          loom .
        </span>
      </div>
    </div>
  );
}
