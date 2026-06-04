/* ============================================================
 * Loom — TIER 2 e2e: mermaid diagrams across the REAL Electron stack
 * ------------------------------------------------------------
 * This is the ONLY layer that can exercise the mermaid feature's
 * runtime half. Neither the pure unit tests (renderMarkdown placeholder,
 * sanitizeSvg in jsdom — test/mermaid.mjs) nor any Node harness can reach
 * it, because:
 *
 *   - mermaid.render() needs REAL SVG layout (getBBox/getComputedTextLength)
 *     that jsdom does not implement, so the actual fence -> <svg> upgrade
 *     (lib/mermaid-render.ts, driven by the Viewer effect) can only be
 *     proven in real Chromium; and
 *   - the Law-1 guarantee that securityLevel:'strict' + the DOMPurify SVG
 *     scrub HOLD on what mermaid ACTUALLY produces from a HOSTILE diagram
 *     (not a hand-authored dirty SVG) can only be observed against the real
 *     mermaid pipeline running under the app's real CSP (script-src 'self',
 *     NO 'unsafe-eval').
 *
 * It launches the REAL built app (dist/main.cjs) with `_electron`, opens a
 * .md fixture by clicking its Explorer row (the REAL selection -> readFile
 * IPC -> MarkdownView -> mermaid effect path), and asserts on the real DOM.
 *
 * ZERO PRODUCTION SEAM: like navlinks.e2e.ts, we monkeypatch
 * shell.openExternal IN THE MAIN PROCESS at runtime via electronApp.evaluate()
 * to record every URL the app would hand the OS into globalThis.__opened. A
 * hostile mermaid `click ... "javascript:..."` directive that strict mode
 * FAILED to ignore would surface there (or as an in-app navigation / dialog),
 * so the spy is the OS-level backstop for the XSS test. No prod change.
 *
 * WHY each test FAILS FOR THE RIGHT REASON:
 *   1. RENDER: if the Viewer effect stopped upgrading placeholders, or
 *      mermaid.render broke, or the sanitizer stripped the whole <svg>, the
 *      `.mermaid-diagram svg` / `.mermaid-done` wait would TIME OUT (fail).
 *      The url-unchanged + no-page-error checks fail if rendering navigated
 *      or threw uncaught.
 *   2. XSS NEUTRALIZED: if securityLevel:'strict' regressed (htmlLabels /
 *      click directives re-enabled) OR the DOMPurify scrub were removed, a
 *      <script>/on*-handler would survive in the diagram, OR the click
 *      directive's javascript: target would reach shell.openExternal /
 *      fire a dialog — each asserted ABSENT, so any regression fails.
 *   3. DEGRADE: if a garbage diagram crashed the render loop or blanked the
 *      container instead of catching + keeping the escaped fallback, the
 *      `.mermaid-error` + fallback-text checks fail.
 *
 * Mirrors the navlinks.e2e.ts harness (temp LOOM_ROOT, _electron.launch,
 * Explorer-row open, main-process openExternal spy) so the two specs share
 * one well-understood real-stack pattern.
 * ============================================================ */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* ---- Build prerequisite ------------------------------------------------- */
// The e2e suite launches the BUILT bundle, never the TS sources. Resolve
// dist/main.cjs relative to this file (test/e2e -> project root -> dist) and
// assert it exists with a clear, actionable message so a missing build fails
// loudly here, not as an opaque electron spawn error.
//
// The project is "type": "commonjs", so Playwright transpiles this spec to
// CommonJS — `__dirname` is the directory of THIS file (test/e2e). We use it
// (not import.meta.url, which does not exist in a CJS module) to stay
// module-system-agnostic under Playwright's loader.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');

/* ---- Fixture content (agent-authored, potentially hostile) -------------- */
// 1. A plain, valid flowchart — three nodes, two edges. Renders to an <svg>.
const VALID_MERMAID = '```mermaid\ngraph TD; A-->B; B-->C\n```\n';
const VALID_MD = `# Valid diagram\n\n${VALID_MERMAID}`;

// 2. A HOSTILE diagram exercising BOTH documented attack surfaces at once:
//    (a) a node label that tries to smuggle HTML/script into the rendered SVG
//        (under strict mode htmlLabels is OFF, so the label is plain SVG text;
//        the DOMPurify scrub is the second line of defense), and
//    (b) a `click` interaction directive pointing at a javascript: URL —
//        securityLevel:'strict' MUST ignore click/call directives entirely, so
//        no handler is wired and the URL never reaches shell.openExternal.
//    A SENTINEL token in the label lets us assert the label TEXT still renders
//    (proving the diagram drew) while its markup did NOT execute.
const XSS_SENTINEL = 'LOOMXSSPROBE';
const XSS_JS_URL = 'javascript:alert(1)';
const HOSTILE_MERMAID =
  '```mermaid\n' +
  'graph TD\n' +
  `  A["${XSS_SENTINEL}<img src=x onerror=alert(2)>"] --> B[node]\n` +
  `  click A "${XSS_JS_URL}" "open"\n` +
  '```\n';
const HOSTILE_MD = `# Hostile diagram\n\n${HOSTILE_MERMAID}`;

// 3. A garbage/invalid diagram body — not valid mermaid grammar. mermaid.render
//    rejects it; the render loop must CATCH, tag `.mermaid-error`, and keep the
//    escaped code-block fallback (graceful degradation, no crash, no blank).
//    A SENTINEL in the body lets us assert the fallback TEXT is still visible.
const BAD_SENTINEL = 'LOOMBADDIAGRAM';
const INVALID_MERMAID = '```mermaid\n' + `this is not ${BAD_SENTINEL} valid {{{ >>> mermaid\n` + '```\n';
const INVALID_MD = `# Invalid diagram\n\n${INVALID_MERMAID}`;

// 4. A HEAVY multi-diagram file used ONLY by the file-switch race test. Many
//    serial mermaid.render() calls (renderMermaidIn awaits them one-by-one) make
//    the render loop demonstrably in-flight when we switch away, so the
//    cancellation guard (isCancelled() + el.isConnected) is actually exercised
//    rather than racing to completion before the switch. Each is a small but
//    real flowchart so every one needs a real layout pass.
const HEAVY_COUNT = 24;
const HEAVY_MERMAID = Array.from(
  { length: HEAVY_COUNT },
  (_unused, i) => '```mermaid\n' + `graph TD; A${i}-->B${i}; B${i}-->C${i}; C${i}-->D${i}\n` + '```\n',
).join('\n');
const HEAVY_MD = `# Heavy diagram file\n\n${HEAVY_MERMAID}`;

// 5. A SECOND, distinct valid file the race test switches TO. Its single diagram
//    carries a unique node label SENTINEL so we can assert the diagram that ends
//    up under the second file's container is THE SECOND FILE'S — never a stale
//    SVG carried over from the heavy file's in-flight render.
const OTHER_SENTINEL = 'LOOMOTHERFILE';
const OTHER_MERMAID = '```mermaid\n' + `graph LR; ${OTHER_SENTINEL}-->done\n` + '```\n';
const OTHER_MD = `# Other diagram\n\n${OTHER_MERMAID}`;

// 6. NON-flowchart diagram types, one fixture each. Spec item 7 asks us to VERIFY
//    common types render under the locked CSP (script-src 'self', NO
//    'unsafe-eval') and DOCUMENT which degrade. mermaid 11 inlines every
//    diagram-type module into the renderer IIFE (esbuild — no runtime import(),
//    no eval/new Function), so each type SHOULD render at file:// with no
//    module-loader fetch and no CSP eval violation. These lock that guarantee for
//    paths beyond the flowchart the other tests prove: a future mermaid bump that
//    reintroduced eval in, say, the sequence or pie layout would fail here (the
//    diagram would throw under CSP and land .mermaid-error instead of
//    .mermaid-done). Each renders to a real <svg> needing real layout, so this is
//    e2e-only. Keep the list small (sequence + pie) — two extra real-layout types
//    are enough to prove the non-flowchart code paths are eval-free under CSP
//    without ballooning the suite runtime.
const TYPE_FIXTURES: ReadonlyArray<{ name: string; file: string; body: string }> = [
  {
    name: 'sequenceDiagram',
    file: 'type-sequence.md',
    body: 'sequenceDiagram\n  Alice->>Bob: hello\n  Bob-->>Alice: hi',
  },
  {
    name: 'pie',
    file: 'type-pie.md',
    body: 'pie title Pets\n  "Dogs" : 3\n  "Cats" : 2',
  },
];

/** Make a fresh temp sandbox dir with the .md fixtures. Returns the dir + the
 *  root-relative paths the Explorer rows expose via data-row-path. */
function makeFixtureDir(): {
  dir: string;
  valid: string;
  hostile: string;
  invalid: string;
  heavy: string;
  other: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-mermaid-'));
  writeFileSync(path.join(dir, 'valid.md'), VALID_MD);
  writeFileSync(path.join(dir, 'hostile.md'), HOSTILE_MD);
  writeFileSync(path.join(dir, 'invalid.md'), INVALID_MD);
  writeFileSync(path.join(dir, 'heavy.md'), HEAVY_MD);
  writeFileSync(path.join(dir, 'other.md'), OTHER_MD);
  for (const t of TYPE_FIXTURES) {
    writeFileSync(path.join(dir, t.file), `# ${t.name}\n\n` + '```mermaid\n' + t.body + '\n```\n');
  }
  // Tree paths are root-relative POSIX (Explorer data-row-path / sandbox).
  return {
    dir,
    valid: 'valid.md',
    hostile: 'hostile.md',
    invalid: 'invalid.md',
    heavy: 'heavy.md',
    other: 'other.md',
  };
}

/** Install the main-process shell.openExternal spy. Records every URL the app
 *  hands to the OS into globalThis.__opened. NO prod seam: this monkeypatch
 *  lives only in the test, applied at runtime before any interaction. Identical
 *  to the navlinks harness so the two specs observe the OS surface the same way. */
async function installOpenExternalSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[]; __origOpen?: unknown };
    g.__opened = [];
    g.__origOpen = shell.openExternal;
    shell.openExternal = (url: string): Promise<void> => {
      g.__opened.push(url);
      return Promise.resolve();
    };
  });
}

/** Read back the URLs recorded by the spy (in the MAIN process). */
async function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __opened?: string[] };
    return g.__opened ?? [];
  });
}

/** Launch the built app rooted at `dir`, wait for the first window + the
 *  rendered file tree, install the openExternal spy, AND start collecting any
 *  uncaught page errors / native dialogs so the XSS test can assert none fired. */
async function launch(
  dir: string,
): Promise<{ app: ElectronApplication; page: Page; pageErrors: Error[]; dialogs: string[] }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    // LOOM_ROOT is the sandbox root the launcher normally sets (bin/loom.cjs);
    // resolveRoot() honors it byte-for-byte, so the renderer's Explorer shows
    // exactly our three fixtures.
    env: { ...process.env, LOOM_ROOT: dir },
  });
  const page = await app.firstWindow();

  // Collect uncaught renderer errors. A clean render must produce none; an XSS
  // payload that crashed (or a render exception) would surface here.
  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  // Collect (and dismiss) any native dialog — alert/confirm/prompt. A surviving
  // `onerror=alert(...)` or a fired click directive would raise one; under our
  // neutralization NONE may appear. Auto-dismiss so a stray dialog can never
  // wedge the run, then assert the collected list is empty in the XSS test.
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(`${d.type()}:${d.message()}`);
    void d.dismiss().catch(() => {});
  });

  // Wait for the renderer to boot past the pre-boot shell: the Explorer tree
  // mounts once the initial state arrives. A file row proves the tree is live.
  await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
  await installOpenExternalSpy(app);
  return { app, page, pageErrors, dialogs };
}

/** Click a file row in the Explorer (by its root-relative path) and wait for
 *  the Viewer to render its markdown body (the `.md` container). This drives
 *  the REAL selection path → readFile IPC → MarkdownView → mermaid effect, with
 *  NO prod test hook. */
async function openMarkdownFile(page: Page, relPath: string): Promise<void> {
  const row = page.locator(`.pane.explorer .row[data-row-path="${relPath}"]`);
  await row.click();
  await page.waitForSelector('.pane.viewer .md', { timeout: 15_000 });
}

/* Guard: a missing build is a setup error, not a test failure. Fail every test
 * with one clear message rather than letting electron.launch throw opaquely. */
test.beforeAll(() => {
  expect(
    existsSync(MAIN_ENTRY),
    `dist/main.cjs not found at ${MAIN_ENTRY}. Run \`npm run build\` before \`npm run test:e2e\`.`,
  ).toBe(true);
});

/* ------------------------------------------------------------------ *
 * 1. RENDER: a valid mermaid fence becomes a real <svg> diagram      *
 * ------------------------------------------------------------------ */
test('1: a valid mermaid fence renders to an <svg> diagram (real Chromium), no nav, no page error', async () => {
  const { dir, valid } = makeFixtureDir();
  const { app, page, pageErrors } = await launch(dir);
  try {
    const urlBefore = page.url();

    await openMarkdownFile(page, valid);

    // The placeholder is present immediately; the Viewer effect upgrades it.
    const diagram = page.locator('.pane.viewer .md .mermaid-diagram');
    await expect(diagram).toHaveCount(1);

    // The upgrade is proven by BOTH the success class AND a real <svg> child —
    // either alone is weaker (a class with no svg, or an svg the sanitizer
    // emptied, would be a false pass). mermaid.render needs real SVG layout, so
    // this can only succeed in real Chromium.
    // COLD-PATH timeout (30s, not 20s): this is the FIRST diagram in a fresh app
    // instance, so it pays the one-time lazy-chunk cost the pre-split suite never
    // measured — the Viewer dynamic-imports the loader, ensureMermaid() injects the
    // ~7MB dist/mermaid.js classic script over file://, the browser parses/evaluates
    // that whole IIFE, THEN mermaid.initialize + render + a real SVG layout run. 30s
    // absorbs that one-time parse on slower/contended CI runners, matching the 30s
    // the harness already allows for the initial tree mount. No assertion weakened.
    await page.waitForSelector('.pane.viewer .md .mermaid-diagram.mermaid-done', { timeout: 30_000 });
    const svg = page.locator('.pane.viewer .md .mermaid-diagram svg');
    await expect(svg).toHaveCount(1);
    // A rendered flowchart draws path/edge geometry — assert non-empty SVG body
    // so an empty <svg></svg> (sanitizer over-stripping) fails rather than passes.
    await expect(svg.locator('path').first()).toBeAttached();

    // The window NEVER navigated away from its local bundle while rendering.
    expect(page.url()).toBe(urlBefore);
    expect(page.url().startsWith('file://')).toBe(true);
    // Rendering produced no uncaught renderer error.
    expect(pageErrors, `unexpected page errors: ${pageErrors.map((e) => e.message).join(' | ')}`).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 2. XSS NEUTRALIZED: hostile label + javascript: click directive    *
 *    are rendered inert — proves strict mode + DOMPurify hold in real *
 *    Chromium against what mermaid ACTUALLY produces.                 *
 * ------------------------------------------------------------------ */
test('2: a hostile mermaid diagram is neutralized — no script, no on* handler, no javascript: open, no dialog', async () => {
  const { dir, hostile } = makeFixtureDir();
  const { app, page, pageErrors, dialogs } = await launch(dir);
  try {
    const urlBefore = page.url();

    await openMarkdownFile(page, hostile);

    const diagram = page.locator('.pane.viewer .md .mermaid-diagram');
    await expect(diagram).toHaveCount(1);

    // The diagram must resolve to a terminal state (rendered OR errored) before
    // we assert — otherwise an assertion could race the async upgrade and pass
    // on the un-upgraded placeholder. We wait for EITHER class, then proceed.
    // (A valid-but-hostile diagram should render: strict mode neutralizes the
    // payload WITHOUT failing the layout.)
    // COLD-PATH timeout (30s, not 20s): a fresh app instance pays the one-time
    // lazy-chunk cost (dynamic-import the loader -> inject + parse the ~7MB
    // dist/mermaid.js IIFE over file:// -> initialize + render + layout) before this
    // terminal class can appear. 30s absorbs that on slower/contended CI runners,
    // matching the 30s the harness allows for the initial tree mount. No assertion
    // weakened — only the wait window widened.
    await page.waitForSelector(
      '.pane.viewer .md .mermaid-diagram.mermaid-done, .pane.viewer .md .mermaid-diagram.mermaid-error',
      { timeout: 30_000 },
    );

    // (POSITIVE) The hostile diagram is VALID mermaid (a flowchart with a labeled
    // node + a click directive), so strict mode renders it: assert the .mermaid-done
    // terminal state AND that the label's SENTINEL token is present as rendered SVG
    // TEXT. This proves the diagram actually DREW (not silently errored) and that
    // strict mode placed the label as inert plain text — the positive half of the
    // claim the negative assertions below cannot make on their own.
    const done = page.locator('.pane.viewer .md .mermaid-diagram.mermaid-done');
    await expect(done).toHaveCount(1);
    await expect(done).toContainText(XSS_SENTINEL);

    // (a) NO live <script> anywhere in the diagram subtree. mermaid strict mode
    //     emits SVG text labels (no htmlLabels), and DOMPurify FORBID_TAGS
    //     removes <script>/<foreignObject> — so none may exist.
    await expect(page.locator('.pane.viewer .md .mermaid-diagram script')).toHaveCount(0);
    await expect(page.locator('.pane.viewer .md .mermaid-diagram foreignObject')).toHaveCount(0);

    // (b) NO on*-handler attribute survives anywhere in the diagram. We scan the
    //     whole subtree's attributes in the real DOM (not a substring of HTML,
    //     which could false-match inside text) and assert zero on* attributes.
    const onHandlerCount = await page.evaluate(() => {
      const root = document.querySelector('.pane.viewer .md .mermaid-diagram');
      if (!root) return -1; // sentinel: container vanished -> fail loudly below
      let n = 0;
      for (const el of Array.from(root.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          if (/^on/i.test(attr.name)) n++;
        }
      }
      return n;
    });
    expect(onHandlerCount).toBe(0);

    // (c) The hostile <img onerror> markup must NOT have become a live element:
    //     under strict mode the label is plain SVG text, so no <img> exists in
    //     the diagram. (DOMPurify would strip it too — defense in depth.)
    await expect(page.locator('.pane.viewer .md .mermaid-diagram img')).toHaveCount(0);

    // Give any (incorrect) async click-directive activation a beat to fire, then
    // assert the OS-level + UI-level backstops are clean:
    await page.waitForTimeout(500);

    // (d) The javascript: click-directive target NEVER reached shell.openExternal.
    //     securityLevel:'strict' ignores click/call directives, so no handler is
    //     wired; even if one were, the URL must not hit the OS. Assert the spy is
    //     free of the payload AND of any javascript: scheme at all.
    const opened = await openedUrls(app);
    expect(opened).not.toContain(XSS_JS_URL);
    expect(opened.some((u) => /^javascript:/i.test(u))).toBe(false);

    // (e) NO native dialog (alert/confirm/prompt) fired — an executed onerror or
    //     click handler would have raised one.
    expect(dialogs, `unexpected dialogs: ${dialogs.join(' | ')}`).toEqual([]);

    // (f) No uncaught renderer error, and the app never navigated in-app.
    expect(pageErrors, `unexpected page errors: ${pageErrors.map((e) => e.message).join(' | ')}`).toEqual([]);
    expect(page.url()).toBe(urlBefore);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 3. DEGRADE: an invalid diagram errors gracefully, fallback remains *
 * ------------------------------------------------------------------ */
test('3: an invalid mermaid body degrades gracefully — .mermaid-error + the escaped code fallback stays visible', async () => {
  const { dir, invalid } = makeFixtureDir();
  const { app, page, pageErrors } = await launch(dir);
  try {
    await openMarkdownFile(page, invalid);

    const diagram = page.locator('.pane.viewer .md .mermaid-diagram');
    await expect(diagram).toHaveCount(1);

    // mermaid.render rejects the garbage body; the loop CATCHES and tags the
    // node .mermaid-error (never .mermaid-done). If it instead crashed the loop
    // or left the placeholder un-upgraded, this wait times out (fail).
    // COLD-PATH timeout (30s, not 20s): even the error path must FIRST inject +
    // parse the ~7MB dist/mermaid.js IIFE over file:// before mermaid.render can
    // reject the garbage body and the loop can tag .mermaid-error — this fresh app
    // instance pays the same one-time lazy-chunk cost as the render tests. 30s
    // absorbs it on slower/contended CI runners. No assertion weakened.
    await page.waitForSelector('.pane.viewer .md .mermaid-diagram.mermaid-error', { timeout: 30_000 });
    await expect(page.locator('.pane.viewer .md .mermaid-diagram.mermaid-done')).toHaveCount(0);

    // The escaped code-block fallback must STILL be on screen (graceful
    // degradation — not a blank container). Assert both that the fallback <pre>
    // exists AND that the body's sentinel text is visible to the user.
    const fallback = page.locator('.pane.viewer .md .mermaid-diagram pre.md-code');
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText(BAD_SENTINEL);

    // Graceful means no uncaught renderer error escaped the catch.
    expect(pageErrors, `unexpected page errors: ${pageErrors.map((e) => e.message).join(' | ')}`).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 4. FILE-SWITCH RACE / CANCELLATION: switching files mid-render must *
 *    NOT write a stale SVG from the first file into the second file's *
 *    DOM. Exercises the Viewer cleanup (`cancelled = true`) +         *
 *    renderMermaidIn's isCancelled()/el.isConnected guards — the one  *
 *    path no unit test can reach and that, if regressed, would leave  *
 *    EVERY existing test green. (Spec coverage dimension:             *
 *    "file-switch race".)                                             *
 * ------------------------------------------------------------------ */
test('4: switching files mid-render never leaks a stale diagram into the new file (cancellation holds)', async () => {
  const { dir, heavy, other } = makeFixtureDir();
  const { app, page, pageErrors } = await launch(dir);
  try {
    const urlBefore = page.url();

    // Open the HEAVY file (24 serial renders). Its placeholders are present
    // immediately; the Viewer effect begins upgrading them one-by-one. We do NOT
    // wait for .mermaid-done — we want the loop demonstrably in-flight.
    await openMarkdownFile(page, heavy);
    await expect(page.locator('.pane.viewer .md .mermaid-diagram')).toHaveCount(HEAVY_COUNT);

    // Immediately switch to the OTHER file BEFORE the heavy file finishes. The
    // React re-render replaces the .md subtree (so the heavy nodes detach) and
    // the effect cleanup flips `cancelled`, so the in-flight renderMermaidIn must
    // bail at its next isCancelled()/isConnected check and never write into the
    // (now-stale) heavy nodes nor into the freshly-mounted other-file nodes.
    await openMarkdownFile(page, other);

    // The SECOND file owns exactly ONE diagram, and it must render to completion
    // (the new file's own effect run is NOT cancelled). Waiting on its terminal
    // state proves the switch did not wedge rendering.
    // COLD-PATH timeout (30s, not 20s): this fresh app instance pays the one-time
    // lazy-chunk cost during the HEAVY file open (inject + parse the ~7MB
    // dist/mermaid.js IIFE over file://), and this wait spans that cold load plus the
    // heavy-render cancellation and the other-file render. 30s absorbs the one-time
    // chunk parse on slower/contended CI runners. No assertion weakened.
    await page.waitForSelector('.pane.viewer .md .mermaid-diagram.mermaid-done', { timeout: 30_000 });
    const diagrams = page.locator('.pane.viewer .md .mermaid-diagram');
    await expect(diagrams).toHaveCount(1);

    // (a) The diagram now on screen is THE SECOND FILE'S — its unique label
    //     SENTINEL is present. A stale heavy-file SVG leaking in would NOT carry
    //     this token (and the count assertion above already forbids 24 nodes).
    const done = page.locator('.pane.viewer .md .mermaid-diagram.mermaid-done');
    await expect(done).toHaveCount(1);
    await expect(done).toContainText(OTHER_SENTINEL);

    // (b) Give any (incorrectly un-cancelled) heavy-file render a generous beat to
    //     try to write, then re-assert the container still holds exactly the one
    //     other-file diagram — the heavy file's HEAVY_COUNT diagrams (e.g. node
    //     labels A0/B0/…) never appear. If the cancel/isConnected guard regressed,
    //     a stale SVG would surface here as extra nodes or foreign label text.
    await page.waitForTimeout(800);
    await expect(diagrams).toHaveCount(1);
    await expect(done).toContainText(OTHER_SENTINEL);
    // No heavy-file label leaked into the live container.
    await expect(page.locator('.pane.viewer .md .mermaid-diagram')).not.toContainText('A0');

    // (c) The cancellation path is "no-throw": bailing out of the loop must not
    //     surface an uncaught renderer error, and the app never navigated.
    expect(pageErrors, `unexpected page errors: ${pageErrors.map((e) => e.message).join(' | ')}`).toEqual([]);
    expect(page.url()).toBe(urlBefore);
    expect(page.url().startsWith('file://')).toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 5. NON-FLOWCHART TYPES UNDER CSP: each common type renders to a     *
 *    real <svg> under script-src 'self' WITHOUT 'unsafe-eval' — i.e.  *
 *    none hard-degrades for want of eval. Proves the non-flowchart    *
 *    diagram-type code paths (bundled into the IIFE, no runtime       *
 *    import(), no eval) under the LOCKED CSP. (Spec item 7.)          *
 * ------------------------------------------------------------------ */
for (const t of TYPE_FIXTURES) {
  test(`5: a ${t.name} diagram renders under CSP (script-src 'self', no unsafe-eval) — no eval-degradation`, async () => {
    const { dir } = makeFixtureDir();
    const { app, page, pageErrors } = await launch(dir);
    try {
      const urlBefore = page.url();

      await openMarkdownFile(page, t.file);

      const diagram = page.locator('.pane.viewer .md .mermaid-diagram');
      await expect(diagram).toHaveCount(1);

      // It must reach .mermaid-done (a real layout succeeded), NOT .mermaid-error.
      // If this type secretly needed eval/Function, CSP would throw it into the
      // catch and it would land .mermaid-error — so .mermaid-done is the precise
      // proof of "renders under the locked CSP without unsafe-eval".
      // COLD-PATH timeout (30s, not 20s): each type runs in its OWN fresh app
      // instance, so every iteration pays the one-time lazy-chunk cost (inject +
      // parse the ~7MB dist/mermaid.js IIFE over file://) before its first diagram
      // can render. 30s absorbs that on slower/contended CI runners. No assertion
      // weakened.
      await page.waitForSelector('.pane.viewer .md .mermaid-diagram.mermaid-done', { timeout: 30_000 });
      await expect(page.locator('.pane.viewer .md .mermaid-diagram.mermaid-error')).toHaveCount(0);

      // A real, non-empty <svg> body — guards against a class-only false pass or a
      // sanitizer that emptied the diagram. (We assert the <svg> root is present
      // and has at least one child element drawn from the type's layout.)
      const svg = page.locator('.pane.viewer .md .mermaid-diagram svg');
      await expect(svg).toHaveCount(1);
      const svgChildCount = await svg.evaluate((el) => el.childElementCount);
      expect(svgChildCount).toBeGreaterThan(0);

      // No CSP eval-violation surfaces as an uncaught renderer error; no nav.
      expect(pageErrors, `unexpected page errors for ${t.name}: ${pageErrors.map((e) => e.message).join(' | ')}`).toEqual([]);
      expect(page.url()).toBe(urlBefore);
      expect(page.url().startsWith('file://')).toBe(true);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
