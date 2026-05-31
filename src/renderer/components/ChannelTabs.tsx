/* ============================================================
 * Loom — Channel tabs (FR-47, FR-54)
 * ------------------------------------------------------------
 * Selectable channel tabs, each showing the channel name and
 * member count. A message-count badge is shown on NON-active tabs
 * (the active/selected tab suppresses its own count badge). Tabs
 * are keyboard-operable real <button>s with role=tab inside a
 * tablist (the prototype's click-only divs do NOT satisfy FR-54),
 * with a visible focus indicator (:focus-visible in renderer.css)
 * and roving-tabindex arrow-key navigation.
 * ============================================================ */
import type { JSX, KeyboardEvent } from 'react';
import type { ChannelView } from '../../shared/types.js';

export interface ChannelTabsProps {
  channels: ChannelView[];
  active: string;
  onSelect(name: string): void;
}

export function ChannelTabs(props: ChannelTabsProps): JSX.Element {
  const { channels, active, onSelect } = props;

  // Arrow-key navigation across the tablist (WCAG tab pattern).
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (channels.length === 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % channels.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + channels.length) % channels.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = channels.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = channels[next];
    if (target) onSelect(target.name);
  }

  return (
    <div className="channels" role="tablist" aria-label="Channels">
      {channels.map((c, i) => {
        const isActive = c.name === active;
        return (
          <button
            type="button"
            key={c.id}
            className={'chtab' + (isActive ? ' on' : '')}
            role="tab"
            aria-selected={isActive}
            // Roving tabindex: only the active tab is in the tab order.
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(c.name)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span>#{c.name}</span>
            <span
              className="mem"
              aria-label={`${c.members.length} member${c.members.length === 1 ? '' : 's'}`}
            >
              {c.members.length}
            </span>
            {/* Count badge ONLY on non-active tabs (active suppresses
                its own badge — FR-47). */}
            {!isActive && c.messageCount > 0 && (
              <span
                className="cnt"
                aria-label={`${c.messageCount} message${c.messageCount === 1 ? '' : 's'}`}
              >
                {c.messageCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
