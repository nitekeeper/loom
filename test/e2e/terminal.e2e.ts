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
// (The pane itself is a <section aria-label="Terminal N">, never a button, so
// the button-scoped selector stays unambiguous — but note the pane's accessible
// name is now INDEXED, so a bare name match would substring-collide; selectors
// here that need the pane scope to ONE index use the data-terminal-index hook.)
const TOGGLE_BUTTON =
  'button[aria-label="Terminal"], button[aria-label="Toggle terminal"]';
// The status-bar "Add terminal" action — mounts another .pane.terminal column
// (up to MAX_TERMINALS), opening the dock first when it is closed.
const ADD_BUTTON = 'button[aria-label="Add terminal"]';
const PANE = '.pane.terminal';
const XTERM = `${PANE} .xterm`;
const CLOSE_BUTTON = `${PANE} button[aria-label="Close terminal"]`;

/* ---- Per-index (multi-terminal) selectors -------------------------------- *
 * The dock mounts up to 3 .pane.terminal columns side by side, each carrying a
 * 0-based `data-terminal-index` attribute and an indexed `aria-label`
 * (`Terminal N`, N = index + 1). With >1 pane live a bare `.pane.terminal`
 * locator multi-matches and trips Playwright STRICT MODE (risk R9), so every
 * per-terminal selector below scopes to ONE index via the data attribute — the
 * stable, exact, non-substring hook (an aria-label name match would substring-
 * collide: "Terminal 1" is a prefix of nothing here, but the attribute selector
 * is the unambiguous idiom and never collides with the StatusBar "Terminal"
 * toggle either). */
const paneAt = (i: number): string => `${PANE}[data-terminal-index="${i}"]`;
const xtermAt = (i: number): string => `${paneAt(i)} .xterm`;
const closeAt = (i: number): string =>
  `${paneAt(i)} button[aria-label="Close terminal"]`;

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
  // Isolate Electron's userData per launch (XDG_CONFIG_HOME → app.getPath(
  // 'userData') on Linux) so PERSISTED state never leaks across tests:
  // loom-config.json carries terminalCount, and localStorage carries
  // TERMINAL_OPEN_KEY / TERMINAL_COLUMNS_RATIOS_KEY. Without this, a test that
  // opens N terminals (or leaves the dock open) makes a LATER test boot with the
  // wrong column count or an already-open dock — an order-dependent flake the
  // multi-terminal persistence made visible (single-terminal tests booting at 3
  // columns; the toggle CLOSING an already-open dock). A fresh dir = a clean boot.
  const cfgDir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-cfg-'));
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    // LOOM_ROOT is the sandbox root the launcher normally sets (bin/loom.cjs);
    // resolveRoot() honors it byte-for-byte — the PTY must spawn with this
    // directory as its cwd (AC 1).
    // SHELL is pinned to bash because the app honors $SHELL (defaultShell,
    // src/main/terminal.ts) and every probe in this suite is Bourne syntax
    // ($(pwd), $$, quote-splitting) — a fish/other login shell on a local dev
    // box would otherwise break the tests spuriously.
    env: { ...process.env, LOOM_ROOT: dir, SHELL: 'bash', XDG_CONFIG_HOME: cfgDir },
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

/** Open the dock then ADD columns until `count` (1..3) panes are live, waiting
 *  for each new pane's xterm to mount before adding the next (the PTY spawn is
 *  async). Returns once all `count` indexed panes have an .xterm element. */
async function openNTerminals(page: Page, count: number): Promise<void> {
  await openTerminal(page); // pane index 0
  await expect(page.locator(xtermAt(0))).toHaveCount(1);
  for (let i = 1; i < count; i++) {
    await page.locator(ADD_BUTTON).click();
    // The freshly-added pane is the rightmost (slot i). Wait for ITS xterm to
    // mount before adding the next, so each terminal is fully spawned.
    await page.waitForSelector(xtermAt(i), { timeout: 15_000 });
  }
  await expect(page.locator(PANE)).toHaveCount(count);
}

/** Type a command into the xterm at index `i` (re-asserting focus on that
 *  pane's host so keystrokes reach the RIGHT pty) and press Enter. */
async function runCommandAt(page: Page, i: number, command: string): Promise<void> {
  await page.locator(xtermAt(i)).click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** The rendered text of the indexed pane (xterm DOM rows), '' before mount. */
async function paneTextAt(page: Page, i: number): Promise<string> {
  return (await page.locator(paneAt(i)).textContent()) ?? '';
}

/** Read the shell pid the indexed terminal printed via `echo "PID:$$:END"`.
 *  `$$` expands ONLY in the shell, so the typed line renders WITHOUT digits and
 *  the regex can never match the local echo of the keystrokes; the `:END`
 *  terminator guards against capturing a TRUNCATED pid from a partial paint. */
async function readPidAt(page: Page, i: number): Promise<number> {
  await runCommandAt(page, i, 'echo "PID:$$:END"');
  await expect(page.locator(paneAt(i))).toContainText(/PID:\d+:END/, {
    timeout: 15_000,
  });
  const match = /PID:(\d+):END/.exec(await paneTextAt(page, i));
  expect(match, `terminal ${i} pid did not render`).not.toBeNull();
  return Number(match![1]);
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
 * 2b. REGRESSION: column splitters must not overlay the dock          *
 * ------------------------------------------------------------------ */
// The Explorer/Chat column splitters are absolutely-positioned grid children
// of .body with top:0/bottom:0 rails at z-index:5. A bare `grid-row: 1` pin
// resolves an abspos child's END line to the grid CONTAINER edge (CSS Grid
// §9.2), which once let both rails run straight through the terminal row —
// painting over the dock and stealing its pointer events. The fix pins
// `grid-row: 1 / 2` so the rails stop at the row-1/dock seam; this test
// fails for the right reason if that end line ever regresses.
test('column splitters do not extend over the open terminal dock', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openTerminal(page);

    const pane = await page.locator(PANE).boundingBox();
    expect(pane, 'terminal pane has no bounding box').not.toBeNull();

    // Both column splitters: Explorer right edge (.left) and Chat left edge
    // (the base class). Scope to .body and exclude the dock's own horizontal
    // splitter, which legitimately straddles the seam by design.
    const splitters = page.locator('.body > .splitter:not(.horizontal)');
    await expect(splitters).toHaveCount(2);

    for (const splitter of await splitters.all()) {
      const box = await splitter.boundingBox();
      expect(box, 'column splitter has no bounding box').not.toBeNull();
      // The rail must STOP at (or above) the dock's top edge — no vertical
      // overlap with the terminal pane. 0.5px slack absorbs subpixel layout
      // rounding in boundingBox(); a real regression overlaps by the full
      // dock height (--terminal-h >= 120px), far beyond any rounding noise.
      expect(box!.y + box!.height).toBeLessThanOrEqual(pane!.y + 0.5);
    }
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

/* ================================================================== *
 * MULTI-TERMINAL: up to 3 columns, INDEPENDENT ptys, per-index close, *
 * width geometry, and per-terminal solo-maximize (design §4 / R8/R11) *
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * 4. three terminals run as INDEPENDENT shells (distinct pids + cwd)  *
 * ------------------------------------------------------------------ */
// Adding columns mounts a SEPARATE PTY per pane (App tracks a count and mounts
// one TerminalPane per slot; each pane's mount opens its OWN session). Each
// shell must therefore report a DISTINCT pid — a regression that reused one
// backend session across panes (or mounted a single shared xterm) would print
// the SAME pid in every column. Every pane is also cwd-pinned to the launch
// root, so each prints the same PWD — proving all three are real, live shells.
test('three terminals run as independent shells with distinct pids', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openNTerminals(page, 3);

    // Each pane prints its OWN shell pid (parsed via the digit-free typed line)
    // and its cwd. Read them per index — the per-pane host click in runCommandAt
    // routes each command to the matching pty.
    const pids = [
      await readPidAt(page, 0),
      await readPidAt(page, 1),
      await readPidAt(page, 2),
    ];

    // All three pids are real and pairwise DISTINCT — three independent shells.
    for (const pid of pids) expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(new Set(pids).size, `pids were not all distinct: ${pids.join()}`).toBe(3);

    // Each is a live shell cwd-pinned to the launch root (`$(pwd)` expands only
    // in the shell, so the assertion can't pass off the keystroke echo). The
    // resolved real path guards the /tmp-symlink case (terminal AC 1 idiom).
    const wantPwd = 'PWD:' + realpathSync(dir);
    for (const i of [0, 1, 2]) {
      await runCommandAt(page, i, 'echo "PWD:$(pwd)"');
      await expect(page.locator(paneAt(i))).toContainText(wantPwd, {
        timeout: 15_000,
      });
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 5. closing ONE terminal kills only its pty; siblings survive        *
 * ------------------------------------------------------------------ */
// With >1 column open, a terminal's × removes the RIGHTMOST column (App tracks a
// count, so the last TerminalPane unmounts and its cleanup closes ITS session).
// The unmounted pane's pty MUST die while the remaining panes' ptys stay alive —
// proving per-pane session lifetime, not a shared backend that a single close
// would tear down (or leak) for everyone.
test('closing one terminal kills only its pty; siblings survive', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openNTerminals(page, 3);

    // Learn each pane's pid BEFORE the close so we can probe all three after.
    const pid0 = await readPidAt(page, 0);
    const pid1 = await readPidAt(page, 1);
    const pid2 = await readPidAt(page, 2);
    expect(new Set([pid0, pid1, pid2]).size).toBe(3);

    // Precondition: all three shells are alive (signalable from main).
    expect(await pidAlive(app, pid0)).toBe(true);
    expect(await pidAlive(app, pid1)).toBe(true);
    expect(await pidAlive(app, pid2)).toBe(true);

    // Close ONE terminal: removeTerminal unmounts the rightmost (slot 2). Its ×
    // is the closeAt(2) button; the dock drops to two columns.
    await page.locator(closeAt(2)).click();
    await expect(page.locator(PANE)).toHaveCount(2);

    // The closed pane's pty MUST die (kill is async — poll until ESRCH in main).
    await expect.poll(() => pidAlive(app, pid2), { timeout: 15_000 }).toBe(false);

    // The TWO surviving panes' ptys stay alive — a close that reaped a sibling
    // (shared-session bug) would fail here. Probe a few times to catch a delayed
    // collateral kill, then re-confirm the live panes still echo (truly usable).
    for (let n = 0; n < 5; n++) {
      expect(await pidAlive(app, pid0), 'terminal 0 pty was wrongly killed').toBe(true);
      expect(await pidAlive(app, pid1), 'terminal 1 pty was wrongly killed').toBe(true);
    }
    await runCommandAt(page, 0, 'echo STILL_"ALIVE0"');
    await expect(page.locator(paneAt(0))).toContainText('STILL_ALIVE0', {
      timeout: 15_000,
    });
    await runCommandAt(page, 1, 'echo STILL_"ALIVE1"');
    await expect(page.locator(paneAt(1))).toContainText('STILL_ALIVE1', {
      timeout: 15_000,
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 6. quitting the app reaps EVERY pty                                  *
 * ------------------------------------------------------------------ */
// App teardown (here app.close(), the same path a window-close / quit takes)
// must unmount every TerminalPane and kill ALL their ptys — no orphaned shells
// outliving the app. Captures all three pids while live, then asserts each is
// gone AFTER the app exits (probed from a SECOND, fresh Electron instance, since
// the original main process is gone; pids live in the same OS namespace).
test('quitting the app reaps every terminal pty', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  let pids: number[] = [];
  try {
    await openNTerminals(page, 3);
    const pid0 = await readPidAt(page, 0);
    const pid1 = await readPidAt(page, 1);
    const pid2 = await readPidAt(page, 2);
    pids = [pid0, pid1, pid2];
    expect(new Set(pids).size).toBe(3);
    expect(await pidAlive(app, pid0)).toBe(true);
    expect(await pidAlive(app, pid1)).toBe(true);
    expect(await pidAlive(app, pid2)).toBe(true);
  } finally {
    await app.close();
  }

  // After the app has quit, NONE of the ptys may survive. The original main
  // process is gone, so probe from a fresh, throwaway Electron instance — the
  // pids are OS-global, and process.kill(pid, 0) reports existence regardless of
  // which process asks. Poll to absorb the OS's async reap of the dead children.
  const probeDir = makeFixtureDir();
  const probe = await launch(probeDir);
  try {
    for (const pid of pids) {
      await expect
        .poll(() => pidAlive(probe.app, pid), { timeout: 15_000 })
        .toBe(false);
    }
  } finally {
    await probe.app.close();
    rmSync(probeDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 7. column geometry: 2-col vs 3-col widths (boundingBox)             *
 * ------------------------------------------------------------------ */
// The dock lays the columns out as equal-ish fractions of the SAME dock width
// (terminalColumnsTemplate). So with 2 columns each pane is ~half the dock; with
// 3 it is ~a third — every 3-col pane must be NARROWER than a 2-col pane, and
// the columns within a count must be roughly equal. A regression that stopped
// re-templating on add (all panes keep the 2-col width, overflowing the dock, or
// one pane collapsing to ~0) fails the width-monotonicity assertion below.
test('column widths shrink from 2-col to 3-col layout (boundingBox)', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    // --- 2-column layout: measure each pane's width. ---
    await openNTerminals(page, 2);
    const w0two = (await page.locator(paneAt(0)).boundingBox())?.width;
    const w1two = (await page.locator(paneAt(1)).boundingBox())?.width;
    expect(w0two, 'pane 0 (2-col) has no box').toBeTruthy();
    expect(w1two, 'pane 1 (2-col) has no box').toBeTruthy();
    // The two columns are ~equal (within 10% of each other) — equal fractions.
    expect(Math.abs(w0two! - w1two!)).toBeLessThan(w0two! * 0.1);

    // --- add a 3rd column, re-measure. ---
    await page.locator(ADD_BUTTON).click();
    await page.waitForSelector(xtermAt(2), { timeout: 15_000 });
    await expect(page.locator(PANE)).toHaveCount(3);
    const w0three = (await page.locator(paneAt(0)).boundingBox())?.width;
    const w1three = (await page.locator(paneAt(1)).boundingBox())?.width;
    const w2three = (await page.locator(paneAt(2)).boundingBox())?.width;
    expect(w0three, 'pane 0 (3-col) has no box').toBeTruthy();
    expect(w1three, 'pane 1 (3-col) has no box').toBeTruthy();
    expect(w2three, 'pane 2 (3-col) has no box').toBeTruthy();

    // Each 3-col pane is NARROWER than a 2-col pane (a third < a half of the
    // ~same dock width). 1px slack absorbs subpixel rounding; a real regression
    // (no re-template) leaves them equal or wider.
    expect(w0three!).toBeLessThan(w0two! - 1);
    // The three columns are ~equal to each other (equal fractions of the dock).
    expect(Math.abs(w0three! - w1three!)).toBeLessThan(w0three! * 0.1);
    expect(Math.abs(w1three! - w2three!)).toBeLessThan(w1three! * 0.1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 8. solo-maximize hides the OTHER terminals, restore brings them back *
 * ------------------------------------------------------------------ */
// Solo-maximizing terminal *i* expands it to fill the dock and HIDES its
// siblings WITHIN the dock (visibility:hidden, design §4 / R11) — NOT a whole-
// dock maximize. The maximized pane stays visible; the others leave the tab
// order / AT tree. A second press on the same pane restores the side-by-side
// layout. The maximized pane's width must also grow to ~the full dock.
test('solo-maximizing one terminal hides the others; restore brings them back', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openNTerminals(page, 3);

    // All three visible side by side before any maximize.
    for (const i of [0, 1, 2]) {
      await expect(page.locator(paneAt(i))).toBeVisible();
    }
    const wBefore = (await page.locator(paneAt(1)).boundingBox())?.width;
    expect(wBefore, 'pane 1 has no pre-maximize box').toBeTruthy();

    // Solo-maximize the MIDDLE terminal via its pane-header maximize button
    // (aria-label "Maximize terminal", scoped to slot 1). The wrap gains
    // .solo-maximized and the maximized pane spans the full dock.
    await page
      .locator(`${paneAt(1)} button[aria-label="Maximize terminal"]`)
      .click();

    // The two SIBLINGS are hidden (visibility:hidden ⇒ Playwright "hidden");
    // the maximized terminal stays visible and grows to ~the full dock width.
    await expect(page.locator(paneAt(0))).toBeHidden();
    await expect(page.locator(paneAt(2))).toBeHidden();
    await expect(page.locator(paneAt(1))).toBeVisible();
    const wMax = (await page.locator(paneAt(1)).boundingBox())?.width;
    expect(wMax, 'maximized pane 1 has no box').toBeTruthy();
    // The maximized pane is markedly WIDER than its restored third-of-dock width
    // (it now spans every grid column) — a clear, rounding-proof delta.
    expect(wMax!).toBeGreaterThan(wBefore! * 1.5);

    // The pane-header button flips to the RESTORE affordance while maximized
    // (aria-pressed mirrors the state) — matches the keyboard-shortcuts suite.
    const restoreBtn = page.locator(
      `${paneAt(1)} button[aria-label="Restore terminal size"]`,
    );
    await expect(restoreBtn).toHaveAttribute('aria-pressed', 'true');

    // Restore: a second press on the (now Restore) button brings the siblings
    // back to a side-by-side, all-visible layout.
    await restoreBtn.click();
    for (const i of [0, 1, 2]) {
      await expect(page.locator(paneAt(i))).toBeVisible();
    }
    const wAfter = (await page.locator(paneAt(1)).boundingBox())?.width;
    expect(wAfter, 'pane 1 has no post-restore box').toBeTruthy();
    // Back to ~its pre-maximize third-of-dock width (within 5%).
    expect(Math.abs(wAfter! - wBefore!)).toBeLessThan(wBefore! * 0.05);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 9. an IN-APP RELOAD reaps EVERY live pty (the did-navigate path)     *
 * ------------------------------------------------------------------ */
// A full renderer reload drops every sessionId WITHOUT sending a close, so main
// wires `win.webContents.on('did-navigate', () => terminal.disposeAll())` to kill
// all live ptys (src/main/main.ts) — design AC4 lists reload alongside window-
// close and will-quit. This is a DISTINCT path from the quit/window-close test
// above: here the APP STAYS ALIVE (only the renderer navigates), so the original
// main process can probe the pids directly — process.kill(pid, 0) must report
// every captured pid as gone. A regression where the map-based disposeAll stopped
// iterating every entry (risk R3) would leave orphan shells signalable here.
test('reloading the renderer reaps every terminal pty (did-navigate disposeAll)', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openNTerminals(page, 3);

    // Capture all three live pids BEFORE the reload (digit-free typed line, so the
    // parse can never read the keystroke echo) and confirm they are distinct.
    const pids = [
      await readPidAt(page, 0),
      await readPidAt(page, 1),
      await readPidAt(page, 2),
    ];
    for (const pid of pids) expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(new Set(pids).size, `pids were not all distinct: ${pids.join()}`).toBe(3);

    // Precondition: all three shells are alive (signalable from the main process).
    for (const pid of pids) expect(await pidAlive(app, pid)).toBe(true);

    // Drive an IN-APP reload (NOT app.close()): the renderer navigates, firing
    // `did-navigate` in main, which calls terminal.disposeAll(). page.reload()
    // waits for the fresh document to load, after which the dock starts CLOSED
    // again — the dispose has already fired on the navigation.
    await page.reload();
    await page.waitForSelector('.pane.explorer [role="treeitem"]', {
      timeout: 30_000,
    });

    // Every captured pty MUST die. The app process is still alive, so probe from
    // the SAME instance; poll until process.kill(pid, 0) throws (ESRCH) in main —
    // the OS reaps the killed children asynchronously.
    for (const pid of pids) {
      await expect.poll(() => pidAlive(app, pid), { timeout: 15_000 }).toBe(false);
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 10. dragging the inter-terminal divider resizes both adjacent panes  *
 * ------------------------------------------------------------------ */
// Design AC5: the inter-terminal columns are RESIZABLE via the ColSplitter-style
// divider. The `.terminal-col-divider` between slots 0 and 1 (aria-label
// "Resize terminals 1 and 2") moves width from the RIGHT column to the LEFT when
// dragged right (App.tsx TerminalColSplitter.applyDelta). A pointer down/move/up
// over it must therefore widen pane 0 and narrow pane 1 by ~the same amount — the
// two boundingBox widths change in OPPOSITE directions — while clampColumnRatios
// keeps BOTH columns at or above TERMINAL_PANE_MIN (240px). A regression that
// stopped wiring the drag (or clamped both panes to one width) fails here.
const TERMINAL_PANE_MIN = 240; // mirrors src/renderer/lib/terminal-columns.ts
const DIVIDER = '.splitter.terminal-col-divider';
test('dragging the inter-terminal divider resizes the two adjacent panes (opposite directions, min floor held)', async () => {
  const dir = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    // Two terminals → ONE divider between slots 0 and 1.
    await openNTerminals(page, 2);
    const divider = page.locator(DIVIDER);
    await expect(divider).toHaveCount(1);

    // Pre-drag widths of the two adjacent panes (equal-ish 2-col fractions).
    const w0before = (await page.locator(paneAt(0)).boundingBox())?.width;
    const w1before = (await page.locator(paneAt(1)).boundingBox())?.width;
    expect(w0before, 'pane 0 has no pre-drag box').toBeTruthy();
    expect(w1before, 'pane 1 has no pre-drag box').toBeTruthy();

    // The divider's center is the grab point. Drag it RIGHT by a fixed, sizable
    // delta (widens the LEFT column, narrows the RIGHT) — staying inside the dock
    // so neither column hits the min floor. mouse.move in steps emits the
    // pointermove stream the capture-based handler tracks (TerminalColSplitter).
    const box = await divider.boundingBox();
    expect(box, 'divider has no bounding box').toBeTruthy();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    const dragBy = 80; // px to the right; comfortably below the slack to the floor

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dragBy, startY, { steps: 12 });
    await page.mouse.up();

    // Post-drag widths. Poll the LEFT pane until it actually grew, so the assertion
    // does not race the React re-render the pointerup persist triggers.
    await expect
      .poll(async () => (await page.locator(paneAt(0)).boundingBox())?.width ?? 0, {
        timeout: 15_000,
      })
      .toBeGreaterThan(w0before! + 1);
    const w0after = (await page.locator(paneAt(0)).boundingBox())?.width;
    const w1after = (await page.locator(paneAt(1)).boundingBox())?.width;
    expect(w0after, 'pane 0 has no post-drag box').toBeTruthy();
    expect(w1after, 'pane 1 has no post-drag box').toBeTruthy();

    // OPPOSITE directions: the left pane GREW, the right pane SHRANK (1px slack
    // absorbs subpixel rounding; the 80px drag dwarfs any rounding noise).
    expect(w0after!).toBeGreaterThan(w0before! + 1);
    expect(w1after!).toBeLessThan(w1before! - 1);

    // The total width across the two panes is conserved (the divider shifts share
    // between them; it does not change the dock width). Within a few px of slack.
    expect(Math.abs(w0after! + w1after! - (w0before! + w1before!))).toBeLessThan(4);

    // NEITHER pane dropped below TERMINAL_PANE_MIN — clampColumnRatios held the
    // floor on both columns through the drag (design AC5 min-width floor).
    expect(w0after!).toBeGreaterThanOrEqual(TERMINAL_PANE_MIN);
    expect(w1after!).toBeGreaterThanOrEqual(TERMINAL_PANE_MIN);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
