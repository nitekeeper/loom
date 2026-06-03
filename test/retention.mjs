/* ============================================================
 * Loom — message-retention suite (node --test)
 * ------------------------------------------------------------
 * Pins the configurable persisted-message cap (LoomConfig.maxMessages
 * -> EngineOptions.maxMessages -> db.pruneMessagesToCap): the newest N
 * messages are kept; older ones (and their receipts) are pruned FK-safe
 * on send and on construction. Bounds memory + the per-flush full-image
 * serialize cost under a runaway/marathon multi-agent session, without
 * a data race (sql.js is single-threaded).
 *
 * DEPENDENCY: dist/testkit.cjs (built by `npm run build`) re-exports
 * { createDb, createEngine, createEventBus }.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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

const caller = (name) => ({ name });

async function freshDb() {
  const mod = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-ret-'));
  const db = mod.createDb();
  await db.init(dir);
  const bus = mod.createEventBus();
  const teardown = () => {
    try { db.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { mod, db, bus, dir, teardown };
}

const scalar = (db, sql) => {
  const out = db.exec(sql);
  return out.length === 0 ? 0 : Number(out[0].values[0][0]);
};
const countMessages = (db) => scalar(db, 'SELECT COUNT(*) AS c FROM messages');
const countReceipts = (db) => scalar(db, 'SELECT COUNT(*) AS c FROM receipts');

/** Two-agent direct-message channel under an engine with `opts`. */
function setupDirect(mod, db, bus, opts) {
  const engine = mod.createEngine(db, bus, opts);
  engine.register(caller(null), { name: 'a' });
  engine.register(caller(null), { name: 'b' });
  engine.create_channel(caller('a'), { name: 'c' });
  engine.join_channel(caller('b'), { channel: 'c' });
  return engine;
}

test('RETENTION: maxMessages caps the transcript to the newest N (older pruned FK-safe)', async () => {
  const ctx = await freshDb();
  const { mod, db, bus } = ctx;
  try {
    const CAP = 50;
    const engine = setupDirect(mod, db, bus, { maxMessages: CAP });
    let lastId = 0;
    for (let i = 0; i < 200; i += 1) {
      lastId = engine.send_message(caller('a'), { channel: 'c', to: 'b', body: `m${i}` }).message_id;
    }
    assert.equal(countMessages(db), CAP, 'message count must be capped to maxMessages');
    assert.equal(countReceipts(db), CAP, 'each pruned message takes its receipt with it (FK-safe)');

    const { mn, mx } = (() => {
      const o = db.exec('SELECT MIN(id) AS mn, MAX(id) AS mx FROM messages')[0].values[0];
      return { mn: Number(o[0]), mx: Number(o[1]) };
    })();
    assert.equal(mx, lastId, 'the newest message must be retained');
    assert.equal(mx - mn + 1, CAP, 'the survivors are the contiguous newest CAP ids');

    const dangling = scalar(
      db,
      'SELECT COUNT(*) AS c FROM receipts r LEFT JOIN messages m ON m.id = r.message_id WHERE m.id IS NULL',
    );
    assert.equal(dangling, 0, 'no receipt may reference a pruned message');
  } finally {
    ctx.teardown();
  }
});

test('RETENTION: maxMessages = 0 means unlimited (no pruning)', async () => {
  const ctx = await freshDb();
  const { mod, db, bus } = ctx;
  try {
    const engine = setupDirect(mod, db, bus, { maxMessages: 0 });
    for (let i = 0; i < 120; i += 1) engine.send_message(caller('a'), { channel: 'c', to: 'b', body: `m${i}` });
    assert.equal(countMessages(db), 120, 'an explicit 0 cap must not prune');
  } finally {
    ctx.teardown();
  }
});

test('RETENTION: default engine (no opts) is unlimited — existing behaviour unchanged', async () => {
  const ctx = await freshDb();
  const { mod, db, bus } = ctx;
  try {
    const engine = setupDirect(mod, db, bus, {}); // no maxMessages
    for (let i = 0; i < 60; i += 1) engine.send_message(caller('a'), { channel: 'c', to: 'b', body: `m${i}` });
    assert.equal(countMessages(db), 60, 'the engine default must be unlimited (the acceptance suite relies on this)');
  } finally {
    ctx.teardown();
  }
});

test('RETENTION: the cap enforces on construction over an already-large db', async () => {
  const ctx = await freshDb();
  const { mod, db, bus } = ctx;
  try {
    // Fill with an unlimited engine first.
    const big = setupDirect(mod, db, bus, { maxMessages: 0 });
    for (let i = 0; i < 300; i += 1) big.send_message(caller('a'), { channel: 'c', to: 'b', body: `m${i}` });
    assert.equal(countMessages(db), 300);

    // A NEW engine with a cap over the SAME db prunes on construction.
    mod.createEngine(db, bus, { maxMessages: 100 });
    assert.equal(countMessages(db), 100, 'the cap must enforce on load/construction, not only on send');
  } finally {
    ctx.teardown();
  }
});

test('RETENTION: read/unread accounting stays consistent across pruning', async () => {
  const ctx = await freshDb();
  const { mod, db, bus } = ctx;
  try {
    const CAP = 40;
    const engine = setupDirect(mod, db, bus, { maxMessages: CAP });
    for (let i = 0; i < 150; i += 1) engine.send_message(caller('a'), { channel: 'c', to: 'b', body: `m${i}` });

    // b reads everything still present and marks a handful read.
    const unread = engine.read_messages(caller('b'), {});
    engine.mark_read(caller('b'), { message_ids: unread.slice(0, 10).map((u) => u.message_id) });

    const total = countReceipts(db);
    const read = scalar(db, 'SELECT COUNT(*) AS c FROM receipts WHERE read_at IS NOT NULL');
    const stillUnread = scalar(db, 'SELECT COUNT(*) AS c FROM receipts WHERE read_at IS NULL');
    assert.equal(total, CAP, 'receipts bounded with the messages');
    assert.equal(read + stillUnread, total, 'read + unread must equal total after pruning (no corruption)');
    assert.equal(
      engine.check_inbox(caller('b')).unread,
      stillUnread,
      'the inbox view must agree with the raw unread count post-prune',
    );
  } finally {
    ctx.teardown();
  }
});
