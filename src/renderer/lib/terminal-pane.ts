/* ============================================================
 * Loom — terminal-dock geometry (pure, fully unit-testable)
 * ------------------------------------------------------------
 * The height clamp + persistence constants behind the bottom-dock
 * terminal pane's RowSplitter (App.tsx). The dock height is driven
 * by the `--terminal-h` custom property on `.body`, clamped here so
 * the pane can never collapse below a usable floor nor swallow the
 * three content panes above it.
 *
 * DESIGN: this module has NO React / DOM-instance state and imports
 * nothing from the DOM or Node, so it bundles into the Electron-free
 * testkit (dist/testkit.cjs) and is unit-tested without a browser.
 * App.tsx (useTerminalHeight + RowSplitter) is the only stateful
 * consumer.
 * ============================================================ */

/** Hard minimum dock height (px) — keeps the terminal usable. */
export const TERMINAL_MIN_HEIGHT = 120;
/** Ceiling as a fraction of the `.body` height — the columns above always
 *  keep at least 20% of the body, so the dock can never swallow them
 *  (maximize is a separate, explicit mode — not a drag past this cap). */
export const TERMINAL_MAX_FRACTION = 0.8;
/** Default dock height when nothing is persisted (matches the CSS fallback
 *  in `.body.terminal-open { … var(--terminal-h, 240px) }`). */
export const TERMINAL_DEFAULT_HEIGHT = 240;
/** Keyboard nudge step (px) for ArrowUp / ArrowDown on the row splitter. */
export const TERMINAL_HEIGHT_STEP = 24;
/** Persisted localStorage key for the dock height (px). */
export const TERMINAL_HEIGHT_KEY = 'loom-terminal-height';
/** Persisted localStorage key for the dock open state ("1"/"0"). */
export const TERMINAL_OPEN_KEY = 'loom-terminal-open';

/** Upper bound for the dock height given the current `.body` height (px). */
export function terminalHeightMax(bodyHeight: number): number {
  return Math.round(bodyHeight * TERMINAL_MAX_FRACTION);
}

/** Clamp a candidate dock height into [TERMINAL_MIN_HEIGHT .. 80% of the
 *  body]. A degenerate body (max < min, e.g. a tiny window mid-resize) pins
 *  to the MIN so the pane stays usable rather than inverting the range. */
export function clampTerminalHeight(raw: number, bodyHeight: number): number {
  const max = Math.max(TERMINAL_MIN_HEIGHT, terminalHeightMax(bodyHeight));
  return Math.min(max, Math.max(TERMINAL_MIN_HEIGHT, raw));
}
