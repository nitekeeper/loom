/* ============================================================
 * Loom — shared escaped-slice match highlighter (Law 1)
 * ------------------------------------------------------------
 * The ONE implementation of "escape a raw line, mark the matched run".
 * Lifted out of SearchView (GTD-6) so SearchView's content/file rows AND
 * the go-to-definition DefinitionPicker share a single Law-1 contract:
 * attacker-influenced file content is ALWAYS escaped — never the
 * concatenated raw text — and the matched run is the ONLY thing wrapped in
 * a semantic <mark class="search-hit">.
 *
 * SECURITY (Law 1): each of the three slices (before / hit / after) is
 * escaped INDEPENDENTLY via escapeHtml, then re-joined with a fixed
 * <mark class="search-hit"> wrapper that contains NO user-controlled bytes.
 * The result is the ONLY string ever fed to a dangerouslySetInnerHTML sink
 * for a match row — raw file text is never set as innerHTML.
 *
 * ACCESSIBILITY (A11Y-SEARCH-07): a <mark> gives the emphasis a
 * programmatic role (not a styled-span-only cue); hitText() extracts the
 * matched run verbatim for a row's accessible name.
 * ============================================================ */
import { escapeHtml } from './highlight.js';

/** Build the escaped, highlighted HTML for one match line: escape the three
 *  slices around [start, end) INDEPENDENTLY (Law 1) so attacker-influenced
 *  file content can never inject markup, then wrap ONLY the matched run in a
 *  semantic <mark class="search-hit">. Offsets are defensively clamped into
 *  the string so a bad offset can never slice outside it. An empty match
 *  region renders the line with no highlight rather than an empty <mark>. */
export function highlightedMatchHtml(
  lineText: string,
  matchStart: number,
  matchEnd: number,
): string {
  const start = Math.max(0, Math.min(matchStart, lineText.length));
  const end = Math.max(start, Math.min(matchEnd, lineText.length));
  const before = escapeHtml(lineText.slice(0, start));
  const hit = escapeHtml(lineText.slice(start, end));
  const after = escapeHtml(lineText.slice(end));
  if (hit.length === 0) return before + after;
  return `${before}<mark class="search-hit">${hit}</mark>${after}`;
}

/** Extract the matched run verbatim from a match line for the accessible name
 *  (A11Y-SEARCH-07). Bounded by the same clamped offsets as
 *  highlightedMatchHtml; empty when the match falls past a truncation point. */
export function hitText(
  lineText: string,
  matchStart: number,
  matchEnd: number,
): string {
  const start = Math.max(0, Math.min(matchStart, lineText.length));
  const end = Math.max(start, Math.min(matchEnd, lineText.length));
  return lineText.slice(start, end);
}
