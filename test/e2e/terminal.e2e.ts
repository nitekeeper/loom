/* ============================================================
 * Loom — TIER 2 e2e: terminal pane across the REAL Electron stack
 * ------------------------------------------------------------
 * This is the ONLY layer that can exercise the terminal feature's
 * cross-process chain end to end, which the pure unit suite
 * (test/terminal.mjs — manager validators over a FAKE pty factory)
 * cannot reach:
 *
 *   - the real node-pty spawn in main (src/main/pty-factory.ts),
 *     cwd-pinned to the launch root,
 *   - the loom:terminal:* IPC round-trip (preload allow-list →
 *     ipc.ts handlers → session manager → TERMINAL_DATA pushes),
 *   - the xterm.js renderer binding (TerminalPane.tsx: keystrokes →
 *     terminal.input, pushes → term.write, close → terminal.close),
 *   - the REAL PTY process lifecycle (close kills it; reopen spawns
 *     a fresh working shell).
 *
 * It launches the REAL built app (dist/main.cjs) with `_electron`,
 * exactly like navlinks.e2e.ts.
 *
 * WHY each test would FAIL FOR THE RIGHT REASON:
 *   1. If the PTY stopped spawning with cwd = the launch root (or the
 *      open/input/data chain broke anywhere), the rendered terminal
 *      would never contain `PWD:<realpath(root)>` (AC 1 + AC 7).
 *   2. If closing the pane stopped killing the PTY (close handler,
 *      session manager kill, or unmount-cleanup regression), the
 *      shell pid would stay signalable from the main process and the
 *      poll below would never see it die (AC 2).
 *   3. If reopen reused a dead/stale session instead of spawning a
 *      fresh shell, the round-2 echo output would never render (AC 3).
 *
 * ECHO-MARKER HYGIENE: every probe is written so the EXPECTED OUTPUT
 * string never appears in the TYPED command line that xterm also
 * renders (`$(pwd)` / `$$` expand only in the shell; the round-2
 * marker is quote-split). A test can therefore never pass off the
 * local echo of its own keystrokes.
 *
 * CI CAVEAT: this suite runs under xvfb in .github/workflows/e2e.yml,
 * NOT in the WSL sandbox (documented Electron-headless gremlin — see
 * test/e2e/README.md). The in-sandbox validation gate is
 * `npx playwright test --list` (compiles + enumerates, no launch).
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* ---- Build prerequisite ------------------------------------------------- */
// The e2e suite launches the BUILT bundle, never the TS sources. Resolve
// dist/main.cjs relative to this file (test/e2e -> project root -> dist) and
// assert it exists with a clear, actionable message so a missing build fails
// loudly here, not as an opaque electron spawn error. (CJS spec under
// Playwright's loader — __dirname, not import.meta.url; see navlinks.e2e.ts.)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/* ---- Selectors ----------------------------------------------------------- */
// The status-bar dock toggle is a <button> labelled for the terminal; accept
// both the stable-name form ("Terminal") and the verb form ("Toggle terminal")
// so a label-polish commit in the renderer cannot silently orphan this suite.
// (The pane itself is a <section aria-label="Terminal">, never a button, so
// the button-scoped selector stays unambiguous.)
const TOGGLE_BUTTON =
  'button[aria-label="Terminal"], button[aria-label="Toggle terminal"]';
const PANE = '.pane.terminal';
const XTERM = `${PANE} .xterm`;
const CLOSE_BUTTON = `${PANE} button[aria-label="Close terminal"]`;

/** Make a fresh temp sandbox dir (the launch root). One marker file so the
 *  Explorer tree has a row to prove the renderer booted. */
function makeFixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-'));
  writeFileSync(path.join(dir, 'readme.md'), '# terminal e2e fixture\n');
  return dir;
}

/** Launch the built app rooted at `dir` and wait for the renderer to boot
 *  (an Explorer file row proves the tree is live) — navlinks.e2e.ts idiom. */
async function launch(dir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    // LOOM_ROOT is the sandbox root the launcher normally sets (bin/loom.cjs);
    // resolveRoot() honors it byte-for-byte — the PTY must spawn with this
    // directory as its cwd (AC 1).
    // SHELL is pinned to bash because the app honors $SHELL (defaultShell,
    // src/main/terminal.ts) and every probe in this suite is Bourne syntax
    // ($(pwd), $$, quote-splitting) — a fish/other login shell on a local dev
    // box would otherwise break the tests spuriously.
    env: { ...process.env, LOOM_ROOT: dir, SHELL: 'bash' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
  return { app, page };
}

/** Open the terminal dock via the status-bar toggle and wait for xterm to
 *  mount (the .xterm element only appears once Terminal.open() ran). */
async function openTerminal(page: Page): Promise<void> {
  await page.locator(TOGGLE_BUTTON).click();
  await page.waitForSelector(XTERM, { timeout: 15_000 });
}

/** Type a shell command into the focused xterm and press Enter. TerminalPane
 *  focuses the terminal on mount; clicking the xterm host re-asserts focus so
 *  keystrokes deterministically reach term.onData -> terminal.input. */
async function runCommand(page: Page, command: string): Promise<void> {
  await page.locator(XTERM).click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** The pane's rendered text (xterm DOM renderer rows), '' before mount. */
async function paneText(page: Page): Promise<string> {
  return (await page.locator(PANE).textContent()) ?? '';
}

/** Probe (from the MAIN process) whether `pid` is still signalable.
 *  process.kill(pid, 0) sends NO signal — it only checks existence/permission
 *  and throws (ESRCH) once the process is gone. Evaluated in main so the check
 *  sees the same pid namespace that spawned the PTY. */
async function pidAlive(app: ElectronApplication, pid: number): Promise<boolean> {
  return app.evaluate((_electron, p) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  }, pid);
}

/* Guard: a missing build is a setup error, not a test failure (navlinks idiom). */
test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * 1. open → the shell starts in the launch root (pwd round-trip)      *
 * ------------------------------------------------------------------ */
test('terminal opens and the shell starts in the launch root (pwd prints it)', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openTerminal(page);

    // `$(pwd)` expands ONLY in the shell: the typed line renders as
    // `echo "PWD:$(pwd)"`, so the assertion below can only be satisfied by
    // REAL shell output, never by the local echo of the keystrokes.
    await runCommand(page, 'echo "PWD:$(pwd)"');

    // realpathSync guards the /tmp-as-symlink case (e.g. macOS /tmp ->
    // /private/tmp): the PTY's cwd is the RESOLVED directory, so the shell's
    // pwd prints the real path even when LOOM_ROOT was handed the symlink.
    await expect(page.locator(PANE)).toContainText('PWD:' + realpathSync(dir), {
      timeout: 15_000,
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 2. closing the pane kills the PTY process                           *
 * ------------------------------------------------------------------ */
test('closing the pane kills the PTY process', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openTerminal(page);

    // Learn the shell's pid from inside the shell. `$$` expands only in the
    // shell, so the typed line renders as `PID:$$:END` (no digits) and the
    // regex below can only match REAL output. The `:END` terminator guards
    // against a partially flushed render: a bare /PID:\d+/ could match
    // mid-paint and capture a TRUNCATED pid.
    await runCommand(page, 'echo "PID:$$:END"');
    await expect(page.locator(PANE)).toContainText(/PID:\d+:END/, { timeout: 15_000 });
    const match = /PID:(\d+):END/.exec(await paneText(page));
    expect(match, 'shell pid did not render').not.toBeNull();
    const pid = Number(match![1]);

    // Precondition: the shell is alive while the pane is open.
    expect(await pidAlive(app, pid)).toBe(true);

    // Close the pane: unmount -> terminal.close(sessionId) -> manager kill.
    await page.locator(CLOSE_BUTTON).click();
    await expect(page.locator(PANE)).toHaveCount(0);

    // The PTY process must die. Poll until process.kill(pid, 0) throws in the
    // MAIN process (kill is asynchronous; give the OS a moment to reap).
    await expect
      .poll(() => pidAlive(app, pid), { timeout: 15_000 })
      .toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 3. reopening after close yields a fresh working shell               *
 * ------------------------------------------------------------------ */
test('reopening after close yields a fresh working shell', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    // Round 1: open then close (the previous session is gone for good).
    await openTerminal(page);
    await page.locator(CLOSE_BUTTON).click();
    await expect(page.locator(PANE)).toHaveCount(0);

    // Round 2: reopen — a FRESH session must spawn and round-trip output.
    await openTerminal(page);

    // Quote-split marker: the typed line renders as `echo ROUND2_"OK"`, the
    // shell output as `ROUND2_OK` — only a live round-2 shell can produce it.
    await runCommand(page, 'echo ROUND2_"OK"');
    await expect(page.locator(PANE)).toContainText('ROUND2_OK', { timeout: 15_000 });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
