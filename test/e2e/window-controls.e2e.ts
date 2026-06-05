/* ============================================================
 * Loom — TIER 2 e2e: custom frameless window controls (win/linux chrome)
 * ------------------------------------------------------------
 * This is the ONLY layer that can prove the custom min / maximize-restore
 * controls END TO END against a REAL frameless Electron window:
 *
 *   TitleBar.tsx .win-controls (rendered on non-darwin)
 *      → real <button> onClick → window.loom.windowControls.{minimize,toggleMaximize}
 *      → preload bridge (assertInvoke-pinned IPC.WINDOW_*), no caller-supplied id
 *      → main.ts registerWindowControlHandlers: sender-scoped
 *        BrowserWindow.fromWebContents → win.minimize() / isMaximized()?unmaximize():maximize()
 *      → win.on('maximize'|'unmaximize') → webContents.send(IPC.WINDOW_MAXIMIZED)
 *      → preload onMaximizeChange → TitleBar maximize<->restore glyph + aria-label flip
 *
 * The platform default in this harness is linux (no --platform override), so the
 * custom controls render (darwin would use the native inset traffic-lights and
 * render NONE). It launches the REAL built app (dist/main.cjs) with `_electron`,
 * reads the REAL BrowserWindow state via app.evaluate, and drives the REAL
 * buttons — NO prod test hook. Mirrors md-width.e2e.ts / copy-rendered.e2e.ts.
 *
 * CLOSE is deliberately NOT exercised here — clicking it would kill the app
 * mid-suite. The close control is covered in its own isolated, single-test file
 * (window-close.e2e.ts) so it can run last without taking down sibling tests.
 *
 * This spec is CI-only (it launches Electron, which the WSL sandbox cannot do);
 * here it must only TYPECHECK (npm run typecheck:e2e).
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* ---- Build prerequisite ------------------------------------------------- */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/** Make a fresh temp sandbox dir with one .md fixture so the Explorer boots a
 *  live tree (the launch() helper waits on a treeitem). */
function makeFixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-winctl-'));
  writeFileSync(path.join(dir, 'doc.md'), '# Window controls fixture\n');
  return dir;
}

/** Launch the built app rooted at `dir`, wait for the first window + the live
 *  file tree. Mirrors md-width.e2e.ts / navlinks.e2e.ts. */
async function launch(dir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    // LOOM_ROOT is the sandbox root the launcher normally sets (bin/loom.cjs);
    // resolveRoot() honors it byte-for-byte, so the Explorer shows our fixture.
    env: { ...process.env, LOOM_ROOT: dir },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
  return { app, page };
}

/** The live BrowserWindow.isMaximized() of the first window, read in MAIN. */
async function isMaximized(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.isMaximized() : false;
  });
}

/** The live BrowserWindow.getBounds() of the first window, read in MAIN. */
async function getBounds(
  app: ElectronApplication,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const b = win ? win.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
}

/** Drag a Linux frameless edge/corner resize handle by (dx, dy) screen px using
 *  real mouse moves with the button held — the same pointer path the handle's
 *  pointerdown/move/up wiring services. Returns once the button is released. */
async function dragHandle(
  page: Page,
  dirClass: string,
  dx: number,
  dy: number,
): Promise<void> {
  const handle = page.locator(`.win-resize .win-resize-${dirClass}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`resize handle .win-resize-${dirClass} has no box`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move in a few steps so the pointermove handler fires + rAF flushes setBounds.
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
}

/** The live BrowserWindow.isMinimized() of the first window, read in MAIN. */
async function isMinimized(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.isMinimized() : false;
  });
}

/* Guard: a missing build is a setup error, not a test failure. */
test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * 1. The custom controls exist (frameless win/linux chrome)           *
 * ------------------------------------------------------------------ */
// On the harness default (linux) platform the .win-controls group renders THREE
// real buttons — Minimize, Maximize, Close. If the platform gate regressed (e.g.
// rendered on darwin, or never rendered) or a button was dropped, these counts
// fail. The CLOSE button is asserted PRESENT here (never clicked).
test('1: the custom min/max/close controls render on the frameless chrome', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    const controls = page.locator('.titlebar .win-controls');
    await expect(controls).toHaveCount(1);
    await expect(controls.locator('button')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Minimize' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Maximize' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Close window' })).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 2. Clicking Minimize reports the window minimized                   *
 * ------------------------------------------------------------------ */
// Minimize → window.loom.windowControls.minimize() → sender-scoped win.minimize().
// If the IPC wiring or the sender resolution regressed, isMinimized() stays false.
// (WM-dependent: some Linux WMs report minimize asynchronously, so poll.)
test('2: clicking Minimize minimizes the window', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    expect(await isMinimized(app)).toBe(false);
    await page.getByRole('button', { name: 'Minimize' }).click();
    await expect.poll(() => isMinimized(app), { timeout: 10_000 }).toBe(true);
    // Restore so the window is interactable for teardown.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.restore();
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 3. Toggling Maximize flips BrowserWindow.isMaximized() + the glyph  *
 * ------------------------------------------------------------------ */
// Maximize → toggleMaximize() → sender-scoped isMaximized()?unmaximize():maximize().
// The button's accessible name flips Maximize<->Restore from the WINDOW_MAXIMIZED
// push. If the toggle, the sender resolution, or the push wiring regressed,
// isMaximized() never flips (or the label never flips).
test('3: toggling Maximize flips isMaximized() and the button label', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    expect(await isMaximized(app)).toBe(false);
    // Starts as "Maximize"; after toggling it must become "Restore".
    await page.getByRole('button', { name: 'Maximize' }).click();
    await expect.poll(() => isMaximized(app), { timeout: 10_000 }).toBe(true);
    await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(1);

    // Toggle back: unmaximize → isMaximized() false → label back to "Maximize".
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect.poll(() => isMaximized(app), { timeout: 10_000 }).toBe(false);
    await expect(page.getByRole('button', { name: 'Maximize' })).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 4. Double-clicking the titlebar drag region toggles maximize        *
 * ------------------------------------------------------------------ */
// OS convention: double-clicking the drag region toggles maximize. Double-click
// the heading (a drag-region child that is NOT a control button) — it must
// toggle isMaximized(). A double-click ON a control button must NOT also toggle
// (the .win-controls group stops propagation); test 3 already proves a single
// button click toggles exactly once.
test('4: double-clicking the titlebar toggles maximize', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    expect(await isMaximized(app)).toBe(false);
    // Double-click the identity heading (inside the drag region, not a control).
    await page.locator('.titlebar .title-center').dblclick();
    await expect.poll(() => isMaximized(app), { timeout: 10_000 }).toBe(true);
    await page.locator('.titlebar .title-center').dblclick();
    await expect.poll(() => isMaximized(app), { timeout: 10_000 }).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 5. A renderer mounted into an ALREADY-maximized window seeds the    *
 *    glyph from the authoritative pull (WINDOW_IS_MAXIMIZED), not the  *
 *    fire-and-forget did-finish-load push.                            *
 * ------------------------------------------------------------------ */
// Reproduces the exact race the reviewers flagged: the initial WINDOW_MAXIMIZED
// push is sent on did-finish-load — potentially BEFORE the renderer's
// onMaximizeChange listener attaches — and Electron never replays it. The fix
// makes the seed PULL-based: WindowControls' mount effect calls
// window.loom.windowControls.isMaximized() and seeds setMaximized from the
// authoritative main-process value. Here we maximize the window in MAIN, then
// reload the renderer (remounting WindowControls into an already-maximized
// window); the maximize button MUST seed to "Restore", not stale "Maximize".
test('5: a renderer reloaded while maximized seeds the Restore label (pull, not push)', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    // Maximize in MAIN (not via the button) so the renderer is unaware until it
    // queries on mount. WM-dependent on Linux, hence the polled gate.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.maximize();
    });
    await expect.poll(() => isMaximized(app), { timeout: 10_000 }).toBe(true);

    // Reload the renderer: WindowControls remounts into the maximized window and
    // must re-seed from the pull-based isMaximized() invoke. (did-finish-load
    // also re-fires here, but correctness no longer DEPENDS on catching it.)
    await page.reload();
    await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });

    // The seed must reflect the live maximized state — "Restore", never "Maximize".
    await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Maximize' })).toHaveCount(0);

    // Restore in MAIN so teardown leaves a normal window.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.unmaximize();
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 6. Dragging the SE corner resize handle GROWS the window            *
 * ------------------------------------------------------------------ *
 * The Linux frameless edge-resize handles (WindowResizeHandles.tsx, rendered on
 * the harness-default linux platform when NOT maximized) drive
 * window.loom.windowControls.{getBounds,setBounds} through the sender-scoped
 * WINDOW_GET_BOUNDS/WINDOW_SET_BOUNDS handlers + the PURE computeResizeBounds
 * geometry. Dragging the SE corner out by (+dx, +dy) must GROW width AND height
 * (the top-left corner stays put). If the handle render gate, the IPC wiring, or
 * the geometry regressed, the bounds won't grow.
 */
test('6: dragging the SE corner handle grows the window width + height', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    const before = await getBounds(app);
    await dragHandle(page, 'se', 120, 90);
    await expect
      .poll(async () => (await getBounds(app)).width, { timeout: 10_000 })
      .toBeGreaterThan(before.width);
    const after = await getBounds(app);
    expect(after.height).toBeGreaterThan(before.height);
    // The top-left corner (the anchor for an SE drag) must not move.
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 7. Dragging the W edge handle moves x while the right edge stays put *
 * ------------------------------------------------------------------ *
 * A west-edge drag MOVES x and shrinks width by the same amount, so the RIGHT
 * edge (x + width) is fixed (the move-and-shrink rule pinned in the unit suite).
 * Dragging the W handle inward (+dx, toward the window center) must increase x
 * while keeping x + width ≈ the original right edge.
 */
test('7: dragging the W edge handle moves x and keeps the right edge fixed', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    const before = await getBounds(app);
    const rightBefore = before.x + before.width;
    await dragHandle(page, 'w', 80, 0);
    await expect
      .poll(async () => (await getBounds(app)).x, { timeout: 10_000 })
      .toBeGreaterThan(before.x);
    const after = await getBounds(app);
    // The right edge stays put (within a 2px tolerance for HiDPI/step rounding).
    expect(Math.abs(after.x + after.width - rightBefore)).toBeLessThanOrEqual(2);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 8. The TOP handles (n/ne/nw) are inset BELOW the 40px titlebar so   *
 *    they never overlap the min/max/close controls or the drag region *
 * ------------------------------------------------------------------ *
 * Regression guard for the handle-over-controls overlap: the n edge and the
 * ne/nw corners are CSS-inset to top:40px (the bottom of the titlebar). If a
 * future change drops them back to top:0 they would shadow the top sliver of the
 * close/maximize buttons and steal the titlebar's drag/double-click region. Read
 * each top handle's bounding box and assert it starts at or below the 40px bar;
 * also assert the titlebar controls remain hittable (a click on Maximize toggles
 * isMaximized()), proving the handles don't intercept the control's pointerdown.
 */
test('8: the n/ne/nw handles start below the 40px titlebar and never shadow the controls', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    for (const dirClass of ['n', 'ne', 'nw']) {
      const box = await page.locator(`.win-resize .win-resize-${dirClass}`).boundingBox();
      if (!box) throw new Error(`top handle .win-resize-${dirClass} has no box`);
      // The titlebar is 40px tall; the top handles must not intrude into it (a
      // small sub-px tolerance for fractional DPR rounding).
      expect(box.y).toBeGreaterThanOrEqual(39.5);
    }
    // The controls are still fully clickable (no handle intercepts the pointerdown):
    // clicking Maximize through the area the ne corner used to cover must toggle.
    expect(await isMaximized(app)).toBe(false);
    await page.getByRole('button', { name: 'Maximize' }).click();
    await expect.poll(() => isMaximized(app), { timeout: 10_000 }).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.unmaximize();
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
