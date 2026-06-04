/* ============================================================
 * Loom — renderer click-guard suite (node --test + jsdom)
 * ------------------------------------------------------------
 * TIER-1 DOM harness for the renderer half of navigable-links. This
 * is an INTEGRATION test of (renderMarkdown -> guard): it renders the
 * REAL sanitized HTML the app emits, injects it into a real DOM
 * (jsdom), installs the REAL installGlobalAnchorGuard(), dispatches
 * real mouse/keyboard events, and asserts the guard's behavior:
 *
 *   - a VETTED external link (data-loom-ext='1') opens in the browser
 *     via window.loom.openExternal, with the default prevented;
 *   - a NEUTRALIZED link is blocked (no openExternal) but in-app nav is
 *     still prevented;
 *   - keyboard Enter/Space activate the same as a click;
 *   - an anchor OUTSIDE RENDERED_MARKDOWN_SELECTOR is ignored entirely
 *     (no openExternal, no preventDefault);
 *   - a click on a child node nested inside the anchor still resolves
 *     via closest('a').
 *
 * Each case is constructed so it would FAIL if the guard logic broke —
 * e.g. the data-loom-ext gate, the selector scoping, the capture-phase
 * preventDefault, or the keyboard-key filter.
 *
 * The bundled guard references `document` / `window` / `KeyboardEvent`
 * as bare globals, so we install jsdom's globals (and its event
 * constructors — `instanceof KeyboardEvent` must see the SAME ctor we
 * dispatch with) on globalThis before invoking the guard.
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

/** Build a fresh jsdom window and install the DOM globals the bundled guard
 *  reads as bare identifiers (document / window / Event constructors). The
 *  event constructors must be the SAME ones we dispatch with, so the guard's
 *  `e instanceof KeyboardEvent` check matches. Returns the window plus an
 *  openExternal spy, a track() to register the guard's unsubscribe, and a
 *  restore() that ALWAYS tears down the guard + globals + window — even when
 *  it runs from a `finally` after an assertion threw, so no jsdom global (or
 *  live guard listener) can leak into the next test and cause order-dependent
 *  flakiness. */
function makeDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://loom.test/',
  });
  const { window } = dom;

  const calls = [];
  const openExternal = (url) => {
    calls.push(url);
    return Promise.resolve();
  };
  window.loom = { openExternal };

  // Snapshot any pre-existing globals so we can restore them after the test.
  const KEYS = [
    'window', 'document', 'Event', 'MouseEvent', 'KeyboardEvent',
    'HTMLElement', 'Element', 'Node',
  ];
  const saved = {};
  for (const k of KEYS) saved[k] = globalThis[k];

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Event = window.Event;
  globalThis.MouseEvent = window.MouseEvent;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;

  // Guard unsubscribes registered via track(); restore() runs them all so the
  // guard's listeners are torn down even if the test body throws first.
  const offs = [];
  /** Register the guard's unsubscribe so teardown is guaranteed-on-throw. */
  const track = (off) => {
    offs.push(off);
    return off;
  };

  const restore = () => {
    // Unsubscribe every installed guard first; isolate failures so one bad
    // off() cannot skip the global/window teardown below.
    while (offs.length) {
      const off = offs.pop();
      try { off(); } catch { /* already torn down — ignore */ }
    }
    for (const k of KEYS) {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    }
    window.close();
  };

  return { window, calls, track, restore };
}

/** Mount sanitized HTML inside a container with `className`, append it to the
 *  body, and return the container. */
function mount(window, className, html) {
  const container = window.document.createElement('div');
  container.className = className;
  container.innerHTML = html;
  window.document.body.appendChild(container);
  return container;
}

/** Dispatch a real bubbling, cancelable click on `el`; return the event so the
 *  caller can read defaultPrevented (the guard runs in the CAPTURE phase). */
function clickOn(window, el) {
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

/** Dispatch a real bubbling, cancelable keydown with `key` on `el`. */
function keyOn(window, el, key) {
  const ev = new window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(ev);
  return ev;
}

/* ------------------------------------------------------------------ *
 * a. SAFE link inside `.md` -> click -> openExternal(href), prevented *
 * ------------------------------------------------------------------ */
test('GUARD a: a SAFE link in .md opens externally on click (default prevented)', async () => {
  const { renderMarkdown, installGlobalAnchorGuard } = await kit();
  const { window, calls, track, restore } = makeDom();
  try {
    const html = renderMarkdown('[x](http://example.com)');
    // The renderer must have produced a vetted external link to begin with.
    assert.match(html, /data-loom-ext="1"/, 'precondition: renderer marked it external');
    const container = mount(window, 'md', html);
    const off = track(installGlobalAnchorGuard());

    const anchor = container.querySelector('a');
    assert.ok(anchor, 'an anchor was rendered');
    const expected = anchor.getAttribute('href'); // the NORMALIZED href
    assert.equal(expected, 'http://example.com/', 'href is the normalized URL');

    const ev = clickOn(window, anchor);
    assert.equal(calls.length, 1, 'openExternal called exactly once');
    assert.equal(calls[0], expected, 'called with the normalized href');
    assert.equal(ev.defaultPrevented, true, 'in-app navigation default prevented');
    off();
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * b. NEUTRALIZED link inside `.md` -> click -> blocked, but prevented *
 * ------------------------------------------------------------------ *
 * There are TWO neutralization outcomes and this case proves BOTH:
 *   b1. A dangerous SCHEME (`javascript:`) is rejected by markdown-it's
 *       own validateLink BEFORE our rule runs, so it renders as INERT
 *       TEXT — no <a> at all, nothing the browser can ever activate
 *       (the strongest neutralization). We assert no anchor exists.
 *   b2. A target our linkOpenRule drops (here the classic
 *       `legit.com@evil.com` userinfo spoof) DOES render as an <a>, but
 *       with NO data-loom-ext. THIS is the case that exercises the
 *       guard's data-loom-ext gate: it preventDefault()s (no in-app
 *       nav) yet must NOT call openExternal. If the gate were broken
 *       (e.g. opened on any anchor), this case fails.
 *
 * The data-loom-ext GATE isolation is its OWN test below (`GUARD
 * b-gate`), not a third sub-assertion here: b2's dropped-href anchor
 * cannot catch a broken gate (it has no href to open anyway), so the
 * gate needs an href-bearing-but-ungated anchor. Keeping it separate
 * means a b1/b2 RENDER-precondition regression (renderer behavior
 * change) localizes here and can never mask — by aborting first — the
 * gate's mutation coverage below. */
test('GUARD b: a NEUTRALIZED link in .md is blocked (no open) but default prevented', async () => {
  const { renderMarkdown, installGlobalAnchorGuard } = await kit();
  const { window, calls, track, restore } = makeDom();
  try {
    // b1 — dangerous scheme: no anchor is produced at all (inert text).
    const jsHtml = renderMarkdown('[x](javascript:alert(1))');
    assert.doesNotMatch(jsHtml, /<a\b/i, 'a javascript: link renders as inert text, no <a>');
    assert.doesNotMatch(jsHtml, /data-loom-ext/, 'and is certainly not marked external');

    // b2 — an anchor the guard SEES but must refuse to open (no data-loom-ext).
    const html = renderMarkdown('[x](http://legit.com@evil.com/)');
    assert.match(html, /<a\b/i, 'precondition: an anchor IS rendered for the spoof');
    assert.doesNotMatch(html, /data-loom-ext/, 'precondition: NOT marked external');
    const container = mount(window, 'md', html);
    const off = track(installGlobalAnchorGuard());

    const anchor = container.querySelector('a');
    assert.ok(anchor, 'an inert anchor was rendered');
    assert.equal(anchor.getAttribute('href'), null, 'a dropped-href anchor has no href');

    const ev = clickOn(window, anchor);
    assert.equal(calls.length, 0, 'openExternal NOT called for a neutralized link');
    assert.equal(ev.defaultPrevented, true, 'still no in-app navigation');
    off();
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * b-gate. ISOLATE the data-loom-ext GATE itself.                     *
 * ------------------------------------------------------------------ *
 * This is the assertion that actually catches a removed data-loom-ext
 * gate, so it gets its OWN test: an anchor that DOES carry a real,
 * would-be-safe href but is NOT marked external (no data-loom-ext),
 * mounted inside the watched `.md` container. The guard must STILL
 * refuse to open it — only data-loom-ext='1' is openable — while still
 * preventing in-app navigation. If the gate were removed (open any
 * anchor with an href), this FAILS. Built on its own fresh DOM so its
 * mutation coverage is independent of the b1/b2 render preconditions:
 * a renderer-behavior change cannot abort the test before this gate
 * check runs. */
test('GUARD b-gate: an href-bearing anchor WITHOUT data-loom-ext is never opened (the gate)', async () => {
  const { installGlobalAnchorGuard } = await kit();
  const { window, calls, track, restore } = makeDom();
  try {
    // Mount an EMPTY watched container, then craft the ungated anchor directly —
    // no renderer involved, so this gate check stands on its own.
    const container = mount(window, 'md', '');
    const off = track(installGlobalAnchorGuard());

    const gateAnchor = window.document.createElement('a');
    gateAnchor.setAttribute('href', 'http://example.com/'); // a real, would-be-safe href
    gateAnchor.textContent = 'ungated';
    container.appendChild(gateAnchor);

    const gateEv = clickOn(window, gateAnchor);
    assert.equal(calls.length, 0, 'an anchor WITHOUT data-loom-ext is never opened (the gate)');
    assert.equal(gateEv.defaultPrevented, true, 'but in-app nav is still prevented');
    off();
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * c. keyboard Enter on a focused safe link -> openExternal           *
 * ------------------------------------------------------------------ */
test('GUARD c: keyboard Enter on a safe link opens externally', async () => {
  const { renderMarkdown, installGlobalAnchorGuard } = await kit();
  const { window, calls, track, restore } = makeDom();
  try {
    const container = mount(window, 'md', renderMarkdown('[x](https://example.org/a)'));
    const off = track(installGlobalAnchorGuard());
    const anchor = container.querySelector('a');

    const ev = keyOn(window, anchor, 'Enter');
    assert.equal(calls.length, 1, 'Enter activates the link');
    assert.equal(calls[0], anchor.getAttribute('href'), 'with the normalized href');
    assert.equal(ev.defaultPrevented, true, 'default prevented on Enter');
    off();
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * d. keyboard Space (' ') on a safe link -> openExternal             *
 * ------------------------------------------------------------------ */
test('GUARD d: keyboard Space on a safe link opens externally', async () => {
  const { renderMarkdown, installGlobalAnchorGuard } = await kit();
  const { window, calls, track, restore } = makeDom();
  try {
    const container = mount(window, 'md', renderMarkdown('[x](https://example.org/b)'));
    const off = track(installGlobalAnchorGuard());
    const anchor = container.querySelector('a');

    const ev = keyOn(window, anchor, ' ');
    assert.equal(calls.length, 1, 'Space activates the link');
    assert.equal(ev.defaultPrevented, true, 'default prevented on Space');

    // Sanity: a non-activation key (e.g. "a") must NOT activate the link — the
    // guard's key filter would be broken if it did.
    const ev2 = keyOn(window, anchor, 'a');
    assert.equal(calls.length, 1, 'a non-activation key does not open or re-fire');
    assert.equal(ev2.defaultPrevented, false, 'non-activation key not consumed');
    off();
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * e. a safe link OUTSIDE the selector -> ignored entirely            *
 * ------------------------------------------------------------------ */
test('GUARD e: a safe link OUTSIDE the rendered-markdown selector is ignored', async () => {
  const { renderMarkdown, installGlobalAnchorGuard } = await kit();
  const { window, calls, track, restore } = makeDom();
  try {
    // Same vetted-external HTML, but in a container the guard does not watch.
    const html = renderMarkdown('[x](http://example.com)');
    assert.match(html, /data-loom-ext="1"/, 'precondition: it IS a vetted link');
    const container = mount(window, 'other', html);
    const off = track(installGlobalAnchorGuard());
    const anchor = container.querySelector('a');

    const ev = clickOn(window, anchor);
    assert.equal(calls.length, 0, 'an anchor outside the selector is not opened');
    assert.equal(ev.defaultPrevented, false, 'and its default is NOT prevented (ignored)');
    off();
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * f. a click on a CHILD of the anchor -> closest('a') resolves       *
 * ------------------------------------------------------------------ */
test('GUARD f: clicking a child element inside the anchor resolves via closest()', async () => {
  const { renderInline, installGlobalAnchorGuard } = await kit();
  const { window, calls, track, restore } = makeDom();
  try {
    // Exercise the chat path (`.msg-body`) AND a nested descendant target:
    // a bold span inside the link, so event.target is a CHILD of the anchor.
    const html = renderInline('[**bold**](https://example.net/c)');
    const container = mount(window, 'msg-body', html);
    const off = track(installGlobalAnchorGuard());

    const anchor = container.querySelector('a');
    assert.ok(anchor, 'a .msg-body anchor was rendered');
    const inner = anchor.querySelector('strong') ?? anchor.firstElementChild;
    assert.ok(inner, 'the anchor has a nested child element to click');
    assert.notEqual(inner, anchor, 'the click target is a descendant, not the anchor');

    const ev = clickOn(window, inner);
    assert.equal(calls.length, 1, 'closest("a") resolves from a descendant target');
    assert.equal(calls[0], anchor.getAttribute('href'), 'opens the anchor href');
    assert.equal(ev.defaultPrevented, true, 'default prevented');
    off();
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * Cleanup proof: the unsubscribe actually removes the listeners, so  *
 * cases cannot bleed into each other.                                *
 * ------------------------------------------------------------------ */
test('GUARD: the returned unsubscribe removes the listeners (no bleed)', async () => {
  const { renderMarkdown, installGlobalAnchorGuard } = await kit();
  const { window, calls, track, restore } = makeDom();
  try {
    const container = mount(window, 'md', renderMarkdown('[x](http://example.com)'));
    const off = track(installGlobalAnchorGuard());
    off(); // uninstall immediately

    const anchor = container.querySelector('a');
    const ev = clickOn(window, anchor);
    assert.equal(calls.length, 0, 'after unsubscribe, the guard no longer fires');
    assert.equal(ev.defaultPrevented, false, 'and no longer prevents default');
  } finally {
    restore();
  }
});
