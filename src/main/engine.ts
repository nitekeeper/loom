/* ============================================================
 * Loom — tool engine (PURE business logic for the 10 MCP tools)
 * ------------------------------------------------------------
 * The heart of the chat system. Implements all 10 tools as pure
 * functions over a LoomDb + EventBus. Importable WITHOUT Electron
 * so the acceptance suite (test/acceptance.mjs) can exercise every
 * tool directly. mcp.ts is a thin wrapper over this module.
 *
 * Contract notes encoded here:
 *  - register: suffix-on-collision vs ANY existing row (active or
 *    gone); max name length 64 (OQ-1, FR-15, AC-6). Mutates caller.
 *  - create_channel: auto-joins caller (FR-16, AC-7).
 *  - join_channel: returns current member names (FR-17, AC-7).
 *  - send_message: `to`=name -> addressing 'direct', target=name;
 *    `to`="@here" -> 'here', target=NULL, one receipt per member
 *    except sender; recipients resolved at SEND time (OQ-3, FR-21/24).
 *  - check_inbox / read_messages: mark NOTHING read (FR-25/26, AC-9).
 *  - mark_read: set read_at for caller's receipts (FR-27, AC-9).
 *  - Law 5: a send is only valid if sender + target share the channel
 *    (FR-20, AC-11) -> RECIPIENT_NOT_MEMBER / NOT_A_MEMBER.
 *  - Every mutating tool publishes a LoomEvent on the bus (FR-29/30).
 *
 * Timestamps: epoch milliseconds from the standard JS wall clock.
 * ============================================================ */
import { readdirSync, rmSync, type Dirent } from 'node:fs';
import path from 'node:path';
import {
  HERE_TOKEN,
  LoomError,
  MAX_BODY_LENGTH,
  MAX_NAME_LENGTH,
  type Caller,
  type CheckInboxResult,
  type CreateChannelParams,
  type CreateChannelResult,
  type DeregisterParams,
  type DeregisterResult,
  type InboxPreview,
  type JoinChannelParams,
  type JoinChannelResult,
  type ListChannelsResult,
  type LoomEngine,
  type MarkReadParams,
  type MarkReadResult,
  type MessageRow,
  type ReadMessagesParams,
  type ReadMessagesResult,
  type RegisterParams,
  type RegisterResult,
  type PurgeAllResult,
  type SendMessageParams,
  type SendMessageResult,
  type UnreadMessage,
} from '../shared/types.js';
import type { LoomDb } from './db.js';
import type { EventBus } from './eventbus.js';

/** Maximum length of a body preview returned by check_inbox (FR-25). */
const PREVIEW_MAX = 80;

/** Runtime engine options (R1/R4). All optional so the Electron-free test
 *  harness can construct the engine with just (db, bus) and get the defaults. */
export interface EngineOptions {
  /** Per-message body cap (SEC-6), resolved from config; defaults to
   *  MAX_BODY_LENGTH when unset. Enforced authoritatively in send_message. */
  maxBodyLength?: number;
  /** Sandbox root, used by purge_all to delete `.loom/temp` report files.
   *  When absent (e.g. a pure-engine unit test), purge_all skips the fs
   *  removal and reports reports:0 — the table deletes still run. */
  rootDir?: string;
  /** Persisted-message retention cap (memory + per-flush serialize-cost bound).
   *  When a positive integer, send_message prunes the oldest beyond it (FK-safe)
   *  and the cap is enforced once on construction; 0/absent = unlimited. The
   *  pure-engine test harness omits it, so the default is unlimited and existing
   *  behaviour is unchanged. Resolved from config (LoomConfig.maxMessages). */
  maxMessages?: number;
}

/** Build the engine bound to a db + event bus. */
export function createEngine(
  db: LoomDb,
  bus: EventBus,
  opts: EngineOptions = {},
): LoomEngine {
  // Resolve the runtime body cap once: a positive integer from config, else
  // the compile-time default. send_message enforces THIS value (R1).
  const maxBodyLength =
    typeof opts.maxBodyLength === 'number' &&
    Number.isInteger(opts.maxBodyLength) &&
    opts.maxBodyLength > 0
      ? opts.maxBodyLength
      : MAX_BODY_LENGTH;
  const rootDir = opts.rootDir;
  // Persisted-message retention cap (memory + flush-cost bound). A positive
  // integer enables pruning; 0/absent leaves history unlimited.
  const maxMessages =
    typeof opts.maxMessages === 'number' &&
    Number.isInteger(opts.maxMessages) &&
    opts.maxMessages > 0
      ? opts.maxMessages
      : 0;
  /** Epoch-millisecond wall-clock time (the standard JS clock). */
  function now(): number {
    return Date.now();
  }

  /** Resolve the caller's registered name or throw NOT_REGISTERED.
   *  A caller is "registered" when it has a bound name that still resolves
   *  to an existing agents row (active OR gone) AND — when the session
   *  carries the connectionId register() bound — that row is still THE SAME
   *  registration (agents.connection_id matches). The match closes the
   *  identity-capture hole around human removal (REMOVE_AGENT): removal
   *  frees the bare name for a NEW agent to re-register; without it, the
   *  OLD removed session's calls would silently succeed AS the new agent
   *  (read its inbox, send as it). The recreated row carries a different
   *  connection_id, so the stale session keeps failing NOT_REGISTERED.
   *  Hand-built callers without a connectionId (in-process unit tests)
   *  skip the match — every real session gets one from register(). */
  function requireRegistered(caller: Caller): string {
    const name = caller.name;
    const agent = name === null ? undefined : db.getAgent(name);
    if (
      agent === undefined ||
      (caller.connectionId != null && agent.connection_id !== caller.connectionId)
    ) {
      throw new LoomError(
        'NOT_REGISTERED',
        'caller must register() before invoking this tool',
      );
    }
    // name is non-null here (agent would be undefined otherwise).
    return name as string;
  }

  /** Resolve a channel by name or throw CHANNEL_NOT_FOUND. */
  function requireChannel(channel: string): { id: number; name: string } {
    const row = db.getChannelByName(channel);
    if (row === undefined) {
      throw new LoomError('CHANNEL_NOT_FOUND', `no such channel: ${channel}`);
    }
    return row;
  }

  /** Current member names of a channel (membership order). */
  function memberNames(channelId: number): string[] {
    return db.listMemberships(channelId).map((m) => m.agent_name);
  }

  /** Truncate a body for inbox previews (FR-25). */
  function previewOf(body: string): string {
    if (body.length <= PREVIEW_MAX) return body;
    return `${body.slice(0, PREVIEW_MAX)}…`;
  }

  /** All UNREAD MessageRows addressed to a recipient (receipt read_at NULL),
   *  optionally filtered by channel id, ordered by message id ascending so
   *  delivery order is stable across check_inbox / read_messages.
   *
   *  Backed by a single indexed JOIN (db.listUnreadMessagesFor) — O(unread),
   *  not the former O(messages × receipts) per-message scan. check_inbox and
   *  read_messages are the tools every agent polls, so this is the path that
   *  must stay cheap when many agents chat concurrently (single-threaded
   *  sql.js: a slow scan here blocks every other session AND the UI). */
  function unreadMessagesFor(
    recipient: string,
    channelId?: number,
  ): MessageRow[] {
    return db.listUnreadMessagesFor(recipient, channelId);
  }

  // Enforce the retention cap once on construction so loading a previously
  // over-cap db (or a lowered config) converges immediately, not only on the
  // next send. No-op when unlimited.
  if (maxMessages > 0) db.pruneMessagesToCap(maxMessages);

  // Monotonic disambiguator for generated connection_ids: two registrations
  // of the SAME bare name within the SAME millisecond (e.g. remove → instant
  // re-register) must still mint DISTINCT connection_ids, or the stale-session
  // guard in requireRegistered could not tell the claims apart.
  let connSeq = 0;

  return {
    register(caller: Caller, params: RegisterParams): RegisterResult {
      const requested = params.name.trim();
      if (requested.length > MAX_NAME_LENGTH) {
        throw new LoomError(
          'NAME_TOO_LONG',
          `name exceeds ${MAX_NAME_LENGTH} characters`,
        );
      }
      // Assign a unique name by suffixing against ANY existing row, active OR
      // gone (FR-15, AC-6, OQ-1).
      //
      // CONCURRENCY INVARIANT (audit H3): this name-claim — read `taken`, pick a
      // free suffix, db.insertAgent — MUST run as ONE synchronous unit with NO
      // `await` between the read and the insert. The MCP transport binds one
      // Caller per session and serializes concurrent register() calls on the
      // single-threaded event loop, so two sessions racing the SAME name each
      // observe the other's row in `taken` and get distinct suffixes. The
      // agents.name PRIMARY KEY is the DB-level backstop. Do NOT add an await.
      const taken = new Set(db.listAgents().map((a) => a.name));
      let assigned = requested;
      let n = 2;
      while (taken.has(assigned)) {
        assigned = `${requested}-${n}`;
        n += 1;
      }

      const at = now();
      // ALWAYS mint a fresh, per-registration-unique connection_id. The
      // legacy branch that reused caller.name as the id when an already-named
      // session registered a SECOND name made it deterministic and REUSABLE:
      // after the human removed the rows, a new session re-running the same
      // register sequence minted the SAME id, so the OLD session's stale
      // (name, connectionId) binding matched the successor row and it could
      // act AS the new agent (identity-capture PoC, RM-12). Nothing reads
      // connection_id back except requireRegistered's match, so uniqueness is
      // the property that matters — name + wall-clock ms + monotonic seq.
      const connection_id = `conn-${assigned}-${at}-${connSeq++}`;
      const agent = {
        name: assigned,
        connection_id,
        status: 'active' as const,
        registered_at: at,
      };
      db.insertAgent(agent);
      db.flush();

      // Bind the caller identity to the assigned name AND this registration's
      // connection_id (mutate caller) — the pair requireRegistered verifies,
      // so a later same-name re-registration is a DIFFERENT identity.
      caller.name = assigned;
      caller.connectionId = connection_id;

      bus.publish({ kind: 'agent', agent });
      return { ok: true, name: assigned, channels: [] };
    },

    create_channel(
      caller: Caller,
      params: CreateChannelParams,
    ): CreateChannelResult {
      const me = requireRegistered(caller);
      const name = params.name.trim();
      if (db.getChannelByName(name) !== undefined) {
        throw new LoomError('CHANNEL_EXISTS', `channel already exists: ${name}`);
      }

      const at = now();
      const channel = db.insertChannel(name, at);
      // Auto-join the creating agent (FR-16, AC-7).
      db.insertMembership({
        channel_id: channel.id,
        agent_name: me,
        joined_at: at,
      });
      db.flush();

      bus.publish({
        kind: 'channel',
        channel,
        members: memberNames(channel.id),
      });
      return { id: channel.id, name: channel.name };
    },

    join_channel(
      caller: Caller,
      params: JoinChannelParams,
    ): JoinChannelResult {
      const me = requireRegistered(caller);
      const channel = requireChannel(params.channel);

      const already = db
        .listMemberships(channel.id)
        .some((m) => m.agent_name === me);
      if (!already) {
        db.insertMembership({
          channel_id: channel.id,
          agent_name: me,
          joined_at: now(),
        });
        db.flush();
      }

      const members = memberNames(channel.id);
      // LOOM-AC13-05: an idempotent re-join is a NO-OP and must be SILENT —
      // only publish the membership change when the caller actually joined,
      // so the live feed + ws never carry a spurious channel event for a
      // member that was already present.
      if (!already) {
        const channelRow = db.getChannelById(channel.id) ?? {
          id: channel.id,
          name: channel.name,
          created_at: now(),
        };
        bus.publish({ kind: 'channel', channel: channelRow, members });
      }
      return { channel: channel.name, members };
    },

    list_channels(_caller: Caller): ListChannelsResult {
      return db.listChannels().map((c) => ({
        id: c.id,
        name: c.name,
        members: memberNames(c.id),
      }));
    },

    deregister(
      caller: Caller,
      params: DeregisterParams,
    ): DeregisterResult {
      // FR-19 / US-9 intend ORCHESTRATOR-DRIVEN deregistration: the lead
      // agent calls deregister(name) for each sub-agent when its work is
      // done. A registered caller MAY therefore deregister ANY agent by
      // name (itself or another) — there is no self-only restriction. The
      // trust boundary is the loopback-only, Origin/DNS-rebinding-guarded
      // MCP transport (OQ-4 / SEC-1), not per-call name matching; the
      // earlier self-only rule (SEC-2) was reverted as spec-contradicting.
      // requireRegistered still enforces Law 4 (an unregistered/anonymous
      // session gets NOT_REGISTERED), and the operation is idempotent.
      requireRegistered(caller);
      const name = params.name.trim();
      const agent = db.getAgent(name);
      if (agent === undefined) {
        throw new LoomError('AGENT_NOT_FOUND', `no such agent: ${name}`);
      }

      // Idempotent: deregistering an already-'gone' agent is a no-op write
      // that still returns {ok,name}. The row stays in the table (dimmed in
      // UI, excluded from active count) — FR-19, AC-12.
      db.setAgentStatus(name, 'gone');
      db.flush();

      // Publish the updated agent row.
      bus.publish({ kind: 'agent', agent: { ...agent, status: 'gone' } });
      return { ok: true, name };
    },

    send_message(
      caller: Caller,
      params: SendMessageParams,
    ): SendMessageResult {
      const sender = requireRegistered(caller);
      // Bound the body authoritatively at the engine boundary (SEC-6, FR-14)
      // so an oversized fenced code block cannot freeze the renderer's
      // per-line highlighter. The MCP schema mirrors this for an early reject.
      if (params.body.length > maxBodyLength) {
        throw new LoomError(
          'BODY_TOO_LONG',
          `message body exceeds ${maxBodyLength} characters`,
        );
      }
      const channel = requireChannel(params.channel);

      const members = memberNames(channel.id);
      // The sender MUST be a member of the channel (Law 5, FR-20).
      if (!members.includes(sender)) {
        throw new LoomError(
          'NOT_A_MEMBER',
          `sender ${sender} is not a member of channel ${channel.name}`,
        );
      }

      const at = now();
      let addressing: MessageRow['addressing'];
      let target: string | null;
      let recipients: string[];

      if (params.to === HERE_TOKEN) {
        // Broadcast: resolve recipients at SEND time (OQ-3) — all current
        // members except the sender (FR-24).
        addressing = 'here';
        target = null;
        recipients = members.filter((m) => m !== sender);
      } else {
        // Direct: the named recipient MUST be a member of THIS channel
        // (Law 5, FR-20, AC-11) -> RECIPIENT_NOT_MEMBER (FR-23).
        const to = params.to;
        if (!members.includes(to)) {
          throw new LoomError(
            'RECIPIENT_NOT_MEMBER',
            `recipient ${to} is not a member of channel ${channel.name}`,
          );
        }
        addressing = 'direct';
        target = to;
        recipients = [to];
      }

      const message = db.insertMessage({
        channel_id: channel.id,
        sender,
        body: params.body,
        addressing,
        target,
        created_at: at,
      });

      // One receipt per recipient (read_at NULL = unread) — FR-21/28. Batched
      // into a single multi-row INSERT + one flush (the @here fan-out writes
      // N-1 receipts at once) instead of N execWrite+flush re-arms.
      db.insertReceipts(
        recipients.map((recipient) => ({ message_id: message.id, recipient, read_at: null })),
      );
      db.flush();

      bus.publish({
        kind: 'message',
        message,
        recipients,
        channel: channel.name,
      });

      // Bound persisted history (memory + per-flush serialize cost): prune the
      // oldest beyond the cap. The just-inserted message is the newest, so it is
      // never pruned. No-op when unlimited (maxMessages = 0).
      if (maxMessages > 0) db.pruneMessagesToCap(maxMessages);

      return { message_id: message.id, recipients };
    },

    check_inbox(caller: Caller): CheckInboxResult {
      const me = requireRegistered(caller);
      const unreadMessages = unreadMessagesFor(me);

      const previews: InboxPreview[] = unreadMessages.map((message) => {
        const channel = db.getChannelById(message.channel_id);
        return {
          message_id: message.id,
          channel: channel?.name ?? '',
          sender: message.sender,
          addressing: message.addressing,
          preview: previewOf(message.body),
          created_at: message.created_at,
        };
      });

      // MARK NOTHING READ (FR-25, AC-9).
      return { unread: previews.length, previews };
    },

    read_messages(
      caller: Caller,
      params: ReadMessagesParams,
    ): ReadMessagesResult {
      const me = requireRegistered(caller);

      let channelId: number | undefined;
      if (params.channel !== undefined) {
        // Filter by channel name; an unknown name yields no messages.
        channelId = db.getChannelByName(params.channel)?.id;
        if (channelId === undefined) return [];
      }

      const unreadMessages = unreadMessagesFor(me, channelId);
      const out: UnreadMessage[] = unreadMessages.map((message) => {
        const channel = db.getChannelById(message.channel_id);
        return {
          message_id: message.id,
          channel: channel?.name ?? '',
          sender: message.sender,
          addressing: message.addressing,
          target: message.target,
          body: message.body,
          created_at: message.created_at,
        };
      });

      // MARK NOTHING READ (FR-26, AC-9).
      return out;
    },

    mark_read(caller: Caller, params: MarkReadParams): MarkReadResult {
      const me = requireRegistered(caller);
      const at = now();

      // Set read_at for the caller's receipts whose message_id is in the list
      // AND currently NULL (FR-27). markReceiptsRead returns the ids that
      // actually FLIPPED (was unread -> now read) and flushes internally.
      const flipped = db.markReceiptsRead(params.message_ids, me, at);

      // Publish one ReceiptEvent per flipped receipt so the live feed + ws +
      // counters update (FR-29/30). We know recipient=me and read_at=at, so we
      // build the events directly — no per-id listReceipts re-query (L2).
      for (const id of flipped) {
        bus.publish({ kind: 'receipt', receipt: { message_id: id, recipient: me, read_at: at } });
      }

      return { marked: flipped.length };
    },

    purge_all(caller: Caller): PurgeAllResult {
      // Light guard (Law 4): only a registered session may invoke the human
      // delete affordance — an anonymous transport gets NOT_REGISTERED.
      requireRegistered(caller);

      // Count BEFORE deleting so the summary reflects what was removed.
      const messages = db.listMessages().length;
      const channels = db.listChannels().length;
      const agents = db.listAgents().length;

      // Empty every table FK-safe (children first) + flush the now-empty db.
      db.purgeAll();

      // Remove the transient agent-report files under <rootDir>/.loom/temp.
      // Best-effort + recursive; absent dir (ENOENT) is ignored. Skipped when
      // the engine has no rootDir (pure unit test): reports stays 0.
      let reports = 0;
      if (rootDir !== undefined) {
        const tempDir = path.join(rootDir, '.loom', 'temp');
        try {
          // Count files removed (best-effort; a read failure leaves reports=0).
          reports = countTempReports(tempDir);
        } catch {
          reports = 0;
        }
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* best-effort: ignore (e.g. permissions); the table purge stands. */
        }
      }

      // The caller's agents row is now gone, so its bound identity is stale:
      // null it so a stale follow-up call fails cleanly with NOT_REGISTERED
      // rather than acting under a vanished name. Callers MUST re-register.
      caller.name = null;
      caller.connectionId = null;

      return { ok: true, deleted: { messages, channels, agents, reports } };
    },
  };
}

/* ------------------------------------------------------------------ *
 * HUMAN roster curation (IPC-only — NOT MCP tools, the frozen 10 are  *
 * untouched). Pure fns over (db, bus) so the node --test suite drives *
 * them Electron-free; src/main/ipc.ts is their only production caller *
 * (REMOVE_AGENT / CLEAR_STALE_AGENTS).                                *
 * ------------------------------------------------------------------ */

/** Channels that currently hold a membership for ANY of `names`. Snapshotted
 *  BEFORE the delete so the post-delete ChannelEvents cover exactly the
 *  channels whose member lists changed. */
function channelsWithMembers(db: LoomDb, names: ReadonlySet<string>) {
  return db
    .listChannels()
    .filter((c) => db.listMemberships(c.id).some((m) => names.has(m.agent_name)));
}

/** Publish one ChannelEvent (the same shape join_channel publishes) per
 *  affected channel with its POST-delete member list, so the renderer's
 *  ChannelTabs member counts stay in sync with MCP list_channels without a
 *  relaunch. */
function publishMembershipRemovals(
  db: LoomDb,
  bus: EventBus,
  affected: ReturnType<typeof channelsWithMembers>,
): void {
  for (const channel of affected) {
    bus.publish({
      kind: 'channel',
      channel,
      members: db.listMemberships(channel.id).map((m) => m.agent_name),
    });
  }
}

/** Remove ONE agent (any status) from the roster: DELETE its agents row
 *  (+ memberships/receipts; messages preserved — see LoomDb.removeAgent).
 *
 *  Re-validates the renderer-supplied input here (never trust the renderer):
 *  non-string / blank / over-long / unknown names are a fail-soft `false`.
 *
 *  For a still-ACTIVE agent this is a FORCE-deregister. Its MCP session (if
 *  any) ends because session identity is bound to the registered row's
 *  connection_id (requireRegistered): with the row deleted the next tool
 *  call fails NOT_REGISTERED, and — crucially — it KEEPS failing even after
 *  a NEW agent re-registers the freed bare name, because the recreated row
 *  carries a different connection_id (no identity capture). The idle reaper
 *  evicts the dead transport (the same backstop deregister relies on); no
 *  parallel session-teardown path is introduced.
 *
 *  Publishes the SAME 'gone' AgentEvent shape deregister publishes — the
 *  renderer's reduceAgent already drops a gone agent from the roster, so the
 *  strip updates live without any new event kind (the LoomEvent union stays
 *  frozen) — plus one ChannelEvent per channel the agent belonged to (member
 *  lists stay live). A removed name may re-register FRESH (no blocklist). */
export function removeAgentByName(
  db: LoomDb,
  bus: EventBus,
  name: unknown,
): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) return false;
  const agent = db.getAgent(trimmed);
  if (agent === undefined) return false;
  const affected = channelsWithMembers(db, new Set([trimmed]));
  if (!db.removeAgent(trimmed)) return false;
  bus.publish({ kind: 'agent', agent: { ...agent, status: 'gone' } });
  publishMembershipRemovals(db, bus, affected);
  return true;
}

/** Is this agents row STALE — i.e. clearable by the roster's sweep button?
 *  Stale = explicitly deregistered (status='gone') OR still marked 'active'
 *  but with NO live MCP session bound to its registration (its connection_id
 *  is absent from the live set). The kaizen field case: agents whose process
 *  died (or whose app was restarted) never call deregister, and the idle
 *  reaper only closes transports — it NEVER touches the db — so dead agents
 *  sit 'active' forever; the old gone-only sweep cleared rows the roster
 *  never even displays. Exported so the counters tick
 *  (SessionCounters.staleAgents) and the sweep share ONE definition. */
export function isStaleAgent(
  agent: { status: 'active' | 'gone'; connection_id: string },
  liveConnectionIds: ReadonlySet<string>,
): boolean {
  return agent.status === 'gone' || !liveConnectionIds.has(agent.connection_id);
}

/** Remove EVERY stale agent at once (same delete semantics as
 *  removeAgentByName): status='gone' rows ∪ status='active' rows with no
 *  live session bound (isStaleAgent over the live connection_id set the MCP
 *  server reports). A LIVE connected agent is NEVER swept — the per-chip ×
 *  is the only affordance that can remove one.
 *
 *  Post-restart note: sessions do not survive the process, so after a
 *  relaunch EVERY 'active' row is stale until its agent re-registers —
 *  sweeping them all is the intended meaning of the button. No race with a
 *  registering agent: register() claims the row AND binds the session's
 *  connectionId in one synchronous unit on the same event loop this sweep
 *  runs on, so at sweep time an agent is either fully live (kept) or not
 *  yet present (nothing to remove).
 *
 *  Returns the number removed; publishes one 'gone' AgentEvent per removed
 *  row (the renderer's reduceAgent drops the VISIBLE stale-active chips —
 *  the user-facing point of the sweep) plus one ChannelEvent per channel
 *  that lost members. */
export function clearStaleAgents(
  db: LoomDb,
  bus: EventBus,
  liveConnectionIds: ReadonlySet<string>,
): number {
  const stale = db.listAgents().filter((a) => isStaleAgent(a, liveConnectionIds));
  if (stale.length === 0) return 0;
  const affected = channelsWithMembers(db, new Set(stale.map((a) => a.name)));
  const removed = new Set(db.removeAgents(stale.map((a) => a.name)));
  for (const agent of stale) {
    if (removed.has(agent.name)) {
      bus.publish({ kind: 'agent', agent: { ...agent, status: 'gone' } });
    }
  }
  publishMembershipRemovals(db, bus, affected);
  return removed.size;
}

/** Count regular files anywhere under `dir` (recursive), for the purge_all
 *  report tally. Returns 0 when the dir is absent/unreadable. Lazily imports
 *  the fs primitives it needs so the hot tool paths don't. */
function countTempReports(dir: string): number {
  let count = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // absent/unreadable -> nothing counted.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countTempReports(full);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}
