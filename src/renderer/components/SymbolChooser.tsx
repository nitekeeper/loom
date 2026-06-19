/* ============================================================
 * Loom — Go to Definition KEYBOARD symbol chooser (overlay)
 * ------------------------------------------------------------
 * A11Y-GTD-01: the source view is non-editable and Loom does not enable caret
 * browsing, so a pure-keyboard user cannot position a text caret on a chosen
 * symbol. When F12 fires with NO caret/selection (the pure-keyboard path) on a
 * line that has MORE THAN ONE resolvable identifier, the CodeView surfaces all
 * of them and App shows THIS chooser so the keyboard user can pick WHICH symbol
 * — restoring parity with the pointer path (Ctrl/Cmd-click already targets a
 * single symbol). Picking a symbol then runs the normal go-to-definition flow.
 *
 * REUSE: this mirrors DefinitionPicker's overlay + a11y contract (modal
 * listbox, roving ArrowUp/Down, Enter/Space pick, Escape dismiss + restore
 * Viewer focus, Tab trap) and reuses its CSS classes (def-picker* +
 * search-results / search-match) so there is no new design system — the only
 * difference is each row is a SYMBOL name, not a resolved candidate, so there
 * is no lineText / no Law-1 escaped-slice highlighter to invoke (a symbol is a
 * single validated identifier rendered as plain text).
 *
 * ACCESSIBILITY (mirrors DefinitionPicker — GTD-A11Y-1/2):
 *   - DOM focus + keydown + aria-activedescendant ALL on the role=listbox.
 *   - the listbox is the single tab stop; Tab/Shift+Tab are trapped.
 *   - Escape dismisses with no action and App restores Viewer focus.
 *   - A11Y-1 (SC 3.3.2): the dialog's aria-describedby points at the
 *     operating-instructions hint (Enter goes to definition / Esc dismisses),
 *     mirroring ShortcutsPanel, so the action keys are announced on focus-in.
 * ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import type { SymbolChoice } from './Viewer.js';

export interface SymbolChooserProps {
  /** The 1-based line the identifiers live on (for the dialog's accessible name). */
  line: number;
  /** The resolvable identifiers on the line (always length > 1 when mounted). */
  choices: SymbolChoice[];
  /** Resolve the chosen symbol (closes the chooser + runs go-to-definition). */
  onPick(choice: SymbolChoice): void;
  /** Dismiss with NO action; App restores Viewer focus. */
  onClose(): void;
}

export function SymbolChooser({
  line,
  choices,
  onPick,
  onClose,
}: SymbolChooserProps): JSX.Element {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Clamp the active index if the choice set ever changes under us.
  useEffect(() => {
    setActive((i) => Math.max(0, Math.min(i, choices.length - 1)));
  }, [choices.length]);

  // Focus the LISTBOX on mount so arrows + aria-activedescendant work at once.
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // Keep the active option scrolled into view as selection moves.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-sym-index="${active}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      const key = e.key;
      if (key === 'Tab') {
        e.preventDefault();
        listRef.current?.focus();
        return;
      }
      if (key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, choices.length - 1));
        return;
      }
      if (key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        return;
      }
      if (key === 'Home') {
        e.preventDefault();
        setActive(0);
        return;
      }
      if (key === 'End') {
        e.preventDefault();
        setActive(choices.length - 1);
        return;
      }
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
        e.preventDefault();
        const c = choices[active];
        if (c) onPick(c);
        return;
      }
      if (key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
    },
    [active, choices, onPick, onClose],
  );

  const titleId = 'sym-chooser-title';
  const hintId = 'sym-chooser-hint';
  return (
    <div className="def-picker-scrim" onMouseDown={onClose}>
      <div
        className="def-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // A11Y-1 (SC 3.3.2): the operating-instructions hint is conveyed on
        // focus-in via aria-describedby, mirroring ShortcutsPanel.tsx:494 and
        // DefinitionPicker, so a screen-reader user learns Enter goes to the
        // definition / Esc dismisses without seeing the hint text.
        aria-describedby={hintId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="def-picker-head" id={titleId}>
          {choices.length} symbols on line {line} — pick one to go to its
          definition
        </div>
        <div
          className="search-results def-picker-list"
          role="listbox"
          aria-label={`Symbols on line ${line}`}
          aria-activedescendant={`sym-opt-${active}`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          ref={listRef}
        >
          {choices.map((c, i) => (
            <div
              key={`${c.symbol}:${c.col}:${i}`}
              id={`sym-opt-${i}`}
              data-sym-index={i}
              className={'search-match def-picker-row' + (i === active ? ' active' : '')}
              role="option"
              aria-selected={i === active}
              aria-label={`${c.symbol}, column ${c.col}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(c)}
            >
              <span className="search-match-line">{c.col}</span>
              {/* A symbol is a single validated identifier — plain text, no
                  Law-1 escaped-slice highlighter needed. */}
              <span className="search-match-text">{c.symbol}</span>
            </div>
          ))}
        </div>
        {/* A11Y-1 (SC 3.3.2): NOT aria-hidden — referenced by the dialog's
            aria-describedby so the action keys are announced on focus-in,
            mirroring ShortcutsPanel.tsx:530. Visible to sighted users too. */}
        <div className="def-picker-hint" id={hintId}>
          ↑↓ navigate · Enter go to definition · Esc dismiss
        </div>
      </div>
    </div>
  );
}
