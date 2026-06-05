/* ============================================================
 * Loom — TIER 2 e2e: custom frameless CLOSE control (ISOLATED)
 * ------------------------------------------------------------
 * Clicking the custom Close control closes the window, which (on win/linux,
 * the harness default) quits the app via window-all-closed. That would KILL the
 * process mid-run for any sibling test, so the close path is deliberately
 * carved out into its OWN single-test file (NOT the shared window-controls
 * suite) and is the LAST behavior exercised against its launched app.
 *
 *   TitleBar.tsx .win-ctl-close onClick → window.loom.windowControls.close()
 *      → preload bridge (assertInvoke-pinned IPC.WINDOW_CLOSE), no caller id
 *      → main.ts registerWindowControlHandlers: sender-scoped
 *        BrowserWindow.fromWebContents(evt.sender).close()
 *
 * playwright.config runs workers:1 with NO intra-file parallelism, so this file
 * runs in its own launched app and tears down cleanly. This spec is CI-only (it
 * launches Electron, which the WSL sandbox cannot do); here it must only
 * TYPECHECK (npm run typecheck:e2e). Mirrors md-width.e2e.ts.
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

function makeFixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-winclose-'));
  writeFileSync(path.join(dir, 'doc.md'), '# Close fixture\n');
  return dir;
}

async function launch(dir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, LOOM_ROOT: dir },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
  return { app, page };
}

test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * Clicking Close closes the window (ISOLATED — last/only test here)   *
 * ------------------------------------------------------------------ */
// Close → window.loom.windowControls.close() → sender-scoped win.close(). The
// window count must drop to zero. If the IPC wiring or the sender resolution
// regressed, the window would stay open and the count assertion fails.
test('clicking Close closes the window', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    expect(app.windows().length).toBe(1);
    await page.getByRole('button', { name: 'Close window' }).click();
    // The window (and, on win/linux, the app) goes away; the app emits 'close'.
    await app.waitForEvent('close', { timeout: 15_000 });
  } finally {
    // app.close() is idempotent: a no-op if the app already exited on the close
    // click, a graceful teardown if it somehow survived.
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
