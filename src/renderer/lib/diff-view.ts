/* ============================================================
 * Loom — pure diff-row view model (DOM-free)
 * ------------------------------------------------------------
 * Flattens a parsed FileDiff (DiffHunk[]) into a render-ready DiffRow[]
 * the FileDiff/DiffLine React components present 1:1. Kept PURE and
 * DOM-free so it is the unit-testable core of the "Changes" viewer — the
 * only tier locally runnable in WSL (no display). The React components
 * are thin presenters over this output.
 *
 * LAW 1 (nothing executes): this module carries the RAW line text
 * through UNCHANGED (DiffRow.text). It NEVER escapes/markups here — the
 * presenter routes `text` through highlight.ts (escapeHtml/highlightCode)
 * before any dangerouslySetInnerHTML, and the +/-/space sigil, gutter
 * numbers, and origin class are pure React/CSS OUTSIDE the escaped span,
 * so attacker bytes can neither inject markup nor spoof a marker.
 *
 * NFR-12 (non-color cues): every add/del row carries a sigil glyph
 * (+/−) AND an accessible-name suffix ('added line'/'removed line') so
 * the change kind is never conveyed by background color alone.
 * ============================================================ */
import type { FileDiff, DiffLine } from '../../shared/types.js';

/** The visual + accessible classification of one diff line. */
export interface DiffRowClass {
  /** The row CSS class: addition / deletion / context. The VISIBLE +/− sigil and
   *  the row background are both owned by this class via CSS (renderer.css:
   *  `.diff-row.diff-add .diff-sigil::before { content: '+' }`, `.diff-del →
   *  '\2212'`, `.diff-ctx → ''`) — so rowClass is the single source of truth for
   *  the on-screen glyph. */
  rowClass: 'diff-add' | 'diff-del' | 'diff-ctx';
  /** The sigil glyph as DATA: '+' / '−' (U+2212 minus) / '' (context). NOTE: this
   *  is INFORMATIONAL only — the FileDiff presenter renders an EMPTY
   *  `<span class="diff-sigil" aria-hidden>` and the VISIBLE glyph comes from the
   *  CSS `::before` keyed off `rowClass` (above), NOT from this field. It is kept
   *  on the contract so a consumer that needs the glyph as a string (export,
   *  test, a non-CSS surface) has it; changing it does NOT change a rendered
   *  pixel. The CSS-content assertion in diff-render.mjs pins the actual visible
   *  glyph (sdet/F4). */
  sigil: '+' | '−' | '';
  /** The accessible-name suffix announcing the change kind (NFR-12). */
  a11ySuffix: 'added line' | 'removed line' | 'context';
}

/** A flattened, render-ready diff line (one per visible row). Carries the
 *  gutter labels (old# / new#, blank on the absent side), the non-color cues,
 *  and the RAW text the presenter escapes at the sink (Law 1). */
export interface DiffRow extends DiffRowClass {
  /** 0-based index of the hunk this row belongs to (for keying / separators). */
  hunkIndex: number;
  /** OLD-side gutter label (1-based line number), '' for a pure addition. */
  oldGutter: string;
  /** NEW-side gutter label (1-based line number), '' for a pure deletion. */
  newGutter: string;
  /** RAW line text WITHOUT the +/-/space marker — escaped at the render sink. */
  text: string;
}

/** Classify one DiffLine into its row class, sigil glyph, and accessible-name
 *  suffix. PURE — the visual contract (NFR-12) lives here so the presenter and
 *  the tests share ONE source of truth. */
export function classifyDiffLine(origin: DiffLine['origin']): DiffRowClass {
  switch (origin) {
    case 'add':
      return { rowClass: 'diff-add', sigil: '+', a11ySuffix: 'added line' };
    case 'del':
      return { rowClass: 'diff-del', sigil: '−', a11ySuffix: 'removed line' };
    case 'context':
    default:
      return { rowClass: 'diff-ctx', sigil: '', a11ySuffix: 'context' };
  }
}

/** Flatten a FileDiff's hunks into a flat DiffRow[] for rendering. Returns []
 *  when the diff is binary, truncated, or identical (hunks null/empty) — the
 *  presenter shows the matching placeholder card in those cases. PURE — no DOM,
 *  no escaping (the raw text rides through to the escape sink, Law 1). */
export function buildDiffRows(diff: FileDiff): DiffRow[] {
  if (diff.hunks === null) return [];
  const rows: DiffRow[] = [];
  diff.hunks.forEach((hunk, hunkIndex) => {
    for (const line of hunk.lines) {
      const cls = classifyDiffLine(line.origin);
      rows.push({
        ...cls,
        hunkIndex,
        oldGutter: line.oldLine === null ? '' : String(line.oldLine),
        newGutter: line.newLine === null ? '' : String(line.newLine),
        text: line.text,
      });
    }
  });
  return rows;
}
