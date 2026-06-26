/* ============================================================
 * Loom — token presentation formatters (node --test)
 * ------------------------------------------------------------
 * Pins the PURE formatters the TokenUsagePanel table uses (lib/format.ts):
 *   - formatTokens: grouped integer ("1,234,567"), truncation, and the
 *                   defensive "0" floor for non-finite / negative input.
 *   - formatCost:   "$X.XX" with a 2-decimal floor, the em-dash ("—") for
 *                   null/undefined/non-finite, and a signed-negative case.
 * Hermetic + display-free: imports the dist/testkit.cjs bundle (built by
 * `npm run build`), mirroring test/tokens.mjs's kit() loader. No DOM/Electron.
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

test('formatTokens groups thousands with commas', async () => {
  const { formatTokens } = await kit();
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(42), '42');
  assert.equal(formatTokens(1000), '1,000');
  assert.equal(formatTokens(1234567), '1,234,567');
});

test('formatTokens truncates fractions and floors garbage to "0"', async () => {
  const { formatTokens } = await kit();
  assert.equal(formatTokens(1234.99), '1,234');
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens(Number.NaN), '0');
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), '0');
});

test('formatCost renders "$X.XX" with two decimals', async () => {
  const { formatCost } = await kit();
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(1.5), '$1.50');
  assert.equal(formatCost(12.345), '$12.35');
  assert.equal(formatCost(-2.5), '-$2.50');
});

test('formatCost renders an em-dash for null/undefined/non-finite', async () => {
  const { formatCost } = await kit();
  assert.equal(formatCost(null), '—');
  assert.equal(formatCost(undefined), '—');
  assert.equal(formatCost(Number.NaN), '—');
});
