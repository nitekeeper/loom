/* ============================================================
 * Loom — TIER 2 e2e: "Copy rendered" across the REAL Electron stack
 * ------------------------------------------------------------
 * This is the ONLY layer that can exercise the full "Copy rendered"
 * chain end to end against a REAL OS clipboard:
 *
 *   Viewer head button / Ctrl(⌘)+Shift+C shortcut
 *      → MarkdownCopyHandle.copyRendered (serializes the LIVE .md DOM)
 *      → serializeRenderedForCopy (allowlist rebuild, src/renderer/lib/copy-serialize.ts)
 *      → preload bridge window.loom.copyToClipboard
 *      → COPY_TO_CLIPBOARD IPC (main re-validation, src/main/ipc.ts)
 *      → Electron clipboard.write({ text, html })
 *
 * Neither the node --test/jsdom unit suite (test/copy-serialize.mjs, which
 * proves the PURE serializer in isolation) nor any Tier-1 harness can reach
 * the MAIN-process halves — the COPY_TO_CLIPBOARD IPC's shape re-validation
 * and the actual native clipboard write/read. Only a real Electron launch
 * with a real Chromium renderer + real main process can prove the WHOLE
 * chain lands cleaned, portable text/html on the OS clipboard.
 *
 * It launches the REAL built app (dist/main.cjs) with `_electron`, opens a
 * real .md via the Explorer (the REAL selection → readFile IPC → MarkdownView
 * → renderMarkdown path, NO prod test hook), then drives the REAL header
 * button and the REAL global keybinding handler.
 *
 * ZERO PRODUCTION SEAM: we read the clipboard back FROM THE MAIN PROCESS via
 * electronApp.evaluate(({ clipboard }) => ...). The main process and ipc.ts
 * import the SAME `electron` singleton (esbuild marks electron external), so
 * the clipboard the app wrote is exactly the one we read — no renderer-side
 * Clipboard API, no injected hook. We also `clipboard.clear()` the same way
 * before each action so a stale value can never make a test pass by accident.
 *
 * WHY each test FAILS FOR THE RIGHT REASON:
 *   1. If the button stopped serializing/writing, OR the serializer stopped
 *      producing semantic <h1>/<strong>/<a href>, OR the IPC dropped the
 *      payload — clipboard.readHTML() would lack those markers (fail). If the
 *      allowlist rebuild regressed and leaked the in-app code artifacts
 *      (class="ln"), data-loom-* attrs, or a javascript: href, the negative
 *      assertions catch it (fail). If text/plain regressed, readText() would
 *      miss the heading/code text (fail).
 *   2. If the copyRendered keybinding stopped mapping, OR Ctrl/⌘+Shift+C no
 *      longer reached the Viewer copy command, the post-shortcut clipboard
 *      would not match the button result (fail). And plain Ctrl+C MUST stay
 *      native selection-copy: it must NOT overwrite the rendered-HTML we put
 *      on the clipboard (if it ever triggered rendered-copy, the sentinel we
 *      seed would be gone — but here we assert the rendered HTML is still the
 *      one the button produced, so a regression that made Ctrl+C copy-rendered
 *      OR clobber the clipboard is caught).
 *   3. The transient "Copied" affordance flips the button label + shows a
 *      polite live status; if the success-feedback regressed it would not
 *      appear (fail).
 *   4. The MAIN-process COPY_TO_CLIPBOARD gate (src/main/ipc.ts) re-validates
 *      the payload: only { html:string, text:string } each within
 *      MAX_CLIPBOARD_CHARS writes; oversize or malformed shapes are a silent
 *      no-op. Driving the REAL preload bridge with off-contract payloads and
 *      asserting the clipboard stays untouched proves the cap + shape check; a
 *      well-formed payload still writes, proving the gate is not over-strict.
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

/* ---- Platform copy shortcut --------------------------------------------- */
// The copyRendered command binds 'Ctrl+Shift+C'. The renderer's combo matcher
// (src/renderer/lib/keybindings.ts eventToCombo) maps EITHER ctrlKey OR metaKey
// to the single 'Ctrl' token, so on macOS ⌘+Shift+C and elsewhere Ctrl+Shift+C
// both resolve to the SAME command. Press the platform-appropriate modifier so
// the test exercises the real per-OS keypress a user would make.
const IS_MAC = process.platform === 'darwin';
const COPY_MOD = IS_MAC ? 'Meta' : 'Control';
const COPY_SHORTCUT = `${COPY_MOD}+Shift+C`;
// Plain copy (must stay NATIVE selection-copy, never rendered-copy).
const PLAIN_COPY = `${COPY_MOD}+C`;

/* ---- Fixture content ----------------------------------------------------- */
// A .md exercising the markers the assertions key on: a heading (→ <h1>), bold
// (→ <strong>), a list (→ <ul><li>), a SAFE link (→ <a href="https://…">), and
// a fenced code block (→ a clean <pre><code> whose text is the original lines,
// with the in-app per-line <span class="ln"> + nbsp artifacts stripped). The
// safe link's NORMALIZED href is what the serializer keeps (safeExternalUrl) —
// "https://example.com/" already has the trailing slash it normalizes to.
const HEADING_TEXT = 'Copy Me Heading';
const CODE_LINE = 'const answer = 42;';
const SAFE_HREF = 'https://example.com/';
const DOC_MD = [
  `# ${HEADING_TEXT}`,
  '',
  'A paragraph with **bold words** and a [safe link](https://example.com).',
  '',
  '- first item',
  '- second item',
  '',
  '```js',
  CODE_LINE,
  '```',
  '',
].join('\n');

/** Make a fresh temp sandbox dir with the .md fixture. Returns the dir + the
 *  root-relative path the Explorer row exposes via data-row-path. */
function makeFixtureDir(): { dir: string; doc: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-e2e-copy-'));
  writeFileSync(path.join(dir, 'doc.md'), DOC_MD);
  // Tree paths are root-relative POSIX (Explorer data-row-path / sandbox).
  return { dir, doc: 'doc.md' };
}

/** The real OS clipboard, read FROM THE MAIN PROCESS (no renderer seam). */
async function readClipboard(
  app: ElectronApplication,
): Promise<{ html: string; text: string }> {
  return app.evaluate(({ clipboard }) => ({
    html: clipboard.readHTML(),
    text: clipboard.readText(),
  }));
}

/** Clear the real OS clipboard FROM THE MAIN PROCESS, then prove it cleared.
 *  Clearing first means a leftover value can never let a later assertion pass
 *  for the wrong reason. */
async function clearClipboard(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ clipboard }) => clipboard.clear());
}

/** Seed the clipboard with a known sentinel FROM THE MAIN PROCESS — used by the
 *  "plain Ctrl+C must not trigger rendered-copy" check to prove the rendered
 *  HTML is NOT what lands there. */
async function seedClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

/** Launch the built app rooted at `dir`, wait for the first window + the
 *  rendered file tree. Mirrors navlinks.e2e.ts / mermaid.e2e.ts. */
async function launch(dir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    // LOOM_ROOT is the sandbox root the launcher normally sets (bin/loom.cjs);
    // resolveRoot() honors it byte-for-byte, so the Explorer shows our fixture.
    env: { ...process.env, LOOM_ROOT: dir },
  });
  const page = await app.firstWindow();
  // Wait for the renderer to boot past the pre-boot shell: a file row proves
  // the Explorer tree is live.
  await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
  return { app, page };
}

/** Click a file row in the Explorer (by its root-relative path) and wait for
 *  the Viewer to render its markdown body. This drives the REAL selection path
 *  → readFile IPC → MarkdownView (renderMarkdown), NO prod test hook. We also
 *  wait for the head's "Copy rendered" button — it only appears for a RENDERED
 *  markdown file, so its presence confirms the right render state. */
async function openMarkdownFile(page: Page, relPath: string): Promise<void> {
  const row = page.locator(`.pane.explorer .row[data-row-path="${relPath}"]`);
  await row.click();
  await page.waitForSelector('.pane.viewer .md', { timeout: 15_000 });
  // The copy control is RENDERED-only; wait for it so we never act before the
  // markdown view (and its copy handle) is live.
  await page.waitForSelector('.pane.viewer .copy-rendered-btn', { timeout: 15_000 });
}

/** Assert a clipboard {html,text} pair carries the CLEANED, PORTABLE rendered
 *  content: semantic markers present, in-app artifacts absent, and the
 *  plaintext fallback carries the heading + code text. Shared by the button +
 *  shortcut tests so "parity" is checked against the SAME contract. */
function expectRenderedClipboard(clip: { html: string; text: string }): void {
  // --- portable HTML carries the rendered structure (formatted paste) -------
  // Electron wraps written HTML in a <html><body>/<meta> fragment (and may add
  // CF_HTML StartFragment comments); substring checks on the inner markers
  // survive that wrapping, so we assert on contains, not equality.
  expect(clip.html).toContain(`<h1>${HEADING_TEXT}</h1>`);
  expect(clip.html).toContain('<strong>bold words</strong>');
  expect(clip.html).toContain('<li>first item</li>');
  // The safe link keeps its NORMALIZED href (and nothing dangerous).
  expect(clip.html).toContain(`<a href="${SAFE_HREF}">safe link</a>`);
  // The code block reconstructs to a clean <pre><code> with the original text.
  expect(clip.html).toContain(`<pre><code>${CODE_LINE}</code></pre>`);

  // --- the in-app rendering artifacts must NOT survive the allowlist rebuild -
  // No per-line code spans, no Loom data-* hooks, no dangerous scheme anywhere.
  expect(clip.html).not.toContain('class="ln"');
  expect(clip.html).not.toContain('data-loom');
  expect(clip.html.toLowerCase()).not.toContain('javascript:');

  // --- text/plain fallback carries the readable content --------------------
  expect(clip.text).toContain(HEADING_TEXT);
  expect(clip.text).toContain(CODE_LINE);
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
 * 1. BUTTON copies the CLEANED, PORTABLE rendered html + text         *
 * ------------------------------------------------------------------ */
test('1: the "Copy rendered" button writes cleaned, portable html + text to the clipboard', async () => {
  const { dir, doc } = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openMarkdownFile(page, doc);

    // Clear FIRST so a leftover value cannot make this pass for the wrong reason.
    await clearClipboard(app);
    expect((await readClipboard(app)).html).toBe('');

    await page.locator('.pane.viewer .copy-rendered-btn').click();

    // The write is async (serialize → bridge → IPC → clipboard.write); poll the
    // MAIN-process clipboard until the rendered HTML lands.
    await expect
      .poll(async () => (await readClipboard(app)).html, { timeout: 10_000 })
      .toContain(`<h1>${HEADING_TEXT}</h1>`);

    expectRenderedClipboard(await readClipboard(app));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 2. SHORTCUT parity + plain Ctrl/⌘+C stays native selection-copy     *
 * ------------------------------------------------------------------ */
test('2: Ctrl/⌘+Shift+C copies the same rendered content as the button; plain Ctrl/⌘+C does NOT', async () => {
  const { dir, doc } = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openMarkdownFile(page, doc);

    // --- the keyboard shortcut produces the SAME rendered clipboard ----------
    await clearClipboard(app);
    expect((await readClipboard(app)).html).toBe('');

    // Focus the document body (not an editable target) so the global keydown
    // handler runs — the handler ignores editable targets by design.
    await page.locator('.pane.viewer .md').click();
    await page.keyboard.press(COPY_SHORTCUT);

    await expect
      .poll(async () => (await readClipboard(app)).html, { timeout: 10_000 })
      .toContain(`<h1>${HEADING_TEXT}</h1>`);

    const shortcutClip = await readClipboard(app);
    // Same contract as the button — full parity on the cleaned, portable pair.
    expectRenderedClipboard(shortcutClip);

    // --- plain Ctrl/⌘+C must STAY native selection-copy (never rendered-copy) -
    // Seed a sentinel, press plain Ctrl/⌘+C, and assert the rendered HTML did
    // NOT land on the clipboard. A native selection copy of the (here unselected)
    // .md either leaves the sentinel untouched or replaces it with selection
    // text — in NEITHER case does the portable rendered <h1> markup appear. If
    // a regression mapped Ctrl/⌘+C to copyRendered, the <h1> WOULD appear (fail).
    const SENTINEL = 'loom-plain-copy-sentinel';
    await seedClipboard(app, SENTINEL);
    expect((await readClipboard(app)).text).toBe(SENTINEL);

    await page.locator('.pane.viewer .md').click();
    await page.keyboard.press(PLAIN_COPY);

    // Give any (incorrect) rendered-copy a chance to land before asserting.
    await page.waitForTimeout(500);
    const afterPlain = await readClipboard(app);
    expect(afterPlain.html).not.toContain(`<h1>${HEADING_TEXT}</h1>`);
    expect(afterPlain.html).not.toContain('<pre><code>');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 3. Transient "Copied" affordance appears after a successful copy    *
 * ------------------------------------------------------------------ */
test('3: a transient "Copied" affordance appears after the copy, then reverts', async () => {
  const { dir, doc } = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    await openMarkdownFile(page, doc);
    await clearClipboard(app);

    const btn = page.locator('.pane.viewer .copy-rendered-btn');
    // Precondition: before the action the button reads "Copy rendered".
    await expect(btn).toContainText('Copy rendered');
    await expect(btn).not.toHaveClass(/\bcopied\b/);

    await btn.click();

    // On success the label flips to "Copied" (+ a .copied class) and a polite
    // live status announces it. This is the user/AT success affordance.
    //
    // The "Copied" state is TRANSIENT (~1.5s; Viewer copyTimer). Asserting the
    // three success markers as SEPARATE awaits would race that window: under CI
    // load the gap between a label assertion resolving and the next assertion
    // running can exceed the remaining window, after which the markers flip to
    // their reverted values and the later assertions burn the full expect
    // timeout and FAIL. So we poll all three markers ATOMICALLY — one snapshot
    // per poll — so they are observed at the SAME instant of the transient
    // window (label, class, and live status are guaranteed consistent).
    const status = page.locator('.pane.viewer .viewer-head [role="status"]');
    await expect
      .poll(
        async () => ({
          text: (await btn.textContent()) ?? '',
          cls: (await btn.getAttribute('class')) ?? '',
          status: (await status.textContent()) ?? '',
        }),
        { timeout: 5_000 },
      )
      .toEqual({
        text: expect.stringContaining('Copied'),
        cls: expect.stringContaining('copied'),
        status: 'Rendered content copied to clipboard',
      });

    // It is transient: after ~1.5s it reverts to "Copy rendered" (a stale
    // "Copied" never persists onto the next interaction/file).
    await expect(btn).toContainText('Copy rendered', { timeout: 5_000 });
    await expect(btn).not.toHaveClass(/\bcopied\b/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 4. MAIN-process COPY_TO_CLIPBOARD gate: length cap + bad-shape no-op *
 * ------------------------------------------------------------------ */
// src/main/ipc.ts re-validates the COPY_TO_CLIPBOARD payload (never trust the
// renderer): it accepts ONLY { html: string, text: string } with each field
// within MAX_CLIPBOARD_CHARS (5,000,000), and SILENTLY no-ops anything else.
// This is a MAIN-process branch — the jsdom unit suite (pure serializer) cannot
// reach it, and the renderer never produces such payloads from a real .md. The
// e2e layer is the only one that can drive the REAL preload bridge → IPC → main
// gate, so we exercise the cap + the bad-shape rejection HERE, directly, by
// calling window.loom.copyToClipboard with payloads the renderer would never
// build. We assert the clipboard is left UNTOUCHED (the gate dropped it).
test('4: the COPY_TO_CLIPBOARD main gate drops oversize + malformed payloads (clipboard untouched)', async () => {
  const { dir, doc } = makeFixtureDir();
  const { app, page } = await launch(dir);
  try {
    // Open a real .md so window.loom (the preload bridge) is live in the page.
    await openMarkdownFile(page, doc);

    // A sentinel proves the gate did NOT overwrite the clipboard. If the cap or
    // the shape check regressed and let a payload through, the sentinel would be
    // gone (replaced by the rejected html/text) and the assertions would fail.
    const SENTINEL_TEXT = 'loom-clipboard-gate-sentinel-text';
    const SENTINEL_HTML = '<p>loom-clipboard-gate-sentinel-html</p>';

    // Drive window.loom.copyToClipboard from the page (REAL preload bridge →
    // REAL COPY_TO_CLIPBOARD IPC → REAL main gate). The bridge types the payload
    // as { html: string; text: string }; we cast through `unknown` to feed the
    // gate the off-contract shapes the renderer would never construct, exactly
    // as a hostile/buggy caller might. Each invoke is awaited so the main gate
    // has fully run (or no-opped) before we read the clipboard back.
    type Bridge = { copyToClipboard(p: unknown): Promise<void> };
    const callCopy = (payload: unknown): Promise<void> =>
      page.evaluate(
        (p) => (window as unknown as { loom: Bridge }).loom.copyToClipboard(p),
        payload,
      );

    /* ---- 4a: OVERSIZE html (> MAX_CLIPBOARD_CHARS) is dropped --------------- */
    // Seed the sentinel, fire a > 5,000,000-char html payload, and assert the
    // clipboard still holds the sentinel (the cap silently dropped the write).
    await app.evaluate(({ clipboard }, s) => clipboard.write(s), {
      text: SENTINEL_TEXT,
      html: SENTINEL_HTML,
    });
    expect((await readClipboard(app)).text).toBe(SENTINEL_TEXT);

    const OVERSIZE = 'x'.repeat(5_000_001); // one char past the 5,000,000 cap
    await callCopy({ html: OVERSIZE, text: 'small' });
    // Give any (incorrect) write a chance to land before asserting it did NOT.
    await page.waitForTimeout(300);
    {
      const clip = await readClipboard(app);
      expect(clip.text).toBe(SENTINEL_TEXT);
      expect(clip.html).toContain('loom-clipboard-gate-sentinel-html');
      expect(clip.html).not.toContain('xxx'); // the oversize blob never landed
    }

    /* ---- 4b: OVERSIZE text (> MAX_CLIPBOARD_CHARS) is dropped --------------- */
    await callCopy({ html: '<p>ok</p>', text: 'y'.repeat(5_000_001) });
    await page.waitForTimeout(300);
    {
      const clip = await readClipboard(app);
      expect(clip.text).toBe(SENTINEL_TEXT); // unchanged — the text cap held
      expect(clip.text).not.toContain('yyy');
    }

    /* ---- 4c: MALFORMED shape (non-string fields) is a no-op ---------------- */
    // { html: 123 } / a missing field / null / a string all fail the shape
    // check (typeof html/text !== 'string') and must be silently ignored.
    for (const bad of [
      { html: 123, text: 'ok' },
      { html: '<p>ok</p>' }, // text missing
      { text: 'ok' }, // html missing
      null,
      'not-an-object',
      { html: null, text: null },
    ]) {
      await callCopy(bad);
    }
    await page.waitForTimeout(300);
    {
      const clip = await readClipboard(app);
      // The sentinel still stands: not one malformed payload reached the OS.
      expect(clip.text).toBe(SENTINEL_TEXT);
      expect(clip.html).toContain('loom-clipboard-gate-sentinel-html');
    }

    /* ---- 4d: a WELL-FORMED, in-bounds payload DOES write (gate not over-strict) */
    // Proves the negatives above fail for the RIGHT reason — the gate accepts a
    // valid { html, text } pair, so the no-ops were the cap/shape check, not a
    // broken IPC that drops everything.
    const OK_TEXT = 'loom-gate-accepts-this';
    const OK_HTML = '<p>loom-gate-accepts-this</p>';
    await callCopy({ html: OK_HTML, text: OK_TEXT });
    await expect
      .poll(async () => (await readClipboard(app)).text, { timeout: 5_000 })
      .toBe(OK_TEXT);
    expect((await readClipboard(app)).html).toContain('loom-gate-accepts-this');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
