/* ============================================================
 * Loom — caret -> (line, column) reconstruction suite (node --test + jsdom)
 * ------------------------------------------------------------
 * TA-3: the error-prone HALF of go-to-definition word extraction — mapping a
 * DOM caret (container + offset) inside a rendered source row to a 0-based
 * COLUMN — used to be reachable ONLY by the CI-only e2e. It is now the PURE
 * columnAt helper (caret-column.ts) the CodeView glue delegates to, so we can
 * prove it under jsdom WITHOUT Electron:
 *
 *   - a caret inside .ln sums the preceding tok-* span text to the correct
 *     0-based column (the TreeWalker offset sum);
 *   - a caret on the collapsed-header sibling decoration (.fold-ellipsis /
 *     .sr-only OUTSIDE .ln) returns null (the GTD-3 lnEl.contains guard) so
 *     the glue no-ops instead of reporting a wrong column / firing IPC;
 *   - a caret outside the root, or on a row with no .ln, returns null.
 *
 * Pattern mirrors test/copy-serialize.mjs (lazy testkit loader + a fresh jsdom
 * window per test). This file MUST be in the package.json EXPLICIT test list.
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

/** Build a CodeView-shaped row in a fresh jsdom document and return the handles
 *  a caret test needs. `lnHtml` is the .ln innerHTML (tok-* spans + raw text,
 *  exactly as highlightCode emits); `collapsed` adds the .fold-ellipsis +
 *  .sr-only decorations OUTSIDE .ln (the GTD-3 hazard). */
function makeRow(lnHtml, { dataLine = 0, collapsed = false } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const doc = dom.window.document;
  const code = doc.createElement('div');
  code.className = 'code';
  const wrap = doc.createElement('span');
  wrap.className = 'ln-wrap';
  wrap.setAttribute('data-line', String(dataLine));
  const ln = doc.createElement('span');
  ln.className = 'ln';
  ln.innerHTML = lnHtml;
  wrap.appendChild(ln);
  if (collapsed) {
    const ell = doc.createElement('span');
    ell.className = 'fold-ellipsis';
    ell.textContent = ' ⋯';
    const sr = doc.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = '3 lines hidden';
    wrap.appendChild(ell);
    wrap.appendChild(sr);
  }
  code.appendChild(wrap);
  doc.body.appendChild(code);
  return { dom, doc, code, wrap, ln };
}

test('columnAt: a caret inside .ln sums preceding tok-* span text to the right 0-based column', async () => {
  const { columnAt } = await kit();
  // Render `const widget = make()` the way highlightCode would: `const` in a
  // .tok-kw span, then raw text. The caret lands inside `widget`.
  const { dom, ln } = makeRow(
    '<span class="tok-kw">const</span> widget = <span class="tok-fn">make</span>()',
  );
  try {
    // The original line round-trips via textContent.
    assert.equal(ln.textContent, 'const widget = make()');
    // Caret inside the raw text node " widget = " — find that text node and put
    // the caret 3 chars in (at the 'd' of widget). 'const' is 5 chars, then the
    // raw node begins with a space, so column = 5 (tok-kw) + 3 = 8.
    const rawNode = ln.childNodes[1]; // the " widget = " text node after .tok-kw
    assert.equal(rawNode.nodeType, 3, 'the second child is a text node');
    const res = columnAt(ln.closest('.code'), rawNode, 3);
    assert.ok(res, 'a caret inside .ln resolves');
    assert.equal(res.line, 1, '1-based line = data-line + 1');
    assert.equal(res.col, 8, 'preceding tok-kw text (5) + in-node offset (3)');
    assert.equal(res.lineText, 'const widget = make()', '.ln textContent round-trips');
    // The 0-based column points at the right char of the original line.
    assert.equal(res.lineText[res.col], 'd', 'column lands on the d of widget');
  } finally {
    dom.window.close();
  }
});

test('columnAt: a caret inside a later tok-fn span sums all preceding text', async () => {
  const { columnAt } = await kit();
  const { dom, ln } = makeRow(
    '<span class="tok-kw">const</span> widget = <span class="tok-fn">make</span>()',
  );
  try {
    const fnSpan = ln.querySelector('.tok-fn');
    const fnText = fnSpan.firstChild; // the "make" text node
    // Caret at offset 0 inside "make": preceding text is "const widget = " (15).
    const res = columnAt(ln.closest('.code'), fnText, 0);
    assert.ok(res);
    assert.equal(res.col, 15, 'all preceding text summed (const widget = )');
    assert.equal(res.lineText.slice(res.col, res.col + 4), 'make');
  } finally {
    dom.window.close();
  }
});

test('columnAt: GTD-3 — a caret on the collapsed-header decoration OUTSIDE .ln returns null', async () => {
  const { columnAt } = await kit();
  const { dom, wrap } = makeRow('<span class="tok-kw">if</span> (cond) {', {
    collapsed: true,
  });
  try {
    const code = wrap.closest('.code');
    // A caret on the .fold-ellipsis sibling (NOT inside .ln) must be rejected.
    const ell = wrap.querySelector('.fold-ellipsis');
    assert.equal(columnAt(code, ell.firstChild, 1), null, 'caret on .fold-ellipsis -> null');
    // And on the .sr-only "N lines hidden" decoration.
    const sr = wrap.querySelector('.sr-only');
    assert.equal(columnAt(code, sr.firstChild, 2), null, 'caret on .sr-only -> null');
    // Sanity: a caret INSIDE the same row's .ln still resolves (guard is precise).
    const ln = wrap.querySelector('.ln');
    const res = columnAt(code, ln.querySelector('.tok-kw').firstChild, 0);
    assert.ok(res, 'a caret inside .ln of a collapsed header still resolves');
    assert.equal(res.col, 0, 'col 0 at the start of the .ln');
  } finally {
    dom.window.close();
  }
});

test('columnAt: a caret outside the root, or a row without .ln, returns null', async () => {
  const { columnAt } = await kit();
  const { dom, code, doc } = makeRow('plain text');
  try {
    // A node OUTSIDE the .code root -> null.
    const stray = doc.createElement('div');
    stray.textContent = 'elsewhere';
    doc.body.appendChild(stray);
    assert.equal(columnAt(code, stray.firstChild, 1), null, 'a node outside root -> null');
    // A null container -> null (defensive).
    assert.equal(columnAt(code, null, 0), null, 'null container -> null');
  } finally {
    dom.window.close();
  }
});

test('columnAt: an offset past the text-node length clamps (never over-counts)', async () => {
  const { columnAt } = await kit();
  const { dom, ln } = makeRow('abc');
  try {
    const textNode = ln.firstChild; // "abc"
    // Offset 99 clamps to the node length (3).
    const res = columnAt(ln.closest('.code'), textNode, 99);
    assert.ok(res);
    assert.equal(res.col, 3, 'offset clamps to the text-node length');
  } finally {
    dom.window.close();
  }
});

/* ============================================================
 * TA-R2: resolveSelectionSymbol — the jsdom-reachable HALF of the F12 symbol-
 * resolution chain (selection -> live caret -> lastCaret). The 4th fallback
 * (topmost-visible .ln-wrap getBoundingClientRect scan) is jsdom-unfriendly
 * (every rect is 0) and stays inline in CodeView (e2e-only) — NOT tested here.
 * resolveSelectionSymbol accepts a SelectionLike, so a plain object referencing
 * the jsdom nodes drives it exactly as Electron's live Selection does.
 * ============================================================ */

/** A collapsed-caret SelectionLike at (node, offset). */
function caretSel(node, offset) {
  return {
    rangeCount: 1,
    isCollapsed: true,
    anchorNode: node,
    anchorOffset: offset,
    focusNode: node,
    focusOffset: offset,
    toString: () => '',
  };
}

/** A ranged SelectionLike from (anchorNode, anchorOffset) to (focusNode,
 *  focusOffset) whose toString() is `text`. */
function rangeSel(anchorNode, anchorOffset, focusNode, focusOffset, text) {
  return {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode,
    anchorOffset,
    focusNode,
    focusOffset,
    toString: () => text,
  };
}

test('resolveSelectionSymbol: a one-identifier selection inside ONE .ln resolves that identifier (LTR + RTL anchor)', async () => {
  const { resolveSelectionSymbol } = await kit();
  // `const widget = make()` — select the `widget` run (a single identifier).
  const { dom, ln, code } = makeRow(
    '<span class="tok-kw">const</span> widget = <span class="tok-fn">make</span>()',
  );
  try {
    const rawNode = ln.childNodes[1]; // " widget = " (the text node after .tok-kw)
    // `const`=5 chars (0-based cols 0..4); the raw node starts at col 5 with a
    // leading space, so `widget` is at 0-based cols 6..11. The selection endpoints
    // are offsets WITHIN the raw node: offset 1 = the 'w' (= 0-based col 6).
    // resolveSelectionSymbol reports the 1-based word-start column = 6 + 1 = 7.
    // LTR selection (anchor before focus).
    const ltr = rangeSel(rawNode, 1, rawNode, 7, 'widget');
    const a = resolveSelectionSymbol(code, ltr, null);
    assert.ok(a, 'LTR selection resolves');
    assert.equal(a.symbol, 'widget');
    assert.equal(a.line, 1);
    assert.equal(a.col, 7, 'GTD-CORR-2: reported col is the WORD START (1-based)');
    // RTL selection (anchor AFTER focus) — must report the SAME start column.
    const rtl = rangeSel(rawNode, 7, rawNode, 1, 'widget');
    const b = resolveSelectionSymbol(code, rtl, null);
    assert.ok(b, 'RTL selection resolves');
    assert.equal(b.symbol, 'widget');
    assert.equal(b.col, 7, 'GTD-CORR-2: RTL reports the same word-start column');
  } finally {
    dom.window.close();
  }
});

test('resolveSelectionSymbol: a multi-identifier selection falls back to the collapsed caret', async () => {
  const { resolveSelectionSymbol } = await kit();
  const { dom, ln, code } = makeRow('alpha beta gamma');
  try {
    const textNode = ln.firstChild; // "alpha beta gamma"
    // A selection of `alpha beta` (two identifiers) is NOT a single identifier,
    // so source (1) declines. With isCollapsed=false it cannot use source (2);
    // a TRUE multi-identifier selection therefore yields null here (no caret).
    const multi = rangeSel(textNode, 0, textNode, 10, 'alpha beta');
    assert.equal(resolveSelectionSymbol(code, multi, null), null, 'multi-identifier selection -> null');
    // But a COLLAPSED caret inside `beta` resolves it via source (2).
    const caret = caretSel(textNode, 7); // inside "beta" (offset 6..10)
    const res = resolveSelectionSymbol(code, caret, null);
    assert.ok(res, 'collapsed caret inside beta resolves');
    assert.equal(res.symbol, 'beta');
    assert.equal(res.col, 7, 'beta starts at 1-based column 7');
  } finally {
    dom.window.close();
  }
});

test('resolveSelectionSymbol: the lastCaret fallback resolves when there is no live selection', async () => {
  const { resolveSelectionSymbol } = await kit();
  const { dom, code } = makeRow('const token = 1', { dataLine: 4 });
  try {
    // No selection at all (null) -> source (3): the lastCaret on row data-line=4
    // (1-based line 5), 0-based column 8 (inside `token`, which starts at col 6).
    const res = resolveSelectionSymbol(code, null, { line: 5, col: 8 });
    assert.ok(res, 'lastCaret resolves a symbol');
    assert.equal(res.symbol, 'token');
    assert.equal(res.line, 5, 'the lastCaret line is honored');
    assert.equal(res.col, 7, 'token starts at 1-based column 7');
    // A lastCaret on whitespace (column 5, the space before `token`) -> null.
    assert.equal(resolveSelectionSymbol(code, null, { line: 5, col: 5 }), null, 'caret on whitespace -> null');
  } finally {
    dom.window.close();
  }
});

test('resolveSelectionSymbol: a selection spanning TWO .ln rows falls through (not source 1)', async () => {
  const { resolveSelectionSymbol } = await kit();
  // Two rows in one .code; a selection whose endpoints are in DIFFERENT .ln
  // elements must not be treated as a single-identifier selection.
  const dom = new (await import('jsdom')).JSDOM('<!DOCTYPE html><body></body>');
  const doc = dom.window.document;
  const code = doc.createElement('div');
  code.className = 'code';
  const mk = (txt, dl) => {
    const wrap = doc.createElement('span');
    wrap.className = 'ln-wrap';
    wrap.setAttribute('data-line', String(dl));
    const ln = doc.createElement('span');
    ln.className = 'ln';
    ln.textContent = txt;
    wrap.appendChild(ln);
    code.appendChild(wrap);
    return ln;
  };
  try {
    const ln0 = mk('foo', 0);
    const ln1 = mk('bar', 1);
    doc.body.appendChild(code);
    // anchor in ln0, focus in ln1 -> different .ln -> source (1) declines, and
    // isCollapsed=false blocks source (2), lastCaret null -> null.
    const cross = rangeSel(ln0.firstChild, 0, ln1.firstChild, 3, 'foo\nbar');
    assert.equal(resolveSelectionSymbol(code, cross, null), null, 'cross-row selection -> null');
  } finally {
    dom.window.close();
  }
});
