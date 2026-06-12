/* ============================================================
 * Loom — Chat roster strip (FR-46, FR-54, NFR-12)
 * ------------------------------------------------------------
 * Per agent: identity (name + avatar with a text label), a
 * presence/online indicator, and an unread count. Each chip is a
 * pill (.rchip-wrap) holding TWO sibling real <button>s — the
 * keyboard-operable open/close-inbox chip (.rchip, the prototype's
 * click-only div does NOT satisfy FR-54) and a separate remove (×)
 * button (.rchip-x). Siblings, never nested: activating the × can
 * never hijack the chip's open-inbox click, and buttons-in-buttons
 * are invalid/inaccessible markup.
 *
 * REACHABLE STATES ONLY: vm.agents never contains 'gone' rows (the
 * boot snapshot filters to active, and the live reducer drops a
 * 'gone' AgentEvent's chip), so every chip here is an agent main
 * still believes active and every × is a FORCE-remove — the label
 * says so (non-color cue). The clear-up affordance is "clear stale
 * (N)" (SessionCounters.staleAgents, disabled at zero): it sweeps
 * gone rows PLUS 'active' rows with no live MCP session — the dead
 * chips the human actually sees (kaizen field report: dead agents
 * never deregister, so they sit 'active' forever; a gone-only sweep
 * cleared only invisible rows). A LIVE connected agent is never
 * swept — the per-chip × is the only way to remove one.
 *
 * HUMAN roster curation: the × removes that agent from the roster
 * outright (DB row deleted in main; chat history preserved). No
 * confirm step (the user decision): removal is fail-soft and a
 * removed agent may simply re-register fresh.
 *
 * FOCUS IS NEVER STRANDED (the App.tsx close-file idiom): the
 * activated × / clear-stale button can unmount or disable, so the
 * click handlers pick a live target FIRST (next chip, else previous
 * chip, else the enabled clear-stale button, else the roster
 * container — focusable via tabindex=-1) and move focus after the
 * re-render (rAF). The target pickers are exported pure-DOM seams
 * so the node suite can pin them in jsdom.
 *
 * Non-color cues accompany presence / unread (a visually-hidden
 * status word + an unread suffix), and every button shows
 * :focus-visible focus from renderer.css.
 * ============================================================ */
import type { JSX } from 'react';
import type { AgentView } from '../../shared/types.js';
import { Avatar } from './Avatar.js';

export interface RosterProps {
  agents: AgentView[];
  /** Currently opened inbox agent name, or null. */
  openInbox: string | null;
  /** Authoritative count of STALE agents (counters.staleAgents) — gone rows
   *  + actives with no live session, computed in main where the session map
   *  lives. This is exactly what the clear-stale button will remove. */
  staleCount: number;
  onOpenInbox(name: string | null): void;
  /** HUMAN curation: remove ONE agent (always a force-remove — every
   *  rendered chip is a live agent). */
  onRemoveAgent(name: string): void;
  /** HUMAN curation: sweep ALL stale agents at once. */
  onClearStale(): void;
}

/** Where focus should land after a chip's × removes it: the NEXT chip's
 *  open-inbox button, else the PREVIOUS chip's, else the ENABLED clear-stale
 *  button, else the roster container itself (tabindex=-1). Pure DOM walk
 *  from the activated × — exported so the jsdom suite can pin it. */
export function nextFocusAfterChipRemoval(removeBtn: Element): HTMLElement | null {
  const roster = removeBtn.closest('.roster');
  const wrap = removeBtn.closest('.rchip-wrap');
  if (roster === null || wrap === null) return null;
  const wraps = Array.from(roster.querySelectorAll('.rchip-wrap'));
  const i = wraps.indexOf(wrap);
  const neighbor = wraps[i + 1] ?? wraps[i - 1] ?? null;
  return (
    (neighbor?.querySelector('.rchip') as HTMLElement | null) ??
    (roster.querySelector('.roster-clear-stale:not([disabled])') as HTMLElement | null) ??
    (roster as HTMLElement)
  );
}

/** Where focus should land after clear-stale: clearing zeroes the count,
 *  which DISABLES the button under focus (focus would strand) — hand it to
 *  the first chip, else the roster container. Exported for the jsdom suite. */
export function focusTargetAfterClearStale(clearBtn: Element): HTMLElement | null {
  const roster = clearBtn.closest('.roster');
  if (roster === null) return null;
  return (
    (roster.querySelector('.rchip') as HTMLElement | null) ?? (roster as HTMLElement)
  );
}

/** Focus `target` after the unmount/disable re-render (rAF when available —
 *  the App.tsx close-file idiom; synchronous fallback keeps non-browser
 *  environments working). */
function focusAfterRender(target: HTMLElement | null): void {
  if (target === null) return;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => target.focus());
  } else {
    target.focus();
  }
}

export function Roster(props: RosterProps): JSX.Element {
  const { agents, openInbox, staleCount, onOpenInbox, onRemoveAgent, onClearStale } = props;

  return (
    /* tabIndex=-1: the programmatic focus fallback when the last chip is
       removed and clear-stale is disabled (never strand focus on <body>). */
    <div className="roster" tabIndex={-1}>
      <span className="lbl" id="roster-label">roster</span>
      {agents.map((a) => {
        const isOpen = openInbox === a.name;
        // Non-color status cue baked into the accessible name. Every rendered
        // chip is an active agent (gone rows never reach vm.agents).
        const unreadWord = a.unread > 0 ? `, ${a.unread} unread` : '';
        const label = `${a.name}, online${unreadWord}. ${
          isOpen ? 'Close inbox' : 'Open inbox'
        }`;
        const removeLabel =
          `Remove ${a.name} from the roster ` +
          `(force-remove: the agent may still be running). Chat history is kept.`;
        return (
          <span key={a.name} className={'rchip-wrap' + (isOpen ? ' active' : '')}>
            <button
              type="button"
              className={'rchip' + (isOpen ? ' active' : '')}
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
            <button
              type="button"
              className="rchip-x"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(e) => {
                // Pick the post-removal focus target while this chip is still
                // in the DOM, then remove; focus moves after the re-render.
                const target = nextFocusAfterChipRemoval(e.currentTarget);
                onRemoveAgent(a.name);
                focusAfterRender(target);
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        );
      })}
      <button
        type="button"
        className="roster-clear-stale"
        disabled={staleCount === 0}
        aria-label={`Clear stale agents: remove all ${staleCount} agents with no live connection (deregistered or dead sessions). Live agents are kept; chat history is kept.`}
        title="Remove every agent with no live connection (deregistered or dead). Live agents and chat history are kept."
        onClick={(e) => {
          // Clearing zeroes the count and disables this button under focus —
          // hand focus to a live target first (App.tsx close-file idiom).
          const target = focusTargetAfterClearStale(e.currentTarget);
          onClearStale();
          focusAfterRender(target);
        }}
      >
        clear stale ({staleCount})
      </button>
    </div>
  );
}
