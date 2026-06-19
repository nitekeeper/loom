/* ============================================================
 * Loom — pure heuristic "go to definition" matcher (Law 1 / Law 3 safe)
 * ------------------------------------------------------------
 * findDefinitionsInText(text, symbol, ext) scans already-confined UTF-8
 * source text for DECLARATIONS of a single identifier `symbol`, using a
 * language-aware (by file extension) table of regular expressions. It is
 * PURE: no fs, no DOM, no Node API, no evaluation of the content — it
 * only reads the string it is handed (which sandbox.readFile already
 * proved confined) and the bounded symbol the resolver re-validated.
 *
 * This is the NON-AST fallback Loom uses instead of a language server /
 * tree-sitter / ctags (all forbidden — Loom is a self-contained local
 * substrate). The trade-offs are documented in definition.ts; the core
 * here is the regex engine that the resolver walks the sandbox with.
 *
 * DESIGN (mirrors search-core.ts so coordinates align 1:1 with the Viewer):
 *   - Same line model as matchFile / highlightCode / computeFoldRanges: a
 *     single trailing "\n" is trimmed, then split on "\n", so 1-based line
 *     numbers returned here land on the exact source row the Viewer shows
 *     (and the existing targetLine reveal primitive jumps to).
 *   - Per-line scan clamped to MAX_SCAN_LINE_LENGTH (shared with
 *     search-core) so a minified one-line bundle cannot stall the loop.
 *   - Each pattern anchors the symbol to a WHOLE identifier via the W(S)
 *     look-around (?<![A-Za-z0-9_$])S(?![A-Za-z0-9_$]) — NOT \b, because
 *     \b treats `$` as a word boundary and would mis-match `foo$bar`.
 *     ES2018 look-behind is supported by bundled Electron Chromium + Node
 *     20 (the only runtimes that load this module).
 *   - Patterns are keyed by extension FAMILY in a Record, so ADDING A
 *     LANGUAGE = ADDING A ROW. Object-literal-property shorthand `{ foo }`
 *     and parameter `(foo: T)` matches are tagged with LOW-rank kinds
 *     ('property' / 'parameter') so a real top-level declaration always
 *     outranks a mere use in the resolver's ranking (GTD-5).
 *
 * KNOWN LIMITS (fundamental to a non-AST resolver; fail-closed):
 *   - no scope resolution (ranking + the picker disambiguate);
 *   - no type resolution for member access (`obj.method` resolves by name);
 *   - imports/aliases are not followed (two-hop workaround);
 *   - per-line string/comment classification only (matches the highlighter
 *     fidelity — we do NOT track multi-line strings/comments, so a symbol
 *     inside one MAY be offered, identical to what the user sees rendered);
 *   - ASCII + $/_ identifier class (matches highlight.ts).
 * ============================================================ */
import type { DefinitionKind } from '../shared/types.js';
import { MAX_SCAN_LINE_LENGTH } from './search-core.js';

/** One declaration match within a single line of a file (pure core output). */
export interface DefMatch {
  /** 1-based line number (aligns with the Viewer's rendered rows). */
  line: number;
  /** 1-based column of the symbol occurrence in the ORIGINAL line. */
  col: number;
  /** The line's raw text (attacker-influenced — escaped at the render sink). */
  lineText: string;
  /** What kind of declaration this match represents (drives ranking). */
  kind: DefinitionKind;
}

/** Display truncation for the returned lineText (chars). Mirrors search-core's
 *  DEFAULT_MAX_LINE_LENGTH so the picker shows a bounded snippet; col stays
 *  measured against the original line so it is accurate past the cut. */
const MAX_DEF_LINE_LENGTH = 200;

/** Cap on matches collected from a SINGLE file (DoS bound). A pathological
 *  file with thousands of occurrences cannot blow the candidate list; the
 *  resolver also enforces a global MAX_DEFS across all files. */
const MAX_DEFS_PER_FILE = 200;

/** Per-line PREFIX scan window for DEFINITION matching (chars). SEC-GTD-2:
 *  defense-in-depth on top of the strictly-linear patterns (SEC-GTD-1). The
 *  byte budget in definition.ts (MAX_TOTAL_SCAN_BYTES) is checked only BETWEEN
 *  files, so it bounds total INPUT but NOT the wall-clock TIME of the per-line
 *  regex loop on a single pathological line. A real declaration sits in the
 *  first few hundred chars of a line, never at column 50000, so we clip the
 *  per-line scan for DEFINITIONS far tighter than search-core's 50_000
 *  MAX_SCAN_LINE_LENGTH (which bounds input length, not regex time). This caps
 *  worst-case per-line regex time regardless of any FUTURE pattern's cost, at
 *  negligible recall cost. We keep it well under MAX_SCAN_LINE_LENGTH so the
 *  definition core is the stricter of the two. */
const MAX_DEF_SCAN_LINE_LENGTH = Math.min(4_000, MAX_SCAN_LINE_LENGTH);

/** Escape a string for safe embedding in a RegExp source. Defensive: the
 *  resolver already restricts `symbol` to a single identifier, so no metachar
 *  can be present, but the core never trusts that and escapes anyway. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-identifier boundary look-around for the (escaped) symbol. NOT \b. */
function wholeWord(escapedSymbol: string): string {
  return `(?<![A-Za-z0-9_$])${escapedSymbol}(?![A-Za-z0-9_$])`;
}

/** One declaration pattern: a per-symbol RegExp factory + the kind it implies.
 *  The factory receives the boundary-anchored symbol fragment W(S) so every
 *  row matches a WHOLE identifier without re-deriving the look-around. */
interface DefPattern {
  /** Build the RegExp for a given W(S) fragment. */
  build(ws: string): RegExp;
  /** The declaration kind this pattern proves. */
  kind: DefinitionKind;
}

/** The TS/JS base patterns shared by every JS-family + TS-family extension. */
function tsJsBase(): DefPattern[] {
  return [
    // class Foo / export class Foo / export default class Foo / abstract class
    { build: (ws) => new RegExp(`\\bclass\\s+${ws}`), kind: 'class' },
    // function foo / async function foo / function* foo / export function foo
    {
      build: (ws) => new RegExp(`\\bfunction\\s*\\*?\\s*${ws}`),
      kind: 'function',
    },
    // const/let/var foo  (covers `const foo = () =>`, fn-expr, plain value)
    {
      build: (ws) => new RegExp(`\\b(?:const|let|var)\\s+${ws}\\b`),
      kind: 'variable',
    },
    // Destructured binding: const { foo } = ... / const [ foo ] = ...
    // Tagged 'destructured' (a real binding, ranked just under a plain var).
    {
      build: (ws) => new RegExp(`\\b(?:const|let|var)\\s*[{[][^=;]*${ws}`),
      kind: 'destructured',
    },
    // Method / class-field shorthand:  foo() { ... }  (inside a class/object
    // body). Low-ish rank so a free `function foo` outranks a method named foo.
    // Anchored to start-of-trimmed-line so a call expression `foo(x)` mid-line
    // is NOT mistaken for a definition.
    //
    // CORR-1 (false-positive call statements): the pattern MUST require the
    // signature to be followed by a BODY brace `{` (with an optional return-type
    // annotation), not merely terminate at the opening paren. The earlier
    // `…${ws}\s*\(` form stopped at the `(` and so could not distinguish a
    // method SIGNATURE (`foo() {`) from a bare CALL STATEMENT (`foo();`),
    // mis-tagging call sites like `render();` as STRONG `method` definitions —
    // which leaked into the candidate count (breaking 1->auto-jump) and could
    // even auto-jump onto a call site for a symbol whose real declaration lives
    // outside the scanned tree. Requiring `\([^)]*\)\s*(?::[^={]+)?\{` keeps
    // every legitimate form (`foo() {}`, `public foo() {}`, `public static
    // async foo () {}`, `get foo()`, `private readonly foo(arg) {}`,
    // `foo(): number { ... }`) while rejecting ALL bare call statements
    // (`foo();`, `  foo();`, `foo(a,b);`, `foo()`). Documented trade-off: a
    // signature whose `{` is on the NEXT line, and an overload/abstract
    // signature ending in `;` (`foo(): void;`), are no longer matched —
    // acceptable and strictly better on the false-positive axis, and consistent
    // with the per-line (non-multiline) scan model.
    //
    // SEC-GTD-1 (ReDoS): the leading-modifier run consumes the inter-token
    // whitespace ITSELF ((?:modifier\s+)*) and NOT a bare `\s` in the
    // alternation, so each space belongs to exactly one construct (linear). The
    // appended `\([^)]*\)\s*(?::[^={]+)?\{` uses negated character classes
    // (`[^)]`, `[^={]`) which match each char at most once with no nested
    // quantifier overlap, so it adds no backtracking exposure.
    {
      build: (ws) =>
        new RegExp(
          `^\\s*(?:(?:public|private|protected|static|readonly|async|get|set|\\*)\\s+)*${ws}\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`,
        ),
      kind: 'method',
    },
    // export { foo } / export { bar as foo } — a re-export surface for foo.
    {
      build: (ws) => new RegExp(`\\bexport\\s*\\{[^}]*${ws}`),
      kind: 're-export',
    },
    // IMPORT binding (CI-1): `import foo from`, `import { foo }`, `import {
    // bar as foo }`, `import * as foo`, `import foo, { ... }`. An import is a
    // pure USE site (the real declaration lives in the imported module — which
    // the non-AST resolver finds separately and ranks ABOVE this), but it is a
    // navigable, meaningful site so it is its OWN low-rank 'import' kind rather
    // than being mis-tagged 'property' by the object-literal pattern below. It
    // is STRONGER than 'property' (so the `{ foo }` of an import line is reported
    // as 'import', not 'property') yet still a USE that NEVER outranks a real
    // declaration. Anchored to a leading `import` keyword so only genuine import
    // statements match (a plain `{ foo }` object literal is NOT an import).
    //   SEC (ReDoS): the gap before the symbol is a SINGLE negated class
    //   `[^;]*` with NO nested quantifier and no ambiguous-whitespace overlap
    //   (the only other quantifier is the leading `\s*`, separated from `[^;]*`
    //   by the literal `import` keyword), so matching is strictly linear; the
    //   per-line prefix clip bounds the line length regardless.
    {
      build: (ws) => new RegExp(`^\\s*import\\b[^;]*\\b${ws}\\b`),
      kind: 'import',
    },
    // Object-literal property: a `key:` either at the start of a trimmed line
    // (multi-line literal) OR immediately after a `{`/`,` (inline literal), OR
    // shorthand `{ foo }` / `, foo }`. LOW rank (GTD-5) — a USE, never
    // auto-jumped over a real declaration. The `[{,]`-or-line-start anchor
    // avoids mis-tagging a ternary `cond ? a : b` or a bare type annotation.
    {
      build: (ws) => new RegExp(`(?:^\\s*|[{,]\\s*)${ws}\\s*[:},]`),
      kind: 'property',
    },
    // Function PARAMETER: `(foo: T` / `, foo: T` / `(foo,` — LOW rank (GTD-5).
    {
      build: (ws) => new RegExp(`[(,]\\s*${ws}\\s*[:),]`),
      kind: 'parameter',
    },
  ];
}

/** TS-ONLY declaration forms (no JS analog). */
function tsOnly(): DefPattern[] {
  return [
    { build: (ws) => new RegExp(`\\binterface\\s+${ws}\\b`), kind: 'interface' },
    { build: (ws) => new RegExp(`\\btype\\s+${ws}\\b`), kind: 'type' },
    { build: (ws) => new RegExp(`\\benum\\s+${ws}\\b`), kind: 'enum' },
    {
      build: (ws) => new RegExp(`\\b(?:namespace|module)\\s+${ws}\\b`),
      kind: 'generic',
    },
  ];
}

/** Python declaration forms. */
function python(): DefPattern[] {
  return [
    { build: (ws) => new RegExp(`\\b(?:async\\s+)?def\\s+${ws}\\b`), kind: 'function' },
    { build: (ws) => new RegExp(`\\bclass\\s+${ws}\\b`), kind: 'class' },
    // Column-0 module-level assignment: FOO = ...  or  FOO: T = ...
    { build: (ws) => new RegExp(`^${ws}\\s*(?::[^=]+)?=`), kind: 'variable' },
    // def parameter / for-target etc. — low rank.
    { build: (ws) => new RegExp(`[(,]\\s*${ws}\\s*[:=,)]`), kind: 'parameter' },
  ];
}

/** TA-6: cap on plain whole-word OCCURRENCES emitted for the generic family
 *  (an unknown / no extension where we have no grammar at all). After the
 *  declaration-keyword union, we surface up to this many bare uses tagged with
 *  the weakest kind ('other') so an unknown-language symbol with NO recognized
 *  declaration form is still navigable as a last resort — but never auto-jumped
 *  over a real declaration, and bounded so a pathological file cannot flood the
 *  candidate list. */
const MAX_GENERIC_OCCURRENCES = 20;

/** Generic fallback for any other / no extension: a declaration-keyword union
 *  that covers Go / Rust / Kotlin / Java / C / C++ / Scala without a grammar,
 *  plus plain whole-word occurrences (emitted in the scan loop, capped at
 *  MAX_GENERIC_OCCURRENCES, kind 'other'). All generic matches rank LOWEST.
 *
 *  SEC-GTD-A / SEC-1 (ReDoS): the optional qualifier run between the keyword
 *  and the symbol MUST keep whitespace unambiguous. The earlier
 *  `(?:[A-Za-z0-9_$<>,\s]*\s)?` form put `\s` INSIDE the char class AND was
 *  flanked by the leading `\s+` and a trailing boundary, so a run of spaces
 *  could be claimed by both the leading `\s+` and the group — classic
 *  ambiguous-whitespace overlap that backtracks quadratically on a line of the
 *  shape `<keyword> <many spaces> <non-matching tail>` (measured ~14ms per
 *  clipped 4000-char line; ~minutes aggregated over the byte budget). The
 *  replacement `(?:[A-Za-z0-9_$<>,]+\s+)*` has NO `\s` in the char class: each
 *  qualifier token is a non-space run separated by a REQUIRED `\s+`, so every
 *  space belongs to exactly one construct (strictly linear — measured ~0.09ms
 *  per worst-case line, 158x faster) while preserving every legitimate match
 *  (`class fooBarBaz`, `public static final fooBarBaz`,
 *  `export interface Foo<T, U> extends Bar fooBarBaz`, `impl <T> Trait for
 *  fooBarBaz`, `const fooBarBaz = 1`). This mirrors the SEC-GTD-1 fix already
 *  applied to the method pattern; a generic-family ReDoS regression test pins
 *  it (test/definition.mjs). */
function generic(): DefPattern[] {
  return [
    {
      build: (ws) =>
        new RegExp(
          `\\b(?:def|function|func|fn|class|struct|interface|type|enum|trait|impl|const|let|var|val|public|private|protected|static|final)\\s+(?:[A-Za-z0-9_$<>,]+\\s+)*${ws}\\b`,
        ),
      kind: 'generic',
    },
  ];
}

/** The four extension FAMILIES. Adding a language = adding a family + a row. */
type ExtFamily = 'ts' | 'js' | 'py' | 'generic';

/** Map a (lowercased, dot-less) extension to its pattern family. */
function familyForExt(ext: string): ExtFamily {
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'py':
    case 'pyi':
      return 'py';
    default:
      return 'generic';
  }
}

/** Resolve the ordered pattern table for an extension family. The order is
 *  irrelevant to correctness (every line is tested against every pattern and
 *  the STRONGEST kind wins per (line,col) in the resolver) but kept stable for
 *  readability. */
function patternsForFamily(family: ExtFamily): DefPattern[] {
  switch (family) {
    case 'ts':
      // TS files use the full TS grammar AND the JS base (a .ts file has
      // functions, classes, consts too).
      return [...tsOnly(), ...tsJsBase()];
    case 'js':
      return tsJsBase();
    case 'py':
      return python();
    case 'generic':
    default:
      return generic();
  }
}

/** Rank a kind for the "strongest wins per coordinate" de-dupe inside this
 *  pure core (lower = stronger). MUST stay consistent with the resolver's
 *  declaration-kind strength so a (line,col) hit reports its strongest form.
 *  This is intentionally the SAME ordering definition.ts uses for ranking.
 *
 *  CI-1: the table is split into a DECLARATION band (0..7 — a real definition
 *  site) and a USE band (8..11 — an import binding / object-literal property /
 *  parameter / bare occurrence that is NOT a definition). isDeclarationKind()
 *  reads off this split, and the resolver compares the DECLARATION-vs-USE band
 *  BEFORE locality so a real declaration ANYWHERE outranks a use EVERYWHERE
 *  (an import of a symbol never beats the symbol's actual declaration, even
 *  when the import is in the same file the caret sits in). Note `generic`
 *  (namespace/module + the Go/Rust/Kotlin/Java keyword-union) IS a real
 *  declaration; only `other` (the bare whole-word fallback) is a pure use. */
const KIND_STRENGTH: Record<DefinitionKind, number> = {
  // --- DECLARATION band (a real definition site) ---
  class: 0,
  interface: 0,
  enum: 0,
  type: 1,
  function: 1,
  method: 2,
  variable: 3,
  destructured: 4,
  're-export': 5,
  generic: 7,
  // --- USE band (NOT a definition; always ranked below every declaration) ---
  import: 8,
  property: 9,
  parameter: 10,
  other: 11,
};

/** The strength at/above which a kind is a pure USE (import / property /
 *  parameter / bare occurrence), NOT a real declaration. The DECLARATION band
 *  is strictly below this. CI-1: the resolver compares this band split BEFORE
 *  locality so a real declaration always outranks a use, and the dispatch layer
 *  counts real declarations (not raw candidate count) for the 1-vs-many fork. */
const USE_BAND_FLOOR = 8;

/** True iff `kind` is a real DECLARATION site (vs a pure use). Shared single
 *  source of truth for the resolver ranking (CI-1) and — mirrored in
 *  definition-dispatch.ts's USE_ONLY_KINDS — the dispatch count (CI-2). */
export function isDeclarationKind(kind: DefinitionKind): boolean {
  return KIND_STRENGTH[kind] < USE_BAND_FLOOR;
}

/**
 * Find every DECLARATION of `symbol` in `text`, line by line, bounded.
 *
 * Pure + deterministic: identical input always yields identical output; no
 * clock, no randomness, no evaluation of the content. Returns at most one
 * DefMatch per (line, col) — the strongest kind for that coordinate — so a
 * line that matches several patterns at the same column is not double-counted.
 */
export function findDefinitionsInText(
  text: string,
  symbol: string,
  ext: string,
): DefMatch[] {
  const out: DefMatch[] = [];
  if (typeof text !== 'string' || typeof symbol !== 'string') return out;
  if (symbol.length === 0) return out;

  const escaped = escapeRegExp(symbol);
  const ws = wholeWord(escaped);
  const family = familyForExt(typeof ext === 'string' ? ext.toLowerCase() : '');
  const patterns = patternsForFamily(family);

  // A bare whole-word locator so we can compute the symbol's column on a line
  // that a declaration pattern matched. The pattern may match starting BEFORE
  // the symbol (e.g. "class " precedes "Foo"), so col must point at the symbol
  // itself, found via this locator on the same (untruncated) line.
  const wordRe = new RegExp(ws, 'g');

  // Same line model as search-core/highlightCode: trim ONE trailing newline,
  // then split on "\n", so 1-based line numbers align 1:1 with the Viewer.
  const lines = text.replace(/\n$/, '').split('\n');

  // Per (line,col) strongest-kind de-dupe within this file: key "line:col".
  const bestAt = new Map<string, DefMatch>();

  // TA-6: for the GENERIC family ONLY, after the declaration-keyword union we
  // surface plain whole-word OCCURRENCES (kind 'other', weakest rank) so an
  // unknown-language symbol with no recognized declaration form is still
  // navigable as a last resort. Bounded by MAX_GENERIC_OCCURRENCES so a
  // pathological file cannot flood the candidate list. (TS/JS/PY have rich
  // declaration tables, so they do NOT emit bare occurrences.)
  const emitGenericOccurrences = family === 'generic';
  let genericOccurrences = 0;

  for (let li = 0; li < lines.length; li++) {
    const fullLine = lines[li]!;
    // Bound the SCAN to a PREFIX (mirrors search-core SEC-2, but TIGHTER —
    // SEC-GTD-2): an absurdly long (minified / deeply-indented) line is clipped
    // so the per-line regex loop can never stall the main thread regardless of
    // any future pattern's cost; a declaration in the first
    // MAX_DEF_SCAN_LINE_LENGTH chars is still found, and col stays measured
    // against the scanned window.
    const scanLine =
      fullLine.length > MAX_DEF_SCAN_LINE_LENGTH
        ? fullLine.slice(0, MAX_DEF_SCAN_LINE_LENGTH)
        : fullLine;

    // Fast reject: the symbol does not occur as a whole word on this line.
    wordRe.lastIndex = 0;
    if (!wordRe.test(scanLine)) continue;

    // The DISPLAY text for this line (truncated for safety); col stays measured
    // against the original line so it is accurate past the cut.
    const displayText =
      scanLine.length > MAX_DEF_LINE_LENGTH
        ? scanLine.slice(0, MAX_DEF_LINE_LENGTH)
        : scanLine;

    for (const pat of patterns) {
      const re = pat.build(ws);
      if (!re.test(scanLine)) continue;

      // Locate EVERY whole-word occurrence of the symbol on this line and tag
      // each with this pattern's kind. A line may legitimately declare + use
      // the symbol (e.g. `const foo = foo + 1`); the strongest kind wins per
      // (line,col) so we never emit two rows for the same coordinate.
      wordRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = wordRe.exec(scanLine)) !== null) {
        const col = m.index + 1; // 1-based ORIGINAL-line column
        const key = `${li + 1}:${col}`;
        const existing = bestAt.get(key);
        if (
          existing === undefined ||
          KIND_STRENGTH[pat.kind] < KIND_STRENGTH[existing.kind]
        ) {
          bestAt.set(key, {
            line: li + 1,
            col,
            lineText: displayText,
            kind: pat.kind,
          });
        }
        // Zero-width-guard: wordRe always advances (the symbol has length >= 1),
        // but defend against a pathological empty match anyway.
        if (m.index === wordRe.lastIndex) wordRe.lastIndex += 1;
      }
    }

    // TA-6: generic plain-occurrence fallback. For an unknown extension, also
    // record bare uses (kind 'other') at any (line,col) not already claimed by
    // a stronger generic-keyword match, bounded by MAX_GENERIC_OCCURRENCES.
    if (emitGenericOccurrences && genericOccurrences < MAX_GENERIC_OCCURRENCES) {
      wordRe.lastIndex = 0;
      let g: RegExpExecArray | null;
      while (
        genericOccurrences < MAX_GENERIC_OCCURRENCES &&
        (g = wordRe.exec(scanLine)) !== null
      ) {
        const col = g.index + 1;
        const key = `${li + 1}:${col}`;
        if (!bestAt.has(key)) {
          bestAt.set(key, { line: li + 1, col, lineText: displayText, kind: 'other' });
          genericOccurrences++;
        }
        if (g.index === wordRe.lastIndex) wordRe.lastIndex += 1;
      }
    }

    // Stop scanning further lines once this file alone has hit its cap; the
    // accumulated bestAt is emitted (sorted) below.
    if (bestAt.size >= MAX_DEFS_PER_FILE) break;
  }

  // Emit in (line, col) order — a strict, reproducible order the resolver
  // re-ranks but relies on for determinism.
  for (const d of bestAt.values()) out.push(d);
  out.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.col - b.col));
  return out.length > MAX_DEFS_PER_FILE ? out.slice(0, MAX_DEFS_PER_FILE) : out;
}

/** Exported (test-only) so the suite can pin the per-file cap + the kind
 *  strength ordering + the per-line scan window + the generic occurrence cap
 *  without re-deriving the literals. */
export {
  MAX_DEFS_PER_FILE,
  MAX_DEF_SCAN_LINE_LENGTH,
  MAX_GENERIC_OCCURRENCES,
  KIND_STRENGTH,
  USE_BAND_FLOOR,
};
