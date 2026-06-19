/* ============================================================
 * Loom — pure go-to-definition dispatch + history decisions
 * ------------------------------------------------------------
 * The two decision functions behind App's onGoToDefinition flow, extracted
 * as PURE, DOM-free, React-free helpers (TA-5) so the count-based dispatch
 * and the GTD-9 same-location / history-push invariants are unit-testable
 * under node --test WITHOUT Electron — instead of living only inside a
 * useCallback that closes over window.loom + React state and could only be
 * exercised by the CI-only e2e.
 *
 *   - classifyDefinitionResult(candidates): the jump-vs-pick fork. CI-2: the
 *     decision is DECLARATION-AWARE, not a raw candidate COUNT. The resolver
 *     emits low-rank USE candidates (import binding / object-literal property /
 *     parameter / bare occurrence) ALONGSIDE the real declaration, so a symbol
 *     that is merely used more than once would, under a pure count, always show
 *     the picker even when there is exactly ONE obvious declaration — diverging
 *     from the user-confirmed "exactly one definition -> jump directly". So:
 *       * exactly ONE real-declaration candidate  -> auto-jump to it (even when
 *         low-rank uses also exist — they never outrank it after CI-1 ranking);
 *       * two or more real-declaration candidates -> pick (genuinely ambiguous);
 *       * ZERO declarations, multiple uses         -> pick (surface the uses);
 *       * ZERO declarations, exactly one use       -> none (GTD-CORR-3: a lone
 *         use is not a definition; show the "no definition" toast rather than
 *         silently landing the caret on a mere use);
 *       * ZERO candidates                          -> none.
 *   - shouldPushHistory(current, target): the GTD-9 predicate — a jump to the
 *     SAME (path,line) the trigger already sits on is an in-place no-op that
 *     must NOT push a Go-Back entry (so the history stack is never polluted by
 *     a self-jump, e.g. F12 on a symbol's own declaration).
 * ============================================================ */
import type { DefinitionCandidate, DefinitionKind } from '../../shared/types.js';

/** What the renderer should do with a resolved candidate set. */
export type DefinitionAction =
  | { action: 'none' }
  | { action: 'jump'; candidate: DefinitionCandidate }
  | { action: 'pick' };

/** Pure-USE kinds: a match that is a USE of the symbol (an import binding, an
 *  object-literal property, a function parameter, or a bare whole-word
 *  occurrence), NOT a real declaration. The resolver sinks these BELOW every
 *  declaration (CI-1) and never lets them outrank one; the dispatch counts
 *  declarations (NOT raw candidates) so a symbol with one declaration + several
 *  uses still auto-jumps (CI-2), and GTD-CORR-3 refuses to AUTO-JUMP to a use
 *  even when it is the SOLE candidate (there is no real definition to go to).
 *
 *  MUST stay the EXACT complement of definition-core.ts isDeclarationKind() —
 *  the resolver (main) and the dispatch (renderer) are separate bundles, so the
 *  use/declaration partition is mirrored here rather than imported across the
 *  main/renderer boundary. A unit test pins the two in lock-step. */
const USE_ONLY_KINDS: ReadonlySet<DefinitionKind> = new Set<DefinitionKind>([
  'import',
  'property',
  'parameter',
  'other',
]);

/** True iff `kind` is a real DECLARATION site (the complement of USE_ONLY_KINDS;
 *  mirrors definition-core.ts isDeclarationKind across the bundle boundary). */
export function isDeclarationCandidate(c: DefinitionCandidate): boolean {
  return !USE_ONLY_KINDS.has(c.kind);
}

/** Decide the action for a resolved (already-ranked) candidate list. CI-2:
 *  DECLARATION-AWARE, not a raw count —
 *    exactly 1 declaration -> jump (even alongside low-rank uses);
 *    2+ declarations       -> pick;
 *    0 declarations, 2+ uses -> pick;
 *    0 declarations, 1 use   -> none (GTD-CORR-3 — a use is not a definition);
 *    0 candidates          -> none. */
export function classifyDefinitionResult(
  candidates: readonly DefinitionCandidate[],
): DefinitionAction {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { action: 'none' };
  }
  const declarations = candidates.filter(isDeclarationCandidate);
  if (declarations.length === 1) {
    // Exactly one real declaration: auto-jump to it (CI-2). It is candidates[0]
    // after CI-1 ranking — declarations sort above every use — but we resolve it
    // from the filtered list so the contract holds even if a caller passes an
    // unranked list.
    return { action: 'jump', candidate: declarations[0]! };
  }
  if (declarations.length >= 2) {
    // Genuinely ambiguous: multiple real definitions -> let the user pick.
    return { action: 'pick' };
  }
  // No real declarations — only uses (import/property/parameter/other).
  if (candidates.length === 1) {
    // A lone use is not a definition (GTD-CORR-3): toast, never auto-jump.
    return { action: 'none' };
  }
  // Multiple navigable uses but no declaration -> surface them in the picker.
  return { action: 'pick' };
}

/** GTD-9 same-location predicate: push a Go-Back entry ONLY when the jump
 *  actually MOVES the caret. A jump whose target (path,line) equals where the
 *  trigger already is must NOT push history (and the caller shows "Already at
 *  definition" with no flash). A null current path (no file open) never pushes.
 *  `currentLine`/`targetLine` are 1-based, matching the Viewer + candidate
 *  coordinates. */
export function shouldPushHistory(
  current: { path: string | null; line: number },
  target: { path: string; line: number },
): boolean {
  if (current.path === null) return false;
  return !(current.path === target.path && current.line === target.line);
}

/** GTD-9 helper: true iff the jump is an in-place no-op (same path + line). */
export function isSameLocation(
  current: { path: string | null; line: number },
  target: { path: string; line: number },
): boolean {
  return current.path !== null && current.path === target.path && current.line === target.line;
}

/** One entry on the Go-Back jump-history stack: a reading location to return to. */
export interface JumpLocation {
  path: string;
  line: number;
}

/** TA-R1: push a reading location onto the jump-history stack, enforcing the
 *  drop-oldest cap. PURE-ish — it MUTATES the passed array in place (the live
 *  useRef array App closes over) AND returns it, so the cap/order invariant is
 *  unit-testable without React. After a push the stack holds AT MOST `max`
 *  entries; when it overflows, the OLDEST (index 0) is dropped so Go-Back walks
 *  back through the most recent `max` jumps (browser-history semantics). A
 *  non-positive `max` keeps only the just-pushed entry (defensive). */
export function pushJumpHistory(
  stack: JumpLocation[],
  entry: JumpLocation,
  max: number,
): JumpLocation[] {
  stack.push(entry);
  // Drop from the OLDEST end until within cap (a single push can overflow by at
  // most one in normal use, but the loop is robust to a pre-overflowed stack).
  const cap = max > 0 ? max : 1;
  while (stack.length > cap) stack.shift();
  return stack;
}

/** TA-R1: pop the most-recent entry off the jump-history stack, or null when the
 *  stack is empty (the caller then shows "No previous location"). Mutates the
 *  passed array in place (LIFO) and returns the popped entry. */
export function popJumpHistory(stack: JumpLocation[]): JumpLocation | null {
  return stack.pop() ?? null;
}
