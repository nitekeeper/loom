/* ============================================================
 * Loom — pure content-search matcher (Law 1 / Law 3 safe, bounded)
 * ------------------------------------------------------------
 * matchFile(text, query, opts) scans already-confined UTF-8 text for a
 * substring query and returns the per-line match coordinates the
 * renderer needs to display + highlight hits. It is PURE: no fs, no
 * DOM, no Node API, no evaluation of the content — it only reads the
 * string it is handed (which sandbox.readFile already proved confined).
 *
 * DESIGN (mirrors lib/fold.ts + lib/highlight.ts):
 *   - Line model MATCHES highlightCode/computeFoldRanges: a single
 *     trailing "\n" is trimmed, then split on "\n", so 1-based line
 *     numbers returned here align 1:1 with the Viewer's rendered rows
 *     (so "open at line" lands on the exact source row).
 *   - default case-INSENSITIVE substring; opts.caseSensitive flips it.
 *   - matchStart/matchEnd are character offsets INTO lineText (the
 *     possibly-truncated display string), so the renderer can wrap the
 *     matched run in a <mark> over escaped text without re-searching.
 *   - col is the 1-based column of the match in the ORIGINAL line (so
 *     it stays accurate even when a long line is truncated for display).
 *   - BOUNDS so a pathological file can't blow up the UI/main thread:
 *       * cap matches PER FILE (maxPerFile, default 50),
 *       * skip absurdly long lines for the SCAN entirely above a hard
 *         length ceiling (they are display-truncated regardless),
 *       * truncate lineText for DISPLAY (maxLineLength, default 200)
 *         while keeping col accurate.
 *   - Empty / whitespace-only query yields no matches (the caller also
 *     short-circuits a blank query, but this is defensive).
 * ============================================================ */

/** One match within a single line of a file. */
export interface LineMatch {
  /** 1-based line number (aligns with the Viewer's rendered rows). */
  line: number;
  /** 1-based column of the match start in the ORIGINAL (untruncated) line. */
  col: number;
  /** The line's display text (truncated to maxLineLength for safety). */
  lineText: string;
  /** Match start offset INTO lineText (0-based char index). */
  matchStart: number;
  /** Match end offset INTO lineText (exclusive, 0-based char index). */
  matchEnd: number;
}

/** Tuning + behavior knobs for matchFile. All optional with safe defaults. */
export interface MatchOptions {
  /** Case-sensitive substring match. Default false (case-insensitive). */
  caseSensitive?: boolean;
  /** Max matches returned PER FILE before stopping (bound). Default 50. */
  maxPerFile?: number;
  /** Display truncation length for lineText (chars). Default 200. */
  maxLineLength?: number;
}

/** Default cap on matches returned per file (DoS / UI bound). */
export const DEFAULT_MAX_PER_FILE = 50;
/** Default display truncation length for a result line (chars). */
export const DEFAULT_MAX_LINE_LENGTH = 200;
/** Hard ceiling on how MANY characters of a single line the scanner inspects.
 *  A multi-megabyte minified line (one-line bundle / single-line JSON) cannot
 *  stall the per-line indexOf loop because we only scan the first
 *  MAX_SCAN_LINE_LENGTH chars. SEC-2: we scan a bounded PREFIX of an over-length
 *  line rather than skipping it entirely, so an EARLY match (the common case —
 *  minified/one-line files are exactly where users search) is still found.
 *  A match past the prefix is not reported (acceptable for a search affordance).
 *  Exported so the acceptance suite can prove an in-window match on an
 *  over-length line is found (SEC-2 regression). */
export const MAX_SCAN_LINE_LENGTH = 50_000;

/**
 * Find every substring match of `query` in `text`, line by line, bounded.
 *
 * Pure + deterministic: identical input always yields identical output; no
 * clock, no randomness, no evaluation of the content.
 */
export function matchFile(
  text: string,
  query: string,
  opts: MatchOptions = {},
): LineMatch[] {
  const matches: LineMatch[] = [];
  if (typeof text !== 'string' || typeof query !== 'string') return matches;
  // A blank/whitespace-only query matches nothing (defensive; the caller also
  // short-circuits). An empty needle would otherwise match every position.
  if (query.length === 0) return matches;

  const caseSensitive = opts.caseSensitive === true;
  const maxPerFile = clampPositive(opts.maxPerFile, DEFAULT_MAX_PER_FILE);
  const maxLineLength = clampPositive(opts.maxLineLength, DEFAULT_MAX_LINE_LENGTH);

  // Same line model as highlightCode/computeFoldRanges: trim ONE trailing
  // newline, then split on "\n", so line indices align 1:1 with the Viewer.
  const lines = text.replace(/\n$/, '').split('\n');
  // The needle we actually search with (folded to lower-case when insensitive).
  const needle = caseSensitive ? query : query.toLowerCase();
  const needleLen = query.length;

  for (let li = 0; li < lines.length; li++) {
    const fullLine = lines[li]!;
    // Bound the SCAN to a PREFIX (SEC-2): an absurdly long (e.g. minified) line
    // is clipped to MAX_SCAN_LINE_LENGTH chars so the per-line indexOf loop can
    // never stall the main thread, but a match in the first MAX_SCAN_LINE_LENGTH
    // chars (column 1 of a minified bundle / single-line JSON) is STILL found —
    // it is no longer silently dropped. A match past the prefix is not reported,
    // which is acceptable for a content-search affordance. col stays measured
    // against the original line so it is accurate within the scanned window.
    const rawLine =
      fullLine.length > MAX_SCAN_LINE_LENGTH
        ? fullLine.slice(0, MAX_SCAN_LINE_LENGTH)
        : fullLine;

    // The haystack we search (case-folded when insensitive). col + offsets are
    // computed against the SAME length string, so they stay correct.
    const hay = caseSensitive ? rawLine : rawLine.toLowerCase();

    // UX-SEARCH-02: left-strip leading indentation for DISPLAY so a deeply-
    // indented source line does not begin with a wide blank run that pushes the
    // matched token (and its highlight) off the right edge under `white-space:
    // pre` + ellipsis. We strip the leading whitespace from the DISPLAY string
    // only; `col` (the 1-based ORIGINAL column) is unchanged so coordinates stay
    // accurate, and match offsets are shifted left by the stripped amount so the
    // highlight still wraps the correct run in the trimmed text.
    const leadingWs = rawLine.length - rawLine.replace(/^[ \t]+/, '').length;
    const trimmed = leadingWs > 0 ? rawLine.slice(leadingWs) : rawLine;

    // The DISPLAY string for this line: leading indentation stripped, then
    // truncated for safety. col is always measured against the original line so
    // it stays accurate past both the trim and the cut.
    const displayText =
      trimmed.length > maxLineLength ? trimmed.slice(0, maxLineLength) : trimmed;

    let from = 0;
    for (;;) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;

      // matchStart/matchEnd are offsets INTO displayText. The match index `idx`
      // is into the original (untrimmed) line, so shift it left by the stripped
      // leading whitespace, clamp to >=0 (a match INSIDE the indentation is rare
      // but possible), and clamp to the display length so an out-of-window match
      // is not highlighted. col stays the true original column regardless.
      const shifted = idx - leadingWs;
      const matchStart = Math.max(0, Math.min(shifted, displayText.length));
      const matchEnd = Math.max(
        matchStart,
        Math.min(shifted + needleLen, displayText.length),
      );

      matches.push({
        line: li + 1, // 1-based
        col: idx + 1, // 1-based, ORIGINAL-line column
        lineText: displayText,
        matchStart,
        matchEnd,
      });

      if (matches.length >= maxPerFile) return matches;

      // Advance past this match start by at least one to find the NEXT hit on
      // the same line (multiple hits per line). Step by needle length so
      // overlapping self-matches are not double counted.
      from = idx + Math.max(1, needleLen);
    }
  }

  return matches;
}

/** Coerce a candidate cap to a positive finite integer, else the fallback. */
function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}
