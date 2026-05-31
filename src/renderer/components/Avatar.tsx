/* ============================================================
 * Loom — Avatar (FR-46, NFR-12)
 * ------------------------------------------------------------
 * A colored initial chip with: an optional presence dot, an
 * optional unread badge, and a gone (dimmed) state. ACCESSIBILITY:
 * every avatar MUST carry an accompanying text label (initials are
 * non-unique, e.g. scout / scout-2 both render "S"), so the
 * component takes the full agent name and exposes it as aria-label.
 *
 * Non-color cues (NFR-12 / SC 1.4.1): the gone state is conveyed by
 * a dimming class AND a visually-hidden "(left)" suffix in the
 * label; presence/unread are mirrored in the same text label so a
 * screen reader (and a colorblind user reading the label) gets the
 * state without relying on color alone.
 * ============================================================ */
import type { JSX } from 'react';
import type { AgentStatus } from '../../shared/types.js';

export interface AvatarProps {
  name: string;
  status: AgentStatus;
  size?: number;
  showPresence?: boolean;
  unread?: number;
  /** When true the avatar is purely decorative (aria-hidden, no role=img):
   *  use this wherever the agent's visible name text sits immediately beside
   *  the avatar, so a screen reader announces the name ONCE rather than twice
   *  (A11Y-08). The avatar still conveys presence/unread visually. */
  decorative?: boolean;
}

/** Deterministic hue from the agent name so non-unique initials
 *  (e.g. "scout" vs "scout-2", both "S") get distinct, stable colors.
 *  Pure + side-effect free; safe for SSR / repeated renders. */
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  }
  const hue = h % 360;
  // Shared chroma/lightness, vary hue (mirrors loom.css agent hues).
  return `oklch(0.70 0.14 ${hue})`;
}

/** First character, uppercased. Empty-safe. */
export function avatarInitial(name: string): string {
  return (name.charAt(0) || '?').toUpperCase();
}

export function Avatar(props: AvatarProps): JSX.Element {
  const {
    name,
    status,
    size = 30,
    showPresence = false,
    unread = 0,
    decorative = false,
  } = props;
  const gone = status === 'gone';
  const fontSize = Math.round(size * 0.42);

  // Build a single descriptive label so the state is available as
  // TEXT (non-color cue) to assistive tech and colorblind users.
  const parts: string[] = [name];
  if (showPresence) parts.push(gone ? 'left the session' : 'online');
  if (unread > 0) parts.push(`${unread} unread`);
  const label = parts.join(', ');

  // A11Y-08: when decorative (a visible name sits beside us), hide from AT so
  // the name is announced once. Otherwise expose the full descriptive label.
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': label } as const);

  return (
    <span
      className={'avatar' + (gone ? ' gone' : '')}
      style={{
        width: size,
        height: size,
        background: avatarColor(name),
        fontSize,
        opacity: gone ? 0.55 : 1,
      }}
      {...a11y}
      title={name}
    >
      <span aria-hidden="true">{avatarInitial(name)}</span>
      {showPresence && (
        // Non-color cue: gone presence also carries a small glyph
        // distinct from the live dot (ring vs filled).
        <span className={'on' + (gone ? ' off' : '')} aria-hidden="true" />
      )}
      {unread > 0 && (
        <span className="unread-badge" aria-hidden="true">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </span>
  );
}
