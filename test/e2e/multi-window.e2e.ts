/* ============================================================
 * Loom — TIER 2 e2e: multiple windows (FR — multi-window)
 * ------------------------------------------------------------
 * The ONLY layer that proves the multi-window feature END TO END against
 * REAL Electron BrowserWindows:
 *
 *   TitleBar.tsx .title-actions "New window" <button> onClick
 *      → window.loom.windowControls.newWindow()
 *      → preload bridge (assertInvoke-pinned IPC.WINDOW_NEW), no caller args
 *      → main.ts registerExtraWindowHandlers → createMainWindow(services)
 *      → a SECOND BrowserWindow on the SAME folder, sharing db/engine/MCP but
 *        with its OWN renderer pump (ipc.ts) + its OWN terminal manager (main.ts
 *        windowTerminals), so the two windows never share a pause toggle, a
 *        files counter, or a terminal output sink.
 *
 * The terminal-isolation test is the load-bearing regression guard for the
 * per-window refactor: the PRE-refactor single shared TerminalManager had ONE
 * sink (last attachSink wins) + ONE 3-session pool, so a second window stole the
 * first's output — window 1's pane would go dark. Here each window's terminal
 * must echo ITS OWN command and NEVER the other's.
 *
 * Platform default here is linux (no --platform override), so the custom
 * .title-actions buttons render. It launches the REAL built app (dist/main.cjs)
 * with `_electron`, reads REAL BrowserWindow state via app.evaluate, and drives
 * REAL buttons — no prod test hook. Mirrors window-controls.e2e.ts / terminal.e2e.ts.
 *
 * This spec launches Electron; in a sandbox that cannot, it must at least
 * TYPECHECK (npm run typecheck:e2e) + enumerate (npx playwright test --list).
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* ---- Build prerequisite ------------------------------------------------- */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/* ---- Selectors ----------------------------------------------------------- */
const TREEITEM = '.pane.explorer [role="treeitem"]';
const NEW_WINDOW_BTN = 'button[aria-label="New window (same folder)"]';
const OPEN_FOLDER_BTN = 'button[aria-label="Open folder in new window"]';
const TOGGLE_TERMINAL =
  'button[aria-label="Terminal"], button[aria-label="Toggle terminal"]';
const PANE = '.pane.terminal';
const XTERM = `${PANE} .xterm`;

/** A fresh temp sandbox dir with one marker file so the Explorer tree boots. */
function makeFixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-multiwin-'));
  writeFileSync(path.join(dir, 'readme.md'), '# multi-window e2e fixture\n');
  return dir;
}

/** Launch the built app rooted at `dir`, isolating userData per launch (so
 *  persisted terminal/dock state never leaks across tests — terminal.e2e.ts
 *  idiom). Waits for the first window's live file tree. */
async function launch(dir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const cfgDir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-cfg-'));
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, LOOM_ROOT: dir, SHELL: 'bash', XDG_CONFIG_HOME: cfgDir },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(TREEITEM, { timeout: 30_000 });
  return { app, page };
}

/** Count of live BrowserWindows, read in MAIN. */
async function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** The distinct rootDir each window's sandbox is confined to, read in MAIN via
 *  each window's URL is not reliable; instead assert via the visible title — the
 *  renderer shows the sandbox root name in the <h1>. Same-folder duplication must
 *  therefore show the SAME root name in both windows. */
async function rootNameOf(p: Page): Promise<string> {
  return (await p.locator('.titlebar .title-center b.mono').textContent()) ?? '';
}

/** Open the terminal dock on `p` and wait for xterm to mount. */
async function openTerminal(p: Page): Promise<void> {
  await p.locator(TOGGLE_TERMINAL).click();
  await p.waitForSelector(XTERM, { timeout: 15_000 });
}

/** Type a command into `p`'s focused xterm and press Enter. */
async function runCommand(p: Page, command: string): Promise<void> {
  await p.locator(XTERM).click();
  await p.keyboard.type(command);
  await p.keyboard.press('Enter');
}

/* Guard: a missing build is a setup error, not a test failure. */
test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * 1. The new-window / open-folder action buttons render               *
 * ------------------------------------------------------------------ */
test('1: the New window + Open folder titlebar actions render', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await expect(page.locator(NEW_WINDOW_BTN)).toHaveCount(1);
    await expect(page.locator(OPEN_FOLDER_BTN)).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 2. "New window" opens a SECOND window on the SAME folder            *
 * ------------------------------------------------------------------ */
// Click New window → WINDOW_NEW → createMainWindow(services) → a 2nd live
// BrowserWindow that boots its own renderer (live tree) and shows the SAME
// sandbox root (shared services). If the handler, the bridge, or the second
// createMainWindow regressed, the window count never reaches 2.
test('2: clicking New window opens a 2nd window on the same folder', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    expect(await windowCount(app)).toBe(1);
    const [win2] = await Promise.all([
      app.waitForEvent('window'),
      page.locator(NEW_WINDOW_BTN).click(),
    ]);
    await win2.waitForSelector(TREEITEM, { timeout: 30_000 });
    await expect.poll(() => windowCount(app), { timeout: 10_000 }).toBe(2);
    // Both windows are the SAME folder (shared services) — same root name.
    expect(await rootNameOf(win2)).toBe(await rootNameOf(page));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 3. Closing the 2nd window leaves the 1st alive + functional         *
 * ------------------------------------------------------------------ */
// window-all-closed only quits when EVERY window is gone; closing one window of
// two must NOT quit the app and must NOT break the survivor (its renderer pump +
// terminal manager are independent, torn down per window in 'closed').
test('3: closing one of two windows keeps the other alive', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    const [win2] = await Promise.all([
      app.waitForEvent('window'),
      page.locator(NEW_WINDOW_BTN).click(),
    ]);
    await win2.waitForSelector(TREEITEM, { timeout: 30_000 });
    await expect.poll(() => windowCount(app), { timeout: 10_000 }).toBe(2);

    // Close the SECOND window from main (close() runs its 'closed' teardown).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[1]?.close();
    });
    await expect.poll(() => windowCount(app), { timeout: 10_000 }).toBe(1);

    // The survivor is still interactive: its Explorer tree is still live and the
    // New-window button still works (a third window can be opened).
    await expect(page.locator(TREEITEM).first()).toBeVisible();
    const [win3] = await Promise.all([
      app.waitForEvent('window'),
      page.locator(NEW_WINDOW_BTN).click(),
    ]);
    await win3.waitForSelector(TREEITEM, { timeout: 30_000 });
    await expect.poll(() => windowCount(app), { timeout: 10_000 }).toBe(2);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 4. Each window's terminal is INDEPENDENT (per-window sink + pool)    *
 * ------------------------------------------------------------------ */
// The load-bearing regression guard for the per-window TerminalManager refactor.
// With the PRE-refactor single shared manager (one sink, last-attach-wins; one
// 3-session pool), the second window would steal the output sink and the first
// window's pane would never render its own echo. Here: open a terminal in EACH
// window, run a window-unique echo in each, and assert each pane shows ITS OWN
// marker and NEVER the other window's — proving output routes per window.
test('4: terminals in two windows are isolated (own output only)', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    const [win2] = await Promise.all([
      app.waitForEvent('window'),
      page.locator(NEW_WINDOW_BTN).click(),
    ]);
    await win2.waitForSelector(TREEITEM, { timeout: 30_000 });

    await openTerminal(page);
    await openTerminal(win2);

    await runCommand(page, 'echo ISOLATEDWINONE');
    await runCommand(win2, 'echo ISOLATEDWINTWO');

    // Each window's pane shows ITS OWN echo output...
    await expect(page.locator(PANE)).toContainText('ISOLATEDWINONE', { timeout: 15_000 });
    await expect(win2.locator(PANE)).toContainText('ISOLATEDWINTWO', { timeout: 15_000 });
    // ...and NEVER the other window's (the typed marker only ever entered the
    // owning window's xterm, and output is sink-routed per window).
    await expect(page.locator(PANE)).not.toContainText('ISOLATEDWINTWO');
    await expect(win2.locator(PANE)).not.toContainText('ISOLATEDWINONE');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
