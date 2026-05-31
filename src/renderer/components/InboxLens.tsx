/* ============================================================
 * Loom — per-agent inbox lens (FR-50, FR-53, AC-24)
 * ------------------------------------------------------------
 * Reachable from the roster. Lists messages addressed to one agent,
 * labeled by channel, addressing (@here/direct), and read/unread
 * state, with an unread/total summary ("{unread} unread / {items}
 * in inbox") and (when available) the agent's role line in the
 * header. Provides a real keyboard-operable "<- channels" back
 * control (FR-54). Shows an empty state when nothing is addressed
 * to the agent (AC-24). Bodies render via the safe inline path.
 * ============================================================ */
import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import type { MessageView } from '../../shared/types.js';
import { renderInline } from '../lib/markdown.js';
import { Avatar, avatarColor } from './Avatar.js';

export interface InboxLensProps {
  agent: string;
  /** OPTIONAL role line (FR-50). Omitted gracefully when the backend has no
   *  role for this agent (the live MCP protocol never supplies one). */
  role?: string;
  /** Messages addressed to this agent (direct to them, or @here in a shared channel). */
  items: MessageView[];
  onBack(): void;
}

/** This agent's read/unread state for a message, from the REAL receipt
 *  belonging to this recipient. Unknown receipt -> treated as unread. */
function isUnreadFor(m: MessageView, agent: string): boolean {
  const r = m.receipts.find((rc) => rc.recipient === agent);
  // No receipt for this agent means nothing was addressed to them here;
  // callers should not pass such items, but be defensive: treat as read.
  if (!r) return false;
  return r.read_at === null;
}

function blockBodyNavigation(
  e: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>,
): void {
  if ('key' in e && e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') {
    return;
  }
  const target = e.target as HTMLElement | null;
  if (target && target.closest('a')) {
    e.preventDefault();
  }
}

export function InboxLens(props: InboxLensProps): JSX.Element {
  const { agent, role, items, onBack } = props;
  const unread = items.filter((m) => isUnreadFor(m, agent)).length;
  // FR-50: the role line precedes the unread/inbox summary WHEN a role is
  // available; otherwise it is omitted so empty backends degrade gracefully.
  const roleLine = role && role.trim().length > 0 ? role.trim() : null;

  return (
    <>
      <div className="inbox-head">
        <button type="button" className="back" onClick={onBack}>
          {'←'} channels
        </button>
        <Avatar name={agent} status="active" size={30} showPresence decorative />
        <div>
          <div className="inbox-title">{agent}</div>
          <div className="inbox-sub">
            {roleLine ? `${roleLine} · ` : ''}
            {unread} unread / {items.length} in inbox
          </div>
        </div>
      </div>
      <div className="thread" style={{ padding: 0 }} role="log">
        {items.length === 0 ? (
          <div className="inbox-empty">
            Inbox is empty.
            <br />
            Nothing has been addressed to {agent} yet.
          </div>
        ) : (
          // Newest first, mirroring the prototype's reversed order.
          items
            .slice()
            .reverse()
            .map((m) => {
              const unreadItem = isUnreadFor(m, agent);
              return (
                <div
                  className={'inbox-item' + (unreadItem ? ' unread' : '')}
                  key={m.id}
                >
                  <Avatar name={m.sender} status="active" size={26} decorative />
                  <div>
                    <div>
                      <span
                        className="ib-from"
                        style={{ color: avatarColor(m.sender) }}
                      >
                        {m.sender}
                      </span>{' '}
                      <span className="ib-ch">
                        #{m.channel} {'·'}{' '}
                        {m.addressing === 'here' ? '@here' : 'direct'}
                      </span>
                    </div>
                    <div
                      className="ib-body"
                      onClick={blockBodyNavigation}
                      onKeyDown={blockBodyNavigation}
                      dangerouslySetInnerHTML={{ __html: renderInline(m.body) }}
                    />
                  </div>
                  <span className={'ib-state ' + (unreadItem ? 'unread' : 'read')}>
                    {unreadItem ? 'new' : 'read'}
                  </span>
                </div>
              );
            })
        )}
      </div>
    </>
  );
}
