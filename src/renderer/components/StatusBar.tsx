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
import type { JSX, Ref } from 'react';
import type { LiveState, SessionCounters, Theme } from '../../shared/types.js';

export interface StatusBarProps {
  liveState: LiveState;
  counters: SessionCounters;
  theme: Theme;
  /** True when the Explorer pane is collapsed (drives the toggle's state). */
  explorerHidden: boolean;
  /** Collapse/expand the Explorer pane (also bound to Ctrl/Cmd+B in App).
   *  `viaKeyboard` lets App move focus into a re-shown Explorer only on a
   *  keyboard activation, never on a mouse click (UX-4). */
  onToggleExplorer(viaKeyboard?: boolean): void;
  /** Ref to the toggle <button> so App can restore focus when the Explorer
   *  collapses out from under the keyboard (no lost focus / no trap). */
  explorerToggleRef?: Ref<HTMLButtonElement>;
  /** True while the Changes viewer is open (drives the toggle's pressed state). */
  diffMode: boolean;
  /** Open/close the branch Changes viewer (also bound to Ctrl/Cmd+Shift+G). */
  onToggleDiff(): void;
  /** Ref to the Changes toggle <button> so App can restore focus on close. */
  diffToggleRef?: Ref<HTMLButtonElement>;
  /** Number of changed files on the branch, for the optional count chip; null
   *  until the listing is first fetched (or off a git repo). */
  changedCount: number | null;
  /** True when the Chat pane is collapsed (drives the chat toggle's state). */
  chatHidden: boolean;
  /** Collapse/expand the Chat pane (also bound to Ctrl/Cmd+J in App).
   *  `viaKeyboard` lets App move focus into a re-shown Chat only on a
   *  keyboard activation, never on a mouse click (UX-4). */
  onToggleChat(viaKeyboard?: boolean): void;
  /** Ref to the chat toggle <button> so App can restore focus when the Chat
   *  collapses out from under the keyboard (no lost focus / no trap). */
  chatToggleRef?: Ref<HTMLButtonElement>;
  /** True when the terminal dock is open (drives the toggle's state). */
  terminalOpen: boolean;
  /** Open/close the bottom terminal dock (also bound to Ctrl/Cmd+`). */
  onToggleTerminal(): void;
  /** Ref to the terminal toggle <button> so App can restore focus when the
   *  dock closes out from under the keyboard (no lost focus / no trap). */
  terminalToggleRef?: Ref<HTMLButtonElement>;
  onTogglePause(): void;
  onToggleTheme(): void;
  /** Open the Settings panel. (The Keyboard Shortcuts panel has its own fixed
   *  Ctrl/Cmd+Comma opener and is reachable from inside Settings.) */
  onOpenSettings(): void;
  /** Ref to the gear <button> so App can restore focus when the panel closes. */
  settingsButtonRef?: Ref<HTMLButtonElement>;
  /** True while the Settings panel is open (drives the gear's expanded cue). */
  settingsOpen: boolean;
}

/** Sidebar/panel glyph: a framed rectangle with a highlighted side column,
 *  the conventional "toggle side panel" affordance. The column FILLS when the
 *  Explorer is shown and is EMPTY (hollow) when collapsed, so the glyph itself
 *  signals open vs collapsed at a glance (UX-3) — not by tint alone. */
function SidebarIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      {/* Shown: the panel column is filled (solid). Collapsed: left empty so
          the panel reads as "off". A non-color, shape-based state cue. */}
      {!collapsed && (
        <rect
          x="3"
          y="4"
          width="6"
          height="16"
          rx="2"
          fill="currentColor"
          stroke="none"
        />
      )}
    </svg>
  );
}

/** Changes/diff glyph: a git branch — semantically mapping to "branch changes",
 *  visually distinct from the explorer PANEL rectangle and the chat speech
 *  bubble at 16px so the three left/right toggles can never be confused. The
 *  branch nodes FILL (solid) when the Changes viewer is open and are hollow
 *  outlines when closed, so the glyph itself signals open vs closed at a glance
 *  (UX-3) — a non-color, shape-based state cue, not tint alone. */
function DiffIcon({ open }: { open: boolean }): JSX.Element {
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
      {/* Three branch nodes connected by the fork lines. */}
      <circle cx="6" cy="6" r="2.5" fill={open ? 'currentColor' : 'none'} />
      <circle cx="6" cy="18" r="2.5" fill={open ? 'currentColor' : 'none'} />
      <circle cx="18" cy="8" r="2.5" fill={open ? 'currentColor' : 'none'} />
      <path d="M6 8.5v7" />
      <path d="M18 10.5a6 6 0 0 1-6 6H8.5" />
    </svg>
  );
}

/** Chat glyph: a speech bubble — semantically mapping to "agent chat" and
 *  instantly distinct from the file-explorer PANEL rectangle glyph at 16px, so
 *  the two toggles can never be confused (recognition over recall — UX-CHAT-01 /
 *  SC 1.3.1: identity not by position alone). The bubble FILLS (solid) when the
 *  Chat is shown and is an EMPTY outline (with two interior message-line strokes
 *  as a content cue) when collapsed, so the glyph itself signals open vs
 *  collapsed at a glance (UX-3) — a non-color, shape-based state cue, not tint
 *  alone. Both states draw at strokeWidth 2 in currentColor, so the visible
 *  outline meets the non-text-contrast minimum in the resting (collapsed/
 *  un-pressed) state regardless of the accent tint (A11Y-CHAT-03). */
function ChatBubbleIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
  // A rounded speech bubble with a small tail at the bottom-left.
  const bubble =
    'M4 5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16H9l-4 4v-4H4a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 5z';
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
      {/* Shown: a solid (filled) bubble. Collapsed: a hollow outline so the
          chat reads as "off". A non-color, shape-based state cue. */}
      <path d={bubble} fill={collapsed ? 'none' : 'currentColor'} />
      {/* Two short interior message lines — a content cue that makes the bubble
          unambiguously a CHAT glyph. Drawn only in the hollow (collapsed) state
          where the bubble interior is empty; in the filled state the solid body
          already reads as chat and lines on the fill would be invisible. */}
      {collapsed && (
        <>
          <line x1="7.5" y1="9.5" x2="16.5" y2="9.5" />
          <line x1="7.5" y1="12.5" x2="13" y2="12.5" />
        </>
      )}
    </svg>
  );
}

/** Terminal glyph: a framed prompt (`>` chevron + cursor underscore) — the
 *  conventional "terminal" affordance, instantly distinct from the chat
 *  bubble and the explorer panel rectangle at 16px. The frame FILLS when the
 *  dock is open (the prompt knocks out in the panel color via the accent-ink
 *  trick used by filled glyphs) and is a hollow outline when closed, so the
 *  glyph itself signals open vs closed at a glance (UX-3) — a non-color,
 *  shape-based state cue, not tint alone. */
function TerminalIcon({ open }: { open: boolean }): JSX.Element {
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
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        fill={open ? 'currentColor' : 'none'}
      />
      {/* Prompt chevron + cursor line. On the filled (open) frame they draw in
          the panel surface color so they stay visible against the fill. */}
      <g stroke={open ? 'var(--panel)' : 'currentColor'}>
        <path d="m7 9 3 3-3 3" />
        <line x1="12.5" y1="15" x2="17" y2="15" />
      </g>
    </svg>
  );
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

/** Gear/settings glyph — the conventional "settings" affordance, here the
 *  entry point to the Settings panel. Decorative; the accessible name comes
 *  from the button's aria-label. */
function GearIcon(): JSX.Element {
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
  explorerHidden,
  onToggleExplorer,
  explorerToggleRef,
  diffMode,
  onToggleDiff,
  diffToggleRef,
  changedCount,
  chatHidden,
  onToggleChat,
  chatToggleRef,
  terminalOpen,
  onToggleTerminal,
  terminalToggleRef,
  onTogglePause,
  onToggleTheme,
  onOpenSettings,
  settingsButtonRef,
  settingsOpen,
}: StatusBarProps): JSX.Element {
  const paused = liveState === 'PAUSED';
  // Pill carries the .paused look for both PAUSED and CAUGHT_UP (steady dot);
  // LIVE gets the pulsing dot.
  const pillSteady = liveState !== 'LIVE';

  return (
    <div className="statusbar">
      {/* Always visible in BOTH states so it can re-show a collapsed Explorer.
          A11Y-EXP-04: a true toggle button uses a STABLE name describing the
          thing toggled ("File explorer") + aria-pressed for the on/off state
          (pressed = shown). Mixing a flipping Show/Hide verb WITH aria-pressed
          double-encodes state and reads contradictorily ("Show… pressed").
          The flipping verb + Ctrl/Cmd+B hint stay in the visual tooltip. */}
      <button
        type="button"
        className="iconbtn"
        ref={explorerToggleRef}
        // A keyboard-activated button click reports detail===0 (no pointer
        // coordinates); a real mouse click reports detail>=1. Use that to
        // signal a keyboard activation so focus follows into a re-shown
        // Explorer only for keyboard users (UX-4).
        onClick={(e) => onToggleExplorer(e.detail === 0)}
        aria-pressed={!explorerHidden}
        aria-label="File explorer"
        title={
          (explorerHidden ? 'Show file explorer' : 'Hide file explorer') +
          ' (Ctrl/Cmd+B)'
        }
      >
        <SidebarIcon collapsed={explorerHidden} />
      </button>

      {/* Branch CHANGES toggle — a workspace-level view, so it sits in the LEFT
          cluster next to the explorer toggle. A true toggle button: STABLE name
          ("Changes") + aria-pressed for the open/closed state (A11Y-EXP-04); the
          shortcut hint lives in the visual tooltip only — the hard-coded DEFAULT
          (toggleChanges, now editable, default Ctrl/Cmd+Shift+G), like every peer
          toggle, so a rebind shows only in the Shortcuts panel row, not here. An
          optional changed-file count rides as a .badge-new chip (aria-hidden — the
          count is supplemental, the stable name never changes). */}
      <button
        type="button"
        className="iconbtn statusbar-changes-btn"
        ref={diffToggleRef}
        onClick={onToggleDiff}
        aria-pressed={diffMode}
        aria-label="Changes"
        title={
          (diffMode ? 'Hide changes on this branch' : 'Show changes on this branch') +
          ' (Ctrl/Cmd+Shift+G)'
        }
      >
        <DiffIcon open={diffMode} />
        {changedCount !== null && changedCount > 0 ? (
          <span className="badge-new statusbar-changes-count" aria-hidden="true">
            {changedCount}
          </span>
        ) : null}
      </button>

      <span className="stat-sep" aria-hidden="true" />

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

      {/* Chat-pane toggle — grouped on the RIGHT with the pause + theme icon
          buttons because the chat lives on the right edge of the body. A true
          toggle button: STABLE name ("Agent chat") + aria-pressed for the
          on/off state (pressed = shown). The flipping Show/Hide verb +
          Ctrl/Cmd+J hint live in the visual tooltip only (A11Y-EXP-04). */}
      <button
        type="button"
        className="iconbtn"
        ref={chatToggleRef}
        // A keyboard-activated button click reports detail===0 (no pointer
        // coordinates); a real mouse click reports detail>=1. Use that to
        // signal a keyboard activation so focus follows into a re-shown Chat
        // only for keyboard users (UX-4).
        onClick={(e) => onToggleChat(e.detail === 0)}
        aria-pressed={!chatHidden}
        aria-label="Agent chat"
        title={
          (chatHidden ? 'Show agent chat' : 'Hide agent chat') +
          ' (Ctrl/Cmd+J)'
        }
      >
        <ChatBubbleIcon collapsed={chatHidden} />
      </button>

      {/* Terminal-dock toggle — next to the chat toggle (both are body-pane
          visibility controls). A true toggle button: STABLE name ("Terminal")
          + aria-pressed for the open/closed state (A11Y-EXP-04); the shortcut
          hint lives in the visual tooltip only. */}
      <button
        type="button"
        className="iconbtn"
        ref={terminalToggleRef}
        onClick={onToggleTerminal}
        aria-pressed={terminalOpen}
        aria-label="Terminal"
        title="Toggle terminal (Ctrl/Cmd+`)"
      >
        <TerminalIcon open={terminalOpen} />
      </button>

      <span className="stat-sep" aria-hidden="true" />

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

      <span className="stat-sep" aria-hidden="true" />

      {/* Settings opener — a settings gear. aria-haspopup="dialog" signals it
          opens a modal; aria-expanded mirrors the Settings panel's open state.
          The ref lets App return focus here when the panel closes. Settings now
          has its OWN editable shortcut (the openSettings command, default
          Ctrl/Cmd+Shift+,) advertised in the title below — like every peer
          toggle the hint is a hard-coded DEFAULT (a rebind shows only in the
          Shortcuts panel row, not here, since no peer button threads the
          resolved binding through props); aria-keyshortcuts is still omitted to
          match that peer convention (title-only hints). */}
      <button
        type="button"
        className="iconbtn"
        ref={settingsButtonRef}
        onClick={onOpenSettings}
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        aria-label="Settings"
        title="Settings (Ctrl/Cmd+Shift+,)"
      >
        <GearIcon />
      </button>
    </div>
  );
}
