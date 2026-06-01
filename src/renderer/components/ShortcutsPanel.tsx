/* ============================================================
 * Loom — Keyboard Shortcuts panel (FR-54 / WCAG 2.2 AA)
 * ------------------------------------------------------------
 * An accessible MODAL dialog for viewing + rebinding the 7
 * customizable commands. It is the ONLY UI that mutates the
 * keybindings; the App dispatcher merely reads the resolved map.
 *
 * ACCESSIBILITY (WCAG 2.2 AA):
 *   - role="dialog" + aria-modal="true" + aria-labelledby the title
 *     ("Keyboard Shortcuts"), rendered over a backdrop.
 *   - FOCUS TRAP: Tab/Shift+Tab cycle within the dialog; focus moves
 *     to the dialog on open and RETURNS to the opener on close
 *     (SC 2.4.3 / 2.1.2). The trap enumerates focusables via
 *     getClientRects() (robust for position:fixed; A11Y-SC-04).
 *   - A polite live region announces capture-armed/combo/commit/conflict/
 *     reset to assistive tech regardless of focus location (SC 4.1.3 /
 *     A11Y-SC-01 / UX-07).
 *   - On conflict, focus moves to the primary Reassign button and the
 *     alert spells out BOTH the collision AND the consequence of each
 *     choice (SC 2.4.3 / 3.3.3 / 4.1.2 — A11Y-SC-03 / UX-01 / UX-02).
 *   - Escape closes the dialog (returning focus to the opener) — but
 *     while a row is CAPTURING a new combo, Escape CANCELS the capture
 *     and the dialog stays open (the capture owns the key). Escape is
 *     still ASSIGNABLE: capturing it stages a confirm step (KB-4).
 *   - Every control is a real <button> with a visible :focus-visible
 *     ring; dark + light themed; honors prefers-reduced-motion via the
 *     global CSS override.
 *
 * CAPTURE MODE: clicking a row (or its Edit button) arms a listener for
 * the next key combo. A pure-modifier press (Ctrl alone, etc.) is
 * ignored (isValidBinding === false) so the user can hold modifiers.
 * A valid combo is assigned; if it collides with another command, or is
 * RESERVED by the app shell (the Ctrl/Cmd+Comma opener), a LIVE warning
 * is surfaced. Reassign moves the captured combo to the new command and
 * resolves the displaced command without ever leaving two commands on
 * one key (planReassign; KB-3) — re-opening capture for the displaced
 * command when its default would re-collide. Reset-to-defaults requires
 * an inline confirm and announces the result (UX-03 / UX-07).
 *
 * PERSISTENCE: changes are committed through `onPersist(resolvedMap)`
 * (wired to store.setKeybindings in App), which writes the SPARSE
 * override map (only entries differing from defaults). We pass the FULL
 * resolved map and let the store diff it (documented in client.ts).
 * ============================================================ */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import {
  COMMANDS,
  DEFAULT_BINDINGS,
  RESERVED_COMBOS,
  eventToCombo,
  findConflict,
  formatCombo,
  isPlatformCritical,
  isReserved,
  isValidBinding,
  planReassign,
  resolveBindings,
} from '../lib/keybindings.js';
import type { CommandId } from '../lib/keybindings.js';

export interface ShortcutsPanelProps {
  /** Resolved current bindings (commandId -> canonical combo). */
  bindings: Record<string, string>;
  /** Persist the new RESOLVED bindings map (App wires store.setKeybindings,
   *  which diffs to the sparse override map). */
  onPersist(resolved: Record<string, string>): void;
  /** Close the dialog AND return focus to the opener (App owns the state). */
  onClose(): void;
}

/** Pencil glyph for the per-row edit affordance. Decorative — the
 *  accessible name comes from the wrapping button's aria-label. */
function EditIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

/** Selector for every tabbable control inside the dialog (focus trap). */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** True when an element is currently rendered/laid-out (has client rects) OR
 *  is the active element. Robust for position:fixed / sticky controls where
 *  offsetParent is null (A11Y-SC-04). */
function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 || el === document.activeElement;
}

/** The canonical display string for the fixed (non-rebindable) opener — the
 *  single reserved combo (UX-04). */
const OPENER_COMBO = Array.from(RESERVED_COMBOS)[0] ?? 'Ctrl+,';

/** Human label for a command id, with a defensive fallback so the conflict
 *  sentence is always grammatical (UX-06). */
function labelFor(id: CommandId | null): string {
  if (!id) return 'another command';
  return COMMANDS.find((c) => c.id === id)?.label ?? 'another command';
}

export function ShortcutsPanel({
  bindings,
  onPersist,
  onClose,
}: ShortcutsPanelProps): JSX.Element {
  const titleId = useId();
  const hintId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // The control to focus on open (the first row's edit button); on close
  // App restores the opener focus, so we don't track the opener here.
  const firstFocusRef = useRef<HTMLButtonElement | null>(null);
  // The primary Reassign button — focused when a conflict is surfaced so the
  // recovery controls are immediately operable (A11Y-SC-03 / UX-01).
  const reassignBtnRef = useRef<HTMLButtonElement | null>(null);

  // Working copy of the resolved bindings — edited locally, persisted on
  // every committed change so it survives a re-open and reaches main.
  const [working, setWorking] = useState<Record<string, string>>(() =>
    resolveBindings(bindings),
  );
  // The command id currently CAPTURING a new combo, or null.
  const [capturingId, setCapturingId] = useState<CommandId | null>(null);
  // The live (in-progress) combo string shown while capturing, or ''.
  const [liveCombo, setLiveCombo] = useState('');
  // A pending VALID combo that conflicts with another command — drives the
  // reassign/cancel warning. null when no conflict is pending.
  const [pendingConflict, setPendingConflict] = useState<{
    id: CommandId;
    combo: string;
    conflictWith: CommandId;
  } | null>(null);
  // A pending REJECTED combo (reserved by the app shell) — drives a hard-block
  // warning with only a Cancel affordance (KB-2). null when none.
  const [pendingReserved, setPendingReserved] = useState<{
    id: CommandId;
    combo: string;
  } | null>(null);
  // A staged Escape (or Escape-containing) combo awaiting a deliberate confirm
  // so Escape stays ASSIGNABLE without losing the cancel escape-hatch (KB-4).
  const [pendingEscape, setPendingEscape] = useState<{
    id: CommandId;
    combo: string;
  } | null>(null);
  // Inline reset-to-defaults confirmation state (UX-03).
  const [confirmingReset, setConfirmingReset] = useState(false);
  // Polite live-region message for AT (capture/commit/conflict/reset). The
  // single source of spoken status; cleared by callers as state changes
  // (A11Y-SC-01 / UX-07).
  const [liveMsg, setLiveMsg] = useState('');

  // Refs to each row's edit button so we can restore focus after a capture
  // ends (the row stays mounted, so this is the natural landing spot).
  const editButtonRefs = useRef<Map<CommandId, HTMLButtonElement>>(new Map());
  // Timer that clears the transient reset/commit announcement.
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Announce a polite message, auto-clearing transient ones after a beat.
  const announce = useCallback((msg: string, transient = false): void => {
    if (msgTimer.current) {
      clearTimeout(msgTimer.current);
      msgTimer.current = null;
    }
    setLiveMsg(msg);
    if (transient && msg) {
      msgTimer.current = setTimeout(() => setLiveMsg(''), 4000);
    }
  }, []);
  useEffect(
    () => () => {
      if (msgTimer.current) clearTimeout(msgTimer.current);
    },
    [],
  );

  // Commit a change to the working map AND persist it through the store.
  const commit = useCallback(
    (next: Record<string, string>): void => {
      setWorking(next);
      onPersist(next);
    },
    [onPersist],
  );

  // Focus the dialog's first control on mount (open). The trap + Escape are
  // wired below. App restores opener focus on unmount/close.
  useEffect(() => {
    // Defer to after paint so the element exists + layout is settled.
    const raf = requestAnimationFrame(() => firstFocusRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  const stopCapture = useCallback((focusId: CommandId | null): void => {
    setCapturingId(null);
    setLiveCombo('');
    setPendingConflict(null);
    setPendingReserved(null);
    setPendingEscape(null);
    if (focusId) {
      requestAnimationFrame(() => editButtonRefs.current.get(focusId)?.focus());
    }
  }, []);

  const beginCapture = useCallback(
    (id: CommandId): void => {
      setPendingConflict(null);
      setPendingReserved(null);
      setPendingEscape(null);
      setLiveCombo('');
      setConfirmingReset(false);
      setCapturingId(id);
      announce(
        `Recording new shortcut for ${labelFor(id)}. Press a key combination, or press Escape to cancel.`,
      );
    },
    [announce],
  );

  // Assign a valid combo to the capturing command, handling reserved combos
  // (hard block) and conflicts (reassign/cancel).
  const assignCombo = useCallback(
    (id: CommandId, combo: string): void => {
      // The app-shell opener is reserved — refuse and explain (KB-2).
      if (isReserved(combo)) {
        setPendingReserved({ id, combo });
        setLiveCombo(combo);
        announce(
          `${formatCombo(combo)} is reserved for opening Keyboard Shortcuts and cannot be assigned. Press another key combination, or press Escape to cancel.`,
        );
        return;
      }
      const conflictWith = findConflict(working, combo, id);
      if (conflictWith !== null) {
        // Surface the live conflict warning; do NOT assign yet.
        setPendingConflict({ id, combo, conflictWith });
        setLiveCombo(combo);
        const otherDefault = DEFAULT_BINDINGS[conflictWith];
        announce(
          `${formatCombo(combo)} is already bound to ${labelFor(conflictWith)}. ` +
            `Reassign it to ${labelFor(id)}? ${labelFor(conflictWith)} will revert to its default, ${formatCombo(otherDefault)}. ` +
            `Use the Reassign or Cancel buttons.`,
        );
        return;
      }
      const next = { ...working, [id]: combo };
      commit(next);
      const warn = isPlatformCritical(combo)
        ? ` Note: ${formatCombo(combo)} may override a system shortcut.`
        : '';
      announce(`${labelFor(id)} set to ${formatCombo(combo)}.${warn}`, true);
      stopCapture(id);
    },
    [working, commit, stopCapture, announce],
  );

  // Reassign the pending combo to the new command WITHOUT ever producing a
  // duplicate binding (KB-3 / UX-02). The displaced command falls back to its
  // default when that is free; otherwise it is VACATED and capture re-opens
  // for it so the user picks a fresh key.
  const reassignPending = useCallback((): void => {
    if (!pendingConflict) return;
    const { id, combo, conflictWith } = pendingConflict;
    const plan = planReassign(working, id, combo, conflictWith);
    commit(plan.next);
    if (plan.displacedNeedsRebind) {
      // The displaced command's default would re-collide — prompt for a fresh
      // key instead of shipping a still-conflicted state (KB-3).
      setPendingConflict(null);
      setPendingReserved(null);
      setPendingEscape(null);
      setLiveCombo('');
      setCapturingId(conflictWith);
      announce(
        `${labelFor(id)} now uses ${formatCombo(combo)}. ${labelFor(conflictWith)} needs a new shortcut — ` +
          `press a key combination, or press Escape to cancel.`,
      );
      return;
    }
    announce(
      `${labelFor(id)} set to ${formatCombo(combo)}. ` +
        `${labelFor(conflictWith)} reverted to its default, ${formatCombo(plan.displacedCombo ?? '')}.`,
      true,
    );
    stopCapture(id);
  }, [pendingConflict, working, commit, stopCapture, announce]);

  // Cancel only the pending conflict/reserved warning (stay in capture for
  // that row so the user can pick a different key), keeping the dialog open.
  const cancelPending = useCallback((): void => {
    const id = capturingId;
    setPendingConflict(null);
    setPendingReserved(null);
    setPendingEscape(null);
    setLiveCombo('');
    announce(
      id
        ? `Cancelled. Press a key combination for ${labelFor(id)}, or press Escape to cancel.`
        : '',
    );
  }, [capturingId, announce]);

  // Commit a staged Escape (or Escape-containing) combo (KB-4).
  const confirmEscape = useCallback((): void => {
    if (!pendingEscape) return;
    const { id, combo } = pendingEscape;
    setPendingEscape(null);
    assignCombo(id, combo);
  }, [pendingEscape, assignCombo]);

  const resetDefaults = useCallback((): void => {
    const next = { ...DEFAULT_BINDINGS } as Record<string, string>;
    commit(next);
    stopCapture(null);
    setConfirmingReset(false);
    announce('Shortcuts reset to defaults.', true);
  }, [commit, stopCapture, announce]);

  // Dialog-level key handling: the capture listener (when a row is armed),
  // the focus trap (Tab / Shift+Tab), and Escape (cancel capture, else close).
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      // CAPTURE MODE owns the keyboard while armed.
      if (capturingId !== null) {
        // While a conflict / reserved / escape-confirm prompt is up, its
        // buttons own interaction; allow only Tab (reach the buttons) and a
        // BARE Escape (cancel the prompt / capture). Everything else is inert.
        if (
          pendingConflict !== null ||
          pendingReserved !== null ||
          pendingEscape !== null
        ) {
          if (
            e.key === 'Escape' &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            !e.shiftKey
          ) {
            // A bare Escape while a prompt is up is the universal escape hatch:
            // it cancels capture entirely (dialog stays open). The Reassign /
            // Assign / Cancel / OK buttons remain the way to ACT on the prompt,
            // so the user is never trapped (KB-4 / UX-01).
            e.preventDefault();
            e.stopPropagation();
            stopCapture(capturingId);
            announce('Capture cancelled.', true);
            return;
          }
          // Any other key is inert while a prompt is up — but do NOT
          // preventDefault, so Enter / Space still ACTIVATE the focused
          // Reassign / Assign / Cancel / OK button natively.
          if (e.key !== 'Tab') return;
          // fall through to the focus trap for Tab
        } else {
          const combo = eventToCombo(e);
          e.preventDefault();
          // A pure-modifier press is not yet a valid binding — show it live
          // but do not assign (the user is still holding modifiers).
          if (!isValidBinding(combo)) {
            setLiveCombo(combo);
            return;
          }
          // A bare Escape cancels capture (the universal escape hatch). Any
          // OTHER Escape-containing combo, or Escape staged via a deliberate
          // confirm, remains ASSIGNABLE (KB-4).
          if (combo === 'Escape') {
            e.stopPropagation();
            setPendingEscape({ id: capturingId, combo });
            setLiveCombo(combo);
            announce(
              `Press Assign to bind Escape to ${labelFor(capturingId)}, or press Escape again to cancel.`,
            );
            return;
          }
          assignCombo(capturingId, combo);
          return;
        }
      }

      // Escape (not capturing) closes the dialog + returns focus to opener.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      // FOCUS TRAP: keep Tab focus inside the dialog (SC 2.4.3 / 2.1.2).
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
        ).filter(isVisible);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !dialog.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !dialog.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [
      capturingId,
      pendingConflict,
      pendingReserved,
      pendingEscape,
      assignCombo,
      stopCapture,
      announce,
      onClose,
    ],
  );

  // When a conflict or an Escape-confirm prompt is surfaced, move focus to its
  // primary action button so the alert is announced AND the recovery controls
  // are operable immediately (A11Y-SC-03 / UX-01 / KB-4). Both prompts share
  // reassignBtnRef (only one can be mounted at a time). Runs after paint so the
  // button exists.
  useEffect(() => {
    if (pendingConflict !== null || pendingEscape !== null) {
      const raf = requestAnimationFrame(() => reassignBtnRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [pendingConflict, pendingEscape]);

  // Clicking the backdrop closes the dialog (a standard modal affordance).
  const onBackdropMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      if (e.target === e.currentTarget && capturingId === null) onClose();
    },
    [onClose, capturingId],
  );

  return (
    <div
      className="sc-backdrop"
      onMouseDown={onBackdropMouseDown}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
      onKeyDown={onKeyDown}
    >
      <div
        className="sc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        ref={dialogRef}
      >
        {/* Polite live region — announces capture/commit/conflict/reset to AT
            regardless of focus location (A11Y-SC-01 / A11Y-SC-02 / UX-07). */}
        <div className="sc-sr-live" role="status" aria-live="polite" aria-atomic="true">
          {liveMsg}
        </div>

        <div className="sc-head">
          <h2 className="sc-title" id={titleId}>
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            className="iconbtn sc-close"
            aria-label="Close keyboard shortcuts"
            title="Close (Esc)"
            onClick={onClose}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="sc-hint" id={hintId}>
          Click a shortcut to rebind it, then press the new key combination.
          Modifier-only presses (e.g. just Ctrl) are ignored until you add a
          key. Click the same shortcut again, or press Escape, to cancel.
        </p>

        <ul className="sc-list" role="list">
          {COMMANDS.map((cmd, idx) => {
            const id = cmd.id;
            const capturing = capturingId === id;
            const isConflicting =
              pendingConflict !== null && pendingConflict.id === id;
            const isReservedRow =
              pendingReserved !== null && pendingReserved.id === id;
            const isEscapeRow =
              pendingEscape !== null && pendingEscape.id === id;
            const current = working[id] ?? DEFAULT_BINDINGS[id];
            // A VACATED command (combo === '' after a re-colliding reassign,
            // KB-3) shows its default as the resolved fallback.
            const shown =
              current && isValidBinding(current) ? current : DEFAULT_BINDINGS[id];
            const display = capturing
              ? liveCombo
                ? formatCombo(liveCombo)
                : 'Press keys…'
              : formatCombo(shown);
            const conflictName = isConflicting
              ? labelFor(pendingConflict!.conflictWith)
              : null;
            const otherDefault = isConflicting
              ? DEFAULT_BINDINGS[pendingConflict!.conflictWith]
              : '';
            // The capturing-state description for AT — wires the chip to the
            // recording cue so it is not conveyed by color alone (A11Y-SC-02).
            const captureHintId = `sc-capture-hint-${id}`;
            return (
              <li className="sc-row" key={id}>
                <span className="sc-row-label" id={`sc-label-${id}`}>
                  {cmd.label}
                </span>
                <button
                  type="button"
                  ref={(el) => {
                    if (idx === 0) firstFocusRef.current = el;
                    if (el) editButtonRefs.current.set(id, el);
                    else editButtonRefs.current.delete(id);
                  }}
                  className={'sc-binding' + (capturing ? ' capturing' : '')}
                  aria-labelledby={`sc-label-${id}`}
                  aria-describedby={
                    capturing
                      ? `sc-binding-val-${id} ${captureHintId}`
                      : `sc-binding-val-${id}`
                  }
                  // aria-pressed conveys the armed/capturing state to AT.
                  aria-pressed={capturing}
                  onClick={() =>
                    capturing ? stopCapture(id) : beginCapture(id)
                  }
                >
                  {capturing && (
                    <span className="sc-rec" aria-hidden="true">
                      <span className="sc-rec-dot" />
                      Recording
                    </span>
                  )}
                  <span className="sc-combo" id={`sc-binding-val-${id}`}>
                    {display}
                  </span>
                  <span className="sc-edit-glyph" aria-hidden="true">
                    <EditIcon />
                  </span>
                </button>
                {capturing && (
                  <span id={captureHintId} className="sc-sr-live">
                    Recording. Press a key combination, or press Escape to
                    cancel.
                  </span>
                )}
                {isConflicting && pendingConflict && (
                  <div className="sc-conflict" role="alert">
                    <span className="sc-conflict-text">
                      {formatCombo(pendingConflict.combo)} is already bound to{' '}
                      <b>{conflictName}</b>. Reassign it to{' '}
                      <b>{cmd.label}</b>? <b>{conflictName}</b> will revert to
                      its default, <b>{formatCombo(otherDefault)}</b>.
                    </span>
                    <span className="sc-conflict-actions">
                      <button
                        type="button"
                        className="sc-btn sc-btn-primary"
                        ref={reassignBtnRef}
                        onClick={reassignPending}
                      >
                        Reassign
                      </button>
                      <button
                        type="button"
                        className="sc-btn"
                        onClick={cancelPending}
                      >
                        Cancel
                      </button>
                    </span>
                  </div>
                )}
                {isReservedRow && pendingReserved && (
                  <div className="sc-conflict" role="alert">
                    <span className="sc-conflict-text">
                      {formatCombo(pendingReserved.combo)} is reserved for
                      opening this Keyboard Shortcuts panel and cannot be
                      assigned. Press a different key combination.
                    </span>
                    <span className="sc-conflict-actions">
                      <button
                        type="button"
                        className="sc-btn sc-btn-primary"
                        onClick={cancelPending}
                      >
                        OK
                      </button>
                    </span>
                  </div>
                )}
                {isEscapeRow && pendingEscape && (
                  <div className="sc-conflict" role="alert">
                    <span className="sc-conflict-text">
                      Bind <b>Escape</b> to <b>{cmd.label}</b>?
                    </span>
                    <span className="sc-conflict-actions">
                      <button
                        type="button"
                        className="sc-btn sc-btn-primary"
                        ref={reassignBtnRef}
                        onClick={confirmEscape}
                      >
                        Assign
                      </button>
                      <button
                        type="button"
                        className="sc-btn"
                        onClick={cancelPending}
                      >
                        Cancel
                      </button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}

          {/* Read-only reference to the fixed (non-rebindable) opener so a
              keyboard-first user can discover it from inside the panel
              (UX-04). No edit affordance / capture behavior. */}
          <li className="sc-row sc-row-fixed">
            <span className="sc-row-label" id="sc-label-opener">
              Open Keyboard Shortcuts
            </span>
            <span
              className="sc-binding sc-binding-fixed"
              aria-labelledby="sc-label-opener"
            >
              <span className="sc-combo">{formatCombo(OPENER_COMBO)}</span>
            </span>
          </li>
        </ul>

        <div className="sc-foot">
          {confirmingReset ? (
            <span className="sc-reset-confirm" role="group" aria-label="Confirm reset">
              <span className="sc-reset-q">Reset all shortcuts to defaults?</span>
              <button
                type="button"
                className="sc-btn sc-btn-danger"
                onClick={resetDefaults}
              >
                Reset
              </button>
              <button
                type="button"
                className="sc-btn"
                onClick={() => {
                  setConfirmingReset(false);
                  announce('Reset cancelled.', true);
                }}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="sc-btn sc-btn-reset"
              onClick={() => {
                stopCapture(capturingId);
                setConfirmingReset(true);
              }}
            >
              Reset to defaults
            </button>
          )}
          <button
            type="button"
            className="sc-btn sc-btn-primary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
