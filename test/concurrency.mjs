/* ============================================================
 * Loom — concurrency / scale stress suite (node --test)
 * ------------------------------------------------------------
 * GOAL PROOF: many agents chatting CONCURRENTLY in a shared room
 * must not crash, hang, or corrupt the transcript.
 *
 * Drives the PURE engine over a fresh sql.js db (no Electron),
 * interleaving each agent's turn as a microtask so sends + inbox
 * polls + reads + mark_read race the way real async MCP sessions
 * do against the single synchronous writer. sql.js is single-
 * threaded, so the failure mode here is NOT a data race — it is an
 * event-loop STALL on an O(messages × receipts) hot path, plus the
 * accounting corruption that would show if writes interleaved badly.
 *
 * Two guarantees, the pair the old per-message inbox scan could not
 * meet at 20 agents:
 *   1. CONSISTENCY — exact message + receipt counts, conservation of
 *      read/unread receipts, the engine's inbox view agreeing with
 *      the raw store. No lost or duplicated rows under the storm.
 *   2. LIVENESS — the whole storm completes well within a generous
 *      wall-clock bound. A regression to the O(n²) inbox scan would
 *      blow past it (or trip the per-test timeout).
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
    throw new Error(
      `dist/testkit.cjs not found at ${TESTKIT} — run \`npm run build\` first.`,
    );
  }
  _kit = await import(TESTKIT);
  return _kit;
}

const caller = (name) => ({ name });

/** Fresh engine + db + a real (no-op) bus subscriber so the fanout path is
 *  exercised under load too. Returns a teardown that stops timers + removes
 *  the temp db dir. */
async function freshEngine() {
  const mod = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-conc-'));
  const db = mod.createDb();
  await db.init(dir);
  const bus = mod.createEventBus();
  let events = 0;
  const unsub = bus.subscribe(() => {
    events += 1;
  });
  const engine = mod.createEngine(db, bus);
  const teardown = () => {
    try { unsub(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { db, bus, engine, dir, teardown, eventCount: () => events };
}

/** Count receipt rows: total, or only read / only unread. */
function countReceipts(db, read) {
  const sql =
    read === undefined
      ? 'SELECT COUNT(*) AS c FROM receipts'
      : `SELECT COUNT(*) AS c FROM receipts WHERE read_at IS ${read ? 'NOT NULL' : 'NULL'}`;
  const out = db.exec(sql);
  return out.length === 0 ? 0 : Number(out[0].values[0][0]);
}

/* ================================================================== */
/* 20 agents, a broadcast+poll storm. Proves consistency + liveness.   */
/* ================================================================== */
test('CONCURRENCY: 20 agents broadcasting + polling concurrently stay consistent and live', { timeout: 60000 }, async () => {
  const ctx = await freshEngine();
  const { db, engine, teardown } = ctx;
  const N = 20; // agents
  const M = 30; // broadcast rounds per agent -> N*M total messages
  try {
    const names = Array.from({ length: N }, (_, i) => `agent-${i}`);
    for (const n of names) engine.register(caller(null), { name: n });
    engine.create_channel(caller(names[0]), { name: 'room' }); // names[0] auto-joins
    for (const n of names.slice(1)) engine.join_channel(caller(n), { channel: 'room' });

    // Build the storm: every (agent, round) is an independent async turn that
    // yields once (microtask) before touching the engine, so the turns
    // interleave instead of running as one synchronous block.
    const turns = [];
    for (let round = 0; round < M; round += 1) {
      for (const n of names) {
        turns.push(
          (async () => {
            await Promise.resolve(); // yield -> interleave with other turns
            engine.send_message(caller(n), { channel: 'room', to: '@here', body: `r${round} from ${n}` });
            engine.check_inbox(caller(n));
            const unread = engine.read_messages(caller(n), { channel: 'room' });
            if (unread.length > 0) {
              engine.mark_read(caller(n), {
                message_ids: unread.slice(0, 5).map((u) => u.message_id),
              });
            }
          })(),
        );
      }
    }

    const t0 = Date.now();
    await Promise.all(turns); // rejects if ANY turn threw — proves no crash
    const elapsed = Date.now() - t0;

    /* --- CONSISTENCY -------------------------------------------------- */
    const totalMessages = db.listMessages().length;
    assert.equal(totalMessages, N * M, `expected exactly ${N * M} messages, got ${totalMessages}`);

    const totalReceipts = countReceipts(db);
    assert.equal(
      totalReceipts,
      N * M * (N - 1),
      `each @here must write N-1 receipts with none lost/duplicated under concurrency; ` +
        `expected ${N * M * (N - 1)}, got ${totalReceipts}`,
    );

    const read = countReceipts(db, true);
    const unread = countReceipts(db, false);
    assert.equal(read + unread, totalReceipts, 'read + unread receipts must equal the total (no corruption)');

    // The engine's inbox view must agree with the raw unread count.
    let inboxUnreadSum = 0;
    for (const n of names) inboxUnreadSum += engine.check_inbox(caller(n)).unread;
    assert.equal(
      inboxUnreadSum,
      unread,
      `sum of per-agent check_inbox().unread (${inboxUnreadSum}) must equal raw unread receipts (${unread})`,
    );

    /* --- LIVENESS ----------------------------------------------------- */
    // Generous bound: with the indexed-JOIN unread query this storm finishes
    // in well under a second. A regression to the per-message O(n²) scan would
    // blow past this (or trip the timeout above).
    assert.ok(
      elapsed < 15000,
      `concurrent storm must stay live; took ${elapsed}ms (regression to O(n²) inbox scan?)`,
    );
  } finally {
    teardown();
  }
});

/* ================================================================== */
/* Concurrent mark_read storm: read/unread accounting must be exact.   */
/* ================================================================== */
test('CONCURRENCY: interleaved mark_read never double-counts or loses a receipt', { timeout: 60000 }, async () => {
  const ctx = await freshEngine();
  const { db, engine, teardown } = ctx;
  const N = 12;
  const M = 20;
  try {
    const names = Array.from({ length: N }, (_, i) => `a${i}`);
    for (const n of names) engine.register(caller(null), { name: n });
    engine.create_channel(caller(names[0]), { name: 'r' });
    for (const n of names.slice(1)) engine.join_channel(caller(n), { channel: 'r' });

    // Seed the transcript first.
    for (let round = 0; round < M; round += 1) {
      for (const n of names) engine.send_message(caller(n), { channel: 'r', to: '@here', body: `${round}:${n}` });
    }
    const total = countReceipts(db);
    assert.equal(total, N * M * (N - 1), 'seed receipt count');

    // Concurrent mark_read storm: each agent reads then marks ALL its unread,
    // three interleaved passes. Idempotent re-marks must not shift the count.
    const turns = [];
    for (let pass = 0; pass < 3; pass += 1) {
      for (const n of names) {
        turns.push(
          (async () => {
            await Promise.resolve();
            const unread = engine.read_messages(caller(n), {});
            if (unread.length > 0) {
              engine.mark_read(caller(n), { message_ids: unread.map((u) => u.message_id) });
            }
          })(),
        );
      }
    }
    await Promise.all(turns);

    const read = countReceipts(db, true);
    const unread = countReceipts(db, false);
    assert.equal(read + unread, total, 'conservation under concurrent mark_read');
    assert.equal(unread, 0, 'after every agent marks all of its unread, nothing should remain unread');
  } finally {
    teardown();
  }
});
