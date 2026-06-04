/* ============================================================
 * Loom — mermaid placeholder + SVG-sanitize suite (node --test)
 * ------------------------------------------------------------
 * TIER-1 coverage for the Viewer's mermaid feature, split in two:
 *
 *  (A) markdown PLACEHOLDER — the pure, shared renderMarkdown turns a
 *      ```mermaid fence into an inert <div class="mermaid-diagram"> that
 *      carries the EXACT source inside an escaped, hidden <pre
 *      class="mermaid-src"> plus the normal escaped code-block fallback.
 *      Law-1: the source is escaped text only, never live markup.
 *
 *  (B) sanitizeSvg — DOMPurify scrub of the SVG mermaid would produce.
 *      We feed it hostile SVG (script / foreignObject>script / on*-handler
 *      / javascript: xlink:href) and assert none survive, and a benign SVG
 *      (path + <style>) is preserved. DOMPurify needs a DOM, so we pass a
 *      jsdom window (sanitizeSvg(svg, win)) — the SAME code the browser runs.
 *
 * NOTE: jsdom CANNOT run mermaid.render — it needs real SVG layout/getBBox,
 * which jsdom does not implement. So this file does NOT attempt a full
 * mermaid render in Node; the end-to-end render of each diagram type (and
 * the CSP-no-eval behavior) is proven in the Playwright e2e suite, not here.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TESTKIT = path.join(root, 'dist', 'testkit.cjs');

let _kit = null;
async function kit() {
  if (_kit) return _kit;
  if (!existsSync(TESTKIT)) {
    throw new Error(`dist/testkit.cjs not found at ${TESTKIT} — run \`npm run build\` first.`);
  }
  _kit = await import(TESTKIT);
  return _kit;
}

/* Decode the HTML entities inside .mermaid-src back to the original text the
   browser's .textContent would yield. We use a jsdom document to decode exactly
   like the browser, then read textContent — proving the round-trip the
   mermaid-render path relies on (escaped-on-write, decoded-on-read). */
function decodeMermaidSrc(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="r">${html}</div></body>`);
  const src = dom.window.document.querySelector('.mermaid-src');
  return src ? src.textContent : null;
}

/* ---------- (A) markdown placeholder ---------- */

test('MERMAID placeholder: a ```mermaid fence renders the diagram wrapper + exact source', async () => {
  const { renderMarkdown } = await kit();
  const body = 'graph TD; A-->B';
  const html = renderMarkdown('```mermaid\n' + body + '\n```');
  // The inert wrapper + hidden source node are present.
  assert.match(html, /<div class="mermaid-diagram">/, 'emits the .mermaid-diagram wrapper');
  assert.match(html, /<pre class="mermaid-src" hidden>/, 'emits the hidden .mermaid-src node');
  // The fallback escaped code block is present (data-lang="mermaid").
  assert.match(html, /<pre class="md-code" data-lang="mermaid">/, 'keeps an escaped code-block fallback');
  // The decoded source EQUALS markdown-it's fence content byte-for-byte. NOTE:
  // markdown-it's fence token.content INCLUDES the fence body's trailing
  // newline, so the placeholder preserves "graph TD; A-->B\n" exactly — which is
  // what mermaid.render receives (a trailing newline is inert for mermaid). We
  // assert the EXACT content, not a trimmed variant, so the round-trip is
  // proven faithful rather than approximate. (One subtlety: markdown-it
  // normalizes CRLF -> LF in the fence body BEFORE the fence rule sees
  // token.content, so the round-trip is exact MODULO newline normalization, not
  // for raw \r\n — see the dedicated CRLF test below.)
  assert.equal(decodeMermaidSrc(html), body + '\n', 'decoded .mermaid-src is the exact fence content');
});

test('MERMAID placeholder: a NON-mermaid fence is unchanged (plain md-code, no diagram wrapper)', async () => {
  const { renderMarkdown } = await kit();
  const html = renderMarkdown('```js\nconst x = 1;\n```');
  assert.doesNotMatch(html, /mermaid-diagram/, 'no diagram wrapper for a js fence');
  assert.doesNotMatch(html, /mermaid-src/, 'no hidden source node for a js fence');
  assert.match(html, /<pre class="md-code"/, 'still a normal code block');
});

test('MERMAID placeholder is case-insensitive on the info string (Mermaid / MERMAID)', async () => {
  const { renderMarkdown } = await kit();
  for (const tag of ['Mermaid', 'MERMAID']) {
    const html = renderMarkdown('```' + tag + '\ngraph TD; A-->B\n```');
    assert.match(html, /mermaid-diagram/, `${tag} fence becomes a diagram`);
  }
});

test('MERMAID placeholder Law-1: hostile diagram source is ESCAPED inside .mermaid-src (never live markup)', async () => {
  const { renderMarkdown } = await kit();
  const hostile = '<script>alert(1)</script>\n"><img src=x onerror=alert(1)>';
  const html = renderMarkdown('```mermaid\n' + hostile + '\n```');
  // The raw, LIVE markup must NOT appear anywhere in the emitted HTML.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'no live <script> tag');
  assert.doesNotMatch(html, /<img\b[^>]*\bonerror\s*=/i, 'no live <img onerror=> element');
  // The escaped entities ARE present (the source is preserved as inert text).
  assert.match(html, /&lt;script&gt;/, 'the <script> is escaped to entities');
  assert.match(html, /&lt;img/i, 'the <img> is escaped to entities');
  // And the .mermaid-src decodes back to the EXACT hostile source (so mermaid
  // would receive the literal text, not interpreted markup). markdown-it's fence
  // content includes the body's trailing newline (see the placeholder test
  // above), so we compare against the source + '\n'.
  assert.equal(decodeMermaidSrc(html), hostile + '\n', 'decoded source is the exact (inert) text');
});

test('MERMAID placeholder: markdown-it normalizes CRLF -> LF in the fence body before the placeholder', async () => {
  const { renderMarkdown } = await kit();
  // markdown-it strips the \r of a CRLF in the fence body before the fence rule
  // sees token.content. So 'line1\r\nline2' decodes to 'line1\nline2\n' (the \r
  // is gone, plus the trailing newline markdown-it appends to fence content).
  // This is benign — mermaid treats \r\n and \n identically — and is markdown-it
  // preprocessing, NOT the placeholder. escapeHtml still neutralizes every byte,
  // so the "byte-for-byte exact source" claim holds modulo this normalization.
  const html = renderMarkdown('```mermaid\nline1\r\nline2\n```');
  assert.equal(decodeMermaidSrc(html), 'line1\nline2\n', 'CRLF is normalized to LF in the decoded source');
});

/* ---------- (B) sanitizeSvg ---------- */

/* A fresh jsdom window per test keeps DOMPurify instances isolated. */
function freshWindow() {
  return new JSDOM('<!doctype html><body></body>').window;
}

test('SANITIZE-SVG: strips <script>, on*-handlers, foreignObject>script, and javascript: xlink:href', async () => {
  const { sanitizeSvg } = await kit();
  const win = freshWindow();
  const dirty =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
    '<script>alert(1)</script>' +
    '<foreignObject><script>alert(2)</script></foreignObject>' +
    '<g onload="alert(3)"><rect width="10" height="10"/></g>' +
    '<a xlink:href="javascript:alert(4)"><text>x</text></a>' +
    '</svg>';
  const clean = sanitizeSvg(dirty, win);
  assert.doesNotMatch(clean, /<script/i, 'no <script> survives');
  assert.doesNotMatch(clean, /onload/i, 'no on*-handler survives');
  assert.doesNotMatch(clean, /javascript:/i, 'no javascript: URI survives');
  assert.doesNotMatch(clean, /<foreignObject/i, 'foreignObject is forbidden + removed');
});

test('SANITIZE-SVG: a benign SVG (path + g + style) survives the scrub', async () => {
  const { sanitizeSvg } = await kit();
  const win = freshWindow();
  const benign =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<g><path d="M10 10 L90 90" stroke="white"/></g>' +
    '<style>.node{fill:#fff}</style>' +
    '</svg>';
  const clean = sanitizeSvg(benign, win);
  assert.match(clean, /<svg/i, 'the <svg> root survives');
  assert.match(clean, /<path/i, 'the <path> shape survives');
  assert.match(clean, /<style/i, 'the in-svg <style> survives (allowed under style-src unsafe-inline)');
  assert.match(clean, /M10 10 L90 90/, 'path geometry is preserved');
});

test('SANITIZE-SVG: mermaid arrowheads survive — marker-end="url(#id)" + <marker> are preserved', async () => {
  const { sanitizeSvg } = await kit();
  const win = freshWindow();
  // This is how mermaid actually draws arrowheads: a <defs><marker> referenced
  // via a marker-end="url(#id)" attribute (NOT a <use href>). Both must survive
  // so real diagrams keep their arrowheads after the scrub.
  const arrows =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<defs><marker id="arrow"><path d="M0 0 L4 2 L0 4"/></marker></defs>' +
    '<path d="M0 0 L40 0" marker-end="url(#arrow)"/>' +
    '</svg>';
  const clean = sanitizeSvg(arrows, win);
  assert.match(clean, /<marker[^>]*\bid="arrow"/, 'the <marker> definition survives');
  assert.match(clean, /marker-end="url\(#arrow\)"/, 'the marker-end url(#id) reference survives');
});

test('SANITIZE-SVG: a genuine same-document #fragment <a xlink:href> is KEPT; a javascript: one is dropped', async () => {
  const { sanitizeSvg } = await kit();
  const win = freshWindow();
  // A real in-document fragment hyperlink is allowed by the uponSanitizeAttribute
  // hook (value starts with '#'); a javascript: one is dropped (its href is
  // removed while the inert <a> wrapper / text may remain). NOTE: DOMPurify's svg
  // profile drops <use> entirely by default (an external-content vector), so the
  // fragment-keep guarantee is demonstrated on <a>, the element that survives.
  const ok =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
    '<a xlink:href="#node1"><text>x</text></a></svg>';
  assert.match(sanitizeSvg(ok, win), /xlink:href="#node1"/, 'a #fragment href is preserved');

  const evil =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
    '<a xlink:href="javascript:alert(1)"><text>x</text></a></svg>';
  const cleanEvil = sanitizeSvg(evil, win);
  assert.doesNotMatch(cleanEvil, /javascript:/i, 'a javascript: href is dropped by the hook');
});

test('SANITIZE-SVG: the renderer trust flag data-loom-ext is STRIPPED from a hostile diagram anchor', async () => {
  const { sanitizeSvg } = await kit();
  const win = freshWindow();
  // The global anchor-guard opens a link externally ONLY when
  // anchor.dataset.loomExt === '1'. DOMPurify's svg profile allows data-* by
  // default, so a HOSTILE diagram emitting <a data-loom-ext="1" …> would survive
  // WITH the trust flag intact unless we FORBID it. mermaid never emits
  // data-loom-* legitimately, so it MUST be stripped — making the scrub
  // self-sufficient rather than leaning on main's openExternal re-validation.
  const hostile =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
    '<a data-loom-ext="1" data-loom-link="x" href="#node1"><text>x</text></a></svg>';
  const clean = sanitizeSvg(hostile, win);
  assert.doesNotMatch(clean, /data-loom-ext/i, 'data-loom-ext trust flag does NOT survive the scrub');
  assert.doesNotMatch(clean, /data-loom-link/i, 'data-loom-link does NOT survive the scrub');
  // The legitimate #fragment href and the anchor itself are still kept — only the
  // Loom-internal trust attributes are removed.
  assert.match(clean, /href="#node1"/, 'a legitimate #fragment href is still preserved');
});

test('SANITIZE-SVG: hostile CSS inside a kept <style> SURVIVES verbatim — containment is CSP, not this scrub', async () => {
  const { sanitizeSvg } = await kit();
  const win = freshWindow();
  // HONESTY TEST. Under USE_PROFILES:{svg} + ADD_TAGS:['style'], DOMPurify keeps
  // the <style> element but passes its CSS TEXT through UNCHANGED — it sanitizes
  // structure, not CSS declarations. So @import / url(javascript:) / expression()
  // SURVIVE here. That is NOT a vuln in Loom: the real containment for CSS-borne
  // vectors is the app CSP (default-src 'none'; style-src 'self' 'unsafe-inline'
  // blocks remote @import; img-src 'self' data: blocks remote url() beacons;
  // connect-src 'none'; script-src 'self' has NO 'unsafe-eval' so expression() is
  // dead; Chromium does not execute javascript: in url()). That CSP boundary is
  // proven in the e2e/CSP layer, not here. This test PINS the true behavior so a
  // reader is not misled into believing this scrub covers CSS.
  const dirty =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    '<style>@import url("http://evil.test/x.css");' +
    '.a{background:url(javascript:alert(1))}' +
    '.b{width:expression(alert(1))}</style>' +
    '<path d="M0 0 L1 1"/></svg>';
  const clean = sanitizeSvg(dirty, win);
  // The <style> element is kept...
  assert.match(clean, /<style/i, 'the in-svg <style> element is kept');
  // ...and its dangerous CSS body is NOT scrubbed (contained by CSP at runtime).
  assert.match(clean, /@import/i, 'CSS @import survives the scrub (CSP blocks it at runtime)');
  assert.match(clean, /expression\(/i, 'CSS expression() survives the scrub (no unsafe-eval kills it)');
  assert.match(clean, /url\(javascript:/i, 'CSS url(javascript:) survives the scrub (Chromium never executes it)');
  // But genuine structural script-smuggling is still collapsed.
  assert.doesNotMatch(clean, /<script/i, 'no <script> element survives even via a <style> sibling');
});

/* ---------- (C) svgHasRenderableContent predicate ---------- */

/* The renderer (lib/mermaid-render.ts) gates the innerHTML write on this pure,
   DOMPurify-free predicate: after sanitizeSvg, if the scrubbed SVG has NO
   renderable content (empty, parse-failed, or stripped down to a bare <svg>),
   the renderer must NOT inject an empty SVG — it keeps the escaped code-block
   fallback and tags .mermaid-error (the same path as a render throw). jsdom
   cannot run mermaid.render, but it CAN exercise this predicate directly via a
   jsdom window's DOMParser — proving the "has-renderable-content" decision at
   the sanitize/inspection boundary. */

test('SVG-RENDERABLE: an empty <svg></svg> is NOT renderable (renderer would fall back)', async () => {
  const { svgHasRenderableContent } = await kit();
  const win = freshWindow();
  assert.equal(
    svgHasRenderableContent('<svg xmlns="http://www.w3.org/2000/svg"></svg>', win),
    false,
    'a bare <svg> with no child elements has nothing to draw',
  );
  // An empty string is likewise not renderable (e.g. sanitizeSvg returned '').
  assert.equal(svgHasRenderableContent('', win), false, 'an empty string is not renderable');
});

test('SVG-RENDERABLE: an <svg> whose only content was a stripped <script> is NOT renderable', async () => {
  const { sanitizeSvg, svgHasRenderableContent } = await kit();
  const win = freshWindow();
  // Mirror the real pipeline: a hostile diagram whose SVG is JUST a <script>.
  // sanitizeSvg removes the <script>, leaving a bare <svg> — which the predicate
  // must classify as NOT renderable so the renderer degrades to the fallback
  // instead of injecting an empty box.
  const dirty =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const clean = sanitizeSvg(dirty, win);
  assert.doesNotMatch(clean, /<script/i, 'the <script> is stripped by the scrub');
  assert.equal(
    svgHasRenderableContent(clean, win),
    false,
    'an <svg> left empty after the scrub is NOT renderable',
  );
});

test('SVG-RENDERABLE: a real <svg><g><path/></g></svg> IS renderable (renderer would inject it)', async () => {
  const { svgHasRenderableContent } = await kit();
  const win = freshWindow();
  const real =
    '<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0 L10 10"/></g></svg>';
  assert.equal(svgHasRenderableContent(real, win), true, 'a real diagram with a <path> is renderable');
});
