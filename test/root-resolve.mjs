/* ============================================================
 * Loom — sandbox-root precedence unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE root-precedence decision (src/main/root-resolve.ts → chooseRoot)
 * that backs main.ts resolveRoot. This is the bug fix's core invariant: the
 * EXPLICIT positional folder argument (`loom .` / `loom <dir>`) takes priority
 * OVER the ambient LOOM_ROOT env var, so a stale/inherited LOOM_ROOT can never
 * make `loom .` silently reopen the parent's folder.
 *
 * Coverage:
 *   - argvFolder wins over envRoot (both present) — the regression guard;
 *   - envRoot used when argvFolder is null — LOOM_ROOT still honored for the
 *     bin/loom.cjs launcher + --capture path (no positional arg);
 *   - null when both are null — the caller then falls back to picker/cwd;
 *   - argvFolder alone is returned when envRoot is null.
 *
 * DOM-free + Electron-free: exercises chooseRoot from the testkit bundle.
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

test('ROOT-PRECEDENCE: an explicit positional argv folder WINS over LOOM_ROOT (the bug fix)', async () => {
  const { chooseRoot } = await kit();
  // The reproduced bug: a stale/inherited LOOM_ROOT (/tmp/prev) must NOT override
  // the folder the user explicitly named on argv (/tmp/cur).
  assert.equal(
    chooseRoot({ argvFolder: '/tmp/cur', envRoot: '/tmp/prev' }),
    '/tmp/cur',
  );
});

test('ROOT-PRECEDENCE: LOOM_ROOT is used when there is NO positional argv folder', async () => {
  const { chooseRoot } = await kit();
  // The launcher + --capture contract: bin/loom.cjs passes the root ONLY via
  // LOOM_ROOT (no positional), so an absent argvFolder must still honor it.
  assert.equal(
    chooseRoot({ argvFolder: null, envRoot: '/tmp/prev' }),
    '/tmp/prev',
  );
});

test('ROOT-PRECEDENCE: argvFolder alone is returned when LOOM_ROOT is unset', async () => {
  const { chooseRoot } = await kit();
  assert.equal(chooseRoot({ argvFolder: '/tmp/cur', envRoot: null }), '/tmp/cur');
});

test('ROOT-PRECEDENCE: null when BOTH candidates are absent (caller falls back to picker/cwd)', async () => {
  const { chooseRoot } = await kit();
  assert.equal(chooseRoot({ argvFolder: null, envRoot: null }), null);
});

test('ROOT-PRECEDENCE: chooseRoot is re-exported from the testkit surface', async () => {
  const k = await kit();
  assert.equal(typeof k.chooseRoot, 'function', 'chooseRoot export is present');
});
