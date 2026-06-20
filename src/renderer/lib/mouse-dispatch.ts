/* ============================================================
 * Loom — pure mouse-dispatch decision helpers (FR-54 mouse bindings)
 * ------------------------------------------------------------
 * The two DECISION functions behind App's document-level mouse dispatcher
 * (App.tsx onMouse) and the Viewer's onCodeClick, extracted as PURE, DOM-free,
 * React-free helpers (TA-MOUSE) so the single-source button routing and the
 * fire/skip decision are unit-testable under node --test WITHOUT a DOM —
 * instead of living ONLY inline inside a React useEffect closure that the
 * sandbox can never exercise (the e2e covering the live path is CI-only).
 *
 * These are the SINGLE SOURCE OF TRUTH: the App dispatcher and the Viewer
 * onCodeClick CALL these helpers, and the unit suite imports THESE same
 * functions — so a unit test pins the production logic, and any drift in the
 * dispatcher breaks the build/tests rather than silently passing against a
 * hand-kept copy (the definition-dispatch.ts idiom).
 *
 *   - mouseEventDispatchButton(type, button): the SINGLE-SOURCE right-button
 *     routing rule. A right-button release fires BOTH 'auxclick' AND
 *     'contextmenu' natively (and defaultPrevented does NOT carry across them),
 *     so right-button is dispatched ONLY from 'contextmenu' (its unreliable
 *     e.button is normalized to 2); 'auxclick' owns the MIDDLE button only (a
 *     right-button auxclick is dropped); 'click' owns the PRIMARY button only.
 *     Returns the EFFECTIVE button to dispatch for, or null when the event must
 *     be SKIPPED — guaranteeing a right-button gesture dispatches EXACTLY ONCE.
 *   - shouldFireMouseCommand(facts): the fire/skip decision for a MATCHED mouse
 *     command — bail on a consumed event (anchor-guard / Viewer jump won), skip
 *     a positional command (Viewer-owned), skip closeFile (keyboard-only),
 *     suppress inside an editable target unless the command is terminal-exempt.
 * ============================================================ */

/** The kind of mouse event reaching a dispatcher. Mirrors the three DOM event
 *  types the document/Viewer listeners are wired to. */
export type MouseDispatchType = 'click' | 'auxclick' | 'contextmenu';

/** SINGLE-SOURCE right-button routing. Returns the EFFECTIVE MouseEvent.button
 *  to dispatch for, or null when the event must be SKIPPED:
 *    - 'auxclick'    -> MIDDLE (1) only; any other button is dropped (the
 *                       right-button auxclick is dropped — contextmenu owns it).
 *    - 'click'       -> PRIMARY (0) only; defensive — click is the primary
 *                       button, but a non-primary click is dropped.
 *    - 'contextmenu' -> RIGHT (2) always; its reported e.button is unreliable
 *                       across engines, so it is NORMALIZED to 2.
 *  Any other event type yields null (never dispatched). */
export function mouseEventDispatchButton(
  type: MouseDispatchType,
  button: number,
): number | null {
  if (type === 'auxclick') return button === 1 ? 1 : null;
  if (type === 'click') return button === 0 ? 0 : null;
  if (type === 'contextmenu') return 2;
  return null;
}

/** The facts the fire/skip decision needs, all derived at the call site from
 *  the live event + the matched command. */
export interface MouseFireFacts {
  /** The event was already consumed (e.preventDefault) — the capture-phase
   *  anchor-guard for a rendered-markdown link, or the Viewer's go-to-definition
   *  jump. Links/jumps WIN over a global mouse binding. */
  defaultPrevented: boolean;
  /** The matched command is POSITIONAL (goToDefinition) — the document
   *  dispatcher has no per-pane caret context, so the Viewer's onCodeClick owns
   *  the click path; skip here so it never double-fires. */
  isPositional: boolean;
  /** The matched command is closeFile — keyboard-only (its tooltip/focus-rescue
   *  needs the KeyboardEvent), so a mouse-bound closeFile is intentionally
   *  inert. */
  isCloseFile: boolean;
  /** The click landed inside a text-editable element (input/textarea/
   *  contenteditable, e.g. xterm's hidden textarea). */
  isEditable: boolean;
  /** The matched command is TERMINAL-EXEMPT — it fires even inside an editable
   *  target (toggleTerminal + the per-terminal focus commands). In production a
   *  MOUSE combo is never terminal-exempt, but the guard is expressed here so
   *  the contract is explicit + testable. */
  isTerminalExempt: boolean;
}

/** Decide whether a MATCHED mouse command should FIRE. Returns true to fire,
 *  false to skip. Order mirrors the App onMouse dispatcher:
 *    1. bail on a consumed event (anchor-guard / Viewer jump won);
 *    2. skip a positional command (goToDefinition — Viewer-owned);
 *    3. skip closeFile (keyboard-only);
 *    4. suppress inside an editable target unless terminal-exempt. */
export function shouldFireMouseCommand(facts: MouseFireFacts): boolean {
  if (facts.defaultPrevented) return false; // anchor-guard / Viewer jump won
  if (facts.isPositional) return false; // goToDefinition — Viewer-owned
  if (facts.isCloseFile) return false; // keyboard-only
  if (!facts.isTerminalExempt && facts.isEditable) return false; // don't steal a textarea click
  return true;
}
