/* ============================================================
 * Loom — StatusBar chrome (FR-36, FR-37, AC-20)
 * ------------------------------------------------------------
 * Live-session state indicator (LIVE / PAUSED / CAUGHT_UP) with a
 * real PAUSE control that freezes the incoming feed (a legitimate
 * observer control — NOT the prototype's demo transport/replay/
 * speed, which are DROPPED). Shows REAL telemetry counters
 * (agents/channels/messages/receipts/files) from the DB + watcher,
 * and the theme toggle (persisted, FR-37/AC-20).
 *
 * Accessibility (FR-54, NFR-12): pause + theme toggle are real
 * <button>s, keyboard-operable, with focus-visible outlines; the
 * live dot honors prefers-reduced-motion via CSS. Each control
 * carries a text label (aria-label / aria-pressed) so state is not
 * conveyed by color alone.
 * ============================================================ */
import type { JSX } from 'react';
import type { LiveState, SessionCounters, Theme } from '../../shared/types.js';

export interface StatusBarProps {
  liveState: LiveState;
  counters: SessionCounters;
  theme: Theme;
  onTogglePause(): void;
  onToggleTheme(): void;
}

function SunIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function PauseIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function PlayIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5l12 7-12 7z" />
    </svg>
  );
}

const PILL_TEXT: Record<LiveState, string> = {
  LIVE: 'LIVE',
  PAUSED: 'PAUSED',
  CAUGHT_UP: 'CAUGHT UP',
};

export function StatusBar({
  liveState,
  counters,
  theme,
  onTogglePause,
  onToggleTheme,
}: StatusBarProps): JSX.Element {
  const paused = liveState === 'PAUSED';
  // Pill carries the .paused look for both PAUSED and CAUGHT_UP (steady dot);
  // LIVE gets the pulsing dot.
  const pillSteady = liveState !== 'LIVE';

  return (
    <div className="statusbar">
      <span
        className={'live-pill' + (pillSteady ? ' paused' : '')}
        role="status"
        aria-live="polite"
        aria-label={`Session ${PILL_TEXT[liveState]}`}
      >
        <span className="live-dot" aria-hidden="true" />
        {PILL_TEXT[liveState]}
      </span>

      <span className="stat-sep" aria-hidden="true" />

      <span className="stat">
        <b>{counters.agents}</b> agents
      </span>
      <span className="stat">
        <b>{counters.channels}</b> channels
      </span>
      <span className="stat">
        <b>{counters.messages}</b> messages
      </span>
      <span className="stat">
        <b>{counters.receipts}</b> receipts
      </span>
      <span className="stat">
        <b>{counters.files}</b> files written
      </span>

      <span className="grow" />

      <button
        type="button"
        className="iconbtn"
        onClick={onTogglePause}
        aria-pressed={paused}
        aria-label={paused ? 'Resume live feed' : 'Pause live feed'}
        title={paused ? 'Resume live feed' : 'Pause live feed'}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </button>

      <span className="stat-sep" aria-hidden="true" />

      <button
        type="button"
        className="iconbtn"
        onClick={onToggleTheme}
        aria-label={
          theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
        }
        title="Toggle theme"
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </div>
  );
}
