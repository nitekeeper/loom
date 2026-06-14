/* ============================================================
 * Loom — terminal-columns helpers unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE multi-terminal COLUMN geometry: the count clamp
 * (1|2|3, degenerate-input pin), the grid-template-columns string
 * (correct track count = count + (count-1) interleaved dividers,
 * minmax(0, calc(...)) shape, a single column has no divider track),
 * the N-pane min-width floor (count*240 + (count-1)*8), the per-column
 * ratio clamp (equalize when the splittable width can't host `count`
 * minimums; else WATER-FILL so EVERY column is >= its min-fraction and
 * the array sums to 1), the stored count/ratio coercion (garbage -> default/null),
 * and the active-index clamp + wrap-cycle. DOM-free: exercises
 * terminal-columns.ts from the testkit bundle (mirror of
 * test/viewer-split.mjs).
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TESTKIT = path.join(root, 'dist', 'testkit.cjs');

let _kit = null;
async function kit() {
  if (_kit) return _kit;
  if (!existsSync(TESTKIT)) {
    throw new Error(`dist/testkit.cjs not found at ${TESTKIT} — run \`npm run build\` first.`);
  }
  _kit = await import(TESTKIT);
  return _kit;
}

test('TCOL-CLAMP: clampTerminalColumns pins into the supported range [1, MAX_TERMINALS]', async () => {
  const { clampTerminalColumns, MAX_TERMINALS, TERMINAL_COUNT_DEFAULT } = await kit();
  assert.equal(MAX_TERMINALS, 3, 'the column layout maxes at 3');
  // In-range integers pass through (the only valid outputs are 1|2|3).
  assert.equal(clampTerminalColumns(1), 1);
  assert.equal(clampTerminalColumns(2), 2);
  assert.equal(clampTerminalColumns(3), 3);
  // Out of range pins to the nearer bound.
  assert.equal(clampTerminalColumns(0), 1, 'below 1 pins to 1');
  assert.equal(clampTerminalColumns(-5), 1, 'negative pins to 1');
  assert.equal(clampTerminalColumns(4), MAX_TERMINALS, 'above the cap pins to MAX_TERMINALS');
  assert.equal(clampTerminalColumns(99), MAX_TERMINALS, 'far above the cap pins to MAX_TERMINALS');
  // Non-integers round to the nearest supported slot.
  assert.equal(clampTerminalColumns(2.4), 2, 'rounds down to 2');
  assert.equal(clampTerminalColumns(2.6), 3, 'rounds up to 3');
  // The clamped output is always one of the literal column counts.
  for (const n of [-1, 0, 1, 2, 3, 4, 2.5, 7]) {
    assert.ok([1, 2, 3].includes(clampTerminalColumns(n)), `clamp(${n}) is 1|2|3`);
  }
  // The default constant itself is in range.
  assert.ok([1, 2, 3].includes(TERMINAL_COUNT_DEFAULT));
});

test('TCOL-CLAMP: non-finite count pins to TERMINAL_COUNT_DEFAULT, never NaN', async () => {
  const { clampTerminalColumns, TERMINAL_COUNT_DEFAULT } = await kit();
  assert.equal(clampTerminalColumns(Number.NaN), TERMINAL_COUNT_DEFAULT, 'NaN ⇒ default');
  assert.equal(clampTerminalColumns(Number.POSITIVE_INFINITY), TERMINAL_COUNT_DEFAULT, '+Inf ⇒ default');
  assert.equal(clampTerminalColumns(Number.NEGATIVE_INFINITY), TERMINAL_COUNT_DEFAULT, '-Inf ⇒ default');
});

test('TCOL-TEMPLATE: track count is count + (count-1) interleaved divider tracks', async () => {
  const { terminalColumnsTemplate } = await kit();
  // A column is a `minmax(...)` track; a divider is a standalone `8px` track
  // sitting BETWEEN two columns (so it always reads `) 8px minmax(`).
  const colCount = (tpl) => (tpl.match(/minmax\(/g) || []).length;
  const dividerCount = (tpl) => (tpl.match(/\) 8px minmax\(/g) || []).length;
  for (const count of [1, 2, 3]) {
    const ratios = Array.from({ length: count }, () => 1 / count);
    const tpl = terminalColumnsTemplate(ratios, count, 5000);
    assert.equal(colCount(tpl), count, `${count} columns ⇒ ${count} minmax tracks`);
    assert.equal(
      dividerCount(tpl),
      count - 1,
      `${count} columns ⇒ ${count - 1} interleaved divider tracks`,
    );
  }
});

test('TCOL-TEMPLATE: single column yields one track with NO divider', async () => {
  const { terminalColumnsTemplate } = await kit();
  const tpl = terminalColumnsTemplate([1], 1, 1000);
  assert.equal((tpl.match(/minmax\(/g) || []).length, 1, 'exactly one column track');
  assert.equal(tpl.includes('8px'), false, 'a single column carries no divider track');
});

test('TCOL-TEMPLATE: each column track is minmax(0, calc(ratio * (100% - dividersPx)))', async () => {
  const { terminalColumnsTemplate, TERMINAL_DIVIDER_W } = await kit();
  // Two-column template: minmax(0, …) lets a column shrink without a content
  // min blowing out the grid, and the calc subtracts the TOTAL divider span so
  // each column is a fraction of the TRUE splittable width.
  const tpl = terminalColumnsTemplate([0.5, 0.5], 2, 2000);
  assert.ok(tpl.includes('minmax(0,'), 'columns use minmax(0, …) to allow shrink');
  assert.ok(tpl.includes('calc('), 'columns use a calc() track');
  assert.ok(tpl.includes('(100% - 8px)'), '2 cols subtract one divider (1 * 8px) from 100%');
  // 3 columns ⇒ two dividers ⇒ subtract 16px.
  const tpl3 = terminalColumnsTemplate([1, 1, 1], 3, 3000);
  assert.ok(tpl3.includes(`(100% - ${2 * TERMINAL_DIVIDER_W}px)`), '3 cols subtract 16px (two dividers)');
});

test('TCOL-MINWIDTH: terminalColumnsMinWidth = count*240 + (count-1)*8', async () => {
  const { terminalColumnsMinWidth, TERMINAL_PANE_MIN, TERMINAL_DIVIDER_W } = await kit();
  for (const count of [1, 2, 3]) {
    const expected = count * TERMINAL_PANE_MIN + (count - 1) * TERMINAL_DIVIDER_W;
    assert.equal(terminalColumnsMinWidth(count), expected, `floor for ${count} columns`);
  }
  // Concrete pins against the documented geometry (240 / 8).
  assert.equal(terminalColumnsMinWidth(1), 240, '1 col ⇒ 240');
  assert.equal(terminalColumnsMinWidth(2), 488, '2 cols ⇒ 2*240 + 8');
  assert.equal(terminalColumnsMinWidth(3), 736, '3 cols ⇒ 3*240 + 2*8');
  // Out-of-range count is clamped first (so the floor never goes degenerate).
  assert.equal(terminalColumnsMinWidth(9), 736, 'over-cap count clamps to the 3-col floor');
});

test('TCOL-RATIOS: equalizes when the splittable width can not host `count` minimums', async () => {
  const { clampColumnRatios, TERMINAL_PANE_MIN } = await kit();
  // splittable <= min*count ⇒ EQUAL fractions rather than invert the range.
  const atBoundary = clampColumnRatios([0.8, 0.2], 2, TERMINAL_PANE_MIN * 2); // 480
  assert.deepEqual(atBoundary, [0.5, 0.5], 'exactly min*count is still degenerate ⇒ equalize');
  const tooSmall = clampColumnRatios([0.9, 0.05, 0.05], 3, 100);
  assert.deepEqual(tooSmall, [1 / 3, 1 / 3, 1 / 3], 'tiny width ⇒ equal thirds');
  // Non-finite width also equalizes (never NaN).
  assert.deepEqual(clampColumnRatios([0.5, 0.5], 2, Number.NaN), [0.5, 0.5], 'NaN width ⇒ equalize');
});

test('TCOL-RATIOS: water-fills skewed inputs so EVERY column >= min-fraction and sum 1', async () => {
  const { clampColumnRatios, TERMINAL_PANE_MIN } = await kit();
  const EPS = 1e-9;
  const splitWidth = 1000; // > 240*2, so the floor (water-fill) path (not equalize) runs.
  const minFraction = TERMINAL_PANE_MIN / splitWidth; // 0.24
  // The CORE contract (design §4 AC5 / the docstring promise): when there IS
  // room (splitWidth > min*count), water-filling guarantees EVERY returned
  // column is >= minFraction AND the array sums to 1. A heavily-skewed input
  // ([0.99, 0.01]) pins the starved column to EXACTLY the floor and gives the
  // rest of the budget to the wide one ⇒ [0.76, 0.24], NOT the old buggy
  // [0.805, 0.195] that left the 2nd column 0.195 < 0.24 below the floor.
  const out = clampColumnRatios([0.99, 0.01], 2, splitWidth);
  assert.ok(Math.abs(out.reduce((a, b) => a + b, 0) - 1) < EPS, 'water-filled ratios sum to 1');
  assert.ok(
    out.every((r) => r >= minFraction - EPS),
    `every column >= minFraction (${minFraction}); got ${JSON.stringify(out)}`,
  );
  assert.ok(out[1] < out[0], 'the originally-larger column stays the wider track');
  assert.ok(Math.abs(out[1] - minFraction) < EPS, 'the starved column pins to exactly the floor');
  assert.ok(Math.abs(out[0] - (1 - minFraction)) < EPS, 'the wide column takes the remaining budget');
  // A 3-column skew where TWO columns would starve: both pin to the floor and
  // the remainder goes to the wide column. Still every column >= floor, sum 1.
  const three = clampColumnRatios([0.98, 0.01, 0.01], 3, splitWidth);
  assert.equal(three.length, 3, '3 columns ⇒ 3 ratios');
  assert.ok(Math.abs(three.reduce((a, b) => a + b, 0) - 1) < EPS, '3-col skew sums to 1');
  assert.ok(
    three.every((r) => r >= minFraction - EPS),
    `3-col skew: every column >= minFraction; got ${JSON.stringify(three)}`,
  );
  assert.ok(
    Math.abs(three[1] - minFraction) < EPS && Math.abs(three[2] - minFraction) < EPS,
    'both starved columns pin to exactly the floor',
  );
  assert.ok(three[0] > three[1] && three[0] > three[2], 'the wide column stays widest');
  // An already-balanced, in-range set passes through unchanged (no inversion):
  // both columns are already >= minFraction, so water-filling is a no-op.
  const balanced = clampColumnRatios([0.5, 0.5], 2, splitWidth);
  assert.deepEqual(balanced, [0.5, 0.5], 'balanced in-range ratios pass through unchanged');
  assert.ok(balanced[0] >= minFraction - EPS && balanced[1] >= minFraction - EPS, 'balanced cols >= floor');
  // A mildly-skewed set both above the floor also passes through untouched.
  assert.deepEqual(clampColumnRatios([0.6, 0.4], 2, splitWidth), [0.6, 0.4], 'both >= floor ⇒ untouched');
  // Plenty-of-room 3-col equal input is identity, summing to 1.
  const wide = clampColumnRatios([1, 1, 1], 3, 3000);
  assert.equal(wide.length, 3, '3 columns ⇒ 3 ratios');
  assert.ok(Math.abs(wide.reduce((a, b) => a + b, 0) - 1) < EPS, '3-col result sums to 1');
  assert.equal(clampColumnRatios([1], 1, 1000).length, 1, '1 column ⇒ 1 ratio');
});

test('TCOL-RATIOS: at min*count + 1 the floor path engages (NOT the equal-fraction array)', async () => {
  const { clampColumnRatios, TERMINAL_PANE_MIN } = await kit();
  const EPS = 1e-9;
  // One px ABOVE the degenerate boundary ⇒ there IS (just barely) room, so the
  // water-fill path runs instead of the equalize fast-path. A SKEWED input must
  // therefore NOT collapse to the equal-fraction array — the floor is so high
  // (minFraction ≈ 0.499 for 2 cols) that both columns are near-equal, but the
  // wider column keeps a sliver more, distinguishing it from a clean equalize.
  const w2 = TERMINAL_PANE_MIN * 2 + 1; // 481
  const out2 = clampColumnRatios([0.99, 0.01], 2, w2);
  const equal2 = [0.5, 0.5];
  assert.ok(
    out2.some((r, i) => Math.abs(r - equal2[i]) > EPS),
    `floor path engaged at min*count+1 ⇒ not the equal array; got ${JSON.stringify(out2)}`,
  );
  assert.ok(Math.abs(out2.reduce((a, b) => a + b, 0) - 1) < EPS, 'sums to 1');
  assert.ok(out2[0] >= TERMINAL_PANE_MIN / w2 - EPS && out2[1] >= TERMINAL_PANE_MIN / w2 - EPS, 'both >= floor');
  assert.ok(out2[0] > out2[1], 'the wider candidate stays the wider column');
  // Same for 3 columns at min*3 + 1.
  const w3 = TERMINAL_PANE_MIN * 3 + 1; // 721
  const out3 = clampColumnRatios([0.9, 0.05, 0.05], 3, w3);
  const equal3 = [1 / 3, 1 / 3, 1 / 3];
  assert.ok(
    out3.some((r, i) => Math.abs(r - equal3[i]) > EPS),
    `3-col floor path engaged at min*3+1 ⇒ not equal thirds; got ${JSON.stringify(out3)}`,
  );
  assert.ok(Math.abs(out3.reduce((a, b) => a + b, 0) - 1) < EPS, '3-col sums to 1');
  assert.ok(out3.every((r) => r >= TERMINAL_PANE_MIN / w3 - EPS), '3-col every column >= floor');
});

test('TCOL-STORE-COUNT: coerceStoredColumns rejects garbage/null/out-of-range to a valid count', async () => {
  const { coerceStoredColumns, TERMINAL_COUNT_DEFAULT } = await kit();
  // Unset / garbage / out-of-range ⇒ the default (count is non-optional for layout).
  for (const bad of [null, '', '   ', 'garbage', '2cols', 'NaN', '{}', '-1', '0']) {
    assert.equal(
      coerceStoredColumns(bad),
      TERMINAL_COUNT_DEFAULT,
      `stored ${JSON.stringify(bad)} ⇒ default`,
    );
  }
  // Valid bare integers pass through; over-range clamps into [1, 3].
  assert.equal(coerceStoredColumns('1'), 1);
  assert.equal(coerceStoredColumns('2'), 2);
  assert.equal(coerceStoredColumns('3'), 3);
  assert.equal(coerceStoredColumns('5'), 3, 'over-range clamps to the cap');
  // Every coerced value is a real column count.
  for (const v of [null, '2', '99', 'x']) {
    assert.ok([1, 2, 3].includes(coerceStoredColumns(v)), `coerce(${JSON.stringify(v)}) is 1|2|3`);
  }
});

test('TCOL-STORE-RATIOS: coerceStoredColumnRatios rejects non-array/wrong-length/bad-entry ⇒ null', async () => {
  const { coerceStoredColumnRatios } = await kit();
  // A valid JSON array of `count` finite positive numbers round-trips.
  assert.deepEqual(coerceStoredColumnRatios('[0.5,0.5]', 2), [0.5, 0.5]);
  assert.deepEqual(coerceStoredColumnRatios('[0.3,0.3,0.4]', 3), [0.3, 0.3, 0.4]);
  // Non-array JSON ⇒ null.
  for (const notArray of ['5', '"x"', '{}', 'true', 'null']) {
    assert.equal(coerceStoredColumnRatios(notArray, 2), null, `non-array ${notArray} ⇒ null`);
  }
  // Wrong length (for the given count) ⇒ null (a single bad set voids the whole thing).
  assert.equal(coerceStoredColumnRatios('[0.5,0.5,0.5]', 2), null, 'too many entries ⇒ null');
  assert.equal(coerceStoredColumnRatios('[0.5]', 2), null, 'too few entries ⇒ null');
  // A single bad entry voids the entire set.
  for (const badEntry of ['[0.5,"x"]', '[0.5,-1]', '[0.5,0]', '[0.5,null]', '[0.5,NaN]']) {
    assert.equal(coerceStoredColumnRatios(badEntry, 2), null, `bad entry in ${badEntry} ⇒ null`);
  }
  // Unset / empty / non-JSON ⇒ null.
  for (const bad of [null, '', '   ', 'not json']) {
    assert.equal(coerceStoredColumnRatios(bad, 2), null, `stored ${JSON.stringify(bad)} ⇒ null`);
  }
});

test('TCOL-ACTIVE: clampActiveTerminalIndex clamps into [0, count-1]; non-finite ⇒ 0', async () => {
  const { clampActiveTerminalIndex } = await kit();
  // In-range index passes through.
  assert.equal(clampActiveTerminalIndex(0, 3), 0);
  assert.equal(clampActiveTerminalIndex(1, 3), 1);
  assert.equal(clampActiveTerminalIndex(2, 3), 2);
  // Over-range pins to the last live slot (e.g. a terminal closed and count dropped).
  assert.equal(clampActiveTerminalIndex(5, 3), 2, 'over-range ⇒ count-1');
  assert.equal(clampActiveTerminalIndex(2, 1), 0, 'stale index with count 1 ⇒ 0');
  // Below 0 pins to 0.
  assert.equal(clampActiveTerminalIndex(-3, 3), 0, 'negative ⇒ 0');
  // Non-finite ⇒ 0 (never NaN).
  assert.equal(clampActiveTerminalIndex(Number.NaN, 3), 0, 'NaN ⇒ 0');
  assert.equal(clampActiveTerminalIndex(Number.POSITIVE_INFINITY, 3), 0, '+Inf ⇒ 0');
});

test('TCOL-CYCLE: cycleTerminalIndex wraps next/prev within the live count', async () => {
  const { cycleTerminalIndex } = await kit();
  // next steps forward, wrapping at the end.
  assert.equal(cycleTerminalIndex(0, 3, 'next'), 1);
  assert.equal(cycleTerminalIndex(1, 3, 'next'), 2);
  assert.equal(cycleTerminalIndex(2, 3, 'next'), 0, 'next from the last wraps to the first');
  // prev steps back, wrapping at the start.
  assert.equal(cycleTerminalIndex(0, 3, 'prev'), 2, 'prev from the first wraps to the last');
  assert.equal(cycleTerminalIndex(1, 3, 'prev'), 0);
  assert.equal(cycleTerminalIndex(2, 3, 'prev'), 1);
  // Default direction is 'next'.
  assert.equal(cycleTerminalIndex(0, 3), 1, 'default dir is next');
  // A single live terminal stays put in either direction.
  assert.equal(cycleTerminalIndex(0, 1, 'next'), 0, 'count 1 ⇒ no move (next)');
  assert.equal(cycleTerminalIndex(0, 1, 'prev'), 0, 'count 1 ⇒ no move (prev)');
  // A stale index is clamped first, then cycled from a valid slot.
  assert.equal(cycleTerminalIndex(9, 3, 'next'), 0, 'stale 9 clamps to 2 then next ⇒ 0');
  assert.equal(cycleTerminalIndex(9, 3, 'prev'), 1, 'stale 9 clamps to 2 then prev ⇒ 1');
});

test('TCOL: constants carry the documented column geometry + key', async () => {
  const {
    TERMINAL_COUNT_DEFAULT,
    TERMINAL_PANE_MIN,
    TERMINAL_DIVIDER_W,
    TERMINAL_COLUMNS_RATIOS_KEY,
    MAX_TERMINALS,
  } = await kit();
  assert.equal(TERMINAL_COUNT_DEFAULT, 1, 'default is a single terminal (visual no-op upgrade)');
  assert.equal(TERMINAL_PANE_MIN, 240, 'per-column min width (mirrors VIEWER_PANE_MIN)');
  assert.equal(TERMINAL_DIVIDER_W, 8, 'inter-column divider width (CSS + clamp source of truth)');
  assert.equal(TERMINAL_COLUMNS_RATIOS_KEY, 'loom-terminal-columns-ratios');
  assert.equal(MAX_TERMINALS, 3, 'the column layout maxes at 3');
});
