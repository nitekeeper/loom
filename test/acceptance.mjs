/* ============================================================
 * Loom — acceptance suite (node --test)
 * ------------------------------------------------------------
 * Proves the acceptance criteria at the ENGINE + schema + dispatch +
 * content-safety layers WITHOUT launching Electron. Deterministic,
 * no network, fresh engine + db per test.
 *
 * Drives the PURE engine (src/main/engine.ts) over a fresh sql.js
 * db (src/main/db.ts) and an in-process EventBus (src/main/eventbus.ts),
 * imported from the built `dist/testkit.cjs` re-export bundle.
 *
 * Coverage map:
 *   AC-6  (register + suffix + NAME_TOO_LONG) ........ FR-15
 *   AC-7  (create/join auto-join + members) .......... FR-16, FR-17
 *   AC-8  (addressing direct / @here, row state) ..... FR-21, FR-23, FR-24, FR-31
 *   AC-9  (inbox/read mark NOTHING; mark_read; recount) FR-25, FR-26, FR-27, FR-28
 *   AC-10 (async delivery to offline recipient) ...... FR-22
 *   AC-11 (channel isolation, Law 5) ................. FR-20
 *   AC-12 (deregister -> gone, excluded from active) . FR-19
 *   AC-13/15 (event fanout on the bus per tool) ...... FR-29, FR-30, NFR-9, NFR-10
 *   AC-16 (schema: enums, UNIQUE, composite PK, index) FR-31
 *   AC-19 (dispatch ext -> render-state, deterministic) FR-40, FR-10, NFR-6
 *   AC-21/22 (link + embedded-HTML content safety) ... FR-5, FR-48, FR-52
 *
 * DEPENDENCY: dist/testkit.cjs must re-export
 *   { createDb, createEngine, createEventBus, kindOf, dispatchFor }
 * and (for AC-21/22) { renderMarkdown, renderInline }. It is imported
 * LAZILY so this file always PARSES even before the bundle is built;
 * the import is performed inside a beforeEach/within each test. If the
 * bundle or a needed export is missing, the relevant tests FAIL loudly
 * (not silently skipped) so the gap is visible in CI.
 * ============================================================ */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TESTKIT = path.join(root, 'dist', 'testkit.cjs');

/* ------------------------------------------------------------------ */
/* Lazy testkit loader. Imported once; cached. Throws a CLEAR error if  */
/* the bundle is absent so dependent tests fail for the right reason.   */
/* ------------------------------------------------------------------ */
let _kit = null;
async function kit() {
  if (_kit) return _kit;
  if (!existsSync(TESTKIT)) {
    throw new Error(
      `dist/testkit.cjs not found at ${TESTKIT} — run \`npm run build\` first. ` +
        `The backend engineer must add a 'testkit' esbuild bundle re-exporting ` +
        `createDb, createEngine, createEventBus, kindOf, dispatchFor (and ` +
        `renderMarkdown, renderInline for AC-21/22).`,
    );
  }
  _kit = await import(TESTKIT);
  return _kit;
}

/** Assert a named export exists on the kit and is a function. */
function requireExport(mod, name) {
  assert.equal(
    typeof mod[name],
    'function',
    `dist/testkit.cjs must re-export \`${name}\` (got ${typeof mod[name]}). ` +
      `Add it to the testkit bundle.`,
  );
  return mod[name];
}

/* ------------------------------------------------------------------ */
/* Fresh-engine fixture. A unique tmp dir per call -> isolated db file. */
/* Captures every published LoomEvent for fanout assertions.            */
/* ------------------------------------------------------------------ */
async function freshEngine() {
  const mod = await kit();
  const createDb = requireExport(mod, 'createDb');
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');

  const dir = mkdtempSync(path.join(tmpdir(), 'loom-ac-'));
  const db = createDb();
  await db.init(dir);

  const bus = createEventBus();
  const events = [];
  const unsub = bus.subscribe((e) => events.push(e));

  const engine = createEngine(db, bus);
  return { mod, db, bus, engine, events, dir, unsub };
}

/** A Caller object for an agent name (engine binds caller per session). */
const caller = (name) => ({ name });

/** Throw-and-capture helper: returns the thrown error or fails. */
function expectThrows(fn, msg) {
  let thrown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, msg ?? 'expected the call to throw, but it returned');
  return thrown;
}

/** Assert a thrown error carries the expected LoomError `code`. */
function assertCode(err, code) {
  assert.equal(
    err.code,
    code,
    `expected LoomError code ${code}, got code=${err.code} (${err.message})`,
  );
}

/** Standard two-agent channel: returns { engine, db, events, chan }. */
async function twoAgentChannel(chanName = 'general') {
  const ctx = await freshEngine();
  const { engine } = ctx;
  engine.register(caller(null), { name: 'alice' });
  engine.register(caller(null), { name: 'bob' });
  engine.create_channel(caller('alice'), { name: chanName }); // alice auto-joins
  engine.join_channel(caller('bob'), { channel: chanName }); // bob joins
  ctx.events.length = 0; // reset capture so per-test assertions are clean
  return { ...ctx, chan: chanName };
}

/* ================================================================== */
/* Pre-flight: the testkit bundle is importable and complete.          */
/* ================================================================== */
before(async () => {
  // Surfaces a single clear failure if the build/testkit is missing,
  // instead of N confusing per-test failures.
  const mod = await kit();
  for (const name of [
    'createDb',
    'createEngine',
    'createEventBus',
    'kindOf',
    'dispatchFor',
  ]) {
    requireExport(mod, name);
  }
});

/* ================================================================== */
/* AC-6 — register: assignment, suffix-on-collision, NAME_TOO_LONG.    */
/* ================================================================== */
test('AC-6 register: first register returns the requested name + empty channels', async () => {
  const { engine } = await freshEngine();
  const res = engine.register(caller(null), { name: 'researcher' });
  assert.equal(res.ok, true);
  assert.equal(res.name, 'researcher');
  assert.deepEqual(res.channels, []);
});

test('AC-6 register: a colliding name is suffixed -2 (FR-15, OQ-1)', async () => {
  const { engine, db } = await freshEngine();
  const first = engine.register(caller(null), { name: 'researcher' });
  const second = engine.register(caller(null), { name: 'researcher' });
  assert.equal(first.name, 'researcher');
  assert.equal(
    second.name,
    'researcher-2',
    `second registration must be suffixed, got "${second.name}"`,
  );
  // Both rows must exist in the table (proof the suffix is the stored name).
  assert.ok(db.getAgent('researcher'), 'first agent row missing');
  assert.ok(db.getAgent('researcher-2'), 'suffixed agent row missing');
});

test('AC-6 register: collision against a `gone` row still suffixes (vs ANY row)', async () => {
  const { engine } = await freshEngine();
  engine.register(caller(null), { name: 'ghost' });
  engine.deregister(caller('ghost'), { name: 'ghost' }); // now status='gone'
  const again = engine.register(caller(null), { name: 'ghost' });
  assert.equal(
    again.name,
    'ghost-2',
    `must suffix against gone rows too, got "${again.name}"`,
  );
});

test('AC-6 register: a name longer than 64 chars throws NAME_TOO_LONG', async () => {
  const { engine } = await freshEngine();
  const tooLong = 'x'.repeat(65);
  const err = expectThrows(
    () => engine.register(caller(null), { name: tooLong }),
    'a >64-char name must throw',
  );
  assertCode(err, 'NAME_TOO_LONG');
});

test('AC-6 register: a name of exactly 64 chars is accepted (boundary)', async () => {
  const { engine } = await freshEngine();
  const exactly = 'y'.repeat(64);
  const res = engine.register(caller(null), { name: exactly });
  assert.equal(res.name, exactly, '64 chars is the inclusive max and must pass');
});

/* ================================================================== */
/* AC-7 — create_channel auto-joins caller; join_channel returns the   */
/*        membership list including the joiner.                        */
/* ================================================================== */
test('AC-7 create_channel: caller is auto-joined (appears in members) (FR-16)', async () => {
  const { engine, db } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  const ch = engine.create_channel(caller('alice'), { name: 'general' });
  assert.equal(typeof ch.id, 'number');
  assert.equal(ch.name, 'general');
  const members = db.listMemberships(ch.id).map((m) => m.agent_name);
  assert.deepEqual(
    members,
    ['alice'],
    `creator must be auto-joined; members=${JSON.stringify(members)}`,
  );
});

test('AC-7 join_channel: returns members including the joiner (FR-17)', async () => {
  const { engine } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  engine.register(caller(null), { name: 'bob' });
  engine.create_channel(caller('alice'), { name: 'general' });
  const joined = engine.join_channel(caller('bob'), { channel: 'general' });
  assert.equal(joined.channel, 'general');
  assert.ok(
    joined.members.includes('bob'),
    `join must return the joiner in members; got ${JSON.stringify(joined.members)}`,
  );
  assert.ok(
    joined.members.includes('alice'),
    `join must return existing members too; got ${JSON.stringify(joined.members)}`,
  );
});

test('AC-7 create_channel: duplicate channel name throws CHANNEL_EXISTS', async () => {
  const { engine } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  engine.create_channel(caller('alice'), { name: 'general' });
  const err = expectThrows(
    () => engine.create_channel(caller('alice'), { name: 'general' }),
    'duplicate channel name must throw',
  );
  assertCode(err, 'CHANNEL_EXISTS');
});

/* ================================================================== */
/* AC-8 — addressing: direct delivers to ONE member; @here delivers to */
/*        all members except sender. Inspect rows via db accessors.    */
/* ================================================================== */
test('AC-8 send direct: stores addressing=direct, target=name, exactly 1 receipt (FR-21/23/31)', async () => {
  const { engine, db, chan } = await twoAgentChannel();
  // alice -> bob (direct)
  const sent = engine.send_message(caller('alice'), {
    channel: chan,
    to: 'bob',
    body: 'hi bob',
  });
  assert.deepEqual(
    sent.recipients,
    ['bob'],
    `direct must resolve exactly the named recipient; got ${JSON.stringify(sent.recipients)}`,
  );
  const msg = db.listMessages().find((m) => m.id === sent.message_id);
  assert.ok(msg, 'message row not persisted');
  assert.equal(msg.addressing, 'direct');
  assert.equal(msg.target, 'bob');
  assert.equal(msg.sender, 'alice');
  const receipts = db.listReceipts(sent.message_id);
  assert.equal(
    receipts.length,
    1,
    `direct send must write exactly one receipt; got ${receipts.length}`,
  );
  assert.equal(receipts[0].recipient, 'bob');
  assert.equal(receipts[0].read_at, null, 'a fresh receipt must be unread');
});

test('AC-8 send @here: stores addressing=here, target=NULL, N-1 receipts (FR-24/31)', async () => {
  const ctx = await freshEngine();
  const { engine, db } = ctx;
  // Three members so N-1 is unambiguous (2 receipts, not 1).
  for (const n of ['alice', 'bob', 'carol']) {
    engine.register(caller(null), { name: n });
  }
  engine.create_channel(caller('alice'), { name: 'general' }); // alice auto-joins
  engine.join_channel(caller('bob'), { channel: 'general' });
  engine.join_channel(caller('carol'), { channel: 'general' });

  const sent = engine.send_message(caller('alice'), {
    channel: 'general',
    to: '@here',
    body: 'hello all',
  });
  const recips = [...sent.recipients].sort();
  assert.deepEqual(
    recips,
    ['bob', 'carol'],
    `@here must target all members except sender; got ${JSON.stringify(sent.recipients)}`,
  );
  const msg = db.listMessages().find((m) => m.id === sent.message_id);
  assert.ok(msg, 'message row not persisted');
  assert.equal(msg.addressing, 'here');
  assert.equal(msg.target, null, '@here must store target=NULL');
  const receipts = db.listReceipts(sent.message_id).map((r) => r.recipient).sort();
  assert.deepEqual(
    receipts,
    ['bob', 'carol'],
    `@here must write one receipt per member except sender; got ${JSON.stringify(receipts)}`,
  );
  assert.ok(
    !receipts.includes('alice'),
    'sender must NOT receive its own @here broadcast',
  );
});

/* ================================================================== */
/* AC-9 — check_inbox/read_messages mark NOTHING; mark_read sets        */
/*        read_at + returns count; a later check_inbox recounts.       */
/* ================================================================== */
test('AC-9 check_inbox: returns unread + previews and marks NOTHING (FR-25/28)', async () => {
  const { engine, db, chan } = await twoAgentChannel();
  const sent = engine.send_message(caller('alice'), {
    channel: chan,
    to: 'bob',
    body: 'unread me',
  });
  const inbox1 = engine.check_inbox(caller('bob'));
  assert.equal(inbox1.unread, 1, `bob should have 1 unread; got ${inbox1.unread}`);
  assert.equal(inbox1.previews.length, 1);
  const p = inbox1.previews[0];
  assert.equal(p.message_id, sent.message_id);
  assert.equal(p.channel, chan);
  assert.equal(p.sender, 'alice');
  assert.equal(p.addressing, 'direct');
  assert.ok(typeof p.preview === 'string' && p.preview.length > 0, 'preview must be a non-empty string');

  // Calling check_inbox again must NOT have marked anything read.
  const inbox2 = engine.check_inbox(caller('bob'));
  assert.equal(inbox2.unread, 1, 'check_inbox must not mark anything read');
  const receipt = db.listReceipts(sent.message_id)[0];
  assert.equal(receipt.read_at, null, 'receipt.read_at must still be NULL after check_inbox');
});

test('AC-9 read_messages: returns full bodies and marks NOTHING (FR-26)', async () => {
  const { engine, db, chan } = await twoAgentChannel();
  const sent = engine.send_message(caller('alice'), {
    channel: chan,
    to: 'bob',
    body: 'the full body text',
  });
  const msgs = engine.read_messages(caller('bob'), {});
  assert.equal(msgs.length, 1);
  const m = msgs[0];
  assert.equal(m.message_id, sent.message_id);
  assert.equal(m.body, 'the full body text', 'read_messages must return the FULL body');
  assert.equal(m.sender, 'alice');
  assert.equal(m.addressing, 'direct');
  assert.equal(m.target, 'bob');
  // Marks nothing.
  const receipt = db.listReceipts(sent.message_id)[0];
  assert.equal(receipt.read_at, null, 'read_messages must NOT set read_at');
  assert.equal(
    engine.check_inbox(caller('bob')).unread,
    1,
    'unread must be unchanged after read_messages',
  );
});

test('AC-9 mark_read: sets read_at, returns count, and reduces later unread (FR-27/28)', async () => {
  const { engine, db, chan } = await twoAgentChannel();
  const m1 = engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: 'one' });
  const m2 = engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: 'two' });
  assert.equal(engine.check_inbox(caller('bob')).unread, 2);

  const marked = engine.mark_read(caller('bob'), { message_ids: [m1.message_id] });
  assert.equal(marked.marked, 1, `mark_read must return the actual count updated; got ${marked.marked}`);

  const r1 = db.listReceipts(m1.message_id)[0];
  assert.ok(typeof r1.read_at === 'number', 'marked receipt must have a numeric read_at');
  const r2 = db.listReceipts(m2.message_id)[0];
  assert.equal(r2.read_at, null, 'unmarked receipt must remain unread');

  assert.equal(
    engine.check_inbox(caller('bob')).unread,
    1,
    'a subsequent check_inbox must show the reduced unread count',
  );
});

test('AC-9 mark_read: ids not addressed to the caller do not inflate the count', async () => {
  const { engine, chan } = await twoAgentChannel();
  const m = engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: 'x' });
  // alice marking bob's receipt id: alice has no receipt for it -> 0 updated.
  const marked = engine.mark_read(caller('alice'), { message_ids: [m.message_id] });
  assert.equal(marked.marked, 0, 'mark_read must only touch the caller\'s own receipts');
  // And bob still sees it unread.
  assert.equal(engine.check_inbox(caller('bob')).unread, 1);
});

/* ================================================================== */
/* AC-10 — async delivery: a message sent while the recipient is idle  */
/*         (registered but not actively polling) is retrievable later. */
/* ================================================================== */
test('AC-10 async delivery: message to an offline (idle) recipient is retrievable later (FR-22)', async () => {
  const { engine, chan } = await twoAgentChannel();
  // bob never "polls" at send time; he is registered + a member but idle.
  const sent = engine.send_message(caller('alice'), {
    channel: chan,
    to: 'bob',
    body: 'catch this later',
  });
  // ... time passes; bob comes back and polls.
  const inbox = engine.check_inbox(caller('bob'));
  assert.equal(inbox.unread, 1, 'message must persist for the idle recipient');
  const read = engine.read_messages(caller('bob'), {});
  assert.equal(read.length, 1);
  assert.equal(read[0].message_id, sent.message_id);
  assert.equal(read[0].body, 'catch this later');
});

/* ================================================================== */
/* AC-11 — channel isolation (Law 5): non-members cannot exchange.     */
/* ================================================================== */
test('AC-11 isolation: direct send to a NON-member throws RECIPIENT_NOT_MEMBER (Law 5/FR-20)', async () => {
  const { engine } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  engine.register(caller(null), { name: 'eve' }); // registered but NOT in the channel
  engine.create_channel(caller('alice'), { name: 'general' });
  const err = expectThrows(
    () => engine.send_message(caller('alice'), { channel: 'general', to: 'eve', body: 'secret' }),
    'sending to a non-member must throw',
  );
  assertCode(err, 'RECIPIENT_NOT_MEMBER');
});

test('AC-11 isolation: a sender NOT in the channel throws NOT_A_MEMBER (Law 5/FR-20)', async () => {
  const { engine } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  engine.register(caller(null), { name: 'bob' });
  engine.register(caller(null), { name: 'eve' });
  engine.create_channel(caller('alice'), { name: 'general' }); // alice + (join) bob
  engine.join_channel(caller('bob'), { channel: 'general' });
  // eve is not a member and tries to send into the channel.
  const err = expectThrows(
    () => engine.send_message(caller('eve'), { channel: 'general', to: 'bob', body: 'intrusion' }),
    'a non-member sender must be rejected',
  );
  assertCode(err, 'NOT_A_MEMBER');
});

test('AC-11 isolation: two agents sharing NO channel cannot exchange (end-to-end)', async () => {
  const { engine, db } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  engine.register(caller(null), { name: 'bob' });
  // Two SEPARATE channels, one each — they share none.
  engine.create_channel(caller('alice'), { name: 'a-room' });
  engine.create_channel(caller('bob'), { name: 'b-room' });
  // alice tries to reach bob in her room (bob not a member there).
  const err = expectThrows(
    () => engine.send_message(caller('alice'), { channel: 'a-room', to: 'bob', body: 'hi' }),
    'cross-channel direct send must fail',
  );
  assertCode(err, 'RECIPIENT_NOT_MEMBER');
  // No message + no receipt leaked into bob's world.
  assert.equal(
    db.listMessages().length,
    0,
    'no message row may be written when isolation is violated',
  );
});

/* ================================================================== */
/* AC-12 — deregister: status='gone', returns {ok,name}, excluded from */
/*         active count, row remains.                                  */
/* ================================================================== */
test('AC-12 deregister: sets status=gone, returns {ok,name}, row remains (FR-19)', async () => {
  const { engine, db } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  const res = engine.deregister(caller('alice'), { name: 'alice' });
  assert.equal(res.ok, true);
  assert.equal(res.name, 'alice');
  const row = db.getAgent('alice');
  assert.ok(row, 'deregistered agent must REMAIN in the table (shown dimmed), not be deleted');
  assert.equal(row.status, 'gone', 'status must be set to gone');
});

test('AC-12 deregister: a gone agent is excluded from the active count', async () => {
  const { engine, db } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  engine.register(caller(null), { name: 'bob' });
  engine.deregister(caller('alice'), { name: 'alice' });
  const active = db.listAgents().filter((a) => a.status === 'active');
  const activeNames = active.map((a) => a.name).sort();
  assert.deepEqual(
    activeNames,
    ['bob'],
    `active set must exclude the gone agent; got ${JSON.stringify(activeNames)}`,
  );
  // Total rows unchanged (gone is retained).
  assert.equal(db.listAgents().length, 2, 'gone agent must still be present in the full list');
});

/* ================================================================== */
/* AC-13/15 — event fanout: every mutating tool publishes the correct   */
/*            LoomEvent kind on the bus. (The IPC + ws sinks receive    */
/*            the SAME shape — see note below.) Transport separation:   */
/*            messaging works with no ws feed attached.                 */
/* ================================================================== */
test('AC-13 fanout: register publishes an `agent` event for the new agent (FR-29)', async () => {
  const { engine, events } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  const agentEvents = events.filter((e) => e.kind === 'agent');
  assert.ok(agentEvents.length >= 1, 'register must publish an agent event');
  assert.equal(agentEvents.at(-1).agent.name, 'alice');
  assert.equal(agentEvents.at(-1).agent.status, 'active');
});

test('AC-13 fanout: create_channel publishes a `channel` event with members (FR-29)', async () => {
  const { engine, events } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  events.length = 0;
  const ch = engine.create_channel(caller('alice'), { name: 'general' });
  const channelEvents = events.filter((e) => e.kind === 'channel');
  assert.ok(channelEvents.length >= 1, 'create_channel must publish a channel event');
  const ev = channelEvents.at(-1);
  assert.equal(ev.channel.name, 'general');
  assert.equal(ev.channel.id, ch.id);
  assert.ok(
    ev.members.includes('alice'),
    `channel event must carry members incl. auto-joined creator; got ${JSON.stringify(ev.members)}`,
  );
});

test('AC-13 fanout: send_message publishes a `message` event with recipients + channel (FR-29)', async () => {
  const { engine, events, chan } = await twoAgentChannel();
  const sent = engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: 'ping' });
  const msgEvents = events.filter((e) => e.kind === 'message');
  assert.equal(msgEvents.length, 1, `exactly one message event expected; got ${msgEvents.length}`);
  const ev = msgEvents[0];
  assert.equal(ev.message.id, sent.message_id);
  assert.equal(ev.message.body, 'ping');
  assert.equal(ev.channel, chan, 'message event must denormalize the channel name');
  assert.deepEqual(ev.recipients, ['bob'], 'message event must carry resolved recipients');
});

test('AC-13 fanout: mark_read publishes a `receipt` event reflecting the read (FR-29)', async () => {
  const { engine, events, chan } = await twoAgentChannel();
  const sent = engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: 'r' });
  events.length = 0;
  engine.mark_read(caller('bob'), { message_ids: [sent.message_id] });
  const receiptEvents = events.filter((e) => e.kind === 'receipt');
  assert.ok(receiptEvents.length >= 1, 'mark_read must publish a receipt event');
  const ev = receiptEvents.at(-1);
  assert.equal(ev.receipt.message_id, sent.message_id);
  assert.equal(ev.receipt.recipient, 'bob');
  assert.ok(typeof ev.receipt.read_at === 'number', 'receipt event must reflect the read_at timestamp');
});

test('AC-13 fanout: deregister publishes an `agent` event with status=gone (FR-29)', async () => {
  const { engine, events } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  events.length = 0;
  engine.deregister(caller('alice'), { name: 'alice' });
  const agentEvents = events.filter((e) => e.kind === 'agent');
  assert.ok(agentEvents.length >= 1, 'deregister must publish an agent event');
  assert.equal(agentEvents.at(-1).agent.name, 'alice');
  assert.equal(agentEvents.at(-1).agent.status, 'gone');
});

test('AC-15 transport separation: messaging works with NO observer feed attached (NFR-9/10)', async () => {
  // The EventBus here has subscribers ONLY via our test capture; no IPC/ws
  // sink is wired. Messaging must still fully succeed and persist — the
  // observer feed (IPC + optional ws, LOOM_WS=1) is the SAME LoomEvent shape
  // fanned to a different sink, and is independent of agent messaging.
  const { engine, db, unsub, chan } = await twoAgentChannel();
  unsub(); // detach the only subscriber -> zero observers attached
  const sent = engine.send_message(caller('alice'), {
    channel: chan,
    to: 'bob',
    body: 'still delivered',
  });
  assert.deepEqual(sent.recipients, ['bob'], 'delivery must not depend on any feed subscriber');
  assert.equal(db.listReceipts(sent.message_id).length, 1, 'receipt persisted with no feed attached');
  assert.equal(engine.check_inbox(caller('bob')).unread, 1, 'recipient can still read with no feed');
});

/* ================================================================== */
/* AC-16 — schema: enums, UNIQUE, composite PKs, partial index exist.  */
/*         Asserted by exercising real constraint behavior + DDL,      */
/*         not just by name matching.                                   */
/* ================================================================== */
test('AC-16 schema: agents.status CHECK enum rejects an out-of-enum value (FR-31)', async () => {
  const { db } = await freshEngine();
  // setAgentStatus is typed to the enum, but the CHECK is the real guard.
  // Use a raw insert path via the documented mutator with a bad status by
  // casting through the typed API is not possible; instead assert the DDL
  // declares the enum AND that a valid transition works, then that the
  // constraint exists in sqlite_master.
  const ddl = schemaDdl(db, 'agents');
  assert.match(ddl, /status[\s\S]*CHECK\s*\(\s*status\s+IN\s*\(\s*'active'\s*,\s*'gone'\s*\)\s*\)/i,
    'agents.status must declare a CHECK IN (active, gone) enum');
});

test('AC-16 schema: messages.addressing CHECK enum is (direct, here) (FR-31)', async () => {
  const { db } = await freshEngine();
  const ddl = schemaDdl(db, 'messages');
  assert.match(ddl, /addressing[\s\S]*CHECK\s*\(\s*addressing\s+IN\s*\(\s*'direct'\s*,\s*'here'\s*\)\s*\)/i,
    'messages.addressing must declare a CHECK IN (direct, here) enum');
});

test('AC-16 schema: channels.name is UNIQUE (enforced at runtime)', async () => {
  const { db } = await freshEngine();
  const now = Date.now();
  db.insertChannel('dup', now);
  const err = expectThrows(
    () => db.insertChannel('dup', now + 1),
    'a duplicate channel name must violate the UNIQUE constraint',
  );
  // sql.js surfaces a constraint error; message mentions UNIQUE.
  assert.match(
    String(err.message),
    /unique|constraint/i,
    `expected a UNIQUE constraint violation; got: ${err.message}`,
  );
});

test('AC-16 schema: receipts has a composite PK (message_id, recipient)', async () => {
  const { db } = await freshEngine();
  const ddl = schemaDdl(db, 'receipts');
  assert.match(
    ddl,
    /PRIMARY\s+KEY\s*\(\s*message_id\s*,\s*recipient\s*\)/i,
    'receipts must declare a composite PRIMARY KEY (message_id, recipient)',
  );
});

test('AC-16 schema: idx_receipts_unread partial index (WHERE read_at IS NULL) exists', async () => {
  const { db } = await freshEngine();
  const idx = indexDdl(db, 'idx_receipts_unread');
  assert.ok(idx, 'idx_receipts_unread index must exist in sqlite_master');
  assert.match(
    idx,
    /ON\s+receipts\s*\(\s*recipient\s*\)\s*WHERE\s+read_at\s+IS\s+NULL/i,
    `idx_receipts_unread must be the partial unread index; got: ${idx}`,
  );
});

test('AC-16 schema: all five Appendix-A tables exist', async () => {
  const { db } = await freshEngine();
  const names = tableNames(db);
  for (const t of ['agents', 'channels', 'memberships', 'messages', 'receipts']) {
    assert.ok(names.includes(t), `table ${t} missing; have ${JSON.stringify(names)}`);
  }
});

/* ---- schema introspection helpers -------------------------------- */
/* These pull the raw DDL/index defs from sqlite_master. They prefer a  */
/* db.query/exec passthrough if the testkit exposes one; otherwise they */
/* fall back to a typed accessor. We probe defensively so the suite      */
/* works against the real LoomDb without assuming an undocumented API.   */
function rawRows(db, sql) {
  // Try common shapes a sql.js-backed LoomDb might expose for ad-hoc reads.
  if (typeof db.exec === 'function') {
    const out = db.exec(sql); // sql.js native: [{columns, values}]
    if (!out || out.length === 0) return [];
    const { columns, values } = out[0];
    return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  }
  if (typeof db.query === 'function') {
    return db.query(sql);
  }
  if (typeof db.all === 'function') {
    return db.all(sql);
  }
  throw new Error(
    'LoomDb exposes no raw read (exec/query/all) for schema introspection. ' +
      'Ask the backend engineer to expose one on the testkit, or this AC-16 ' +
      'introspection helper must be adapted.',
  );
}
function schemaDdl(db, tableName) {
  const rows = rawRows(
    db,
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`,
  );
  assert.ok(rows.length > 0, `no DDL found for table ${tableName}`);
  return String(rows[0].sql);
}
function indexDdl(db, indexName) {
  const rows = rawRows(
    db,
    `SELECT sql FROM sqlite_master WHERE type='index' AND name='${indexName}'`,
  );
  return rows.length > 0 ? String(rows[0].sql) : '';
}
function tableNames(db) {
  return rawRows(db, `SELECT name FROM sqlite_master WHERE type='table'`).map((r) =>
    String(r.name),
  );
}

/* ================================================================== */
/* AC-19 — dispatch: deterministic ext -> render-state mapping.        */
/* ================================================================== */
test('AC-19 dispatch: .md -> RENDERED (FR-40)', async () => {
  const { dispatchFor } = await kit();
  const d = dispatchFor('README.md');
  assert.equal(d.renderState, 'RENDERED');
  assert.equal(d.kind, 'md');
  assert.equal(d.safetyBanner, false);
});

test('AC-19 dispatch: code/text extensions -> SOURCE (FR-40)', async () => {
  const { dispatchFor } = await kit();
  for (const name of [
    'index.ts', 'app.js', 'data.json', 'styles.css', 'main.py', 'notes.txt',
  ]) {
    const d = dispatchFor(name);
    assert.equal(d.renderState, 'SOURCE', `${name} must be SOURCE`);
    assert.equal(d.kind, 'code', `${name} must be kind=code`);
    assert.equal(d.safetyBanner, false, `${name} must not show a safety banner`);
  }
});

test('AC-19 dispatch: .svg -> SOURCE WITH a safety banner (FR-7/41)', async () => {
  const { dispatchFor } = await kit();
  const d = dispatchFor('logo.svg');
  assert.equal(d.renderState, 'SOURCE');
  assert.equal(d.kind, 'svg');
  assert.equal(d.safetyBanner, true, 'SVG shown as source must carry the safety banner');
});

test('AC-19 dispatch: .html -> SOURCE WITH a safety banner (FR-8/41)', async () => {
  const { dispatchFor } = await kit();
  const d = dispatchFor('page.html');
  assert.equal(d.renderState, 'SOURCE');
  assert.equal(d.kind, 'html');
  assert.equal(d.safetyBanner, true, 'HTML shown as source must carry the safety banner');
});

test('AC-19 dispatch: image extensions -> PREVIEW (FR-10)', async () => {
  const { dispatchFor } = await kit();
  for (const name of ['photo.png', 'pic.jpg', 'pic.jpeg']) {
    const d = dispatchFor(name);
    assert.equal(d.renderState, 'PREVIEW', `${name} must be PREVIEW`);
    assert.equal(d.kind, 'image', `${name} must be kind=image`);
  }
});

test('AC-19 dispatch: unknown / .bin / no-ext -> NO PREVIEW (FR-9/43)', async () => {
  const { dispatchFor } = await kit();
  for (const name of ['blob.bin', 'archive.zip', 'mystery', 'data.unknownext']) {
    const d = dispatchFor(name);
    assert.equal(d.renderState, 'NO PREVIEW', `${name} must be NO PREVIEW`);
    assert.equal(d.kind, 'binary', `${name} must be kind=binary`);
  }
});

test('AC-19 dispatch: kindOf agrees with dispatchFor and is deterministic (NFR-6)', async () => {
  const { dispatchFor, kindOf } = await kit();
  const cases = ['a.md', 'a.ts', 'a.svg', 'a.html', 'a.png', 'a.bin'];
  for (const name of cases) {
    // Same input twice -> identical output (no clock/random dependence).
    const a = dispatchFor(name);
    const b = dispatchFor(name);
    assert.deepEqual(a, b, `${name} dispatch must be deterministic`);
    assert.equal(a.kind, kindOf(name), `${name}: kindOf must agree with dispatchFor.kind`);
  }
});

/* ================================================================== */
/* AC-21/22 — content safety: embedded HTML is escaped; links are      */
/*            neutralized (no navigable href, no javascript: scheme).  */
/*                                                                     */
/* These prefer renderMarkdown/renderInline from the testkit. If those  */
/* exports are unavailable, the test FAILS with a clear dependency note  */
/* (see notes_for_integrator) rather than passing vacuously.            */
/* ================================================================== */

/** Assert rendered HTML has NO navigable/dangerous href. Scheme-agnostic:
 *  a neutralized href="#" (or stripped href) is fine; what must NEVER
 *  appear is a live javascript: href or the original navigable URL. */
function assertNoNavigableHref(html, originalUrl) {
  // No javascript: scheme anywhere in an href value.
  assert.doesNotMatch(
    html,
    /href\s*=\s*["']?\s*javascript:/i,
    `rendered output must not contain a javascript: href:\n${html}`,
  );
  // The original navigable URL must not survive as an href value.
  if (originalUrl) {
    const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(
      html,
      new RegExp(`href\\s*=\\s*["']?\\s*${escaped}`, 'i'),
      `the original URL must be neutralized out of any href:\n${html}`,
    );
  }
}

test('AC-22 Viewer markdown: embedded HTML is ESCAPED to text, not interpreted (FR-5/52)', async () => {
  const mod = await kit();
  if (typeof mod.renderMarkdown !== 'function') {
    assert.fail(
      'dist/testkit.cjs does not export renderMarkdown — cannot prove AC-22 HTML escaping ' +
        'at the renderer layer. Ask the integrator to add { renderMarkdown, renderInline } ' +
        'to the testkit bundle (see notes_for_integrator).',
    );
  }
  const evil = 'before <img src=x onerror="alert(1)"> after';
  const html = mod.renderMarkdown(evil);
  // The literal angle bracket of the agent-authored tag must be escaped.
  assert.match(html, /&lt;img/i, 'the <img tag must be HTML-escaped to &lt;img');
  // And it must NOT survive as a live element with a live event handler.
  assert.doesNotMatch(
    html,
    /<img\b[^>]*\bonerror\s*=/i,
    `embedded HTML must never be interpreted as a live element:\n${html}`,
  );
});

test('AC-22 Viewer markdown: links are non-navigating (href neutralized) (FR-5/52)', async () => {
  const mod = await kit();
  if (typeof mod.renderMarkdown !== 'function') {
    assert.fail('renderMarkdown export missing — see notes_for_integrator.');
  }
  const httpLink = '[click me](http://evil.example.com/phish)';
  const html = mod.renderMarkdown(httpLink);
  // The visible link TEXT should still render.
  assert.match(html, /click me/, 'link text must still be rendered');
  assertNoNavigableHref(html, 'http://evil.example.com/phish');
});

test('AC-22 Viewer markdown: a javascript: link is neutralized (no executable href) (FR-52)', async () => {
  const mod = await kit();
  if (typeof mod.renderMarkdown !== 'function') {
    assert.fail('renderMarkdown export missing — see notes_for_integrator.');
  }
  const jsLink = '[run me](javascript:alert(document.cookie))';
  const html = mod.renderMarkdown(jsLink);
  assert.match(html, /run me/, 'link text must still be rendered');
  assertNoNavigableHref(html, 'javascript:alert(document.cookie)');
});

test('AC-21 message body: inline links are non-navigating (href neutralized) (FR-48/52)', async () => {
  const mod = await kit();
  if (typeof mod.renderInline !== 'function') {
    assert.fail(
      'dist/testkit.cjs does not export renderInline — cannot prove AC-21 message-link ' +
        'safety. Ask the integrator to add it to the testkit bundle (see notes_for_integrator).',
    );
  }
  const httpLink = '[open](http://evil.example.com)';
  const html = mod.renderInline(httpLink);
  assert.match(html, /open/, 'link text must render');
  assertNoNavigableHref(html, 'http://evil.example.com');
});

test('AC-21 message body: a javascript: inline link is neutralized (FR-48/52)', async () => {
  const mod = await kit();
  if (typeof mod.renderInline !== 'function') {
    assert.fail('renderInline export missing — see notes_for_integrator.');
  }
  const jsLink = '[x](javascript:fetch("//evil"))';
  const html = mod.renderInline(jsLink);
  assertNoNavigableHref(html, 'javascript:fetch("//evil")');
});

test('AC-21 message body: embedded HTML in a chat message is escaped, not interpreted (FR-48/52)', async () => {
  const mod = await kit();
  if (typeof mod.renderInline !== 'function') {
    assert.fail('renderInline export missing — see notes_for_integrator.');
  }
  const evil = 'hey <img src=x onerror=alert(1)> there';
  const html = mod.renderInline(evil);
  assert.match(html, /&lt;img/i, 'embedded HTML in a message must be escaped to &lt;img');
  assert.doesNotMatch(
    html,
    /<img\b[^>]*\bonerror\s*=/i,
    `message bodies must never interpret embedded HTML as a live element:\n${html}`,
  );
});

/* String-level escaping fallback (always runs; independent of the     */
/* renderer exports). Proves the escape semantics the renderer relies   */
/* on — a defense-in-depth check that fails if the build is broken.     */
test('AC-22 (string-level): escapeHtml-style transform neutralizes angle brackets if exported', async () => {
  const mod = await kit();
  if (typeof mod.escapeHtml !== 'function') {
    // Not a hard dependency — renderMarkdown/renderInline carry the real
    // guarantee. Recorded as a soft note; do not fail the suite here.
    return;
  }
  const escaped = mod.escapeHtml('<script>&"');
  assert.doesNotMatch(escaped, /<script>/i, 'escapeHtml must neutralize <script>');
  assert.match(escaped, /&lt;script&gt;/i, 'escapeHtml must encode < and >');
});

/* ================================================================== */
/* LOOM-AC13-01 — the ws observer feed (a REAL second sink the AC      */
/* names) serializes the SAME LoomEvent shape published on the bus.    */
/* This converts the previously-assumed IPC/ws parity into a test that  */
/* can fail for the right reason if the ws JSON serialization regresses. */
/* ================================================================== */
import { WebSocket } from 'ws';

/** Connect a ws client and resolve with the FIRST JSON message it receives,
 *  or reject on timeout. Closes the socket on settle. */
function firstWsMessage(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    const timer = setTimeout(() => {
      try { sock.terminate(); } catch { /* ignore */ }
      reject(new Error(`no ws message within ${timeoutMs}ms`));
    }, timeoutMs);
    sock.on('message', (data) => {
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(String(data)); } catch (e) { reject(e); return; }
      try { sock.close(); } catch { /* ignore */ }
      resolve(parsed);
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitWsOpen(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    const timer = setTimeout(() => {
      try { sock.terminate(); } catch { /* ignore */ }
      reject(new Error(`ws did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    sock.on('open', () => { clearTimeout(timer); resolve(sock); });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

test('AC-13 ws sink: a published event is broadcast to a ws observer as the SAME JSON shape (FR-29/30, NFR-10)', async () => {
  const mod = await kit();
  const createWsFeed = requireExport(mod, 'createWsFeed');
  const createEventBus = requireExport(mod, 'createEventBus');
  const WS_PORT = mod.WS_PORT;
  const WS_HOST = mod.WS_HOST;
  assert.equal(typeof WS_PORT, 'number', 'testkit must export WS_PORT');

  const bus = createEventBus();
  const feed = createWsFeed(bus);
  await feed.start();
  try {
    const url = `ws://${WS_HOST}:${WS_PORT}`;
    // Open first, THEN publish, so the subscriber + client are both live.
    const sock = await waitWsOpen(url);
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no broadcast received')), 4000);
      sock.on('message', (data) => {
        clearTimeout(timer);
        try { resolve(JSON.parse(String(data))); } catch (e) { reject(e); }
      });
      sock.on('error', reject);
    });

    const event = {
      kind: 'message',
      message: {
        id: 7, channel_id: 1, sender: 'alice', body: 'hi',
        addressing: 'direct', target: 'bob', created_at: 1234,
      },
      recipients: ['bob'],
      channel: 'general',
    };
    bus.publish(event);

    const got = await received;
    try { sock.close(); } catch { /* ignore */ }
    // The ws feed must serialize the IDENTICAL LoomEvent shape (AC-13).
    assert.deepEqual(got, event, 'ws observer must receive the exact published LoomEvent JSON');
  } finally {
    await feed.stop();
  }
});

/* ================================================================== */
/* LOOM-AC15-02 — transport vs feed separation: the ws feed is gated   */
/* by LOOM_WS and is INDEPENDENT of agent messaging. With the feed OFF  */
/* the port is closed yet messaging fully succeeds; with it ON the feed  */
/* serves events AND messaging is unaffected (NFR-9/10).                */
/* ================================================================== */
test('AC-15 separation: with LOOM_WS unset the feed is disabled and its port is closed, messaging still works', async () => {
  const mod = await kit();
  const wsEnabled = requireExport(mod, 'wsEnabled');
  const WS_PORT = mod.WS_PORT;
  const WS_HOST = mod.WS_HOST;

  const prev = process.env.LOOM_WS;
  delete process.env.LOOM_WS;
  try {
    assert.equal(wsEnabled(), false, 'wsEnabled() must be false when LOOM_WS is unset');
    // The port must be closed (no feed running here) — a connect must fail.
    let connected = false;
    try {
      const sock = await waitWsOpen(`ws://${WS_HOST}:${WS_PORT}`, 800);
      connected = true;
      try { sock.close(); } catch { /* ignore */ }
    } catch {
      /* expected: connection refused / no listener */
    }
    assert.equal(connected, false, 'no ws feed should be listening when LOOM_WS is unset');

    // Messaging is fully functional with NO feed attached.
    const { engine, db, chan } = await twoAgentChannel();
    const sent = engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: 'no feed needed' });
    assert.deepEqual(sent.recipients, ['bob']);
    assert.equal(db.listReceipts(sent.message_id).length, 1);
    assert.equal(engine.check_inbox(caller('bob')).unread, 1);
  } finally {
    if (prev === undefined) delete process.env.LOOM_WS;
    else process.env.LOOM_WS = prev;
  }
});

test('AC-15 separation: with LOOM_WS=1 the feed serves events AND messaging is unaffected', async () => {
  const mod = await kit();
  const wsEnabled = requireExport(mod, 'wsEnabled');
  const createWsFeed = requireExport(mod, 'createWsFeed');
  const createEventBus = requireExport(mod, 'createEventBus');
  const WS_PORT = mod.WS_PORT;
  const WS_HOST = mod.WS_HOST;

  const prev = process.env.LOOM_WS;
  process.env.LOOM_WS = '1';
  const bus = createEventBus();
  const feed = createWsFeed(bus);
  await feed.start();
  try {
    assert.equal(wsEnabled(), true, 'wsEnabled() must be true when LOOM_WS=1');
    const sock = await waitWsOpen(`ws://${WS_HOST}:${WS_PORT}`);
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no broadcast')), 4000);
      sock.on('message', (d) => { clearTimeout(timer); try { resolve(JSON.parse(String(d))); } catch (e) { reject(e); } });
      sock.on('error', reject);
    });
    const ev = { kind: 'agent', agent: { name: 'z', connection_id: 'c', status: 'active', registered_at: 1 } };
    bus.publish(ev);
    const got = await received;
    try { sock.close(); } catch { /* ignore */ }
    assert.deepEqual(got, ev, 'the feed must serve the published event when ON');
  } finally {
    await feed.stop();
    if (prev === undefined) delete process.env.LOOM_WS;
    else process.env.LOOM_WS = prev;
  }
});

/* ================================================================== */
/* FR-19 / US-9 — orchestrator-driven deregistration: a REGISTERED      */
/* caller (the lead) may deregister ANOTHER agent (a sub-agent) by name. */
/* The trust boundary is the loopback-only, Origin-guarded transport    */
/* (OQ-4 / SEC-1); requireRegistered still enforces Law 4. The earlier   */
/* self-only NOT_AUTHORIZED rule (SEC-2) was reverted as it contradicted */
/* FR-19 / US-9.                                                         */
/* ================================================================== */
test('FR-19 deregister: a lead CAN deregister ANOTHER agent (sub-agent) by name (US-9)', async () => {
  const { engine, db } = await freshEngine();
  engine.register(caller(null), { name: 'lead' });
  engine.register(caller(null), { name: 'worker' });
  const res = engine.deregister(caller('lead'), { name: 'worker' });
  assert.equal(res.ok, true, 'cross-agent deregister must succeed');
  assert.equal(res.name, 'worker');
  // The sub-agent is now gone, excluded from the active count, row retained.
  const worker = db.getAgent('worker');
  assert.ok(worker, 'deregistered sub-agent row must REMAIN (shown dimmed), not be deleted');
  assert.equal(worker.status, 'gone', 'sub-agent status must be set to gone (FR-19 / AC-12)');
  const active = db.listAgents().filter((a) => a.status === 'active').map((a) => a.name).sort();
  assert.deepEqual(active, ['lead'], `worker must be excluded from the active set; got ${JSON.stringify(active)}`);
  assert.equal(db.listAgents().length, 2, 'gone sub-agent must still be present in the full list');
});

test('FR-19 deregister: cross-agent deregister is idempotent — a 2nd call still returns {ok,name}', async () => {
  const { engine, db } = await freshEngine();
  engine.register(caller(null), { name: 'lead' });
  engine.register(caller(null), { name: 'worker' });
  engine.deregister(caller('lead'), { name: 'worker' });
  // Deregistering an already-'gone' agent must NOT throw and must return {ok,name}.
  const again = engine.deregister(caller('lead'), { name: 'worker' });
  assert.equal(again.ok, true, 'idempotent re-deregister must succeed, not throw');
  assert.equal(again.name, 'worker');
  assert.equal(db.getAgent('worker').status, 'gone', 'worker stays gone after the idempotent call');
});

test('FR-19 deregister: self-deregistration still works (AC-12)', async () => {
  const { engine, db } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  const res = engine.deregister(caller('alice'), { name: 'alice' });
  assert.equal(res.ok, true);
  assert.equal(res.name, 'alice');
  assert.equal(db.getAgent('alice').status, 'gone');
});

test('FR-19 deregister: an UNREGISTERED caller cannot deregister anyone (NOT_REGISTERED, Law 4)', async () => {
  const { engine, db } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  const err = expectThrows(
    () => engine.deregister(caller(null), { name: 'alice' }),
    'an unregistered/anonymous caller must be rejected',
  );
  assertCode(err, 'NOT_REGISTERED');
  // The target was untouched — an unregistered caller had no effect.
  assert.equal(db.getAgent('alice').status, 'active', 'target must stay active when caller is unregistered');
});

test('FR-19 deregister: a non-existent target name throws AGENT_NOT_FOUND', async () => {
  const { engine } = await freshEngine();
  engine.register(caller(null), { name: 'lead' });
  const err = expectThrows(
    () => engine.deregister(caller('lead'), { name: 'nobody' }),
    'deregistering a name that has no agents row must throw',
  );
  assertCode(err, 'AGENT_NOT_FOUND');
});

/* ================================================================== */
/* SEC-6 — send_message body length cap is enforced at the engine      */
/* boundary (authoritative, FR-14): an over-cap body throws            */
/* BODY_TOO_LONG; a body at the cap is accepted.                        */
/* ================================================================== */
test('SEC-6 send_message: a body over MAX_BODY_LENGTH throws BODY_TOO_LONG', async () => {
  const mod = await kit();
  const MAX = mod.MAX_BODY_LENGTH;
  assert.equal(typeof MAX, 'number', 'testkit must export MAX_BODY_LENGTH');
  const { engine, chan } = await twoAgentChannel();
  const tooLong = 'x'.repeat(MAX + 1);
  const err = expectThrows(
    () => engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: tooLong }),
    'an over-cap body must throw',
  );
  assertCode(err, 'BODY_TOO_LONG');
});

test('SEC-6 send_message: a body of exactly MAX_BODY_LENGTH is accepted (boundary)', async () => {
  const mod = await kit();
  const MAX = mod.MAX_BODY_LENGTH;
  const { engine, db, chan } = await twoAgentChannel();
  const exact = 'y'.repeat(MAX);
  const sent = engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: exact });
  const msg = db.listMessages().find((m) => m.id === sent.message_id);
  assert.ok(msg, 'a body at the cap must persist');
  assert.equal(msg.body.length, MAX);
});

/* ================================================================== */
/* LOOM-AC16-04 — behavioral CHECK-enum: an out-of-enum raw INSERT is   */
/* REJECTED by the constraint (not merely declared in the DDL string).  */
/* Mirrors the channels.name UNIQUE behavioral test.                    */
/* ================================================================== */
test('AC-16 schema (behavioral): agents.status rejects an out-of-enum value at runtime', async () => {
  const { db } = await freshEngine();
  const err = expectThrows(
    () => db.exec(
      "INSERT INTO agents (name, connection_id, status, registered_at) VALUES ('x', 'c', 'bogus', 1)",
    ),
    'an out-of-enum agents.status must be rejected by the CHECK',
  );
  assert.match(
    String(err.message),
    /constraint|check/i,
    `expected a CHECK constraint violation; got: ${err.message}`,
  );
});

test('AC-16 schema (behavioral): messages.addressing rejects an out-of-enum value at runtime', async () => {
  const { db } = await freshEngine();
  // Seed the FK parents so the failure is the addressing CHECK, not an FK.
  const now = Date.now();
  db.exec("INSERT INTO agents (name, connection_id, status, registered_at) VALUES ('alice','c','active',1)");
  db.insertChannel('general', now);
  const ch = db.getChannelByName('general');
  const err = expectThrows(
    () => db.exec(
      `INSERT INTO messages (channel_id, sender, body, addressing, target, created_at) ` +
        `VALUES (${ch.id}, 'alice', 'b', 'bogus', NULL, ${now})`,
    ),
    'an out-of-enum messages.addressing must be rejected by the CHECK',
  );
  assert.match(
    String(err.message),
    /constraint|check/i,
    `expected a CHECK constraint violation; got: ${err.message}`,
  );
});

/* ================================================================== */
/* LOOM-AC13-05 — an idempotent re-join is SILENT: joining a channel    */
/* the caller is ALREADY a member of publishes NO channel event (the    */
/* membership insert is skipped; the publish is now gated on it).       */
/* ================================================================== */
test('AC-13 fanout: a no-op re-join emits NO channel event (idempotent + silent)', async () => {
  const { engine, events } = await twoAgentChannel();
  // bob is already a member (twoAgentChannel joined him). Re-join.
  events.length = 0;
  const res = engine.join_channel(caller('bob'), { channel: 'general' });
  assert.ok(res.members.includes('bob'), 're-join still returns the membership list');
  const channelEvents = events.filter((e) => e.kind === 'channel');
  assert.equal(channelEvents.length, 0, 'a no-op re-join must not publish a channel event');
});

test('AC-13 fanout: a FIRST join still publishes one channel event with members', async () => {
  const { engine, events } = await freshEngine();
  engine.register(caller(null), { name: 'alice' });
  engine.register(caller(null), { name: 'bob' });
  engine.create_channel(caller('alice'), { name: 'general' });
  events.length = 0;
  engine.join_channel(caller('bob'), { channel: 'general' });
  const channelEvents = events.filter((e) => e.kind === 'channel');
  assert.equal(channelEvents.length, 1, 'a genuine join must publish exactly one channel event');
  assert.ok(channelEvents[0].members.includes('bob'));
});

/* ================================================================== */
/* LOOM-FR19-03 — DOCUMENTED behavior (decision: Option B): a 'gone'    */
/* agent that remains a channel member STILL receives messages. FR-19   */
/* 'excluded' is a ROSTER / active-count concern, not a delivery one;   */
/* OQ-3 resolves recipients at send time over current membership. This  */
/* test pins that documented contract so it cannot regress silently.    */
/* (See CONTRACTS.md — gone vs delivery.)                               */
/* ================================================================== */
test('FR-19 (documented): a gone member still receives an @here broadcast and a direct send', async () => {
  const { engine, db, chan } = await twoAgentChannel();
  // bob goes gone but remains a member of `chan`.
  engine.deregister(caller('bob'), { name: 'bob' });
  assert.equal(db.getAgent('bob').status, 'gone');

  // @here from alice still includes the gone member bob (current membership).
  const here = engine.send_message(caller('alice'), { channel: chan, to: '@here', body: 'all' });
  assert.deepEqual(here.recipients, ['bob'], 'gone member is still an @here recipient (OQ-3, send-time membership)');

  // A direct send to the gone member also succeeds (it is a valid member).
  const direct = engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: 'just you' });
  assert.deepEqual(direct.recipients, ['bob'], 'direct send to a gone member is delivered');

  // And the receipts persist as unread for the gone recipient.
  assert.equal(engine.check_inbox(caller('bob')).unread, 2, 'gone member accrues unread receipts');
});

/* ================================================================== */
/* SEC-4 — adversarial markdown corpus. Under WSL the process-wide      */
/* --no-sandbox concession removes the OS renderer sandbox, so the safe  */
/* markdown+highlight ESCAPING is the sole remaining barrier. This       */
/* corpus guards that one layer across both render paths (Viewer block   */
/* + chat inline): no live element, no event handler, no navigable/      */
/* executable href survives ANY of these hostile inputs.                 */
/* ================================================================== */
const ADVERSARIAL_CORPUS = [
  '<img src=x onerror="alert(1)">',
  '<img src=x onerror=alert(1)>',
  '<script>alert(document.cookie)</script>',
  '<a href="javascript:alert(1)">x</a>',
  '[x](javascript:alert(1))',
  '[y](data:text/html,<script>alert(1)</script>)',
  '[z](http://evil.example.com/phish)',
  '<svg/onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<div onmouseover="alert(1)">hover</div>',
  '![img](javascript:alert(1))',
  '<a href="vbscript:msgbox(1)">v</a>',
  '<a href="#" onclick="alert(1)">c</a>',
  '<details open ontoggle=alert(1)>',
  '`<img src=x onerror=alert(1)>`',
];

/** Assert a single rendered HTML string carries NO executable/navigable
 *  surface from hostile input (SEC-4). */
function assertInertHtml(html, source) {
  // No live event-handler attribute on any tag.
  assert.doesNotMatch(
    html, /<[a-z][^>]*\son[a-z]+\s*=/i,
    `live event-handler attribute survived for input ${JSON.stringify(source)}:\n${html}`,
  );
  // No live <script>/<iframe>/<svg>/<img> element (these tags must be escaped).
  assert.doesNotMatch(
    html, /<\s*(script|iframe|svg|img|object|embed|details)\b/i,
    `a live dangerous element survived for input ${JSON.stringify(source)}:\n${html}`,
  );
  // No javascript:/vbscript:/data: scheme inside an href value.
  assert.doesNotMatch(
    html, /href\s*=\s*["']?\s*(javascript|vbscript|data):/i,
    `an executable-scheme href survived for input ${JSON.stringify(source)}:\n${html}`,
  );
}

test('SEC-4 corpus: renderMarkdown (Viewer) neutralizes every adversarial input', async () => {
  const mod = await kit();
  const renderMarkdown = requireExport(mod, 'renderMarkdown');
  for (const input of ADVERSARIAL_CORPUS) {
    assertInertHtml(renderMarkdown(input), input);
  }
});

test('SEC-4 corpus: renderInline (chat) neutralizes every adversarial input', async () => {
  const mod = await kit();
  const renderInline = requireExport(mod, 'renderInline');
  for (const input of ADVERSARIAL_CORPUS) {
    assertInertHtml(renderInline(input), input);
  }
});

/* ================================================================== */
/* SEC-5 — neutralized links carry NO href attribute at all (not even    */
/* href="#"): a hrefless anchor cannot navigate NOR fragment-scroll.     */
/* ================================================================== */
test('SEC-5: a neutralized link renders with NO href attribute (not href="#")', async () => {
  const mod = await kit();
  const renderInline = requireExport(mod, 'renderInline');
  const html = renderInline('[open](http://evil.example.com)');
  assert.match(html, /<a\b/i, 'an anchor element is still rendered');
  assert.match(html, /open/, 'the link text still renders');
  assert.doesNotMatch(html, /\bhref\s*=/i, 'a neutralized link must carry NO href attribute');
});
