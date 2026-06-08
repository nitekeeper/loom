/* ============================================================
 * Loom — frameless edge-resize geometry unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE computeResizeBounds geometry behind the Linux frameless
 * edge-resize handles (WindowResizeHandles.tsx): the per-edge grow vs
 * move-and-shrink behavior, the min-clamp that keeps the opposite edge FIXED
 * without inverting the window, corner combining, integer rounding, and the
 * zero-delta no-op. DOM-free: exercises computeResizeBounds from the testkit
 * bundle (the impure pointer/rAF drag wiring is NOT tested here — it only
 * touches window.loom + the DOM, proven by the CI-only e2e drag).
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

/** A roomy start rect with a generous floor, so a normal drag never clamps. */
const START = { x: 100, y: 100, width: 800, height: 600 };
const MIN = { width: 720, height: 480 };

test('RESIZE: east edge grows width by dx; left/top edge fixed', async () => {
  const { computeResizeBounds } = await kit();
  const b = computeResizeBounds('e', START, 50, 999 /* dy ignored on a pure e */, MIN);
  assert.deepEqual(b, { x: 100, y: 100, width: 850, height: 600 });
});

test('RESIZE: south edge grows height by dy; top/left edge fixed', async () => {
  const { computeResizeBounds } = await kit();
  const b = computeResizeBounds('s', START, 999 /* dx ignored on a pure s */, 40, MIN);
  assert.deepEqual(b, { x: 100, y: 100, width: 800, height: 640 });
});

test('RESIZE: se corner combines e (width) + s (height); x/y fixed', async () => {
  const { computeResizeBounds } = await kit();
  const b = computeResizeBounds('se', START, 50, 40, MIN);
  assert.deepEqual(b, { x: 100, y: 100, width: 850, height: 640 });
});

test('RESIZE: west edge moves x by dx AND shrinks width; right edge fixed', async () => {
  const { computeResizeBounds } = await kit();
  // Drag the LEFT edge right by 30: x 100->130, width 800->770; the right edge
  // (x+width = 900) stays put.
  const b = computeResizeBounds('w', START, 30, 0, MIN);
  assert.deepEqual(b, { x: 130, y: 100, width: 770, height: 600 });
  assert.equal(b.x + b.width, START.x + START.width, 'right edge must stay fixed');
});

test('RESIZE: north edge moves y by dy AND shrinks height; bottom edge fixed', async () => {
  const { computeResizeBounds } = await kit();
  // Drag the TOP edge down by 25: y 100->125, height 600->575; the bottom edge
  // (y+height = 700) stays put.
  const b = computeResizeBounds('n', START, 0, 25, MIN);
  assert.deepEqual(b, { x: 100, y: 125, width: 800, height: 575 });
  assert.equal(b.y + b.height, START.y + START.height, 'bottom edge must stay fixed');
});

test('RESIZE: nw corner moves x+y AND shrinks both; right+bottom edges fixed', async () => {
  const { computeResizeBounds } = await kit();
  const b = computeResizeBounds('nw', START, 30, 25, MIN);
  assert.deepEqual(b, { x: 130, y: 125, width: 770, height: 575 });
  assert.equal(b.x + b.width, START.x + START.width, 'right edge fixed');
  assert.equal(b.y + b.height, START.y + START.height, 'bottom edge fixed');
});

test('RESIZE: ne corner GROWS width (e) AND moves y+shrinks height (n); left+bottom fixed', async () => {
  const { computeResizeBounds } = await kit();
  // ne = e on x (east-grow: width++, left/x fixed) + n on y (north move-and-shrink:
  // y moves DOWN, height shrinks, the bottom edge stays put). The two axes resolve
  // independently — this is the only direction whose grow-on-one-axis +
  // move-shrink-on-the-other combination is exercised with a NON-zero delta.
  const b = computeResizeBounds('ne', START, 50, 25, MIN);
  assert.deepEqual(b, { x: 100, y: 125, width: 850, height: 575 });
  assert.equal(b.x, START.x, 'left edge (x) fixed on an e-grow');
  assert.equal(b.y + b.height, START.y + START.height, 'bottom edge fixed on the n move-and-shrink');
});

test('RESIZE: west drag that exceeds the floor clamps width and STOPS x (no inversion)', async () => {
  const { computeResizeBounds } = await kit();
  // dx larger than the available shrink (800 - 720 = 80). Width must clamp to the
  // floor (720), and x must STOP at start.x + start.width - min.width = 180 — the
  // right edge stays put and the window never inverts past it.
  const b = computeResizeBounds('w', START, 500, 0, MIN);
  assert.equal(b.width, MIN.width, 'width clamps to the floor');
  assert.equal(b.x, START.x + START.width - MIN.width, 'x stops so the right edge is fixed');
  assert.equal(b.x, 180);
  assert.equal(b.x + b.width, START.x + START.width, 'right edge stays put under clamp');
});

test('RESIZE: north drag that exceeds the floor clamps height and STOPS y (no inversion)', async () => {
  const { computeResizeBounds } = await kit();
  // dy larger than the available shrink (600 - 480 = 120). Height clamps to the
  // floor (480), y stops at start.y + start.height - min.height = 220.
  const b = computeResizeBounds('n', START, 0, 400, MIN);
  assert.equal(b.height, MIN.height, 'height clamps to the floor');
  assert.equal(b.y, START.y + START.height - MIN.height, 'y stops so the bottom edge is fixed');
  assert.equal(b.y, 220);
  assert.equal(b.y + b.height, START.y + START.height, 'bottom edge stays put under clamp');
});

test('RESIZE: east/south drag below the floor clamps the size (no negative size)', async () => {
  const { computeResizeBounds } = await kit();
  // A large NEGATIVE dx/dy on an e/s drag would shrink below the floor; clamp.
  const e = computeResizeBounds('e', START, -500, 0, MIN);
  assert.equal(e.width, MIN.width, 'east width never drops below the floor');
  assert.equal(e.x, START.x, 'east drag never moves the left edge');
  const s = computeResizeBounds('s', START, 0, -500, MIN);
  assert.equal(s.height, MIN.height, 'south height never drops below the floor');
  assert.equal(s.y, START.y, 'south drag never moves the top edge');
});

test('RESIZE: sw corner clamps each axis INDEPENDENTLY', async () => {
  const { computeResizeBounds } = await kit();
  // sw = w on x + s on y. Over-drag the west edge (clamps x+width) while the south
  // grows normally — the two axes resolve on their own.
  const b = computeResizeBounds('sw', START, 500, 40, MIN);
  assert.equal(b.width, MIN.width, 'x-axis (w) clamps to the floor');
  assert.equal(b.x, 180, 'x stops at the right-edge anchor');
  assert.equal(b.height, 640, 's-axis grows freely');
  assert.equal(b.x + b.width, START.x + START.width, 'right edge fixed');
});

test('RESIZE: a zero delta is a no-op (returns the start rect, integer)', async () => {
  const { computeResizeBounds } = await kit();
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    assert.deepEqual(
      computeResizeBounds(dir, START, 0, 0, MIN),
      { x: 100, y: 100, width: 800, height: 600 },
      `dir ${dir} with a zero delta must be a no-op`,
    );
  }
});

test('RESIZE: fractional start/delta is rounded to integers (setBounds wants ints)', async () => {
  const { computeResizeBounds } = await kit();
  const frac = { x: 100.4, y: 100.6, width: 800.5, height: 600.5 };
  const b = computeResizeBounds('se', frac, 10.3, 10.7, MIN);
  for (const k of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isInteger(b[k]), `${k} must be an integer, got ${b[k]}`);
  }
  // se: x/y unchanged (rounded), width/height grown by the delta (rounded).
  assert.deepEqual(b, {
    x: Math.round(100.4),
    y: Math.round(100.6),
    width: Math.round(800.5 + 10.3),
    height: Math.round(600.5 + 10.7),
  });
});
