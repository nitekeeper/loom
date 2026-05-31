/* ============================================================
 * Loom — read-only syntax highlighter (port of design/highlight.jsx)
 * ------------------------------------------------------------
 * A lightweight per-line tokenizer (string / comment / number /
 * keyword / function / punctuation). Read-only: it NEVER executes
 * content, it only wraps tokens in <span class="tok-*">. Per-line
 * scanning keeps the gutter line numbers honest (Law 1, FR-6, AC-3b).
 *
 * SECURITY: every emitted token MUST be HTML-escaped first
 * (escapeHtml) so source code can never inject markup. The ONLY
 * non-escaped substrings this module produces are the fixed
 * <span class="tok-*"> / </span> wrappers — which contain no
 * user-controlled bytes — and the literal "&nbsp;" used for blank
 * lines. Output is an array of escaped HTML strings, one per line,
 * injected via React dangerouslySetInnerHTML in the Viewer.
 *
 * Ported verbatim-in-behavior from the prototype's highlightLine /
 * highlightCode to TypeScript (see ADR-0007).
 * ============================================================ */

/** Escape &, <, > so no source text is ever interpreted as markup.
 *  '&' MUST be escaped first so the literal ampersands we introduce
 *  for '<'/'>' are not themselves double-escaped, and so an input
 *  like "&lt;" stays inert rather than collapsing into a real '<'. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const KEYWORDS: ReadonlySet<string> = new Set([
  'import', 'from', 'export', 'default', 'const', 'let', 'var', 'function',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'async', 'await', 'new', 'class', 'extends', 'try', 'catch',
  'finally', 'throw', 'type', 'interface', 'as', 'of', 'in', 'typeof',
  'instanceof', 'void', 'yield', 'this', 'super',
]);
const LITERALS: ReadonlySet<string> = new Set(['true', 'false', 'null', 'undefined', 'NaN']);

/* Tokenize one line. No multi-line constructs in the sample set, so
   per-line scanning is safe and keeps the gutter aligned.
   Token groups:
     1 = line comment / shebang / single-line html comment
     2 = single/double/back-quoted string (with escapes)
     3 = number
     4 = identifier / word
     5 = punctuation run */
export function highlightLine(line: string): string {
  const re =
    /(\/\/[^\n]*|#![^\n]*|<!--.*?-->)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\].,;:<>=+\-*/%!?&|]+)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out += escapeHtml(line.slice(last, m.index));
    if (m[1] !== undefined) {
      out += `<span class="tok-com">${escapeHtml(m[1])}</span>`;
    } else if (m[2] !== undefined) {
      out += `<span class="tok-str">${escapeHtml(m[2])}</span>`;
    } else if (m[3] !== undefined) {
      out += `<span class="tok-num">${escapeHtml(m[3])}</span>`;
    } else if (m[4] !== undefined) {
      const w = m[4];
      const after = line.slice(re.lastIndex);
      if (KEYWORDS.has(w) || LITERALS.has(w)) {
        out += `<span class="tok-kw">${escapeHtml(w)}</span>`;
      } else if (/^\s*\(/.test(after)) {
        out += `<span class="tok-fn">${escapeHtml(w)}</span>`;
      } else {
        out += escapeHtml(w);
      }
    } else if (m[5] !== undefined) {
      out += `<span class="tok-punc">${escapeHtml(m[5])}</span>`;
    }
    last = re.lastIndex;
    // Zero-length match guard: a punctuation/keyword run can never be
    // empty, but defend against a pathological regex stall regardless.
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (last < line.length) out += escapeHtml(line.slice(last));
  return out || '&nbsp;';
}

/** Split code into lines and highlight each (line-number safe).
 *  A single trailing newline is trimmed so the gutter does not show a
 *  spurious empty final line; interior blank lines are preserved. */
export function highlightCode(code: string): string[] {
  return code.replace(/\n$/, '').split('\n').map(highlightLine);
}
