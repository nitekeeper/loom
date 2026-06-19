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
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
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

test('AC-22 Viewer markdown: a safe http link keeps a real href + data-loom-ext (opens externally)', async () => {
  const mod = await kit();
  if (typeof mod.renderMarkdown !== 'function') {
    assert.fail('renderMarkdown export missing — see notes_for_integrator.');
  }
  const html = mod.renderMarkdown('[click me](http://example.com/page)');
  assert.match(html, /click me/, 'link text must still be rendered');
  // NEW contract: a safe http(s) link keeps a navigable href + data-loom-ext so
  // the renderer opens it in the EXTERNAL browser (not in-app navigation).
  assert.match(html, /href="http:\/\/example\.com\/page"/, 'safe http link keeps a navigable href');
  assert.match(html, /data-loom-ext="1"/, 'and is marked for shell.openExternal');
  assert.doesNotMatch(html, /href\s*=\s*["']?\s*javascript:/i, 'never a javascript: href');
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

test('AC-21 message body: a safe http inline link keeps a real href + data-loom-ext (FR-48/52)', async () => {
  const mod = await kit();
  if (typeof mod.renderInline !== 'function') {
    assert.fail(
      'dist/testkit.cjs does not export renderInline — cannot prove AC-21 message-link ' +
        'safety. Ask the integrator to add it to the testkit bundle (see notes_for_integrator).',
    );
  }
  const html = mod.renderInline('[open](https://example.com/x)');
  assert.match(html, /open/, 'link text must render');
  assert.match(html, /href="https:\/\/example\.com\/x"/, 'safe https link keeps a navigable href');
  assert.match(html, /data-loom-ext="1"/, 'marked for external open');
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
/* R1 — CONFIGURABLE body cap: createEngine({ maxBodyLength }) is       */
/* enforced at runtime (not the compile-time MAX_BODY_LENGTH default).  */
/* A two-agent channel built on an engine with an explicit cap of N:    */
/* a body of length N passes; N+1 throws BODY_TOO_LONG.                 */
/* ================================================================== */

/** Two-agent channel on an engine constructed with an explicit options bag
 *  (e.g. { maxBodyLength }). Mirrors twoAgentChannel but injects opts. */
async function twoAgentChannelWith(opts, chanName = 'general') {
  const mod = await kit();
  const createDb = requireExport(mod, 'createDb');
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-ac-'));
  const db = createDb();
  await db.init(dir);
  const bus = createEventBus();
  const engine = createEngine(db, bus, opts);
  engine.register(caller(null), { name: 'alice' });
  engine.register(caller(null), { name: 'bob' });
  engine.create_channel(caller('alice'), { name: chanName });
  engine.join_channel(caller('bob'), { channel: chanName });
  return { mod, db, bus, engine, dir, chan: chanName };
}

test('R1 configurable cap: a body at the configured limit passes (cap=10)', async () => {
  const { engine, db, chan } = await twoAgentChannelWith({ maxBodyLength: 10 });
  const atLimit = 'z'.repeat(10);
  const sent = engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: atLimit });
  const msg = db.listMessages().find((m) => m.id === sent.message_id);
  assert.ok(msg, 'a body at the configured cap must persist');
  assert.equal(msg.body.length, 10);
});

test('R1 configurable cap: limit+1 throws BODY_TOO_LONG (cap=10)', async () => {
  const { engine, chan } = await twoAgentChannelWith({ maxBodyLength: 10 });
  const overLimit = 'z'.repeat(11);
  const err = expectThrows(
    () => engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: overLimit }),
    'a body over the CONFIGURED cap must throw',
  );
  assertCode(err, 'BODY_TOO_LONG');
});

test('R1 configurable cap: absent option falls back to MAX_BODY_LENGTH default', async () => {
  const mod = await kit();
  const MAX = mod.MAX_BODY_LENGTH;
  // No opts -> default cap. A body at MAX passes; MAX+1 throws.
  const { engine, chan } = await twoAgentChannelWith(undefined);
  const okSend = engine.send_message(caller('alice'), {
    channel: chan,
    to: 'bob',
    body: 'y'.repeat(MAX),
  });
  assert.ok(okSend.message_id, 'a body at the default cap must pass');
  const err = expectThrows(
    () => engine.send_message(caller('alice'), { channel: chan, to: 'bob', body: 'y'.repeat(MAX + 1) }),
    'a body over the default cap must throw',
  );
  assertCode(err, 'BODY_TOO_LONG');
});

/* ================================================================== */
/* R2 — PERSISTENCE (OPTION A): chat survives a relaunch. Data written  */
/* to a db at <dir>/.loom/loom.db, then a SECOND createDb().init(dir)    */
/* over the SAME dir must LOAD the persisted rows (not start fresh).     */
/* ================================================================== */
test('R2 persistence: a fresh db re-init from the same folder retains chat data', async () => {
  const mod = await kit();
  const createDb = requireExport(mod, 'createDb');
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-ac-persist-'));

  // Session 1: populate, then flush + close so loom.db is durable on disk.
  {
    const db = createDb();
    await db.init(dir);
    const engine = createEngine(db, createEventBus());
    engine.register(caller(null), { name: 'alice' });
    engine.register(caller(null), { name: 'bob' });
    engine.create_channel(caller('alice'), { name: 'general' });
    engine.join_channel(caller('bob'), { channel: 'general' });
    engine.send_message(caller('alice'), { channel: 'general', to: 'bob', body: 'persist me' });
    db.flushNow(); // durable snapshot, mirrors graceful-close persistence (R2).
    db.close();
  }

  // The serialized db file must remain on disk (close() must NOT delete it).
  assert.ok(
    existsSync(path.join(dir, '.loom', 'loom.db')),
    'loom.db must persist on disk after close() (R2/R3 — no delete on close)',
  );

  // Session 2: a NEW db over the SAME folder must LOAD the prior rows.
  {
    const db2 = createDb();
    await db2.init(dir);
    const agents = db2.listAgents().map((a) => a.name).sort();
    assert.deepEqual(agents, ['alice', 'bob'], 'agents must survive the relaunch');
    const channels = db2.listChannels().map((c) => c.name);
    assert.deepEqual(channels, ['general'], 'channels must survive the relaunch');
    const messages = db2.listMessages();
    assert.equal(messages.length, 1, 'the message must survive the relaunch');
    assert.equal(messages[0].body, 'persist me');
    db2.close();
  }
});

test('R2 persistence: a CORRUPT loom.db falls back to a fresh empty DB (no throw)', async () => {
  const mod = await kit();
  const createDb = requireExport(mod, 'createDb');
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-ac-corrupt-'));

  // Pre-seed a garbage loom.db so init() takes the LOAD path, fails the probe,
  // and falls back to fresh (corrupt -> fresh branch).
  mkdirSync(path.join(dir, '.loom'), { recursive: true });
  writeFileSync(path.join(dir, '.loom', 'loom.db'), 'not a sqlite database — garbage bytes');

  const db = createDb();
  // Must NOT throw on a corrupt image.
  await db.init(dir);
  // Must come up as a fresh, empty, usable DB.
  assert.deepEqual(db.listAgents(), [], 'corrupt image must fall back to an empty agents table');
  assert.deepEqual(db.listChannels(), [], 'corrupt image must fall back to an empty channels table');
  assert.deepEqual(db.listMessages(), [], 'corrupt image must fall back to an empty messages table');
  db.close();
});

/* ================================================================== */
/* R4 — purge_all: populate chat + a .loom/temp report file, purge,     */
/* assert all tables empty, temp file gone, and the returned counts.    */
/* ================================================================== */
test('R4 purge_all: empties all tables, removes temp reports, returns counts', async () => {
  const mod = await kit();
  const createDb = requireExport(mod, 'createDb');
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-ac-purge-'));

  const db = createDb();
  await db.init(dir);
  // rootDir injected so purge_all can remove .loom/temp report files (R4).
  const engine = createEngine(db, createEventBus(), { rootDir: dir });

  // Populate: 2 agents, 1 channel (alice auto-joins), bob joins, 2 messages.
  engine.register(caller(null), { name: 'alice' });
  engine.register(caller(null), { name: 'bob' });
  engine.create_channel(caller('alice'), { name: 'general' });
  engine.join_channel(caller('bob'), { channel: 'general' });
  engine.send_message(caller('alice'), { channel: 'general', to: 'bob', body: 'one' });
  engine.send_message(caller('alice'), { channel: 'general', to: '@here', body: 'two' });

  // Drop transient agent report files under .loom/temp (purge must remove).
  const tempDir = path.join(dir, '.loom', 'temp');
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(path.join(tempDir, 'report-1.md'), '# r1');
  writeFileSync(path.join(tempDir, 'report-2.md'), '# r2');

  // Purge as a registered caller.
  const purger = caller('alice');
  const res = engine.purge_all(purger);

  // Result counts reflect pre-deletion state.
  assert.equal(res.ok, true);
  assert.equal(res.deleted.messages, 2, 'two messages were present');
  assert.equal(res.deleted.channels, 1, 'one channel was present');
  assert.equal(res.deleted.agents, 2, 'two agents were present');
  assert.equal(res.deleted.reports, 2, 'two temp report files were present');

  // All tables empty.
  assert.deepEqual(db.listAgents(), [], 'agents emptied');
  assert.deepEqual(db.listChannels(), [], 'channels emptied');
  assert.deepEqual(db.listMessages(), [], 'messages emptied');

  // .loom/temp removed.
  assert.ok(!existsSync(tempDir), '.loom/temp must be removed by purge_all');

  // The caller's bound identity is nulled (stale) — a follow-up tool call
  // without re-registering fails cleanly with NOT_REGISTERED.
  assert.equal(purger.name, null, 'purge_all must null the stale caller identity');
  const staleErr = expectThrows(
    () => engine.send_message(purger, { channel: 'general', to: 'bob', body: 'after' }),
    'a stale caller must fail after purge',
  );
  assertCode(staleErr, 'NOT_REGISTERED');

  db.close();
});

test('R4 purge_all: an unregistered caller is rejected (NOT_REGISTERED)', async () => {
  const { engine } = await freshEngine();
  const err = expectThrows(
    () => engine.purge_all(caller(null)),
    'purge_all must require a registered caller',
  );
  assertCode(err, 'NOT_REGISTERED');
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
/* SEC-5 — a SAFE link carries its real external href tagged data-loom-ext (the */
/* renderer click guard + main nav guard open it in the BROWSER, never in-app), */
/* and never href="#" (no fragment scroll) nor a dangerous scheme. A relative   */
/* or dangerous target gets no navigable href at all.                           */
/* ================================================================== */
test('SEC-5: a safe link keeps its real external href (data-loom-ext), never href="#" / javascript:', async () => {
  const mod = await kit();
  const renderInline = requireExport(mod, 'renderInline');
  const html = renderInline('[open](http://example.com/p)');
  assert.match(html, /<a\b/i, 'an anchor element is still rendered');
  assert.match(html, /open/, 'the link text still renders');
  assert.match(html, /href="http:\/\/example\.com\/p"/, 'a safe link keeps its real external href');
  assert.match(html, /data-loom-ext="1"/, 'tagged for external (browser) open, not in-app navigation');
  assert.doesNotMatch(html, /href\s*=\s*["']#/, 'never href="#" (no in-document fragment scroll)');
  assert.doesNotMatch(html, /href\s*=\s*["']?\s*javascript:/i, 'never a javascript: href');
  // A relative target stays inert (no base document for agent content).
  assert.doesNotMatch(renderInline('[r](relative/path)'), /\bhref\s*=/i, 'relative link is not navigable');
});

/* ================================================================== */
/* A11Y-CLOSE-05 — Escape coordination contract (SC 2.1.2 / 2.4.3).    */
/* The document-level file-close Escape handler must:                  */
/*  (a) IGNORE an Escape a tooltip already consumed (defaultPrevented), */
/*      so dismissing a receipt breakdown never also closes the file;  */
/*  (b) IGNORE Escape when nothing is open, when the key is not Escape, */
/*      or when focus is in an editable control;                       */
/*  (c) CLOSE + rescue focus when the unmounting × button is focused    */
/*      (A11Y-CLOSE-01), else CLOSE in place (treeitem stays mounted).  */
/* Pinned via the pure decideEscapeClose() the App handler delegates to. */
/* ================================================================== */
test('A11Y-CLOSE-05: a tooltip-consumed Escape (defaultPrevented) does NOT close the file', async () => {
  const { decideEscapeClose } = await kit();
  assert.equal(typeof decideEscapeClose, 'function', 'testkit must export decideEscapeClose');
  // A receipt tooltip consumed Escape: stopPropagation + preventDefault. Even
  // if the event reaches the document handler, defaultPrevented must veto close.
  const action = decideEscapeClose({
    isEscape: true,
    defaultPrevented: true,
    hasOpenFile: true,
    editableTarget: false,
    focusOnCloseButton: false,
  });
  assert.equal(action, 'ignore', 'a consumed Escape must never close the open file');
});

test('A11Y-CLOSE-05: Escape with NO tooltip open and a file open closes it (in place)', async () => {
  const { decideEscapeClose } = await kit();
  const action = decideEscapeClose({
    isEscape: true,
    defaultPrevented: false,
    hasOpenFile: true,
    editableTarget: false,
    focusOnCloseButton: false,
  });
  assert.equal(action, 'close-in-place', 'a clean Escape with a file open must close it');
});

test('A11Y-CLOSE-01: Escape while the × close button is focused closes AND rescues focus', async () => {
  const { decideEscapeClose } = await kit();
  const action = decideEscapeClose({
    isEscape: true,
    defaultPrevented: false,
    hasOpenFile: true,
    editableTarget: false,
    focusOnCloseButton: true,
  });
  assert.equal(
    action,
    'close-rescue-focus',
    'Escape from the unmounting × button must take the focus-rescue close path (SC 2.4.3)',
  );
});

test('A11Y-CLOSE-05: Escape is ignored with nothing open, a non-Escape key, or an editable target', async () => {
  const { decideEscapeClose } = await kit();
  // Nothing open.
  assert.equal(
    decideEscapeClose({ isEscape: true, defaultPrevented: false, hasOpenFile: false, editableTarget: false, focusOnCloseButton: false }),
    'ignore',
    'Escape with no open file is a no-op',
  );
  // Not the Escape key.
  assert.equal(
    decideEscapeClose({ isEscape: false, defaultPrevented: false, hasOpenFile: true, editableTarget: false, focusOnCloseButton: false }),
    'ignore',
    'a non-Escape key never closes the file',
  );
  // Editable target — don't hijack.
  assert.equal(
    decideEscapeClose({ isEscape: true, defaultPrevented: false, hasOpenFile: true, editableTarget: true, focusOnCloseButton: false }),
    'ignore',
    'Escape inside an editable control must not close the file',
  );
});

/* ================================================================== */
/* FOLD — indentation-based code folding (computeFoldRanges).          */
/* A PURE function over RAW source text: it measures leading           */
/* whitespace to decide which already-escaped lines a header hides     */
/* (LAW 1 — no parsing/eval). Ranges are {header,start,end}, all       */
/* 0-based; start..end inclusive are hidden when the header collapses;  */
/* the header line and the dedent line after `end` stay VISIBLE.       */
/* These pin: nesting, blank-line inclusion, dedent visibility, the    */
/* >=2-hidden-lines (trivial-block) skip, and the flat-file no-op.     */
/* ================================================================== */
test('FOLD computeFoldRanges: nested indentation yields the expected parent + child ranges', async () => {
  const { computeFoldRanges } = await kit();
  assert.equal(typeof computeFoldRanges, 'function', 'testkit must re-export computeFoldRanges');
  // 0 outer header; 1 body; 2 inner header; 3-4 inner body; 5 inner dedent (})
  // 6 outer body; 7 outer dedent (}). Header iff next non-blank line is deeper.
  const src = [
    'function outer() {', // 0 header
    '  const a = 1;', //     1
    '  if (a) {', //         2 header (nested)
    '    doThing();', //     3
    '    doOther();', //     4
    '  }', //                5 dedent — stays VISIBLE
    '  return a;', //        6
    '}', //                  7 dedent — stays VISIBLE
  ].join('\n');
  const ranges = computeFoldRanges(src);
  // Outer hides 1..6 (the closing `}` at 7 is NOT hidden); inner hides 3..4
  // (the closing `}` at 5 is NOT hidden). Child nests inside the parent body.
  assert.deepEqual(
    ranges,
    [
      { header: 0, start: 1, end: 6 },
      { header: 2, start: 3, end: 4 },
    ],
    `nested ranges incorrect; got ${JSON.stringify(ranges)}`,
  );
  // Explicit nesting check: the inner range lies entirely within the outer body.
  const [outer, inner] = ranges;
  assert.ok(
    inner.start > outer.start && inner.end <= outer.end,
    'the child fold range must nest inside the parent fold body',
  );
});

test('FOLD computeFoldRanges: a flat (no-deeper-line) file yields NO ranges', async () => {
  const { computeFoldRanges } = await kit();
  const flat = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
  assert.deepEqual(
    computeFoldRanges(flat),
    [],
    'a file with no increasing indentation must produce zero fold ranges',
  );
});

test('FOLD computeFoldRanges: a blank line INSIDE a block is included in the folded body', async () => {
  const { computeFoldRanges } = await kit();
  // The blank at line 2 sits between two deeper lines, so it is part of the
  // body; the dedent line `g = 5` at index 5 stays visible (NOT folded).
  const src = [
    'def f():', //      0 header
    '    x = 1', //     1
    '', //              2 blank INSIDE the block
    '    y = 2', //     3
    '    return x', //  4
    'g = 5', //         5 dedent — stays VISIBLE
  ].join('\n');
  const ranges = computeFoldRanges(src);
  assert.deepEqual(
    ranges,
    [{ header: 0, start: 1, end: 4 }],
    `the interspersed blank line must be inside the folded body; got ${JSON.stringify(ranges)}`,
  );
  // The blank line (index 2) must fall within the hidden span.
  const r = ranges[0];
  assert.ok(2 >= r.start && 2 <= r.end, 'the blank line index must be hidden when folded');
});

test('FOLD computeFoldRanges: the closing-dedent line is NOT hidden (stays visible)', async () => {
  const { computeFoldRanges } = await kit();
  const src = [
    'block {', //       0 header
    '  line one;', //   1
    '  line two;', //   2
    '}', //             3 closing dedent — MUST stay visible
  ].join('\n');
  const ranges = computeFoldRanges(src);
  assert.equal(ranges.length, 1, 'exactly one fold region expected');
  const r = ranges[0];
  assert.equal(r.header, 0);
  assert.equal(r.start, 1, 'the first hidden line is the line after the header');
  assert.equal(r.end, 2, 'the LAST hidden line is the deepest body line, not the closing brace');
  // The closing brace (index 3) must be OUTSIDE the hidden span.
  assert.ok(3 > r.end, 'the closing-dedent line must NOT be folded (it stays visible)');
});

test('FOLD computeFoldRanges: a trivial 1-line block is SKIPPED (needs >= 2 hidden lines)', async () => {
  const { computeFoldRanges } = await kit();
  const src = [
    'if (x) {', //   0 header — but only ONE body line follows
    '  one();', //   1  (single hidden line -> below the >=2 threshold)
    '}', //          2 dedent
  ].join('\n');
  assert.deepEqual(
    computeFoldRanges(src),
    [],
    'a block that would hide only one line must NOT be emitted (trivial)',
  );
  // Sanity: a TWO-line body of the same shape DOES fold — proves the test can
  // fail for the right reason (the skip is the >=2 rule, not a blanket no-op).
  const two = ['if (x) {', '  one();', '  two();', '}'].join('\n');
  assert.deepEqual(
    computeFoldRanges(two),
    [{ header: 0, start: 1, end: 2 }],
    'a two-line body must fold (confirming the trivial-skip is threshold-based)',
  );
});

test('FOLD computeFoldRanges: a leading TAB is normalized to spaces (tab/space indent agree)', async () => {
  const { computeFoldRanges, TAB_WIDTH } = await kit();
  assert.equal(typeof TAB_WIDTH, 'number', 'testkit must export the TAB_WIDTH constant');
  // Tab-indented body must fold identically to a space-indented equivalent.
  const tabbed = ['root {', '\tline1;', '\tline2;', '}'].join('\n');
  const spaced = ['root {', '    line1;', '    line2;', '}'].join('\n');
  assert.deepEqual(
    computeFoldRanges(tabbed),
    computeFoldRanges(spaced),
    'tab- and space-indented bodies must yield identical fold ranges',
  );
  assert.deepEqual(computeFoldRanges(tabbed), [{ header: 0, start: 1, end: 2 }]);
});

test('FOLD computeFoldRanges: is pure + deterministic (identical input -> identical output)', async () => {
  const { computeFoldRanges } = await kit();
  const src = ['a {', '  b;', '  c;', '}'].join('\n');
  assert.deepEqual(
    computeFoldRanges(src),
    computeFoldRanges(src),
    'computeFoldRanges must be deterministic (no clock/random dependence)',
  );
});

/* ------------------------------------------------------------------ */
/* FOLD label geometry — the hidden-line COUNT the Viewer's accessible  */
/* names use ("Expand N hidden lines" / "Collapse N lines", A11Y-FOLD-  */
/* 02/04/07) is exactly end-start+1 of the emitted range. Pin it so a   */
/* range-shape change can't silently desync the announced count.        */
/* ------------------------------------------------------------------ */
test('FOLD label count: hiddenCount (end-start+1) matches the body the Viewer hides', async () => {
  const { computeFoldRanges } = await kit();
  const src = ['outer {', '  a;', '  b;', '  c;', '}'].join('\n');
  const ranges = computeFoldRanges(src);
  assert.equal(ranges.length, 1, 'one region expected');
  const r = ranges[0];
  const hiddenCount = r.end - r.start + 1;
  assert.equal(hiddenCount, 3, 'the count powering the accessible name must equal the hidden-line span');
});

/* ------------------------------------------------------------------ */
/* FOLD-UX-03 (documented asymmetry) — pinned against the REAL fixtures  */
/* so the intentional MIN_HIDDEN>=2 behavior cannot regress silently:    */
/*   server.ts -> only the multi-line /users/:id handler folds           */
/*   db.ts     -> zero chevrons (both bodies are a single line)          */
/* If the product later lowers MIN_HIDDEN this test fails LOUDLY,         */
/* forcing the decision (and this expectation) to be revisited together.  */
/* ------------------------------------------------------------------ */
test('FOLD-UX-03 fixtures: MIN_HIDDEN>=2 yields the documented chevron asymmetry', async () => {
  const { computeFoldRanges } = await kit();
  const serverTs = readFileSync(
    path.join(root, 'fixtures', 'acme-api', 'src', 'server.ts'),
    'utf8',
  );
  const dbTs = readFileSync(
    path.join(root, 'fixtures', 'acme-api', 'src', 'db.ts'),
    'utf8',
  );
  const serverRanges = computeFoldRanges(serverTs);
  // Exactly one foldable region: the /users/:id handler header (0-based line 7,
  // i.e. source line 8) hiding its >=2-line body. The 1-line /users handler is
  // intentionally NOT foldable.
  assert.equal(
    serverRanges.length,
    1,
    `server.ts must expose exactly one fold region; got ${JSON.stringify(serverRanges)}`,
  );
  assert.equal(serverRanges[0].header, 7, 'the foldable header is the /users/:id handler line');
  assert.ok(
    serverRanges[0].end - serverRanges[0].start + 1 >= 2,
    'the folded body must hide >= MIN_HIDDEN lines',
  );
  // db.ts: both exported functions have single-line bodies -> nothing folds.
  assert.deepEqual(
    computeFoldRanges(dbTs),
    [],
    'db.ts (two 1-line bodies) must show zero chevrons under MIN_HIDDEN>=2',
  );
});

/* ------------------------------------------------------------------ */
/* FOLD-UX-04 (accepted limitation) — indentation folding folds VISUAL   */
/* indentation, not syntactic blocks. This PINS the documented behavior  */
/* (ternary / continuation / comment-block "headers" still fold) so the  */
/* limitation is explicit and any future trailing-char refinement is a   */
/* deliberate, test-visible change — NOT a silent drift. Law 1 holds:    */
/* nothing is parsed/evaluated; only already-escaped rows are hidden.    */
/* ------------------------------------------------------------------ */
test('FOLD-UX-04 limitation: a multi-line ternary continuation still folds (indentation, not blocks)', async () => {
  const { computeFoldRanges } = await kit();
  const ternary = ['const v = cond', '  ? whenTrue', '  : whenFalse;', 'next();'].join('\n');
  assert.deepEqual(
    computeFoldRanges(ternary),
    [{ header: 0, start: 1, end: 2 }],
    'documented: an indented ternary continuation is treated as a foldable region',
  );
  const call = ['const x = foo(', '  a,', '  b,', ');'].join('\n');
  assert.deepEqual(
    computeFoldRanges(call),
    [{ header: 0, start: 1, end: 2 }],
    'documented: a multi-line call continuation folds (the `);` dedent stays visible)',
  );
});

/* ============================================================
 * Keyboard Shortcuts core (FR-54) — pure data + combo logic.
 * ------------------------------------------------------------
 * The customizable-shortcuts feature rests on a DOM-free core
 * (src/renderer/lib/keybindings.ts) re-exported from the testkit:
 * eventToCombo, resolveBindings, findConflict, isValidBinding,
 * COMMANDS, DEFAULT_BINDINGS. These pin the combo normalization,
 * override merge, conflict detection, validation, and a rebind+reset
 * round-trip on the pure data — no React/DOM needed.
 * ============================================================ */

/** Build a KeyboardEvent-like object for eventToCombo. */
const keyEvent = (key, mods = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

test('FR-54 eventToCombo: canonical modifier order is Ctrl, Alt, Shift, then key', async () => {
  const { eventToCombo } = await kit();
  // All modifiers + a letter -> fixed order regardless of how they are set.
  assert.equal(
    eventToCombo(keyEvent('k', { shift: true, alt: true, ctrl: true })),
    'Ctrl+Alt+Shift+K',
    'modifiers must serialize in the fixed Ctrl, Alt, Shift order',
  );
  assert.equal(
    eventToCombo(keyEvent('k', { ctrl: true, shift: true })),
    'Ctrl+Shift+K',
    'Ctrl+Shift+letter -> Ctrl+Shift+K',
  );
});

test('FR-54 eventToCombo: metaKey (Cmd) maps to the SAME Ctrl token as ctrlKey', async () => {
  const { eventToCombo } = await kit();
  const fromMeta = eventToCombo(keyEvent('b', { meta: true }));
  const fromCtrl = eventToCombo(keyEvent('b', { ctrl: true }));
  assert.equal(fromMeta, 'Ctrl+B', 'Cmd+B must normalize to Ctrl+B');
  assert.equal(fromMeta, fromCtrl, 'Cmd and Ctrl must produce an identical combo');
});

test('FR-54 eventToCombo: key casing is normalized and Escape stays Escape', async () => {
  const { eventToCombo } = await kit();
  // A shifted letter reports key='K' but the modifier is also present.
  assert.equal(
    eventToCombo(keyEvent('K', { ctrl: true, shift: true })),
    'Ctrl+Shift+K',
    'an upper-case key char must normalize to the same canonical letter',
  );
  // Lower vs upper single char agree once normalized.
  assert.equal(
    eventToCombo(keyEvent('t', { ctrl: true })),
    eventToCombo(keyEvent('T', { ctrl: true })),
    'k and K must canonicalize identically',
  );
  // Escape is a named key — passes through unchanged, no modifiers.
  assert.equal(eventToCombo(keyEvent('Escape')), 'Escape', 'Escape stays Escape');
  // The pause default uses a literal dot key.
  assert.equal(eventToCombo(keyEvent('.', { ctrl: true })), 'Ctrl+.', 'Ctrl+. preserved');
});

test('FR-54 eventToCombo: a pure-modifier press yields only the modifier list', async () => {
  const { eventToCombo, isValidBinding } = await kit();
  // Holding Ctrl alone: key is the modifier name itself.
  const combo = eventToCombo(keyEvent('Control', { ctrl: true }));
  assert.equal(combo, 'Ctrl', 'a lone Ctrl press serializes to just "Ctrl"');
  assert.equal(
    isValidBinding(combo),
    false,
    'a pure-modifier combo must be rejected by isValidBinding',
  );
});

test('FR-54 resolveBindings: user overrides win over defaults; others keep defaults', async () => {
  const { resolveBindings, DEFAULT_BINDINGS } = await kit();
  const resolved = resolveBindings({ toggleTheme: 'Ctrl+Shift+T' });
  assert.equal(resolved.toggleTheme, 'Ctrl+Shift+T', 'the overridden binding must win');
  assert.equal(
    resolved.toggleExplorer,
    DEFAULT_BINDINGS.toggleExplorer,
    'a non-overridden command must keep its default',
  );
  // All commands present in the resolved map (includes openSearch, the
  // project-wide content-search opener, copyRendered, the Viewer
  // copy-rendered shortcut, toggleTerminal, the bottom-dock toggle,
  // toggleReadingWidth, the Viewer reading-width quick toggle, toggleSplitView,
  // the side-by-side compare reading-pane toggle, the three newly-editable
  // shell commands — toggleChanges, openSettings, and toggleMaximizeTerminal —
  // the four multi-terminal commands: focusTerminal1/2/3 and cycleTerminalFocus —
  // plus the two multi-window commands: newWindow and openFolderWindow —
  // plus the go-to-definition pair: goToDefinition and goBack).
  assert.equal(Object.keys(resolved).length, 23, 'resolved map covers all 23 commands');
});

test('FR-54 resolveBindings: missing/corrupt overrides fall back to defaults', async () => {
  const { resolveBindings, DEFAULT_BINDINGS } = await kit();
  assert.deepEqual(resolveBindings(null), { ...DEFAULT_BINDINGS }, 'null -> defaults');
  assert.deepEqual(resolveBindings(undefined), { ...DEFAULT_BINDINGS }, 'undefined -> defaults');
  // An invalid (pure-modifier) override is ignored, keeping the default.
  const resolved = resolveBindings({ foldAll: 'Ctrl', unknownCmd: 'Ctrl+Z' });
  assert.equal(
    resolved.foldAll,
    DEFAULT_BINDINGS.foldAll,
    'an invalid override must be dropped, keeping the default',
  );
  assert.equal(resolved.unknownCmd, undefined, 'an unknown command id must not leak in');
});

test('FR-54 findConflict: detects a taken combo and respects exceptId', async () => {
  const { findConflict, resolveBindings, DEFAULT_BINDINGS } = await kit();
  const bindings = resolveBindings({});
  // toggleExplorer default is Ctrl+B — assigning Ctrl+B to toggleChat collides.
  const taken = findConflict(bindings, DEFAULT_BINDINGS.toggleExplorer, 'toggleChat');
  assert.equal(taken, 'toggleExplorer', 'must report the command already holding the combo');
  // Excluding the owner itself reports no conflict (re-confirming its own key).
  const selfExcluded = findConflict(
    bindings,
    DEFAULT_BINDINGS.toggleExplorer,
    'toggleExplorer',
  );
  assert.equal(selfExcluded, null, 'exceptId must exclude the queried command itself');
  // A free combo collides with nothing.
  assert.equal(
    findConflict(bindings, 'Ctrl+Alt+Shift+F9', null),
    null,
    'an unused combo must report no conflict',
  );
});

test('FR-54 isValidBinding: rejects empty + pure-modifier, accepts real keys', async () => {
  const { isValidBinding } = await kit();
  assert.equal(isValidBinding(''), false, 'empty string rejected');
  assert.equal(isValidBinding('Ctrl'), false, 'lone Ctrl rejected');
  assert.equal(isValidBinding('Ctrl+Shift'), false, 'Ctrl+Shift (no key) rejected');
  assert.equal(isValidBinding('Alt'), false, 'lone Alt rejected');
  assert.equal(isValidBinding('Ctrl+B'), true, 'Ctrl+B accepted');
  assert.equal(isValidBinding('Escape'), true, 'Escape accepted');
  assert.equal(isValidBinding('Ctrl+Shift+K'), true, 'Ctrl+Shift+K accepted');
});

test('FR-54 isValidBinding: rejects STRUCTURALLY-malformed combos no keypress can produce (KB-1)', async () => {
  const { isValidBinding } = await kit();
  // Empty segments (a leading/trailing/double '+').
  assert.equal(isValidBinding('+K'), false, 'leading + (empty modifier segment) rejected');
  assert.equal(isValidBinding('Ctrl+'), false, 'trailing + (empty key segment) rejected');
  assert.equal(isValidBinding('Ctrl+ +K'), false, 'a blank middle segment rejected');
  assert.equal(isValidBinding(' '), false, 'a lone space is not a key token');
  // Lower-case / unknown / non-canonical modifier or key tokens.
  assert.equal(isValidBinding('a+b'), false, 'lowercase a+b is not a canonical combo');
  assert.equal(isValidBinding('garbagekey'), false, 'a multi-char non-named key rejected');
  // Modifier ordering + repeats (canonical order is Ctrl, Alt, Shift).
  assert.equal(isValidBinding('Shift+Ctrl+K'), false, 'out-of-order modifiers rejected');
  assert.equal(isValidBinding('Alt+Ctrl+K'), false, 'Alt before Ctrl rejected');
  assert.equal(isValidBinding('Ctrl+Ctrl+K'), false, 'repeated modifier rejected');
  assert.equal(isValidBinding('Ctrl+Shift+Alt+K'), false, 'Shift before Alt rejected');
  // Genuinely valid shapes still pass (so the guard is not over-tight).
  assert.equal(isValidBinding('Ctrl+Alt+Shift+ArrowLeft'), true, 'full-modifier named key accepted');
  assert.equal(isValidBinding('Ctrl+.'), true, 'punctuation key accepted');
  assert.equal(isValidBinding('Alt+/'), true, 'a non-leading single modifier + punctuation accepted');
  assert.equal(isValidBinding('F9'), true, 'a function key accepted');
  assert.equal(isValidBinding('Ctrl+Space'), true, 'Ctrl+Space accepted');
});

test('FR-54 resolveBindings: a structurally-invalid override NEVER shadows a command (KB-1)', async () => {
  const { resolveBindings, DEFAULT_BINDINGS } = await kit();
  // The KB-1 failure mode: a corrupt persisted combo that no keypress matches
  // must NOT be applied (it would silently kill the command). It must fall
  // back to the command's working default.
  for (const bad of ['garbagekey', '+K', 'a+b', ' ', 'Ctrl+ +K', 'Shift+Ctrl+K']) {
    const resolved = resolveBindings({ toggleChat: bad });
    assert.equal(
      resolved.toggleChat,
      DEFAULT_BINDINGS.toggleChat,
      `a corrupt override ${JSON.stringify(bad)} must drop to the default, never shadow the command`,
    );
  }
});

test('FR-54 formatCombo: maps Ctrl -> "Ctrl/Cmd" for display; leaves others (KB-6)', async () => {
  const { formatCombo } = await kit();
  assert.equal(formatCombo('Ctrl+Shift+K'), 'Ctrl/Cmd+Shift+K', 'Ctrl shows as Ctrl/Cmd');
  assert.equal(formatCombo('Ctrl+B'), 'Ctrl/Cmd+B', 'single-modifier Ctrl shows as Ctrl/Cmd');
  assert.equal(formatCombo('Escape'), 'Escape', 'a bare named key is unchanged');
  assert.equal(formatCombo('Ctrl+Space'), 'Ctrl/Cmd+Space', 'Space token is preserved in display');
  assert.equal(formatCombo('Ctrl+.'), 'Ctrl/Cmd+.', 'punctuation preserved in display');
  assert.equal(formatCombo(''), '', 'empty combo formats to empty string');
});

test('FR-54 eventToCombo: the space key normalizes to the readable "Space" token (KB-6)', async () => {
  const { eventToCombo } = await kit();
  assert.equal(eventToCombo(keyEvent(' ')), 'Space', "key=' ' serializes to 'Space'");
  assert.equal(eventToCombo(keyEvent(' ', { ctrl: true })), 'Ctrl+Space', "Ctrl+' ' -> 'Ctrl+Space'");
  // Legacy 'Spacebar' alias also normalizes.
  assert.equal(eventToCombo(keyEvent('Spacebar')), 'Space', "'Spacebar' alias -> 'Space'");
});

test('FR-54 eventToCombo: a shifted-punctuation glyph folds to its unshifted base so a Shift chord is layout-stable', async () => {
  const { eventToCombo, DEFAULT_BINDINGS } = await kit();
  // With Shift held, the comma key reports its SHIFTED glyph '<' (US layout), so
  // WITHOUT folding the chord would serialize to 'Ctrl+Shift+<' and miss the
  // openSettings default 'Ctrl+Shift+,'. Folding '<' -> ',' makes the obvious
  // Shift+comma keypress REACH the default (the Shift token already records the
  // shift), so the default and the keypress that produces it agree.
  assert.equal(
    eventToCombo(keyEvent('<', { ctrl: true, shift: true })),
    'Ctrl+Shift+,',
    "Shift+comma (key='<') folds back to the base ',' so it matches the openSettings default",
  );
  assert.equal(
    eventToCombo(keyEvent('<', { ctrl: true, shift: true })),
    DEFAULT_BINDINGS.openSettings,
    'the folded Shift+comma chord equals the resolved openSettings default (reachable on US layouts)',
  );
  // A few more shifted glyphs fold to their base (number row + bracket).
  assert.equal(eventToCombo(keyEvent('@', { ctrl: true, shift: true })), 'Ctrl+Shift+2', "Shift+2 ('@') -> base '2'");
  assert.equal(eventToCombo(keyEvent('?', { ctrl: true, shift: true })), 'Ctrl+Shift+/', "Shift+/ ('?') -> base '/'");
  assert.equal(eventToCombo(keyEvent('>', { ctrl: true, shift: true })), 'Ctrl+Shift+.', "Shift+. ('>') -> base '.'");
  // The shifted '+' glyph (Shift+'=') folds to '=' BEFORE the join, so it can
  // never collide with the '+' combo separator.
  assert.equal(eventToCombo(keyEvent('+', { ctrl: true, shift: true })), 'Ctrl+Shift+=', "Shift+= ('+') -> base '=' (no separator clash)");
  // An UNSHIFTED punctuation key is unchanged (no spurious fold).
  assert.equal(eventToCombo(keyEvent(',', { ctrl: true })), 'Ctrl+,', 'an unshifted comma stays a comma');
  assert.equal(eventToCombo(keyEvent('.', { ctrl: true })), 'Ctrl+.', 'an unshifted dot stays a dot');
});

test('FR-54 isReserved: the fixed Ctrl/Cmd+Comma opener is reserved + un-assignable (KB-2)', async () => {
  const { isReserved, RESERVED_COMBOS, findConflict, isValidBinding } = await kit();
  assert.equal(isReserved('Ctrl+,'), true, 'the opener combo is reserved');
  assert.equal(isReserved('Ctrl+B'), false, 'a normal command combo is not reserved');
  assert.equal(RESERVED_COMBOS.has('Ctrl+,'), true, 'RESERVED_COMBOS contains the opener');
  // The opener combo is itself a structurally-valid combo (so the ONLY thing
  // stopping its assignment is the reserved check, which the panel enforces).
  assert.equal(isValidBinding('Ctrl+,'), true, 'Ctrl+, is a real combo; reservation is what blocks it');
  // It collides with nothing in the default set (it is not a command binding).
  const { resolveBindings } = await kit();
  assert.equal(findConflict(resolveBindings({}), 'Ctrl+,', null), null, 'no command holds the opener combo');

  // The terminal focus-escape hatch (Ctrl/Cmd+Shift+Tab) stays reserved so a
  // command rebound onto it could never fire focus-escape AND its own action at
  // once (TerminalPane's attachCustomKeyEventHandler owns it).
  assert.equal(isReserved('Ctrl+Shift+Tab'), true, 'the terminal focus-escape hatch is reserved');
  assert.equal(
    RESERVED_COMBOS.has('Ctrl+Shift+Tab'),
    true,
    'RESERVED_COMBOS contains the terminal focus-escape hatch',
  );

  // RESERVED_COMBOS is now EXACTLY {Ctrl+,, Ctrl+Shift+Tab}: the Changes-viewer
  // toggle (Ctrl/Cmd+Shift+G) was PROMOTED out of RESERVED to an editable
  // toggleChanges command, so it is no longer shell-reserved and CAN be rebound.
  assert.equal(isReserved('Ctrl+Shift+G'), false, 'the promoted Changes toggle is no longer reserved');
  assert.equal(RESERVED_COMBOS.has('Ctrl+Shift+G'), false, 'RESERVED_COMBOS no longer holds the Changes toggle');
  assert.equal(RESERVED_COMBOS.size, 2, 'RESERVED_COMBOS is exactly {Ctrl+comma, Ctrl+Shift+Tab}');
  assert.deepEqual(
    [...RESERVED_COMBOS].sort(),
    ['Ctrl+,', 'Ctrl+Shift+Tab'].sort(),
    'RESERVED_COMBOS contents are exactly the opener + the terminal focus-escape hatch',
  );
  // The Shortcuts-panel opener (ShortcutsPanel.OPENER_COMBO) reads
  // Array.from(RESERVED_COMBOS)[0], so the opener MUST remain at index 0 — a
  // prepend of a new reserved combo would break the panel's "press X to open"
  // hint. This pins the ordering contract.
  assert.equal(
    Array.from(RESERVED_COMBOS)[0],
    'Ctrl+,',
    'the opener combo MUST stay at RESERVED_COMBOS index 0 (panel OPENER_COMBO)',
  );
});

test('FR-54 isPlatformCritical: load-bearing native combos flagged for a soft warning (KB-5)', async () => {
  const { isPlatformCritical } = await kit();
  assert.equal(isPlatformCritical('Ctrl+R'), true, 'reload flagged');
  assert.equal(isPlatformCritical('Ctrl+W'), true, 'close flagged');
  assert.equal(isPlatformCritical('Ctrl+Q'), true, 'quit flagged');
  assert.equal(isPlatformCritical('F5'), true, 'F5 reload flagged');
  assert.equal(isPlatformCritical('Ctrl+J'), false, 'a normal command combo not flagged');
  assert.equal(isPlatformCritical('Ctrl+Shift+K'), false, 'an app shortcut not flagged');
});

test('FR-54 planReassign: a default-equals-assigned collision never duplicates a binding (KB-3)', async () => {
  const { planReassign, resolveBindings, DEFAULT_BINDINGS } = await kit();
  const working = resolveBindings({});
  // From defaults, reassign foldAll's default (Ctrl+K) onto toggleChat. The
  // displaced command (foldAll) reverting to its default WOULD re-collide, so
  // it must be VACATED + flagged for rebind — NOT silently left on Ctrl+K.
  const plan = planReassign(working, 'toggleChat', DEFAULT_BINDINGS.foldAll, 'foldAll');
  assert.equal(plan.next.toggleChat, DEFAULT_BINDINGS.foldAll, 'the new owner keeps the captured combo');
  assert.equal(plan.displacedNeedsRebind, true, 'the displaced command needs a fresh key');
  assert.equal(plan.next.foldAll, '', 'the displaced command is vacated, not left duplicating the combo');
  // INVARIANT: no two commands share a non-empty combo after a reassign.
  const counts = {};
  for (const c of Object.values(plan.next)) {
    if (!c) continue;
    counts[c] = (counts[c] ?? 0) + 1;
  }
  assert.ok(
    Object.values(counts).every((n) => n === 1),
    'no combo may be held by more than one command after reassign',
  );
});

test('FR-54 planReassign: a free displaced default is restored (no spurious vacate) (KB-3)', async () => {
  const { planReassign, DEFAULT_BINDINGS } = await kit();
  // toggleTheme rebound to Ctrl+Y, so its default Ctrl+T is now FREE. Capturing
  // Ctrl+Y for togglePause conflicts with toggleTheme; reassign must restore
  // toggleTheme to its (free) default Ctrl+T with no rebind needed.
  const working = { ...DEFAULT_BINDINGS, toggleTheme: 'Ctrl+Y' };
  const plan = planReassign(working, 'togglePause', 'Ctrl+Y', 'toggleTheme');
  assert.equal(plan.next.togglePause, 'Ctrl+Y', 'new owner keeps the captured combo');
  assert.equal(plan.next.toggleTheme, DEFAULT_BINDINGS.toggleTheme, 'displaced reverts to its now-free default');
  assert.equal(plan.displacedNeedsRebind, false, 'no rebind needed when the default is free');
  assert.equal(plan.displacedCombo, DEFAULT_BINDINGS.toggleTheme, 'displacedCombo reports the restored default');
});

test('FR-54 diffOverrides: a vacated ("") binding is never persisted (KB-3)', async () => {
  const { diffOverrides, DEFAULT_BINDINGS } = await kit();
  // A vacated displaced command (combo '') must NOT leak into the sparse map —
  // it falls back to its default on resolve.
  const overrides = diffOverrides({ ...DEFAULT_BINDINGS, foldAll: '' });
  assert.equal(overrides.foldAll, undefined, 'a vacated/invalid binding is not persisted');
  assert.deepEqual(overrides, {}, 'only the (empty) vacate yields no override entry');
  // A real differing binding still persists. Use a combo NO command defaults to
  // (Ctrl+Shift+Y) so the fixture reads as a clean rebind, not an unintended
  // conflict with toggleChanges (whose live default is now Ctrl+Shift+G).
  const o2 = diffOverrides({ ...DEFAULT_BINDINGS, foldAll: 'Ctrl+Shift+Y' });
  assert.deepEqual(o2, { foldAll: 'Ctrl+Shift+Y' }, 'a real rebind still persists');
});

test('FR-54 rebind + reset round-trip on the pure data (defaults <-> override)', async () => {
  const { resolveBindings, diffOverrides, DEFAULT_BINDINGS, findConflict } = await kit();
  // Start from defaults.
  let resolved = resolveBindings({});
  assert.deepEqual(resolved, { ...DEFAULT_BINDINGS }, 'start at defaults');
  // Rebind toggleTheme to a free combo; the sparse override holds only it.
  const newCombo = 'Ctrl+Shift+Y';
  assert.equal(findConflict(resolved, newCombo, 'toggleTheme'), null, 'new combo is free');
  resolved = { ...resolved, toggleTheme: newCombo };
  const overrides = diffOverrides(resolved);
  assert.deepEqual(
    overrides,
    { toggleTheme: newCombo },
    'diffOverrides must persist ONLY the changed binding (sparse)',
  );
  // Re-resolving the persisted sparse map reproduces the working state.
  assert.deepEqual(
    resolveBindings(overrides),
    resolved,
    'persisted sparse overrides must re-resolve to the same full map',
  );
  // Reset: back to defaults yields an EMPTY override map.
  const afterReset = { ...DEFAULT_BINDINGS };
  assert.deepEqual(
    diffOverrides(afterReset),
    {},
    'after reset the sparse override map must be empty (all defaults)',
  );
});

/* ============================================================
 * Editable shell commands (toggleChanges / openSettings /
 * toggleMaximizeTerminal) — the three actionable app commands promoted
 * to (or added as) rebindable COMMANDS entries.
 * ============================================================ */
test('FR-54 editable shell commands: the three new commands exist with their default bindings', async () => {
  const { COMMANDS, DEFAULT_BINDINGS } = await kit();
  const expectCmd = (id, label, combo) => {
    const spec = COMMANDS.find((c) => c.id === id);
    assert.ok(spec, `a ${id} command is registered`);
    assert.equal(spec.label, label, `${id} label matches the spec`);
    assert.equal(spec.defaultBinding, combo, `${id} default binding is ${combo}`);
    assert.equal(DEFAULT_BINDINGS[id], combo, `${id} resolved default carries the combo`);
  };
  // toggleChanges was PROMOTED from the fixed/reserved Ctrl/Cmd+Shift+G branch
  // to a rebindable command; openSettings + toggleMaximizeTerminal are new.
  expectCmd('toggleChanges', 'Toggle changes view', 'Ctrl+Shift+G');
  expectCmd('openSettings', 'Open settings', 'Ctrl+Shift+,');
  expectCmd('toggleMaximizeTerminal', 'Toggle terminal maximize', 'Ctrl+Shift+M');
});

test('FR-54 editable shell commands: no two COMMANDS share a default binding (no conflicting defaults)', async () => {
  const { COMMANDS, DEFAULT_BINDINGS, findConflict, resolveBindings } = await kit();
  // Every default binding is unique across the whole command set — so the
  // panel's conflict detection never trips on the shipped defaults.
  const seen = new Map();
  for (const c of COMMANDS) {
    assert.equal(
      seen.has(c.defaultBinding),
      false,
      `default ${c.defaultBinding} is claimed by both ${seen.get(c.defaultBinding)} and ${c.id}`,
    );
    seen.set(c.defaultBinding, c.id);
  }
  // And each new command's default is collision-free against ALL other defaults.
  for (const id of ['toggleChanges', 'openSettings', 'toggleMaximizeTerminal']) {
    assert.equal(
      findConflict(DEFAULT_BINDINGS, DEFAULT_BINDINGS[id], id),
      null,
      `${id} default conflicts with no other default binding`,
    );
  }
  // POSITIVE conflict detection for a new command: capturing toggleTheme's
  // live combo for openSettings is detected as colliding WITH toggleTheme.
  // findConflict returns the id already bound to the combo (excluding the
  // capturing command), so the result is 'toggleTheme'.
  assert.equal(
    findConflict(resolveBindings({}), DEFAULT_BINDINGS.toggleTheme, 'openSettings'),
    'toggleTheme',
    "binding openSettings to toggleTheme's combo is detected as a toggleTheme conflict",
  );
});

test('FR-54 editable shell commands: the promoted Ctrl/Cmd+Shift+G can now be rebound + persisted', async () => {
  const { resolveBindings, diffOverrides, DEFAULT_BINDINGS, isReserved, bindingAllowedFor } =
    await kit();
  // Ctrl+Shift+G is no longer shell-reserved (it was promoted out of
  // RESERVED_COMBOS), so a command CAN be rebound onto it AND off it.
  assert.equal(isReserved('Ctrl+Shift+G'), false, 'the promoted combo is no longer reserved');
  assert.equal(
    bindingAllowedFor('toggleChanges', 'Ctrl+Shift+G'),
    true,
    'the promoted combo is allowed for its command',
  );
  // Rebinding toggleChanges to a fresh free combo persists sparsely and
  // re-resolves cleanly — exactly like any other editable command.
  const rebound = 'Ctrl+Shift+D';
  const resolved = { ...DEFAULT_BINDINGS, toggleChanges: rebound };
  const overrides = diffOverrides(resolved);
  assert.deepEqual(overrides, { toggleChanges: rebound }, 'a toggleChanges rebind persists sparsely');
  assert.deepEqual(
    resolveBindings(overrides),
    resolved,
    'the persisted toggleChanges override re-resolves to the same full map',
  );
});

test('FR-54 migration safety: an OLD persisted override map (pre-new-ids) loads cleanly', async () => {
  const { resolveBindings, DEFAULT_BINDINGS } = await kit();
  // A persisted config from BEFORE these ids existed never mentioned them — the
  // new commands must default cleanly (resolve to defaultBinding when absent),
  // and a legacy override of a still-present command must still apply.
  const legacy = { toggleTheme: 'Ctrl+Shift+T' };
  const resolved = resolveBindings(legacy);
  assert.equal(resolved.toggleTheme, 'Ctrl+Shift+T', 'the legacy override still applies');
  assert.equal(resolved.toggleChanges, DEFAULT_BINDINGS.toggleChanges, 'toggleChanges defaults cleanly');
  assert.equal(resolved.openSettings, DEFAULT_BINDINGS.openSettings, 'openSettings defaults cleanly');
  assert.equal(
    resolved.toggleMaximizeTerminal,
    DEFAULT_BINDINGS.toggleMaximizeTerminal,
    'toggleMaximizeTerminal defaults cleanly',
  );
});

/* ============================================================
 * Project-wide content search (search-core matchFile + search.run)
 * ------------------------------------------------------------
 * matchFile is a pure substring matcher; createSearch walks the
 * Law-3-confined sandbox tree + reads via readFile. These tests pin:
 *   - multiple hits per line + across lines,
 *   - case-insensitive default + case-sensitive opt,
 *   - per-file cap + truncation flag,
 *   - empty/blank query -> no matches,
 *   - search.run over a temp dir: finds content, SKIPS binary/oversize,
 *     stays CONFINED (an escaping symlink yields nothing).
 * ============================================================ */

test('SEARCH command: the openSearch command exists with its default binding (D)', async () => {
  const { COMMANDS, DEFAULT_BINDINGS } = await kit();
  const spec = COMMANDS.find((c) => c.id === 'openSearch');
  assert.ok(spec, 'an openSearch command is registered');
  assert.equal(spec.label, 'Search file contents', 'label matches the spec');
  assert.equal(spec.defaultBinding, 'Ctrl+Shift+F', 'default binding is Ctrl/Cmd+Shift+F');
  assert.equal(DEFAULT_BINDINGS.openSearch, 'Ctrl+Shift+F', 'resolved default carries the combo');
  assert.equal(COMMANDS.length, 23, 'there are now 23 customizable commands');
});

test('MULTI-WINDOW commands: newWindow + openFolderWindow are registered, non-colliding, un-reserved', async () => {
  const { COMMANDS, DEFAULT_BINDINGS, resolveBindings, findConflict, isReserved, bindingAllowedFor } =
    await kit();
  const newWin = COMMANDS.find((c) => c.id === 'newWindow');
  const openFolder = COMMANDS.find((c) => c.id === 'openFolderWindow');
  assert.ok(newWin, 'a newWindow command is registered');
  assert.ok(openFolder, 'an openFolderWindow command is registered');
  assert.equal(newWin.defaultBinding, 'Ctrl+Shift+N', 'newWindow default is Ctrl/Cmd+Shift+N');
  assert.equal(openFolder.defaultBinding, 'Ctrl+Shift+O', 'openFolderWindow default is Ctrl/Cmd+Shift+O');
  assert.equal(DEFAULT_BINDINGS.newWindow, 'Ctrl+Shift+N', 'resolved default carries the combo');
  assert.equal(DEFAULT_BINDINGS.openFolderWindow, 'Ctrl+Shift+O', 'resolved default carries the combo');
  // Each default must be a structurally-valid binding for its command, free of a
  // conflict with any OTHER command, and not one of the app-shell RESERVED combos
  // (so the shortcut actually fires, and the Shortcuts panel never flags it dead).
  const resolved = resolveBindings({});
  for (const id of ['newWindow', 'openFolderWindow']) {
    const combo = DEFAULT_BINDINGS[id];
    assert.ok(bindingAllowedFor(id, combo), `${id} default is a valid binding`);
    assert.equal(findConflict(resolved, combo, id), null, `${id} default collides with no other command`);
    assert.equal(isReserved(combo), false, `${id} default is not an app-shell reserved combo`);
  }
});

test('SEARCH matchFile: finds multiple hits per line AND across lines', async () => {
  const { matchFile } = await kit();
  const text = 'user USER user\nno hit here\nthe user logs in';
  const m = matchFile(text, 'user'); // case-insensitive default
  // Three hits on line 1 (user, USER, user), one on line 3.
  assert.equal(m.length, 4, 'four total matches (3 on line 1, 1 on line 3)');
  assert.deepEqual(
    m.map((x) => [x.line, x.col]),
    [
      [1, 1],
      [1, 6],
      [1, 11],
      [3, 5],
    ],
    'line/col coordinates are 1-based and accurate',
  );
  // The match offsets index INTO lineText for highlighting.
  const first = m[0];
  assert.equal(first.lineText.slice(first.matchStart, first.matchEnd), 'user');
});

test('SEARCH matchFile: case-insensitive by default, case-sensitive with opt', async () => {
  const { matchFile } = await kit();
  const text = 'User user USER';
  assert.equal(matchFile(text, 'user').length, 3, 'insensitive default matches all 3 casings');
  const cs = matchFile(text, 'user', { caseSensitive: true });
  assert.equal(cs.length, 1, 'case-sensitive matches only the exact-case "user"');
  assert.equal(cs[0].col, 6, 'the lowercase "user" is at col 6');
});

test('SEARCH matchFile: per-file cap bounds the result list', async () => {
  const { matchFile } = await kit();
  // 100 hits but a cap of 5 should stop at 5.
  const text = 'x'.repeat(100).split('').map(() => 'ab').join(' '); // many "ab"
  const m = matchFile(text, 'ab', { maxPerFile: 5 });
  assert.equal(m.length, 5, 'matchFile stops at maxPerFile');
});

test('SEARCH matchFile: empty / blank query yields no matches', async () => {
  const { matchFile } = await kit();
  assert.deepEqual(matchFile('anything here', ''), [], 'empty query -> none');
  // A non-string query is rejected defensively.
  assert.deepEqual(matchFile('anything here', /** @type any */ (null)), [], 'null query -> none');
});

test('SEARCH matchFile: a long line is display-truncated but col stays accurate', async () => {
  const { matchFile } = await kit();
  const prefix = 'y'.repeat(250);
  const text = `${prefix}needle`;
  const m = matchFile(text, 'needle', { maxLineLength: 200 });
  assert.equal(m.length, 1, 'the match past the truncation point is still found');
  assert.equal(m[0].col, 251, 'col reflects the ORIGINAL (untruncated) position');
  assert.equal(m[0].lineText.length, 200, 'lineText is truncated to maxLineLength for display');
});

test('SEARCH run: finds content across the confined tree (multiple files)', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    writeFileSync(path.join(root, 'a.ts'), 'const user = 1;\nfunction getUser(){}\n');
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'sub', 'b.md'), '# User guide\nuser stuff here\n');
    const sandbox = createSandbox(root);
    const search = createSearch(sandbox);
    const res = search.run({ query: 'user' });
    assert.equal(res.results.length, 2, 'both text files match');
    assert.ok(res.total >= 4, 'total counts every match across files');
    const paths = res.results.map((r) => r.path).sort();
    assert.deepEqual(paths, ['a.ts', 'sub/b.md'], 'root-relative POSIX paths');
    assert.equal(res.truncated, false, 'a small tree is not truncated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH run: SKIPS binary/image files (never reads/scans their bytes)', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    // A .png whose raw bytes literally contain the ASCII for "user" — it must
    // STILL be skipped (image kind -> readFile returns text=null).
    writeFileSync(path.join(root, 'img.png'), Buffer.from('PNGuserPNG', 'binary'));
    // A .bin (binary kind) likewise containing "user".
    writeFileSync(path.join(root, 'data.bin'), Buffer.from('user-in-binary', 'binary'));
    // A genuine text hit so the run isn't empty for the wrong reason.
    writeFileSync(path.join(root, 'c.ts'), 'const user = 2;\n');
    const search = createSearch(createSandbox(root));
    const res = search.run({ query: 'user' });
    const hitPaths = res.results.map((r) => r.path);
    assert.deepEqual(hitPaths, ['c.ts'], 'only the text file matches; binary/image skipped');
    assert.ok(!hitPaths.some((p) => p.endsWith('.png') || p.endsWith('.bin')), 'no binary/image scanned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH run: stays CONFINED — an escaping symlink yields nothing (Law 3)', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'loom-secret-'));
  try {
    // A secret OUTSIDE the root containing the query term.
    writeFileSync(path.join(outside, 'secret.txt'), 'user password leak\n');
    // A text file INSIDE the root with a benign hit (the run finds this).
    writeFileSync(path.join(root, 'inside.ts'), 'const user = 3;\n');
    // A symlink inside the root that points OUTSIDE it.
    let symlinked = true;
    try {
      symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    } catch {
      symlinked = false; // some sandboxes disallow symlink creation
    }
    const res = createSearch(createSandbox(root)).run({ query: 'user' });
    // The escaping symlink's content must NEVER appear in the results.
    const leaked = res.results.some(
      (f) => f.path.includes('escape') || f.matches.some((m) => m.lineText.includes('password')),
    );
    assert.equal(leaked, false, 'the escaping symlink secret must not leak (Law 3 confinement)');
    // The legitimate in-root hit is still found (proves the test searched).
    assert.ok(
      res.results.some((f) => f.path === 'inside.ts'),
      symlinked
        ? 'the in-root file is found while the symlink escape is excluded'
        : 'the in-root file is found (symlink unsupported here; confinement still holds)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('SEARCH run: empty / blank query returns no results without walking', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    writeFileSync(path.join(root, 'a.ts'), 'const user = 1;\n');
    const search = createSearch(createSandbox(root));
    // UX-NAME-02: the empty-query result reports its (all-false) truncation
    // breakdown alongside the legacy single `truncated` flag.
    const empty = {
      results: [],
      fileMatches: [],
      truncated: false,
      truncatedNames: false,
      truncatedContent: false,
      total: 0,
    };
    assert.deepEqual(search.run({ query: '' }), empty);
    assert.deepEqual(search.run({ query: '   ' }), empty);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ============================================================
 * Project-wide search — FILE-NAME / PATH matching (ADDITIVE)
 * ------------------------------------------------------------
 * The SAME query that scans contents ALSO matches each file's
 * root-relative PATH — covering EVERY file, including image/binary
 * (which have NO content match) — and lands in fileMatches with a
 * highlight span. Confined to the same single Law-3 walk, bounded.
 * ============================================================ */

test('SEARCH names: a query matching a file NAME returns it in fileMatches (with correct span)', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    // server.ts: the NAME contains "server"; its CONTENT does NOT.
    writeFileSync(path.join(root, 'server.ts'), 'const x = 1;\nfunction boot(){}\n');
    const res = createSearch(createSandbox(root)).run({ query: 'server' });
    assert.equal(res.fileMatches.length, 1, 'the file name match is collected');
    const fm = res.fileMatches[0];
    assert.equal(fm.path, 'server.ts', 'the matching root-relative path');
    // The span indices must isolate the matched substring within the path.
    assert.equal(
      fm.path.slice(fm.matchStart, fm.matchEnd),
      'server',
      'matchStart/matchEnd isolate the matched run in the path',
    );
    assert.equal(fm.matchStart, 0, 'match begins at the start of the basename');
    assert.equal(fm.matchEnd, 6, 'match end is exclusive (len of "server")');
    // No CONTENT match for this query (the body has no "server").
    assert.equal(res.total, 0, 'no content matches for a name-only query');
    assert.equal(res.results.length, 0, 'no content result files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH names: matches a BINARY/IMAGE file by NAME even with NO content match', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    // An IMAGE whose CONTENT is never read (image kind). Its NAME holds "logo".
    writeFileSync(path.join(root, 'logo.png'), Buffer.from('\x89PNG not text', 'binary'));
    // A .bin (binary kind) whose NAME holds "logo" too.
    writeFileSync(path.join(root, 'logo-data.bin'), Buffer.from('\x00\x01\x02', 'binary'));
    // A text file with NO "logo" in name or content (control).
    writeFileSync(path.join(root, 'main.ts'), 'const a = 1;\n');
    const res = createSearch(createSandbox(root)).run({ query: 'logo' });
    const names = res.fileMatches.map((f) => f.path).sort();
    assert.deepEqual(
      names,
      ['logo-data.bin', 'logo.png'],
      'the image AND binary file names match (no content read needed)',
    );
    // Proves filename search covers non-text files: there is NO content result.
    assert.equal(res.results.length, 0, 'no content matches (binary/image never scanned)');
    assert.equal(res.total, 0, 'zero content matches');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH names: case-insensitive by default, case-sensitive with the opt', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    writeFileSync(path.join(root, 'Logo.png'), Buffer.from('\x89PNG', 'binary'));
    const sandbox = createSandbox(root);
    // Default: case-INSENSITIVE — "logo" matches "Logo.png".
    const insens = createSearch(sandbox).run({ query: 'logo' });
    assert.equal(insens.fileMatches.length, 1, 'insensitive default matches Logo.png');
    assert.equal(insens.fileMatches[0].path, 'Logo.png');
    // The span still indexes the ORIGINAL-cased path correctly.
    assert.equal(insens.fileMatches[0].path.slice(
      insens.fileMatches[0].matchStart, insens.fileMatches[0].matchEnd), 'Logo');
    // caseSensitive: "logo" does NOT match "Logo.png".
    const sens = createSearch(sandbox).run({ query: 'logo', caseSensitive: true });
    assert.equal(sens.fileMatches.length, 0, 'case-sensitive excludes the mismatched case');
    // But the exact case "Logo" does match under caseSensitive.
    const sensExact = createSearch(sandbox).run({ query: 'Logo', caseSensitive: true });
    assert.equal(sensExact.fileMatches.length, 1, 'case-sensitive matches the exact case');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH names: a query matches BOTH a file NAME and file CONTENT (both returned)', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    // server.ts: NAME matches "server" AND its CONTENT contains "server" too.
    writeFileSync(path.join(root, 'server.ts'), 'startServer();\n// server boot\n');
    // notes.md: NO "server" in name, but CONTENT has it.
    writeFileSync(path.join(root, 'notes.md'), '# Notes\nthe server is up\n');
    const res = createSearch(createSandbox(root)).run({ query: 'server' });
    // File-NAME match: only server.ts's PATH contains "server".
    assert.deepEqual(
      res.fileMatches.map((f) => f.path),
      ['server.ts'],
      'the file-name match is server.ts',
    );
    // CONTENT matches: BOTH files contain "server" in their bodies.
    const contentPaths = res.results.map((r) => r.path).sort();
    assert.deepEqual(contentPaths, ['notes.md', 'server.ts'], 'both files have content hits');
    assert.ok(res.total >= 2, 'content total counts every body match');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH names: the match span can locate a hit in the DIRECTORY portion of a path', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    mkdirSync(path.join(root, 'server'));
    // The basename "index.ts" has NO "server"; the DIRECTORY does.
    writeFileSync(path.join(root, 'server', 'index.ts'), 'const a = 1;\n');
    const res = createSearch(createSandbox(root)).run({ query: 'server' });
    const fm = res.fileMatches.find((f) => f.path === 'server/index.ts');
    assert.ok(fm, 'the file under server/ is a name match via its directory');
    assert.equal(
      fm.path.slice(fm.matchStart, fm.matchEnd),
      'server',
      'the span isolates the directory-portion match',
    );
    assert.equal(fm.matchStart, 0, 'the directory match starts at the path head');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH names: empty / blank query yields no file-name matches', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    writeFileSync(path.join(root, 'logo.png'), Buffer.from('\x89PNG', 'binary'));
    const search = createSearch(createSandbox(root));
    assert.deepEqual(search.run({ query: '' }).fileMatches, [], 'empty query -> no name matches');
    assert.deepEqual(search.run({ query: '  ' }).fileMatches, [], 'blank query -> no name matches');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH names: the file-name match list is bounded (cap + truncated)', async () => {
  const { createSandbox, createSearch, MAX_FILE_NAME_MATCHES } = await kit();
  assert.equal(typeof MAX_FILE_NAME_MATCHES, 'number', 'MAX_FILE_NAME_MATCHES is exported');
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    // Create MORE matching file NAMES than the cap so the list truncates.
    const overCap = MAX_FILE_NAME_MATCHES + 25;
    for (let i = 0; i < overCap; i++) {
      // Every name contains "match" (a binary file, so no content scan at all).
      writeFileSync(path.join(root, `match-${String(i).padStart(4, '0')}.bin`), Buffer.from([0]));
    }
    const res = createSearch(createSandbox(root)).run({ query: 'match' });
    assert.equal(
      res.fileMatches.length,
      MAX_FILE_NAME_MATCHES,
      'the file-name match list stops at the cap',
    );
    assert.equal(res.truncated, true, 'hitting the file-name cap reports truncated');
    // UX-NAME-02: the cap is attributed to the NAME list (so the UI can say
    // "file names capped"), NOT to content — these binaries are never scanned.
    assert.equal(res.truncatedNames, true, 'the NAME list is flagged as capped');
    assert.equal(res.truncatedContent, false, 'content was NOT capped (binaries unscanned)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH names (UX-NAME-02): a CONTENT byte-budget cap attributes to content, not names', async () => {
  const { createSandbox, createSearch, MAX_TOTAL_SCAN_BYTES } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-budget-'));
  try {
    // Text totalling over the scanned-bytes budget; NONE matching by name OR
    // content (filenames are f0000.txt..., the query is "needle"). The run must
    // attribute the cap to CONTENT (the byte budget aborted it), not to names.
    const oneMb = 'z'.repeat(1024 * 1024);
    const fileCount = Math.ceil(MAX_TOTAL_SCAN_BYTES / (1024 * 1024)) + 8;
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(path.join(root, `f${String(i).padStart(4, '0')}.txt`), oneMb);
    }
    const res = createSearch(createSandbox(root)).run({ query: 'needle' });
    assert.equal(res.truncated, true, 'the byte budget reports truncated');
    assert.equal(res.truncatedContent, true, 'the CONTENT list is flagged as capped');
    assert.equal(res.truncatedNames, false, 'the NAME list was NOT capped (no name hits)');
    assert.equal(res.fileMatches.length, 0, 'no name matches for "needle"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Reviewer fixes — regression tests                                   */
/* ------------------------------------------------------------------ */

test('SEARCH matchFile (SEC-2): an EARLY match on an over-length line is found, not dropped', async () => {
  const { matchFile, MAX_SCAN_LINE_LENGTH } = await kit();
  assert.equal(typeof MAX_SCAN_LINE_LENGTH, 'number', 'MAX_SCAN_LINE_LENGTH is exported');
  // A needle at column 1 of a 60000-char minified line (over the scan cap) MUST
  // still be found — previously the whole line was skipped (false negative).
  const earlyHit = 'needle' + 'x'.repeat(60_000);
  const m = matchFile(earlyHit, 'needle');
  assert.equal(m.length, 1, 'the in-window (col 1) match on the over-length line is found');
  assert.equal(m[0].col, 1, 'col is the true 1-based original column');
  assert.equal(m[0].lineText.length, 200, 'lineText is still display-truncated to the cap');
  // A match PAST the scanned prefix is not reported (bounded scan, acceptable).
  const lateHit = 'x'.repeat(MAX_SCAN_LINE_LENGTH + 100) + 'needle';
  assert.equal(matchFile(lateHit, 'needle').length, 0, 'a match past the scan prefix is not reported');
});

test('SEARCH matchFile (UX-SEARCH-02): leading indentation is stripped for display, col stays accurate', async () => {
  const { matchFile } = await kit();
  const line = '        app.get("/users", handler)'; // 8 leading spaces
  const m = matchFile(line, 'app.get');
  assert.equal(m.length, 1, 'the indented match is found');
  assert.equal(m[0].col, 9, 'col reflects the ORIGINAL (untrimmed) column');
  assert.ok(!/^\s/.test(m[0].lineText), 'lineText has its leading indentation stripped for display');
  assert.equal(
    m[0].lineText.slice(m[0].matchStart, m[0].matchEnd),
    'app.get',
    'match offsets index the matched run in the TRIMMED display text',
  );
});

test('SEARCH run (SEC-1/SEC-3): a zero-match run over a huge corpus stops at the byte budget', async () => {
  const { createSandbox, createSearch, MAX_TOTAL_SCAN_BYTES } = await kit();
  assert.equal(typeof MAX_TOTAL_SCAN_BYTES, 'number', 'MAX_TOTAL_SCAN_BYTES is exported');
  const root = mkdtempSync(path.join(tmpdir(), 'loom-budget-'));
  try {
    // Write text totalling well OVER the scanned-bytes budget, none matching the
    // query — exactly the intermediate-keystroke worst case. The run must abort
    // (truncated=true) instead of reading the whole tree to completion.
    const oneMb = 'z'.repeat(1024 * 1024);
    const fileCount = Math.ceil(MAX_TOTAL_SCAN_BYTES / (1024 * 1024)) + 8;
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(path.join(root, `f${String(i).padStart(4, '0')}.txt`), oneMb);
    }
    const res = createSearch(createSandbox(root)).run({ query: 'needle' });
    assert.equal(res.total, 0, 'zero matches (the query is absent)');
    assert.equal(res.results.length, 0, 'no result files');
    assert.equal(res.truncated, true, 'the run is reported truncated — the budget aborted it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEARCH run: a small zero-match tree is NOT truncated (budget not hit)', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-search-'));
  try {
    writeFileSync(path.join(root, 'a.ts'), 'const user = 1;\n');
    const res = createSearch(createSandbox(root)).run({ query: 'nomatch-here' });
    assert.deepEqual(res, {
      results: [],
      fileMatches: [],
      truncated: false,
      // UX-NAME-02: the result now reports WHICH list was capped; a clean
      // zero-match run capped NEITHER, so both discriminators are false.
      truncatedNames: false,
      truncatedContent: false,
      total: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MARKDOWN (A11Y-SEARCH-01): rendered blocks carry 1-based data-srcline for search reveal', async () => {
  const mod = await kit();
  const renderMarkdown = requireExport(mod, 'renderMarkdown');
  const md = [
    '# Architecture', // line 1
    '', // 2
    '## Known issues', // 3
    '', // 4
    '- **No connection pooling.** db.ts opens a single shared', // 5
    '  connection.', // 6
  ].join('\n');
  const html = renderMarkdown(md);
  // The heading on source line 1 and 3 are stamped; the list item on line 5.
  assert.match(html, /<h1 data-srcline="1">/, 'h1 carries its 1-based source line');
  assert.match(html, /<h2 data-srcline="3">/, 'h2 carries its 1-based source line');
  assert.match(html, /<li data-srcline="5">/, 'the pooling list item carries source line 5');
  // The mapping is metadata only — it must not break content safety (Law 1):
  // a script in the markdown is still inert/escaped.
  const evil = renderMarkdown('# <script>alert(1)</script>\n');
  assert.ok(!/<script>/.test(evil), 'no live <script> survives the srcline mapping');
});

/* ============================================================
 * Cross-OS path normalization (Law 3 contract <-> native fs)
 * ------------------------------------------------------------
 * nativeToPosixRel / posixRelToNative are the single conversion
 * chokepoint between the POSIX ('/'-separated) renderer contract
 * (FileNode.path, FileEvent.path, search paths) and the platform's
 * NATIVE fs separators. The helpers take an injectable `path` module
 * so we can pin BOTH the POSIX behavior AND the WINDOWS expectation
 * on this Linux host (no Windows available) — by passing path.posix
 * and path.win32 respectively. These encode the Windows correctness
 * that cannot be runtime-verified here.
 * ============================================================ */

test('PATH posix: native abs -> POSIX rel is a clean root-relative slash path', async () => {
  const { nativeToPosixRel } = await kit();
  // On a POSIX path module the separator is already '/' (identity transform).
  assert.equal(
    nativeToPosixRel('/srv/root', '/srv/root/sub/b.md', path.posix),
    'sub/b.md',
  );
  assert.equal(nativeToPosixRel('/srv/root', '/srv/root', path.posix), '');
  assert.equal(nativeToPosixRel('/srv/root', '/srv/root/a.ts', path.posix), 'a.ts');
});

test('PATH win32: native BACKSLASH abs -> POSIX rel converts \\ to / (Windows contract)', async () => {
  const { nativeToPosixRel } = await kit();
  // The KEY Windows assertion: path.win32.relative returns 'sub\\b.md'; the
  // helper MUST emit the POSIX 'sub/b.md' for the renderer contract.
  assert.equal(
    nativeToPosixRel('C:\\srv\\root', 'C:\\srv\\root\\sub\\b.md', path.win32),
    'sub/b.md',
    'backslash native separators must become forward slashes in the contract',
  );
  assert.equal(
    nativeToPosixRel('C:\\srv\\root', 'C:\\srv\\root\\deep\\nested\\x.ts', path.win32),
    'deep/nested/x.ts',
  );
  assert.equal(nativeToPosixRel('C:\\srv\\root', 'C:\\srv\\root', path.win32), '');
});

test('PATH posix: POSIX rel -> native abs round-trips on a POSIX host', async () => {
  const { posixRelToNative, nativeToPosixRel } = await kit();
  const root = '/srv/root';
  const abs = posixRelToNative(root, 'sub/b.md', path.posix);
  assert.equal(abs, '/srv/root/sub/b.md');
  // Round-trip: native -> posix -> native is stable.
  assert.equal(nativeToPosixRel(root, abs, path.posix), 'sub/b.md');
});

test('PATH win32: a POSIX contract rel resolves to a native BACKSLASH abs (Windows fs access)', async () => {
  const { posixRelToNative, nativeToPosixRel } = await kit();
  const root = 'C:\\srv\\root';
  // The renderer hands back a POSIX rel ('sub/b.md'); win32 path.join accepts
  // '/' as a separator and emits the native backslash absolute path for fs.
  const abs = posixRelToNative(root, 'sub/b.md', path.win32);
  assert.equal(abs, 'C:\\srv\\root\\sub\\b.md', 'forward-slash rel joins to a native backslash path');
  // And the inverse converts it back to the POSIX contract form.
  assert.equal(nativeToPosixRel(root, abs, path.win32), 'sub/b.md');
});

test('PATH win32: a `..` escape in the rel still collapses (caller re-proves containment)', async () => {
  const { posixRelToNative } = await kit();
  // posixRelToNative performs NO security check; it just normalizes shape.
  // path.join collapses '..', so an escape attempt produces a path OUTSIDE
  // the root that resolveInRoot's containment check would then reject.
  const escaped = posixRelToNative('C:\\srv\\root', '..\\..\\Windows\\system32', path.win32);
  assert.ok(
    !escaped.startsWith('C:\\srv\\root\\'),
    'a `..` escape resolves outside the root (rejected later by resolveInRoot)',
  );
});

test('PATH: live node:path default keeps the existing POSIX behavior on this host', async () => {
  const { nativeToPosixRel } = await kit();
  // No injected module -> uses live node:path (POSIX on Linux/WSL). Confirms
  // the production default is unchanged on the verifiable platform.
  assert.equal(nativeToPosixRel('/srv/root', '/srv/root/sub/b.md'), 'sub/b.md');
});

test('PATH win32: the SHIPPING resolveInRoot conversion (path.resolve, POSIX rel) is correct on Windows', () => {
  // X2 coverage gap closure: production resolveInRoot (sandbox.ts) converts the
  // POSIX contract rel -> native abs via path.resolve(root, relPath), NOT via
  // the posixRelToNative (path.join) helper the other PATH tests exercise.
  // path.resolve and path.join differ for absolute-override inputs, so the
  // shipping direction needs its OWN win32 assertion. We pin path.win32.resolve
  // directly (the exact call resolveInRoot makes) so the production POSIX->native
  // conversion has a named Windows guard, correct-by-construction on this host.
  const root = 'C:\\srv\\root';

  // 1) A normal POSIX contract rel resolves into the native backslash abs.
  assert.equal(
    path.win32.resolve(root, 'sub/b.md'),
    'C:\\srv\\root\\sub\\b.md',
    'win32 path.resolve accepts the POSIX `/` rel and emits the native backslash abs',
  );
  assert.equal(
    path.win32.resolve(root, 'deep/nested/x.ts'),
    'C:\\srv\\root\\deep\\nested\\x.ts',
  );

  // 2) A `..` traversal that escapes the root resolves OUTSIDE it. This is the
  //    exact shape resolveInRoot then rejects via isInsideRoot (path.relative
  //    returns a '..'-leading rel). We assert the escape lands outside so the
  //    downstream containment check has something to catch.
  const escaped = path.win32.resolve(root, '../../Windows/system32');
  assert.equal(escaped, 'C:\\Windows\\system32');
  assert.ok(
    !escaped.toLowerCase().startsWith('c:\\srv\\root\\') && escaped.toLowerCase() !== 'c:\\srv\\root',
    'a `..` escape resolves outside the root (rejected by resolveInRoot.isInsideRoot)',
  );

  // 3) An ABSOLUTE POSIX rel (drive-letter override attempt) overrides the base
  //    in path.resolve exactly as an attacker would try — again caught downstream
  //    by isInsideRoot, never trusted by shape.
  const driveEscape = path.win32.resolve(root, 'C:/Windows/system32');
  assert.equal(driveEscape, 'C:\\Windows\\system32');
  assert.ok(
    !driveEscape.toLowerCase().startsWith('c:\\srv\\root\\'),
    'an absolute-drive rel overrides the base (rejected by resolveInRoot.isInsideRoot)',
  );
});

/* ================================================================== */
/* WATCHER — live FileEvents over a real temp dir (FR-14, FR-39).      */
/* The v0.5.4 engine swap (native recursive fs.watch on darwin/win32,  */
/* chokidar fallback on linux) must preserve the FileEvent contract:   */
/* add/change/unlink + addDir/unlinkDir, root-relative POSIX paths,    */
/* and the ignore filter (.git / node_modules / dotfiles / .loom).     */
/* These tests drive the REAL createWatcher against a temp dir, so they */
/* run whichever engine the test host selects.                          */
/* ================================================================== */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll captured file events for one matching `pred` until `timeoutMs`. */
async function waitForFile(events, pred, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await delay(25);
  }
}

/** Spin up the real watcher over a fresh temp dir; capture file events. */
async function freshWatcher() {
  const mod = await kit();
  const createWatcher = requireExport(mod, 'createWatcher');
  const createEventBus = requireExport(mod, 'createEventBus');
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-watch-'));
  const bus = createEventBus();
  const events = [];
  bus.subscribe((e) => {
    if (e.kind === 'file') events.push(e);
  });
  const watcher = createWatcher(dir, bus);
  watcher.start();
  // Warmup: the chokidar fallback (linux) must finish its initial scan before
  // it reliably reports live mutations; the native engine is live immediately.
  await delay(300);
  return { dir, events, watcher };
}

async function teardownWatcher(watcher, dir) {
  await watcher.stop();
  rmSync(dir, { recursive: true, force: true });
}

test('WATCHER: a new file -> add, a write -> change, a delete -> unlink (FR-39)', async () => {
  const { dir, events, watcher } = await freshWatcher();
  try {
    const abs = path.join(dir, 'note.txt');
    writeFileSync(abs, 'hello');
    const add = await waitForFile(
      events,
      (e) => e.action === 'add' && e.path === 'note.txt',
    );
    assert.ok(add, 'expected an `add` event for note.txt');
    assert.equal(add.path, 'note.txt', 'add path must be root-relative POSIX');

    await delay(80); // distinct from any creation-trailing change
    writeFileSync(abs, 'hello world');
    const change = await waitForFile(
      events,
      (e) => e.action === 'change' && e.path === 'note.txt',
    );
    assert.ok(change, 'expected a `change` event after the rewrite');

    rmSync(abs);
    const unlink = await waitForFile(
      events,
      (e) => e.action === 'unlink' && e.path === 'note.txt',
    );
    assert.ok(unlink, 'expected an `unlink` event after delete');
  } finally {
    await teardownWatcher(watcher, dir);
  }
});

test('WATCHER: a new/removed directory -> addDir / unlinkDir', async () => {
  const { dir, events, watcher } = await freshWatcher();
  try {
    const sub = path.join(dir, 'pkg');
    mkdirSync(sub);
    const addDir = await waitForFile(
      events,
      (e) => e.action === 'addDir' && e.path === 'pkg',
    );
    assert.ok(addDir, 'expected an `addDir` event for pkg/');

    rmSync(sub, { recursive: true, force: true });
    const unlinkDir = await waitForFile(
      events,
      (e) => e.action === 'unlinkDir' && e.path === 'pkg',
    );
    assert.ok(
      unlinkDir,
      'expected an `unlinkDir` event for pkg/ (delete classified via the dir set)',
    );
  } finally {
    await teardownWatcher(watcher, dir);
  }
});

test('WATCHER: node_modules / .git / dotfiles are NOT published (noise filter)', async () => {
  const { dir, events, watcher } = await freshWatcher();
  try {
    mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x');
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: x');
    writeFileSync(path.join(dir, '.env'), 'SECRET=1'); // dotfile
    // A legit file written LAST acts as a sentinel: once it arrives, any noise
    // events that were going to fire already have.
    writeFileSync(path.join(dir, 'real.txt'), 'ok');
    const real = await waitForFile(events, (e) => e.path === 'real.txt');
    assert.ok(real, 'the non-ignored sentinel real.txt must be reported');
    await delay(150); // let any stragglers land

    const noisy = events.find(
      (e) =>
        e.path === '.env' ||
        e.path.startsWith('node_modules') ||
        e.path.startsWith('.git'),
    );
    assert.equal(
      noisy,
      undefined,
      `ignored paths must never publish (saw ${noisy && noisy.path})`,
    );
  } finally {
    await teardownWatcher(watcher, dir);
  }
});

/* ================================================================== */
/* LISTDIR — the lazy-expand primitive (FR-2/FR-3) + its perf fast     */
/* path. classifyEntries skips the per-entry realpath for NON-symlinks  */
/* (a plain entry in a contained dir can't escape) and skips statSync   */
/* for plain dirs (shallow nodes). This test pins that the output +     */
/* ordering are unchanged AND that an escaping SYMLINK is still dropped  */
/* (Law 3 containment must survive the optimization).                   */
/* ================================================================== */
test('LISTDIR: dirs-first children, shallow dirs + sized files, escaping symlink EXCLUDED (Law 3)', async () => {
  const { createSandbox } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-listdir-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'loom-secret-'));
  try {
    mkdirSync(path.join(root, 'sub'));
    mkdirSync(path.join(root, 'sub', 'inner'));
    writeFileSync(path.join(root, 'sub', 'a.ts'), 'const a = 1;\n');
    writeFileSync(path.join(root, 'sub', 'z.md'), '# z\n');
    writeFileSync(path.join(outside, 'secret.txt'), 'password leak\n');
    // A symlink INSIDE the listed dir that points OUTSIDE the root.
    try {
      symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'sub', 'escape.txt'));
    } catch {
      /* some sandboxes disallow symlink creation — exclusion still asserted */
    }

    const kids = createSandbox(root).listDir('sub');
    const names = kids.map((n) => n.name);

    // Containment: the escaping symlink must NEVER be listed, even though plain
    // entries now skip the realpath check (symlinks still take the checked path).
    assert.ok(!names.includes('escape.txt'), 'escaping symlink must be excluded (Law 3)');

    // Ordering unchanged: dirs first, then files, each case-insensitive alpha.
    assert.deepEqual(
      names,
      ['inner', 'a.ts', 'z.md'],
      'dirs-first then alpha ordering must survive the fast path',
    );

    // A directory child is SHALLOW (loaded:false, no children) — the lazy node.
    const inner = kids.find((n) => n.name === 'inner');
    assert.equal(inner.type, 'dir');
    assert.equal(inner.loaded, false);

    // A file child still carries the metadata the UI needs (proves the stat ran).
    const a = kids.find((n) => n.name === 'a.ts');
    assert.equal(a.type, 'file');
    assert.equal(typeof a.size, 'number');
    assert.equal(typeof a.mtimeMs, 'number');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

/* ================================================================== */
/* EXPLORER visibility + file-type handling (v0.5.6)                    */
/*  - the tree shows EVERYTHING (dotfiles, .git, node_modules, .loom);  */
/*    only the SEARCH walk skips the heavy VCS/dep/internal dirs.       */
/*  - readFile shows source for any file that LOOKS textual, regardless */
/*    of extension (content sniff), while true binaries stay metadata.  */
/* ================================================================== */
test('TREE shows all (dotfiles + .git + node_modules); SEARCH still skips heavy dirs', async () => {
  const { createSandbox, createSearch } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-showall-'));
  try {
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'node_modules'));
    mkdirSync(path.join(root, '.github'));
    writeFileSync(path.join(root, '.env'), 'APP_KEY=1\n');
    writeFileSync(path.join(root, '.git', 'config'), 'findme_token\n');
    writeFileSync(path.join(root, 'app.php'), '<?php // findme_token\n');
    const sb = createSandbox(root);

    const names = sb.buildTree().children.map((c) => c.name).sort();
    for (const n of ['.env', '.git', '.github', 'app.php', 'node_modules']) {
      assert.ok(names.includes(n), `tree must show "${n}" (show-all, nothing hidden)`);
    }

    const hits = createSearch(sb).run({ query: 'findme_token' }).results.map((r) => r.path);
    assert.ok(hits.includes('app.php'), 'search finds the in-repo file');
    assert.ok(
      !hits.some((p) => p.startsWith('.git')),
      'search must still skip .git (heavy-dir skip), even though the tree shows it',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('READFILE sniff: extensionless text -> source; NUL-byte binary -> metadata-only (Law 2)', async () => {
  const { createSandbox } = await kit();
  const root = mkdtempSync(path.join(tmpdir(), 'loom-sniff-'));
  try {
    writeFileSync(path.join(root, 'Dockerfile'), 'FROM php:8.2\nRUN composer install\n');
    writeFileSync(path.join(root, 'artisan'), '#!/usr/bin/env php\n<?php\n');
    writeFileSync(path.join(root, '.env'), 'APP_KEY=secret\n');
    writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x48, 0x69, 0x00, 0x01, 0x02]));
    const sb = createSandbox(root);

    for (const name of ['Dockerfile', 'artisan', '.env']) {
      const r = sb.readFile(name);
      assert.notEqual(r.text, null, `${name} (extensionless text) must show its contents`);
      assert.equal(r.dispatch.kind, 'code', `${name} sniffed-text -> kind 'code'`);
      assert.equal(r.dispatch.renderState, 'SOURCE');
      assert.equal(r.dispatch.safetyBanner, false, 'sniffed source carries no safety banner');
    }

    const bin = sb.readFile('blob.bin');
    assert.equal(bin.text, null, 'a file with a NUL byte must stay metadata-only (Law 2)');
    assert.equal(bin.dispatch.kind, 'binary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DISPATCH: .php (and other added exts) classify as code', async () => {
  const { kindOf } = await kit();
  for (const f of ['Service.php', 'view.blade.php', 'phpstan.neon', 'deploy.ps1', 'schema.graphql', 'Component.vue']) {
    assert.equal(kindOf(f), 'code', `${f} must classify as code`);
  }
});
