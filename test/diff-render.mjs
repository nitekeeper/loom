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
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';

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

/* ------------------------------------------------------------------ *
 * ChangesView header Split toggle (M2 — the composable diff+file split). *
 * The ONLY header-level affordance that surfaces the new diff+file       *
 * capability, so its aria-pressed correctness + label-in-name must be    *
 * pinned. ChangesView is hook-free in its loading/unavailable/empty      *
 * states (no <FileDiff> children, which carry useState), so it SSRs      *
 * cleanly via renderToStaticMarkup under the testkit's bundled React.    *
 * ------------------------------------------------------------------ */
test('DIFF-RENDER ChangesView Split toggle: aria-pressed tracks splitView, label-in-name holds, icon present', async () => {
  const { ChangesView } = await kit();
  // Empty (clean working tree) state ⇒ no FileDiff children ⇒ hook-free SSR.
  const emptyChanges = { available: true, base: 'main', files: [] };
  const noop = () => {};

  // Split OFF ⇒ aria-pressed="false".
  const offHtml = renderToStaticMarkup(
    React.createElement(ChangesView, {
      changes: emptyChanges,
      onClose: noop,
      splitView: false,
      onToggleSplit: noop,
    }),
  );
  // The Split toggle exists and carries its mirrored class + icon. Match by
  // TOKEN presence in the class list (not the exact byte-identical attribute
  // string) so a benign refactor — adding a class, reordering, interleaving an
  // attribute — does not turn this RED; the meaningful contract is "the diff-pane
  // Split toggle (.changes-split-btn) is present", not the className ordering.
  assert.match(offHtml, /class="[^"]*\bchanges-split-btn\b[^"]*"/, 'the ChangesView header Split toggle is present');
  assert.match(offHtml, /class="[^"]*\bsplit-view-btn\b[^"]*"/, 'it carries the shared split-view-btn affordance class');
  assert.match(offHtml, /<svg[^>]*>[\s\S]*<\/svg>/, 'the mirrored SplitIcon is rendered');
  // aria-pressed reflects split OFF.
  assert.match(offHtml, /aria-pressed="false"/, 'split OFF ⇒ aria-pressed="false"');
  // SC 2.5.3 label-in-name: the visible text "Split" is the accessible name (no
  // aria-label override on this button, so the visible <span>Split</span> IS the
  // name) — pin the visible label is present.
  assert.match(offHtml, /<span>Split<\/span>/, 'visible text "Split" present (= accessible name, label-in-name)');

  // Split ON ⇒ aria-pressed="true" (the diff+file split is rendered).
  const onHtml = renderToStaticMarkup(
    React.createElement(ChangesView, {
      changes: emptyChanges,
      onClose: noop,
      splitView: true,
      onToggleSplit: noop,
    }),
  );
  assert.match(onHtml, /aria-pressed="true"/, 'split ON ⇒ aria-pressed="true" (diff+file split rendered)');
  // The toggle has NO per-pane aria-label (unlike the duplicated Viewer toggles)
  // — it is the single diff-pane control, so its accessible name stays the bare
  // visible "Split". Assert no aria-label is emitted on the changes Split button.
  // Key off the .changes-split-btn token (not the exact class string) so the
  // button is found regardless of class ordering / added attributes.
  const changesBtn = onHtml.match(/<button[^>]*\bchanges-split-btn\b[^>]*>/);
  assert.ok(changesBtn, 'the changes Split button tag is found');
  assert.doesNotMatch(changesBtn[0], /aria-label=/, 'the single diff Split toggle keeps its visible-text name (no aria-label)');
  // ACTIVATION CONTRACT (req #1): it is a real <button type="button"> so a click,
  // Enter, and Space all natively activate its onClick (= onToggleSplit), and
  // type="button" keeps it from submitting any ancestor form. renderToStaticMarkup
  // cannot DISPATCH a click, so the actual onClick -> onToggleSplit FIRING is
  // asserted in the dedicated click test BELOW (a real react-dom/client mount +
  // dispatched click), not here. (tests-finding: the prior rationale assumed a
  // react-dom/client mount would mismatch the bundled React; it does NOT for this
  // hook-free shell — `react.element` is a globally-REGISTERED Symbol.for, so the
  // node_modules react-dom mounts the bundle's element tree and wires its events.)
  assert.match(changesBtn[0], /\btype="button"/, 'the diff Split toggle is a type="button" control (native click/Enter/Space activation)');
});

/* ------------------------------------------------------------------ *
 * ChangesView Split toggle — ONCLICK WIRING (req #1).                 *
 * The structural test above proves the button exists + carries the    *
 * right aria/label/type; THIS one proves its onClick is actually wired *
 * to the onToggleSplit prop (a regression that dropped the handler or  *
 * wired it to onClose would pass every structural assertion yet break  *
 * the feature, tests-finding). ChangesView's empty state is hook-free, *
 * so a real react-dom/client mount works even though the testkit       *
 * bundles its OWN React: a React element is tagged with                *
 * Symbol.for('react.element') (a GLOBAL registry symbol, identical     *
 * across instances), so the node_modules react-dom recognizes + mounts *
 * the bundled element tree and attaches its event handlers. The click  *
 * is dispatched as a real DOM MouseEvent and the passed spy must fire  *
 * EXACTLY once — and only for the Split button, never onClose.         *
 * ------------------------------------------------------------------ */
test('DIFF-RENDER ChangesView Split toggle: a click invokes onToggleSplit (NOT onClose) — onClick wiring (req #1)', async () => {
  const { ChangesView } = await kit();
  const emptyChanges = { available: true, base: 'main', files: [] };

  // A fresh jsdom document for this mount (the suite is otherwise DOM-free; this
  // single test owns its own window so it never leaks globals to the others).
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let toggleFired = 0;
  let closeFired = 0;
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        React.createElement(ChangesView, {
          changes: emptyChanges,
          onClose: () => {
            closeFired += 1;
          },
          splitView: false,
          onToggleSplit: () => {
            toggleFired += 1;
          },
        }),
      );
    });

    const btn = container.querySelector('.changes-split-btn');
    assert.ok(btn, 'the Split toggle is mounted');
    assert.equal(btn.tagName, 'BUTTON', 'it is a real <button>');

    await act(async () => {
      btn.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    assert.equal(toggleFired, 1, 'a click invokes onToggleSplit exactly once');
    assert.equal(closeFired, 0, 'the click does NOT invoke onClose (correct handler wired)');
  } finally {
    await act(async () => {
      root.unmount();
    });
    // Restore the prior globals so the rest of the (DOM-free) suite is untouched.
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    globalThis.navigator = prev.navigator;
    globalThis.IS_REACT_ACT_ENVIRONMENT = prev.actEnv;
  }
});

test('DIFF-RENDER ChangesView Split toggle: present in EVERY terminal state (loading / unavailable / empty)', async () => {
  const { ChangesView } = await kit();
  const noop = () => {};
  // The header (and its Split toggle) is shared by all three hook-free states so
  // the diff+file split is reachable from the header regardless of git state.
  const states = [
    null, // loading
    { available: false, base: '', files: [] }, // not a git repo
    { available: true, base: 'main', files: [] }, // clean working tree
  ];
  for (const changes of states) {
    const html = renderToStaticMarkup(
      React.createElement(ChangesView, {
        changes,
        onClose: noop,
        splitView: false,
        onToggleSplit: noop,
      }),
    );
    assert.match(
      html,
      /class="[^"]*\bchanges-split-btn\b[^"]*"/,
      `Split toggle present for changes=${JSON.stringify(changes)}`,
    );
  }
});
