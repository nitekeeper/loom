/* ============================================================
 * Loom — TIER 2 e2e: Go to Definition (CI-only)
 * ------------------------------------------------------------
 * End-to-end coverage for the go-to-definition feature:
 *   - F12 on the symbol under the caret navigates to its definition,
 *   - Ctrl/Cmd-click on a symbol navigates to its definition,
 *   - more than one candidate shows the DefinitionPicker chooser; Enter jumps,
 *   - Alt+ArrowLeft (Go Back) returns to the prior reading location.
 *
 * Flow under test:
 *   F12 (goToDefinition) / Ctrl-click → CodeView glue derives the symbol via
 *     wordAt(lineText, col) → window.loom.findDefinition({symbol, fromPath})
 *     → MAIN's Law-3-confined resolver returns candidates → App jumps via the
 *     shared revealAt (store.selectFile + targetLine reveal) OR shows the picker.
 *   Alt+ArrowLeft (goBack) pops the jump-history stack and reveals the prior line.
 *
 * GTD-10: this spec is CHEAP INSURANCE — CI-only (it launches Electron, which
 * the WSL sandbox cannot do). Here it must only TYPECHECK (npm run
 * typecheck:e2e) and ENUMERATE (npx playwright test --list); it is NEVER
 * executed in this sandbox. Mirrors the house *.e2e.ts harness (keyboard-
 * shortcuts.e2e.ts / multi-window.e2e.ts).
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/** A fixture project: a definition file + a use file that references it, plus a
 *  file with TWO definitions of the same symbol (to exercise the picker). */
function makeFixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-gtd-'));
  mkdirSync(path.join(dir, 'src'));
  // model.ts DECLARES the class Widget.
  writeFileSync(
    path.join(dir, 'src', 'model.ts'),
    ['export class Widget {', '  name = "";', '}', ''].join('\n'),
  );
  // app.ts USES Widget (F12 here should jump to model.ts).
  writeFileSync(
    path.join(dir, 'src', 'app.ts'),
    ['import { Widget } from "./model";', '', 'const w = new Widget();', 'export { w };', ''].join('\n'),
  );
  // Two declarations of Helper across files -> the picker (>1 candidates).
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function Helper() { return 1; }\n');
  writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const Helper = 2;\n');
  writeFileSync(
    path.join(dir, 'src', 'consumer.ts'),
    ['import { Helper } from "./a";', 'Helper();', ''].join('\n'),
  );
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

/** Open a file from the Explorer tree by its visible basename. */
async function openFile(page: Page, basename: string): Promise<void> {
  await page.getByRole('treeitem', { name: new RegExp(basename) }).first().click();
  await page.waitForSelector('.viewer .code', { timeout: 15_000 });
}

/** The 1-based line number of the currently-revealed (flashed) source row, or
 *  null. Used to assert a jump landed on the expected line. */
async function activeLine(page: Page): Promise<number | null> {
  const handle = await page.$('.viewer .code .ln-wrap.code-line-active[data-line]');
  if (!handle) return null;
  const dataLine = await handle.getAttribute('data-line');
  return dataLine === null ? null : Number.parseInt(dataLine, 10) + 1;
}

test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * F12 on a symbol navigates to its definition across files            *
 * ------------------------------------------------------------------ */
test('F12 on a symbol jumps to its definition (cross-file)', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openFile(page, 'app.ts');
    // Put the caret inside the `Widget` use on the `new Widget()` line.
    const widgetUse = page.locator('.viewer .code .ln-wrap[data-line="2"] .ln');
    await widgetUse.click();
    // Place the caret inside the identifier (double-click selects the word).
    await page.locator('.viewer .code .ln-wrap[data-line="2"] .ln').dblclick();
    await page.keyboard.press('F12');
    // The store now shows model.ts at the class declaration (line 1).
    await page.waitForFunction(
      () => document.querySelector('.viewer .crumb b')?.textContent === 'model.ts',
      { timeout: 15_000 },
    );
    await expect.poll(() => activeLine(page)).toBe(1);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Ctrl/Cmd-click on a symbol navigates to its definition              *
 * ------------------------------------------------------------------ */
test('Ctrl/Cmd-click on a symbol jumps to its definition', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openFile(page, 'app.ts');
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page
      .locator('.viewer .code .ln-wrap[data-line="2"] .ln')
      .click({ modifiers: [modifier] });
    await page.waitForFunction(
      () => document.querySelector('.viewer .crumb b')?.textContent === 'model.ts',
      { timeout: 15_000 },
    );
    await expect.poll(() => activeLine(page)).toBe(1);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * >1 candidates show the picker; Enter jumps; Alt+ArrowLeft goes back  *
 * ------------------------------------------------------------------ */
test('multiple definitions show the picker; Enter jumps; Go Back returns', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openFile(page, 'consumer.ts');
    // Helper has TWO declarations (a.ts function + b.ts const) -> the picker.
    await page.locator('.viewer .code .ln-wrap[data-line="0"] .ln').dblclick();
    await page.keyboard.press('F12');
    const picker = page.locator('.def-picker[role="dialog"]');
    await expect(picker).toBeVisible({ timeout: 15_000 });
    // Enter jumps to the active (first) candidate.
    await page.keyboard.press('Enter');
    await expect(picker).toBeHidden();
    await page.waitForFunction(
      () => {
        const b = document.querySelector('.viewer .crumb b')?.textContent;
        return b === 'a.ts' || b === 'b.ts';
      },
      { timeout: 15_000 },
    );
    // Go Back returns to consumer.ts (the prior reading location).
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForFunction(
      () => document.querySelector('.viewer .crumb b')?.textContent === 'consumer.ts',
      { timeout: 15_000 },
    );
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * A11Y-GTD-01: a pure-keyboard F12 on a top line with MORE THAN ONE *
 * identifier shows the SYMBOL chooser; the user picks which symbol.  *
 * ------------------------------------------------------------------ */
test('A11Y-GTD-01: keyboard F12 on a multi-identifier line opens the symbol chooser', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openFile(page, 'app.ts');
    // Focus the source view with NO caret/selection (the pure-keyboard path) and
    // scroll so a multi-identifier line (`const w = new Widget();`) is the top
    // visible row, then press F12. With more than one identifier on that line the
    // chooser appears so the keyboard user can pick WHICH symbol.
    await page.locator('.viewer .code').focus();
    await page.locator('.viewer .code .ln-wrap[data-line="2"]').scrollIntoViewIfNeeded();
    await page.keyboard.press('F12');
    const chooser = page.locator('.def-picker[role="dialog"] [aria-label^="Symbols on line"]');
    await expect(chooser).toBeVisible({ timeout: 15_000 });
    // Move to the `Widget` option and confirm; it then resolves to model.ts.
    const widgetOpt = page.locator('[role="option"]').filter({ hasText: 'Widget' });
    await widgetOpt.click();
    await expect(page.locator('.def-picker[role="dialog"]')).toBeHidden();
    await page.waitForFunction(
      () => document.querySelector('.viewer .crumb b')?.textContent === 'model.ts',
      { timeout: 15_000 },
    );
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
