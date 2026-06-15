/* ============================================================
 * Loom — TIER 2 e2e: explicit folder arg beats a stale LOOM_ROOT
 * ------------------------------------------------------------
 * REGRESSION GUARD for the "loom . opens the wrong/previous folder" bug.
 *
 * resolveRoot() (src/main/main.ts) used to rank process.env.LOOM_ROOT ABOVE the
 * explicit positional folder argument, so a stale/inherited LOOM_ROOT (it leaks
 * into the user's shell via Loom's OWN integrated terminal, whose PTY inherited
 * the parent's env) made `loom .` silently reopen the PARENT's folder instead of
 * the one the user named. The fix flips the precedence (argv > LOOM_ROOT); the
 * pure decision is unit-tested in test/root-resolve.mjs, but ONLY a real launch
 * with BOTH a positional arg AND a conflicting LOOM_ROOT exercises the impure
 * resolveRoot wiring end-to-end — which is what this spec does.
 *
 * The assertion is the user-visible symptom: the Explorer shows the file that
 * exists ONLY in the named (positional) folder, and NEVER the file that exists
 * only in the stale LOOM_ROOT folder.
 *
 * Note: every OTHER e2e launches with `args: [MAIN_ENTRY]` (no positional) +
 * `env LOOM_ROOT=dir`, which is the launcher/--capture contract — so this is the
 * one spec that passes a positional. It does NOT regress that contract (covered
 * by the no-positional specs); it proves the explicit-arg path on top of it.
 *
 * CI-only (it launches Electron, which the WSL sandbox cannot do); here it must
 * only TYPECHECK (npm run typecheck:e2e) + ENUMERATE (npx playwright test --list).
 * Mirrors the window-close.e2e.ts harness.
 * ============================================================ */
import { test, expect, type ElectronApplication } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/** A temp dir holding a single uniquely-named marker file, so the Explorer's
 *  tree unambiguously reveals WHICH root the app actually opened. */
function makeMarkedDir(prefix: string, marker: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  writeFileSync(path.join(dir, marker), `# ${marker}\n`);
  return dir;
}

test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

// Launch with the CURRENT dir as the positional arg and a DIFFERENT dir in
// LOOM_ROOT (the leaked/stale value). The explicit positional MUST win, so the
// Explorer shows only-in-current.md and never only-in-previous.md. On the OLD
// (buggy) precedence this test fails — the stale LOOM_ROOT folder would open.
test('explicit positional folder beats a stale LOOM_ROOT', async () => {
  const currentDir = makeMarkedDir('loom-e2e-cur-', 'only-in-current.md');
  const staleDir = makeMarkedDir('loom-e2e-stale-', 'only-in-previous.md');
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [MAIN_ENTRY, currentDir],
      env: { ...process.env, LOOM_ROOT: staleDir },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
    const explorer = page.locator('.pane.explorer');
    // The NAMED (positional) folder's file is shown...
    await expect(
      explorer.locator('[role="treeitem"]', { hasText: 'only-in-current.md' }),
    ).toBeVisible();
    // ...and the stale LOOM_ROOT folder's file is NOT present anywhere in the tree.
    await expect(
      explorer.locator('[role="treeitem"]', { hasText: 'only-in-previous.md' }),
    ).toHaveCount(0);
  } finally {
    if (app) await app.close().catch(() => undefined);
    rmSync(currentDir, { recursive: true, force: true });
    rmSync(staleDir, { recursive: true, force: true });
  }
});
