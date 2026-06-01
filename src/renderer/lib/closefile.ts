/* ============================================================
 * Loom — close-file Escape coordination (pure decision logic)
 * ------------------------------------------------------------
 * The document-level Escape handler that closes the open file
 * (FR-42 / SC 2.4.3) must coordinate with ReceiptStrip's tooltip
 * Escape (SC 1.4.13) and rescue focus when the × close button is
 * focused. That coordination is load-bearing AND fragile
 * (A11Y-CLOSE-05), so the DECISION is factored out here as a pure,
 * DOM-free function that the acceptance suite pins with a regression
 * test — App.tsx merely wires the DOM facts (defaultPrevented, the
 * open selection, the editable/close-button focus) into it.
 *
 * This module has NO React / DOM imports so it bundles into the
 * Electron-free testkit and is unit-testable without a browser.
 * ============================================================ */

/** What the Escape handler should do, given the current DOM facts. */
export type EscapeCloseAction =
  /** Do nothing — a tooltip consumed Escape, nothing is open, focus is in an
   *  editable control, or the key was not Escape. */
  | 'ignore'
  /** Close the file AND rescue focus off the unmounting × button (SC 2.4.3). */
  | 'close-rescue-focus'
  /** Close the file; focus stays put (e.g. the Explorer treeitem). */
  | 'close-in-place';

/** Inputs the handler reads from the keyboard event + document state. */
export interface EscapeCloseFacts {
  /** True only for the Escape key. */
  isEscape: boolean;
  /** event.defaultPrevented — a tooltip (or anything) already consumed it.
   *  This is the SECOND, independent line of defense behind propagation-
   *  stopping: even if the event reaches this handler, a consumed Escape is
   *  ignored so a receipt tooltip dismissal can never also close the file
   *  (A11Y-CLOSE-05). */
  defaultPrevented: boolean;
  /** True when a file is open (store.selected !== null) — else nothing to
   *  close. */
  hasOpenFile: boolean;
  /** True when focus is in a text-editable control — don't hijack Escape. */
  editableTarget: boolean;
  /** True when document.activeElement is (or is inside) the × close button,
   *  which UNMOUNTS on close, so focus must be rescued (A11Y-CLOSE-01). */
  focusOnCloseButton: boolean;
}

/** Decide the Escape action from the current facts. Pure + total. */
export function decideEscapeClose(facts: EscapeCloseFacts): EscapeCloseAction {
  // Order matters: each guard mirrors the App.tsx handler exactly.
  if (!facts.isEscape) return 'ignore';
  if (facts.defaultPrevented) return 'ignore'; // a tooltip consumed it
  if (!facts.hasOpenFile) return 'ignore'; // nothing open to close
  if (facts.editableTarget) return 'ignore'; // don't hijack editable controls
  // A real close. Rescue focus only when it sits on the unmounting × button.
  return facts.focusOnCloseButton ? 'close-rescue-focus' : 'close-in-place';
}
