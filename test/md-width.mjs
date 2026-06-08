/* ============================================================
 * Loom — md-width unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE width-mode resolution behind the Viewer's RENDERED
 * (.md) reading column: the `?mdwidth=full|fit` capture-hint parse,
 * the localStorage coercion, and the hint>stored>default ('fit')
 * precedence. DOM-free: exercises parseMdWidthHint / coerceStoredMdWidth /
 * resolveInitialMdWidth from the testkit bundle (the impure
 * readInitialMdWidth/persistMdWidth wrappers are NOT tested here — they
 * only touch location/localStorage, proven indirectly by the e2e hint).
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

test('MD-WIDTH: the default is the predefined "fit" measure', async () => {
  const { MD_WIDTH_DEFAULT, resolveInitialMdWidth } = await kit();
  assert.equal(MD_WIDTH_DEFAULT, 'fit');
  // Nothing supplied (no hint, no stored) ⇒ default.
  assert.equal(resolveInitialMdWidth(null, null), 'fit');
});

test('MD-WIDTH: the localStorage key is stable (sticky across restarts)', async () => {
  const { MD_WIDTH_KEY } = await kit();
  assert.equal(MD_WIDTH_KEY, 'loom.viewer.mdWidth');
});

test('MD-WIDTH: hint parses "full" and "fit" from the query string', async () => {
  const { parseMdWidthHint } = await kit();
  assert.equal(parseMdWidthHint('?mdwidth=full'), 'full');
  assert.equal(parseMdWidthHint('?mdwidth=fit'), 'fit');
  // A leading-`?`-less search and extra params still resolve the value.
  assert.equal(parseMdWidthHint('mdwidth=full'), 'full');
  assert.equal(parseMdWidthHint('?foo=1&mdwidth=fit&bar=2'), 'fit');
});

test('MD-WIDTH: hint returns null when absent so stored/default take over', async () => {
  const { parseMdWidthHint } = await kit();
  assert.equal(parseMdWidthHint(null), null);
  assert.equal(parseMdWidthHint(''), null);
  assert.equal(parseMdWidthHint('?other=1'), null);
});

test('MD-WIDTH: an INVALID hint value is treated as absent (null), never a guess', async () => {
  const { parseMdWidthHint } = await kit();
  for (const bad of [
    '?mdwidth=',
    '?mdwidth=wide',
    '?mdwidth=120ch',
    '?mdwidth=FULL', // case-sensitive: only the lowercase set is valid
    '?mdwidth=1',
    '?mdwidth=true',
  ]) {
    assert.equal(parseMdWidthHint(bad), null, `hint ${bad} must be null`);
  }
});

test('MD-WIDTH: stored coercion accepts the valid set', async () => {
  const { coerceStoredMdWidth } = await kit();
  assert.equal(coerceStoredMdWidth('full'), 'full');
  assert.equal(coerceStoredMdWidth('fit'), 'fit');
});

test('MD-WIDTH: stored coercion rejects unset/garbage (⇒ null so default applies)', async () => {
  const { coerceStoredMdWidth } = await kit();
  for (const bad of [null, '', 'wide', 'FULL', '120ch', '1', 'true', '{}', 'fit ']) {
    assert.equal(coerceStoredMdWidth(bad), null, `stored ${JSON.stringify(bad)} must be null`);
  }
});

test('MD-WIDTH: precedence is hint > stored > default', async () => {
  const { resolveInitialMdWidth } = await kit();
  // Hint wins over a conflicting stored value (capture determinism).
  assert.equal(resolveInitialMdWidth('full', 'fit'), 'full');
  assert.equal(resolveInitialMdWidth('fit', 'full'), 'fit');
  // No hint ⇒ stored wins over the default.
  assert.equal(resolveInitialMdWidth(null, 'full'), 'full');
  assert.equal(resolveInitialMdWidth(null, 'fit'), 'fit');
  // Neither ⇒ the 'fit' default.
  assert.equal(resolveInitialMdWidth(null, null), 'fit');
});

test('MD-WIDTH: the parse→coerce→resolve chain is consistent end to end', async () => {
  const { parseMdWidthHint, coerceStoredMdWidth, resolveInitialMdWidth } = await kit();
  // A `?mdwidth=full` capture over a 'fit'-persisted user ⇒ full (e2e boots full).
  const hint = parseMdWidthHint('?mdwidth=full');
  const stored = coerceStoredMdWidth('fit');
  assert.equal(resolveInitialMdWidth(hint, stored), 'full');
  // No capture, garbage in storage ⇒ the default, never a thrown/odd value.
  assert.equal(
    resolveInitialMdWidth(parseMdWidthHint('?x=1'), coerceStoredMdWidth('garbage')),
    'fit',
  );
});
