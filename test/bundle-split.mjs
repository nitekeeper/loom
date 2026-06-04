/* ============================================================
 * Loom — BUILD-OUTPUT GUARD: the mermaid lazy-chunk split holds
 * ------------------------------------------------------------
 * Proves the bundle topology the lazy-mermaid optimization depends on, so a
 * FUTURE accidental static import (e.g. someone re-imports lib/mermaid-render
 * directly from the renderer, or makes lib/mermaid-loader statically import the
 * mermaid graph) FAILS LOUDLY here instead of silently re-inflating the startup
 * bundle by ~7-8MB.
 *
 * THE INVARIANTS:
 *   - dist/mermaid.js EXISTS and is LARGE (the mermaid library lives there).
 *   - dist/renderer.js does NOT contain mermaid-LIBRARY-INTERNAL signatures.
 *   - dist/testkit.cjs (the Node test bundle) is mermaid-free too.
 *   - NEITHER renderer.js NOR mermaid.js contains eval( / new Function( (the
 *     CSP has no 'unsafe-eval'; both run under script-src 'self').
 *   - dist/index.html carries NO static mermaid <script> tag (load stays lazy).
 *
 * SIGNATURE CHOICE (critical): grepping renderer.js for the bare word "mermaid"
 * would FALSE-MATCH lib/markdown.ts's own placeholder class names
 * (.mermaid-diagram / .mermaid-src) and lib/mermaid-loader.ts's own code — both
 * of which legitimately ship in renderer.js and are mermaid-FREE. So we assert on
 * mermaid-LIBRARY-INTERNAL tokens that appear ONLY if the library itself were
 * bundled: 'flowchart-v2' (a diagram-type id) and 'sequenceDiagram' (a parser
 * keyword). Neither appears anywhere in src/, so a hit in renderer.js means the
 * mermaid library leaked into the startup bundle — exactly the regression to
 * catch. (We verify they DO appear in mermaid.js so the signatures stay valid if
 * mermaid is bumped — a future rename that broke the signature is caught here.)
 *
 * Requires a prior `npm run build` (CI builds before `npm test`); a missing
 * artifact fails with a clear, actionable message rather than a confusing absence.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(root, 'dist');
const RENDERER = path.join(DIST, 'renderer.js');
const MERMAID = path.join(DIST, 'mermaid.js');
const TESTKIT = path.join(DIST, 'testkit.cjs');
const INDEX_HTML = path.join(DIST, 'index.html');

/** Read a built artifact, failing with an actionable message if it is absent
 *  (the build did not run). Reading the whole file is fine — these are bundles
 *  we already load wholesale elsewhere in the suite. */
function readDist(file) {
  if (!existsSync(file)) {
    throw new Error(
      `${path.relative(root, file)} not found — run \`npm run build\` before \`npm test\`.`,
    );
  }
  return readFileSync(file, 'utf8');
}

// mermaid-LIBRARY-INTERNAL signatures (NOT Loom's placeholder class names). See
// the header note: these appear ONLY if the mermaid library itself is bundled.
const MERMAID_LIB_SIGNATURES = ['flowchart-v2', 'sequenceDiagram'];

test('bundle-split: dist/mermaid.js exists and is large (the mermaid library lives there)', () => {
  assert.ok(existsSync(MERMAID), 'dist/mermaid.js must exist — run `npm run build`');
  const bytes = statSync(MERMAID).size;
  // mermaid 11 is ~7MB. A floor of 2MB is comfortably above any plausible empty/
  // stub bundle yet well below the real size, so a broken build that emitted a
  // near-empty mermaid.js (mermaid failed to bundle) fails here.
  assert.ok(
    bytes > 2_000_000,
    `dist/mermaid.js is ${bytes} bytes — expected > 2MB (the mermaid library); the lazy chunk did not bundle mermaid`,
  );
});

test('bundle-split: dist/mermaid.js DOES contain the mermaid-library signatures (keeps the guard valid)', () => {
  const js = readDist(MERMAID);
  for (const sig of MERMAID_LIB_SIGNATURES) {
    assert.ok(
      js.includes(sig),
      `expected mermaid-library signature "${sig}" in dist/mermaid.js — if a mermaid bump removed it, pick a new live signature so the renderer.js guard below stays meaningful`,
    );
  }
});

test('bundle-split: dist/renderer.js is FREE of mermaid-library signatures (mermaid is NOT in the startup bundle)', () => {
  const js = readDist(RENDERER);
  for (const sig of MERMAID_LIB_SIGNATURES) {
    assert.ok(
      !js.includes(sig),
      `mermaid-library signature "${sig}" leaked into dist/renderer.js — a static import dragged the mermaid library back into the startup bundle (it must load lazily via dist/mermaid.js)`,
    );
  }
});

test('bundle-split: dist/renderer.js DOES still carry the lazy loader (loader inlined, mermaid-free)', () => {
  const js = readDist(RENDERER);
  // The mermaid-FREE loader is part of the renderer IIFE (it is dynamic-imported
  // by the Viewer, and esbuild — which cannot code-split IIFE — inlines it). Its
  // presence here, alongside ZERO mermaid-library signatures above, is the proof
  // the split is correct: the renderer can REACH mermaid lazily without CONTAINING
  // it. The hardcoded chunk src literal must be exactly './mermaid.js'.
  assert.ok(js.includes('ensureMermaid'), 'the lazy loader (ensureMermaid) must be inlined in renderer.js');
  assert.ok(
    js.includes('./mermaid.js'),
    'renderer.js must reference the fixed lazy-chunk src literal "./mermaid.js"',
  );
});

test('bundle-split: dist/testkit.cjs (Node test bundle) is mermaid-free', () => {
  const js = readDist(TESTKIT);
  for (const sig of MERMAID_LIB_SIGNATURES) {
    assert.ok(
      !js.includes(sig),
      `mermaid-library signature "${sig}" leaked into dist/testkit.cjs — testkit must never pull mermaid (it would drag a browser-only lib into the Node test bundle)`,
    );
  }
});

test('bundle-split: NO eval( / new Function( in renderer.js OR mermaid.js (CSP has no unsafe-eval)', () => {
  for (const [name, file] of [
    ['renderer.js', RENDERER],
    ['mermaid.js', MERMAID],
  ]) {
    const js = readDist(file);
    assert.ok(!js.includes('eval('), `dist/${name} must contain no eval( — CSP forbids 'unsafe-eval'`);
    assert.ok(
      !js.includes('new Function('),
      `dist/${name} must contain no new Function( — CSP forbids 'unsafe-eval'`,
    );
  }
});

test('bundle-split: dist/index.html has NO static mermaid <script> tag (load stays lazy)', () => {
  const html = readDist(INDEX_HTML);
  // The only script tag is ./renderer.js. mermaid.js must be injected lazily by
  // the loader, never statically referenced here — a static tag would eagerly
  // load the 7MB chunk at startup, defeating the split.
  assert.ok(
    !/mermaid\.js/.test(html),
    'dist/index.html must NOT statically reference mermaid.js — it is injected lazily by lib/mermaid-loader.ts',
  );
});
