/* ============================================================
 * Loom — Linux maximize bounds unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE linuxMaximizeBounds geometry behind the Linux frameless
 * maximize button: single-display workArea return, multi-display nearest-by-
 * center-distance selection, and empty-list fallback to the window bounds.
 * DOM-free: exercises linuxMaximizeBounds from the testkit bundle.
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

test('LINUX-MAXIMIZE: single display returns its workArea', async () => {
  const { linuxMaximizeBounds } = await kit();
  const win = { x: 100, y: 100, width: 800, height: 600 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  ];
  const result = linuxMaximizeBounds(win, displays);
  assert.deepEqual(result, { x: 0, y: 0, width: 1920, height: 1040 });
});

test('LINUX-MAXIMIZE: multi-display selects nearest by display center', async () => {
  const { linuxMaximizeBounds } = await kit();
  // Window center ≈ (2500, 400) — closer to display B (center x=2880) than A (center x=960)
  const win = { x: 2100, y: 100, width: 800, height: 600 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },       // A
    { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }, // B
  ];
  const result = linuxMaximizeBounds(win, displays);
  assert.deepEqual(result, { x: 1920, y: 0, width: 1920, height: 1040 });
});

test('LINUX-MAXIMIZE: empty display list returns winBounds unchanged', async () => {
  const { linuxMaximizeBounds } = await kit();
  const win = { x: 100, y: 100, width: 800, height: 600 };
  const result = linuxMaximizeBounds(win, []);
  assert.deepEqual(result, { x: 100, y: 100, width: 800, height: 600 });
});

test('WSL2-MAXIMIZE-REGRESSION: manual maximize targets workArea (bypass WM)', async () => {
  const { computeWslToggleMaximize } = await kit();
  const win = { x: 50, y: 50, width: 800, height: 600 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  ];
  const decision = computeWslToggleMaximize(false, win, null, displays);
  assert.equal(decision.isMaximized, true);
  assert.deepEqual(decision.bounds, { x: 0, y: 0, width: 1920, height: 1040 });
});

test('WSL2-MAXIMIZE-REGRESSION: manual restore returns pre-maximize bounds', async () => {
  const { computeWslToggleMaximize } = await kit();
  const preBounds = { x: 100, y: 80, width: 1200, height: 800 };
  const currentBounds = { x: 0, y: 0, width: 1920, height: 1040 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  ];
  const decision = computeWslToggleMaximize(true, currentBounds, preBounds, displays);
  assert.equal(decision.isMaximized, false);
  assert.deepEqual(decision.bounds, preBounds);
});
