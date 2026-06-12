/* ============================================================
 * Loom — roster agent-removal suite (node --test)
 * ------------------------------------------------------------
 * Proves the human roster-curation affordance WITHOUT Electron:
 *
 *   store level (db.removeAgent / db.removeAgents):
 *     - the agents row is DELETED (plus its memberships + receipts,
 *       the FK children keyed by agent name);
 *     - CHAT HISTORY IS PRESERVED: messages the removed agent
 *       authored (or was the direct target of) remain;
 *     - PRAGMA foreign_keys is restored ON after the delete AND
 *       survives an ordinary flushNow (the sql.js export() reopen
 *       used to silently reset it — the flushNow re-apply is pinned
 *       here independently of deleteAgentRows);
 *     - a removed name re-registers FRESH (no -2 suffix, no blocklist).
 *
 *   main-process helper level (removeAgentByName / clearStaleAgents
 *   from engine.ts — the pure fns the IPC handlers call):
 *     - input re-validation (non-string / blank / oversized /
 *       unknown -> false, fail-soft, no throw);
 *     - a 'gone' AgentEvent is published so the renderer's existing
 *       reduceAgent drops the chip live (requirement 4), plus one
 *       'channel' event per affected channel so member lists stay
 *       in sync with MCP list_channels;
 *     - NO IDENTITY CAPTURE: session identity is bound to the
 *       registered row's connection_id, so after a force-remove the
 *       OLD session keeps failing NOT_REGISTERED even when a NEW
 *       agent re-registers the same bare name — and the new agent's
 *       own traffic is unaffected;
 *     - STALE sweep (kaizen field report): nothing ever flips a dead
 *       agent to 'gone' — sessions die with their process and the
 *       reaper only closes transports — so the visible dead chips
 *       are status='active' rows and a gone-only sweep cleared
 *       INVISIBLE rows. clearStaleAgents removes status='gone' rows
 *       ∪ status='active' rows whose connection_id is NOT bound to
 *       any live MCP session; a LIVE connected agent must NEVER be
 *       swept (the per-chip × is the only way to remove a live one).
 *
 *   MCP level (createMcpServer.liveConnectionIds):
 *     - the live-session connection_id set the sweep consults is
 *       empty before any registration, carries a registered
 *       session's row connection_id, and drops it on reap.
 *
 *   component level (Roster SSR, ChangeKindGlyph precedent —
 *   hook-free presenter via renderToStaticMarkup, jsdom for the
 *   focus-target seam):
 *     - every chip carries a separate remove (×) <button> that does
 *       NOT nest inside the open-inbox button (keyboard operable,
 *       aria-labelled force-remove cue, FR-46/FR-54/NFR-12);
 *     - the clear-stale button shows the authoritative stale COUNT
 *       and is disabled at zero;
 *     - removing a chip never strands keyboard focus on a detached
 *       node: the exported focus-target helpers pick the next chip /
 *       previous chip / clear-stale / roster container (the App.tsx
 *       close-file idiom).
 *
 *   renderer store level (createStore over a stubbed window.loom):
 *     - optimistic chip drop + inbox-lens close on removeAgent;
 *     - clearStaleAgents optimistically zeroes counters.staleAgents
 *       (it does NOT guess which chips are stale — the authoritative
 *       'gone' AgentEvents from main drop them).
 *
 * DEPENDENCY: dist/testkit.cjs must re-export
 *   { createDb, createEngine, createEventBus, createMcpServer,
 *     MCP_HOST, MCP_PATH, removeAgentByName, clearStaleAgents,
 *     Roster, nextFocusAfterChipRemoval, focusTargetAfterClearStale,
 *     createStore, LoomError }.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

/** Assert a named export exists on the kit and is a function. */
function requireExport(mod, name) {
  assert.equal(
    typeof mod[name],
    'function',
    `dist/testkit.cjs must re-export \`${name}\` (got ${typeof mod[name]}).`,
  );
  return mod[name];
}

/** Fresh sql.js db over a throwaway temp dir. */
async function freshDb(mod) {
  const createDb = requireExport(mod, 'createDb');
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-agent-rm-'));
  const db = createDb();
  await db.init(dir);
  return { db, dir };
}

function cleanup(db, dir) {
  try { db.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * Store level — db.removeAgent / db.removeAgents                      *
 * ------------------------------------------------------------------ */

test('RM-01 db.removeAgent deletes the row + memberships + receipts, PRESERVES messages, restores FK pragma', async () => {
  const mod = await kit();
  const { db, dir } = await freshDb(mod);
  try {
    assert.equal(typeof db.removeAgent, 'function', 'LoomDb must expose removeAgent(name)');
    const t = Date.now();
    db.insertAgent({ name: 'alpha', connection_id: 'c1', status: 'active', registered_at: t });
    db.insertAgent({ name: 'beta', connection_id: 'c2', status: 'active', registered_at: t });
    const ch = db.insertChannel('dev', t);
    db.insertMembership({ channel_id: ch.id, agent_name: 'alpha', joined_at: t });
    db.insertMembership({ channel_id: ch.id, agent_name: 'beta', joined_at: t });
    // alpha -> @here (receipt for beta); beta -> direct alpha (receipt for alpha).
    const m1 = db.insertMessage({ channel_id: ch.id, sender: 'alpha', body: 'hello', addressing: 'here', target: null, created_at: t });
    db.insertReceipt({ message_id: m1.id, recipient: 'beta', read_at: null });
    const m2 = db.insertMessage({ channel_id: ch.id, sender: 'beta', body: 'hi alpha', addressing: 'direct', target: 'alpha', created_at: t });
    db.insertReceipt({ message_id: m2.id, recipient: 'alpha', read_at: null });

    assert.equal(db.removeAgent('alpha'), true, 'removing an existing agent returns true');

    // Row gone; the other agent untouched.
    assert.equal(db.getAgent('alpha'), undefined);
    assert.ok(db.getAgent('beta'));

    // CHAT HISTORY PRESERVED: both messages still listed, sender intact.
    const messages = db.listMessages();
    assert.deepEqual(messages.map((m) => m.sender).sort(), ['alpha', 'beta']);
    assert.equal(messages.find((m) => m.id === m2.id).target, 'alpha', 'direct target column preserved');

    // The removed agent's FK children are gone; others remain.
    assert.deepEqual(db.listReceipts(m2.id), [], "removed agent's receipts are deleted");
    assert.equal(db.listReceipts(m1.id).length, 1, "other agents' receipts survive");
    assert.deepEqual(db.listMemberships(ch.id).map((m) => m.agent_name), ['beta']);

    // FK enforcement restored after the scoped toggle.
    const pragma = db.exec('PRAGMA foreign_keys;');
    assert.equal(pragma[0]?.values?.[0]?.[0], 1, 'PRAGMA foreign_keys must be back ON');

    // Idempotent fail-soft: a second removal of the same name is false.
    assert.equal(db.removeAgent('alpha'), false);
  } finally {
    cleanup(db, dir);
  }
});

test('RM-02 a removed name re-registers FRESH (no suffix, no blocklist)', async () => {
  const mod = await kit();
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');
  const { db, dir } = await freshDb(mod);
  try {
    const engine = createEngine(db, createEventBus());
    const c1 = { name: null };
    assert.equal(engine.register(c1, { name: 'alpha' }).name, 'alpha');
    assert.equal(db.removeAgent('alpha'), true);
    // Fresh registration claims the SAME bare name — not alpha-2.
    const c2 = { name: null };
    assert.equal(engine.register(c2, { name: 'alpha' }).name, 'alpha');
    assert.equal(db.getAgent('alpha').status, 'active');
  } finally {
    cleanup(db, dir);
  }
});

test('RM-03 db.removeAgents removes the GIVEN existing rows in one sweep; history survives', async () => {
  const mod = await kit();
  const { db, dir } = await freshDb(mod);
  try {
    assert.equal(typeof db.removeAgents, 'function', 'LoomDb must expose removeAgents(names)');
    const t = Date.now();
    db.insertAgent({ name: 'live', connection_id: 'c1', status: 'active', registered_at: t });
    db.insertAgent({ name: 'g1', connection_id: 'c2', status: 'gone', registered_at: t });
    db.insertAgent({ name: 'g2', connection_id: 'c3', status: 'gone', registered_at: t });
    const ch = db.insertChannel('dev', t);
    db.insertMembership({ channel_id: ch.id, agent_name: 'g1', joined_at: t });
    db.insertMessage({ channel_id: ch.id, sender: 'g1', body: 'bye', addressing: 'here', target: null, created_at: t });

    // Unknown names are skipped fail-soft; existing ones removed in one call.
    const removed = db.removeAgents(['g1', 'g2', 'ghost']);
    assert.deepEqual([...removed].sort(), ['g1', 'g2']);
    assert.deepEqual(db.listAgents().map((a) => a.name), ['live']);
    assert.equal(db.listMessages().length, 1, "removed agents' messages are preserved");
    assert.deepEqual(db.listMemberships(ch.id), []);
    // Empty/no-match input is a no-op.
    assert.deepEqual(db.removeAgents([]), []);
    assert.deepEqual(db.removeAgents(['ghost']), []);
  } finally {
    cleanup(db, dir);
  }
});

test('RM-09 PRAGMA foreign_keys SURVIVES an ordinary flushNow (sql.js export() reopen reset)', async () => {
  const mod = await kit();
  const { db, dir } = await freshDb(mod);
  try {
    const t = Date.now();
    db.insertAgent({ name: 'a', connection_id: 'c', status: 'active', registered_at: t });
    // The ordinary mutation->flush path (no deleteAgentRows involved).
    db.flushNow();
    const pragma = db.exec('PRAGMA foreign_keys;');
    assert.equal(pragma[0]?.values?.[0]?.[0], 1, 'foreign_keys must still be ON after flushNow');
    // And the constraint actually REJECTS: a membership referencing a missing
    // channel/agent must fail (AC-16 enforcement, not just the pragma echo).
    assert.throws(
      () => db.insertMembership({ channel_id: 999, agent_name: 'ghost', joined_at: t }),
      /FOREIGN KEY|constraint/i,
    );
  } finally {
    cleanup(db, dir);
  }
});

/* ------------------------------------------------------------------ *
 * Main-process helpers — the fns the IPC handlers call                *
 * ------------------------------------------------------------------ */

test('RM-04 removeAgentByName: validates input, publishes gone + channel events, and the OLD session can NEVER act as a re-registered same-name agent', async () => {
  const mod = await kit();
  const removeAgentByName = requireExport(mod, 'removeAgentByName');
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');
  const { LoomError } = mod;
  const { db, dir } = await freshDb(mod);
  try {
    const bus = createEventBus();
    const engine = createEngine(db, bus);
    const oldSession = { name: null };
    const bobSession = { name: null };
    engine.register(oldSession, { name: 'alpha' });
    engine.register(bobSession, { name: 'bob' });
    engine.create_channel(bobSession, { name: 'dev' });
    engine.join_channel(oldSession, { channel: 'dev' });

    const events = [];
    bus.subscribe((e) => events.push(e));

    // Re-validation (never trust the renderer): non-string / blank /
    // oversized / unknown are all fail-soft false — no throw, no event.
    assert.equal(removeAgentByName(db, bus, 123), false);
    assert.equal(removeAgentByName(db, bus, '   '), false);
    assert.equal(removeAgentByName(db, bus, 'x'.repeat(65)), false, 'an over-MAX_NAME_LENGTH name is rejected');
    assert.equal(removeAgentByName(db, bus, 'ghost'), false);
    assert.equal(events.length, 0);

    // Force-remove the still-ACTIVE agent.
    assert.equal(removeAgentByName(db, bus, 'alpha'), true);
    assert.equal(db.getAgent('alpha'), undefined);

    // The renderer's reduceAgent already drops a 'gone' agent from the roster —
    // the helper reuses that exact event shape (live update, requirement 4).
    const agentEvents = events.filter((e) => e.kind === 'agent');
    assert.equal(agentEvents.length, 1);
    assert.equal(agentEvents[0].agent.name, 'alpha');
    assert.equal(agentEvents[0].agent.status, 'gone');

    // Membership cleanup is broadcast too, so ChannelTabs member lists stay in
    // sync with MCP list_channels (no relaunch needed).
    const channelEvents = events.filter((e) => e.kind === 'channel');
    assert.equal(channelEvents.length, 1);
    assert.equal(channelEvents[0].channel.name, 'dev');
    assert.deepEqual(channelEvents[0].members, ['bob']);

    // The old session's identity is stale — its next call fails NOT_REGISTERED
    // (purge_all precedent; the idle reaper remains the transport backstop).
    assert.throws(
      () => engine.check_inbox(oldSession),
      (err) => err instanceof LoomError && err.code === 'NOT_REGISTERED',
    );

    // IDENTITY CAPTURE GUARD: a NEW agent re-registers the freed bare name.
    // The OLD session must STILL fail — it must never read the new agent's
    // inbox or send as it (session identity is bound to the row's
    // connection_id at register() time, and the recreated row carries a
    // different connection_id).
    const newSession = { name: null };
    assert.equal(engine.register(newSession, { name: 'alpha' }).name, 'alpha');
    engine.join_channel(newSession, { channel: 'dev' });
    engine.send_message(bobSession, { channel: 'dev', to: 'alpha', body: 'for the NEW alpha only' });

    // New agent's traffic is unaffected…
    const inbox = engine.check_inbox(newSession);
    assert.equal(inbox.unread, 1);
    // …while the old session still cannot act at all (read OR write).
    assert.throws(
      () => engine.check_inbox(oldSession),
      (err) => err instanceof LoomError && err.code === 'NOT_REGISTERED',
      'old session must not read the new same-name agent inbox',
    );
    assert.throws(
      () => engine.send_message(oldSession, { channel: 'dev', to: 'bob', body: 'impostor' }),
      (err) => err instanceof LoomError && err.code === 'NOT_REGISTERED',
      'old session must not send as the new same-name agent',
    );
  } finally {
    cleanup(db, dir);
  }
});

test('RM-05 clearStaleAgents helper: sweeps gone + dead-session actives, NEVER a live-bound active; publishes gone + channel events', async () => {
  const mod = await kit();
  const clearStaleAgents = requireExport(mod, 'clearStaleAgents');
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');
  const { db, dir } = await freshDb(mod);
  try {
    const bus = createEventBus();
    const engine = createEngine(db, bus);
    const keeperSession = { name: null };
    const droneSession = { name: null };
    const zombieSession = { name: null };
    engine.register(keeperSession, { name: 'keeper' });
    engine.register(droneSession, { name: 'drone' });
    engine.register(zombieSession, { name: 'zombie' });
    engine.create_channel(keeperSession, { name: 'dev' });
    engine.join_channel(droneSession, { channel: 'dev' });
    engine.join_channel(zombieSession, { channel: 'dev' });
    engine.deregister(droneSession, { name: 'drone' }); // -> 'gone' (still a member, FR-19)
    // zombie: stays status='active' but its session DIES (kaizen field case —
    // nothing flips it to gone). Only keeper's session is live at sweep time.
    const liveIds = new Set([keeperSession.connectionId]);

    const events = [];
    bus.subscribe((e) => events.push(e));

    // Sweeps BOTH the gone row and the dead-bound active; keeper survives.
    assert.equal(clearStaleAgents(db, bus, liveIds), 2);
    assert.deepEqual(db.listAgents().map((x) => x.name), ['keeper']);
    assert.equal(db.getAgent('keeper').status, 'active', 'a LIVE connected agent is NEVER swept');

    const agentEvents = events.filter((e) => e.kind === 'agent');
    assert.deepEqual(agentEvents.map((e) => e.agent.name).sort(), ['drone', 'zombie']);
    // Both surface as 'gone' so the renderer's reduceAgent drops the visible
    // zombie chip live (the user's "still seeing the agents" complaint).
    assert.ok(agentEvents.every((e) => e.agent.status === 'gone'));

    // The swept agents' membership removal is broadcast per channel.
    const channelEvents = events.filter((e) => e.kind === 'channel');
    assert.equal(channelEvents.length, 1);
    assert.equal(channelEvents[0].channel.name, 'dev');
    assert.deepEqual(channelEvents[0].members, ['keeper']);

    // keeper's live session keeps working after the sweep.
    assert.equal(engine.check_inbox(keeperSession).unread, 0);

    // Nothing stale -> 0, no further events.
    assert.equal(clearStaleAgents(db, bus, liveIds), 0);
    assert.equal(events.filter((e) => e.kind === 'agent').length, 2);

    // Post-restart shape: with NO live sessions (empty set), every remaining
    // active row is by definition stale and sweepable.
    const restartSession = { name: null };
    engine.register(restartSession, { name: 'orphan' });
    assert.equal(clearStaleAgents(db, bus, new Set()), 2, 'keeper + orphan are stale once no session is live');
    assert.deepEqual(db.listAgents(), []);
  } finally {
    cleanup(db, dir);
  }
});

test('RM-13 MCP liveConnectionIds: empty before register, carries the registered row id, drops on reap', async () => {
  const mod = await kit();
  const createMcpServer = requireExport(mod, 'createMcpServer');
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');
  const { db, dir } = await freshDb(mod);
  const engine = createEngine(db, createEventBus());
  const server = createMcpServer(engine, { startPort: 0 }); // ephemeral port
  await server.start();
  const url = `http://${mod.MCP_HOST}:${server.port}${mod.MCP_PATH}`;
  const client = new Client({ name: 'rm13', version: '1.0.0' }, { capabilities: {} });
  try {
    assert.equal(typeof server.liveConnectionIds, 'function', 'handle must expose liveConnectionIds()');
    assert.equal(server.liveConnectionIds().size, 0, 'no live ids before any session');

    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    // Connected but UNREGISTERED: session exists, but it has no bound id yet —
    // an unregistered session must not shield any row from the sweep.
    assert.equal(server.liveConnectionIds().size, 0, 'unregistered session contributes no id');

    await client.callTool({ name: 'register', arguments: { name: 'alpha' } });
    const live = server.liveConnectionIds();
    const row = db.getAgent('alpha');
    assert.equal(live.size, 1);
    assert.ok(live.has(row.connection_id), "the live set carries the registered row's connection_id");

    // Reap the session (deterministically, as the reaper suite does): the id
    // leaves the live set, so the still-'active' row becomes sweepable.
    await server.reapIdleSessions(Date.now() + 60_000);
    assert.equal(server.liveConnectionIds().size, 0, 'reaped session no longer shields its row');
    assert.equal(db.getAgent('alpha').status, 'active', 'reap does NOT touch the db row (the stale-active case)');
  } finally {
    try { await client.close(); } catch { /* ignore */ }
    try { await server.stop(); } catch { /* ignore */ }
    cleanup(db, dir);
  }
});

test('RM-12 no identity capture via DOUBLE-register: a second-name registration mints a fresh, non-reusable connection_id', async () => {
  // Reviewer PoC: under the legacy ternary, a session that registered a SECOND
  // name minted connection_id = its PREVIOUS name — a deterministic, reusable
  // string. Session A registers 'omega' then 'worker' (worker row conn_id
  // 'omega'); the human removes both; session B re-registers 'omega' then
  // 'worker' → B's worker row minted 'omega' AGAIN → old session A's stale
  // binding matched the successor row and A acted AS B's worker.
  const mod = await kit();
  const removeAgentByName = requireExport(mod, 'removeAgentByName');
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');
  const { LoomError } = mod;
  const { db, dir } = await freshDb(mod);
  try {
    const bus = createEventBus();
    const engine = createEngine(db, bus);

    // Session A: register 'omega', then a SECOND name 'worker'.
    const sessionA = { name: null };
    engine.register(sessionA, { name: 'omega' });
    engine.register(sessionA, { name: 'worker' });
    assert.equal(sessionA.name, 'worker');

    // Human removes BOTH rows.
    assert.equal(removeAgentByName(db, bus, 'omega'), true);
    assert.equal(removeAgentByName(db, bus, 'worker'), true);

    // Session B re-runs the SAME register sequence.
    const sessionB = { name: null };
    engine.register(sessionB, { name: 'omega' });
    engine.register(sessionB, { name: 'worker' });
    assert.equal(sessionB.name, 'worker');

    // The recreated row's connection_id must NOT be the reusable legacy value
    // ('omega') — every registration mints a fresh per-registration id.
    const workerRow = db.getAgent('worker');
    assert.notEqual(workerRow.connection_id, 'omega', 'connection_id must not be the deterministic legacy value');
    assert.notEqual(workerRow.connection_id, sessionA.connectionId, "successor row must not match the old session's binding");

    // Give B's worker a real inbox item so a capture would be observable.
    const bobSession = { name: null };
    engine.register(bobSession, { name: 'bob' });
    engine.create_channel(bobSession, { name: 'dev' });
    engine.join_channel(sessionB, { channel: 'dev' });
    engine.send_message(bobSession, { channel: 'dev', to: 'worker', body: 'for B-worker only' });

    // Old session A must fail NOT_REGISTERED and must NOT read the
    // successor's inbox…
    assert.throws(
      () => engine.check_inbox(sessionA),
      (err) => err instanceof LoomError && err.code === 'NOT_REGISTERED',
      'old double-registered session must not act as the re-registered worker',
    );
    assert.throws(
      () => engine.read_messages(sessionA, {}),
      (err) => err instanceof LoomError && err.code === 'NOT_REGISTERED',
    );
    // …while session B's traffic is unaffected.
    assert.equal(engine.check_inbox(sessionB).unread, 1);
  } finally {
    cleanup(db, dir);
  }
});

/* ------------------------------------------------------------------ *
 * Component level — Roster chips (SSR, hook-free presenter)           *
 * ------------------------------------------------------------------ */

function renderRoster(mod, agents, { openInbox = null, staleCount = 0 } = {}) {
  const Roster = requireExport(mod, 'Roster');
  return renderToStaticMarkup(
    React.createElement(Roster, {
      agents,
      openInbox,
      staleCount,
      onOpenInbox: () => {},
      onRemoveAgent: () => {},
      onClearStale: () => {},
    }),
  );
}

test('RM-06 Roster: every chip has a separate, non-nested force-remove button with an accessible label', async () => {
  const mod = await kit();
  // Reachable state only: vm.agents never contains 'gone' rows (the boot
  // snapshot filters to active and reduceAgent drops gone), so every chip
  // rendered in production is an active agent.
  const html = renderRoster(mod, [
    { name: 'alpha', status: 'active', unread: 2 },
    { name: 'beta', status: 'active', unread: 0 },
  ]);

  // The open-inbox chip button is still a real keyboard-operable button with
  // aria-pressed (FR-54) and still carries the rchip class App.tsx focuses.
  assert.match(html, /class="rchip[ "]/, 'open-inbox button keeps the rchip class');
  assert.match(html, /aria-pressed="false"/);

  // One remove button per chip, labelled with the agent name (non-color cue),
  // and the label says force-remove — every roster chip is a live agent.
  const alphaLabel = html.match(/aria-label="(Remove alpha[^"]*)"/)?.[1] ?? '';
  const betaLabel = html.match(/aria-label="(Remove beta[^"]*)"/)?.[1] ?? '';
  assert.match(alphaLabel, /force/i, 'removal label carries the force-remove cue');
  assert.match(betaLabel, /force/i);
  assert.match(alphaLabel, /history/i, 'removal label reassures history is kept');

  // NOT nested: no <button> inside another <button> (a11y / event hijack).
  assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>).)*<button/s, 'remove button must not nest inside the chip button');
});

test('RM-07 Roster: clear-stale shows the authoritative count and is disabled at zero', async () => {
  const mod = await kit();
  const agents = [{ name: 'alpha', status: 'active', unread: 0 }];

  const zero = renderRoster(mod, agents, { staleCount: 0 });
  assert.match(zero, /<button[^>]*class="roster-clear-stale"[^>]*disabled/, 'disabled when nothing is stale');
  assert.match(zero, /clear stale \(0\)/, 'count rendered in the label');

  const three = renderRoster(mod, agents, { staleCount: 3 });
  assert.doesNotMatch(three, /<button[^>]*class="roster-clear-stale"[^>]*disabled/, 'enabled when stale agents exist');
  assert.match(three, /clear stale \(3\)/);
  assert.match(three, /aria-label="Clear stale agents[^"]*3[^"]*"/, 'aria-label carries the count');
  // The accessible name must say live agents are safe (the sweep's contract).
  assert.match(three, /aria-label="Clear stale agents[^"]*Live agents are kept[^"]*"/);
});

test('RM-08 Roster focus targets: removal never strands keyboard focus (App.tsx close-file idiom)', async () => {
  const mod = await kit();
  const nextFocusAfterChipRemoval = requireExport(mod, 'nextFocusAfterChipRemoval');
  const focusTargetAfterClearStale = requireExport(mod, 'focusTargetAfterClearStale');

  const mount = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

  // Two chips, gone agents exist: removing the FIRST focuses the next chip;
  // removing the LAST focuses the previous chip.
  const doc2 = mount(renderRoster(mod, [
    { name: 'alpha', status: 'active', unread: 0 },
    { name: 'beta', status: 'active', unread: 0 },
  ], { staleCount: 1 }));
  const xs = [...doc2.querySelectorAll('.rchip-x')];
  assert.equal(xs.length, 2);
  const afterFirst = nextFocusAfterChipRemoval(xs[0]);
  assert.equal(afterFirst?.querySelector('.nm')?.textContent, 'beta', 'removing the first chip targets the NEXT chip');
  assert.ok(afterFirst.classList.contains('rchip'));
  const afterLast = nextFocusAfterChipRemoval(xs[1]);
  assert.equal(afterLast?.querySelector('.nm')?.textContent, 'alpha', 'removing the last chip targets the PREVIOUS chip');

  // Sole chip + clearable gone backlog: falls back to the (enabled)
  // clear-stale button.
  const doc1 = mount(renderRoster(mod, [{ name: 'solo', status: 'active', unread: 0 }], { staleCount: 2 }));
  const soloTarget = nextFocusAfterChipRemoval(doc1.querySelector('.rchip-x'));
  assert.ok(soloTarget.classList.contains('roster-clear-stale'), 'sole-chip removal targets the clear-stale button');

  // Sole chip + DISABLED clear-stale (count 0): falls back to the roster
  // container (focusable via tabindex=-1) — never <body>/a detached node.
  const doc0 = mount(renderRoster(mod, [{ name: 'solo', status: 'active', unread: 0 }], { staleCount: 0 }));
  const containerTarget = nextFocusAfterChipRemoval(doc0.querySelector('.rchip-x'));
  assert.ok(containerTarget.classList.contains('roster'), 'falls back to the roster container');
  assert.equal(containerTarget.getAttribute('tabindex'), '-1', 'container must be focusable');

  // jsdom smoke: the chosen targets actually take focus.
  afterFirst.focus();
  assert.equal(doc2.activeElement, afterFirst);

  // clear-stale: after clearing, the button disables — focus moves to the
  // first chip when one exists, else the roster container.
  const clearTarget = focusTargetAfterClearStale(doc2.querySelector('.roster-clear-stale'));
  assert.ok(clearTarget.classList.contains('rchip'), 'clear-stale hands focus to the first chip');
  const docEmpty = mount(renderRoster(mod, [], { staleCount: 4 }));
  const clearTargetEmpty = focusTargetAfterClearStale(docEmpty.querySelector('.roster-clear-stale'));
  assert.ok(clearTargetEmpty.classList.contains('roster'), 'empty roster: clear-stale hands focus to the container');
});

/* ------------------------------------------------------------------ *
 * Renderer store level — createStore over a stubbed window.loom       *
 * ------------------------------------------------------------------ */

function fakeInitialState(overrides = {}) {
  return {
    rootName: 'proj',
    theme: 'dark',
    liveState: 'CAUGHT_UP',
    tree: { type: 'dir', name: 'proj', path: '', ext: '', children: [], loaded: true },
    agents: [],
    channels: [],
    messages: [],
    counters: { agents: 0, channels: 0, messages: 0, receipts: 0, files: 0, goneAgents: 0 },
    wsEnabled: false,
    keybindings: {},
    ...overrides,
  };
}

/** Boot a real createStore over a stubbed window.loom bridge. */
async function bootStore(mod, initial, bridgeOverrides = {}) {
  const createStore = requireExport(mod, 'createStore');
  const noopSub = () => () => {};
  globalThis.window = {
    loom: {
      getInitialState: async () => initial,
      onEvent: noopSub,
      onCounters: noopSub,
      onLiveState: noopSub,
      onGitStatus: noopSub,
      getGitStatus: async () => ({}),
      setLiveState: async () => {},
      removeAgent: async () => true,
      clearStaleAgents: async () => 0,
      ...bridgeOverrides,
    },
  };
  const store = createStore();
  await store.start();
  return store;
}

test('RM-10 store.removeAgent: optimistic chip drop + inbox-lens close; bridge result surfaced', async (t) => {
  const mod = await kit();
  t.after(() => { delete globalThis.window; });
  const calls = [];
  const store = await bootStore(
    mod,
    fakeInitialState({
      agents: [
        { name: 'alpha', status: 'active', unread: 1 },
        { name: 'beta', status: 'active', unread: 0 },
      ],
    }),
    { removeAgent: async (name) => { calls.push(name); return true; } },
  );

  store.openInbox('alpha');
  const removed = await store.removeAgent('alpha');
  assert.equal(removed, true, 'store surfaces the main-process result');
  assert.deepEqual(calls, ['alpha'], 'bridge invoked with the agent name');
  const vm = store.getViewModel();
  assert.deepEqual(vm.agents.map((a) => a.name), ['beta'], 'chip dropped optimistically');
  assert.equal(vm.inboxAgent, null, 'an inbox lens open on the removed agent closes');

  // A rejected invoke is swallowed fail-soft (false), optimistic state kept.
  globalThis.window.loom.removeAgent = async () => { throw new Error('ipc down'); };
  assert.equal(await store.removeAgent('beta'), false);
  assert.deepEqual(store.getViewModel().agents, []);
});

test('RM-11 store.clearStaleAgents: optimistically zeroes counters.staleAgents, never guesses which chips are stale', async (t) => {
  const mod = await kit();
  t.after(() => { delete globalThis.window; });
  const store = await bootStore(
    mod,
    fakeInitialState({
      agents: [
        { name: 'alpha', status: 'active', unread: 0 },
        { name: 'zombie', status: 'active', unread: 0 },
      ],
      counters: { agents: 2, channels: 0, messages: 0, receipts: 0, files: 0, staleAgents: 3 },
    }),
    { clearStaleAgents: async () => 3 },
  );

  assert.equal(store.getViewModel().counters.staleAgents, 3, 'seeded from the boot snapshot');
  const cleared = await store.clearStaleAgents();
  assert.equal(cleared, 3, 'store surfaces the main-process count');
  const vm = store.getViewModel();
  assert.equal(vm.counters.staleAgents, 0, 'stale count optimistically zeroed (button disables)');
  // The renderer CANNOT know which active chips are stale (the live-session
  // map lives in main) — chips are dropped only by the authoritative 'gone'
  // AgentEvents that follow, never guessed locally.
  assert.deepEqual(vm.agents.map((a) => a.name), ['alpha', 'zombie'], 'no local guess at staleness');
});

test('RM-14 MCP reaper nudges a counters recompute when it evicts a REGISTERED session', async () => {
  // Count-freeze bug class: reapIdleSessions evicts sessions WITHOUT any bus
  // event, so staleAgents froze at its last pushed value (dead chips next to
  // a disabled "clear stale (0)"). The handle must invoke onSessionsReaped
  // when (and only when) >=1 REGISTERED session is evicted, so main can
  // nudge ipc's counters push. An unregistered session changes no agent row
  // and must NOT nudge.
  const mod = await kit();
  const createMcpServer = requireExport(mod, 'createMcpServer');
  const createEngine = requireExport(mod, 'createEngine');
  const createEventBus = requireExport(mod, 'createEventBus');
  const { db, dir } = await freshDb(mod);
  const engine = createEngine(db, createEventBus());
  const nudges = [];
  const server = createMcpServer(engine, {
    startPort: 0,
    onSessionsReaped: (registered) => nudges.push(registered),
  });
  await server.start();
  const url = `http://${mod.MCP_HOST}:${server.port}${mod.MCP_PATH}`;
  const c1 = new Client({ name: 'rm14-anon', version: '1.0.0' }, { capabilities: {} });
  const c2 = new Client({ name: 'rm14-reg', version: '1.0.0' }, { capabilities: {} });
  try {
    // Unregistered session reaped -> NO nudge (no agent row was live-bound).
    await c1.connect(new StreamableHTTPClientTransport(new URL(url)));
    assert.equal(await server.reapIdleSessions(Date.now() + 60_000) >= 1, true);
    assert.deepEqual(nudges, [], 'evicting only unregistered sessions must not nudge');

    // Registered session reaped -> nudge with the registered-evicted count.
    await c2.connect(new StreamableHTTPClientTransport(new URL(url)));
    await c2.callTool({ name: 'register', arguments: { name: 'alpha' } });
    await server.reapIdleSessions(Date.now() + 60_000);
    assert.deepEqual(nudges, [1], 'evicting a registered session must nudge exactly once');
  } finally {
    try { await c1.close(); } catch { /* ignore */ }
    try { await c2.close(); } catch { /* ignore */ }
    try { await server.stop(); } catch { /* ignore */ }
    cleanup(db, dir);
  }
});

test('RM-15 store: a gone AgentEvent closes an inbox lens open on that agent', async (t) => {
  const mod = await kit();
  t.after(() => { delete globalThis.window; });
  let pushEvent = null;
  const store = await bootStore(
    mod,
    fakeInitialState({
      agents: [{ name: 'alpha', status: 'active', unread: 0 }],
    }),
    { onEvent: (h) => { pushEvent = h; return () => {}; } },
  );

  store.openInbox('alpha');
  assert.equal(store.getViewModel().inboxAgent, 'alpha');
  pushEvent({
    kind: 'agent',
    agent: { name: 'alpha', connection_id: 'c', status: 'gone', registered_at: 1 },
  });
  const vm = store.getViewModel();
  assert.deepEqual(vm.agents, [], 'chip dropped');
  assert.equal(vm.inboxAgent, null, 'the removed agent inbox lens closes');
});

test('RM-16 store: gone AgentEvents pass the PAUSE gate (curation responds while frozen); other events stay buffered; no resurrect on resume', async (t) => {
  const mod = await kit();
  t.after(() => { delete globalThis.window; });
  let pushEvent = null;
  const store = await bootStore(
    mod,
    fakeInitialState({
      agents: [
        { name: 'alpha', status: 'active', unread: 0 },
        { name: 'beta', status: 'active', unread: 0 },
      ],
    }),
    { onEvent: (h) => { pushEvent = h; return () => {}; } },
  );

  await store.togglePause(); // -> PAUSED
  assert.equal(store.getViewModel().liveState, 'PAUSED');

  // A 'gone' AgentEvent (how human removal/sweep results arrive) must apply
  // IMMEDIATELY — the human just clicked; the roster cannot stay frozen
  // while the count zeroes and the announcement fires.
  pushEvent({
    kind: 'agent',
    agent: { name: 'alpha', connection_id: 'c1', status: 'gone', registered_at: 1 },
  });
  assert.deepEqual(
    store.getViewModel().agents.map((a) => a.name),
    ['beta'],
    'swept chip drops even while paused',
  );

  // Non-curation events still freeze (the pause gate is intact).
  pushEvent({
    kind: 'message',
    message: { id: 1, channel_id: 1, sender: 'beta', body: 'hi', addressing: 'here', target: null, created_at: 2 },
    recipients: [],
    channel: 'dev',
  });
  assert.equal(store.getViewModel().messages.length, 0, 'messages stay buffered while paused');

  // No resurrect: an agent that registered DURING the pause (buffered
  // 'active' event) and was then removed must NOT reappear on resume.
  pushEvent({
    kind: 'agent',
    agent: { name: 'gamma', connection_id: 'c3', status: 'active', registered_at: 3 },
  });
  pushEvent({
    kind: 'agent',
    agent: { name: 'gamma', connection_id: 'c3', status: 'gone', registered_at: 3 },
  });

  await store.togglePause(); // resume -> replay buffer
  const vm = store.getViewModel();
  assert.equal(vm.messages.length, 1, 'buffered message replays on resume');
  assert.deepEqual(vm.agents.map((a) => a.name), ['beta'], 'removed-while-paused agent does not resurrect');
});
