/* ============================================================
 * Loom — Chat roster strip (FR-46, FR-54, NFR-12)
 * ------------------------------------------------------------
 * Per agent: identity (name + avatar with a text label), a
 * presence/online indicator, an unread count, and the gone
 * (deregistered) visual state (dimmed, greyed presence). Each chip
 * is a real keyboard-operable <button> that opens/closes that
 * agent's inbox (the prototype's click-only div does NOT satisfy
 * FR-54). Non-color cues accompany presence / unread / gone (a
 * visually-hidden status word + an unread suffix), and the chip
 * shows :focus-visible focus from renderer.css.
 * ============================================================ */
import type { JSX } from 'react';
import type { AgentView } from '../../shared/types.js';
import { Avatar } from './Avatar.js';

export interface RosterProps {
  agents: AgentView[];
  /** Currently opened inbox agent name, or null. */
  openInbox: string | null;
  onOpenInbox(name: string | null): void;
}

export function Roster(props: RosterProps): JSX.Element {
  const { agents, openInbox, onOpenInbox } = props;

  return (
    <div className="roster">
      <span className="lbl" id="roster-label">roster</span>
      {agents.map((a) => {
        const gone = a.status === 'gone';
        const isOpen = openInbox === a.name;
        // Non-color status cue baked into the accessible name.
        const statusWord = gone ? 'left the session' : 'online';
        const unreadWord = a.unread > 0 ? `, ${a.unread} unread` : '';
        const label = `${a.name}, ${statusWord}${unreadWord}. ${
          isOpen ? 'Close inbox' : 'Open inbox'
        }`;
        return (
          <button
            type="button"
            key={a.name}
            className={'rchip' + (isOpen ? ' active' : '') + (gone ? ' gone' : '')}
            aria-pressed={isOpen}
            aria-label={label}
            onClick={() => onOpenInbox(isOpen ? null : a.name)}
          >
            <Avatar
              name={a.name}
              status={a.status}
              size={22}
              showPresence
              unread={a.unread}
              decorative
            />
            <span className="nm">{a.name}</span>
          </button>
        );
      })}
    </div>
  );
}
