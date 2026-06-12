/* ============================================================
 * Loom — diff-row render suite (node --test + jsdom)
 * ------------------------------------------------------------
 * TIER-1 DOM harness for the "Changes" viewer's PURE render core:
 *   - buildDiffRows / classifyDiffLine: the visual + accessible contract
 *     (add/del/context classes + +/− sigils + 'added line'/'removed line'
 *     accessible suffixes — NFR-12), in order;
 *   - LAW 1 (the single most important renderer test): a diff line whose
 *     text is hostile markup (<img onerror>, <script>) is routed through
 *     the EXACT escape sink the React DiffLine uses — highlightCode(text)[0]
 *     injected via innerHTML into a real DOM node — and asserted to render
 *     as ESCAPED TEXT, never a live element. Mirror of markdown.mjs's
 *     hostile-input case.
 *   - created-file / binary / truncated render shapes.
 *
 * The escape sink (highlightCode) is the SAME one CodeView and the
 * FileDiff component use, so this proves Law 1 for the diff path without
 * a display (the only locally-runnable tier in WSL). DOM-free logic +
 * jsdom only for the innerHTML inertness assertion.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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

/** A minimal FileDiff with one hunk made of the given DiffLine rows. */
function fileDiffWith(lines) {
  return {
    path: 'f.txt',
    oldPath: null,
    changeKind: 'modified',
    binary: false,
    truncated: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }],
  };
}

/* ------------------------------------------------------------------ *
 * classifyDiffLine — the NON-color visual + accessible contract       *
 * ------------------------------------------------------------------ */
test('DIFF-RENDER classifyDiffLine: add/del/context map to class + sigil + accessible suffix (NFR-12)', async () => {
  const { classifyDiffLine } = await kit();
  assert.deepEqual(classifyDiffLine('add'), {
    rowClass: 'diff-add', sigil: '+', a11ySuffix: 'added line',
  });
  assert.deepEqual(classifyDiffLine('del'), {
    rowClass: 'diff-del', sigil: '−', a11ySuffix: 'removed line',
  });
  assert.deepEqual(classifyDiffLine('context'), {
    rowClass: 'diff-ctx', sigil: '', a11ySuffix: 'context',
  });
});

/* ------------------------------------------------------------------ *
 * buildDiffRows — additions/deletions/context in order, with gutters  *
 * ------------------------------------------------------------------ */
test('DIFF-RENDER buildDiffRows: rows carry the right class/sigil/suffix + gutter labels, in order', async () => {
  const { buildDiffRows } = await kit();
  const diff = fileDiffWith([
    { origin: 'context', oldLine: 1, newLine: 1, text: 'alpha' },
    { origin: 'del', oldLine: 2, newLine: null, text: 'beta' },
    { origin: 'add', oldLine: null, newLine: 2, text: 'BETA' },
  ]);
  const rows = buildDiffRows(diff);
  assert.equal(rows.length, 3);
  // Context: both gutters, no sigil.
  assert.equal(rows[0].rowClass, 'diff-ctx');
  assert.equal(rows[0].sigil, '');
  assert.equal(rows[0].oldGutter, '1');
  assert.equal(rows[0].newGutter, '1');
  assert.equal(rows[0].a11ySuffix, 'context');
  // Deletion: old gutter only, '−' sigil, 'removed line'.
  assert.equal(rows[1].rowClass, 'diff-del');
  assert.equal(rows[1].sigil, '−');
  assert.equal(rows[1].oldGutter, '2');
  assert.equal(rows[1].newGutter, '', 'a deletion has no NEW-side gutter number');
  assert.equal(rows[1].a11ySuffix, 'removed line');
  // Addition: new gutter only, '+' sigil, 'added line'.
  assert.equal(rows[2].rowClass, 'diff-add');
  assert.equal(rows[2].sigil, '+');
  assert.equal(rows[2].oldGutter, '', 'an addition has no OLD-side gutter number');
  assert.equal(rows[2].newGutter, '2');
  assert.equal(rows[2].a11ySuffix, 'added line');
});

test('DIFF-RENDER buildDiffRows: a created file renders as all-additions (no old gutter numbers)', async () => {
  const { buildDiffRows } = await kit();
  const diff = {
    path: 'new.txt', oldPath: null, changeKind: 'added', binary: false, truncated: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: [
      { origin: 'add', oldLine: null, newLine: 1, text: 'first' },
      { origin: 'add', oldLine: null, newLine: 2, text: 'second' },
    ] }],
  };
  const rows = buildDiffRows(diff);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.rowClass === 'diff-add'), 'every row is an addition');
  assert.ok(rows.every((r) => r.oldGutter === ''), 'no OLD-side gutter numbers');
  assert.ok(rows.every((r) => r.sigil === '+'), 'every row carries the + sigil');
});

test('DIFF-RENDER buildDiffRows: binary/truncated/identical (hunks null|empty) → no rows', async () => {
  const { buildDiffRows } = await kit();
  const binary = { path: 'b.bin', oldPath: null, changeKind: 'modified', binary: true, truncated: false, hunks: null };
  const truncated = { path: 't.txt', oldPath: null, changeKind: 'modified', binary: false, truncated: true, hunks: null };
  const identical = { path: 'i.txt', oldPath: null, changeKind: 'modified', binary: false, truncated: false, hunks: [] };
  assert.deepEqual(buildDiffRows(binary), [], 'binary → no rows (the presenter shows a card)');
  assert.deepEqual(buildDiffRows(truncated), [], 'truncated → no rows (the presenter shows a card)');
  assert.deepEqual(buildDiffRows(identical), [], 'identical → no rows');
});

/* ------------------------------------------------------------------ *
 * sdet/F4 — the VISIBLE sigil glyph is CSS-owned (keyed off rowClass),  *
 * not the DiffRowClass.sigil field. Pin the CSS ::before content so the *
 * on-screen glyph contract can't silently regress (the React .diff-sigil *
 * span is empty; the glyph comes from CSS).                             *
 * ------------------------------------------------------------------ */
test('DIFF-RENDER sigil glyph is owned by CSS ::before keyed off rowClass (not the sigil field)', async () => {
  const { classifyDiffLine } = await kit();
  const css = readFileSync(
    path.join(root, 'src', 'renderer', 'styles', 'renderer.css'),
    'utf8',
  );
  // The React span is EMPTY — the glyph rides on the CSS ::before. Assert the CSS
  // content rules match classifyDiffLine's sigil DATA so the two never drift.
  // '+' for an addition, U+2212 (escaped '\2212' in CSS) for a deletion, '' for
  // context. Whitespace inside the rule is tolerant.
  assert.match(
    css,
    /\.diff-row\.diff-add\s+\.diff-sigil::before\s*\{\s*content:\s*'\+'/,
    "the add row's visible sigil is CSS content '+' (matches classifyDiffLine('add').sigil)",
  );
  assert.equal(classifyDiffLine('add').sigil, '+');
  assert.match(
    css,
    /\.diff-row\.diff-del\s+\.diff-sigil::before\s*\{\s*content:\s*'\\2212'/,
    "the del row's visible sigil is CSS content '\\2212' (U+2212, matches classifyDiffLine('del').sigil)",
  );
  assert.equal(classifyDiffLine('del').sigil, '−'); // U+2212
  assert.match(
    css,
    /\.diff-row\.diff-ctx\s+\.diff-sigil::before\s*\{\s*content:\s*''/,
    "the context row has an EMPTY visible sigil (matches classifyDiffLine('context').sigil)",
  );
  assert.equal(classifyDiffLine('context').sigil, '');
});

/* ------------------------------------------------------------------ *
 * LAW 1 — hostile diff-line text renders ESCAPED, never live markup    *
 * ------------------------------------------------------------------ */
test('DIFF-RENDER LAW 1: a hostile diff line (<img onerror>/<script>) renders ESCAPED, never live markup', async () => {
  const { buildDiffRows, highlightCode } = await kit();
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const diff = fileDiffWith([
    { origin: 'add', oldLine: null, newLine: 1, text: hostile },
  ]);
  const rows = buildDiffRows(diff);
  // The render core carries the RAW text through unchanged (escaping happens at
  // the sink, exactly like the React component).
  assert.equal(rows[0].text, hostile, 'buildDiffRows does NOT escape — that is the sink\'s job');

  // The EXACT sink the FileDiff component uses: highlightCode(text)[0] injected
  // via innerHTML. The highlighter escapes EVERY '<'/'>' to &lt;/&gt; (the only
  // tags it emits are its fixed <span class="tok-*"> wrappers, which carry no
  // user bytes), so a hostile angle bracket can never open a real element.
  const html = highlightCode(rows[0].text)[0];
  assert.match(html, /&lt;/, 'every hostile "<" is escaped to &lt;');
  assert.doesNotMatch(html, /<img\b/i, 'never a live <img> tag in the markup');
  assert.doesNotMatch(html, /<script\b/i, 'never a live <script> tag in the markup');
  // The ONLY tags the highlighter emits are its fixed tok-* span wrappers.
  for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) {
    assert.match(
      tag,
      /^<\/?span(?:\s+class="tok-[a-z]+")?>$/,
      `only fixed tok-* span wrappers may appear, got: ${tag}`,
    );
  }

  const dom = new JSDOM('<!doctype html><div id="sink"></div>');
  const sink = dom.window.document.getElementById('sink');
  sink.innerHTML = html;
  // The escaped string produces NO live <img>/<script> — only inert text nodes
  // (and the highlighter's fixed tok-* spans, which carry no user bytes).
  assert.equal(sink.querySelectorAll('img').length, 0, 'no live <img> element materialized');
  assert.equal(sink.querySelectorAll('script').length, 0, 'no live <script> element materialized');
  // The textContent round-trips the hostile bytes as INERT TEXT.
  assert.ok(sink.textContent.includes('onerror=alert(1)'), 'the hostile bytes survive as inert text');
});

/* ------------------------------------------------------------------ *
 * LAW 1 (anti-revert) — render the REAL production sink (DiffBody) and  *
 * prove a raw-innerHTML revert in FileDiff.tsx would turn this RED      *
 * (sdet/F1). Unlike the test above (which re-derives the escape via     *
 * highlightCode), this drives the ACTUAL component via                  *
 * renderToStaticMarkup, so it pins the production code path, not a       *
 * re-implementation.                                                    *
 * ------------------------------------------------------------------ */
test('DIFF-RENDER LAW 1 (REAL sink): DiffBody renders a hostile line ESCAPED — neutering FileDiff would turn this RED', async () => {
  const { DiffBody } = await kit();
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const diff = fileDiffWith([
    { origin: 'add', oldLine: null, newLine: 1, text: hostile },
  ]);

  // Render the REAL FileDiff render sink (the same DiffBody the renderer mounts)
  // to static HTML. If someone reverted FileDiff.tsx's
  // `dangerouslySetInnerHTML={{ __html: highlightCode(row.text)[0] }}` to inject
  // `row.text` RAW, the serialized output below would contain a LIVE <img>/<script>
  // and these assertions would fail.
  const html = renderToStaticMarkup(React.createElement(DiffBody, { diff }));

  // Every hostile '<' is escaped to &lt; — including the one that opens the <img>.
  // (The highlighter wraps each '<' in a fixed <span class="tok-punc">&lt;</span>,
  // so assert the escaped entity is present and that NO live <img>/<script> tag
  // exists anywhere in the serialized component output.)
  assert.match(html, /&lt;/, 'the production sink escapes "<" to &lt;');
  assert.doesNotMatch(html, /<img\b/i, 'NO live <img> tag in the REAL component output');
  assert.doesNotMatch(html, /<script\b/i, 'NO live <script> tag in the REAL component output');
  // The ONLY raw tags DiffBody emits are its own fixed chrome (div/span wrappers
  // + the highlighter's tok-* spans) — never a user-controlled element.
  for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) {
    assert.match(
      tag,
      /^<\/?(?:div|span|b)(?:\s+(?:class|role|aria-hidden)="[^"]*")*\s*\/?>$/,
      `only fixed component chrome may appear, got: ${tag}`,
    );
  }

  // And under a real DOM, NO live <img>/<script> element materializes from the
  // component's serialized HTML.
  const dom = new JSDOM('<!doctype html><div id="sink"></div>');
  const sink = dom.window.document.getElementById('sink');
  sink.innerHTML = html;
  assert.equal(sink.querySelectorAll('img').length, 0, 'no live <img> from DiffBody');
  assert.equal(sink.querySelectorAll('script').length, 0, 'no live <script> from DiffBody');
  // The hostile bytes survive as INERT text in the diff-text span.
  assert.ok(
    sink.querySelector('.diff-text')?.textContent?.includes('onerror=alert(1)'),
    'the hostile bytes are present as inert text inside .diff-text',
  );
  // Sanity: the escaped attacker bytes did NOT spawn an onerror attribute on any
  // real element (the textContent carries them, but no element does).
  assert.equal(
    sink.querySelector('[onerror]'),
    null,
    'no element carries an onerror handler — the bytes are inert text, not markup',
  );
});

/* ------------------------------------------------------------------ *
 * Change-kind glyphs (NFR-12, reviewer finding 4) — the header chip:  *
 * added → green '+' badge; deleted → its own red '−' badge (NOT the   *
 * amber "modified" dot); modified keeps the amber dot. Rendered via   *
 * the REAL production presenter (ChangeKindGlyph — hook-free, the     *
 * DiffBody idiom; the full FileDiff block carries useState and cannot *
 * SSR across the testkit's bundled React copy).                       *
 * ------------------------------------------------------------------ */
test('DIFF-RENDER ChangeKindGlyph: a deleted row gets a DISTINCT deleted glyph, not the modified dot', async () => {
  const { ChangeKindGlyph } = await kit();
  const row = (changeKind) => ({
    path: 'some/file.txt',
    changeKind,
    oldPath: null,
    binary: false,
  });

  const addedHtml = renderToStaticMarkup(
    React.createElement(ChangeKindGlyph, { file: row('added') }),
  );
  assert.match(addedHtml, /badge-git-added/, 'added keeps the green + badge');
  assert.doesNotMatch(addedHtml, /badge-git-deleted/);

  const modifiedHtml = renderToStaticMarkup(
    React.createElement(ChangeKindGlyph, { file: row('modified') }),
  );
  assert.match(modifiedHtml, /dot-git-modified/, 'modified keeps the amber dot');
  assert.doesNotMatch(modifiedHtml, /badge-git-deleted/);

  const deletedHtml = renderToStaticMarkup(
    React.createElement(ChangeKindGlyph, { file: row('deleted') }),
  );
  assert.match(
    deletedHtml,
    /badge-git-deleted/,
    'deleted renders its OWN glyph chip (red −), not the modified dot',
  );
  assert.doesNotMatch(
    deletedHtml,
    /dot-git-modified/,
    'deleted must NOT reuse the amber modified dot',
  );
  assert.match(deletedHtml, /−|&#x2212;|&minus;/, 'the deleted chip carries a − glyph');
  // The chip is decorative for AT (the FileDiff header's aria-label + visible
  // text label carry the kind, NFR-12) — pin the aria-hidden contract.
  assert.match(deletedHtml, /aria-hidden="true"/, 'the glyph chip is aria-hidden');
});
