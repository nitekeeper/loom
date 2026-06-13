/* ============================================================
 * Loom — split reading-pane geometry (pure, fully unit-testable)
 * ------------------------------------------------------------
 * The center Viewer track can split into TWO reading panes side by
 * side (left | divider | right) to compare two documents — the
 * VERTICAL analog of the bottom-dock terminal pane. The split is
 * driven by the `--viewer-split` custom property on `.body` (the
 * left pane's fraction of the splittable width), clamped here so
 * neither pane can collapse below a usable floor.
 *
 * DESIGN: this module has NO React / DOM-instance state and imports
 * nothing from the DOM or Node, so it bundles into the Electron-free
 * testkit (dist/testkit.cjs) and is unit-tested without a browser,
 * mirroring lib/terminal-pane.ts. App.tsx (useViewerSplit + the
 * vertical ColSplitter) is the only stateful consumer.
 * ============================================================ */

/** Hard minimum width (px) for EITHER reading pane — keeps both usable
 *  (mirrors the column-splitter idiom where a pane can never starve to ~0). */
export const VIEWER_PANE_MIN = 240;
/** Width (px) of the in-flow divider that sits BETWEEN the two panes. The
 *  SINGLE source of truth for that width: App feeds it to CSS as the
 *  `--viewer-divider-w` custom property (so the `.viewer-split-divider` width
 *  and the `.viewer-split-wrap` grid both read it) AND subtracts it from the
 *  wrap width before clamping the ratio — so the divider's width can never
 *  drift between the layout and the geometry math. Both panes are therefore
 *  fractions of the TRUE splittable width (wrap − divider), keeping each one
 *  at least VIEWER_PANE_MIN at the clamp bounds. */
export const VIEWER_DIVIDER_W = 8;
/** Default split ratio (left pane's fraction of the splittable width) when
 *  nothing is persisted: 0.5 = "split in half" (the user's words). */
export const VIEWER_SPLIT_DEFAULT = 0.5;
/** Keyboard nudge step (fraction) for ArrowLeft / ArrowRight on the divider. */
export const VIEWER_SPLIT_STEP = 0.02;
/** Persisted localStorage key for the split-view on/off state ("1"/"0"). */
export const VIEWER_SPLIT_KEY = 'loom-viewer-split';
/** Persisted localStorage key for the split ratio (left pane's fraction). */
export const VIEWER_SPLIT_RATIO_KEY = 'loom-viewer-split-ratio';

/** Which pane is ACTIVE — the one an Explorer selection opens into while
 *  split is on. Off → selection always drives the single (left) document. */
export type ActivePane = 'left' | 'right';

/** Clamp a candidate split ratio to a range that keeps BOTH panes at least
 *  VIEWER_PANE_MIN wide given the current splittable width (the body width
 *  minus the divider, passed in by the caller). A degenerate width (less than
 *  two minimums — e.g. a tiny window) pins to 0.5 so neither pane inverts the
 *  range; otherwise the ratio is bounded so each side keeps its floor. Pure +
 *  total, mirroring clampTerminalHeight's degenerate-input pin. */
export function clampSplitRatio(ratio: number, splitWidth: number): number {
  if (!Number.isFinite(ratio)) return VIEWER_SPLIT_DEFAULT;
  // Not enough room for two usable panes → centre rather than invert.
  if (!Number.isFinite(splitWidth) || splitWidth <= VIEWER_PANE_MIN * 2) {
    return VIEWER_SPLIT_DEFAULT;
  }
  const minFraction = VIEWER_PANE_MIN / splitWidth;
  const maxFraction = 1 - minFraction;
  return Math.min(maxFraction, Math.max(minFraction, ratio));
}

/** Coerce a raw localStorage value to a finite ratio in (0,1), or null when
 *  unset/garbage/out-of-range (so the default applies). Pure: takes the stored
 *  string (or null). Uses Number() (NOT parseFloat) so trailing garbage like
 *  "0.5px" is rejected outright rather than silently truncated — a persisted
 *  ratio is a bare number, never a CSS value. Mirrors md-width's
 *  coerceStoredMdWidth closed-gate intent. */
export function coerceStoredRatio(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  // Number('') === 0, which would wrongly slip past the range gate as a value;
  // an empty/whitespace string is "unset", so reject it explicitly first.
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

/** Resolve which pane an Explorer selection opens into. When split is OFF the
 *  selection always drives the single (left) document — byte-for-byte today's
 *  behavior. When split is ON it opens into the ACTIVE pane so the user can
 *  fill the comparison side. Pure + total. */
export function paneForSelection(splitView: boolean, active: ActivePane): ActivePane {
  return splitView ? active : 'left';
}

/** Resolve the EFFECTIVE active pane once the diff can occupy the LEFT half of
 *  the split. The diff pane is NOT a document target, so while a diff+file split
 *  is rendered (split ON AND diffMode) the active/selection target is FORCED to
 *  the RIGHT (file) pane — an Explorer pick can never land behind the diff, and
 *  the active-pane accent ring stays on the file pane. In every other state the
 *  stored `active` stands (the two-doc reading split is unaffected). Pure +
 *  total — the single source of truth for "where does a pick / the active ring
 *  go" across the composable split. */
export function effectiveActivePane(
  splitView: boolean,
  diffMode: boolean,
  active: ActivePane,
): ActivePane {
  return splitView && diffMode ? 'right' : active;
}

/** Resolve the active pane to set when TURNING ON split: the right pane, so
 *  the user's NEXT file pick naturally fills the empty comparison side (spec
 *  §4). Pure — a named constant behind the toggle so the intent is testable. */
export function activePaneOnSplitOn(): ActivePane {
  return 'right';
}

/** Apply ONE keyboard nudge to the split ratio: ArrowRight ('inc') widens the
 *  LEFT (primary) pane by VIEWER_SPLIT_STEP, ArrowLeft ('dec') narrows it. Pure +
 *  total — the RAW stepped ratio (NOT yet clamped; the App's setRatio runs the
 *  divider-aware clampSplitRatio on the result, exactly as it does for a pointer
 *  drag). Extracted so VIEWER_SPLIT_STEP participates in a BEHAVIORAL assertion
 *  (the ColSplitter's ArrowLeft/ArrowRight handler delegates here) rather than the
 *  step living only as a bare inline `ratio ± VIEWER_SPLIT_STEP` with no test
 *  backing (tests-nit). Home/End are NOT nudges (they request the raw 1/0 bounds),
 *  so they stay in the handler. */
export function nudgeRatio(ratio: number, dir: 'inc' | 'dec'): number {
  return dir === 'inc' ? ratio + VIEWER_SPLIT_STEP : ratio - VIEWER_SPLIT_STEP;
}

/** Whether the split is TRULY rendered (two panes side by side). The crux of the
 *  composable diff+file feature: the split renders whenever `splitView` is on,
 *  REGARDLESS of `diffMode` — the diff no longer owns the whole track in a split,
 *  it just takes the LEFT half beside a file pane. So this is `splitView` alone;
 *  `diffMode` is accepted only to make the diff-aware intent explicit and to PIN
 *  it against the earlier N2 fix (`splitView && !diffMode`) ever creeping back —
 *  if it did, the diff+file split would silently break (panes' aria-pressed off /
 *  the right file pane would not render). Drives every header Split toggle's
 *  aria-pressed AND which Viewer panes mount, so it is the SINGLE "is the split
 *  rendered" source. Pure + total. */
export function isSplitRendered(splitView: boolean, _diffMode: boolean): boolean {
  return splitView;
}
