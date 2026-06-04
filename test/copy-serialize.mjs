/* ============================================================
 * Loom — "Copy rendered" serializer suite (node --test + jsdom)
 * ------------------------------------------------------------
 * Feeds serializeRenderedForCopy the REAL renderMarkdown() output (from
 * dist/testkit.cjs) and asserts the CLEANED, PORTABLE clipboard pair:
 *
 *   - portable HTML is REBUILT by allowlist: NO class / data-* attribute
 *     anywhere, NO <span class="ln"> code artifacts; code blocks are a
 *     clean <pre><code> whose text is the ORIGINAL lines joined by '\n'
 *     (no line numbers, no nbsp);
 *   - a SAFE link keeps href="https://ex.com/"; a NEUTRALIZED link is
 *     UNWRAPPED to its text (no href);
 *   - tables are a clean <table> (no .md-table-wrap, no classes);
 *   - headings / lists / bold / em survive as semantic tags;
 *   - a hostile source yields NO <script>, NO real on*-handler attribute,
 *     NO javascript: href — proven by re-parsing the portable HTML into a
 *     DOM and inspecting it structurally (escaped text is harmless);
 *   - the mermaid SOURCE-fallback branch (a .mermaid-diagram with a
 *     .mermaid-src and NO svg) emits the source ONCE as <pre><code>;
 *   - text/plain reads like the rendered doc: heading / list / code text
 *     present, blocks separated by blank lines (never one mashed line).
 *
 * jsdom CANNOT run mermaid.render, so the mermaid-SVG branch is covered in
 * e2e; here we exercise only the source-fallback branch.
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

/** A fresh jsdom window the serializer parses with (its DOMParser). Closed by
 *  the caller's finally so no window leaks between tests. */
function makeWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://loom.test/',
  });
  return dom.window;
}

/** Parse a portable-HTML string into a detached DOM document (a SEPARATE jsdom
 *  window from the serializer's) so we can inspect it structurally — the most
 *  faithful way to prove no live <script>/<style>/on*-handler/javascript: href
 *  survived (escaped text like "&lt;script&gt;" is harmless and must not trip a
 *  naive substring check). */
function parsePortable(html) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  return { doc: dom.window.document, close: () => dom.window.close() };
}

/** The kitchen-sink markdown doc the spec enumerates. */
const DOC = [
  '# Heading One',
  '',
  '## Heading Two',
  '',
  'A paragraph with **bold** and _em_ and `inline code`.',
  '',
  '- alpha',
  '- beta',
  '',
  '1. first',
  '2. second',
  '',
  '[x](https://ex.com) link and [y](http://legit.com@evil.com/) spoof.',
  '',
  '```js',
  'const a = 1;',
  '',
  'function f() { return a; }',
  '```',
  '',
  '| Name | Role |',
  '|------|------|',
  '| alice | lead |',
].join('\n');

test('COPY portable HTML: no class / data-* attribute anywhere; no ln artifacts', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    const { html } = serializeRenderedForCopy(renderMarkdown(DOC), win);
    assert.doesNotMatch(html, /\sclass\s*=/i, 'no class attribute survives the allowlist rebuild');
    assert.doesNotMatch(html, /\sdata-[\w-]+\s*=/i, 'no data-* attribute survives');
    assert.doesNotMatch(html, /<span\b/i, 'no per-line <span class="ln"> code artifacts');
    assert.doesNotMatch(html, /&nbsp;| /, 'no non-breaking-space code artifacts');
  } finally {
    win.close();
  }
});

test('COPY attribute strip is NON-tautological: a class + data-* ON AN ALLOWLISTED element is dropped', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    // The plain DOC assertions above can be partially tautological for the
    // generic allowlist branch (the input never puts a `class` on a kept tag like
    // <strong>, so the no-class half can't fail for the right reason there). Here
    // we FORCE the adversarial case two independent ways:
    //   (a) renderMarkdown's OWN output already decorates KEPT elements with
    //       attributes — <p data-srcline="1"> (an allowlisted block) — so the
    //       data-* half guards a real allowlisted-element attribute, and
    //   (b) we INJECT a class AND a data-* onto an allowlisted <strong>, which is
    //       rebuilt by the generic BLOCK/INLINE branch — the exact branch the
    //       reviewer flagged. The serialized OUTPUT must carry NEITHER.
    const rendered = renderMarkdown('A paragraph with **bold** here.');
    assert.match(rendered, /<p data-srcline=/, 'precondition: render decorates the allowlisted <p> with data-srcline');
    const injected = rendered.replace(
      '<strong>',
      '<strong class="injected-cls" data-evil="leak">',
    );
    assert.match(injected, /<strong class="injected-cls" data-evil="leak">/, 'precondition: the allowlisted <strong> now carries class + data-*');

    const { html } = serializeRenderedForCopy(injected, win);
    // Fails-for-the-right-reason: if the generic allowlist branch leaked the
    // attribute, these exact tokens would appear in the output.
    assert.doesNotMatch(html, /\sclass\s*=/i, 'no class= survives on the rebuilt allowlisted element');
    assert.doesNotMatch(html, /\sdata-[\w-]+\s*=/i, 'no data-* survives on the rebuilt allowlisted element');
    assert.ok(!html.includes('injected-cls'), 'the injected class value never reaches the clipboard');
    assert.ok(!html.includes('data-evil') && !html.includes('leak'), 'the injected data-* never reaches the clipboard');
    // The element ITSELF (and its content) still survive — only the attrs are stripped.
    assert.match(html, /<strong>bold<\/strong>/, 'the allowlisted element + content are preserved, only attributes dropped');
  } finally {
    win.close();
  }
});

test('COPY non-content elements are DROPPED, not unwrapped-to-text: <style> (and SVG <style>) bodies never leak', async () => {
  const { serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    // A <style> sits between two paragraphs. The serializer must DROP it ENTIRELY
    // (element + body) — NOT unwrap it to its text, which would leak the raw CSS
    // (`.x{color:red}`) into BOTH the portable HTML and the text/plain fallback.
    // Fails-for-the-right-reason: if FIX 1 regressed to the old unwrap behavior,
    // the CSS body would appear in the output.
    const { html, text } = serializeRenderedForCopy(
      '<p>before</p><style>.x{color:red}</style><p>after</p>',
      win,
    );
    assert.doesNotMatch(html, /<style/i, 'no <style> element survives in the portable HTML');
    assert.ok(!html.includes('color:red'), 'the CSS body does not leak into the portable HTML');
    assert.ok(!text.includes('color:red'), 'the CSS body does not leak into the text/plain fallback');
    // The surrounding real content is untouched.
    assert.match(html, /<p>before<\/p>/, 'content before the dropped <style> survives');
    assert.match(html, /<p>after<\/p>/, 'content after the dropped <style> survives');
    assert.match(text, /before/, 'before text survives');
    assert.match(text, /after/, 'after text survives');

    // An SVG <style> (tagName 'style') must be dropped just the same. The <svg>
    // wrapper is unwrapped; its <style> child is removed body-and-all.
    const svg = serializeRenderedForCopy(
      '<p>x</p><svg><style>.y{color:blue}</style><rect/></svg>',
      win,
    );
    assert.doesNotMatch(svg.html, /<style/i, 'no SVG <style> element survives');
    assert.ok(!svg.html.includes('color:blue'), 'the SVG CSS body does not leak into the portable HTML');
    assert.ok(!svg.text.includes('color:blue'), 'the SVG CSS body does not leak into the text/plain fallback');
  } finally {
    win.close();
  }
});

test('COPY code block: clean <pre><code> whose text equals the original lines (no line numbers, no nbsp)', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    const { html } = serializeRenderedForCopy(renderMarkdown(DOC), win);
    // Reconstruct the original code: a const line, a blank line, a function line.
    const expected = 'const a = 1;\n\nfunction f() { return a; }';
    assert.ok(
      html.includes(`<pre><code>${expected}</code></pre>`),
      `code block reconstructs to the original lines joined by \\n.\nGot HTML:\n${html}`,
    );
  } finally {
    win.close();
  }
});

test('COPY links: safe link keeps the normalized href; a neutralized link is unwrapped to text (no href)', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    const { html } = serializeRenderedForCopy(renderMarkdown(DOC), win);
    assert.match(html, /<a href="https:\/\/ex\.com\/">x<\/a>/, 'the safe link keeps href="https://ex.com/"');
    // The userinfo-spoof link renders as an <a> WITHOUT a vetted href; the
    // serializer must unwrap it to bare text (no anchor, no href).
    assert.ok(html.includes('y') && html.includes('spoof'), 'the neutralized link text survives');
    assert.doesNotMatch(html, /legit\.com@evil\.com/, 'the dangerous target never reaches the clipboard');
    // And, structurally, the ONLY anchor is the safe one.
    const { doc, close } = parsePortable(html);
    try {
      const anchors = [...doc.querySelectorAll('a')];
      assert.equal(anchors.length, 1, 'exactly one anchor (the safe link) survives');
      assert.equal(anchors[0].getAttribute('href'), 'https://ex.com/', 'and it carries the normalized href');
    } finally {
      close();
    }
  } finally {
    win.close();
  }
});

test('COPY table: a clean <table> (no md-table-wrap, no classes)', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    const { html } = serializeRenderedForCopy(renderMarkdown(DOC), win);
    assert.match(html, /<table>/, 'the table is a bare <table> with no attributes');
    assert.doesNotMatch(html, /md-table-wrap/, 'the .md-table-wrap container is unwrapped');
    assert.match(html, /<th>Name<\/th>/, 'header cell survives');
    assert.match(html, /<td>alice<\/td>/, 'body cell survives');
  } finally {
    win.close();
  }
});

test('COPY semantics: headings / lists / bold / em survive as semantic tags', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    const { html } = serializeRenderedForCopy(renderMarkdown(DOC), win);
    assert.match(html, /<h1>Heading One<\/h1>/, 'h1 survives');
    assert.match(html, /<h2>Heading Two<\/h2>/, 'h2 survives');
    assert.match(html, /<ul>[\s\S]*<li>alpha<\/li>[\s\S]*<\/ul>/, 'unordered list survives');
    assert.match(html, /<ol>[\s\S]*<li>first<\/li>[\s\S]*<\/ol>/, 'ordered list survives');
    assert.match(html, /<strong>bold<\/strong>/, 'bold survives');
    assert.match(html, /<em>em<\/em>/, 'em survives');
    assert.match(html, /<code>inline code<\/code>/, 'inline code survives');
  } finally {
    win.close();
  }
});

test('COPY hostile source: NO live <script>/<style>, NO on*-handler attribute, NO javascript: href', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    // A paragraph + a code block both carrying hostile bytes, plus a
    // dangerous-scheme link AND a markdown image. renderMarkdown escapes/
    // neutralizes; the serializer must never re-animate any of it. The markdown
    // image is the load-bearing addition for the no-<img> negative: renderMarkdown
    // renders an image as an INERT label (<span class="md-img" data-loom-img="1">
    // alt</span>) — it NEVER decodes/loads the src, so the src URL is dropped at
    // render time and only the alt text remains. That md-img span is a node the
    // serializer's `.md-img` branch must UNWRAP to bare text, so the no-<img>
    // assertion now guards a REACHABLE allowlist path (a real rendered image
    // label, proven to NEVER become a live <img> nor keep the md-img wrapper /
    // data-loom-img trust flag) rather than being vacuous. (A javascript: image
    // src cannot be used here: markdown-it's URL validator refuses to parse
    // ![..](javascript:..) as an image at all — it stays literal text — so the
    // dangerous scheme never even reaches the image rule. We use a normal src;
    // the danger we guard is the <img> ELEMENT itself, which Loom never emits.)
    const hostile = [
      'Danger <script>alert(1)</script> and <img src=x onerror=alert(2)>.',
      '',
      '[click](javascript:alert(3))',
      '',
      '![evil-alt-label](https://attacker.example/track.png)',
      '',
      '```html',
      '<script>steal()</script>',
      '<div onclick="evil()">x</div>',
      '```',
    ].join('\n');
    const { html, text } = serializeRenderedForCopy(renderMarkdown(hostile), win);

    // Structural proof: re-parse and inspect the live DOM.
    const { doc, close } = parsePortable(html);
    try {
      assert.equal(doc.querySelector('script'), null, 'no live <script> element');
      assert.equal(doc.querySelector('style'), null, 'no live <style> element');
      // Non-vacuous: renderMarkdown DID emit an inert image label for the
      // ![…](…) above; the serializer must unwrap it to text, so NO <img>
      // element survives AND the md-img wrapper / data-attr are gone. The alt
      // text survives as plain (inert) text; the image src never reaches output
      // (renderMarkdown dropped it at render time — images are never loaded).
      assert.equal(doc.querySelector('img'), null, 'no <img> element (images are inert text)');
      assert.equal(doc.querySelector('.md-img'), null, 'the md-img wrapper is unwrapped, not kept');
      assert.equal(doc.querySelector('[data-loom-img]'), null, 'no data-loom-img trust flag survives');
      assert.match(html, /evil-alt-label/, 'the image alt text survives as inert text');
      assert.doesNotMatch(html, /attacker\.example/, 'the image src never reaches the clipboard');
      // No element carries an on* event-handler attribute.
      for (const el of doc.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          assert.ok(
            !/^on/i.test(attr.name),
            `no on*-handler attribute (found ${attr.name} on <${el.tagName.toLowerCase()}>)`,
          );
        }
      }
      // No anchor carries a javascript: href (none should survive at all).
      for (const a of doc.querySelectorAll('a')) {
        assert.doesNotMatch(a.getAttribute('href') ?? '', /javascript:/i, 'no javascript: href');
      }
    } finally {
      close();
    }

    // The hostile bytes ARE present, but only as ESCAPED display text (harmless).
    assert.match(html, /&lt;script&gt;/i, 'the hostile <script> appears only as escaped text');
    // text/plain carries the hostile bytes verbatim too (it is plain text — that
    // is inherently inert; the point is the HTML side cannot execute).
    assert.match(text, /steal\(\)/, 'the code text is preserved in the plaintext fallback');
  } finally {
    win.close();
  }
});

test('COPY mermaid (source-fallback branch): a .mermaid-diagram with .mermaid-src and no svg emits the source once', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    const src = 'graph TD;\n  A-->B;\n  B-->C;';
    const { html, text } = serializeRenderedForCopy(
      renderMarkdown('```mermaid\n' + src + '\n```'),
      win,
    );
    // Exactly one <pre><code> carrying the source (the hidden .mermaid-src
    // duplicate + the fallback code block collapse to one).
    const preCount = (html.match(/<pre>/g) ?? []).length;
    assert.equal(preCount, 1, 'the diagram source appears in exactly one <pre> block');
    assert.match(html, /graph TD;/, 'the diagram source is included');
    assert.match(html, /A--&gt;B;/, 'the source arrows are escaped, not interpreted as markup');
    assert.doesNotMatch(html, /mermaid-src|mermaid-diagram|md-code/, 'no in-app mermaid classes leak');
    assert.match(text, /graph TD;/, 'the plaintext fallback carries the source');
  } finally {
    win.close();
  }
});

test('COPY text/plain: heading / list / code text present, blocks separated by blank lines (not one mashed line)', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    const { text } = serializeRenderedForCopy(renderMarkdown(DOC), win);
    assert.match(text, /Heading One/, 'heading text present');
    assert.match(text, /- alpha/, 'unordered list item rendered with a bullet');
    assert.match(text, /1\. first/, 'ordered list item rendered with a number');
    // The code is preserved verbatim (the const line + the blank + the fn line).
    assert.match(text, /const a = 1;\n\nfunction f\(\) \{ return a; \}/, 'code kept verbatim');
    // Blocks are separated by a blank line — NOT mashed into one line. The
    // heading and the first paragraph must not be on the same physical line.
    assert.ok(text.includes('Heading One\n\nHeading Two'), 'blocks are separated by blank lines');
    assert.ok(text.split('\n').length > 5, 'the plaintext spans multiple lines, not one mash');
  } finally {
    win.close();
  }
});

test('COPY empty doc: an empty string and a whitespace-only render both yield empty html + text (benign-empty contract)', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    // (1) The literal empty string — no DOM, no blocks.
    const empty = serializeRenderedForCopy('', win);
    assert.equal(empty.html, '', 'empty input yields empty portable HTML');
    assert.equal(empty.text, '', 'empty input yields empty text/plain');
    // (2) A whitespace-only markdown source renders to whitespace-only HTML;
    // the allowlist rebuild + the block walker must still collapse to empty
    // (no stray blocks, no whitespace-only paste). Pins the benign-empty write.
    const blank = serializeRenderedForCopy(renderMarkdown('   \n\n   \n'), win);
    assert.equal(blank.html, '', 'whitespace-only render yields empty portable HTML');
    assert.equal(blank.text, '', 'whitespace-only render yields empty text/plain');
  } finally {
    win.close();
  }
});

test('COPY blockquote with nested block content: a quoted list AND a quoted code block survive in text/plain (and html)', async () => {
  const { renderMarkdown, serializeRenderedForCopy } = await kit();
  const win = makeWindow();
  try {
    // A blockquote is a CONTAINER of block children. Earlier the plaintext
    // builder flattened it through inlineText, which SKIPS nested <ul>/<ol> and
    // has no <pre> handling — so a quoted list / code block was silently DROPPED
    // from text/plain while surviving on the HTML side (real content loss on a
    // paste into a plain-text field). This case proves the fix: the quoted
    // bullets AND the quoted code now appear in text/plain.
    const doc = [
      '> quoted intro',
      '> - quoted bullet ALPHA',
      '> - quoted bullet BETA',
      '',
      '> outer quote',
      '> ```',
      '> code in quote',
      '> ```',
    ].join('\n');
    const { html, text } = serializeRenderedForCopy(renderMarkdown(doc), win);

    // HTML side already carried these (the allowlist keeps blockquote/ul/li/pre).
    assert.match(html, /<blockquote>[\s\S]*<li>quoted bullet ALPHA<\/li>[\s\S]*<\/blockquote>/, 'html keeps the quoted bullets');
    assert.match(html, /<blockquote>[\s\S]*<pre><code>code in quote<\/code><\/pre>[\s\S]*<\/blockquote>/, 'html keeps the quoted code block');

    // text/plain is the regression guard — these were dropped before the fix.
    assert.match(text, /quoted intro/, 'the quote intro paragraph survives in text');
    assert.match(text, /quoted bullet ALPHA/, 'the FIRST quoted bullet survives in text (was dropped)');
    assert.match(text, /quoted bullet BETA/, 'the SECOND quoted bullet survives in text (was dropped)');
    assert.match(text, /code in quote/, 'the quoted code block content survives in text (was dropped)');
    // The bullets keep their list marker and the whole quote keeps a '> ' gutter,
    // so the quoted structure is visible in a plaintext paste.
    assert.match(text, /^> - quoted bullet ALPHA$/m, 'a quoted bullet keeps its list marker behind the > gutter');
    assert.match(text, /^> code in quote$/m, 'the quoted code line keeps the > gutter');
  } finally {
    win.close();
  }
});
