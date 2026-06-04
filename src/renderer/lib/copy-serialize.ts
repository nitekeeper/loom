/* ============================================================
 * Loom — "Copy rendered" serializer (pure, jsdom-testable)
 * ------------------------------------------------------------
 * Turns the Viewer's RENDERED markdown HTML (the output of
 * lib/markdown.renderMarkdown — already escaped + link-neutralized)
 * into a CLEANED, PORTABLE { html, text } pair for the clipboard, so a
 * paste lands as formatted content in Jira/Confluence/Docs/email with a
 * text/plain fallback.
 *
 * SAFETY / ALLOWLIST (the load-bearing contract):
 *   - The portable HTML is REBUILT by whitelist (a fresh, clean tree),
 *     NOT string-stripped. Only a fixed set of semantic elements survive;
 *     every other element is UNWRAPPED to its children/text — EXCEPT a small
 *     set of "non-content" elements (<style>, <script>, <template>, <head>,
 *     <noscript>, and SVG <style>) whose body is NOT user-visible content;
 *     those are DROPPED ENTIRELY so their raw body (e.g. CSS) never leaks.
 *   - The ONLY attribute carried over is `href` on <a>, and ONLY when
 *     safeExternalUrl() accepts it (the shared scheme allow-list) — using
 *     its NORMALIZED value. Any other anchor is unwrapped to its text.
 *   - All class / data-* / rel / target / style / event-handler attributes
 *     are dropped. By construction the output can contain NO <script>,
 *     NO <style>, NO on*-handler, and NO javascript:/data: href.
 *   - In-app code blocks (<pre class="md-code"><code> with per-line
 *     <span class="ln"> + non-breaking-space blanks) are reconstructed to
 *     a clean <pre><code> whose text is the ORIGINAL code with real
 *     newlines and normal spaces (line-number / nbsp artifacts removed).
 *   - .md-table-wrap is unwrapped to a bare <table>.
 *   - .mermaid-diagram: a rendered <svg class="mermaid-done"> is carried
 *     VERBATIM — the SINGLE branch not self-contained by this allowlist. It
 *     is safe ONLY under the caller contract below (the live `.md` DOM whose
 *     SVG was DOMPurify-sanitized in lib/mermaid-render.ts before the
 *     `.mermaid-done` marker was added). Otherwise the diagram SOURCE
 *     (.mermaid-src text) is emitted ONCE as a <pre><code>. The hidden source
 *     duplicate + the fallback code block are dropped so the source appears at
 *     most once. See the per-branch precondition note in serializeNodeHtml.
 *   - Images render in Loom as inert text labels (no real <img>); we keep
 *     whatever visible text they show.
 *
 * DEPENDENCY-LIGHT: imports ONLY safeExternalUrl (pure). It MUST NOT
 * import mermaid or React. DOM access is via the passed-in window (so the
 * Node + jsdom unit tests pass their own window), defaulting to the
 * browser global. Exportable from testkit-entry for unit tests.
 * ============================================================ */
import { safeExternalUrl } from '../../shared/url.js';

/** The serialized clipboard pair: portable HTML + a plaintext fallback. */
export interface CopyPayload {
  html: string;
  text: string;
}

/** The non-breaking space (U+00A0) lib/markdown emits for a blank code line.
 *  We normalize it out so a copied code block has real spaces / empty lines. */
const NBSP = ' ';

/** Block-level allowlisted tags kept (cleaned) in the portable HTML. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'table',
]);

/** Inline allowlisted tags kept as semantic wrappers in the portable HTML. */
const INLINE_TAGS: ReadonlySet<string> = new Set([
  'strong', 'b', 'em', 'i', 'del', 's', 'code', 'br',
]);

/** Table structural tags kept verbatim (cleaned of attributes). */
const TABLE_TAGS: ReadonlySet<string> = new Set([
  'thead', 'tbody', 'tr', 'th', 'td',
]);

/** "Non-content" elements whose text body is NOT user-visible content (CSS,
 *  script source, template/head metadata). These are DROPPED ENTIRELY (element
 *  + contents removed) rather than unwrapped-to-children like a normal layout
 *  wrapper — unwrapping would LEAK their raw body (e.g. a CSS rule) into the
 *  portable html/text. Defense-in-depth: production markdown is html:false so it
 *  never emits these, but the allowlist serializer must be correct for any input.
 *  Compared case-insensitively against the lowercased tag name, so SVG <style>
 *  (tagName 'style') is covered alongside HTML <style>. */
const DROP_TAGS: ReadonlySet<string> = new Set([
  'style', 'script', 'template', 'head', 'noscript',
]);

/** Resolve the Window to use: explicit arg, else the browser global. Throws a
 *  clear error if neither is available (a misuse, not a runtime path). The cast
 *  to `Window & typeof globalThis` surfaces DOMParser, which lives on the global
 *  scope in this TS lib config (mirrors lib/svg-sanitize). */
function resolveWindow(win?: Window): Window & typeof globalThis {
  const w = (win ?? (typeof window !== 'undefined' ? window : undefined)) as
    | (Window & typeof globalThis)
    | undefined;
  if (!w || typeof w.DOMParser === 'undefined') {
    throw new Error('serializeRenderedForCopy: no window with DOMParser available');
  }
  return w;
}

/** Escape text for safe insertion into the portable HTML string. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Normalize a single code line: collapse the lone non-breaking space a blank
 *  line is rendered as to empty, and convert any interior nbsp back to a normal
 *  space (defensive — lib/markdown only uses nbsp for fully-blank lines). */
function normalizeCodeLine(raw: string): string {
  if (raw === NBSP) return '';
  return raw.split(NBSP).join(' ');
}

/** Reconstruct the ORIGINAL code text from an in-app <code> element built by
 *  lib/markdown (per-line <span class="ln"> wrappers, blank lines as a single
 *  non-breaking space, inner tok-* spans). Each .ln span is one source line;
 *  its textContent (with the nbsp placeholder normalized) is the line, joined
 *  by '\n'. Falls back to the element's textContent when no .ln markers are
 *  present (e.g. a plain <code> from another path). */
function codeTextOf(codeEl: Element): string {
  const lines = codeEl.querySelectorAll('span.ln');
  if (lines.length === 0) {
    return normalizeCodeLine(codeEl.textContent ?? '');
  }
  const out: string[] = [];
  for (const ln of lines) out.push(normalizeCodeLine(ln.textContent ?? ''));
  return out.join('\n');
}

/** Extract a mermaid diagram's source text from its hidden <pre class=
 *  "mermaid-src">. textContent already decodes the escaped entities back to
 *  the exact source; we drop a single trailing newline for tidiness. */
function mermaidSourceOf(diagram: Element): string {
  const src = diagram.querySelector('pre.mermaid-src');
  return (src?.textContent ?? '').replace(/\n$/, '');
}

/* ------------------------------------------------------------------ */
/* Portable HTML builder — rebuild a CLEAN tree by allowlist.          */
/* ------------------------------------------------------------------ */

/** Serialize a node's children into clean portable HTML. */
function serializeChildrenHtml(node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    out += serializeNodeHtml(child);
  }
  return out;
}

/** Serialize ONE node to clean portable HTML, by allowlist. Unknown elements
 *  are unwrapped (their children are serialized in place). */
function serializeNodeHtml(node: Node): string {
  // Text node (Node.TEXT_NODE === 3).
  if (node.nodeType === 3) {
    return esc(node.textContent ?? '');
  }
  // Anything that is not an element (comment, etc.) contributes nothing.
  if (node.nodeType !== 1) return '';

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // ---- non-content elements: DROP ENTIRELY (element + contents) ----
  // <style>/<script>/<template>/<head>/<noscript> (and SVG <style>) hold no
  // user-visible content; unwrapping them would leak their raw body (e.g. CSS)
  // into the portable output, so they are removed completely.
  if (DROP_TAGS.has(tag)) return '';

  // ---- mermaid diagram: SVG if rendered, else the source as a code block ----
  if (el.classList.contains('mermaid-diagram')) {
    const svg = el.querySelector('svg.mermaid-done');
    if (svg) {
      // PRECONDITION (the ONE branch whose output safety is NOT self-evident
      // from this allowlist alone): we emit svg.outerHTML VERBATIM, trusting it
      // is already sanitized. This is safe ONLY because the caller passes the
      // LIVE `.md` DOM, whose `.mermaid-done` SVG was DOMPurify-sanitized in
      // lib/mermaid-render.ts (el.innerHTML = sanitizeSvg(svg)) BEFORE the
      // `.mermaid-done` class was added (the class is the post-sanitize marker).
      // renderMarkdown never emits a raw `.mermaid-done` SVG, so in production
      // the only such node in the input went through DOMPurify.
      // DO NOT call serializeRenderedForCopy on an UNTRUSTED SVG string: a
      // hand-crafted `<svg class="mermaid-done">…</svg>` would pass through here
      // UNSANITIZED. Every OTHER branch is provably safe by allowlist
      // construction; this one depends on that caller invariant.
      return svg.outerHTML;
    }
    const source = mermaidSourceOf(el);
    return `<pre><code>${esc(source)}</code></pre>`;
  }

  // ---- code blocks: rebuild a clean <pre><code> with real newlines ----
  if (tag === 'pre') {
    const codeEl = el.querySelector('code');
    const code = codeEl ? codeTextOf(codeEl) : (el.textContent ?? '');
    return `<pre><code>${esc(code)}</code></pre>`;
  }

  // ---- table wrapper: unwrap to the inner clean <table> ----
  if (el.classList.contains('md-table-wrap')) {
    return serializeChildrenHtml(el);
  }

  // ---- links: keep href ONLY when safeExternalUrl accepts it ----
  if (tag === 'a') {
    const safe = safeExternalUrl(el.getAttribute('href'));
    const inner = serializeChildrenHtml(el);
    return safe !== null ? `<a href="${esc(safe)}">${inner}</a>` : inner;
  }

  // ---- inert image label: keep its visible text only (no <img>) ----
  if (el.classList.contains('md-img')) {
    return esc(el.textContent ?? '');
  }

  // ---- void inline / block: <br>, <hr> ----
  if (tag === 'br') return '<br>';
  if (tag === 'hr') return '<hr>';

  // ---- allowlisted block + inline + table structural tags: keep, clean ----
  // The tag name itself is safe and carries no attributes here.
  if (BLOCK_TAGS.has(tag) || INLINE_TAGS.has(tag) || TABLE_TAGS.has(tag)) {
    return `<${tag}>${serializeChildrenHtml(el)}</${tag}>`;
  }

  // ---- span / div / everything else NOT on the allowlist: UNWRAP ----
  // (spans carry only styling classes; unwrapping keeps their text/children.)
  return serializeChildrenHtml(el);
}

/* ------------------------------------------------------------------ */
/* Plain-text builder — readable rendering of the SAME content.        */
/* ------------------------------------------------------------------ */

/** Collect the plain inline text of a node (links as their text, code/inline
 *  preserved as text). Used for headings, paragraphs, list-item OWN text, and
 *  table cells. Nested ul/ol are SKIPPED so a list item's own text excludes its
 *  sublist (the sublist is emitted separately, indented, by listText). */
function inlineText(node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out += child.textContent ?? '';
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) {
      continue; // non-content element: drop, never fold its body into text
    }
    if (tag === 'br') {
      out += '\n';
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      continue; // nested list handled by listText, not folded into item text
    }
    if (el.classList.contains('md-img')) {
      out += el.textContent ?? '';
      continue;
    }
    out += inlineText(el);
  }
  return out;
}

/** Render a table to a simple pipe-delimited plaintext grid (one row per
 *  line). Keeps it readable in a plaintext paste without heavy alignment. */
function tableText(table: Element): string {
  const rows: string[] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(tr.querySelectorAll('th, td')).map((c) =>
      inlineText(c).trim(),
    );
    rows.push(cells.join(' | '));
  }
  return rows.join('\n');
}

/** Render a list (ul/ol) to indented plaintext lines, recursing into nested
 *  lists at deeper indent. Bullets use '- '; ordered lists use '1.'-style. */
function listText(list: Element, depth: number): string {
  const ordered = list.tagName.toLowerCase() === 'ol';
  const lines: string[] = [];
  let n = 1;
  for (const li of Array.from(list.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const lead = '  '.repeat(depth);
    const marker = ordered ? `${n}. ` : '- ';
    lines.push(`${lead}${marker}${inlineText(li).trim()}`.replace(/\s+$/g, ''));
    for (const sub of Array.from(li.children)) {
      const subTag = sub.tagName.toLowerCase();
      if (subTag === 'ul' || subTag === 'ol') {
        const nested = listText(sub, depth + 1);
        if (nested.length > 0) lines.push(nested);
      }
    }
    n += 1;
  }
  return lines.join('\n');
}

/** Append a block's plaintext to the accumulator. Only trailing whitespace is
 *  trimmed (interior code/structure is preserved); empty blocks are dropped so
 *  blocks join with a real blank line and never mash into one line. */
function pushBlock(blocks: string[], text: string): void {
  const trimmed = text.replace(/\s+$/g, '');
  if (trimmed.length > 0) blocks.push(trimmed);
}

/** Render a <blockquote> to plaintext as a BLOCK CONTAINER (not flattened
 *  through inlineText): recurse into its block children so a nested ul/ol routes
 *  to listText and a nested <pre> emits its code verbatim — matching the HTML
 *  side. Each emitted line is prefixed with '> ' (blank lines become a bare
 *  '>') so the quoted structure is visible in a plaintext paste. Nested
 *  blockquotes compound the prefix ('> > '). The blockquote's own child blocks
 *  are first collected (each separated by a blank line) then prefixed as a
 *  single unit, so the whole quote stays one block in the parent stream. */
function blockquoteText(quote: Element): string {
  const inner: string[] = [];
  walkBlocks(quote, inner);
  if (inner.length === 0) return '';
  // Join the quote's child blocks with a blank line, then prefix EVERY physical
  // line — including the blank separators — so the '> ' gutter is continuous.
  const body = inner.join('\n\n');
  return body
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/** Walk a container's child nodes, emitting one plaintext block per block-level
 *  element into `blocks`. Shared by the top-level pass and the blockquote
 *  container so nested lists / code / quotes are handled identically wherever
 *  they appear (the fix for blockquote-nested block content lost in text/plain). */
function walkBlocks(node: Node, blocks: string[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const t = (child.textContent ?? '').trim();
      if (t.length > 0) pushBlock(blocks, t);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    // non-content element: drop entirely (do NOT descend — its body, e.g. CSS,
    // is not user-visible content and must not leak into text/plain).
    if (DROP_TAGS.has(tag)) continue;

    // mermaid: a rendered SVG carries no useful text — emit a marker; an
    // unrendered diagram emits its SOURCE (once).
    if (el.classList.contains('mermaid-diagram')) {
      const svg = el.querySelector('svg.mermaid-done');
      const source = mermaidSourceOf(el);
      if (svg) pushBlock(blocks, '[diagram]');
      else if (source.length > 0) pushBlock(blocks, source);
      continue;
    }

    if (tag === 'blockquote') {
      // A blockquote is a CONTAINER of block children (p / ul / ol / pre / even
      // nested blockquotes). Recurse so nested lists + code survive, instead of
      // flattening it through inlineText (which dropped them).
      pushBlock(blocks, blockquoteText(el));
    } else if (/^h[1-6]$/.test(tag) || tag === 'p') {
      pushBlock(blocks, inlineText(el).trim());
    } else if (tag === 'pre') {
      const codeEl = el.querySelector('code');
      const code = codeEl ? codeTextOf(codeEl) : (el.textContent ?? '');
      if (code.length > 0) pushBlock(blocks, code);
    } else if (tag === 'hr') {
      pushBlock(blocks, '---');
    } else if (tag === 'ul' || tag === 'ol') {
      pushBlock(blocks, listText(el, 0));
    } else if (el.classList.contains('md-table-wrap') || tag === 'table') {
      const table = tag === 'table' ? el : el.querySelector('table');
      if (table) pushBlock(blocks, tableText(table));
    } else {
      // Unknown container (e.g. a wrapping div): descend so its block
      // children still surface as their own blocks.
      walkBlocks(el, blocks);
    }
  }
}

/** Walk the top-level rendered tree and emit one plaintext block per element. */
function serializeText(root: Node): string {
  const blocks: string[] = [];
  walkBlocks(root, blocks);
  return blocks.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Serialize the Viewer's RENDERED markdown HTML into a CLEANED, PORTABLE
 *  { html, text } clipboard pair. `renderedHtml` is the output of
 *  lib/markdown.renderMarkdown (or the live `.md` container's innerHTML).
 *  Pass `win` in Node/jsdom tests; defaults to the browser global window.
 *
 *  CALLER CONTRACT: pass ONLY trusted, runtime-rendered markdown — either the
 *  raw renderMarkdown() output (which never contains a `.mermaid-done` SVG) or
 *  the LIVE `.md` container's innerHTML (whose `.mermaid-done` SVG was already
 *  DOMPurify-sanitized in lib/mermaid-render.ts). Every branch is allowlist-
 *  pure EXCEPT the rendered-mermaid `<svg class="mermaid-done">` branch, which
 *  is emitted verbatim and is safe ONLY under this contract — do NOT hand this
 *  an untrusted SVG string (see the precondition note in serializeNodeHtml). */
export function serializeRenderedForCopy(
  renderedHtml: string,
  win?: Window,
): CopyPayload {
  const w = resolveWindow(win);
  const doc = new w.DOMParser().parseFromString(
    `<!DOCTYPE html><body>${renderedHtml}</body>`,
    'text/html',
  );
  const root = doc.body;
  const html = serializeChildrenHtml(root).trim();
  const text = serializeText(root).trim();
  return { html, text };
}
