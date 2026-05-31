/* ============================================================
 * Loom — single chat message (FR-44, FR-48, FR-52, AC-21)
 * ------------------------------------------------------------
 * Avatar + header (sender name, addressing tag, time) + body. The
 * addressing tag visually distinguishes @here (accent) from
 * -> recipient (direct). The body renders through lib/markdown
 * renderInline — the SAME safe path as the Viewer: embedded HTML
 * escaped, links neutralized (non-navigating). Embeds a ReceiptStrip.
 *
 * Defense-in-depth for AC-21: the renderer already strips hrefs, but
 * we also intercept clicks on any anchor inside the body and call
 * preventDefault so an activated link can never navigate.
 * ============================================================ */
import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import type { MessageView } from '../../shared/types.js';
import { renderInline } from '../lib/markdown.js';
import { formatClock } from '../lib/format.js';
import { Avatar, avatarColor } from './Avatar.js';
import { ReceiptStrip } from './ReceiptStrip.js';

export interface MessageProps {
  message: MessageView;
}

/** Belt-and-braces: neutralized links already have NO href, but if an anchor
 *  is ever activated by mouse OR keyboard (Enter/Space) we still stop any
 *  default action (SEC-5 / AC-21 / FR-52). */
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

export function Message(props: MessageProps): JSX.Element {
  const { message } = props;
  const here = message.addressing === 'here';

  return (
    <div className="msg">
      <div className="av-col">
        <Avatar name={message.sender} status="active" size={30} decorative />
      </div>
      <div>
        <div className="msg-head">
          <span
            className="msg-name"
            style={{ color: avatarColor(message.sender) }}
          >
            {message.sender}
          </span>
          {here ? (
            <span className="addr here">@here</span>
          ) : (
            <span className="addr">{'→'} {message.target ?? ''}</span>
          )}
          <span className="msg-time">{formatClock(message.created_at)}</span>
        </div>
        {/* Safe inline body: renderInline escapes embedded HTML and
            neutralizes links (FR-48/FR-52/AC-21). dangerouslySetInnerHTML
            receives ONLY that sanitized output. */}
        <div
          className="msg-body"
          onClick={blockBodyNavigation}
          onKeyDown={blockBodyNavigation}
          dangerouslySetInnerHTML={{ __html: renderInline(message.body) }}
        />
        <ReceiptStrip
          addressing={message.addressing}
          target={message.target}
          receipts={message.receipts}
        />
      </div>
    </div>
  );
}
