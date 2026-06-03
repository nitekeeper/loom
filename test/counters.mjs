/* ============================================================
 * Loom — counter-aggregate suite (node --test)
 * ------------------------------------------------------------
 * The renderer telemetry tick (computeCounters) and the roster
 * (buildAgentViews) used to recompute counts with an O(messages ×
 * receipts) scan — on every ~100ms event, synchronously, blocking
 * every agent's tool call. They now use aggregate db methods
 * (countMessages / countReceipts / countActiveAgents /
 * unreadCountsByRecipient). This suite proves those aggregates
 * return EXACTLY the naive computation they replaced — before and
 * after mark_read + deregister — so the perf fix is behaviour-
 * preserving.
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

async function fresh() {
  const mod = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-cnt-'));
  const db = mod.createDb();
  await db.init(dir);
  const bus = mod.createEventBus();
  const engine = mod.createEngine(db, bus);
  const teardown = () => {
    try { db.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { mod, db, bus, engine, teardown };
}

/** The OLD O(messages × receipts) total, recomputed for cross-checking. */
function naiveReceiptTotal(db) {
  let n = 0;
  for (const m of db.listMessages()) n += db.listReceipts(m.id).length;
  return n;
}

/** The OLD O(agents × messages × receipts) per-recipient unread, as a sorted
 *  plain object for deepEqual. */
function naiveUnreadObj(db) {
  const map = new Map();
  for (const m of db.listMessages()) {
    for (const r of db.listReceipts(m.id)) {
      if (r.read_at === null) map.set(r.recipient, (map.get(r.recipient) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...map].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

function aggUnreadObj(db) {
  return Object.fromEntries([...db.unreadCountsByRecipient()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

test('COUNTERS: aggregate db methods equal the naive O(M×R) computation, across mark_read + deregister', async () => {
  const ctx = await fresh();
  const { engine, db } = ctx;
  try {
    const names = ['a', 'b', 'c', 'd'];
    for (const n of names) engine.register(caller(null), { name: n });
    engine.create_channel(caller('a'), { name: 'room' });
    for (const n of names.slice(1)) engine.join_channel(caller(n), { channel: 'room' });
    for (let i = 0; i < 25; i += 1) {
      engine.send_message(caller(names[i % 4]), { channel: 'room', to: '@here', body: `m${i}` });
    }
    engine.send_message(caller('a'), { channel: 'room', to: 'b', body: 'a direct one' });

    // --- before any read ---
    assert.equal(db.countMessages(), db.listMessages().length, 'countMessages');
    assert.equal(db.countReceipts(), naiveReceiptTotal(db), 'countReceipts');
    assert.equal(db.countActiveAgents(), 4, 'countActiveAgents (all active)');
    assert.deepEqual(aggUnreadObj(db), naiveUnreadObj(db), 'unread map (pre mark_read)');

    // --- mutate: b reads some, c is deregistered ---
    const bUnread = engine.read_messages(caller('b'), {});
    engine.mark_read(caller('b'), { message_ids: bUnread.slice(0, 5).map((u) => u.message_id) });
    engine.deregister(caller('a'), { name: 'c' });

    // --- after ---
    assert.equal(db.countMessages(), db.listMessages().length, 'countMessages (post)');
    assert.equal(db.countReceipts(), naiveReceiptTotal(db), 'countReceipts (post mark_read)');
    assert.equal(db.countActiveAgents(), 3, 'countActiveAgents (after one deregister)');
    assert.deepEqual(aggUnreadObj(db), naiveUnreadObj(db), 'unread map (post mark_read)');

    // sanity: b's unread dropped by exactly 5
    const want = naiveUnreadObj(db);
    assert.equal(want.b, bUnread.length - 5, 'b unread reduced by the 5 marked');
  } finally {
    ctx.teardown();
  }
});
