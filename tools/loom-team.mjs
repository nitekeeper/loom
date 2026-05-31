#!/usr/bin/env node
/* ============================================================
 * loom-team.mjs — the TRUE live multi-agent demo
 * ------------------------------------------------------------
 * Standalone Node ESM script. Opens ONE MCP session per agent
 * (5 independent StreamableHTTP clients) against a RUNNING Loom
 * MCP server at http://127.0.0.1:7077/mcp, then replays the
 * canonical `acme-api` audit session as REAL tool calls. The
 * observer (the Loom desktop window) watches it unfold live.
 *
 * Run it after — or alongside — `npm run loom`:
 *     node tools/loom-team.mjs
 *     LOOM_ROOT=/path/to/acme-api node tools/loom-team.mjs
 *
 * Failure-mode-first: the server may still be booting when this
 * starts, so the initial connect is retried for a few seconds
 * before giving up. LOOM_ROOT tells us where to write
 * docs/architecture.md (so the file watcher fires); it defaults
 * to the bundled fixtures/acme-api.
 *
 * This duplicates the small timeline that src/main/demo.ts runs
 * in-process (demo.ts is TS/bundled, this is standalone ESM). The
 * two MUST stay consistent — see src/main/demo.ts SESSION block.
 * ============================================================ */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const MCP_URL = process.env.LOOM_MCP_URL ?? 'http://127.0.0.1:7077/mcp';
const HERE_TOKEN = '@here';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Where docs/architecture.md gets written so the watcher fires. */
const ROOT = resolve(
  process.env.LOOM_ROOT ?? join(__dirname, '..', 'fixtures', 'acme-api'),
);

/* ------------------------------------------------------------------ */
/* The shared session — MUST match src/main/demo.ts.                   */
/* ------------------------------------------------------------------ */

const AGENTS = ['lead', 'scout', 'scout-2', 'scribe', 'critic'];

const CHANNELS = [
  { name: 'general', members: ['lead', 'scout', 'scout-2', 'scribe', 'critic'] },
  { name: 'research', members: ['lead', 'scout', 'scout-2'] },
  { name: 'docs', members: ['lead', 'scribe', 'critic'] },
];

/** kind:'msg' -> a send_message; kind:'file' -> a real fs write. */
const TIMELINE = [
  { kind: 'msg', ch: 'general', from: 'lead', body: 'Kicking off the `acme-api` audit. scout + scout-2 on #research, scribe + critic on #docs. Post findings to your channel — I\'ll relay across.' },
  { kind: 'msg', ch: 'research', from: 'lead', body: 'Map the request lifecycle. scout: take `server.ts`. scout-2: take `db.ts`.' },
  { kind: 'msg', ch: 'research', from: 'scout', body: 'On it.' },
  { kind: 'msg', ch: 'research', from: 'scout-2', body: 'On it.' },
  { kind: 'msg', ch: 'research', from: 'scout', body: '`server.ts` — Express, 14 routes. Three have no input validation; `GET /users/:id` is the worst offender.' },
  { kind: 'msg', ch: 'research', from: 'lead', to: 'scout', body: 'Flag `/users/:id` explicitly in the writeup.' },
  { kind: 'msg', ch: 'research', from: 'scout-2', body: '`db.ts` opens one shared sqlite connection — no pooling. That\'s the latency spike under load.' },
  { kind: 'msg', ch: 'research', from: 'scout', to: 'lead', body: 'Consolidated findings ready: validation gap + the pooling issue scout-2 found.' },
  { kind: 'msg', ch: 'general', from: 'lead', body: 'Research is landing. scribe — start `architecture.md` from the #research findings. critic — review as it goes.' },
  { kind: 'msg', ch: 'docs', from: 'lead', body: 'scribe, focus on the request lifecycle + the pooling issue scout-2 flagged.' },
  { kind: 'file', action: 'create', path: 'docs/architecture.md', by: 'scribe' },
  { kind: 'msg', ch: 'docs', from: 'scribe', body: 'Draft of `architecture.md` is up — covered the lifecycle and the pooling issue.' },
  { kind: 'msg', ch: 'docs', from: 'critic', to: 'scribe', body: 'Solid draft. The lifecycle is missing the auth middleware step. Add it and ship.' },
  { kind: 'file', action: 'modify', path: 'docs/architecture.md', by: 'scribe' },
  { kind: 'msg', ch: 'docs', from: 'scribe', to: 'critic', body: 'Added the auth step. Thanks for the catch.' },
  { kind: 'msg', ch: 'docs', from: 'critic', body: 'Approved. Good to merge.' },
  { kind: 'msg', ch: 'general', from: 'lead', body: 'Docs approved, research wrapped. Nice work, team — merging `architecture.md`.' },
  { kind: 'msg', ch: 'general', from: 'scribe', body: 'Onward.' },
];

const ARCHITECTURE_MD_DRAFT = `# Architecture

## Request lifecycle

1. \`express.json()\` parses the request body
2. The route handler runs its query through \`db.ts\`
3. A JSON response is returned

## Known issues

- **No connection pooling.** \`db.ts\` opens a single shared
  connection, so under load queries serialize.
- **Missing validation** on \`GET /users/:id\`.
`;

const ARCHITECTURE_MD_FINAL = `# Architecture

## Request lifecycle

1. \`express.json()\` parses the request body
2. Auth middleware resolves the caller
3. The route handler runs its query through \`db.ts\`
4. A JSON response is returned

## Known issues

- **No connection pooling.** \`db.ts\` opens a single shared
  connection, so under load queries serialize.
- **Missing validation** on \`GET /users/:id\`.
`;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse a tool result into the engine's structured JSON payload.
 *  Prefer structuredContent; fall back to parsing the text block. */
function toolPayload(result) {
  if (result && typeof result === 'object' && 'structuredContent' in result) {
    const sc = result.structuredContent;
    if (sc && typeof sc === 'object') return sc;
  }
  const content = result?.content;
  if (Array.isArray(content)) {
    const textPart = content.find((c) => c?.type === 'text' && typeof c.text === 'string');
    if (textPart) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return { text: textPart.text };
      }
    }
  }
  return result;
}

/** A single agent's MCP session: one Client + transport + assigned name. */
class Agent {
  /** @param {string} requestedName */
  constructor(requestedName) {
    this.requestedName = requestedName;
    /** The name the server actually assigned (may be suffixed). */
    this.name = requestedName;
    this.client = new Client(
      { name: `loom-team/${requestedName}`, version: '0.5.0' },
      { capabilities: {} },
    );
    this.transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  async call(name, args = {}) {
    const result = await this.client.callTool({ name, arguments: args });
    if (result?.isError) {
      const detail = JSON.stringify(toolPayload(result));
      throw new Error(`tool ${name} failed for ${this.name}: ${detail}`);
    }
    return toolPayload(result);
  }

  async close() {
    try {
      await this.client.close();
    } catch {
      /* best-effort: the session may already be gone */
    }
  }
}

/** Connect every agent's session, retrying the whole set for a few
 *  seconds in case the MCP server is still coming up (failure-first). */
async function connectAll(agents, { attempts = 30, delayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Connect sequentially so a partial failure is easy to attribute.
      for (const agent of agents) {
        await agent.connect();
      }
      return;
    } catch (err) {
      lastErr = err;
      // Tear down any half-open sessions before retrying so we start clean.
      await Promise.all(agents.map((a) => a.close()));
      // Re-create transports/clients for the next attempt (a closed client
      // cannot be reconnected).
      for (const agent of agents) {
        agent.client = new Client(
          { name: `loom-team/${agent.requestedName}`, version: '0.5.0' },
          { capabilities: {} },
        );
        agent.transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
      }
      if (attempt < attempts) {
        process.stderr.write(
          `[loom-team] connect attempt ${attempt}/${attempts} failed (${err?.message ?? err}); retrying in ${delayMs}ms…\n`,
        );
        await sleep(delayMs);
      }
    }
  }
  throw new Error(
    `[loom-team] could not connect to MCP server at ${MCP_URL} after ${attempts} attempts: ${lastErr?.message ?? lastErr}`,
  );
}

async function writeArchitecture(action) {
  await mkdir(join(ROOT, 'docs'), { recursive: true });
  const body = action === 'create' ? ARCHITECTURE_MD_DRAFT : ARCHITECTURE_MD_FINAL;
  await writeFile(join(ROOT, 'docs', 'architecture.md'), body, 'utf8');
  process.stderr.write(`[loom-team] wrote docs/architecture.md (${action})\n`);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  process.stderr.write(`[loom-team] target MCP ${MCP_URL}\n[loom-team] root ${ROOT}\n`);

  const agents = AGENTS.map((name) => new Agent(name));
  /** name -> Agent, by ASSIGNED name (so directed sends resolve). */
  const byName = new Map();

  await connectAll(agents);
  process.stderr.write('[loom-team] all sessions connected\n');

  try {
    // 1. Register each agent; capture the server-assigned name.
    for (const agent of agents) {
      const res = await agent.call('register', { name: agent.requestedName });
      if (res && typeof res.name === 'string') agent.name = res.name;
      byName.set(agent.name, agent);
      process.stderr.write(`[loom-team] registered ${agent.name}\n`);
      await sleep(40);
    }

    // Resolve an agent by its requested (script) name. On a fresh server
    // the assigned name equals the requested name; if the server suffixed
    // a collision, fall back to positional order.
    const agentFor = (requested) => {
      const direct = agents.find((a) => a.requestedName === requested);
      return direct ?? byName.get(requested);
    };

    // 2. lead creates each channel (auto-joins); the rest join.
    for (const { name, members } of CHANNELS) {
      await agentFor('lead').call('create_channel', { name });
      for (const member of members) {
        if (member === 'lead') continue;
        await agentFor(member).call('join_channel', { channel: name });
      }
      process.stderr.write(`[loom-team] channel #${name} ready (${members.join(', ')})\n`);
      await sleep(40);
    }

    // 2b. Exercise list_channels over the real transport (read-only).
    const channelList = await agentFor('lead').call('list_channels', {});
    process.stderr.write(
      `[loom-team] list_channels -> ${
        Array.isArray(channelList) ? channelList.map((c) => c.name).join(', ') : '?'
      }\n`,
    );

    // 2c. Exercise deregister over the real transport WITHOUT disturbing the
    // 5-agent roster: spin up a throwaway probe session, register it, then
    // deregister it (sets its status='gone'); the demo agents are untouched.
    {
      const probe = new Agent('probe');
      await probe.connect();
      const reg = await probe.call('register', { name: 'probe' });
      const probeName = reg && typeof reg.name === 'string' ? reg.name : 'probe';
      await probe.call('deregister', { name: probeName });
      process.stderr.write(`[loom-team] deregister probe (${probeName}) ok\n`);
      await probe.close();
    }

    // 3. Replay the timeline.
    let turnConventionDone = false;
    for (const step of TIMELINE) {
      if (step.kind === 'file') {
        await writeArchitecture(step.action);
        await sleep(180);
        continue;
      }

      const sender = agentFor(step.from);
      const to = step.to ? agentFor(step.to).name : HERE_TOKEN;
      await sender.call('send_message', { channel: step.ch, to, body: step.body });
      process.stderr.write(
        `[loom-team] ${step.from} -> ${step.to ?? '@here'} #${step.ch}\n`,
      );

      // Turn convention, once: lead (and critic) check_inbox -> read -> mark_read
      // so their receipts flip delivered -> seen on the observer's screen.
      if (!turnConventionDone && step.from === 'scout' && step.to === 'lead') {
        await runTurn(agentFor('lead'));
        await runTurn(agentFor('critic'));
        turnConventionDone = true;
      }

      await sleep(90);
    }

    process.stderr.write('[loom-team] session complete (sub-agents left active for the screenshot)\n');
  } finally {
    // Close all transport sessions cleanly. Sub-agents are intentionally
    // NOT deregistered — the contract lets us leave them active so the
    // roster stays populated for the screenshot. Closing the transport
    // does not change agents.status.
    await Promise.all(agents.map((a) => a.close()));
  }
}

/** check_inbox -> read_messages -> mark_read for one agent. */
async function runTurn(agent) {
  await agent.call('check_inbox', {});
  const unread = await agent.call('read_messages', {});
  const ids = Array.isArray(unread)
    ? unread.map((m) => m?.message_id).filter((id) => typeof id === 'number')
    : [];
  if (ids.length > 0) {
    await agent.call('mark_read', { message_ids: ids });
    process.stderr.write(`[loom-team] ${agent.name} marked ${ids.length} read\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[loom-team] FATAL: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
