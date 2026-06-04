/* ============================================================
 * Loom — safe markdown renderer (FR-5, FR-48, FR-52, AC-21/22, Law 1)
 * ------------------------------------------------------------
 * The SINGLE safe renderer that serves BOTH the Viewer (.md full
 * render) and Chat message bodies (inline render). There must be
 * exactly one renderer; both panes import from here (no second
 * markdown path).
 *
 * Threat model: the input markdown is HOSTILE, agent-authored
 * content. Output is injected via React dangerouslySetInnerHTML, so
 * every byte we emit must be either (a) HTML-escaped user text or
 * (b) a fixed structural tag containing no user-controlled bytes.
 *
 * Safety configuration (defense in depth, layered with index.html CSP):
 *   - html: false   -> raw/embedded HTML tokens are EMITTED ESCAPED,
 *                      never interpreted as markup (FR-5, FR-52, AC-22).
 *   - linkify: false -> no autolinking of URL-like text.
 *   - link_open override -> EVERY link is neutralized: the real href
 *                      is dropped, replaced with href="#", the original
 *                      target preserved only in a data-* attribute for
 *                      display/debugging, and rel locked down. No
 *                      agent-authored link can navigate (FR-48, AC-21).
 *   - image override -> images are NOT decoded/loaded; they render as
 *                      an inert text label (Law 2 placeholder policy;
 *                      complements CSP img-src 'self' data:).
 *   - html_block / html_inline overrides -> belt-and-braces escape of
 *                      any raw HTML even if html:true were ever set.
 *   - fence / code_block -> highlighted via lib/highlight.ts, emitting
 *                      the <pre class="md-code"><code> + <span class="ln">
 *                      structure the renderer.css expects.
 * ============================================================ */
import MarkdownIt from 'markdown-it';
import { escapeHtml, highlightCode } from './highlight.js';
import { safeExternalUrl } from '../../shared/url.js';

/* ------------------------------------------------------------------ */
/* Single shared, hardened markdown-it instance.                       */
/* ------------------------------------------------------------------ */

const md = new MarkdownIt({
  // Raw HTML is NEVER interpreted — it is emitted as escaped text.
  html: false,
  // No autolinking; only explicit [text](url) markdown links, all of
  // which we neutralize below.
  linkify: false,
  // No typographic substitution; keep output predictable.
  typographer: false,
  // Do NOT auto-highlight via the `highlight` option; we override the
  // fence/code_block renderer rules directly so the markup structure
  // (md-code / ln) is exactly under our control.
});

/** The exact RenderRule signature, derived from the markdown-it instance
 *  so we never reference the namespace as a value (keeps tsc happy under
 *  `export =` typings). */
type MdRenderRule = NonNullable<typeof md.renderer.rules.fence>;

/** One markdown-it token, derived from the render-rule signature so we never
 *  reference the markdown-it namespace as a value (keeps tsc happy under the
 *  `export =` typings). */
type MdToken = Parameters<MdRenderRule>[0][number];

/** The first `inline` token of the block opened at `tokens[start]`, scanning
 *  forward until the matching `stopType` close (or end). Used by the task-list
 *  and alert core rules to reach a block's first line of inline content. */
function firstInlineOf(
  tokens: MdToken[],
  start: number,
  stopType: string,
): MdToken | undefined {
  for (let k = start + 1; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t === undefined || t.type === stopType) return undefined;
    if (t.type === 'inline') return t;
  }
  return undefined;
}

/* Render the highlighted-source body shared by fenced + indented code.
   Each physical line becomes <span class="ln">…</span>; blank lines are
   already rendered as &nbsp; by highlightCode, so line numbers/heights
   stay honest. The token content is the ONLY user data and it flows
   through highlightCode -> escapeHtml, so it cannot inject markup. */
/** Languages our (JS-family) highlighter actually understands. Other languages
 *  — and untagged / indented blocks — render as PLAIN escaped text: applying
 *  the JS tokenizer to YAML / logs / Python miscolors English words as JS
 *  keywords, which is worse than no highlighting (GitHub leaves them plain). */
const HIGHLIGHT_LANGS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'javascript', 'typescript', 'json',
]);

/** Render a fenced/indented code block. Highlight ONLY when the fence language
 *  is JS-family; otherwise emit plain, escaped lines (still one <span class=ln>
 *  per line, blank lines as &nbsp; — matching highlightCode's structure). Law-1
 *  safe: every non-highlighted line flows through escapeHtml. `data-lang` is
 *  stamped for an optional future language label (no CSS needed now). */
function renderCodeBlock(code: string, lang: string): string {
  const rendered = HIGHLIGHT_LANGS.has(lang.toLowerCase())
    ? highlightCode(code)
    : code.replace(/\n$/, '').split('\n').map((l) => escapeHtml(l) || '&nbsp;');
  const lines = rendered.map((l) => `<span class="ln">${l}</span>`).join('');
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
  return `<pre class="md-code"${langAttr}><code>${lines}</code></pre>`;
}

/* ---- mermaid fences: ```mermaid … ``` → a SAFE, SYNC placeholder ----
   The Viewer renders the diagram AFTER injection (lib/mermaid-render.ts), in
   the browser only, under securityLevel:'strict' + DOMPurify SVG sanitize. Here
   — in the SHARED, PURE renderer (also bundled into testkit.cjs) — we emit ONLY
   inert markup and MUST NOT import mermaid/DOMPurify/DOM.

   Shape:
     <div class="mermaid-diagram">
       <pre class="mermaid-src" hidden>ESCAPED_RAW_SOURCE</pre>
       FALLBACK            ← the normal escaped code block
     </div>

   Law-1 safety: the diagram source appears ONLY as escaped text inside a
   <pre> text node — never as live markup, never as an href/script. The browser
   decodes the HTML entities back to the EXACT original source via .textContent
   (so whitespace/indentation is preserved byte-for-byte for mermaid.render),
   while the rendered DOM stays inert. NOTE: markdown-it normalizes CRLF (\r\n)
   to LF (\n) in the fence body BEFORE the fence rule sees token.content, so the
   round-trip is exact MODULO newline normalization, not literally for raw CRLF
   input (mermaid treats \r\n and \n identically, so this is benign — and it is
   markdown-it preprocessing, not the placeholder). We do NOT base64 the source: this module
   is shared with the Node test bundle and must avoid env-specific encoders, and
   escaped text is already the correct, decode-on-read representation.

   FALLBACK is the existing escaped code block (renderCodeBlock). It is shown
   until mermaid replaces the container, and is also the graceful-degradation
   view when JS is off OR a render fails (mermaid-render keeps it on error). */
function renderMermaidPlaceholder(source: string): string {
  const src = `<pre class="mermaid-src" hidden>${escapeHtml(source)}</pre>`;
  const fallback = renderCodeBlock(source, 'mermaid');
  // CONSCIOUS CHOICE (search-reveal): like every fence rule here, this returns a
  // hand-built string and therefore does NOT carry the `data-srcline` the
  // loom_srcline core rule set on the fence token. So a search that lands on a
  // line INSIDE a diagram fence reveals the nearest PRECEDING mapped block, not
  // the diagram itself — IDENTICAL to a normal ```js fence (whose <pre
  // class=md-code> also lacks data-srcline). This is intentional consistency, not
  // an oversight: mermaid introduces no regression. If diagram-precise reveal is
  // ever wanted, stamp data-srcline onto the wrapper div from token.map[0]+1
  // (a controlled integer string — Law-1 safe) for both this and renderCodeBlock.
  return `<div class="mermaid-diagram">${src}${fallback}</div>`;
}

/* ---- fenced code: ```lang … ``` — highlight only JS-family langs ---- */
const fenceRule: MdRenderRule = (tokens, idx) => {
  const token = tokens[idx];
  // The info string is the language tag (first word after the opening fence).
  const lang = (token?.info ?? '').trim().split(/\s+/)[0] ?? '';
  // A `mermaid` fence becomes an inert placeholder the Viewer upgrades to an
  // SVG diagram after injection; every other fence is the normal code block.
  if (lang.toLowerCase() === 'mermaid') {
    return renderMermaidPlaceholder(token?.content ?? '');
  }
  return renderCodeBlock(token?.content ?? '', lang);
};
md.renderer.rules.fence = fenceRule;

/* ---- indented code blocks: no language → always plain escaped ---- */
md.renderer.rules.code_block = fenceRule;

/* ---- links: render styled but NON-navigating (NO href at all) ----
   We do NOT trust markdown-it's own validateLink. We drop the href
   ENTIRELY: an <a> with no href attribute is not a navigable hyperlink, so
   there is nothing for the browser to activate — neither a remote/document
   navigation NOR a same-document '#' fragment scroll/hashchange (SEC-5). The
   original target is preserved (escaped) in a data-* attribute purely for
   display/inspection — it is never placed in an attribute the browser will
   dereference. rel hardens the (inert) anchor against opener/referrer
   leakage and search ranking. This is the in-markup guarantee that does NOT
   rely on the React-layer click/keydown interceptor (FR-48, FR-52, AC-21). */
const linkOpenRule: MdRenderRule = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  if (token) {
    const rawHref = token.attrGet('href');
    const safe = safeExternalUrl(rawHref);
    // Drop markdown-it's attrs; re-add only vetted ones.
    token.attrs = null;
    token.attrSet('rel', 'noopener noreferrer nofollow');
    if (safe !== null) {
      // SAFE http/https/mailto: keep the NORMALIZED href so it is a real link,
      // and mark it (data-loom-ext) for the renderer's click handler to open in
      // the EXTERNAL browser via shell.openExternal — NEVER in-app navigation.
      // main re-validates the scheme before opening; the window blocks
      // in-app navigation as a backstop.
      token.attrSet('href', safe);
      token.attrSet('data-loom-ext', '1');
    } else {
      // Dangerous (javascript:/file:/data:/…) or relative/unparseable target:
      // emit NO href — inert, non-navigating — preserving the raw target only
      // in a non-href data-* attribute for display (FR-52 / SEC-5 still hold).
      token.attrSet('data-loom-link', rawHref ?? '');
    }
  }
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.link_open = linkOpenRule;

/* ---- images: never decode/load; render an inert text label ----
   Markdown images would otherwise emit <img src=…>. Even though the CSP
   blocks remote img loads (img-src 'self' data:), we do not want any
   file/data to be fetched or decoded, and Law 2 mandates placeholder-only
   image handling. We replace the image with its (escaped) alt text inside
   a labeled inert span. */
const imageRule: MdRenderRule = (tokens, idx) => {
  const token = tokens[idx];
  const alt = token ? token.content : '';
  const label = alt.length > 0 ? alt : 'image';
  return `<span class="md-img" data-loom-img="1">${escapeHtml(label)}</span>`;
};
md.renderer.rules.image = imageRule;

/* ---- raw HTML: escape, never interpret (belt-and-braces) ----
   With html:false markdown-it already emits these escaped, but we
   override explicitly so the guarantee does not depend on a single
   option flag. */
const rawHtmlRule: MdRenderRule = (tokens, idx) => {
  const token = tokens[idx];
  return escapeHtml(token ? token.content : '');
};
md.renderer.rules.html_block = rawHtmlRule;
md.renderer.rules.html_inline = rawHtmlRule;

/* ---- tables: wrap in a horizontally-scrollable container ----
   markdown-it (default preset) parses GFM tables and emits a bare <table>; a
   wide one would overflow the centered .md measure. We wrap the table in a
   fixed, inert <div class="md-table-wrap"> that the renderer.css scrolls. The
   wrapper is a CONSTANT structural tag (no user bytes), and the <table> token
   itself is still rendered by renderToken (keeping its data-srcline) — Law-1
   safe; the cell CONTENT continues to flow through the escaped inline path. */
const tableOpenRule: MdRenderRule = (tokens, idx, options, _env, self) =>
  `<div class="md-table-wrap">${self.renderToken(tokens, idx, options)}`;
md.renderer.rules.table_open = tableOpenRule;
const tableCloseRule: MdRenderRule = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`;
md.renderer.rules.table_close = tableCloseRule;

/* ---- source-line mapping (A11Y-SEARCH-01 / UX-SEARCH-01) ----
   A core rule that stamps each block-level OPENING token with a
   `data-srcline` attribute carrying its 1-based source line. markdown-it
   already records `token.map = [startLine, endLine]` (0-based, half-open) on
   block tokens; we expose the start line so the Viewer can scroll/flash the
   block nearest a searched line when a .md file is opened from a search match.
   This is metadata only — the value is a fixed integer string we control (no
   user bytes), so it cannot affect Law-1 escaping of the rendered content. */
md.core.ruler.push('loom_srcline', (state) => {
  for (const token of state.tokens) {
    // Block opening tokens (paragraph_open, heading_open, list_item_open, …)
    // and self-contained blocks (fence/code_block/hr) carry a source map.
    if (token.map && token.nesting >= 0 && token.type !== 'inline') {
      // token.map[0] is the 0-based start line; expose it 1-based to match the
      // 1-based line numbers the search matcher + Viewer gutter use.
      token.attrSet('data-srcline', String(token.map[0] + 1));
    }
  }
});

/* ---- GFM task lists: `- [ ] todo` / `- [x] done` ----
   markdown-it's default preset does NOT parse these — they render as a literal
   "[ ]"/"[x]" text prefix. We detect the marker at the start of a list item's
   first inline text token, STRIP it, and tag the <li> with a class. The checkbox
   glyph itself is drawn by renderer.css (::before) — we never emit a real
   <input> (keeps the fixed-structural-tag / html:false threat model intact).
   This runs after inline parsing (a pushed core rule), so children exist. */
md.core.ruler.push('loom_tasklist', (state) => {
  state.tokens.forEach((open, i) => {
    if (open.type !== 'list_item_open') return;
    const inline = firstInlineOf(state.tokens, i, 'list_item_close');
    const first = inline?.children?.[0];
    if (first === undefined || first.type !== 'text') return;
    const m = /^\[([ xX])\][ \t]+/.exec(first.content);
    if (m === null) return;
    first.content = first.content.slice(m[0]?.length ?? 0);
    const done = (m[1] ?? '').toLowerCase() === 'x';
    open.attrJoin('class', done ? 'md-task md-task-done' : 'md-task');
  });
});

/* ---- GitHub alerts: a `> [!NOTE]` (TIP/IMPORTANT/WARNING/CAUTION) first line
   of a blockquote. markdown-it renders an ordinary quote with a literal
   "[!NOTE]" line; we detect the marker on the blockquote's first inline token,
   strip that line, and tag the <blockquote> with a class renderer.css styles as
   a colored callout (title via ::before). No HTML/links emitted — Law-1 safe. */
const ALERT_TYPES = new Set(['note', 'tip', 'important', 'warning', 'caution']);
md.core.ruler.push('loom_alerts', (state) => {
  state.tokens.forEach((open, i) => {
    if (open.type !== 'blockquote_open') return;
    const inline = firstInlineOf(state.tokens, i, 'blockquote_close');
    const children = inline?.children;
    if (children === undefined || children === null) return;
    const head = children[0];
    if (head === undefined || head.type !== 'text') return;
    const m = /^\[!(\w+)\]/.exec(head.content);
    const type = (m?.[1] ?? '').toLowerCase();
    if (m === null || !ALERT_TYPES.has(type)) return;
    // Strip the "[!TYPE]" marker; drop a trailing break so the body starts clean.
    head.content = head.content.slice(m[0]?.length ?? 0).replace(/^[ \t]+/, '');
    const next = children[1];
    if (head.content === '' && next !== undefined && (next.type === 'softbreak' || next.type === 'hardbreak')) {
      children.splice(0, 2);
    } else if (head.content === '') {
      children.splice(0, 1);
    }
    open.attrJoin('class', `md-alert md-alert-${type}`);
  });
});

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Full block markdown render for the Viewer (.md → RENDERED).
 *  Returns safe HTML: escaped text + fixed structural tags only. */
export function renderMarkdown(markdown: string): string {
  return md.render(markdown ?? '');
}

/** Inline markdown render for chat message bodies (FR-48).
 *  Renders code spans, bold/italic and neutralized links only — no
 *  block-level structure — under the SAME safety rules. */
export function renderInline(text: string): string {
  return md.renderInline(text ?? '');
}
