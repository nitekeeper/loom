/* ============================================================
 * Loom — heuristic "go to definition" resolver (Law 1 / Law 3 confined)
 * ------------------------------------------------------------
 * createDefinitionFinder(sandbox).find(req) is the MAIN-process owner of
 * go-to-definition. It RE-VALIDATES the renderer-supplied symbol, walks
 * the ALREADY-CONFINED sandbox tree (sandbox.walkFiles — inheriting every
 * Law-3 exclusion for free), reads each TEXT file via sandbox.readFile
 * (which re-proves containment on every read and returns text=null for
 * image/binary/oversize), runs the pure regex core (definition-core.ts),
 * ranks + de-dupes the matches, caps them, and returns
 * { candidates, truncated }.
 *
 * This is the NON-AST fallback Loom uses instead of a language server /
 * tree-sitter / ctags (all forbidden — Loom is a self-contained local
 * substrate with no external indexer dependency). Mirrors search.ts in
 * structure, bounds, and Law-3 discipline.
 *
 * SECURITY (Law 3): the resolver constructs NO paths and trusts NO
 * renderer-supplied path. The renderer sends ONLY a bounded symbol string
 * plus an OPTIONAL advisory fromPath used ONLY for ranking — fromPath is
 * re-confined via sandbox.resolveInRoot inside try/catch and DROPPED on any
 * throw (.. / NUL / symlink escape); it never reaches a read. Every returned
 * candidate path comes from the resolver's OWN confined walk, and is later
 * re-opened only via store.selectFile -> READ_FILE -> sandbox.readFile ->
 * resolveInRoot, which re-proves containment.
 *
 * SECURITY (Law 1 / DoS): the same bounds as search.ts — MAX_FILES (the
 * SHARED exported cap), MAX_TOTAL_SCAN_BYTES (64 MB), MAX_SCAN_LINE_LENGTH
 * (per-line prefix scan, inside the core), plus MAX_DEFS (200 candidate
 * cap) — so a pathological repo/file cannot stall the main thread. On any
 * cap we set truncated:true and stop early.
 *
 * KNOWN LIMITS (fundamental to a non-AST resolver, documented in
 * definition-core.ts): no scope/type resolution, imports/aliases not
 * followed, per-line string/comment fidelity only. The ranking + the
 * multi-candidate picker disambiguate; object-literal-property / parameter
 * matches are TAGGED + sunk in rank rather than excluded so the picker can
 * still surface them last-resort but never auto-jumps to a use over a real
 * declaration (GTD-5).
 * ============================================================ */
import type {
  FileNode,
  DefinitionQuery,
  DefinitionResult,
  DefinitionCandidate,
} from '../shared/types.js';
import type { Sandbox } from './sandbox.js';
import {
  findDefinitionsInText,
  KIND_STRENGTH,
  isDeclarationKind,
} from './definition-core.js';
import { MAX_FILES, MAX_TOTAL_SCAN_BYTES } from './search.js';
import { extensionOf } from '../shared/dispatch.js';

export interface DefinitionFinder {
  /** Resolve definitions for a (re-validated) symbol query. Bounded + Law-3. */
  find(req: unknown): DefinitionResult;
}

/** Max length of an accepted symbol (defensive bound — a real identifier is
 *  far shorter; a longer "symbol" is malformed / hostile input). */
const MAX_SYMBOL_LENGTH = 128;

/** Max candidates returned across the whole walk (mirrors search.ts's
 *  MAX_FILE_NAME_MATCHES=200). On overflow we set truncated:true + stop. */
const MAX_DEFS = 200;

/** FileKinds whose textual content we scan. Mirrors search.ts TEXT_KINDS /
 *  sandbox.isTextKind: md/code/svg/html are text; image/binary are NEVER read
 *  (readFile would also return text=null — this is a fast pre-filter, not the
 *  security boundary). */
const TEXT_KINDS: ReadonlySet<string> = new Set(['md', 'code', 'svg', 'html']);

/** A single identifier (ASCII + $/_). Matches highlight.ts's IDENT class so a
 *  symbol the renderer extracted round-trips. A symbol failing this is a path,
 *  multi-token text, or a regex metachar — rejected. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Keyword / literal set re-filtered in MAIN (defense in depth — the symbol
 *  arrives over IPC, so we never trust the renderer's own rejection). Kept in
 *  sync with highlight.ts's KEYWORDS ∪ LITERALS; a small local copy is fine
 *  because main must NOT import a renderer DOM module's private sets, and the
 *  renderer's wordAt already rejects these too. */
const REJECTED_WORDS: ReadonlySet<string> = new Set([
  // KEYWORDS
  'import', 'from', 'export', 'default', 'const', 'let', 'var', 'function',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'async', 'await', 'new', 'class', 'extends', 'try', 'catch',
  'finally', 'throw', 'type', 'interface', 'as', 'of', 'in', 'typeof',
  'instanceof', 'void', 'yield', 'this', 'super',
  // LITERALS
  'true', 'false', 'null', 'undefined', 'NaN',
]);

/** Locality tier of a candidate relative to the (advisory, confined) fromPath:
 *  0 same file, 1 same directory, 2 elsewhere. Ancestor/descendant is folded
 *  into 'elsewhere' for v1 (GTD-10). */
function localityTier(
  candidatePath: string,
  fromDir: string | null,
  fromPath: string | null,
): number {
  if (fromPath !== null && candidatePath === fromPath) return 0;
  if (fromDir !== null && dirOf(candidatePath) === fromDir) return 1;
  return 2;
}

/** The directory portion of a root-relative POSIX path ('' for a root file). */
function dirOf(posixPath: string): string {
  const i = posixPath.lastIndexOf('/');
  return i >= 0 ? posixPath.slice(0, i) : '';
}

/** True iff the line declaring the match exports it (a cheap visibility cue —
 *  an exported declaration ranks above a private one). Looks for an `export`
 *  keyword at the start of the trimmed line; not exhaustive (a separate
 *  `export { foo }` is its own 're-export' kind), just a ranking nudge. */
function looksExported(lineText: string): boolean {
  return /^\s*export\b/.test(lineText);
}

export function createDefinitionFinder(sandbox: Sandbox): DefinitionFinder {
  function find(req: unknown): DefinitionResult {
    // (1) Coerce + (2) reject empty/whitespace (mirrors search.run).
    const raw =
      typeof (req as DefinitionQuery | undefined)?.symbol === 'string'
        ? (req as DefinitionQuery).symbol.trim()
        : '';
    if (raw.length === 0) return { candidates: [], truncated: false };

    // (3) length cap; (4) single-identifier shape; (4b) keyword/literal reject.
    if (raw.length > MAX_SYMBOL_LENGTH) return { candidates: [], truncated: false };
    if (!IDENT_RE.test(raw)) return { candidates: [], truncated: false };
    if (REJECTED_WORDS.has(raw)) return { candidates: [], truncated: false };

    const symbol = raw;

    // Advisory fromPath: re-confine via resolveInRoot in try/catch, DROP on any
    // throw. It is NEVER a read target — used ONLY for locality ranking. We keep
    // the ROOT-RELATIVE POSIX form the renderer sent (validated to be in-root)
    // so it compares like-for-like with candidate.path (also root-relative).
    let fromPath: string | null = null;
    let fromDir: string | null = null;
    const advisory = (req as DefinitionQuery | undefined)?.fromPath;
    if (typeof advisory === 'string' && advisory.length > 0) {
      try {
        sandbox.resolveInRoot(advisory); // throws if it escapes — we only gate
        fromPath = advisory;
        fromDir = dirOf(advisory);
      } catch {
        fromPath = null; // escape / NUL / '..' — dropped, never trusted
        fromDir = null;
      }
    }

    // Walk the confined tree (bounded by MAX_FILES). A single walk feeds the
    // whole resolution; inherits every Law-3 exclusion from sandbox.walkFiles.
    const files: FileNode[] = sandbox.walkFiles(MAX_FILES);
    const hitFileCap = files.length >= MAX_FILES;

    const candidates: DefinitionCandidate[] = [];
    let truncated = hitFileCap;
    let scannedBytes = 0;

    for (const file of files) {
      if (candidates.length >= MAX_DEFS) {
        truncated = true;
        break;
      }
      // Global scanned-bytes budget (mirrors search.ts SEC-1/SEC-3): stop BEFORE
      // reading another file once the budget is spent, so a no-match symbol can
      // never read the entire tree and block the event loop.
      //
      // SEC-GTD-2 (time-vs-bytes): this budget is checked only BETWEEN files, so
      // it bounds total INPUT but NOT the wall-clock TIME spent inside
      // findDefinitionsInText for a single file/line. Per-line CPU is bounded
      // INSTEAD by (a) every pattern being strictly linear (SEC-GTD-1) and (b)
      // the core's tight MAX_DEF_SCAN_LINE_LENGTH per-line prefix clip. The next
      // pattern author MUST keep patterns linear: this byte budget will NOT save
      // a quadratic pattern.
      if (scannedBytes >= MAX_TOTAL_SCAN_BYTES) {
        truncated = true;
        break;
      }
      // TEXT-only pre-filter (fast): image/binary are never read here.
      if (file.kind === undefined || !TEXT_KINDS.has(file.kind)) continue;

      let text: string | null;
      try {
        // Law 3: readFile re-proves containment on EVERY read and returns
        // text=null for image/binary OR a file over the size cap.
        text = sandbox.readFile(file.path).text;
      } catch {
        continue; // vanished mid-walk / failed containment — skip silently
      }
      if (text === null) continue;

      scannedBytes += text.length;

      const ext = extensionOf(file.path);
      const matches = findDefinitionsInText(text, symbol, ext);
      for (const m of matches) {
        if (candidates.length >= MAX_DEFS) {
          truncated = true;
          break;
        }
        candidates.push({
          path: file.path,
          line: m.line,
          col: m.col,
          lineText: m.lineText,
          kind: m.kind,
        });
      }
    }

    rankCandidates(candidates, fromDir, fromPath);

    return { candidates, truncated };
  }

  return { find };
}

/** Rank candidates in place to a STRICT TOTAL ORDER (so the single-jump
 *  decision and picker order are stable/reproducible):
 *    1. DECLARATION vs USE band (CI-1): a real declaration (class / function /
 *       const / interface / ... — isDeclarationKind true) ALWAYS outranks a
 *       pure use (import binding / object-literal property / parameter / bare
 *       occurrence), REGARDLESS of locality. This is the core "jump to the
 *       definition" promise: F12 on a freshly-imported symbol must land on the
 *       cross-file declaration, not the same-file `import { X }` line. Locality
 *       only breaks ties WITHIN a band (among declarations, or among uses).
 *    2. locality tier (same-file 0, same-dir 1, elsewhere 2),
 *    3. export visibility (exported 0 before non-exported 1),
 *    4. declaration-kind strength (KIND_STRENGTH — class/iface/enum strongest;
 *       within the use band import < property < parameter < other; GTD-5),
 *    5. earliest position (line then col),
 *    6. path lexicographic (root-relative POSIX) — FINAL tie-break that
 *       guarantees a strict total order over otherwise-equal candidates.
 */
function rankCandidates(
  candidates: DefinitionCandidate[],
  fromDir: string | null,
  fromPath: string | null,
): void {
  // De-dupe by (path,line,col) keeping the STRONGEST kind — two patterns can
  // tag the same coordinate; the resolver should report exactly one row for it.
  const byKey = new Map<string, DefinitionCandidate>();
  for (const c of candidates) {
    const key = `${c.path}:${c.line}:${c.col}`;
    const existing = byKey.get(key);
    if (
      existing === undefined ||
      KIND_STRENGTH[c.kind] < KIND_STRENGTH[existing.kind]
    ) {
      byKey.set(key, c);
    }
  }
  const deduped = [...byKey.values()];

  const exportRank = (c: DefinitionCandidate): number =>
    looksExported(c.lineText) ? 0 : 1;

  deduped.sort((a, b) => {
    // (1) DECLARATION before USE — CI-1: a real declaration anywhere beats a
    // use everywhere (the import/property/parameter of a symbol never outranks
    // its actual declaration, even when the use is in the same file).
    const da = isDeclarationKind(a.kind) ? 0 : 1;
    const db = isDeclarationKind(b.kind) ? 0 : 1;
    if (da !== db) return da - db;
    // (2) locality, applied WITHIN a band (among declarations, or among uses).
    const la = localityTier(a.path, fromDir, fromPath);
    const lb = localityTier(b.path, fromDir, fromPath);
    if (la !== lb) return la - lb;
    const ea = exportRank(a);
    const eb = exportRank(b);
    if (ea !== eb) return ea - eb;
    const ka = KIND_STRENGTH[a.kind];
    const kb = KIND_STRENGTH[b.kind];
    if (ka !== kb) return ka - kb;
    if (a.line !== b.line) return a.line - b.line;
    if (a.col !== b.col) return a.col - b.col;
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });

  // Write the ranked, de-duped list back into the caller's array.
  candidates.length = 0;
  candidates.push(...deduped);
}

/** Exported (test-only) so the suite can pin the bounds + symbol gate without
 *  re-deriving literals. */
export { MAX_DEFS, MAX_SYMBOL_LENGTH };
