/* ============================================================
 * Loom — multi-terminal column geometry (pure, fully unit-testable)
 * ------------------------------------------------------------
 * The bottom terminal dock can hold up to THREE terminals laid out
 * side by side in 2 or 3 columns (col | divider | col | divider | col),
 * the HORIZONTAL analog of the center Viewer's two-pane reading split.
 * The layout is driven by per-column fraction ratios fed to CSS as
 * `grid-template-columns` on `.terminal-dock-wrap`, clamped here so no
 * single terminal can collapse below a usable floor.
 *
 * DESIGN: this module has NO React / DOM-instance state and imports
 * nothing from the DOM or Node, so it bundles into the Electron-free
 * testkit (dist/testkit.cjs) and is unit-tested without a browser,
 * mirroring lib/viewer-split.ts. App.tsx (the dock wrap + the inter-
 * terminal ColSplitter instances) is the only stateful consumer.
 * ============================================================ */

/** Hard upper bound on concurrent terminals — the column layout maxes at 3
 *  (spec §3 non-goal: "more than 3 terminals"). The SINGLE source of truth
 *  for the cap on the renderer side; the main-process manager pins its own
 *  `MAX_TERMINALS` independently. */
export const MAX_TERMINALS = 3;
/** Default terminal count when nothing is persisted: 1, a byte-for-byte
 *  visual no-op for upgrading single-terminal users (spec §Decisions). */
export const TERMINAL_COUNT_DEFAULT = 1;
/** Hard minimum width (px) for ANY single terminal column — keeps every
 *  terminal usable (mirrors VIEWER_PANE_MIN: a column can never starve to ~0). */
export const TERMINAL_PANE_MIN = 240;
/** Width (px) of each in-flow divider that sits BETWEEN two terminal columns.
 *  The SINGLE source of truth for that width: App feeds it to CSS as the
 *  `--terminal-divider-w` custom property (so the `.terminal-col-divider` width
 *  and the `.terminal-dock-wrap` grid both read it) AND subtracts the total
 *  divider span from the wrap width before clamping ratios — so the divider
 *  width can never drift between the layout and the geometry math. Every column
 *  is therefore a fraction of the TRUE splittable width (wrap − dividers). */
export const TERMINAL_DIVIDER_W = 8;
/** Persisted localStorage key for the column WIDTH ratios (ephemeral, mirroring
 *  the viewer-split ratio; `terminalCount` itself lives in loom-config.json). */
export const TERMINAL_COLUMNS_RATIOS_KEY = 'loom-terminal-columns-ratios';

/** A live terminal count — exactly the columns the dock can render. The clamped
 *  output type of clampTerminalColumns, mirroring viewer-split's ActivePane
 *  literal-union idiom. */
export type TerminalColumns = 1 | 2 | 3;

/** Clamp a candidate terminal count to the supported column range [1, MAX_TERMINALS].
 *  A non-finite / non-integer input pins to TERMINAL_COUNT_DEFAULT rather than
 *  propagating NaN (mirrors clampSplitRatio's degenerate-input pin). Pure + total
 *  — the SINGLE gate every "how many columns" consumer routes through, so the
 *  1|2|3 invariant holds by construction. */
export function clampTerminalColumns(n: number): TerminalColumns {
  if (!Number.isFinite(n)) return TERMINAL_COUNT_DEFAULT;
  const i = Math.round(n);
  if (i <= 1) return 1;
  if (i >= MAX_TERMINALS) return MAX_TERMINALS as TerminalColumns;
  return i as TerminalColumns;
}

/** The MIN-WIDTH FLOOR (px) the dock wrap needs to host `count` terminals without
 *  any column dropping below TERMINAL_PANE_MIN: `count*min + (count-1)*divider`
 *  (N panes + the N−1 dividers between them). There is NO width clamp on the dock
 *  today, so this is the floor a consumer compares the available wrap width
 *  against (e.g. to decide whether a 3rd column can fit, or how low a resize may
 *  go). Pure + total. */
export function terminalColumnsMinWidth(count: number): number {
  const c = clampTerminalColumns(count);
  return c * TERMINAL_PANE_MIN + (c - 1) * TERMINAL_DIVIDER_W;
}

/** Clamp an array of candidate column ratios so EVERY column keeps at least
 *  TERMINAL_PANE_MIN given the current splittable width (the wrap width minus
 *  all dividers, passed in by the caller). A degenerate width (less than `count`
 *  minimums — e.g. a tiny window) pins to EQUAL fractions so no column inverts
 *  the range; otherwise the candidates are WATER-FILLED so the floor survives:
 *  every returned ratio is >= minFraction (= TERMINAL_PANE_MIN/splitWidth) AND
 *  the array sums to 1. (The earlier "floor-then-renormalize" approach divided
 *  by a floored-sum > 1, which shrank a just-floored column back BELOW the floor;
 *  water-filling pins the starved columns to EXACTLY the floor and redistributes
 *  only the remaining budget among the unpinned ones, so the floor holds.) Pure +
 *  total, the multi-column generalization of clampSplitRatio. */
export function clampColumnRatios(ratios: number[], count: number, splitWidth: number): number[] {
  const c = clampTerminalColumns(count);
  const equal = Array.from({ length: c }, () => 1 / c);
  // Not enough room for `c` usable columns → equalize rather than invert.
  if (!Number.isFinite(splitWidth) || splitWidth <= TERMINAL_PANE_MIN * c) {
    return equal;
  }
  // Take the first `c` finite, positive candidates; fall back to equal per slot.
  const raw = Array.from({ length: c }, (_unused, i) => {
    const r = ratios[i];
    return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : 1 / c;
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  const minFraction = TERMINAL_PANE_MIN / splitWidth;

  // Water-filling. `out` holds each column's final fraction; `pinned` marks
  // columns already fixed at exactly minFraction. Each pass recomputes the
  // unpinned columns' proportional share of the still-free budget
  // (1 − pinnedCount*minFraction) and pins any whose share would fall below the
  // floor. At most `c` passes are needed (one new pin per pass, worst case).
  const out = raw.map((r) => r / sum);
  const pinned = Array.from({ length: c }, () => false);
  for (let pass = 0; pass < c; pass++) {
    const pinnedCount = pinned.reduce((acc, p) => acc + (p ? 1 : 0), 0);
    // Sum the (current) unpinned weights to apportion the free budget.
    let unpinnedWeight = 0;
    for (let i = 0; i < c; i++) {
      if (!pinned[i]) unpinnedWeight += out[i] ?? 0;
    }
    const freeBudget = 1 - pinnedCount * minFraction;
    let newlyPinned = false;
    for (let i = 0; i < c; i++) {
      if (pinned[i]) continue;
      // Proportional share of the free budget; guard a zero unpinned weight
      // (all-equal residue) by splitting the budget evenly among the unpinned.
      const unpinnedRemaining = c - pinnedCount;
      const weight = out[i] ?? 0;
      const share =
        unpinnedWeight > 0
          ? (weight / unpinnedWeight) * freeBudget
          : freeBudget / unpinnedRemaining;
      if (share < minFraction) {
        out[i] = minFraction;
        pinned[i] = true;
        newlyPinned = true;
      } else {
        out[i] = share;
      }
    }
    if (!newlyPinned) break;
  }
  return out;
}

/** Build the `grid-template-columns` value for `count` terminal columns with the
 *  `count − 1` fixed-width divider tracks interleaved between them, following the
 *  viewer-split minmax(0, ratio*(100% − dividers)) pattern: each column is a
 *  `minmax(0, calc(<ratio> * (100% - <totalDividerPx>px)))` track (the minmax(0,…)
 *  lets a column shrink without a content-driven min blowing out the grid) and
 *  each divider is a literal `<TERMINAL_DIVIDER_W>px` track. `ratios` is clamped
 *  & renormalized via clampColumnRatios first, so a single column yields one full
 *  track with no dividers. Pure + total — the SINGLE source of the dock grid
 *  template string. */
export function terminalColumnsTemplate(ratios: number[], count: number, splitWidth: number): string {
  const c = clampTerminalColumns(count);
  const fractions = clampColumnRatios(ratios, c, splitWidth);
  const totalDivider = (c - 1) * TERMINAL_DIVIDER_W;
  const cols = fractions.map(
    (r) => `minmax(0, calc(${r} * (100% - ${totalDivider}px)))`,
  );
  // Interleave a fixed divider track between consecutive columns.
  const tracks: string[] = [];
  cols.forEach((col, i) => {
    if (i > 0) tracks.push(`${TERMINAL_DIVIDER_W}px`);
    tracks.push(col);
  });
  return tracks.join(' ');
}

/** Coerce a raw localStorage value to a finite terminal count in [1, MAX_TERMINALS],
 *  or TERMINAL_COUNT_DEFAULT when unset / garbage / out-of-range (tolerant: garbage
 *  → 1). Pure: takes the stored string (or null). Uses Number() (NOT parseInt) so
 *  trailing garbage like "2cols" is rejected outright rather than silently
 *  truncated — a persisted count is a bare integer, never a CSS value. Mirrors
 *  coerceStoredRatio's closed-gate intent, but resolves to the DEFAULT (not null)
 *  since the count is non-optional for layout. */
export function coerceStoredColumns(raw: string | null): TerminalColumns {
  if (raw === null) return TERMINAL_COUNT_DEFAULT;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return TERMINAL_COUNT_DEFAULT;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return TERMINAL_COUNT_DEFAULT;
  return clampTerminalColumns(n);
}

/** Coerce a raw localStorage value to the column WIDTH ratio array, or null when
 *  unset / garbage / wrong length (so the equal-fraction default applies). Pure:
 *  takes the stored JSON string (or null). Rejects anything that is not a JSON
 *  array of `count` finite positive numbers — a single bad entry voids the whole
 *  set rather than silently substituting. Mirrors coerceStoredRatio's reject-on-
 *  garbage stance; the caller pairs the result with clampColumnRatios. */
export function coerceStoredColumnRatios(raw: string | null, count: number): number[] | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const c = clampTerminalColumns(count);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== c) return null;
  const nums = parsed.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : NaN));
  if (nums.some((v) => Number.isNaN(v))) return null;
  return nums;
}

/** Resolve the ACTIVE terminal index to a valid slot given the live count: clamp
 *  the candidate index into [0, count-1] so a stale/over-range index (e.g. after
 *  a terminal closes and the count drops) can never address a non-existent pane.
 *  A non-finite index pins to 0. Pure + total — the SINGLE "which terminal is
 *  focused" resolver, mirroring viewer-split's effectiveActivePane intent. */
export function clampActiveTerminalIndex(index: number, count: number): number {
  const c = clampTerminalColumns(count);
  if (!Number.isFinite(index)) return 0;
  const i = Math.round(index);
  if (i <= 0) return 0;
  if (i >= c) return c - 1;
  return i;
}

/** Advance the active terminal index by one slot, WRAPPING within the live count
 *  (the cycle/move-focus shortcut, Ctrl+Alt+`). `dir` 'next' steps forward,
 *  'prev' steps back; both wrap modulo the live count so cycling from the last
 *  terminal lands on the first. The candidate index is clamped first so a stale
 *  index still cycles from a valid slot. Pure + total. */
export function cycleTerminalIndex(index: number, count: number, dir: 'next' | 'prev' = 'next'): number {
  const c = clampTerminalColumns(count);
  const cur = clampActiveTerminalIndex(index, c);
  const step = dir === 'next' ? 1 : c - 1;
  return (cur + step) % c;
}
