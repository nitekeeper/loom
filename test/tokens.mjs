/* ============================================================
 * Loom — daily token-usage rollup suite (node --test)
 * ------------------------------------------------------------
 * Exercises src/main/tokens.ts getDailyTokens — the TOKENS_DAILY data
 * layer that SPAWNS atelier's token_usage.py CLI — WITHOUT depending on a
 * real atelier install or python. It injects a FAKE script (a tiny Node
 * stub run via process.execPath) through the DailyTokenDeps.location seam,
 * so the suite is fully hermetic. It proves the PARSING + FAIL-SOFT
 * contract:
 *   (a) a valid rows JSON  -> { ok:true, rows } parsed;
 *   (b) the --cost { rows, totals } shape parsed (totals carried);
 *   (c) a missing script   -> { ok:false, reason:'atelier_not_found' }
 *                             (via an EMPTY homeDir glob, no real cache);
 *   (d) a non-zero exit    -> { ok:false, reason:'nonzero_exit' };
 *   (e) garbage stdout     -> { ok:false, reason:'bad_json' }.
 * Mirrors test/git-diff.mjs structure (the dist/testkit.cjs kit() loader);
 * Electron-free, display-free.
 *
 * DEPENDENCY: dist/testkit.cjs (built by `npm run build`) re-exports
 * { getDailyTokens, parseStdout, resolveTokenScript }.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** A throwaway temp dir + teardown (mirror of config.mjs freshDir). */
function freshDir(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `loom-tokens-${tag}-`));
  const teardown = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { dir, teardown };
}

/** Write a Node stub script into `dir` and return its absolute path. The stub is
 *  run via process.execPath (so `python` = node, hermetic — no python needed).
 *  Because the temp dir has no package.json, a .js file loads as CommonJS. */
function writeStub(dir, name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

/** The fake token_usage.py, impersonated by Node. It echoes a BARE rows array
 *  normally, OR a { rows, totals } object when invoked with `--cost` — exactly
 *  the two documented CLI shapes. It also asserts the canonical argv the
 *  producer must build (`daily --format json`) is present. */
const STUB_ROWS = `
const argv = process.argv.slice(2);
if (argv[0] !== 'daily' || !argv.includes('--format') || !argv.includes('json')) {
  process.stderr.write('unexpected argv: ' + JSON.stringify(argv));
  process.exit(2);
}
const rows = [
  { day: '2026-06-25', input_tokens: 100, output_tokens: 50,
    cache_creation_input_tokens: 10, cache_read_input_tokens: 5, model: 'claude-opus-4-7' },
  { day: '2026-06-26', input_tokens: 200, output_tokens: 80,
    cache_creation_input_tokens: 20, cache_read_input_tokens: 7, model: 'claude-opus-4-7' },
];
if (argv.includes('--cost')) {
  const withCost = rows.map((r) => ({ ...r, cost_usd: 0.42 }));
  process.stdout.write(JSON.stringify({
    rows: withCost,
    totals: { input_tokens: 300, output_tokens: 130,
      cache_creation_input_tokens: 30, cache_read_input_tokens: 12, cost_usd: 0.84 },
  }));
} else {
  process.stdout.write(JSON.stringify(rows));
}
`;

/** A stub that exits non-zero (the CLI failed at runtime). */
const STUB_NONZERO = `
process.stderr.write('boom');
process.exit(1);
`;

/** A stub that prints non-JSON garbage on a clean exit. */
const STUB_GARBAGE = `
process.stdout.write('this is not json at all {{{ <<<');
`;

/* ------------------------------------------------------------------ *
 * (a) valid rows JSON -> ok:true with the rows parsed                  *
 * ------------------------------------------------------------------ */
test('TOKENS getDailyTokens: a valid rows JSON => ok:true with parsed rows', async () => {
  const { getDailyTokens } = await kit();
  const { dir, teardown } = freshDir('rows');
  try {
    const scriptPath = writeStub(dir, 'fake_token_usage.js', STUB_ROWS);
    const res = await getDailyTokens(undefined, {
      location: { python: process.execPath, scriptPath },
    });
    assert.equal(res.ok, true, 'a valid rows array parses to ok:true');
    assert.ok(Array.isArray(res.rows), 'rows is an array');
    assert.equal(res.rows.length, 2, 'both rows parsed');
    assert.equal(res.rows[0].day, '2026-06-25');
    assert.equal(res.rows[0].model, 'claude-opus-4-7');
    assert.equal(res.rows[1].input_tokens, 200);
    assert.equal(res.totals, undefined, 'no totals without --cost (bare rows shape)');
  } finally {
    teardown();
  }
});

/* ------------------------------------------------------------------ *
 * (b) --cost { rows, totals } shape parsed                             *
 * ------------------------------------------------------------------ */
test('TOKENS getDailyTokens: --cost yields the { rows, totals } shape parsed (totals carried)', async () => {
  const { getDailyTokens } = await kit();
  const { dir, teardown } = freshDir('cost');
  try {
    const scriptPath = writeStub(dir, 'fake_token_usage.js', STUB_ROWS);
    const res = await getDailyTokens({ cost: true }, {
      location: { python: process.execPath, scriptPath },
    });
    assert.equal(res.ok, true, 'the { rows, totals } shape parses to ok:true');
    assert.equal(res.rows.length, 2, 'rows extracted from the object shape');
    assert.equal(res.rows[0].cost_usd, 0.42, 'per-row cost carried under --cost');
    assert.ok(res.totals, 'totals object is present under --cost');
    assert.equal(res.totals.cost_usd, 0.84, 'grand-total cost carried');
    assert.equal(res.totals.input_tokens, 300, 'totals token counts carried');
  } finally {
    teardown();
  }
});

/* ------------------------------------------------------------------ *
 * (c) missing script -> atelier_not_found (empty homeDir glob)         *
 * ------------------------------------------------------------------ */
test('TOKENS getDailyTokens: no script found => ok:false reason:atelier_not_found (never throws)', async () => {
  const { getDailyTokens } = await kit();
  const { dir, teardown } = freshDir('nofound');
  try {
    // An EMPTY home tree: ~/.claude/plugins/cache/agora/atelier does NOT exist,
    // so the glob discovery resolves nothing. No `location` injected -> the real
    // resolver runs against this empty home.
    const res = await getDailyTokens(undefined, { homeDir: dir });
    assert.equal(res.ok, false, 'a missing CLI fails soft (no throw)');
    assert.equal(res.reason, 'atelier_not_found', 'the typed reason is atelier_not_found');
    assert.equal(typeof res.error, 'string', 'a human-readable error string is carried');
  } finally {
    teardown();
  }
});

/* explicit null location is also atelier_not_found (the pre-resolved seam). */
test('TOKENS getDailyTokens: an explicit null location => atelier_not_found', async () => {
  const { getDailyTokens } = await kit();
  const res = await getDailyTokens(undefined, { location: null });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'atelier_not_found');
});

/* ------------------------------------------------------------------ *
 * (d) non-zero exit -> nonzero_exit                                    *
 * ------------------------------------------------------------------ */
test('TOKENS getDailyTokens: a non-zero CLI exit => ok:false reason:nonzero_exit', async () => {
  const { getDailyTokens } = await kit();
  const { dir, teardown } = freshDir('exit');
  try {
    const scriptPath = writeStub(dir, 'fake_token_usage.js', STUB_NONZERO);
    const res = await getDailyTokens(undefined, {
      location: { python: process.execPath, scriptPath },
    });
    assert.equal(res.ok, false, 'a non-zero exit fails soft');
    assert.equal(res.reason, 'nonzero_exit', 'the typed reason is nonzero_exit');
  } finally {
    teardown();
  }
});

/* ------------------------------------------------------------------ *
 * (e) garbage stdout -> bad_json                                       *
 * ------------------------------------------------------------------ */
test('TOKENS getDailyTokens: garbage (non-JSON) stdout => ok:false reason:bad_json', async () => {
  const { getDailyTokens } = await kit();
  const { dir, teardown } = freshDir('garbage');
  try {
    const scriptPath = writeStub(dir, 'fake_token_usage.js', STUB_GARBAGE);
    const res = await getDailyTokens(undefined, {
      location: { python: process.execPath, scriptPath },
    });
    assert.equal(res.ok, false, 'unparseable stdout fails soft');
    assert.equal(res.reason, 'bad_json', 'the typed reason is bad_json');
  } finally {
    teardown();
  }
});

/* ------------------------------------------------------------------ *
 * spawn failure: a nonexistent python binary => spawn_failed           *
 * ------------------------------------------------------------------ */
test('TOKENS getDailyTokens: an unspawnable interpreter => ok:false reason:spawn_failed', async () => {
  const { getDailyTokens } = await kit();
  const res = await getDailyTokens(undefined, {
    location: { python: '/no/such/python-binary-xyz', scriptPath: '/tmp/whatever.py' },
  });
  assert.equal(res.ok, false, 'an ENOENT spawn fails soft');
  assert.equal(res.reason, 'spawn_failed', 'the typed reason is spawn_failed');
});

/* ------------------------------------------------------------------ *
 * parseStdout (PURE) — both shapes + bad_json directly                 *
 * ------------------------------------------------------------------ */
test('TOKENS parseStdout (pure): bare array, { rows, totals }, and garbage', async () => {
  const { parseStdout } = await kit();
  const bare = parseStdout(JSON.stringify([{ day: 'd', input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'm' }]));
  assert.equal(bare.ok, true);
  assert.equal(bare.rows.length, 1);
  assert.equal(bare.totals, undefined, 'a bare array carries no totals');

  const obj = parseStdout(JSON.stringify({ rows: [], totals: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
  assert.equal(obj.ok, true);
  assert.ok(Array.isArray(obj.rows));
  assert.ok(obj.totals, 'the object shape carries totals');

  const bad = parseStdout('{ not json');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_json');

  // A recognized-but-shapeless object (no rows array) is also bad_json.
  const shapeless = parseStdout(JSON.stringify({ nope: true }));
  assert.equal(shapeless.ok, false);
  assert.equal(shapeless.reason, 'bad_json');
});

/* ------------------------------------------------------------------ *
 * parseStdout coercion (M2) — malformed/partial rows are normalized    *
 * so the renderer never sees a missing/NaN/non-string field, and       *
 * non-object entries are dropped rather than passed through.           *
 * ------------------------------------------------------------------ */
test('TOKENS parseStdout (pure): coerces malformed/partial rows + drops non-objects', async () => {
  const { parseStdout } = await kit();
  const res = parseStdout(JSON.stringify([
    { day: '2026-06-26', model: 'm', output_tokens: 5 },               // missing token fields
    { day: 123, model: 42, input_tokens: 'NaN', cache_read_input_tokens: -1 }, // wrong-typed
    null,                                                              // dropped (not an object)
    'garbage',                                                         // dropped (not an object)
    { input_tokens: 7, cost_usd: null },                              // no day/model; explicit null cost
    { day: 'd', model: 'm', cost_usd: 'free' },                       // invalid cost dropped
  ]));
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 4, 'the two non-object entries are dropped');

  // row 0 — missing token fields default to 0, present one preserved.
  assert.equal(res.rows[0].input_tokens, 0);
  assert.equal(res.rows[0].cache_creation_input_tokens, 0);
  assert.equal(res.rows[0].output_tokens, 5);

  // row 1 — wrong-typed fields coerced: non-string day -> 'unknown', non-string
  // model -> '', the string 'NaN' -> 0, a finite negative number is kept.
  assert.equal(res.rows[1].day, 'unknown');
  assert.equal(res.rows[1].model, '');
  assert.equal(res.rows[1].input_tokens, 0);
  assert.equal(res.rows[1].cache_read_input_tokens, -1);

  // row 2 (3rd surviving) — no day/model -> safe defaults; explicit null cost kept.
  assert.equal(res.rows[2].day, 'unknown');
  assert.equal(res.rows[2].model, '');
  assert.equal(res.rows[2].input_tokens, 7);
  assert.equal(res.rows[2].cost_usd, null, 'an explicit null cost_usd is preserved');

  // row 3 — an invalid (non-number, non-null) cost_usd is dropped, not forwarded.
  assert.equal(res.rows[3].cost_usd, undefined, 'an invalid cost_usd is omitted');
});

/* ------------------------------------------------------------------ *
 * sanitizeOptions guard (N1) — a malformed `since` is dropped, never   *
 * forwarded as a CLI argv operand (proven via the canonical argv stub) *
 * ------------------------------------------------------------------ */
test('TOKENS getDailyTokens: a malformed `since` is dropped (not forwarded to argv)', async () => {
  const { getDailyTokens } = await kit();
  const { dir, teardown } = freshDir('since');
  try {
    // This stub fails (exit 3) if it EVER sees a `--since` flag, so a forwarded
    // malformed value would surface as nonzero_exit instead of ok:true.
    const guard = `
const argv = process.argv.slice(2);
if (argv.includes('--since')) { process.stderr.write('since leaked'); process.exit(3); }
process.stdout.write(JSON.stringify([]));
`;
    const scriptPath = writeStub(dir, 'fake_token_usage.js', guard);
    const res = await getDailyTokens({ since: 'not-a-date; rm -rf /' }, {
      location: { python: process.execPath, scriptPath },
    });
    assert.equal(res.ok, true, 'a malformed since is silently dropped, CLI runs clean');
    assert.equal(res.rows.length, 0);
  } finally {
    teardown();
  }
});

/* ------------------------------------------------------------------ *
 * resolveTokenScript (PURE-ish) — config override beats glob           *
 * ------------------------------------------------------------------ */
test('TOKENS resolveTokenScript: a config tokens.atelierScript override wins (verbatim path + python)', async () => {
  const { resolveTokenScript } = await kit();
  const loc = resolveTokenScript({
    config: { read: () => ({ theme: 'dark', tokens: { atelierScript: '/opt/atelier/token_usage.py', python: 'python3.12' } }) },
    // homeDir points nowhere relevant — the config override must short-circuit
    // the glob entirely.
    homeDir: '/nonexistent-home',
  });
  assert.ok(loc, 'the override resolves a location');
  assert.equal(loc.scriptPath, '/opt/atelier/token_usage.py', 'the configured path is used verbatim');
  assert.equal(loc.python, 'python3.12', 'the configured python overrides the default');

  // No override + an empty home => null (atelier_not_found upstream).
  const none = resolveTokenScript({
    config: { read: () => ({ theme: 'dark' }) },
    homeDir: '/nonexistent-home',
  });
  assert.equal(none, null, 'no override + empty glob => null');
});
