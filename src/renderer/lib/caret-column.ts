/* ============================================================
 * Loom — pure caret -> (line, column) reconstruction for Go to Definition
 * ------------------------------------------------------------
 * The error-prone HALF of word extraction: mapping a DOM caret
 * (container node + offset) inside a rendered source row to a 0-based
 * COLUMN against the original line text. Extracted out of CodeView's inline
 * glue (TA-3) so it is unit-testable under node --test with jsdom — instead
 * of being reachable ONLY by the CI-only e2e.
 *
 * The Viewer renders each row as:
 *   <span class="ln-wrap" data-line={0-based}>
 *     <span class="ln" innerHTML=escaped-highlighted-source/>
 *     [ .fold-ellipsis / .sr-only decorations on a collapsed header ]
 *   </span>
 * Only KEYWORDS/LITERALS get .tok-kw and fn-calls get .tok-fn; bare
 * identifiers are raw escaped TEXT nodes inside .ln. escapeHtml only
 * re-encodes &<>, which textContent DECODES, so the .ln textContent
 * round-trips to the original source line — making the column exact against
 * the un-highlighted text wordAt sees.
 *
 * COLUMN MATH: sum the textContent lengths of all SHOW_TEXT nodes inside the
 * .ln that PRECEDE the caret container (document order via a TreeWalker),
 * then add the in-container offset.
 *
 * GTD-3 GUARD: the caret container MUST be inside the row's .ln element. A
 * caret landing on a collapsed header's sibling decorations (.fold-ellipsis
 * " ⋯" / .sr-only "N lines hidden") is rejected (returns null) so the
 * .ln-scoped column sum is always well-defined and we never report a wrong
 * column or fire IPC for a click outside the source text.
 *
 * TA-R2: resolveSelectionSymbol() additionally lifts CodeView's selection ->
 * live-caret -> lastCaret PRECEDENCE (the error-prone, jsdom-reachable HALF of
 * the F12 symbol-resolution chain) out of the component so the precedence —
 * including the GTD-CORR-2 right-to-left selection anchor handling — is unit-
 * testable under jsdom. (The 4th fallback, the topmost-visible .ln-wrap
 * getBoundingClientRect scan, is NOT here: jsdom returns 0 for every rect, so
 * that branch is legitimately e2e-only and stays inline in CodeView.)
 * ============================================================ */
import { wordAt } from './symbol-at.js';

/** A resolved caret position within a source row: the 1-based line (from the
 *  .ln-wrap[data-line] + 1) and the 0-based column against the original line. */
export interface CaretColumn {
  /** 1-based line number (data-line + 1, matching the gutter + targetLine). */
  line: number;
  /** 0-based column offset against the original (un-highlighted) line text. */
  col: number;
  /** The .ln element's textContent (the original line, since escapeHtml
   *  round-trips through textContent). */
  lineText: string;
}

/**
 * Map a caret (container node + offset) to (line, 0-based col, lineText) for the
 * source row that contains it, or null when the caret is NOT inside a real .ln.
 *
 * `rootEl` is the CodeView `.code` container; `container`/`offset` come from a
 * selection Range anchor or caretRangeFromPoint/caretPositionFromPoint.
 *
 * Pure with respect to its inputs: it only READS the passed DOM (no mutation,
 * no events, no globals beyond the `document` that owns `rootEl` for the
 * TreeWalker), so a jsdom tree drives it identically to Electron's DOM.
 */
export function columnAt(
  rootEl: Element,
  container: Node | null,
  offset: number,
): CaretColumn | null {
  if (!container || !rootEl.contains(container)) return null;

  // Climb to the enclosing element to find the .ln / .ln-wrap ancestors.
  const startEl =
    container.nodeType === 1 /* ELEMENT_NODE */
      ? (container as Element)
      : container.parentElement;
  if (!startEl) return null;

  const lnEl = startEl.closest('.ln') as HTMLElement | null;
  // GTD-3: the caret container MUST be inside the .ln element. A hit on a
  // collapsed-header sibling (.fold-ellipsis / .sr-only) is rejected.
  if (!lnEl || !lnEl.contains(container)) return null;

  const lnWrap = lnEl.closest('.ln-wrap[data-line]') as HTMLElement | null;
  if (!lnWrap) return null;
  const dataLine = lnWrap.getAttribute('data-line');
  if (dataLine === null) return null;
  const rowIdx = Number.parseInt(dataLine, 10); // 0-based
  if (!Number.isFinite(rowIdx)) return null;
  const lineText = lnEl.textContent ?? '';

  // The owner document drives the TreeWalker (jsdom or Chromium alike).
  const doc = lnEl.ownerDocument;
  if (!doc) return null;

  // The caret container IS the .ln element itself (offset = child-node index):
  // sum the textContent lengths of the first `offset` child text nodes.
  if (container === lnEl) {
    let col = 0;
    const w = doc.createTreeWalker(lnEl, 0x4 /* SHOW_TEXT */);
    let n: Node | null = w.nextNode();
    let childCount = 0;
    while (n && childCount < offset) {
      col += n.textContent?.length ?? 0;
      n = w.nextNode();
      childCount++;
    }
    return { line: rowIdx + 1, col, lineText };
  }

  // Otherwise sum the lengths of all text nodes inside .ln BEFORE the caret
  // container, then add the in-container offset.
  let col = 0;
  const walker = doc.createTreeWalker(lnEl, 0x4 /* SHOW_TEXT */);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node === container) {
      col += Math.max(0, Math.min(offset, node.textContent?.length ?? 0));
      return { line: rowIdx + 1, col, lineText };
    }
    col += node.textContent?.length ?? 0;
    node = walker.nextNode();
  }

  // The container was inside .ln (lnEl.contains is true) but is not itself a
  // visited text node and is not the .ln element — treat the whole .ln prefix as
  // consumed (defensive; should not occur for a normal caret).
  return { line: rowIdx + 1, col, lineText };
}

/** The resolved go-to-definition target: the identifier + its 1-based line and
 *  1-based column (the symbol's START column, advisory). */
export interface ResolvedSymbol {
  symbol: string;
  /** 1-based line. */
  line: number;
  /** 1-based column of the symbol's START. */
  col: number;
}

/** The minimal Selection shape resolveSelectionSymbol reads (a subset of the
 *  DOM Selection interface) so a jsdom Selection — or a hand-built fake —
 *  drives it identically to Electron's live selection. */
export interface SelectionLike {
  rangeCount: number;
  isCollapsed: boolean;
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
  toString(): string;
}

/** Climb from a selection endpoint node to its enclosing `.ln` element (or null
 *  when the endpoint is not inside a source row). */
function lnOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el =
    node.nodeType === 1 /* ELEMENT_NODE */
      ? (node as Element)
      : node.parentElement;
  return (el?.closest<HTMLElement>('.ln')) ?? null;
}

/**
 * TA-R2: resolve the symbol the user is targeting from the live selection /
 * caret, in CodeView's precedence order — WITHOUT the topmost-visible-row scan
 * (which needs getBoundingClientRect and so is e2e-only, kept inline in the
 * component). PURE with respect to its inputs (reads the passed DOM + selection
 * + lastCaret only), so jsdom drives it exactly as Electron does.
 *
 *   (1) a non-collapsed selection within ONE `.ln` whose trimmed text is exactly
 *       one identifier -> use it directly (precise user intent). GTD-CORR-2: a
 *       selection can run right-to-left, so map BOTH endpoints and take the
 *       SMALLER column (the word's start) regardless of direction.
 *   (2) the live collapsed caret inside this `.code` -> wordAt at that column.
 *   (3) the `lastCaret` tracked on a prior interaction -> wordAt at that column.
 *
 * Returns the resolved symbol (1-based line + start col) or null (no symbol —
 * the caller falls through to the topmost-visible-row scan, then no-op).
 */
export function resolveSelectionSymbol(
  rootEl: Element,
  sel: SelectionLike | null,
  lastCaret: { line: number; col: number } | null,
): ResolvedSymbol | null {
  // (1) An explicit one-identifier selection inside a single .ln.
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    const text = sel.toString();
    const anchorLn = lnOf(sel.anchorNode);
    const focusLn = lnOf(sel.focusNode);
    if (
      anchorLn &&
      anchorLn === focusLn &&
      rootEl.contains(anchorLn) &&
      text.trim().length > 0
    ) {
      const trimmed = text.trim();
      const w = wordAt(trimmed, 0);
      if (w && w.symbol === trimmed) {
        // GTD-CORR-2: map both endpoints, take the SMALLER column (word start)
        // so the reported col is direction-independent.
        const a = columnAt(rootEl, sel.anchorNode, sel.anchorOffset);
        const f = columnAt(rootEl, sel.focusNode, sel.focusOffset);
        const line = a?.line ?? f?.line ?? 1;
        const cols = [a?.col, f?.col].filter(
          (c): c is number => typeof c === 'number',
        );
        const startCol = cols.length > 0 ? Math.min(...cols) : 0;
        return { symbol: w.symbol, line, col: startCol + 1 };
      }
    }
  }

  // (2) The live collapsed caret inside this .code.
  if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
    const mapped = columnAt(rootEl, sel.anchorNode, sel.anchorOffset);
    if (mapped) {
      const w = wordAt(mapped.lineText, mapped.col);
      if (w) return { symbol: w.symbol, line: mapped.line, col: w.start + 1 };
    }
  }

  // (3) The last tracked caret in this view.
  if (lastCaret) {
    const lnWrap = rootEl.querySelector<HTMLElement>(
      `.ln-wrap[data-line="${lastCaret.line - 1}"]`,
    );
    const lnEl = lnWrap?.querySelector<HTMLElement>('.ln');
    if (lnEl) {
      const lineText = lnEl.textContent ?? '';
      const w = wordAt(lineText, lastCaret.col);
      if (w) return { symbol: w.symbol, line: lastCaret.line, col: w.start + 1 };
    }
  }

  return null;
}
