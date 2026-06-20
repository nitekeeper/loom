/* ============================================================
 * Loom — TIER 2 e2e: mouse clicks as bindable shortcuts (CI-only)
 * ------------------------------------------------------------
 * End-to-end coverage for the FR-54 mouse-binding feature — a click with
 * modifier(s) is a first-class shortcut, recorded in the Shortcuts panel and
 * dispatched by the App's document-level mouse dispatcher (or, for the
 * positional go-to-definition, by the Viewer's binding-aware onCodeClick):
 *
 *   a. Ctrl/Cmd-click jumps to a definition — the NEW DEFAULT goToDefinition
 *      binding ('Ctrl+Click'), promoted out of the old hardcoded Viewer check.
 *   b. Rebinding goToDefinition to a KEY (F8) DISABLES the click jump, while
 *      both the rebound F8 AND the FIXED, always-on F12 keyboard affordance keep
 *      jumping — the WCAG 2.1.1 guarantee that a keyboard-only user never loses
 *      go-to-definition no matter how the slot is rebound.
 *   c. Binding a GLOBAL command (toggleExplorer) to a mouse combo fires it from
 *      the document mouse dispatcher when the combo is clicked on a neutral area.
 *   d. A RIGHT-CLICK binding fires EXACTLY ONCE (single-source rule: a right
 *      release fires BOTH auxclick AND contextmenu natively; the dispatcher
 *      dispatches via contextmenu only) and its match suppresses the native menu,
 *      while an unmodified right-click elsewhere is untouched.
 *
 * Flow under test:
 *   Shortcuts panel (Ctrl+,) mouse capture: a modifier-held click/middle/right
 *     while a row is ARMED -> mouseEventToCombo -> assignCombo (the SAME validate/
 *     conflict/commit flow as the keyboard path) -> persisted override.
 *   App document mouse dispatcher: click/auxclick(middle)/contextmenu(right) ->
 *     mouseEventToCombo -> resolveBindings match -> runCommand (positional /
 *     closeFile skipped; preventDefault only on a real match).
 *   Viewer onCodeClick: fires go-to-definition ONLY when the click's combo
 *     equals the resolved goToDefinition binding (the binding-aware click path).
 *
 * MB-E2E: this spec is CHEAP INSURANCE — CI-only (it launches Electron, which
 * the WSL sandbox cannot do). In the sandbox it must only TYPECHECK
 * (npm run typecheck:e2e) and ENUMERATE (npx playwright test --list); it is
 * NEVER executed here. Mirrors the house *.e2e.ts harness (go-to-definition.
 * e2e.ts fixture + activeLine, keyboard-shortcuts.e2e.ts rebind flow +
 * makeUserDataDir isolation).
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/** The platform primary modifier — Cmd on macOS, Ctrl elsewhere. Both
 *  canonicalize to the 'Ctrl' token (Cmd == Ctrl), so 'Ctrl+Click' matches a
 *  Meta-click on macOS and a Control-click everywhere else. */
const PRIMARY = process.platform === 'darwin' ? 'Meta' : 'Control';

/** A fixture project: a definition file + a use file that references it. (No
 *  multi-candidate file is needed here — the picker is covered by
 *  go-to-definition.e2e.ts; this spec only needs a single clean jump.) */
function makeFixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-mouse-'));
  mkdirSync(path.join(dir, 'src'));
  // model.ts DECLARES the class Widget (the jump TARGET, line 1).
  writeFileSync(
    path.join(dir, 'src', 'model.ts'),
    ['export class Widget {', '  name = "";', '}', ''].join('\n'),
  );
  // app.ts USES Widget on line 3 (data-line="2") — the click/key SOURCE.
  writeFileSync(
    path.join(dir, 'src', 'app.ts'),
    ['import { Widget } from "./model";', '', 'const w = new Widget();', 'export { w };', ''].join('\n'),
  );
  return dir;
}

/** A fresh, isolated userData dir so a persisted keybindings override (the panel
 *  writes one) never leaks into a sibling launch (playwright.config runs
 *  workers:1 with no per-test isolation — see keyboard-shortcuts.e2e.ts). */
function makeUserDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'loom-e2e-mouse-ud-'));
}

/** Launch the built app rooted at `dir`, isolated to its OWN userData partition
 *  (a fresh dir ⇒ guaranteed-default keybindings), and wait for the renderer to
 *  boot (an Explorer file row proves the tree is live). */
async function launch(
  dir: string,
  userDataDir?: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const ud = userDataDir ?? makeUserDataDir();
  const app = await electron.launch({
    args: [`--user-data-dir=${ud}`, MAIN_ENTRY],
    env: { ...process.env, LOOM_ROOT: dir, SHELL: 'bash' },
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

/** The crumb basename currently shown in the Viewer header, or null. The jump
 *  signal: it flips to the definition file's name once a jump lands. */
async function crumbName(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('.viewer .crumb b')?.textContent ?? null,
  );
}

/** Move focus off any editable target onto the Explorer tree, so the App
 *  dispatcher (which suppresses commands inside editable targets) handles the
 *  combos under test — the keyboard-shortcuts.e2e.ts idiom. */
async function focusTree(page: Page): Promise<void> {
  await page.locator('.pane.explorer [role="treeitem"]').first().click();
}

/** Arm a Shortcuts-panel row by its label, returning the live dialog locator.
 *  The panel must already be open (Ctrl+,). */
async function armRow(page: Page, label: string): Promise<void> {
  const dialog = page.locator('.sc-dialog');
  await dialog.getByRole('button', { name: label }).click();
}

test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * a. Ctrl/Cmd-click jumps to a definition (the NEW DEFAULT binding)    *
 * ------------------------------------------------------------------ */
// 'Ctrl+Click' is now the goToDefinition DEFAULT (promoted out of the old
// hardcoded `e.metaKey||e.ctrlKey` Viewer check). The Viewer onCodeClick fires
// the jump because mouseEventToCombo(e) === 'Ctrl+Click' === gotoBinding.
test('a: Ctrl/Cmd-click on a symbol jumps to its definition (the default binding)', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openFile(page, 'app.ts');
    // Modifier-click the `Widget` use on `const w = new Widget();` (data-line=2).
    await page
      .locator('.viewer .code .ln-wrap[data-line="2"] .ln')
      .click({ modifiers: [PRIMARY] });
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
 * b. Rebinding goToDefinition to a KEY disables the click jump, but    *
 *    BOTH the rebound key AND the FIXED F12 keep jumping (a11y).        *
 * ------------------------------------------------------------------ */
// Rebind goToDefinition to F8 (NOT F12 — F12 is the always-on fixed affordance,
// so binding the slot to it would not prove the guarantee). After the rebind:
//   - a Ctrl/Cmd-click NO LONGER jumps (the click combo 'Ctrl+Click' no longer
//     equals the resolved binding 'F8'),
//   - F8 jumps (the rebound slot fires through the keydown dispatcher),
//   - F12 STILL jumps (the fixed keyboard affordance survives any rebind) —
//     the WCAG 2.1.1 keyboard guarantee.
test('b: rebinding goToDefinition to F8 disables the click jump while F8 and the fixed F12 still jump', async () => {
  const dir = makeFixtureDir();
  const ud = makeUserDataDir();
  const { app, page } = await launch(dir, ud);
  try {
    await openFile(page, 'app.ts');
    await focusTree(page);

    // Open the Shortcuts panel (fixed opener), arm "Go to definition", press F8.
    await page.keyboard.press('Control+Comma');
    const dialog = page.locator('.sc-dialog');
    await expect(dialog).toBeVisible();
    await armRow(page, 'Go to definition');
    await page.keyboard.press('F8');
    // No conflict/reserved warning — F8 is free, valid, and un-reserved. The row
    // now shows the rebound key.
    await expect(dialog.locator('.sc-conflict')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Go to definition' })).toContainText('F8');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.sc-dialog')).toHaveCount(0);

    // 1) A Ctrl/Cmd-click no longer jumps — we are still on app.ts after it.
    await page
      .locator('.viewer .code .ln-wrap[data-line="2"] .ln')
      .click({ modifiers: [PRIMARY] });
    // NEGATIVE assertion robustness: the crumb is ALREADY 'app.ts' here, so a
    // bare expect.poll would pass on its FIRST evaluation with NO settle window —
    // an erroneous async jump (an IPC round-trip to main's definition resolver)
    // could land AFTER the assertion. Wait a fixed settle LONGER than a jump's
    // round-trip would take, then assert the crumb never flipped to the
    // definition file. The crumb is THE jump signal (it flips to 'model.ts' once
    // a cross-file jump lands), so if a regression re-enabled the click jump it
    // would have flipped within this window and the assertion below fails.
    await page.waitForTimeout(1000);
    expect(await crumbName(page)).toBe('app.ts');
    expect(await crumbName(page)).not.toBe('model.ts');

    // 2) F8 (the rebound slot) jumps. Put the caret on the `Widget` use first.
    await page.locator('.viewer .code .ln-wrap[data-line="2"] .ln').dblclick();
    await page.keyboard.press('F8');
    await page.waitForFunction(
      () => document.querySelector('.viewer .crumb b')?.textContent === 'model.ts',
      { timeout: 15_000 },
    );

    // Go Back to app.ts so the fixed-F12 assertion starts from the same source.
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForFunction(
      () => document.querySelector('.viewer .crumb b')?.textContent === 'app.ts',
      { timeout: 15_000 },
    );

    // 3) The FIXED F12 STILL jumps — proving the a11y keyboard guarantee survives
    //    rebinding the slot away from any mouse/key combo.
    await page.locator('.viewer .code .ln-wrap[data-line="2"] .ln').dblclick();
    await page.keyboard.press('F12');
    await page.waitForFunction(
      () => document.querySelector('.viewer .crumb b')?.textContent === 'model.ts',
      { timeout: 15_000 },
    );
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * c. Binding a GLOBAL command to a mouse combo fires it                 *
 * ------------------------------------------------------------------ */
// Arm "Toggle file explorer" in the panel, record 'Ctrl+Shift+Click' by holding
// the primary + Shift modifiers and clicking the row, persist, then trigger the
// same combo on a NEUTRAL area (the status bar — no .code, no editable target, no
// rendered-markdown anchor) and assert the explorer pane toggled (the
// .body.explorer-hidden class flips), proving the document mouse dispatcher fired
// the global command. We use Ctrl+Shift+Click (not Ctrl+Click) so the bind never
// collides with goToDefinition's default 'Ctrl+Click' (which would raise the
// conflict prompt instead of a clean record).
test('c: binding Toggle file explorer to Ctrl+Shift+Click fires it on a neutral click', async () => {
  const dir = makeFixtureDir();
  const ud = makeUserDataDir();
  const { app, page } = await launch(dir, ud);
  try {
    await focusTree(page);

    // Open the panel, arm the row, then RECORD the mouse combo by clicking the
    // armed row button with the primary + Shift modifiers held (capture-phase
    // records it; the modifiers make it a valid, free mouse shortcut).
    await page.keyboard.press('Control+Comma');
    const dialog = page.locator('.sc-dialog');
    await expect(dialog).toBeVisible();
    const row = dialog.getByRole('button', { name: 'Toggle file explorer' });
    await row.click(); // arm
    // The armed row records 'Ctrl+Shift+Click' on the modifier-held click.
    await row.click({ modifiers: [PRIMARY, 'Shift'] });
    await expect(dialog.locator('.sc-conflict')).toHaveCount(0);
    await expect(row).toContainText('Ctrl/Cmd+Shift+Click');

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.sc-dialog')).toHaveCount(0);

    // The explorer starts visible (no .explorer-hidden on .body).
    const body = page.locator('.body');
    await expect(body).not.toHaveClass(/explorer-hidden/);

    // Ctrl/Cmd+Shift-click a NEUTRAL area (the status bar) -> the bound command
    // fires and collapses the explorer (the dispatcher preventDefaults only on a
    // match).
    await page.locator('.statusbar').click({ modifiers: [PRIMARY, 'Shift'] });
    await expect(body).toHaveClass(/explorer-hidden/);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * d. A RIGHT-CLICK binding fires EXACTLY ONCE (single-source) and       *
 *    suppresses the native context menu on a match                      *
 * ------------------------------------------------------------------ */
// Bind "Toggle file explorer" to 'Alt+RightClick' via the panel (a right-click
// with Alt while armed -> onContextMenuCapture records it). Then trigger that
// combo on a NEUTRAL area: a right-button release fires BOTH auxclick AND
// contextmenu natively, so a naive dispatcher would fire the toggle TWICE
// (collapsing then re-showing the explorer — a visible no-op). The single-source
// rule dispatches it ONCE (via contextmenu), so the explorer ends up COLLAPSED —
// the direct proof of exactly-one fire. An UNMODIFIED right-click elsewhere does
// NOT fire the command (no modifier) — the native gesture is untouched.
test('d: a right-click binding fires exactly once (single-source) and an unmodified right-click is untouched', async () => {
  const dir = makeFixtureDir();
  const ud = makeUserDataDir();
  const { app, page } = await launch(dir, ud);
  try {
    await focusTree(page);

    // Open the panel, arm the row, then RECORD 'Alt+RightClick' by Alt+right-
    // clicking the armed row (onContextMenuCapture owns the right button + always
    // preventDefaults the native menu while capturing).
    await page.keyboard.press('Control+Comma');
    const dialog = page.locator('.sc-dialog');
    await expect(dialog).toBeVisible();
    const row = dialog.getByRole('button', { name: 'Toggle file explorer' });
    await row.click(); // arm
    await row.click({ button: 'right', modifiers: ['Alt'] });
    await expect(dialog.locator('.sc-conflict')).toHaveCount(0);
    await expect(row).toContainText('Alt+RightClick');

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.sc-dialog')).toHaveCount(0);

    const body = page.locator('.body');
    await expect(body).not.toHaveClass(/explorer-hidden/);

    // Alt+right-click a NEUTRAL area. EXACTLY ONE fire -> explorer collapses (a
    // double-fire would toggle it back to visible). Playwright cannot read the
    // native OS menu, so context-menu suppression is asserted INDIRECTLY: the
    // command fired (preventDefault ran on the match) and an unmodified right-
    // click below still works as a native gesture.
    await page.locator('.statusbar').click({ button: 'right', modifiers: ['Alt'] });
    await expect(body).toHaveClass(/explorer-hidden/);
    // Re-show it with a second Alt+right-click — proves the single fire is
    // reproducible (toggle on -> off -> on), not a one-off.
    await page.locator('.statusbar').click({ button: 'right', modifiers: ['Alt'] });
    await expect(body).not.toHaveClass(/explorer-hidden/);

    // An UNMODIFIED right-click does NOT fire the command (no modifier -> the
    // dispatcher's modifier fast-path bails), so the explorer state is unchanged.
    // NEGATIVE assertion robustness: the body is ALREADY visible here (from the
    // re-show above), so a bare .not.toHaveClass would be satisfied IMMEDIATELY
    // with no settle — an erroneous fire (which would re-collapse the explorer)
    // would not be reliably caught. Wait a fixed settle longer than the dispatch
    // path takes, THEN assert the explorer is still visible: if the unmodified
    // right-click had wrongly fired the toggle, .explorer-hidden would have
    // appeared within this window and the assertion fails.
    await page.locator('.statusbar').click({ button: 'right' });
    await page.waitForTimeout(1000);
    await expect(body).not.toHaveClass(/explorer-hidden/);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
