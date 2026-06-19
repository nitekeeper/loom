/* ============================================================
 * Loom — Go to Definition multi-candidate chooser (overlay)
 * ------------------------------------------------------------
 * A small focused overlay (ShortcutsPanel pattern) shown ONLY when a
 * go-to-definition resolves to MORE THAN ONE candidate. Exactly one
 * candidate auto-jumps (no picker); zero shows a status toast.
 *
 * REUSE (GTD-6): this is NOT the SearchView component (SearchView owns its
 * own query input, debounce, and is an Explorer-pane ARIA tree). It reuses
 * the AFFORDANCES — the search-results / search-match / search-match-line /
 * search-match-text CSS classes + the LIFTED, shared escaped-slice match
 * highlighter (src/renderer/lib/match-highlight.ts) — so the symbol is
 * marked exactly as a search hit and the Law-1 escaping has ONE source.
 *
 * SECURITY (Law 1): each candidate's lineText is RAW, attacker-influenced
 * file content. It is rendered ONLY via highlightedMatchHtml (escapes the
 * three slices independently, wraps the matched symbol in
 * <mark class="search-hit">) — never raw innerHTML.
 *
 * ACCESSIBILITY (FR-54, WCAG 2.2 AA): a modal listbox — roving
 * ArrowUp/ArrowDown move the selection, Enter/Space jumps, Escape dismisses
 * (no jump, no history mutation) and restores Viewer focus.
 *   - GTD-A11Y-2 (SC 4.1.2): DOM focus, the keydown handler, AND
 *     aria-activedescendant ALL live on the SAME element — the role=listbox —
 *     so a screen reader (which tracks activedescendant only on the focused
 *     element) announces each option as the selection moves. The role=dialog
 *     wrapper carries aria-modal + aria-labelledby but is NOT the focus host.
 *   - GTD-A11Y-1 (SC 2.4.3 / 2.1.2): the listbox is the SINGLE tab stop and a
 *     Tab/Shift+Tab handler preventDefaults so focus can never escape behind
 *     the scrim (a focus trap, mirroring ShortcutsPanel) — recovery is always
 *     Escape/Enter, never a stranded keyboard.
 *   - GTD-A11Y-4 (SC 4.1.3): a truncated-results caveat is wired via
 *     aria-describedby on the listbox so it is conveyed on focus-in, not via a
 *     live region that would no-op for content already present at mount.
 *   - A11Y-1 (SC 3.3.2): the role=dialog wrapper carries aria-describedby ->
 *     the operating-instructions hint (Enter jumps / Esc dismisses), mirroring
 *     the house ShortcutsPanel pattern (ShortcutsPanel.tsx:494) so the action
 *     keys are announced on focus-in. (The listbox's own aria-describedby is
 *     reserved for the truncated caveat above — two distinct described nodes.)
 * ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import type { DefinitionCandidate } from '../../shared/types.js';
import { highlightedMatchHtml, hitText } from '../lib/match-highlight.js';

export interface DefinitionPickerProps {
  /** The symbol being resolved (for the dialog's accessible name + hit marking). */
  symbol: string;
  /** The ranked candidates (always length > 1 when the picker is mounted). */
  candidates: DefinitionCandidate[];
  /** True when a scan/match bound was hit (results may be incomplete). */
  truncated: boolean;
  /** Jump to a chosen candidate (closes the picker + reveals the line). */
  onPick(candidate: DefinitionCandidate): void;
  /** Dismiss with NO jump and NO history mutation; restores Viewer focus. */
  onClose(): void;
}

/** The basename of a root-relative POSIX path (for a compact row label). */
function basenameOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

export function DefinitionPicker({
  symbol,
  candidates,
  truncated,
  onPick,
  onClose,
}: DefinitionPickerProps): JSX.Element {
  // The roving-selection index (exactly one option is the active descendant).
  const [active, setActive] = useState(0);
  // The role=listbox is BOTH the focus host AND the activedescendant owner AND
  // the keydown target (GTD-A11Y-2). The control to restore focus to on close
  // is owned by App's onClose.
  const listRef = useRef<HTMLDivElement>(null);

  // Clamp the active index if the candidate set ever changes under us.
  useEffect(() => {
    setActive((i) => Math.max(0, Math.min(i, candidates.length - 1)));
  }, [candidates.length]);

  // Take focus on mount (SC 2.4.3 / focus management) so arrows work at once.
  // Focus the LISTBOX (not the dialog) so aria-activedescendant is announced.
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // Keep the active option scrolled into view as selection moves.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-def-index="${active}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      const key = e.key;
      // GTD-A11Y-1 (SC 2.4.3 / 2.1.2): the listbox is the ONLY tab stop in the
      // modal — swallow Tab/Shift+Tab so focus can never leak to content hidden
      // behind the scrim (which has no `inert`) and re-focus the listbox so a
      // stray focus is always rescued. Recovery is Escape/Enter.
      if (key === 'Tab') {
        e.preventDefault();
        listRef.current?.focus();
        return;
      }
      if (key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, candidates.length - 1));
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
        setActive(candidates.length - 1);
        return;
      }
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
        e.preventDefault();
        const c = candidates[active];
        if (c) onPick(c);
        return;
      }
      if (key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
    },
    [active, candidates, onPick, onClose],
  );

  const titleId = 'def-picker-title';
  const caveatId = 'def-picker-caveat';
  const hintId = 'def-picker-hint';
  return (
    // The scrim closes the picker on a click outside (no jump, no history).
    <div className="def-picker-scrim" onMouseDown={onClose}>
      <div
        className="def-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // A11Y-1 (SC 3.3.2): the operating-instructions hint is conveyed on
        // focus-in via the dialog's aria-describedby, mirroring the house
        // ShortcutsPanel pattern (ShortcutsPanel.tsx:494) so a screen-reader
        // user learns Enter jumps / Esc dismisses without seeing the hint text.
        aria-describedby={hintId}
        // Stop a click INSIDE the dialog from bubbling to the scrim (which closes).
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="def-picker-head" id={titleId}>
          {candidates.length} definitions for{' '}
          <code className="def-picker-symbol">{symbol}</code>
        </div>
        {/* GTD-A11Y-4 (SC 4.1.3): the caveat is conveyed on focus-in via the
            listbox's aria-describedby (a live region present at mount commonly
            does NOT auto-announce). It is also visible to sighted users. */}
        {truncated && (
          <div className="def-picker-caveat" id={caveatId}>
            Results may be incomplete
          </div>
        )}
        <div
          className="search-results def-picker-list"
          role="listbox"
          aria-label={`Definitions for ${symbol}`}
          aria-activedescendant={`def-opt-${active}`}
          aria-describedby={truncated ? caveatId : undefined}
          // GTD-A11Y-1/2: the listbox is the focus host + keydown target + the
          // single tab stop (tabIndex 0 so the trap re-focus lands here).
          tabIndex={0}
          onKeyDown={onKeyDown}
          ref={listRef}
        >
          {candidates.map((c, i) => {
            // The symbol's run on the line (1-based col -> 0-based start).
            const start = Math.max(0, c.col - 1);
            const end = start + symbol.length;
            const base = basenameOf(c.path);
            const hit = hitText(c.lineText, start, end);
            // A11Y: the option's accessible name carries WHERE + WHAT.
            const optLabel =
              `${base} line ${c.line}, ${c.kind}` +
              (hit ? `, match: ${hit}` : '') +
              `, in ${c.path}`;
            return (
              <div
                key={`${c.path}:${c.line}:${c.col}:${i}`}
                id={`def-opt-${i}`}
                data-def-index={i}
                className={'search-match def-picker-row' + (i === active ? ' active' : '')}
                role="option"
                aria-selected={i === active}
                aria-label={optLabel}
                title={`${c.path}:${c.line}:${c.col}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(c)}
              >
                <span className="search-match-line">{c.line}</span>
                <span className="def-picker-kind" aria-hidden="true">
                  {c.kind}
                </span>
                <span className="def-picker-path" aria-hidden="true">
                  {base}
                </span>
                {/* Law 1: lineText escaped + the symbol wrapped in a
                    <mark class="search-hit"> via the shared highlighter. */}
                <span
                  className="search-match-text"
                  // eslint-disable-next-line react/no-danger -- escaped by match-highlight
                  dangerouslySetInnerHTML={{
                    __html: highlightedMatchHtml(c.lineText, start, end),
                  }}
                />
              </div>
            );
          })}
        </div>
        {/* A11Y-1 (SC 3.3.2): NOT aria-hidden — referenced by the dialog's
            aria-describedby so the action keys are announced on focus-in, the
            same as ShortcutsPanel.tsx:530. Visible to sighted users too. */}
        <div className="def-picker-hint" id={hintId}>
          ↑↓ navigate · Enter jump · Esc dismiss
        </div>
      </div>
    </div>
  );
}
