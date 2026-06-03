/* ============================================================
 * Loom — render-window unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the pure tail-window math the Chat thread + inbox use to
 * bound the DOM (so a 10–20 agent firehose can't freeze the observer
 * pane). DOM-free: exercises tailWindow from the testkit bundle.
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

test('RENDER-WINDOW: under the limit renders everything (not capped)', async () => {
  const { tailWindow } = await kit();
  const w = tailWindow([1, 2, 3], 10);
  assert.deepEqual(w.shown, [1, 2, 3]);
  assert.equal(w.hidden, 0);
  assert.equal(w.total, 3);
  assert.equal(w.capped, false);
});

test('RENDER-WINDOW: exactly at the limit is not capped', async () => {
  const { tailWindow } = await kit();
  const w = tailWindow([1, 2, 3, 4], 4);
  assert.equal(w.capped, false);
  assert.equal(w.hidden, 0);
  assert.deepEqual(w.shown, [1, 2, 3, 4]);
});

test('RENDER-WINDOW: over the limit keeps the TAIL (newest) in order', async () => {
  const { tailWindow } = await kit();
  const items = Array.from({ length: 10 }, (_, i) => i); // 0..9
  const w = tailWindow(items, 3);
  assert.deepEqual(w.shown, [7, 8, 9], 'must keep the last N, order preserved');
  assert.equal(w.hidden, 7);
  assert.equal(w.total, 10);
  assert.equal(w.capped, true);
});

test('RENDER-WINDOW: non-positive / non-integer limit disables the cap', async () => {
  const { tailWindow } = await kit();
  const items = [1, 2, 3, 4, 5];
  for (const bad of [0, -5, 2.5, NaN, Infinity]) {
    const w = tailWindow(items, bad);
    assert.deepEqual(w.shown, items, `limit=${bad} must render all`);
    assert.equal(w.hidden, 0);
    assert.equal(w.capped, false);
  }
});

test('RENDER-WINDOW: empty input', async () => {
  const { tailWindow } = await kit();
  const w = tailWindow([], 5);
  assert.deepEqual(w.shown, []);
  assert.equal(w.hidden, 0);
  assert.equal(w.total, 0);
  assert.equal(w.capped, false);
});

test('RENDER-WINDOW: never mutates the input array', async () => {
  const { tailWindow } = await kit();
  const items = [1, 2, 3, 4, 5];
  const copy = items.slice();
  tailWindow(items, 2);
  assert.deepEqual(items, copy, 'input must be untouched');
});

test('RENDER-WINDOW: the default window is a positive integer and applies when omitted', async () => {
  const { tailWindow, DEFAULT_RENDER_WINDOW } = await kit();
  assert.ok(
    Number.isInteger(DEFAULT_RENDER_WINDOW) && DEFAULT_RENDER_WINDOW > 0,
    'default must be a positive integer',
  );
  const big = Array.from({ length: DEFAULT_RENDER_WINDOW + 50 }, (_, i) => i);
  const w = tailWindow(big); // omit limit -> default
  assert.equal(w.capped, true);
  assert.equal(w.shown.length, DEFAULT_RENDER_WINDOW);
  assert.equal(w.hidden, 50);
  // The tail is preserved: last shown item is the last input item.
  assert.equal(w.shown[w.shown.length - 1], big[big.length - 1]);
});
