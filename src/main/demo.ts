/* ============================================================
 * Loom — in-process session seeder (demo / --replay)
 * ------------------------------------------------------------
 * Replays the canonical multi-agent session DIRECTLY against the
 * in-process LoomEngine (no MCP, no network). main.ts calls this
 * under `--replay` to populate the DB for offscreen screenshots,
 * and it writes docs/architecture.md into the sandbox root so the
 * chokidar watcher fires its NEW badge + file-flash.
 *
 * This module is Electron-free: it needs only the engine surface
 * (LoomEngine from shared/types) + node fs/path. It is bundled into
 * dist/main.cjs via main.ts's import graph.
 *
 * The session it runs is the SAME shared timeline used by the live
 * demo (tools/loom-team.mjs). The standalone .mjs duplicates the
 * small timeline array because it is not part of the TS bundle; the
 * two MUST stay consistent. See SESSION (below) for the source of
 * truth replicated there.
 * ============================================================ */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Caller, LoomEngine } from '../shared/types.js';
import { HERE_TOKEN } from '../shared/types.js';

/* ------------------------------------------------------------------ */
/* The shared session — agents, channels, and the scripted timeline.   */
/* Mirrors documents/design/app/data.jsx (AGENTS / CHANNELS / TIMELINE) */
/* exactly. Kept in sync with tools/loom-team.mjs.                      */
/* ------------------------------------------------------------------ */

/** Agent registration order. lead first (it creates the channels). */
export const AGENTS = ['lead', 'scout', 'scout-2', 'scribe', 'critic'] as const;

/** Channels + their member rosters (excluding the auto-joined creator
 *  where the creator is the first listed member). The creator (always
 *  `lead`) is auto-joined by create_channel; the remaining members join. */
export const CHANNELS: ReadonlyArray<{ name: string; members: readonly string[] }> = [
  { name: 'general', members: ['lead', 'scout', 'scout-2', 'scribe', 'critic'] },
  { name: 'research', members: ['lead', 'scout', 'scout-2'] },
  { name: 'docs', members: ['lead', 'scribe', 'critic'] },
];

/** One scripted step. `kind:'msg'` = a tool send; `kind:'file'` = a
 *  filesystem write that drives the watcher (architecture.md). */
export type SessionStep =
  | {
      kind: 'msg';
      ch: string;
      from: string;
      /** Recipient name for a direct message; omitted for a broadcast. */
      to?: string;
      body: string;
    }
  | { kind: 'file'; action: 'create' | 'modify'; path: string; by: string };

/** The scripted timeline, in order, mirroring data.jsx TIMELINE.
 *  Messages with no `to` are @here broadcasts; `to` is a direct DM. */
export const TIMELINE: readonly SessionStep[] = [
  {
    kind: 'msg',
    ch: 'general',
    from: 'lead',
    body: 'Kicking off the `acme-api` audit. scout + scout-2 on #research, scribe + critic on #docs. Post findings to your channel — I\'ll relay across.',
  },
  {
    kind: 'msg',
    ch: 'research',
    from: 'lead',
    body: 'Map the request lifecycle. scout: take `server.ts`. scout-2: take `db.ts`.',
  },
  { kind: 'msg', ch: 'research', from: 'scout', body: 'On it.' },
  { kind: 'msg', ch: 'research', from: 'scout-2', body: 'On it.' },
  {
    kind: 'msg',
    ch: 'research',
    from: 'scout',
    body: '`server.ts` — Express, 14 routes. Three have no input validation; `GET /users/:id` is the worst offender.',
  },
  {
    kind: 'msg',
    ch: 'research',
    from: 'lead',
    to: 'scout',
    body: 'Flag `/users/:id` explicitly in the writeup.',
  },
  {
    kind: 'msg',
    ch: 'research',
    from: 'scout-2',
    body: '`db.ts` opens one shared sqlite connection — no pooling. That\'s the latency spike under load.',
  },
  {
    kind: 'msg',
    ch: 'research',
    from: 'scout',
    to: 'lead',
    body: 'Consolidated findings ready: validation gap + the pooling issue scout-2 found.',
  },
  {
    kind: 'msg',
    ch: 'general',
    from: 'lead',
    body: 'Research is landing. scribe — start `architecture.md` from the #research findings. critic — review as it goes.',
  },
  {
    kind: 'msg',
    ch: 'docs',
    from: 'lead',
    body: 'scribe, focus on the request lifecycle + the pooling issue scout-2 flagged.',
  },
  { kind: 'file', action: 'create', path: 'docs/architecture.md', by: 'scribe' },
  {
    kind: 'msg',
    ch: 'docs',
    from: 'scribe',
    body: 'Draft of `architecture.md` is up — covered the lifecycle and the pooling issue.',
  },
  {
    kind: 'msg',
    ch: 'docs',
    from: 'critic',
    to: 'scribe',
    body: 'Solid draft. The lifecycle is missing the auth middleware step. Add it and ship.',
  },
  { kind: 'file', action: 'modify', path: 'docs/architecture.md', by: 'scribe' },
  {
    kind: 'msg',
    ch: 'docs',
    from: 'scribe',
    to: 'critic',
    body: 'Added the auth step. Thanks for the catch.',
  },
  { kind: 'msg', ch: 'docs', from: 'critic', body: 'Approved. Good to merge.' },
  {
    kind: 'msg',
    ch: 'general',
    from: 'lead',
    body: 'Docs approved, research wrapped. Nice work, team — merging `architecture.md`.',
  },
  { kind: 'msg', ch: 'general', from: 'scribe', body: 'Onward.' },
];

/* ------------------------------------------------------------------ */
/* architecture.md — the file scribe writes live.                      */
/*   create  -> the draft WITHOUT the auth middleware step             */
/*   modify  -> the final version WITH the auth step (critic's catch), */
/*              matching data.jsx FILES['docs/architecture.md'].        */
/* ------------------------------------------------------------------ */

/** Draft written at the `create` tick — no auth step yet. */
export const ARCHITECTURE_MD_DRAFT = `# Architecture

## Request lifecycle

1. \`express.json()\` parses the request body
2. The route handler runs its query through \`db.ts\`
3. A JSON response is returned

## Known issues

- **No connection pooling.** \`db.ts\` opens a single shared
  connection, so under load queries serialize.
- **Missing validation** on \`GET /users/:id\`.
`;

/** Final version written at the `modify` tick — auth step added. */
export const ARCHITECTURE_MD_FINAL = `# Architecture

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

const caller = (name: string): Caller => ({ name });

/** A small async pause so the live feed animates rather than snapping. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Write architecture.md (create or modify) into the sandbox root so the
 *  watcher emits an 'add' (NEW badge + flash) then a 'change'. */
async function writeArchitecture(root: string, action: 'create' | 'modify'): Promise<void> {
  const docsDir = join(root, 'docs');
  await mkdir(docsDir, { recursive: true });
  const body = action === 'create' ? ARCHITECTURE_MD_DRAFT : ARCHITECTURE_MD_FINAL;
  await writeFile(join(root, 'docs', 'architecture.md'), body, 'utf8');
}

/* ------------------------------------------------------------------ */
/* seed() — the in-process replay used by main.ts --replay             */
/* ------------------------------------------------------------------ */

/**
 * Replay the canonical session directly against the engine and write
 * architecture.md into `root`. No network, no Electron. Used to populate
 * a fresh DB for offscreen screenshot capture.
 *
 * @param engine  the in-process LoomEngine (over the real db + bus).
 * @param root    sandbox root where docs/architecture.md is written.
 */
export async function seed(engine: LoomEngine, root: string): Promise<void> {
  // 1. Register every agent (lead first). register() is idempotent-ish:
  //    a name collision would be suffixed, so on a fresh DB names are exact.
  for (const name of AGENTS) {
    engine.register(caller(name), { name });
    await sleep(20);
  }

  // 2. Create channels (lead is auto-joined) and have the rest join.
  for (const { name, members } of CHANNELS) {
    engine.create_channel(caller('lead'), { name });
    for (const member of members) {
      if (member === 'lead') continue; // already auto-joined as creator
      engine.join_channel(caller(member), { channel: name });
    }
    await sleep(20);
  }

  // 3. Replay the timeline in order.
  let turnConventionDone = false;
  for (const step of TIMELINE) {
    if (step.kind === 'file') {
      await writeArchitecture(root, step.action);
      await sleep(120);
      continue;
    }

    const to = step.to ?? HERE_TOKEN;
    engine.send_message(caller(step.from), { channel: step.ch, to, body: step.body });

    // Sprinkle the turn convention in once, mid-session: after scout's
    // direct DM to lead, lead checks its inbox, reads, and marks read so
    // the receipts flip delivered -> seen on the observer's screen.
    if (!turnConventionDone && step.from === 'scout' && step.to === 'lead') {
      runTurn(engine, 'lead');
      // critic does the same so a docs-channel receipt also flips to seen.
      runTurn(engine, 'critic');
      turnConventionDone = true;
    }

    await sleep(60);
  }
}

/** One turn: check_inbox -> read_messages -> mark_read for a caller,
 *  flipping that caller's receipts from delivered to seen. */
function runTurn(engine: LoomEngine, name: string): void {
  const who = caller(name);
  engine.check_inbox(who);
  const unread = engine.read_messages(who, {});
  const ids = unread.map((m) => m.message_id);
  if (ids.length > 0) {
    engine.mark_read(who, { message_ids: ids });
  }
}
