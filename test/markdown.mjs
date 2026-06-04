/* ============================================================
 * Loom — markdown table rendering suite (node --test)
 * ------------------------------------------------------------
 * The Viewer's .md render parses GFM tables (markdown-it default
 * preset) but they were unstyled (no borders). The renderer now
 * wraps each table in a scrollable .md-table-wrap container (the
 * CSS borders/zebra/header live in renderer.css). This pins the
 * wrapper + table HTML and confirms cell content is still escaped
 * (Law 1) — DOM-free via the testkit's renderMarkdown.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('MARKDOWN tables: a GFM table renders as a table inside the scroll wrapper', async () => {
  const { renderMarkdown } = await kit();
  const md = '| Name | Role |\n|------|------|\n| alice | lead |\n| bob | scout |';
  const html = renderMarkdown(md);
  assert.match(html, /<div class="md-table-wrap">\s*<table/, 'table is wrapped in .md-table-wrap');
  assert.match(html, /<\/table>\s*<\/div>/, 'the wrapper closes after the table');
  assert.match(html, /<th[^>]*>Name<\/th>/, 'header cell');
  assert.match(html, /<td[^>]*>alice<\/td>/, 'body cell');
});

test('MARKDOWN tables: hostile cell content is still HTML-escaped (Law 1)', async () => {
  const { renderMarkdown } = await kit();
  const md = '| h |\n|---|\n| <img src=x onerror=alert(1)> |';
  const html = renderMarkdown(md);
  assert.match(html, /&lt;img/i, 'a hostile cell is escaped to &lt;img');
  assert.doesNotMatch(html, /<img\b[^>]*\bonerror\s*=/i, 'never rendered as a live element');
});

test('MARKDOWN task lists: [ ]/[x] become tagged items (marker stripped, no <input>)', async () => {
  const { renderMarkdown } = await kit();
  const html = renderMarkdown('- [ ] todo\n- [x] done\n- normal');
  assert.match(html, /<li[^>]*\bclass="md-task"[^>]*>todo<\/li>/, 'unchecked -> li.md-task, marker stripped');
  assert.match(html, /<li[^>]*\bclass="md-task md-task-done"[^>]*>done<\/li>/, 'checked -> li.md-task-done');
  assert.match(html, /<li[^>]*>normal<\/li>/, 'a plain item is untouched');
  assert.doesNotMatch(html, /\[ \]|\[x\]/, 'no literal [ ]/[x] marker remains');
  assert.doesNotMatch(html, /<input/i, 'no real <input> emitted — inert CSS checkbox only');
});

test('MARKDOWN code: only JS-family langs are highlighted; others render plain + escaped', async () => {
  const { renderMarkdown } = await kit();
  assert.match(renderMarkdown('```js\nconst x = 1;\n```'), /tok-kw/, 'a js block IS highlighted');
  const yaml = renderMarkdown('```yaml\nfor: all\nclass: x\n```');
  assert.doesNotMatch(yaml, /tok-kw/, 'a yaml block must NOT get JS keyword coloring');
  assert.match(yaml, /data-lang="yaml"/, 'the language is stamped');
  const hostile = renderMarkdown('```text\n<img src=x onerror=alert(1)>\n```');
  assert.match(hostile, /&lt;img/i, 'plain (non-highlighted) code is still escaped');
  assert.doesNotMatch(hostile, /<img\b[^>]*\bonerror/i, 'never a live element');
});

test('MARKDOWN alerts: > [!NOTE] becomes a typed callout; unknown types stay plain quotes', async () => {
  const { renderMarkdown } = await kit();
  const note = renderMarkdown('> [!NOTE]\n> Be careful.');
  assert.match(note, /<blockquote[^>]*\bclass="md-alert md-alert-note"/, 'NOTE -> blockquote.md-alert-note');
  assert.doesNotMatch(note, /\[!NOTE\]/, 'the [!NOTE] marker is stripped');
  assert.match(note, /Be careful\./, 'the alert body survives');
  const bogus = renderMarkdown('> [!BOGUS]\n> hi');
  assert.doesNotMatch(bogus, /md-alert/, 'an unknown type is not promoted to an alert');
  assert.match(bogus, /\[!BOGUS\]/, 'unknown marker left as literal text');
});

test('LINKS: safeExternalUrl allows only bare http/https/mailto (no userinfo, no padding)', async () => {
  const { safeExternalUrl } = await kit();
  // ALLOWED: bare http/https and a bare mailto address.
  assert.equal(safeExternalUrl('http://a.com/x'), 'http://a.com/x');
  assert.equal(safeExternalUrl('https://a.com/x'), 'https://a.com/x');
  assert.ok(safeExternalUrl('mailto:a@b.com'), 'a bare mailto address is allowed');
  for (const bad of [
    // Dangerous schemes / relative / empty / nullish (existing contract).
    'javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,x',
    'vbscript:x', 'blob:https://a', 'relative/path', '#frag', '', null, undefined,
    // FIX 1 — embedded credentials / userinfo (incl. the @host spoof and the
    // password-only sub-clause: url.username === '' && url.password !== '').
    'http://u:p@host.com/', 'http://legit.com@evil.com/', 'http://:p@host.com/',
    // FIX 3 — leading / trailing whitespace.
    '  http://a.com', 'http://a.com ',
    // FIX 4 — mailto with injectable params / fragment / no address.
    'mailto:a@b.com?subject=x', 'mailto:a@b.com?body=y', 'mailto:a@b.com#frag', 'mailto:foo',
    // FIX 4 — percent-encoded separators that an RFC-6068 handler would decode
    // back into header/option metacharacters (must not slip past search/hash).
    'mailto:a@b.com%3Fsubject=Pwned', 'mailto:a@b.com%0D%0ABcc:evil@x.com',
    // FIX 4 — multi-recipient list (comma / semicolon) is not a bare address.
    'mailto:a@b.com,evil@x.com', 'mailto:a@b.com;evil@x.com',
  ]) {
    assert.equal(safeExternalUrl(bad), null, `must reject ${String(bad)}`);
  }
});

test('LINKS: dangerous-scheme markdown links get NO href (neutralized); text survives', async () => {
  const { renderMarkdown } = await kit();
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,hello']) {
    const html = renderMarkdown(`[clickme](${url})`);
    assert.doesNotMatch(html, /href\s*=/i, `no href for ${url}`);
    assert.doesNotMatch(html, /data-loom-ext/, `not marked external for ${url}`);
    assert.match(html, /clickme/, 'link text still renders');
  }
});

test('LINKS: a bare safe link renders WITH data-loom-ext; userinfo / parameterized mailto do NOT', async () => {
  const { renderMarkdown } = await kit();
  // A bare, safe http link is navigable + marked for external open.
  const ok = renderMarkdown('[ok](http://a.com/x)');
  assert.match(ok, /href="http:\/\/a\.com\/x"/, 'a bare safe link keeps a navigable href');
  assert.match(ok, /data-loom-ext="1"/, 'and is marked for shell.openExternal');
  // Newly-rejected targets render inert: NO href, NO data-loom-ext (text survives).
  for (const url of [
    'http://u:p@host.com/',          // FIX 1 — userinfo
    'http://legit.com@evil.com/',    // FIX 1 — @host spoof
    'mailto:a@b.com?subject=x',      // FIX 4 — injectable mailto param
    'mailto:a@b.com#frag',           // FIX 4 — mailto with a fragment
    'mailto:foo',                    // FIX 4 — mailto with no address
    'mailto:a@b.com%3Fsubject=Pwned',// FIX 4 — percent-encoded `?` bypass
    'mailto:a@b.com%0D%0ABcc:evil@x.com', // FIX 4 — percent-encoded CRLF/Bcc
  ]) {
    const html = renderMarkdown(`[clickme](${url})`);
    assert.doesNotMatch(html, /href\s*=/i, `no href for ${url}`);
    assert.doesNotMatch(html, /data-loom-ext/, `not marked external for ${url}`);
    assert.match(html, /clickme/, `link text still renders for ${url}`);
  }
});
