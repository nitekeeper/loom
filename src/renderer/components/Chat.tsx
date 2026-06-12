/* ============================================================
 * Loom — Chat pane container (FR-32, FR-44..FR-53, AC-14/18/23/24)
 * ------------------------------------------------------------
 * Composes the chat layer: the agent Roster, channel Tabs, the
 * Thread (or per-agent InboxLens), and the persistent observer
 * notice that REPLACES any composer (the human is strictly
 * read-only — NO text input anywhere, FR-51 / AC-14 / AC-18).
 *
 * Owns chat-local UI state: active channel + open inbox agent.
 * When a roster agent is selected the InboxLens replaces the
 * channel view; the observer notice persists in BOTH modes.
 * ============================================================ */
import { useMemo } from 'react';
import type { JSX } from 'react';
import type { AgentView, ChannelView, MessageView } from '../../shared/types.js';
import { Roster } from './Roster.js';
import { ChannelTabs } from './ChannelTabs.js';
import { Thread } from './Thread.js';
import { InboxLens } from './InboxLens.js';

export interface ChatProps {
  agents: AgentView[];
  channels: ChannelView[];
  messages: MessageView[];
  /** Whether the live feed is frozen (PAUSED) — suppresses auto-scroll. */
  paused: boolean;
  /** Active channel name from the store (single source of truth, FR-14). */
  activeChannel: string | null;
  /** Open inbox agent from the store, or null for the channel thread view. */
  inboxAgent: string | null;
  /** Store action: make a channel active. */
  onSelectChannel: (name: string) => void;
  /** Store action: open a per-agent inbox lens. */
  onOpenInbox: (agent: string) => void;
  /** Store action: close the inbox lens (back to the channel thread). */
  onCloseInbox: () => void;
  /** Authoritative count of STALE agents (counters.staleAgents: gone rows +
   *  actives with no live session) — drives the roster's "clear stale (N)"
   *  button (disabled at zero). */
  staleCount: number;
  /** Store action: HUMAN curation — remove one agent from the roster
   *  (force-deregister when still active; chat history preserved). */
  onRemoveAgent: (name: string) => void;
  /** Store action: HUMAN curation — sweep all STALE agents at once. */
  onClearStale: () => void;
}

/** A message is in an agent's inbox iff it carries a receipt for that
 *  agent (direct-to-them OR @here in a channel they belong to). */
function inboxItemsFor(messages: MessageView[], agent: string): MessageView[] {
  return messages.filter((m) =>
    m.receipts.some((r) => r.recipient === agent),
  );
}

export function Chat(props: ChatProps): JSX.Element {
  const {
    agents,
    channels,
    messages,
    paused,
    activeChannel,
    inboxAgent,
    onSelectChannel,
    onOpenInbox,
    onCloseInbox,
    staleCount,
    onRemoveAgent,
    onClearStale,
  } = props;

  // The store is the single source of truth for navigation (FR-14): the
  // active channel + open inbox come from props, not chat-local state.
  const firstChannel = channels[0]?.name ?? '';
  const openInbox = inboxAgent;

  // Resolve the active channel against the current list (a channel may
  // disappear or the store value may be stale on first non-empty render).
  const active =
    activeChannel !== null && channels.some((c) => c.name === activeChannel)
      ? activeChannel
      : firstChannel;

  // Active = NOT gone (FR-19 / FR-46).
  const activeCount = agents.filter((a) => a.status === 'active').length;

  // Messages for the active channel, in chronological order.
  const channelMessages = useMemo(
    () =>
      messages
        .filter((m) => m.channel === active)
        .sort((a, b) => a.created_at - b.created_at),
    [messages, active],
  );

  const inboxItems = useMemo(
    () => (openInbox ? inboxItemsFor(messages, openInbox) : []),
    [messages, openInbox],
  );

  // FR-50 role line: surfaced from the agent model WHEN present (optional;
  // the live MCP backend supplies none, so this is normally undefined).
  const inboxRole = openInbox
    ? agents.find((a) => a.name === openInbox)?.role
    : undefined;

  return (
    <div className="pane chat">
      <div className="pane-head">
        <span style={{ color: 'var(--accent)' }} aria-hidden="true">◆</span>
        <span style={{ color: 'var(--text)', letterSpacing: '.04em' }}>
          AGENT CHAT
        </span>
        <span className="grow" />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            textTransform: 'none',
            letterSpacing: 0,
          }}
        >
          {activeCount} active
        </span>
      </div>

      {/* Roster strip — always visible; chips open/close an inbox. A chip for
          the already-open inbox toggles it closed. */}
      <Roster
        agents={agents}
        openInbox={openInbox}
        staleCount={staleCount}
        onOpenInbox={(name) => (name === null ? onCloseInbox() : onOpenInbox(name))}
        onRemoveAgent={onRemoveAgent}
        onClearStale={onClearStale}
      />

      {openInbox ? (
        <InboxLens
          agent={openInbox}
          role={inboxRole}
          items={inboxItems}
          onBack={onCloseInbox}
        />
      ) : channels.length === 0 ? (
        <div className="thread">
          <div className="inbox-empty">No channels yet.</div>
        </div>
      ) : (
        <>
          <ChannelTabs
            channels={channels}
            active={active}
            onSelect={onSelectChannel}
          />
          <Thread channel={active} messages={channelMessages} paused={paused} />
        </>
      )}

      {/* Persistent observer notice — REPLACES the composer. There is no
          text input anywhere in this pane (FR-32 / FR-51 / AC-14 / AC-18). */}
      <div className="observer" role="note">
        <span className="eye" aria-hidden="true">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
        <span className="txt">
          <b>You&rsquo;re observing.</b> This channel belongs to the agents —
          they post and read on their own. You can&rsquo;t be seen here.
        </span>
      </div>
    </div>
  );
}
