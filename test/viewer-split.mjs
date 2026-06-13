/* ============================================================
 * Loom — viewer-split helpers unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE split reading-pane logic: the ratio clamp (each pane
 * keeps VIEWER_PANE_MIN, degenerate-width centre pin) behind the
 * vertical ColSplitter, the stored-ratio coercion, the persisted key
 * names, the active-pane/selection resolution, and the rebindable
 * `toggleSplitView` keyboard command (default Ctrl/Cmd+\). DOM-free:
 * exercises viewer-split.ts + keybindings.ts from the testkit bundle
 * (mirror of test/terminal-pane.mjs).
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

test('VSPLIT-RATIO: clampSplitRatio keeps each pane >= VIEWER_PANE_MIN', async () => {
  const { clampSplitRatio, VIEWER_PANE_MIN } = await kit();
  // 1000px splittable, 240px floor ⇒ ratio bounded to [0.24 .. 0.76].
  const w = 1000;
  const minF = VIEWER_PANE_MIN / w; // 0.24
  assert.equal(clampSplitRatio(0.5, w), 0.5, 'in-range value passes through');
  assert.equal(clampSplitRatio(0.01, w), minF, 'below the floor pins to the left min');
  assert.equal(clampSplitRatio(0.99, w), 1 - minF, 'above the ceiling pins to the right min');
});

test('VSPLIT-RATIO: degenerate width (< two minimums) pins to 0.5', async () => {
  const { clampSplitRatio, VIEWER_SPLIT_DEFAULT } = await kit();
  // 400px can't fit two 240px panes (480 needed) ⇒ centre rather than invert.
  assert.equal(clampSplitRatio(0.2, 400), VIEWER_SPLIT_DEFAULT);
  assert.equal(clampSplitRatio(0.8, 400), VIEWER_SPLIT_DEFAULT);
  // The exact boundary (2*min) is still degenerate (no slack for the divider).
  assert.equal(clampSplitRatio(0.3, 480), VIEWER_SPLIT_DEFAULT);
});

test('VSPLIT-RATIO: non-finite inputs fall back, never NaN', async () => {
  const { clampSplitRatio, VIEWER_SPLIT_DEFAULT } = await kit();
  assert.equal(clampSplitRatio(Number.NaN, 1000), VIEWER_SPLIT_DEFAULT, 'NaN ratio ⇒ default');
  assert.equal(clampSplitRatio(0.5, Number.NaN), VIEWER_SPLIT_DEFAULT, 'NaN width ⇒ default');
  assert.equal(clampSplitRatio(0.5, 0), VIEWER_SPLIT_DEFAULT, 'zero width ⇒ default');
});

test('VSPLIT-RATIO: divider-aware floor — the RIGHT pane stays >= min at the upper bound', async () => {
  // M2 regression: the grid gives the two panes (100% - divider) and the
  // divider its own width, so the App caller passes the SPLITTABLE width
  // (wrap - VIEWER_DIVIDER_W) to clampSplitRatio — NOT the raw wrap. Both panes
  // are then fractions of that splittable width, so each stays >= the floor at
  // the clamp bounds. (Passing the raw wrap would leave the right pane at
  // ~min - divider px, under the floor — the bug this pins.)
  const { clampSplitRatio, VIEWER_PANE_MIN, VIEWER_DIVIDER_W } = await kit();
  const wrap = 1000;
  const splitWidth = wrap - VIEWER_DIVIDER_W; // what the App caller passes
  // Upper-bound request (left pane as wide as possible).
  const ratio = clampSplitRatio(0.99, splitWidth);
  const leftPx = ratio * splitWidth; // grid: left = ratio * (wrap - divider)
  const rightPx = splitWidth - leftPx; // grid: right (1fr) = remainder
  assert.ok(
    leftPx >= VIEWER_PANE_MIN - 1e-6,
    `left pane ${leftPx}px must be >= ${VIEWER_PANE_MIN}`,
  );
  assert.ok(
    rightPx >= VIEWER_PANE_MIN - 1e-6,
    `right pane ${rightPx}px must be >= ${VIEWER_PANE_MIN} (divider not charged to it)`,
  );
  // Symmetric at the lower bound.
  const ratioLo = clampSplitRatio(0.01, splitWidth);
  assert.ok(ratioLo * splitWidth >= VIEWER_PANE_MIN - 1e-6, 'left pane >= min at lower bound');
  assert.ok(
    splitWidth - ratioLo * splitWidth >= VIEWER_PANE_MIN - 1e-6,
    'right pane >= min at lower bound',
  );
});

test('VSPLIT-RATIO: coerceStoredRatio accepts a finite (0,1) value', async () => {
  const { coerceStoredRatio } = await kit();
  assert.equal(coerceStoredRatio('0.5'), 0.5);
  assert.equal(coerceStoredRatio('0.3'), 0.3);
  assert.equal(coerceStoredRatio('0.7'), 0.7);
});

test('VSPLIT-RATIO: coerceStoredRatio rejects unset/garbage/out-of-range (⇒ null)', async () => {
  const { coerceStoredRatio } = await kit();
  for (const bad of [null, '', 'half', '0', '1', '-0.5', '1.5', 'NaN', '{}', '0.5px']) {
    assert.equal(coerceStoredRatio(bad), null, `stored ${JSON.stringify(bad)} must be null`);
  }
});

test('VSPLIT-SEL: paneForSelection routes to the active pane only when split is ON', async () => {
  const { paneForSelection } = await kit();
  // Split OFF ⇒ always the single (left) document, regardless of active pane.
  assert.equal(paneForSelection(false, 'left'), 'left');
  assert.equal(paneForSelection(false, 'right'), 'left');
  // Split ON ⇒ the active pane.
  assert.equal(paneForSelection(true, 'left'), 'left');
  assert.equal(paneForSelection(true, 'right'), 'right');
});

test('VSPLIT-SEL: turning split ON makes the RIGHT pane active', async () => {
  const { activePaneOnSplitOn } = await kit();
  // So the user's next Explorer pick fills the empty comparison pane (spec §4).
  assert.equal(activePaneOnSplitOn(), 'right');
});

test('VSPLIT-SEL: effectiveActivePane forces RIGHT only in a diff+file split', async () => {
  const { effectiveActivePane } = await kit();
  // Split OFF: diffMode is irrelevant — the stored active pane stands (and the
  // single-pane default routes through paneForSelection to 'left' anyway).
  assert.equal(effectiveActivePane(false, false, 'left'), 'left');
  // The plainest baseline — split off, no diff, a NON-default stored value: the
  // stored active must pass through unchanged (closes the 8-corner truth table;
  // guards a future short-circuit accidentally forcing 'left' when split is off).
  assert.equal(effectiveActivePane(false, false, 'right'), 'right', 'split off, no diff ⇒ stored active stands');
  assert.equal(effectiveActivePane(false, true, 'left'), 'left', 'split off ⇒ stored active, even in diffMode');
  assert.equal(effectiveActivePane(false, true, 'right'), 'right', 'split off ⇒ stored active stands');
  // Split ON, NOT diffMode: the two-doc reading split is unaffected — the
  // stored active pane is honored exactly as before.
  assert.equal(effectiveActivePane(true, false, 'left'), 'left');
  assert.equal(effectiveActivePane(true, false, 'right'), 'right');
  // Split ON AND diffMode: the diff occupies the LEFT half and is NOT a doc
  // target, so the active/selection pane is FORCED to the RIGHT (file) pane —
  // regardless of the stored value, so an Explorer pick can never land behind
  // the diff and the active-ring stays on the file pane.
  assert.equal(effectiveActivePane(true, true, 'left'), 'right', 'diff+file split ⇒ FORCED right (stored left ignored)');
  assert.equal(effectiveActivePane(true, true, 'right'), 'right', 'diff+file split ⇒ right');
});

test('VSPLIT-SEL: paneForSelection over effectiveActivePane never targets the diff (left) pane', async () => {
  const { paneForSelection, effectiveActivePane } = await kit();
  // Integration of the two pure helpers as App composes them: while a diff+file
  // split is rendered, a selection ALWAYS routes to the right (file) pane — the
  // diff (left half) is never a document target (spec §3).
  for (const stored of ['left', 'right']) {
    assert.equal(
      paneForSelection(true, effectiveActivePane(true, true, stored)),
      'right',
      `diff+file split with stored=${stored} ⇒ pick opens RIGHT`,
    );
  }
  // Without diffMode the two-doc split still honors the stored active pane.
  assert.equal(paneForSelection(true, effectiveActivePane(true, false, 'left')), 'left');
  assert.equal(paneForSelection(true, effectiveActivePane(true, false, 'right')), 'right');
});

test('VSPLIT-SEL: isSplitRendered tracks splitView and the N2 fix no longer suppresses diffMode', async () => {
  const { isSplitRendered } = await kit();
  // The CRUX of the composable feature (brief §2): the split renders whenever
  // splitView is on, REGARDLESS of diffMode — the earlier N2 fix
  // `splitView && !diffMode` MUST be gone. This pins the anti-revert: if someone
  // reintroduced the diffMode guard IN THE HELPER, the (true,true) assertion turns
  // RED instead of the diff+file split silently breaking, with the whole green
  // suite still passing.
  //
  // ACCURACY (tests-finding): the helper is now the SINGLE source that governs
  // BOTH the panes' aria-pressed (the `splitView` prop) AND which Viewer panes
  // MOUNT — App.tsx routes the diff+file divider/right-pane mount gates, the
  // --solo wrap class, AND the two-doc wrap through `splitRendered =
  // isSplitRendered(splitView, diffMode)` (not an inline `splitView`/`splitView &&
  // !diffMode`). So re-introducing the N2 guard in this helper body would now turn
  // the right FILE pane OFF in the diff+file split too — not merely flip
  // aria-pressed — and THIS unit test would catch the helper regression at its
  // true single source. (The exact JSX mount wiring is additionally covered by
  // e2e; this pins the pure source both consume.)
  assert.equal(isSplitRendered(false, false), false, 'split off ⇒ not rendered');
  assert.equal(isSplitRendered(false, true), false, 'split off + diff ⇒ not rendered (full-width Changes)');
  assert.equal(isSplitRendered(true, false), true, 'split on, no diff ⇒ two-doc split rendered');
  assert.equal(
    isSplitRendered(true, true),
    true,
    'split on AND diff ⇒ STILL rendered (diff+file split) — N2 `splitView && !diffMode` is gone',
  );
});

test('VSPLIT-SEL: nudgeRatio steps the ratio by VIEWER_SPLIT_STEP (the ColSplitter arrow nudge)', async () => {
  const { nudgeRatio, VIEWER_SPLIT_STEP } = await kit();
  // The ColSplitter's ArrowRight ('inc') widens the LEFT pane by one step,
  // ArrowLeft ('dec') narrows it — RAW (the App clamps the result downstream,
  // exactly as it does for a drag). This gives VIEWER_SPLIT_STEP a BEHAVIORAL
  // assertion instead of a bare value-pin (tests-nit): a wrong step now fails a
  // real step computation, not just the literal-equality below.
  assert.equal(nudgeRatio(0.5, 'inc'), 0.5 + VIEWER_SPLIT_STEP, 'inc adds one step');
  assert.equal(nudgeRatio(0.5, 'dec'), 0.5 - VIEWER_SPLIT_STEP, 'dec subtracts one step');
  // Two nudges in opposite directions return to the origin (the step is symmetric).
  assert.ok(
    Math.abs(nudgeRatio(nudgeRatio(0.5, 'inc'), 'dec') - 0.5) < 1e-9,
    'inc then dec is a round-trip to the start',
  );
});

test('VSPLIT: constants carry the documented split geometry + keys', async () => {
  const {
    VIEWER_PANE_MIN,
    VIEWER_DIVIDER_W,
    VIEWER_SPLIT_DEFAULT,
    VIEWER_SPLIT_STEP,
    VIEWER_SPLIT_KEY,
    VIEWER_SPLIT_RATIO_KEY,
  } = await kit();
  assert.equal(VIEWER_PANE_MIN, 240);
  assert.equal(VIEWER_DIVIDER_W, 8, 'the shared divider width (CSS + clamp source of truth)');
  assert.equal(VIEWER_SPLIT_DEFAULT, 0.5, 'default is "split in half"');
  // The keyboard nudge step — pinned here as a value AND exercised behaviorally
  // by the VSPLIT-SEL nudgeRatio test above (so a wrong step fails a real step
  // computation, not just this literal equality — tests-nit).
  assert.equal(VIEWER_SPLIT_STEP, 0.02);
  assert.equal(VIEWER_SPLIT_KEY, 'loom-viewer-split');
  assert.equal(VIEWER_SPLIT_RATIO_KEY, 'loom-viewer-split-ratio');
});

test('VSPLIT-KB: toggleSplitView command exists with default Ctrl+\\', async () => {
  const { COMMANDS, resolveBindings, eventToCombo } = await kit();
  const spec = COMMANDS.find((c) => c.id === 'toggleSplitView');
  assert.ok(spec, 'a toggleSplitView command is registered');
  assert.equal(spec.label, 'Toggle split reading pane', 'label matches the design');
  assert.equal(spec.defaultBinding, 'Ctrl+\\', 'default binding is Ctrl/Cmd+\\');
  assert.equal(
    resolveBindings(undefined).toggleSplitView,
    'Ctrl+\\',
    'resolved default carries the combo',
  );
  // The backslash keypress canonicalizes to the default binding.
  assert.equal(
    eventToCombo({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: '\\' }),
    'Ctrl+\\',
  );
  // Cmd == Ctrl: a macOS Cmd+\ canonicalizes to the same combo.
  assert.equal(
    eventToCombo({ ctrlKey: false, metaKey: true, shiftKey: false, altKey: false, key: '\\' }),
    'Ctrl+\\',
  );
});

test('VSPLIT-KB: the default Ctrl+\\ is structurally valid and collides with nothing', async () => {
  const { isValidBinding, findConflict, DEFAULT_BINDINGS } = await kit();
  assert.equal(isValidBinding('Ctrl+\\'), true, 'Ctrl+\\ parses as a real binding');
  assert.equal(
    findConflict(DEFAULT_BINDINGS, 'Ctrl+\\', 'toggleSplitView'),
    null,
    'no other command default claims Ctrl+\\',
  );
});

test('VSPLIT-KB: Ctrl+\\ is NOT shell-reserved (so the command can fire)', async () => {
  const { isReserved } = await kit();
  assert.equal(isReserved('Ctrl+\\'), false, 'Ctrl+\\ is not shell-reserved');
});

test('VSPLIT-KB: Ctrl+\\ (split) is distinct from Ctrl+` (terminal)', async () => {
  const { DEFAULT_BINDINGS } = await kit();
  // Backslash and backtick are different keys — the two toggles never collide.
  assert.equal(DEFAULT_BINDINGS.toggleSplitView, 'Ctrl+\\');
  assert.equal(DEFAULT_BINDINGS.toggleTerminal, 'Ctrl+`');
  assert.notEqual(DEFAULT_BINDINGS.toggleSplitView, DEFAULT_BINDINGS.toggleTerminal);
});
