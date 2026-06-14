/* ============================================================
 * Loom — TIER 2 e2e: the three newly-EDITABLE shell commands
 * ------------------------------------------------------------
 * This is the ONLY layer that can prove the three actionable app commands
 * promoted to (or added as) rebindable COMMANDS entries actually fire end to
 * end through the REAL App keyboard dispatcher (src/renderer/components/
 * App.tsx) against a REAL Chromium key pipeline — which the pure unit suite
 * (test/acceptance.mjs: COMMANDS / resolveBindings / RESERVED_COMBOS data)
 * cannot reach:
 *
 *   - toggleChanges  (default Ctrl/Cmd+Shift+G) — PROMOTED out of the fixed/
 *     reserved branch to a rebindable command; opens/closes the center-pane
 *     Changes viewer (.pane.viewer.changes), the same action the StatusBar
 *     Changes toggle performs.
 *   - openSettings   (default Ctrl/Cmd+Shift+,) — opens the Settings dialog
 *     the same way the StatusBar gear does.
 *   - toggleMaximizeTerminal (default Ctrl/Cmd+Shift+M) — opens the dock when
 *     closed then maximizes it, and flips maximize<->restore when already
 *     open (the .body.terminal-max class + the maximize button's aria-pressed
 *     mirror the state).
 *
 * It also proves the migration-relevant behavior the unit suite asserts on
 * the pure data: the Changes combo — PREVIOUSLY shell-RESERVED and therefore
 * un-assignable — can now be REBOUND through the Shortcuts panel, and the new
 * combo fires the action while the old default no longer does.
 *
 * It launches the REAL built app (dist/main.cjs) with `_electron`, exactly
 * like changes.e2e.ts / terminal.e2e.ts. The Changes assertions need a REAL
 * git repo (the toggle fetches getChanges over IPC), so the fixture seeds one.
 *
 * CI CAVEAT: this suite runs under xvfb in .github/workflows/e2e.yml, NOT in
 * the WSL sandbox (documented Electron-headless gremlin — see
 * test/e2e/README.md). The in-sandbox validation gate is
 * `npx playwright test --list` (compiles + enumerates, no launch) +
 * `npm run typecheck:e2e`.
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* ---- Build prerequisite ------------------------------------------------- */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/** Per-invocation `-c` isolation flags so a hostile global git config (hooks,
 *  required signing) can't perturb the fixture — matches changes.e2e.ts. */
const ISOLATION = [
  '-c',
  'core.hooksPath=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
];

/** Run git in `cwd` with a fixed argv (NO shell), isolated from host config. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', [...ISOLATION, ...args], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

/** Seed a real temp git repo on `main` with a base commit, then a `feature`
 *  branch carrying one MODIFIED file — enough for the Changes toggle to find a
 *  non-empty listing (the .pane.viewer.changes pane renders regardless). */
function makeGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-kbsc-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'loom-test@example.com']);
  git(dir, ['config', 'user.name', 'Loom Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'edit.txt'), 'alpha\nbeta\ngamma\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);

  git(dir, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(path.join(dir, 'edit.txt'), 'alpha\nBETA\ngamma\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'feature work']);
  return dir;
}

/* ---- Per-launch localStorage isolation -----------------------------------
 * The keybindings override map persists in the renderer config (localStorage).
 * playwright.config runs workers:1 with NO per-test isolation, so the REBIND
 * test must launch with its OWN fresh temp userData dir or a sibling's persisted
 * override could poison it (the --user-data-dir Chromium switch Electron
 * honors — mirrors md-width.e2e.ts makeUserDataDir). */
function makeUserDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'loom-e2e-kbsc-ud-'));
}

/** Launch the built app rooted at `dir` and wait for the renderer to boot (an
 *  Explorer file row proves the tree is live). `userDataDir`, when given, is
 *  passed as the Chromium --user-data-dir switch so the launch gets an isolated
 *  localStorage partition (a fresh dir ⇒ guaranteed-default keybindings).
 *  SHELL is pinned to bash for deterministic terminal behavior (terminal.e2e). */
async function launch(
  dir: string,
  userDataDir?: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  // ALWAYS isolate userData. A caller may pin a SPECIFIC dir (to assert a
  // persisted override survives a relaunch); when none is given we still mint a
  // FRESH dir rather than sharing the machine-global one — terminalCount
  // (loom-config.json) and TERMINAL_OPEN_KEY / TERMINAL_COLUMNS_RATIOS_KEY
  // (localStorage) otherwise leak from a sibling test that opened N terminals or
  // left the dock open, booting this test at the wrong column count (the
  // multi-terminal persistence made this order-dependent flake visible).
  const ud = userDataDir ?? mkdtempSync(path.join(tmpdir(), 'loom-e2e-kbsc-ud-'));
  const app = await electron.launch({
    args: [`--user-data-dir=${ud}`, MAIN_ENTRY],
    env: { ...process.env, LOOM_ROOT: dir, SHELL: 'bash' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
  return { app, page };
}

/** Move focus off any editable target onto the Explorer tree, so the App
 *  dispatcher (which suppresses every command except toggleTerminal inside
 *  editable targets) actually handles the combos under test. */
async function focusTree(page: Page): Promise<void> {
  await page.locator('.pane.explorer [role="treeitem"]').first().click();
}

/* ---- Multi-terminal focus selectors/helpers ------------------------------ *
 * The dock mounts up to 3 .pane.terminal columns, each with a 0-based
 * `data-terminal-index`. The per-terminal focus commands move REAL DOM focus
 * into one pane's xterm (its .xterm-helper-textarea), so we read "which terminal
 * is active" from document.activeElement's owning pane index — NOT a CSS class
 * (there is none). Scope every per-pane selector to ONE index so a >1-pane
 * layout never trips Playwright strict mode (risk R9). */
const TOGGLE_TERMINAL = 'button[aria-label="Terminal"]';
const ADD_TERMINAL = 'button[aria-label="Add terminal"]';
const termPane = (i: number): string => `.pane.terminal[data-terminal-index="${i}"]`;
const termXterm = (i: number): string => `${termPane(i)} .xterm`;

/** Open the dock and ADD columns until `count` (1..3) terminal panes are live,
 *  waiting for each new pane's xterm to mount before adding the next. */
async function openNTerminals(page: Page, count: number): Promise<void> {
  await page.locator(TOGGLE_TERMINAL).click();
  await page.waitForSelector(termXterm(0), { timeout: 15_000 });
  for (let i = 1; i < count; i++) {
    await page.locator(ADD_TERMINAL).click();
    await page.waitForSelector(termXterm(i), { timeout: 15_000 });
  }
  await expect(page.locator('.pane.terminal')).toHaveCount(count);
}

/** The 0-based index of the terminal pane that currently OWNS DOM focus (its
 *  xterm holds activeElement), or null when focus is outside every terminal.
 *  This is the "active ring" signal for the per-index focus commands. */
async function activeTerminalIndex(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const owner = document.activeElement?.closest('.pane.terminal');
    if (owner === null || owner === undefined) return null;
    const raw = owner.getAttribute('data-terminal-index');
    return raw === null ? null : Number(raw);
  });
}

test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * 1. toggleChanges: the default Ctrl/Cmd+Shift+G opens + closes it     *
 * ------------------------------------------------------------------ */
// The combo was PROMOTED from a fixed/reserved interception to a rebindable
// command; it must still toggle the Changes viewer EXACTLY ONCE per press (open
// then close — no double-fire) from a non-editable target.
test('1: Ctrl+Shift+G toggles the Changes viewer (open then close, exactly once each)', async () => {
  const dir = makeGitRepo();
  const { app, page } = await launch(dir);
  try {
    await focusTree(page);
    const changes = page.locator('.pane.viewer.changes');
    await expect(changes).toHaveCount(0);

    // The StatusBar Changes TOGGLE (the one carrying aria-pressed). Its
    // accessible name is exactly "Changes" (StatusBar.tsx aria-label="Changes"),
    // but `getByRole('button', { name: 'Changes' })` matches by SUBSTRING +
    // case-insensitively, so once the viewer opens it ALSO matches the
    // ChangesView header close button (aria-label="Close changes" — contains
    // "changes"), tripping strict mode (2 elements). Scope to the .statusbar
    // and pin exact:true so ONLY the toggle resolves. (Mirrors the exact:true
    // disambiguation window-controls.e2e.ts uses for Maximize/Restore.)
    const changesToggle = page
      .locator('.statusbar')
      .getByRole('button', { name: 'Changes', exact: true });

    // First press OPENS the center-pane Changes viewer.
    await page.keyboard.press('Control+Shift+G');
    await expect(changes).toHaveCount(1);
    await expect(changesToggle).toHaveAttribute('aria-pressed', 'true');

    // Second press CLOSES it — proving a single, non-double-firing toggle.
    await page.keyboard.press('Control+Shift+G');
    await expect(changes).toHaveCount(0);
    await expect(changesToggle).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 1b. Escape still closes the Changes viewer (convenience preserved)  *
 * ------------------------------------------------------------------ */
// Promoting Ctrl/Cmd+Shift+G must NOT disturb the Escape-closes-Changes
// convenience (App.tsx fires it only while diffMode is true).
test('1b: Escape closes the Changes viewer when it is open', async () => {
  const dir = makeGitRepo();
  const { app, page } = await launch(dir);
  try {
    await focusTree(page);
    await page.keyboard.press('Control+Shift+G');
    const changes = page.locator('.pane.viewer.changes');
    await expect(changes).toHaveCount(1);

    // Escape (from a non-editable target) closes it back to the Viewer.
    await page.keyboard.press('Escape');
    await expect(changes).toHaveCount(0);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 2. openSettings: the default Ctrl/Cmd+Shift+, opens Settings         *
 * ------------------------------------------------------------------ */
test('2: Ctrl+Shift+, opens the Settings dialog', async () => {
  const dir = makeGitRepo();
  const { app, page } = await launch(dir);
  try {
    await focusTree(page);
    await expect(page.locator('.settings-dialog')).toHaveCount(0);

    // The comma key with Ctrl+Shift canonicalizes to 'Ctrl+Shift+,' — the
    // openSettings default — and opens the same dialog the gear does.
    await page.keyboard.press('Control+Shift+Comma');
    await expect(page.locator('.settings-dialog')).toHaveCount(1);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 3. toggleMaximizeTerminal: Ctrl/Cmd+Shift+M opens+maximizes, toggles *
 * ------------------------------------------------------------------ */
// With the dock CLOSED the command opens it AND maximizes (a sensible
// non-crashing open-then-maximize); pressed again it restores; a third press
// maximizes again. The .body.terminal-max class + the maximize button's
// aria-pressed mirror the state.
test('3: Ctrl+Shift+M opens+maximizes the terminal, then toggles maximize/restore', async () => {
  const dir = makeGitRepo();
  const { app, page } = await launch(dir);
  try {
    await focusTree(page);
    const body = page.locator('.body');
    const pane = page.locator('.pane.terminal');
    await expect(pane).toHaveCount(0);

    // The terminal CLOSE button (aria-label="Close terminal") is in the pane
    // header and stays VISIBLE in BOTH the restored and the maximized states —
    // unlike the Explorer, which `.body.terminal-max` sets visibility:hidden
    // (renderer.css). So between presses we re-seat focus by FOCUSING it (never
    // CLICKING — that would close the dock) to move off xterm's hidden <textarea>
    // (an editable target where toggleMaximizeTerminal is suppressed by design;
    // only toggleTerminal punches out of xterm). Focusing a visible, non-editable
    // header button is the robust, max-state-safe analogue of focusTree here.
    const closeBtn = pane.locator('button[aria-label="Close terminal"]');
    // The pane-header maximize/restore button. Scoped to .pane.terminal AND a
    // full aria-label attribute selector, so it never substring-collides with the
    // titlebar window "Maximize"/"Restore" controls (window-controls.e2e.ts).
    const maxBtn = pane.locator('button[aria-label="Maximize terminal"]');
    const restoreBtn = pane.locator('button[aria-label="Restore terminal size"]');

    // Closed dock: ONE press must OPEN the dock AND maximize it.
    await page.keyboard.press('Control+Shift+M');
    await expect(pane).toHaveCount(1);
    // Wait for xterm to actually MOUNT (the .xterm element only appears after
    // Terminal.open() ran) before asserting on header/body state — the proven
    // cold-start gate from terminal.e2e.ts (the PTY spawn is async).
    await page.waitForSelector('.pane.terminal .xterm', { timeout: 15_000 });
    await expect(body).toHaveClass(/terminal-max/);
    // Maximized ⇒ the header button is the RESTORE affordance, pressed=true.
    await expect(restoreBtn).toHaveAttribute('aria-pressed', 'true');

    // Re-seat focus off xterm onto the visible Close button, then RESTORE.
    await closeBtn.focus();
    await page.keyboard.press('Control+Shift+M');
    await expect(body).not.toHaveClass(/terminal-max/);
    await expect(pane).toHaveCount(1);
    // Restored ⇒ the header button is the MAXIMIZE affordance, pressed=false.
    await expect(maxBtn).toHaveAttribute('aria-pressed', 'false');

    // A third press maximizes again (now from the OPEN-but-restored state). The
    // Explorer is visible again here, but keep using the always-visible Close
    // button so the focus-reseat path is identical regardless of max state.
    await closeBtn.focus();
    await page.keyboard.press('Control+Shift+M');
    await expect(body).toHaveClass(/terminal-max/);
    await expect(restoreBtn).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 4. REBIND: the PROMOTED Changes combo can now be rebound (was       *
 *    previously reserved + un-assignable) and the new combo fires      *
 * ------------------------------------------------------------------ */
// The migration-relevant proof: open the Shortcuts panel (the fixed
// Ctrl/Cmd+Comma opener), capture a NEW combo for the now-editable "Toggle
// changes view" command (Ctrl+Shift+D — previously impossible when the combo
// was reserved), persist it, then prove the NEW combo fires the action and the
// OLD default no longer does.
test('4: the promoted Toggle changes view command can be rebound and the new combo fires', async () => {
  const dir = makeGitRepo();
  const ud = makeUserDataDir();
  const { app, page } = await launch(dir, ud);
  try {
    await focusTree(page);

    // Open the Shortcuts panel via its fixed opener.
    await page.keyboard.press('Control+Comma');
    const dialog = page.locator('.sc-dialog');
    await expect(dialog).toBeVisible();

    // Arm capture on the "Toggle changes view" row, then press the new combo.
    // The binding button's accessible name is the row label (aria-labelledby).
    await dialog.getByRole('button', { name: 'Toggle changes view' }).click();
    await page.keyboard.press('Control+Shift+D');
    // The row now shows the rebound combo (Ctrl/Cmd display form) and no
    // conflict/reserved warning was raised (the combo is free + un-reserved).
    await expect(dialog.locator('.sc-conflict')).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Toggle changes view' }),
    ).toContainText('Ctrl/Cmd+Shift+D');

    // Close the panel (Done) and return to a non-editable target.
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.sc-dialog')).toHaveCount(0);
    await focusTree(page);

    // The NEW combo now toggles the Changes viewer.
    const changes = page.locator('.pane.viewer.changes');
    await page.keyboard.press('Control+Shift+D');
    await expect(changes).toHaveCount(1);
    await page.keyboard.press('Control+Shift+D');
    await expect(changes).toHaveCount(0);

    // The OLD default (Ctrl/Cmd+Shift+G) no longer fires the action — it was
    // rebound away, and nothing else claims it.
    await page.keyboard.press('Control+Shift+G');
    await expect(changes).toHaveCount(0);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * TERMINAL FOCUS COMMANDS: per-index focus, cycle, and a focus rebind  *
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * 5. the default focus combo moves the active terminal to the right    *
 * ------------------------------------------------------------------ */
// With two terminals open, the active one starts at the LEFT column (slot 0).
// The focusTerminal2 default (Ctrl/Cmd+2) moves real DOM focus into the RIGHT
// column (slot 1) — its xterm becomes activeElement. These editable-target
// commands fire even FROM inside a terminal (EDITABLE_TARGET_COMMANDS), so the
// press works whether focus sits on the tree or in the left terminal.
test('5: the focusTerminal2 default (Ctrl+2) moves the active terminal to the right pane', async () => {
  const dir = makeGitRepo();
  const { app, page } = await launch(dir);
  try {
    await openNTerminals(page, 2);

    // Seed the active terminal to the LEFT pane (slot 0) deterministically: its
    // own focus command lands focus there regardless of where it started.
    await page.keyboard.press('Control+1');
    await expect.poll(() => activeTerminalIndex(page)).toBe(0);

    // The DEFAULT focus combo for terminal 2 moves the active terminal RIGHT.
    await page.keyboard.press('Control+2');
    await expect.poll(() => activeTerminalIndex(page)).toBe(1);
    // And the right pane's xterm actually holds focus (activeElement is inside
    // slot 1) — a precise re-statement of the "active ring on the right" signal.
    await expect(page.locator(`${termPane(1)} .xterm-helper-textarea`)).toBeFocused();
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 6. cycleTerminalFocus advances the active terminal (wrapping)        *
 * ------------------------------------------------------------------ */
// The cycle command (default Ctrl/Cmd+Alt+`) advances the active terminal by one
// slot, wrapping within the live count. With three terminals: 0 → 1 → 2 → 0.
test('6: cycleTerminalFocus (Ctrl+Alt+`) advances focus and wraps within the count', async () => {
  const dir = makeGitRepo();
  const { app, page } = await launch(dir);
  try {
    await openNTerminals(page, 3);

    // Anchor at slot 0, then cycle three times back to 0 (full wrap).
    await page.keyboard.press('Control+1');
    await expect.poll(() => activeTerminalIndex(page)).toBe(0);

    await page.keyboard.press('Control+Alt+`');
    await expect.poll(() => activeTerminalIndex(page)).toBe(1);

    await page.keyboard.press('Control+Alt+`');
    await expect.poll(() => activeTerminalIndex(page)).toBe(2);

    // Wrap: from the last slot the next cycle returns to the first.
    await page.keyboard.press('Control+Alt+`');
    await expect.poll(() => activeTerminalIndex(page)).toBe(0);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 7. REBIND a focus command through the Shortcuts panel, then it fires  *
 * ------------------------------------------------------------------ */
// The full rebind flow for a per-terminal focus command: open the Shortcuts
// panel, capture a NEW combo for "Focus terminal 2" (Ctrl+Shift+Y — free and
// modifier-bearing, as EDITABLE_TARGET_COMMANDS requires), persist it, then
// prove the NEW combo moves the active terminal to slot 1 while the OLD default
// (Ctrl+2) no longer does. Uses an isolated userData dir so the persisted
// override never leaks into a sibling launch (workers:1, no per-test isolation).
test('7: the Focus terminal 2 command can be rebound and the new combo focuses the right pane', async () => {
  const dir = makeGitRepo();
  const ud = makeUserDataDir();
  const { app, page } = await launch(dir, ud);
  try {
    await openNTerminals(page, 2);

    // Move focus off the xterm textarea first: the Shortcuts opener (Ctrl+,) is a
    // normal command, suppressed inside an editable target (only the terminal
    // focus/toggle commands carry the editable-target exception). Open it from a
    // non-editable target, the suite's focusTree idiom.
    await focusTree(page);
    // Open the Shortcuts panel via its fixed opener.
    await page.keyboard.press('Control+Comma');
    const dialog = page.locator('.sc-dialog');
    await expect(dialog).toBeVisible();

    // Arm capture on the "Focus terminal 2" row, then press the new combo. The
    // binding button's accessible name is the row label (aria-labelledby).
    await dialog.getByRole('button', { name: 'Focus terminal 2' }).click();
    await page.keyboard.press('Control+Shift+Y');
    // No conflict/reserved warning — the combo is free, valid, and modifier-
    // bearing (the editable-target constraint is satisfied).
    await expect(dialog.locator('.sc-conflict')).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Focus terminal 2' }),
    ).toContainText('Ctrl/Cmd+Shift+Y');

    // Close the panel (Done). It returns focus to its opener (the Settings gear)
    // AFTER a re-render — and the persisted rebind DEFERS that focus-return by a
    // tick (config write → re-render). WAIT for it to settle (gear focused)
    // before seeding focus: otherwise the deferred return steals focus back from
    // the terminal right after Control+1 (a real but narrow race — a user
    // pressing a focus shortcut a beat later, or twice, never hits it).
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.sc-dialog')).toHaveCount(0);
    await expect(page.locator('button[aria-label="Settings"]')).toBeFocused();

    // Seed the active terminal to the LEFT pane so a successful move is visible.
    await page.keyboard.press('Control+1');
    await expect.poll(() => activeTerminalIndex(page)).toBe(0);

    // The NEW combo now focuses the RIGHT terminal (slot 1).
    await page.keyboard.press('Control+Shift+Y');
    await expect.poll(() => activeTerminalIndex(page)).toBe(1);

    // Re-seat to the left, then prove the OLD default (Ctrl+2) no longer fires
    // the focus action — it was rebound away and nothing else claims it.
    await page.keyboard.press('Control+1');
    await expect.poll(() => activeTerminalIndex(page)).toBe(0);
    await page.keyboard.press('Control+2');
    // Give any (incorrect) handler a beat, then assert focus stayed on the left.
    await expect.poll(() => activeTerminalIndex(page)).toBe(0);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
