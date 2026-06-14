/* ============================================================
 * Loom — persisted-config coercion suite (node --test)
 * ------------------------------------------------------------
 * Pins the tolerant load-path coercion of LoomConfig.terminalCount
 * (multi-terminal design §4 AC8 / §8 R10): the persisted count
 * round-trips across a restart, an existing config with NO
 * `terminalCount` key loads as 1 (visual no-op for upgrading
 * single-terminal users), an in-type out-of-range integer is CLAMPED
 * into [1,3], any non-finite-integer garbage falls back to the default,
 * and an unknown FUTURE config key is tolerated (dropped, never throws).
 * There is no migration runner — additive/optional fields + a
 * range-validating coercer are the whole back-compat story.
 *
 * Drives the REAL FileConfigStore (Electron-free) by writing
 * loom-config.json into a temp userData dir, then re-reading it through
 * a fresh createConfigStore — exactly the boot load path, so the private
 * coerceConfig/coerceTerminalCount are exercised end-to-end.
 *
 * DEPENDENCY: dist/testkit.cjs (built by `npm run build`) re-exports
 * { createConfigStore, DEFAULT_CONFIG, CONFIG_FILENAME,
 *   MIN/MAX/DEFAULT_TERMINAL_COUNT }.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** Fresh temp userData dir + teardown (mirror of test/retention.mjs freshDb). */
function freshDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-cfg-'));
  const teardown = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { dir, teardown };
}

/** Write a raw loom-config.json into `dir`, then load it through the REAL
 *  FileConfigStore (the boot load path) and return the coerced LoomConfig. */
async function loadRaw(mod, dir, raw) {
  writeFileSync(path.join(dir, mod.CONFIG_FILENAME), raw, 'utf8');
  return mod.createConfigStore(dir).read();
}

test('CONFIG: a config WITHOUT terminalCount loads as the default (1) — back-compat no-op', async () => {
  const mod = await kit();
  const { dir, teardown } = freshDir();
  try {
    const cfg = await loadRaw(mod, dir, JSON.stringify({ theme: 'dark' }));
    assert.equal(cfg.terminalCount, mod.DEFAULT_TERMINAL_COUNT, 'missing key must coerce to the default');
    assert.equal(cfg.terminalCount, 1, 'the default terminal count is 1 (single-terminal users unchanged)');
  } finally {
    teardown();
  }
});

test('CONFIG: a missing config file loads the full default config (terminalCount = 1)', async () => {
  const mod = await kit();
  const { dir, teardown } = freshDir();
  try {
    // No file written — the store must fall back to DEFAULT_CONFIG, never throw.
    const cfg = mod.createConfigStore(dir).read();
    assert.equal(cfg.terminalCount, mod.DEFAULT_TERMINAL_COUNT);
    assert.equal(cfg.terminalCount, mod.DEFAULT_CONFIG.terminalCount);
  } finally {
    teardown();
  }
});

test('CONFIG: a valid in-range terminalCount (2, 3) round-trips unchanged', async () => {
  const mod = await kit();
  for (const valid of [1, 2, 3]) {
    const { dir, teardown } = freshDir();
    try {
      const cfg = await loadRaw(mod, dir, JSON.stringify({ theme: 'dark', terminalCount: valid }));
      assert.equal(cfg.terminalCount, valid, `terminalCount ${valid} must round-trip unchanged`);
    } finally {
      teardown();
    }
  }
});

test('CONFIG: an in-type out-of-range integer terminalCount is CLAMPED to [1,3]', async () => {
  const mod = await kit();
  // [persisted, expectedClamped] — integers outside the range clamp into it.
  const cases = [
    [5, mod.MAX_TERMINAL_COUNT], // "as many as allowed" => 3
    [4, mod.MAX_TERMINAL_COUNT],
    [99, mod.MAX_TERMINAL_COUNT],
    [0, mod.MIN_TERMINAL_COUNT], // 0 is an integer => clamps up to the floor (1)
    [-1, mod.MIN_TERMINAL_COUNT],
    [-100, mod.MIN_TERMINAL_COUNT],
  ];
  for (const [persisted, expected] of cases) {
    const { dir, teardown } = freshDir();
    try {
      const cfg = await loadRaw(mod, dir, JSON.stringify({ theme: 'dark', terminalCount: persisted }));
      assert.equal(cfg.terminalCount, expected, `terminalCount ${persisted} must clamp to ${expected}`);
    } finally {
      teardown();
    }
  }
});

test('CONFIG: non-finite-integer garbage terminalCount falls back to the default (1)', async () => {
  const mod = await kit();
  // Raw JSON snippets for the terminalCount value (some are not valid JSON
  // numbers, so they are spliced into the file as text). Each must NOT be a
  // finite integer => coerce to DEFAULT_TERMINAL_COUNT (1), never throw.
  const garbageValues = [
    '2.5',        // non-integer number
    '"3"',        // string (even a numeric one) is not a number
    'null',       // null
    'true',       // boolean
    '[]',         // array
    '{}',         // object
    '"abc"',      // non-numeric string
    '1e308',      // 1e308 is an integer-valued finite number...
  ];
  for (const raw of garbageValues) {
    const { dir, teardown } = freshDir();
    try {
      const cfg = await loadRaw(mod, dir, `{ "theme": "dark", "terminalCount": ${raw} }`);
      const expected =
        raw === '1e308' ? mod.MAX_TERMINAL_COUNT : mod.DEFAULT_TERMINAL_COUNT;
      assert.equal(
        cfg.terminalCount,
        expected,
        `terminalCount ${raw} must coerce to ${expected} (no throw)`,
      );
    } finally {
      teardown();
    }
  }
});

test('CONFIG: NaN / Infinity terminalCount (non-finite) falls back to the default (1)', async () => {
  const mod = await kit();
  // NaN/Infinity are not representable in JSON, so they cannot persist as a raw
  // number; JSON.parse rejects them and the WHOLE file is treated as corrupt =>
  // the store falls back to DEFAULT_CONFIG. Either way terminalCount is the
  // default (1). This pins "a damaged config never throws and never wedges".
  for (const raw of ['NaN', 'Infinity', '-Infinity']) {
    const { dir, teardown } = freshDir();
    try {
      const cfg = await loadRaw(mod, dir, `{ "theme": "dark", "terminalCount": ${raw} }`);
      assert.equal(
        cfg.terminalCount,
        mod.DEFAULT_TERMINAL_COUNT,
        `terminalCount ${raw} must coerce to the default (corrupt JSON => default config)`,
      );
    } finally {
      teardown();
    }
  }
});

test('CONFIG: an unknown FUTURE config key is tolerated (dropped, no throw)', async () => {
  const mod = await kit();
  const { dir, teardown } = freshDir();
  try {
    const cfg = await loadRaw(
      mod,
      dir,
      JSON.stringify({
        theme: 'light',
        terminalCount: 2,
        // A key the current build has never heard of — must be ignored, not
        // throw, and must NOT survive onto the coerced config (R10: no
        // migration runner; the coercer is the only normalization).
        someFutureLayoutMode: 'mosaic',
        columnRatios: [0.5, 0.5],
      }),
    );
    assert.equal(cfg.terminalCount, 2, 'a known key alongside an unknown one still coerces');
    assert.equal(cfg.theme, 'light', 'the rest of the config is unaffected by the unknown key');
    assert.equal(
      Object.prototype.hasOwnProperty.call(cfg, 'someFutureLayoutMode'),
      false,
      'the unknown future key must be dropped, not carried onto the coerced config',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(cfg, 'columnRatios'),
      false,
      'an unknown future array key must be dropped too',
    );
  } finally {
    teardown();
  }
});

test('CONFIG: a corrupt (unparseable) config file loads the default config without throwing', async () => {
  const mod = await kit();
  const { dir, teardown } = freshDir();
  try {
    const cfg = await loadRaw(mod, dir, 'this is not json {{{');
    assert.equal(cfg.terminalCount, mod.DEFAULT_TERMINAL_COUNT);
    assert.equal(cfg.theme, mod.DEFAULT_CONFIG.theme, 'corrupt file => the full default config');
  } finally {
    teardown();
  }
});

test('CONFIG: setTerminalCount persists a clamped count that survives a reload (round-trip)', async () => {
  const mod = await kit();
  const { dir, teardown } = freshDir();
  try {
    // Persist a valid count, then a NEW store over the SAME dir must read it.
    mod.createConfigStore(dir).setTerminalCount(3);
    assert.equal(mod.createConfigStore(dir).read().terminalCount, 3, 'a persisted count survives a restart');

    // A bad renderer value can never persist out of range — the setter clamps
    // via the same coercer the load path uses.
    mod.createConfigStore(dir).setTerminalCount(5);
    assert.equal(
      mod.createConfigStore(dir).read().terminalCount,
      mod.MAX_TERMINAL_COUNT,
      'an out-of-range set is clamped on write and reads back clamped',
    );
  } finally {
    teardown();
  }
});
