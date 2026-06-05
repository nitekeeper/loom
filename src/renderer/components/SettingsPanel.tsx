/* ============================================================
 * Loom — Settings panel (FR-54 / WCAG 2.2 AA)
 * ------------------------------------------------------------
 * An accessible MODAL dialog for the app's user-facing preferences. It is the
 * entry point reached from the StatusBar gear; the Keyboard Shortcuts panel
 * stays a SEPARATE modal (reachable from here AND directly via Ctrl/Cmd+,).
 *
 * Three grouped sections:
 *   1. Viewer → Reading width — a real radio group (fieldset/legend) toggling
 *      the RENDERED (.md) reading column between the predefined 792px measure
 *      ('fit', the default) and full Viewer width ('full').
 *   2. Appearance → Theme — reflects the live theme and sets it BY VALUE
 *      (ADDITIVE; the StatusBar theme toggle stays). A 2-radio Light/Dark group
 *      so the current value is visible and either can be selected directly.
 *   3. Keyboard Shortcuts — a button that opens the Keyboard Shortcuts panel,
 *      with the fixed Ctrl/Cmd+, opener combo shown as a hint.
 *
 * ACCESSIBILITY (WCAG 2.2 AA) — mirrors ShortcutsPanel EXACTLY:
 *   - role="dialog" + aria-modal="true" + aria-labelledby the title
 *     ("Settings"), rendered over a backdrop.
 *   - FOCUS TRAP: Tab/Shift+Tab cycle within the dialog; focus moves to the
 *     first control on open and RETURNS to the opener on close (App owns the
 *     restore, mirroring closeShortcuts — SC 2.4.3 / 2.1.2). The trap enumerates
 *     focusables via the shared FOCUSABLE selector + getClientRects() isVisible
 *     helper (robust for position:fixed — A11Y-SC-04).
 *   - Escape closes the dialog (App returns focus to the opener).
 *   - Backdrop-mousedown closes (a standard modal affordance).
 *   - A polite live region announces a width/theme change to AT regardless of
 *     focus location (SC 4.1.3).
 *   - Every control is a real <input type="radio"> / <button> with a visible
 *     :focus-visible ring; dark + light themed; honors prefers-reduced-motion
 *     via the global CSS override.
 *
 * SECURITY (Law 1): the width value stays a closed 'fit'|'full' enum used only
 * to drive a data-attribute (in the Viewer); the theme stays the existing store
 * path; this panel renders only static, escaped React content — NO HTML sink.
 * ============================================================ */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type { WidthMode } from '../lib/md-width.js';
import type { Theme } from '../../shared/types.js';

export interface SettingsPanelProps {
  /** Current RENDERED-markdown reading-column width mode. */
  mdWidth: WidthMode;
  /** Persist + apply the chosen reading-column width mode (App lifts the state
   *  and writes it through md-width.ts). */
  onMdWidthChange(mode: WidthMode): void;
  /** Current theme — reflected by the Appearance radios. */
  theme: Theme;
  /** Select a specific theme (App wires the existing store.setTheme path). The
   *  radio's VALUE drives the store directly, so the control stays authoritative
   *  and scales past two themes (a binary toggle would desync if a third theme
   *  were ever added). ADDITIVE: the StatusBar theme toggle stays a control too. */
  onSelectTheme(next: Theme): void;
  /** Open the Keyboard Shortcuts panel (App closes Settings first, then opens
   *  it returning focus to the gear on close). */
  onOpenShortcuts(): void;
  /** Close the dialog AND return focus to the opener (App owns the state). */
  onClose(): void;
}

/** Selector for every tabbable control inside the dialog (focus trap). Shared
 *  verbatim with ShortcutsPanel so the two modals trap identically. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** True when an element is currently rendered/laid-out (has client rects) OR
 *  is the active element. Robust for position:fixed / sticky controls where
 *  offsetParent is null (A11Y-SC-04). Mirrors ShortcutsPanel.isVisible. */
function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 || el === document.activeElement;
}

/** The canonical display string for the fixed (non-rebindable) Keyboard
 *  Shortcuts opener combo, shown as a hint beside its "Open" button (UX-04). */
const OPENER_COMBO = 'Ctrl/Cmd+,';

export function SettingsPanel({
  mdWidth,
  onMdWidthChange,
  theme,
  onSelectTheme,
  onOpenShortcuts,
  onClose,
}: SettingsPanelProps): JSX.Element {
  const titleId = useId();
  // A short orientation line wired via aria-describedby — mirrors ShortcutsPanel's
  // dialog description so a screen reader announces the panel's PURPOSE on open,
  // not just the name "Settings" plus the focused radio (parity / SC 4.1.2).
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Polite live-region message for AT (width/theme change). Cleared by callers
  // as state changes; auto-cleared after a beat for transient ones.
  const [liveMsg, setLiveMsg] = useState('');
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Announce a polite message, auto-clearing transient ones after a beat
  // (mirrors ShortcutsPanel.announce).
  const announce = useCallback((msg: string): void => {
    if (msgTimer.current) {
      clearTimeout(msgTimer.current);
      msgTimer.current = null;
    }
    setLiveMsg(msg);
    if (msg) {
      msgTimer.current = setTimeout(() => setLiveMsg(''), 4000);
    }
  }, []);
  useEffect(
    () => () => {
      if (msgTimer.current) clearTimeout(msgTimer.current);
    },
    [],
  );

  // Focus the dialog's first control on open: the reading-width radio matching
  // the CURRENT selection (so focus lands on the user's actual value, not an
  // unchecked option). Query the live :checked radio inside the effect rather
  // than via per-render conditional ref callbacks — the query reads the DOM's
  // authoritative state once, with no fragile cross-render ref bookkeeping.
  // mdWidth is a closed enum so exactly one radio is always checked; the
  // :focus-visible ring + native arrow-key roving then carry the user through.
  // App restores opener focus on unmount/close. Deferred to after paint so the
  // element exists + layout is settled.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLInputElement>('input[name="set-md-width"]:checked')
        ?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Select a reading-width mode (no-op when already chosen so we don't announce
  // a non-change on a re-click of the checked radio).
  const selectWidth = useCallback(
    (mode: WidthMode): void => {
      if (mode === mdWidth) return;
      onMdWidthChange(mode);
      announce(
        mode === 'full'
          ? 'Reading width set to full width.'
          : 'Reading width set to fixed, 792 pixels.',
      );
    },
    [mdWidth, onMdWidthChange, announce],
  );

  // Select a theme (no-op when already active). The store owns the persistence;
  // we drive it by VALUE (onSelectTheme) so the radio's value sets the store
  // directly — no reliance on a binary toggle's involutive behavior, and it
  // scales past two themes.
  const selectTheme = useCallback(
    (next: Theme): void => {
      if (next === theme) return;
      onSelectTheme(next);
      announce(next === 'dark' ? 'Dark theme selected.' : 'Light theme selected.');
    },
    [theme, onSelectTheme, announce],
  );

  // Dialog-level key handling: the focus trap (Tab / Shift+Tab) and Escape
  // (close). Mirrors ShortcutsPanel's onKeyDown, minus the capture mode (this
  // panel has no key-capture rows).
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      // Escape closes the dialog + returns focus to the opener (App owns that).
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
    [onClose],
  );

  // Clicking the backdrop closes the dialog (a standard modal affordance).
  const onBackdropMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div
      className="sc-backdrop"
      onMouseDown={onBackdropMouseDown}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
      onKeyDown={onKeyDown}
    >
      {/* Reuse the shared modal shell (.sc-dialog) for visual parity with the
          Shortcuts panel; the stable "settings-dialog" class lets the e2e target
          this dialog unambiguously vs the shortcuts one. */}
      <div
        className="sc-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        ref={dialogRef}
      >
        {/* Polite live region — announces width/theme changes to AT regardless
            of focus location (SC 4.1.3). */}
        <div className="sc-sr-live" role="status" aria-live="polite" aria-atomic="true">
          {liveMsg}
        </div>

        <div className="sc-head">
          <h2 className="sc-title" id={titleId}>
            Settings
          </h2>
          <button
            type="button"
            className="iconbtn sc-close"
            aria-label="Close settings"
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

        {/* A short orientation line (referenced by the dialog's aria-describedby)
            so AT announces the panel's purpose on open, mirroring the Shortcuts
            panel's instructions paragraph (parity / SC 4.1.2). Reuses .sc-hint
            for visual + spacing parity with that panel. */}
        <p className="sc-hint" id={descId}>
          Adjust the reading width, appearance, and keyboard settings.
        </p>

        <div className="set-body">
          {/* --- Viewer → Reading width --------------------------------------
              A real radio group: a <fieldset> whose <legend> ("Reading width")
              is the group's accessible name, with TWO native radios whose
              visible labels ARE their accessible names ("Fixed (792px)" /
              "Full width"). The platform handles roving focus + arrow-key
              selection; changing the selection lifts to App. */}
          {/* Plain section WITHOUT an accessible name: a named <section> becomes
              a `region` landmark, which here would just duplicate the visible
              <h3> and clutter landmark navigation. The heading carries the
              structure (mirrors ShortcutsPanel, which uses headings, not
              per-block regions). */}
          <section className="set-section">
            <h3 className="set-section-title">Viewer</h3>
            <fieldset className="set-fieldset">
              <legend className="set-legend">Reading width</legend>
              <div className="set-row">
                <label className="set-radio">
                  <input
                    type="radio"
                    name="set-md-width"
                    value="fit"
                    checked={mdWidth === 'fit'}
                    onChange={() => selectWidth('fit')}
                  />
                  <span>Fixed (792px)</span>
                </label>
                <label className="set-radio">
                  <input
                    type="radio"
                    name="set-md-width"
                    value="full"
                    checked={mdWidth === 'full'}
                    onChange={() => selectWidth('full')}
                  />
                  <span>Full width</span>
                </label>
              </div>
            </fieldset>
          </section>

          {/* --- Appearance → Theme -------------------------------------------
              Reflects the live theme and lets either value be selected directly.
              ADDITIVE: the StatusBar theme toggle stays the canonical control;
              both write through the same store path. */}
          <section className="set-section">
            <h3 className="set-section-title">Appearance</h3>
            <fieldset className="set-fieldset">
              <legend className="set-legend">Theme</legend>
              <div className="set-row">
                <label className="set-radio">
                  <input
                    type="radio"
                    name="set-theme"
                    value="light"
                    checked={theme === 'light'}
                    onChange={() => selectTheme('light')}
                  />
                  <span>Light</span>
                </label>
                <label className="set-radio">
                  <input
                    type="radio"
                    name="set-theme"
                    value="dark"
                    checked={theme === 'dark'}
                    onChange={() => selectTheme('dark')}
                  />
                  <span>Dark</span>
                </label>
              </div>
            </fieldset>
          </section>

          {/* --- Keyboard Shortcuts -------------------------------------------
              A real button that opens the (separate) Keyboard Shortcuts panel,
              with the fixed Ctrl/Cmd+, opener combo shown as a discoverable
              hint beside it (UX-04). */}
          <section className="set-section">
            <h3 className="set-section-title">Keyboard Shortcuts</h3>
            <div className="set-section-row">
              <button
                type="button"
                className="sc-btn"
                aria-haspopup="dialog"
                onClick={onOpenShortcuts}
              >
                Open Keyboard Shortcuts…
              </button>
              <span className="set-hint">{OPENER_COMBO}</span>
            </div>
          </section>
        </div>

        <div className="sc-foot">
          {/* Spacer keeps the primary action right-aligned, matching the
              Shortcuts panel's space-between footer. */}
          <span />
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
