/* ============================================================
 * Loom — project-wide content search (Law 3 confined, bounded)
 * ------------------------------------------------------------
 * createSearch(sandbox).run(query, opts) walks the ALREADY-CONFINED
 * sandbox tree (sandbox.buildTree()) — so it inherits every Law-3
 * exclusion for free (node_modules / .git / .loom / dotfiles, and any
 * symlink that escapes the root is already dropped from the tree) —
 * and for each TEXT file (md/code/svg/html; NEVER image/binary) reads
 * its confined UTF-8 content via sandbox.readFile() and runs the pure
 * matchFile() matcher.
 *
 * The SAME single confined walk ALSO matches each file's ROOT-RELATIVE
 * PATH against the query (case-insensitive by default), covering EVERY
 * file — including image/binary (logo.png, data.bin) — because name
 * matching needs no content read. These land in SearchResults.fileMatches
 * (bounded by MAX_FILE_NAME_MATCHES). The result reports WHICH list was
 * capped via truncatedNames / truncatedContent (so the UI can say which to
 * refine, UX-NAME-02); `truncated` stays as their OR for back-compat. There
 * is still ONLY ONE walker (Law 3); content + name matching share it.
 *
 * LAW 3: ALL file access goes through `sandbox`. There is NO second,
 * unconfined walker here. A path that resolves outside the root never
 * appears in buildTree(); readFile() re-proves containment on every
 * read; so an escaping symlink yields nothing.
 *
 * WINDOWS: every path used here is the sandbox's root-relative POSIX
 * ('/'-separated) form (FileNode.path), so it flows STRAIGHT into the
 * FileSearchResult.path / FileNameMatch.path contract unchanged, and is
 * the SAME string handed back to sandbox.readFile (which converts it to a
 * native path internally). locateNameMatch splits on '/' — correct because
 * the haystack is guaranteed POSIX. No native-separator handling leaks here.
 *
 * LAW 1 / DoS BOUNDS (a huge tree must not hang or OOM):
 *   - MAX_FILES   : cap the number of files we even attempt to scan.
 *   - MAX_TOTAL_MATCHES : cap the total matches collected across all
 *                   files; stop early once reached.
 *   - MAX_TOTAL_SCAN_BYTES : cap the TOTAL bytes of text read+scanned across
 *                   the whole run, REGARDLESS of match count. This is the key
 *                   availability bound (SEC-1/SEC-3): a low/zero-match query —
 *                   exactly what every intermediate keystroke produces while a
 *                   user types a longer term — can no longer read the entire
 *                   tree (MAX_FILES x MAX_TEXT_BYTES ≈ 3.9 GB) to completion and
 *                   block the main-process event loop. We stop after this many
 *                   bytes and set truncated=true, independent of match density.
 *   - per-file matchFile cap (search-core) bounds matches per file.
 *   - readFile returns text=null for image/binary AND for files over
 *     the sandbox size cap (MAX_TEXT_BYTES) — those are skipped here.
 *   When any bound is hit, `truncated` is set so the UI can say so.
 *
 * Empty / whitespace-only query returns an empty result set (no walk).
 * ============================================================ */
import type {
  FileNode,
  SearchQuery,
  SearchResults,
  FileSearchResult,
  FileNameMatch,
} from '../shared/types.js';
import type { Sandbox } from './sandbox.js';
import { matchFile } from './search-core.js';

export interface Search {
  /** Run a content search over the confined tree. Bounded + Law-3 safe. */
  run(query: SearchQuery): SearchResults;
}

/** Max number of files we attempt to read+scan in a single run (bound).
 *  Exported (GTD-8) so the go-to-definition resolver re-uses ONE source of
 *  truth for the file-walk cap instead of hand-copying 2000 — a parity test
 *  fails CI if the two ever drift. */
export { MAX_FILES };
const MAX_FILES = 2_000;
/** Max total matches collected across all files before we stop early. */
const MAX_TOTAL_MATCHES = 2_000;
/** Exported (test-only) so the acceptance suite can prove the global
 *  scanned-bytes budget aborts a zero-match run without depending on the
 *  literal value here. */
export { MAX_TOTAL_SCAN_BYTES };
/** Max TOTAL bytes (UTF-16 code units of file text) read+scanned across a
 *  single run, regardless of how many matches accumulate (SEC-1/SEC-3). At
 *  ~64 MB this comfortably covers a real project's text corpus while making a
 *  zero/low-match query (every intermediate keystroke) bounded — it can never
 *  read the whole tree to completion and stall the main thread. When exceeded
 *  the run stops and reports truncated=true. */
const MAX_TOTAL_SCAN_BYTES = 64 * 1024 * 1024;

/** Max number of FILE-NAME (path) matches collected in a single run (bound).
 *  Name matching reads no content, but a pathological tree could still have a
 *  huge number of path hits, so we cap the list and reuse `truncated`.
 *  Exported (test-only) so the acceptance suite can prove the cap without
 *  depending on the literal value here. */
export { MAX_FILE_NAME_MATCHES };
const MAX_FILE_NAME_MATCHES = 200;

/** FileKinds whose textual content we search. Mirrors sandbox.isTextKind /
 *  the dispatch table: md/code/svg/html are text; image/binary are NEVER read.
 *  (We additionally rely on readFile returning text=null for the latter, so
 *  this is a fast pre-filter, not the security boundary.) */
const TEXT_KINDS: ReadonlySet<string> = new Set(['md', 'code', 'svg', 'html']);

export function createSearch(sandbox: Sandbox): Search {
  /** Locate the FIRST match of `needle` within a root-relative path (`hayPath`
   *  is the path already case-folded to match `needle`'s casing), preferring a
   *  hit on the BASENAME when present (so the highlight lands on the file name a
   *  user is most likely scanning) and falling back to anywhere in the full
   *  path. Returns the [start, end) char span INTO the path, or null when the
   *  path does not match. The span indexes the path verbatim (case-folding
   *  preserves positions), so it is valid against the original-cased path too. */
  function locateNameMatch(
    hayPath: string,
    needle: string,
  ): { matchStart: number; matchEnd: number } | null {
    const needleLen = needle.length;
    if (needleLen === 0) return null;
    // Prefer the basename: index of the last '/' in the (case-folded) path.
    const slash = hayPath.lastIndexOf('/');
    const baseStart = slash >= 0 ? slash + 1 : 0;
    const inBase = hayPath.indexOf(needle, baseStart);
    if (inBase >= 0) {
      return { matchStart: inBase, matchEnd: inBase + needleLen };
    }
    // Otherwise, the match must fall in the directory portion of the path.
    const anywhere = hayPath.indexOf(needle);
    if (anywhere >= 0) {
      return { matchStart: anywhere, matchEnd: anywhere + needleLen };
    }
    return null;
  }

  function run(req: SearchQuery): SearchResults {
    const query = typeof req?.query === 'string' ? req.query : '';
    const caseSensitive = req?.caseSensitive === true;

    // Empty / whitespace-only query: no walk, no results.
    if (query.trim().length === 0) {
      return {
        results: [],
        fileMatches: [],
        truncated: false,
        truncatedNames: false,
        truncatedContent: false,
        total: 0,
      };
    }

    // Walk the filesystem on the fly (confined + skip-filtered), bounded by
    // MAX_FILES. This does NOT materialize the explorer tree (which is now
    // shallow/lazy) — search owns its own traversal. A single walk feeds BOTH
    // name + content matching below.
    const files: FileNode[] = sandbox.walkFiles(MAX_FILES);
    // We hit the file cap during collection -> the run is partial. The file cap
    // bounds the SHARED file list, so it can hide BOTH unseen file-NAMES and
    // unseen CONTENT matches — attribute it to both discriminators (UX-NAME-02).
    const hitFileCap = files.length >= MAX_FILES;
    // WHICH list is partial — so the UI can phrase an actionable caveat
    // (UX-NAME-02): names capped vs content capped vs both. `truncated` below
    // is the OR of these (the legacy single flag, kept for back-compat).
    let truncatedNames = hitFileCap;
    let truncatedContent = hitFileCap;

    // File-NAME matching (ADDITIVE): test EVERY file's root-relative path against
    // the query — no content read, so it covers image/binary too. Bounded by
    // MAX_FILE_NAME_MATCHES; reuses `truncated`. The needle is folded to match
    // the haystack casing (default insensitive; caseSensitive opt honored).
    const fileMatches: FileNameMatch[] = [];
    const nameNeedle = caseSensitive ? query : query.toLowerCase();
    for (const file of files) {
      if (fileMatches.length >= MAX_FILE_NAME_MATCHES) {
        truncatedNames = true;
        break;
      }
      const hayPath = caseSensitive ? file.path : file.path.toLowerCase();
      const span = locateNameMatch(hayPath, nameNeedle);
      if (span !== null) {
        fileMatches.push({
          path: file.path,
          matchStart: span.matchStart,
          matchEnd: span.matchEnd,
        });
      }
    }

    const results: FileSearchResult[] = [];
    let total = 0;
    // Running tally of text bytes (code units) read+scanned this run. Bounds the
    // worst case independently of match density (SEC-1/SEC-3): a zero-match query
    // stops once this exceeds MAX_TOTAL_SCAN_BYTES instead of reading the whole
    // tree to completion.
    let scannedBytes = 0;

    for (const file of files) {
      if (total >= MAX_TOTAL_MATCHES) {
        truncatedContent = true;
        break;
      }
      // Global scanned-bytes budget (SEC-1/SEC-3): stop BEFORE reading another
      // file once we have already scanned the budget, so a low/zero-match query
      // can never read the entire tree and block the event loop.
      if (scannedBytes >= MAX_TOTAL_SCAN_BYTES) {
        truncatedContent = true;
        break;
      }
      // CONTENT scan is TEXT-only (unchanged): fast pre-filter so image/binary
      // files — now present in `files` for NAME matching — are never read here.
      // (readFile would also return text=null for them; this avoids the call.)
      if (file.kind === undefined || !TEXT_KINDS.has(file.kind)) continue;
      let text: string | null;
      try {
        // Law 3: readFile re-proves containment on EVERY read and returns
        // text=null for image/binary OR for a file over the size cap — both
        // are skipped. An escaping symlink would throw / never be in the tree.
        const content = sandbox.readFile(file.path);
        text = content.text;
      } catch {
        // A file that vanished mid-walk or failed containment: skip silently.
        continue;
      }
      if (text === null) continue; // image/binary/oversize — never scanned

      // Count this file's text toward the global budget BEFORE matching (the
      // scan cost is proportional to its length).
      scannedBytes += text.length;

      const matches = matchFile(text, query, { caseSensitive });
      if (matches.length === 0) continue;

      results.push({ path: file.path, matches });
      total += matches.length;
    }

    // The legacy single flag is the OR of the two discriminators (back-compat).
    const truncated = truncatedNames || truncatedContent;
    return { results, fileMatches, truncated, truncatedNames, truncatedContent, total };
  }

  return { run };
}
