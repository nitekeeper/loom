/* ============================================================
 * Loom — code-folding range computation (pure, Law 1 safe)
 * ------------------------------------------------------------
 * computeFoldRanges(code) derives indentation-based fold regions
 * from RAW source text. It NEVER parses, evaluates, or re-interprets
 * the content — it only measures leading whitespace to decide which
 * already-rendered, already-escaped lines a header can hide. The
 * Viewer uses these ranges purely to SHOW/HIDE the per-line HTML that
 * lib/highlight.ts produced (Law 1: nothing executes; folding only
 * collapses display rows).
 *
 * ALGORITHM (deterministic, language-agnostic — works for ts/js/json/
 * css/py/html/svg-as-source/txt alike):
 *   - Indent width of a line = count of leading spaces, where each
 *     leading TAB counts as TAB_WIDTH spaces (mixed tabs/spaces are
 *     normalized consistently). Blank / whitespace-only lines have NO
 *     intrinsic indent — they belong to whichever block surrounds them.
 *   - A line H at indent d is a fold HEADER iff the next NON-BLANK line
 *     is MORE indented than d. The region BODY is the maximal run of
 *     following lines whose indent > d, INCLUDING interspersed blank
 *     lines (a blank line stays in the body as long as a later, still
 *     more-indented non-blank line continues the run). The region ENDS
 *     before the next non-blank line at indent <= d — that line (e.g. a
 *     closing brace) stays VISIBLE and is NOT folded.
 *   - Only ranges that hide >= MIN_HIDDEN lines are emitted (trivial
 *     1-line blocks are skipped). Ranges nest naturally: a header inside
 *     another region produces its own range.
 *
 * ACCEPTED LIMITATION (FOLD-UX-04) — pure-indentation folding has no notion of
 * statement boundaries (by design, for Law 1: it must not parse or interpret
 * the content). It therefore folds VISUAL indentation, not SYNTACTIC blocks:
 * any line whose following lines are more-indented is treated as a header,
 * including non-block continuations — a multi-line function CALL, a wrapped
 * assignment, a ternary's ?/: arms, or a JSDoc/comment block above a function.
 * Folding such a "header" collapses a region that does not read as a meaningful
 * block (e.g. `const v = cond ⋯`). This never violates Law 1 (nothing is
 * evaluated; rows are only shown/hidden) and the dedent invariant still holds —
 * it is a known UX trade-off of indentation folding. A cheaper, still-Law-1-safe
 * refinement (NOT applied here to avoid changing established fold geometry across
 * the fixtures without product sign-off) would be to additionally require the
 * header line to END in an opening bracket/brace/paren or a colon — a pure
 * trailing-character check, no parsing — which would suppress ternary/continuation
 * folds while keeping object/array/function/JSON/SVG folds.
 * ============================================================ */

/** A foldable region of the source.
 *  - `header`  : 0-based index of the VISIBLE line carrying the chevron.
 *  - `start`   : 0-based index of the FIRST hidden line (always header+1).
 *  - `end`     : 0-based index of the LAST hidden line (inclusive).
 *  start..end inclusive are hidden when the header is collapsed; the
 *  header line and the line after `end` (the dedent line) stay visible. */
export interface FoldRange {
  header: number;
  start: number;
  end: number;
}

/** A leading tab is normalized to this many spaces when measuring indent. */
export const TAB_WIDTH = 4;

/** A region must hide at least this many lines to be worth a chevron.
 *
 * FOLD-UX-03 (accepted, documented): keeping this at 2 deliberately suppresses
 * chevrons on 1-line bodies to avoid folding trivial noise. A consequence is an
 * affordance ASYMMETRY between structurally-parallel code — e.g. in the acme-api
 * fixture the 3-line `/users/:id` handler folds while the 1-line `/users`
 * handler does not, and db.ts (two 1-line function bodies) shows zero chevrons.
 * This is an intentional product trade-off (less clutter), NOT a bug; the
 * acceptance suite pins the >=2 rule (the "trivial 1-line block is SKIPPED"
 * test). Lowering it to 1 would give every header a chevron at the cost of more
 * visual noise + a foldable single-line body — a product decision to be made
 * before changing this constant (and the test that locks it). */
const MIN_HIDDEN = 2;

/** True for a line that is empty or only whitespace. Blank lines carry no
 *  intrinsic indent; they belong to the surrounding block. */
function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** Measure a line's indentation width: leading spaces count 1, leading
 *  tabs count TAB_WIDTH, until the first non-whitespace character. Pure
 *  whitespace measurement — no tokenizing, no parsing (Law 1). */
function indentWidth(line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 32 /* space */) {
      width += 1;
    } else if (ch === 9 /* tab */) {
      width += TAB_WIDTH;
    } else {
      break;
    }
  }
  return width;
}

/**
 * Compute indentation-based fold ranges over RAW source text.
 *
 * The line model MATCHES lib/highlight.highlightCode: a single trailing
 * newline is trimmed (so a final "\n" does not yield a spurious empty
 * line), then the text is split on "\n". Indices returned here therefore
 * align 1:1 with the per-line HTML array the Viewer renders.
 *
 * Pure + deterministic: identical input always yields identical output;
 * no clock, no randomness, no evaluation of the content.
 */
export function computeFoldRanges(code: string): FoldRange[] {
  const lines = code.replace(/\n$/, '').split('\n');
  const n = lines.length;

  // Pre-measure: indent per line, and a blank flag. Blank lines get a
  // sentinel indent of -1 so they never themselves act as a dedent
  // boundary (their membership is decided by the nearest non-blank line).
  const blank: boolean[] = new Array(n);
  const indent: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = isBlank(lines[i]!);
    blank[i] = b;
    indent[i] = b ? -1 : indentWidth(lines[i]!);
  }

  const ranges: FoldRange[] = [];

  for (let i = 0; i < n; i++) {
    if (blank[i]) continue;
    const headerIndent = indent[i]!;

    // Find the next NON-BLANK line. The header only opens a region if that
    // line is MORE indented than the header.
    let j = i + 1;
    while (j < n && blank[j]) j++;
    if (j >= n) continue; // trailing blanks only — nothing to fold
    if (indent[j]! <= headerIndent) continue; // not a header (no deeper body)

    // Extend the body: the maximal run of following lines whose non-blank
    // indent is STRICTLY greater than the header's. Blank lines are carried
    // along provisionally; a trailing tail of blanks (with no deeper line
    // after them) is excluded so the fold never swallows blank lines that
    // really belong to the dedent line / the gap before the next block.
    let end = i; // last line confirmed to belong to the body
    let k = i + 1;
    while (k < n) {
      if (blank[k]) {
        k++;
        continue;
      }
      if (indent[k]! > headerIndent) {
        end = k; // a deeper non-blank line: everything up to here is body
        k++;
      } else {
        break; // dedent line (e.g. closing brace) — stays VISIBLE
      }
    }

    const start = i + 1;
    // Emit only if the region hides >= MIN_HIDDEN lines (skip trivial blocks).
    if (end - start + 1 >= MIN_HIDDEN) {
      ranges.push({ header: i, start, end });
    }
    // Do NOT advance i past the body: a child header inside the body must
    // also be discovered (ranges nest naturally). The header check above
    // (next non-blank deeper) prevents emitting overlapping junk.
  }

  return ranges;
}
