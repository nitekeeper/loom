/* ============================================================
 * Loom — TIER 2 e2e: branch "Changes" viewer across the REAL stack
 * ------------------------------------------------------------
 * The ONLY tier that exercises the full button→getChanges→IPC→main→render
 * round-trip on a REAL git repo: it seeds a real branch+changes into a
 * tmpdir, launches the built app (dist/main.cjs) with LOOM_ROOT=dir via
 * `_electron`, clicks the StatusBar Changes toggle, and asserts the
 * file-list + before→after diff render READ-ONLY under the app's real CSP.
 *
 *   StatusBar.tsx Changes iconbtn onClick → App.toggleChanges
 *      → store.loadChanges() → window.loom.getChanges()
 *      → preload bridge (assertInvoke-pinned IPC.GET_CHANGES)
 *      → ipc.ts handler → src/main/git-diff.getChanges(rootPath)
 *   FileDiff expand → window.loom.readFileDiff(path)
 *      → IPC.READ_FILE_DIFF handler (sandbox.resolveInRoot re-confine, Law 3)
 *      → getFileDiff → parsed hunks → highlightCode escape sink (Law 1)
 *
 * LAW 1 UNDER REAL CSP: a seeded *.html/*.svg change carrying <script>/
 * <img onerror>/a javascript: link is rendered as ESCAPED SOURCE in the
 * diff — no script runs (a sentinel global stays untouched), no <img>
 * element materializes, and a javascript: target never reaches a
 * monkeypatched shell.openExternal spy (the zero-prod-seam pattern from
 * navlinks.e2e.ts).
 *
 * CI-ONLY: this launches Electron, which the WSL sandbox cannot do. Here
 * it must only `npx playwright test --list` + `npm run typecheck:e2e`.
 * Auto-discovered by playwright.config testMatch (no package.json edit).
 * Mirrors window-close.e2e.ts / navlinks.e2e.ts.
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/** Per-invocation `-c` isolation flags so a hostile global git config (hooks,
 *  required signing) can't perturb the fixture — matches test/git-diff.mjs. */
const ISOLATION = [
  '-c',
  'core.hooksPath=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
];

/** Run git in `cwd` with a fixed argv (NO shell), isolated from host config via
 *  prepended `-c` flags (the comment now matches the code). */
function git(cwd: string, args: string[]): void {
  execFileSync('git', [...ISOLATION, ...args], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

/** Seed a real temp git repo on `main` with a base commit, then a `feature`
 *  branch carrying: a MODIFIED text file, a CREATED text file, and a CREATED
 *  *.html file with HOSTILE content (Law-1 fodder). Returns the dir. */
function makeGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-changes-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'loom-test@example.com']);
  git(dir, ['config', 'user.name', 'Loom Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'edit.txt'), 'alpha\nbeta\ngamma\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);

  git(dir, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(path.join(dir, 'edit.txt'), 'alpha\nBETA\ngamma\n');
  writeFileSync(path.join(dir, 'new.txt'), 'first new line\nsecond new line\n');
  // HOSTILE content for the Law-1 assertion: a script tag, an onerror img, and
  // a javascript: link, all in a *.html file (which the diff shows as SOURCE).
  writeFileSync(
    path.join(dir, 'evil.html'),
    '<script>window.__loomPwned = true;</script>\n' +
      '<img src=x onerror="window.__loomPwned = true">\n' +
      '<a href="javascript:window.__loomPwned=true">x</a>\n',
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'feature work']);
  return dir;
}

/** Install the main-process shell.openExternal spy (zero prod seam). */
async function installOpenExternalSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    shell.openExternal = (url: string): Promise<void> => {
      g.__opened.push(url);
      return Promise.resolve();
    };
  });
}

async function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __opened?: string[] };
    return g.__opened ?? [];
  });
}

/** Launch the built app rooted at `dir`, wait for the Explorer tree, install
 *  the openExternal spy, and seed a renderer-side Law-1 sentinel. */
async function launch(dir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, LOOM_ROOT: dir },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
  await installOpenExternalSpy(app);
  // Renderer-side sentinel: if any seeded hostile bytes EXECUTED in the diff
  // render, this global would flip true. It must stay untouched.
  await page.evaluate(() => {
    (window as unknown as { __loomPwned?: boolean }).__loomPwned = false;
  });
  return { app, page };
}

test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * a. Changes button OPENS the view + lists the seeded changed files   *
 * ------------------------------------------------------------------ */
test('a: clicking Changes opens the viewer listing exactly the seeded changed files', async () => {
  const dir = makeGitRepo();
  const { app, page } = await launch(dir);
  try {
    // The StatusBar toggle opens the center-pane Changes viewer.
    await page.getByRole('button', { name: 'Changes' }).click();
    const changes = page.locator('.pane.viewer.changes');
    await expect(changes).toHaveCount(1);

    // The three changed files are listed (edit.txt modified, new.txt + evil.html
    // created); the unchanged base file is absent (it was committed on main).
    await expect(changes.getByRole('button', { name: /edit\.txt/ })).toHaveCount(1);
    await expect(changes.getByRole('button', { name: /new\.txt/ })).toHaveCount(1);
    await expect(changes.getByRole('button', { name: /evil\.html/ })).toHaveCount(1);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * b. before→after renders READ-ONLY (no editable element, no nav)     *
 * ------------------------------------------------------------------ */
test('b: expanding a modified file shows old+new lines marked, READ-ONLY, no nav', async () => {
  const dir = makeGitRepo();
  const { app, page } = await launch(dir);
  try {
    const urlBefore = page.url();
    await page.getByRole('button', { name: 'Changes' }).click();
    const changes = page.locator('.pane.viewer.changes');
    await expect(changes).toHaveCount(1);

    // Expand the modified file; its diff body renders.
    await changes.getByRole('button', { name: /modified: edit\.txt/ }).click();
    await expect(changes.locator('.diff-body')).toHaveCount(1);
    // The deleted (old) line AND the added (new) line are both visible + marked.
    await expect(changes.locator('.diff-row.diff-del')).not.toHaveCount(0);
    await expect(changes.locator('.diff-row.diff-add')).not.toHaveCount(0);

    // FIDELITY (not just presence): the SPECIFIC before→after content reached the
    // DOM in the right rows — the old text 'beta' in a .diff-del .diff-text and
    // the new text 'BETA' in a .diff-add .diff-text (the fixture edits beta→BETA).
    // A bug that swapped the add/del classes or dropped the text would fail here.
    await expect(changes.locator('.diff-row.diff-del .diff-text')).toContainText('beta');
    await expect(changes.locator('.diff-row.diff-add .diff-text')).toContainText('BETA');
    // A gutter line number rendered (the diff is line-numbered, not class-only).
    await expect(changes.locator('.diff-gutter', { hasText: /\d/ }).first()).toBeVisible();

    // READ-ONLY: the diff body contains NO editable element.
    expect(await changes.locator('input, textarea, [contenteditable="true"]').count()).toBe(0);
    // The window NEVER navigated away from its local bundle.
    expect(page.url()).toBe(urlBefore);
    expect(page.url().startsWith('file://')).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * c. LAW 1 under the REAL CSP — hostile *.html diff stays inert        *
 * ------------------------------------------------------------------ */
test('c: a hostile *.html diff renders as escaped source — no script runs, no <img>, no js: open', async () => {
  const dir = makeGitRepo();
  const { app, page } = await launch(dir);
  try {
    await page.getByRole('button', { name: 'Changes' }).click();
    const changes = page.locator('.pane.viewer.changes');
    await expect(changes).toHaveCount(1);

    // Expand the hostile *.html file; the diff body renders its bytes as SOURCE.
    await changes.getByRole('button', { name: /evil\.html/ }).click();
    await expect(changes.locator('.diff-body')).toHaveCount(1);

    // The escaped source text is present (proves it rendered, as inert text).
    await expect(changes.locator('.diff-text')).toContainText('onerror');

    // No live <script>/<img> materialized inside the diff (the bytes are escaped).
    expect(await changes.locator('script').count()).toBe(0);
    expect(await changes.locator('img').count()).toBe(0);

    // No seeded byte EXECUTED — the renderer sentinel is untouched.
    const pwned = await page.evaluate(
      () => (window as unknown as { __loomPwned?: boolean }).__loomPwned,
    );
    expect(pwned).toBe(false);

    // And the javascript: link never reached the OS (no anchor activation path
    // exists for inert source text; assert the spy stayed empty regardless).
    await page.waitForTimeout(300);
    const opened = await openedUrls(app);
    expect(opened.some((u) => u.startsWith('javascript:'))).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * d. BINARY / NON-GIT ROOT — DOCUMENTED SKIP (Tier-1 covers them)      *
 * ------------------------------------------------------------------ *
 * DECISION: test.skip (documented), NOT a fake always-pass test — mirrors
 * navlinks.e2e.ts's capture-window skip convention.
 *
 * The binary-file card and the non-git-root 'no changes' state are both fully
 * proven at TIER 1 over a real temp git repo (test/git-diff.mjs: the binary
 * numstat '-\t-' classification and the non-git available:false case) and at
 * the render tier (test/diff-render.mjs: a binary FileDiff yields no rows so the
 * presenter shows the inert card). Re-driving them through a second launched
 * Electron app would add cold-spawn flake + runtime for NO additional coverage
 * the Tier-1 suite does not already give with stronger, faster assertions.
 *
 * If a future change makes the binary/non-git RENDER (not just the data) the
 * thing under test — e.g. a new interactive affordance on the card — convert
 * this skip into a real assertion: seed a binary blob (or launch on a non-git
 * dir), open Changes, and assert the inert card text + the absence of any
 * decoded bytes / editable control.
 */
test.skip('d: binary file card + non-git-root empty state (covered by the Tier-1 git-diff + diff-render suites; see comment)', () => {
  // Intentionally empty — see the block comment above for the rationale and the
  // exact assertions to add if the binary/non-git RENDER becomes the subject.
});
