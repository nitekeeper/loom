/* ============================================================
 * Loom — word-under-caret extraction for Go to Definition (PURE)
 * ------------------------------------------------------------
 * A DOM-free helper that, given a single line of source text and a
 * (0-based) column offset, returns the identifier the caret is on — the
 * symbol the developer wants to "go to definition" for.
 *
 * It is deliberately DOM-free: the Viewer's DOM glue maps a caret/click
 * (selection Range or caretRangeFromPoint) to (lineText, columnOffset)
 * and then calls wordAt — so this module is unit-testable with plain
 * strings and NO jsdom.
 *
 * The identifier class is IDENTICAL to highlight.ts's tokenizer
 * (`[A-Za-z_$][\w$]*`) so the highlighter's token boundaries and
 * go-to-definition extraction can never disagree about where a symbol
 * starts/ends. A caret on a KEYWORD or LITERAL (return, if, true, …) is
 * rejected — those are never resolvable symbols. The SAME exported
 * KEYWORDS/LITERALS sets feed both the highlighter and this module so the
 * keyword list has exactly ONE source of truth.
 * ============================================================ */
import { KEYWORDS, LITERALS } from './highlight.js';

/** A resolved identifier span within a single line of text. `start`/`end`
 *  are 0-based [start, end) offsets into the line so a caller (the picker,
 *  the column math) can map the run back to columns/marks. */
export interface WordSpan {
  /** The extracted identifier (a single ASCII + $/_ word). */
  symbol: string;
  /** 0-based start offset of the identifier in the line. */
  start: number;
  /** 0-based end offset (exclusive) of the identifier in the line. */
  end: number;
}

/** First char of an identifier — matches highlight.ts's [A-Za-z_$]. */
const IDENT_START = /[A-Za-z_$]/;
/** Subsequent identifier chars — matches highlight.ts's [\w$] (= [A-Za-z0-9_$]). */
const IDENT_PART = /[A-Za-z0-9_$]/;

/** Resolve the identifier under a (line, 0-based column) caret.
 *
 *  Algorithm (mirrors a typical editor's word-under-caret):
 *   1. Clamp `columnOffset` into [0, line.length].
 *   2. Caret-boundary probe: a caret BETWEEN two chars belongs to either —
 *      prefer the char AT the offset, else the char to its LEFT (so a caret
 *      at the right edge of an identifier still resolves it). Bail (null) if
 *      neither side is an identifier char.
 *   3. Expand left while IDENT_PART, expand right while IDENT_PART.
 *   4. Digit-start guard: if the run begins with a digit (e.g. caret inside
 *      `42px` would otherwise yield `42px`), walk `start` forward past the
 *      leading digits until IDENT_START holds; if the whole run is digits,
 *      return null — a number is never a symbol.
 *   5. Reject the slice if it is a KEYWORD or LITERAL.
 *
 *  Member access `a.b.c` resolves the hovered SEGMENT for free because '.'
 *  is not an identifier char — expansion stops at the dot.
 *
 *  Returns null for whitespace / punctuation / a pure number / a
 *  keyword / an out-of-range or empty line. */
export function wordAt(lineText: string, columnOffset: number): WordSpan | null {
  if (typeof lineText !== 'string' || lineText.length === 0) return null;
  const n = lineText.length;
  // (1) clamp
  let col = columnOffset;
  if (!Number.isFinite(col)) return null;
  col = Math.max(0, Math.min(Math.trunc(col), n));

  // (2) caret-boundary probe: prefer the char at `col`, else the char to the
  // left. Establish an anchor index that sits ON an identifier char.
  let anchor: number;
  if (col < n && IDENT_PART.test(lineText[col]!)) {
    anchor = col;
  } else if (col > 0 && IDENT_PART.test(lineText[col - 1]!)) {
    anchor = col - 1;
  } else {
    return null;
  }

  // (3) expand left/right over identifier chars.
  let start = anchor;
  while (start > 0 && IDENT_PART.test(lineText[start - 1]!)) start--;
  let end = anchor + 1;
  while (end < n && IDENT_PART.test(lineText[end]!)) end++;

  // (4) digit-start guard: never treat a number (or the numeric prefix of a
  // malformed token) as a symbol. Walk past leading digits to the first
  // IDENT_START char; if none exists in the run, it is purely numeric -> null.
  while (start < end && !IDENT_START.test(lineText[start]!)) start++;
  if (start >= end) return null;

  const symbol = lineText.slice(start, end);
  // (5) a keyword/literal is never a resolvable symbol.
  if (KEYWORDS.has(symbol) || LITERALS.has(symbol)) return null;

  return { symbol, start, end };
}

/** A11Y-GTD-01: every RESOLVABLE identifier on a line, left to right, de-duped
 *  by symbol text (first occurrence kept). Used by the keyboard-only F12 path:
 *  when the symbol source is the topmost-visible line (no caret/selection a
 *  pure-keyboard user could place), a line with MORE THAN ONE identifier is
 *  offered as a small chooser so the keyboard user can pick WHICH symbol — the
 *  pointer path (Ctrl/Cmd-click) already has per-symbol precision, so this
 *  restores keyboard/pointer parity (SC 2.1.1 spirit).
 *
 *  Reuses wordAt per identifier RUN (one O(n) left-to-right pass over the same
 *  IDENT class the highlighter uses), so keyword/literal/digit-start rejection
 *  is applied uniformly — a keyword/number on the line is silently skipped. */
export function lineIdentifiers(lineText: string): WordSpan[] {
  const out: WordSpan[] = [];
  if (typeof lineText !== 'string' || lineText.length === 0) return out;
  const seen = new Set<string>();
  const identRe = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(lineText)) !== null) {
    // wordAt at the run start applies the SAME keyword/literal/digit-start
    // rejection wordAt uses elsewhere; a rejected run contributes nothing.
    const w = wordAt(lineText, m.index);
    if (w && !seen.has(w.symbol)) {
      seen.add(w.symbol);
      out.push(w);
    }
  }
  return out;
}
