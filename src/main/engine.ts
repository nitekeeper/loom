/* ============================================================
 * Loom — tool engine (PURE business logic for the 9 MCP tools)
 * ------------------------------------------------------------
 * The heart of the chat system. Implements all 9 tools as pure
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
  type SendMessageParams,
  type SendMessageResult,
  type UnreadMessage,
} from '../shared/types.js';
import type { LoomDb } from './db.js';
import type { EventBus } from './eventbus.js';

/** Maximum length of a body preview returned by check_inbox (FR-25). */
const PREVIEW_MAX = 80;

/** Build the engine bound to a db + event bus. */
export function createEngine(db: LoomDb, bus: EventBus): LoomEngine {
  /** Epoch-millisecond wall-clock time (the standard JS clock). */
  function now(): number {
    return Date.now();
  }

  /** Resolve the caller's registered name or throw NOT_REGISTERED.
   *  A caller is "registered" when it has a bound name that still
   *  resolves to an existing agents row (active OR gone). */
  function requireRegistered(caller: Caller): string {
    const name = caller.name;
    if (name === null || db.getAgent(name) === undefined) {
      throw new LoomError(
        'NOT_REGISTERED',
        'caller must register() before invoking this tool',
      );
    }
    return name;
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
   *  optionally filtered by channel id. Sorted by message id ascending so
   *  delivery order is stable across check_inbox / read_messages. */
  function unreadMessagesFor(
    recipient: string,
    channelId?: number,
  ): MessageRow[] {
    const messages = db.listMessages(channelId);
    const out: MessageRow[] = [];
    for (const message of messages) {
      const receipts = db.listReceipts(message.id);
      const mine = receipts.find(
        (r) => r.recipient === recipient && r.read_at === null,
      );
      if (mine !== undefined) out.push(message);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  return {
    register(caller: Caller, params: RegisterParams): RegisterResult {
      const requested = params.name.trim();
      if (requested.length > MAX_NAME_LENGTH) {
        throw new LoomError(
          'NAME_TOO_LONG',
          `name exceeds ${MAX_NAME_LENGTH} characters`,
        );
      }
      // Assign a unique name by suffixing against ANY existing row,
      // active OR gone (FR-15, AC-6, OQ-1).
      const taken = new Set(db.listAgents().map((a) => a.name));
      let assigned = requested;
      let n = 2;
      while (taken.has(assigned)) {
        assigned = `${requested}-${n}`;
        n += 1;
      }

      const at = now();
      const connection_id =
        caller.name !== null && caller.name !== ''
          ? caller.name
          : `conn-${assigned}-${at}`;
      const agent = {
        name: assigned,
        connection_id,
        status: 'active' as const,
        registered_at: at,
      };
      db.insertAgent(agent);
      db.flush();

      // Bind the caller identity to the assigned name (mutate caller).
      caller.name = assigned;

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
      // Identity is bound to the session at register() time. A caller may
      // ONLY deregister itself — deregistering an arbitrary agent by name
      // is a denial-of-presence / identity-tampering primitive (SEC-2).
      const me = requireRegistered(caller);
      const name = params.name.trim();
      if (name !== me) {
        throw new LoomError(
          'NOT_AUTHORIZED',
          `caller ${me} may only deregister itself, not ${name}`,
        );
      }
      const agent = db.getAgent(name);
      if (agent === undefined) {
        throw new LoomError('AGENT_NOT_FOUND', `no such agent: ${name}`);
      }

      db.setAgentStatus(name, 'gone');
      db.flush();

      // The row stays in the table (dimmed in UI, excluded from active
      // count) — FR-19, AC-12. Publish the updated agent row.
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
      if (params.body.length > MAX_BODY_LENGTH) {
        throw new LoomError(
          'BODY_TOO_LONG',
          `message body exceeds ${MAX_BODY_LENGTH} characters`,
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

      // One receipt per recipient (read_at NULL = unread) — FR-21/28.
      for (const recipient of recipients) {
        db.insertReceipt({ message_id: message.id, recipient, read_at: null });
      }
      db.flush();

      bus.publish({
        kind: 'message',
        message,
        recipients,
        channel: channel.name,
      });
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

      // Set read_at for the caller's receipts whose message_id is in the
      // list AND currently NULL; return the count actually updated (FR-27).
      const marked = db.markReceiptsRead(params.message_ids, me, at);
      if (marked > 0) db.flush();

      // Publish a ReceiptEvent for each receipt that flipped to read so the
      // live feed + ws + counters update (FR-29/30).
      for (const id of params.message_ids) {
        const receipt = db
          .listReceipts(id)
          .find((r) => r.recipient === me && r.read_at === at);
        if (receipt !== undefined) {
          bus.publish({ kind: 'receipt', receipt });
        }
      }

      return { marked };
    },
  };
}
