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

/* Render the highlighted-source body shared by fenced + indented code.
   Each physical line becomes <span class="ln">…</span>; blank lines are
   already rendered as &nbsp; by highlightCode, so line numbers/heights
   stay honest. The token content is the ONLY user data and it flows
   through highlightCode -> escapeHtml, so it cannot inject markup. */
function renderCodeBlock(code: string): string {
  const lines = highlightCode(code).map((l) => `<span class="ln">${l}</span>`).join('');
  return `<pre class="md-code"><code>${lines}</code></pre>`;
}

/* ---- fenced code: ```lang … ``` ---- */
const fenceRule: MdRenderRule = (tokens, idx) => {
  const token = tokens[idx];
  return renderCodeBlock(token ? token.content : '');
};
md.renderer.rules.fence = fenceRule;

/* ---- indented code blocks ---- */
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
    // Strip ALL existing attributes, then re-add only inert ones. We do NOT
    // re-add any href: a hrefless anchor cannot navigate or fragment-scroll.
    token.attrs = null;
    token.attrSet('rel', 'noopener noreferrer nofollow');
    // Original target preserved for display only — escaped, inert. The
    // attribute name deliberately does NOT contain "href": the raw target
    // must never appear in any attribute that could be mistaken for (or
    // parsed as) a navigable href, even as a substring (FR-48/52, AC-21/22).
    token.attrSet('data-loom-link', rawHref ?? '');
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
