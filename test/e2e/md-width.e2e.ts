/* ============================================================
 * Loom — TIER 2 e2e: RENDERED-markdown reading-column width (Settings panel)
 * ------------------------------------------------------------
 * This is the ONLY layer that can prove the width-mode feature END TO END
 * against a REAL Chromium layout engine:
 *
 *   Settings panel → Viewer → Reading width radios ("Fixed (792px)" / "Full
 *   width", RENDERED .md applies regardless of file)
 *      → App-lifted useState<WidthMode> + persistMdWidth (localStorage)
 *      → data-mdwidth attribute on <section class="pane viewer">
 *      → CSS: .md max-width:792px ('fit') vs .viewer[data-mdwidth="full"] .md
 *        max-width:none ('full')  (src/renderer/styles/renderer.css)
 *      → the capture-only ?mdwidth=full|fit hint (parseMdWidthHint), seeded by
 *        main's --md-width capture flag (src/main/main.ts indexUrl)
 *
 * The control was MOVED out of the Viewer head into the Settings panel (gear →
 * Settings → Viewer → Reading width); the old in-head .md-width-btn toggle is
 * GONE (test 4 below asserts its absence).
 *
 * The node --test unit suite (test/md-width.mjs) proves the PURE resolution
 * (hint parse, stored coercion, hint>stored>default precedence) in isolation,
 * but ONLY a real Chromium renderer can prove the data-mdwidth → CSS measure
 * actually changes the rendered .md box, that the chosen mode persists across
 * files, and that the ?mdwidth=full hint boots in full width. No Tier-1 harness
 * has a layout engine, so the box-width assertions live HERE.
 *
 * It launches the REAL built app (dist/main.cjs) with `_electron`, opens a real
 * .md via the Explorer (the REAL selection → readFile IPC → MarkdownView →
 * renderMarkdown path, NO prod test hook), then drives the REAL Settings radios
 * and measures the REAL bounding boxes. Mirrors copy-rendered.e2e.ts.
 *
 * WHY each test FAILS FOR THE RIGHT REASON:
 *   1. Default is 'fit': if the predefined 792px measure regressed (e.g. the
 *      max-width was dropped or the default flipped to 'full'), the .md box
 *      would already span ~the full viewer width on open and the constrained-
 *      measure assertion (.md narrower than the pane by a clear margin) fails.
 *      Selecting "Full width" sets data-mdwidth="full"; if the override rule
 *      regressed (or the radio stopped lifting the mode), the .md box would NOT
 *      grow and the "wider than before, ~pane width" assertion fails. Selecting
 *      "Fixed (792px)" again restores the constrained measure.
 *   2. Persistence across FILES: re-opening another .md must keep 'full' (it was
 *      persisted to localStorage); if persistMdWidth regressed, the re-opened
 *      file would snap back to 'fit' (fail).
 *   3. Capture hint: launching with --md-width full (→ ?mdwidth=full) must boot
 *      the FIRST opened .md already in full width with NO Settings interaction;
 *      if the hint parse/precedence regressed, it would boot 'fit' (fail). This
 *      is the deterministic path headless screenshot capture relies on.
 *   4. The OLD in-head toggle is GONE: opening a .md must expose NO .md-width-btn
 *      in the Viewer head (the control moved into Settings).
 *   5. Restart persistence: toggle to 'full', CLOSE the app, then RELAUNCH the
 *      SAME app with the SAME userData dir and NO --md-width hint — so 'full' can
 *      ONLY come from the rehydrated localStorage. If persistence regressed, the
 *      relaunch would boot the default 'fit' (fail).
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WidthMode } from '../../src/renderer/lib/md-width.js';

/* ---- Build prerequisite ------------------------------------------------- */
// The e2e suite launches the BUILT bundle, never the TS sources. The project is
// "type": "commonjs", so Playwright transpiles this spec to CommonJS — __dirname
// is the directory of THIS file (test/e2e); resolve dist/main.cjs from it.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/* ---- Fixture content ----------------------------------------------------- */
// A long single paragraph so the rendered .md has real horizontal extent to
// measure: in 'fit' the centered 792px column is clearly NARROWER than the
// Viewer pane; in 'full' it spans the pane (minus the kept side padding).
const PARA = Array.from({ length: 12 }, () =>
  'The quick brown fox jumps over the lazy dog and keeps on running well past the margin.',
).join(' ');
const DOC_MD = [`# Width Fixture`, '', PARA, ''].join('\n');
const DOC2_MD = [`# Second Doc`, '', PARA, ''].join('\n');

/** Make a fresh temp sandbox dir with two .md fixtures. Returns the dir + their
 *  root-relative POSIX paths (the Explorer data-row-path / sandbox contract). */
function makeFixtureDir(): { dir: string; doc: string; doc2: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-mdwidth-'));
  writeFileSync(path.join(dir, 'doc.md'), DOC_MD);
  writeFileSync(path.join(dir, 'doc2.md'), DOC2_MD);
  return { dir, doc: 'doc.md', doc2: 'doc2.md' };
}

/* ---- Per-launch localStorage isolation -----------------------------------
 * The width mode persists in localStorage under 'loom.viewer.mdWidth'. Electron
 * scopes localStorage to the app's userData dir, and playwright.config runs
 * `workers:1` with NO per-test isolation and NO localStorage.clear(). If we let
 * every launch share the ONE default persistent userData dir, the DEFAULT-mode
 * ('fit') and box-measured assertions would only pass because no prior test/run
 * happened to persist 'full' — a test that aborts mid-change (or an aborted
 * prior run) would leave 'full' behind and FALSELY FAIL the next default
 * assertion. So each test that asserts the default/box state launches with its
 * OWN fresh temp userData dir (via the --user-data-dir Chromium switch Electron
 * honors), giving a guaranteed-empty localStorage independent of any sibling
 * test's cleanup. The restart-persistence test is the deliberate exception: it
 * REUSES one userData dir across two launches to prove rehydration across boots. */
function makeUserDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'loom-e2e-mdwidth-ud-'));
}

/* ---- Layout headroom -----------------------------------------------------
 * CRITICAL for the box-width assertions: at the DEFAULT 3-pane layout the app
 * launches 1440×900 (src/main/main.ts) with Explorer 248px + Chat 400px, so the
 * Viewer pane is only ~792px — i.e. the SAME as the 792px 'fit' measure. At that
 * width BOTH modes cap .md at the ~792px pane, so 'fit' shows no empty band and
 * the change produces no measurable growth — the core assertions could not hold.
 *
 * So every box-measuring test frees horizontal space: HIDE the Chat (--chat-
 * hidden frees its 400px track) and NARROW the Explorer to its 180px minimum
 * (--explorer-w 180). We must KEEP the Explorer visible — it is the only way to
 * click a file row (the tree is NOT rendered when --explorer-hidden), and the
 * launch() helper waits on a live treeitem. The Viewer pane is then ~1440-180 =
 * ~1260px, so 792px is CLEARLY narrower than the pane and Full visibly grows .md
 * to (≈) the full pane. This only frees measurement headroom; it does not change
 * the feature under test. */
const WIDE_PANE_ARGS = ['--chat-hidden', '--explorer-w', '180'] as const;

/** Launch the built app rooted at `dir`, wait for the first window + the live
 *  file tree. `extraArgs` carries capture flags (e.g. --md-width full,
 *  --chat-hidden for Viewer headroom). `userDataDir`, when given, is passed as
 *  the Chromium --user-data-dir switch so this launch gets an ISOLATED
 *  localStorage partition (see makeUserDataDir) — pass a fresh dir for a clean/
 *  default-mode test, or REUSE one dir across launches to prove restart
 *  persistence. Mirrors copy-rendered.e2e.ts / navlinks.e2e.ts. */
async function launch(
  dir: string,
  extraArgs: readonly string[] = [],
  userDataDir?: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  // --user-data-dir is an Electron/Chromium switch (NOT a Loom flag); placed
  // before MAIN_ENTRY it scopes this launch's localStorage to `userDataDir`.
  const udArgs = userDataDir === undefined ? [] : [`--user-data-dir=${userDataDir}`];
  const app = await electron.launch({
    args: [...udArgs, MAIN_ENTRY, ...extraArgs],
    // LOOM_ROOT is the sandbox root the launcher normally sets (bin/loom.cjs);
    // resolveRoot() honors it byte-for-byte, so the Explorer shows our fixture.
    env: { ...process.env, LOOM_ROOT: dir },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
  return { app, page };
}

/** Click a file row in the Explorer (by its root-relative path) and wait for
 *  the Viewer to render its markdown body. This drives the REAL selection path →
 *  readFile IPC → MarkdownView (renderMarkdown), NO prod test hook. */
async function openMarkdownFile(page: Page, relPath: string): Promise<void> {
  const row = page.locator(`.pane.explorer .row[data-row-path="${relPath}"]`);
  await row.click();
  await page.waitForSelector('.pane.viewer .md', { timeout: 15_000 });
}

/** The live data-mdwidth on the Viewer section ('fit' | 'full' | null). */
async function mdWidthAttr(page: Page): Promise<string | null> {
  return page.locator('.pane.viewer').getAttribute('data-mdwidth');
}

/** The rendered .md content-box width and its Viewer pane width (px). Used to
 *  prove 'fit' is a constrained measure NARROWER than the pane, while 'full'
 *  fills (≈) the pane. */
async function measure(page: Page): Promise<{ md: number; pane: number }> {
  const mdBox = await page.locator('.pane.viewer .md').boundingBox();
  const paneBox = await page.locator('.pane.viewer').boundingBox();
  if (!mdBox || !paneBox) throw new Error('missing bounding box for .md / .pane.viewer');
  return { md: mdBox.width, pane: paneBox.width };
}

/** Open the Settings panel via the StatusBar gear and wait for the dialog. The
 *  gear's accessible name is "Settings"; the dialog carries the stable
 *  "settings-dialog" class so it is targeted unambiguously vs the shortcuts one. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('.statusbar button[aria-label="Settings"]').click();
  await page.waitForSelector('.settings-dialog', { timeout: 15_000 });
}

/** The exact accessible names of the two reading-width radios (must match the
 *  visible labels — SettingsPanel renders them as the radios' names). */
const WIDTH_RADIO_NAME: Record<WidthMode, RegExp> = {
  fit: /^Fixed \(792px\)$/,
  full: /^Full width$/,
};

/** Choose a reading-width mode through the Settings panel: open Settings, click
 *  the radio by its accessible name, close Settings (Done), and wait for the
 *  dialog to detach. Drives the REAL Settings → App-lifted state → data-mdwidth
 *  path with NO prod test hook. */
async function setReadingWidth(page: Page, mode: WidthMode): Promise<void> {
  await openSettings(page);
  const dialog = page.locator('.settings-dialog');
  await dialog.getByRole('radio', { name: WIDTH_RADIO_NAME[mode] }).check();
  // Close via the footer "Done" button; wait for the dialog to fully detach so
  // a following assertion never races a closing animation.
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.settings-dialog')).toHaveCount(0);
}

/* Guard: a missing build is a setup error, not a test failure. */
test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * 1. DEFAULT is the predefined 792px "fit" measure; Settings → full   *
 * ------------------------------------------------------------------ */
test('1: default is the constrained 792px measure; Settings grows the .md to full width', async () => {
  const { dir, doc } = makeFixtureDir();
  // Fresh userData dir ⇒ guaranteed-empty localStorage: the default-'fit'
  // assertion below cannot be poisoned by a 'full' persisted by an aborted
  // sibling test or prior run.
  const ud = makeUserDataDir();
  // Hide Chat + narrow Explorer so the Viewer pane (~1260px) is genuinely WIDER
  // than the 792px 'fit' measure — see WIDE_PANE_ARGS.
  const { app, page } = await launch(dir, WIDE_PANE_ARGS, ud);
  try {
    await openMarkdownFile(page, doc);

    // --- default: 'fit' — the .md is clearly NARROWER than the Viewer pane ----
    expect(await mdWidthAttr(page)).toBe('fit');
    const fit = await measure(page);
    // The constrained measure leaves a clear empty band: well under the pane.
    expect(fit.md).toBeLessThan(fit.pane - 40);

    // --- Settings → 'full' — data-mdwidth flips, .md grows to (≈) the pane -----
    await setReadingWidth(page, 'full');
    expect(await mdWidthAttr(page)).toBe('full');
    const full = await measure(page);
    // Full is strictly wider than fit and spans (≈) the pane, minus the KEPT
    // side padding (.md padding 20px 30px ⇒ ~60px total) so text never glues to
    // the edges. Assert it grew AND lands within that padding band of the pane.
    expect(full.md).toBeGreaterThan(fit.md);
    expect(full.md).toBeGreaterThan(full.pane - 80);
    expect(full.md).toBeLessThanOrEqual(full.pane);

    // --- Settings → 'fit' restores the constrained measure -------------------
    await setReadingWidth(page, 'fit');
    expect(await mdWidthAttr(page)).toBe('fit');
    const fitAgain = await measure(page);
    expect(fitAgain.md).toBeLessThan(fitAgain.pane - 40);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 2. The chosen mode PERSISTS across files (localStorage)             *
 * ------------------------------------------------------------------ */
test('2: switching to full width sticks across files (persisted)', async () => {
  const { dir, doc, doc2 } = makeFixtureDir();
  // Fresh userData dir: this test asserts the OPEN-time default is 'fit' before
  // switching, so it must start from a guaranteed-empty localStorage — a 'full'
  // left by a sibling/prior run would make the first assertion false.
  const ud = makeUserDataDir();
  // Same headroom so 'full' lands at (≈) the wide pane, not capped at ~792px.
  const { app, page } = await launch(dir, WIDE_PANE_ARGS, ud);
  try {
    await openMarkdownFile(page, doc);
    expect(await mdWidthAttr(page)).toBe('fit');

    // Switch to full via Settings on the first file.
    await setReadingWidth(page, 'full');
    expect(await mdWidthAttr(page)).toBe('full');

    // Opening a DIFFERENT .md must keep full (the mode is sticky, not per-file).
    await openMarkdownFile(page, doc2);
    expect(await mdWidthAttr(page)).toBe('full');
    const full = await measure(page);
    expect(full.md).toBeGreaterThan(full.pane - 80);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 3. The ?mdwidth=full capture hint boots in full width               *
 * ------------------------------------------------------------------ */
// main's --md-width full capture flag forwards ?mdwidth=full to the renderer
// (src/main/main.ts indexUrl); parseMdWidthHint resolves it, and the hint wins
// over localStorage/default — so the FIRST opened .md boots full with NO
// Settings interaction.
test('3: launching with --md-width full boots the .md in full width (capture hint)', async () => {
  const { dir, doc } = makeFixtureDir();
  // Fresh userData dir: this PROVES the hint alone boots 'full'. With a shared
  // dir a prior persisted 'full' could make it pass for the wrong reason; a fresh
  // (empty) localStorage means ONLY the --md-width hint can produce 'full' here,
  // so the assertion isolates the capture-hint path.
  const ud = makeUserDataDir();
  // The capture hint AND the headroom flags together: boot full in a wide pane.
  const { app, page } = await launch(dir, ['--md-width', 'full', ...WIDE_PANE_ARGS], ud);
  try {
    await openMarkdownFile(page, doc);

    // No Settings interaction — the hint alone put the column in full on boot.
    expect(await mdWidthAttr(page)).toBe('full');
    const full = await measure(page);
    expect(full.md).toBeGreaterThan(full.pane - 80);
    expect(full.md).toBeLessThanOrEqual(full.pane);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 4. The OLD in-head width toggle is GONE                             *
 * ------------------------------------------------------------------ */
// The control was MOVED into the Settings panel; the Viewer head no longer
// renders a .md-width-btn. Opening a .md must expose NONE — proves the head
// toggle was fully removed (its JSX + CSS), the mirror of the Settings-driven
// path tests 1–3 exercise. Fresh userData dir keeps it self-contained.
test('4: the old in-head width toggle is gone (.md-width-btn absent)', async () => {
  const { dir, doc } = makeFixtureDir();
  const ud = makeUserDataDir();
  const { app, page } = await launch(dir, WIDE_PANE_ARGS, ud);
  try {
    await openMarkdownFile(page, doc);
    // The reading column still renders, but with NO in-head toggle button.
    await expect(page.locator('.pane.viewer .md-width-btn')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 5. RESTART PERSISTENCE: the mode survives an APP RESTART            *
 * ------------------------------------------------------------------ */
// The feature persists the mode in localStorage so it sticks across files AND
// app restarts (md-width.ts persistMdWidth / readInitialMdWidth: stored wins
// over default when there is no hint). Tests 1–2 only prove cross-FILE stick
// within ONE process. This proves cross-BOOT rehydration: set 'full' via
// Settings, CLOSE the app, then RELAUNCH the SAME app with the SAME userData dir
// and NO --md-width hint — so 'full' can ONLY come from the rehydrated
// localStorage. If persistence regressed, the relaunch would boot 'fit' (fail).
test('5: the chosen full-width mode survives an app restart (localStorage rehydration)', async () => {
  const { dir, doc } = makeFixtureDir();
  // ONE userData dir REUSED across both launches — the shared localStorage
  // partition is exactly what carries the mode across the restart.
  const ud = makeUserDataDir();
  try {
    /* ---- boot #1: set 'full' via Settings (persists to localStorage) ------- */
    {
      const { app, page } = await launch(dir, WIDE_PANE_ARGS, ud);
      try {
        await openMarkdownFile(page, doc);
        // Fresh dir ⇒ default 'fit' on this first boot.
        expect(await mdWidthAttr(page)).toBe('fit');
        await setReadingWidth(page, 'full');
        expect(await mdWidthAttr(page)).toBe('full');
      } finally {
        // Close the WHOLE app — the next launch is a genuine cold boot that must
        // rebuild its state from disk (localStorage), not in-process memory.
        await app.close();
      }
    }

    /* ---- boot #2: relaunch SAME userData dir, NO hint ⇒ rehydrates 'full' --- */
    {
      // Deliberately NO --md-width hint: the only source of 'full' is the
      // localStorage persisted by boot #1, so this isolates rehydration.
      const { app, page } = await launch(dir, WIDE_PANE_ARGS, ud);
      try {
        await openMarkdownFile(page, doc);
        // The mode rehydrated from disk: the first opened .md boots 'full' with
        // NO Settings interaction and NO capture hint.
        expect(await mdWidthAttr(page)).toBe('full');
      } finally {
        await app.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
