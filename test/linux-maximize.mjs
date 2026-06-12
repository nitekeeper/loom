/* ============================================================
 * Loom — Linux maximize bounds unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE linuxMaximizeBounds geometry behind the Linux frameless
 * maximize button: single-display workArea return, multi-display selection by
 * largest window/display overlap (getDisplayMatching semantics) with a
 * nearest-center fallback for fully-offscreen windows, and empty-list
 * fallback to the window bounds.
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

test('LINUX-MAXIMIZE: multi-display selects the display containing the window', async () => {
  const { linuxMaximizeBounds } = await kit();
  // Window (x 2100..2900) lies entirely on display B (x 1920..3840)
  const win = { x: 2100, y: 100, width: 800, height: 600 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },       // A
    { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }, // B
  ];
  const result = linuxMaximizeBounds(win, displays);
  assert.deepEqual(result, { x: 1920, y: 0, width: 1920, height: 1040 });
});

test('regression: maximize uses display under window (mixed-resolution dual monitor)', async () => {
  const { linuxMaximizeBounds } = await kit();
  // Dual monitors with DIFFERENT resolutions: primary 1920x1080 at x=0,
  // secondary 2560x1440 at x=1920. The window sits FULLY on the secondary
  // display (near its top-left corner). Its center (2080, 100) is inside the
  // secondary's bounds, yet it is geometrically CLOSER to the primary's
  // display center (960,540; dist ≈1203) than to the secondary's (3200,720;
  // dist ≈1280) — so nearest-center selection maximizes onto the WRONG
  // monitor. Maximize must target the display that CONTAINS the window.
  const win = { x: 1930, y: 0, width: 300, height: 200 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },       // primary
    { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }, // secondary
  ];
  const result = linuxMaximizeBounds(win, displays);
  assert.deepEqual(result, { x: 1920, y: 0, width: 2560, height: 1400 });
});

test('regression: maximize does not jump to smaller second monitor from primary edge', async () => {
  const { linuxMaximizeBounds } = await kit();
  // Inverse layout: primary 2560x1440 at x=0, secondary 1920x1080 at x=2560.
  // The window sits FULLY on the primary, near the shared edge. Its center
  // (2500, 540) is inside the primary's bounds but CLOSER to the secondary's
  // center (3520,540; dist 1020) than the primary's (1280,720; dist ≈1233),
  // so nearest-center selection would maximize it onto the second monitor.
  const win = { x: 2300, y: 440, width: 400, height: 200 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1400 } },       // primary
    { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, workArea: { x: 2560, y: 0, width: 1920, height: 1040 } }, // secondary
  ];
  const result = linuxMaximizeBounds(win, displays);
  assert.deepEqual(result, { x: 0, y: 0, width: 2560, height: 1400 });
});

test('regression: WSL manual maximize on second monitor targets its workArea', async () => {
  const { computeWslToggleMaximize } = await kit();
  // Same mixed-resolution layout via the WSL2 manual-toggle path: a window on
  // the larger second monitor must "fake maximize" to THAT monitor's workArea.
  const win = { x: 1930, y: 0, width: 300, height: 200 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
  ];
  const decision = computeWslToggleMaximize(false, win, null, displays);
  assert.equal(decision.isMaximized, true);
  assert.deepEqual(decision.bounds, { x: 1920, y: 0, width: 2560, height: 1400 });
});

test('regression: offscreen window still falls back to nearest display', async () => {
  const { linuxMaximizeBounds } = await kit();
  // A window dragged fully outside every display (no overlap) must still
  // resolve to SOME display — the nearest one — never return garbage.
  const win = { x: 6000, y: 200, width: 400, height: 300 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
  ];
  const result = linuxMaximizeBounds(win, displays);
  assert.deepEqual(result, { x: 1920, y: 0, width: 2560, height: 1400 });
});

test('regression: WSL toggle re-maximizes onto new display after drag-while-fake-maximized', async () => {
  const { computeWslToggleMaximize } = await kit();
  // User repro: fake-maximize on monitor 1 (manual flag true, preMax recorded),
  // then DRAG the still-flagged window onto monitor 2 and hit maximize again.
  // The window's bounds (monitor-1 workArea SIZE at a monitor-2 position) no
  // longer match the maximized workArea of the display under it, so the toggle
  // must RE-MAXIMIZE onto monitor 2's workArea — not restore the stale
  // monitor-1 preMax bounds.
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },       // monitor 1
    { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }, // monitor 2
  ];
  const preMax = { x: 100, y: 80, width: 1200, height: 800 };           // original monitor-1 floating bounds
  const dragged = { x: 2200, y: 120, width: 1920, height: 1040 };       // dragged onto monitor 2, still flagged maximized
  const decision = computeWslToggleMaximize(true, dragged, preMax, displays);
  assert.equal(decision.isMaximized, true);
  assert.deepEqual(decision.bounds, { x: 1920, y: 0, width: 2560, height: 1400 });
});

test('regression: WSL toggle still restores when window sits exactly at its maximized bounds', async () => {
  const { computeWslToggleMaximize } = await kit();
  // Counterpart guard: an UNDISTURBED fake-maximized window (bounds equal the
  // workArea of the display under it) must keep restoring to preMax bounds.
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
  ];
  const preMax = { x: 2000, y: 80, width: 1200, height: 800 };
  const atMax = { x: 1920, y: 0, width: 2560, height: 1400 };           // exactly monitor 2's workArea
  const decision = computeWslToggleMaximize(true, atMax, preMax, displays);
  assert.equal(decision.isMaximized, false);
  assert.deepEqual(decision.bounds, preMax);
});

test('regression: WSL toggle restores despite 1-2px WM rounding of maximized bounds', async () => {
  const { computeWslToggleMaximize } = await kit();
  // Undisturbed-but-rounded case: WSLg/Mutter can perturb the applied bounds
  // by a pixel or two after setBounds (DIP rounding under fractional scale).
  // The window has NOT been dragged — the toggle must still RESTORE to the
  // preMax bounds, not re-maximize (which would make restore unreachable: a
  // stuck-maximized loop). Stale-flag detection must tolerate <=2px drift on
  // each of x / y / width / height.
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
  ];
  const preMax = { x: 2000, y: 80, width: 1200, height: 800 };
  // Monitor 2's workArea {1920,0,2560,1400} perturbed by 1-2px per edge.
  const rounded = { x: 1922, y: 1, width: 2558, height: 1399 };
  const decision = computeWslToggleMaximize(true, rounded, preMax, displays);
  assert.equal(decision.isMaximized, false);
  assert.deepEqual(decision.bounds, preMax);
});

test('regression: WSL toggle still re-maximizes when drift exceeds the rounding tolerance', async () => {
  const { computeWslToggleMaximize } = await kit();
  // Counterpart guard: 3px is past the <=2px tolerance — treat the window as
  // MOVED and re-maximize onto the display under it (drag detection intact).
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } },
  ];
  const preMax = { x: 2000, y: 80, width: 1200, height: 800 };
  const shifted = { x: 1923, y: 0, width: 2560, height: 1400 }; // x off by 3px
  const decision = computeWslToggleMaximize(true, shifted, preMax, displays);
  assert.equal(decision.isMaximized, true);
  assert.deepEqual(decision.bounds, { x: 1920, y: 0, width: 2560, height: 1400 });
});

test('LINUX-MAXIMIZE: straddling window resolves to the majority-overlap display', async () => {
  const { linuxMaximizeBounds } = await kit();
  // Window straddles the shared edge: 320px-wide slice on A, 480px on B → B wins.
  const win = { x: 1600, y: 100, width: 800, height: 600 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },       // A
    { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }, // B
  ];
  const result = linuxMaximizeBounds(win, displays);
  assert.deepEqual(result, { x: 1920, y: 0, width: 1920, height: 1040 });
});

test('LINUX-MAXIMIZE: exact 50/50 straddle tie resolves to the first display in list order', async () => {
  const { linuxMaximizeBounds } = await kit();
  // Window straddles the shared edge with an EQUAL 400px-wide slice on each
  // side. Pins the deterministic tie-break: strict `>` comparison keeps the
  // FIRST display in getAllDisplays() order (A).
  const win = { x: 1520, y: 100, width: 800, height: 600 };
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },       // A
    { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }, // B
  ];
  const result = linuxMaximizeBounds(win, displays);
  assert.deepEqual(result, { x: 0, y: 0, width: 1920, height: 1040 });
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
