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
