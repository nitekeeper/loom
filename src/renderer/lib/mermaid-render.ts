/* ============================================================
 * Loom — mermaid diagram renderer (BROWSER-ONLY, Law 1 safe)
 * ------------------------------------------------------------
 * Upgrades the inert `.mermaid-diagram` placeholders that lib/markdown.ts
 * emits for ```mermaid fences into real SVG diagrams, IN the renderer,
 * AFTER the markdown HTML has been injected.
 *
 * This module imports mermaid (a large dependency) + the SVG sanitizer,
 * so it MUST be:
 *   - imported ONLY via a dynamic import() from Viewer.tsx (kept off the
 *     hot path for files with no diagrams), and
 *   - NEVER imported by src/testkit-entry.ts (it would drag mermaid + a
 *     browser-only runtime into the Node test bundle).
 *
 * SECURITY (Law 1): the diagram source is hostile, agent-authored.
 *   1. securityLevel:'strict' disables htmlLabels and click/call/script
 *      directives at the mermaid layer.
 *   2. The produced SVG is run through sanitizeSvg (DOMPurify) before it
 *      EVER touches innerHTML — we do not trust mermaid's output.
 *   3. No CSP relaxation: mermaid runs under script-src 'self' WITHOUT
 *      'unsafe-eval'. A diagram type that internally needs eval/Function
 *      throws under CSP; we CATCH and keep the escaped code-block
 *      fallback (graceful degradation), never surfacing the error.
 * ============================================================ */
import mermaid from 'mermaid';
import { sanitizeSvg, svgHasRenderableContent } from './svg-sanitize.js';

/* One-time mermaid configuration. startOnLoad:false — we drive rendering
   ourselves, after injection, per Viewer effect. securityLevel:'strict' is the
   Law-1 anchor (no htmlLabels, no interaction directives). theme:'dark' matches
   Loom's dark UI. deterministicIds keeps generated ids stable (no per-render
   churn). maxTextSize / maxEdges bound the work a hostile diagram can demand.
   fontFamily 'inherit' so labels use Loom's UI font. */
let initialized = false;
function ensureInitialized(): void {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'dark',
    deterministicIds: true,
    // Bound the work a hostile source can demand (DoS guard). These are
    // generous for legitimate docs but cap pathological inputs.
    maxTextSize: 50000,
    maxEdges: 500,
    fontFamily: 'inherit',
    // Skip mermaid's OWN built-in error diagram. We supply our own .mermaid-error
    // affordance (keeping the escaped code-block fallback), so mermaid's error SVG
    // is redundant. More importantly, this guarantees temp-element cleanup on the
    // draw-time failure path: with suppressErrorRendering, BOTH the parse-error
    // and renderer.draw() failure branches call mermaid's removeTempElements()
    // and rethrow — so mermaid no longer orphans a body-level #d<id> div on
    // failure. (Belt-and-braces, our catch below ALSO removes any such orphan.)
    suppressErrorRendering: true,
  });
  initialized = true;
}

/* A monotonic counter for unique render ids. mermaid.render(id, ...) injects a
   transient element keyed by `id`; deterministicIds makes the INTERNAL ids
   stable, but the OUTER render id must still be unique per call to avoid id
   collisions when several diagrams render in one pass. */
let renderSeq = 0;

/** Options for renderMermaidIn. `isCancelled` lets the caller (Viewer) abort
 *  writing a stale SVG into the DOM after the user switched files mid-render. */
export interface RenderMermaidOptions {
  isCancelled?: () => boolean;
}

/** Upgrade every not-yet-processed `.mermaid-diagram` inside `container` to a
 *  sanitized SVG. Idempotent (a data-attr marks processed nodes), bounded, and
 *  never throws out of the function — a failed/unsupported diagram keeps its
 *  escaped code-block fallback and is tagged .mermaid-error.
 *
 *  Async because mermaid.render is async; awaits each render in document order
 *  (diagrams are typically few, and serial keeps memory/CPU bounded vs a burst
 *  of parallel layouts). The cancel check runs both before writing each SVG and
 *  between diagrams so switching files promptly stops the loop. */
export async function renderMermaidIn(
  container: HTMLElement,
  opts?: RenderMermaidOptions,
): Promise<void> {
  ensureInitialized();
  const nodes = container.querySelectorAll<HTMLElement>('.mermaid-diagram');
  for (const el of nodes) {
    if (opts?.isCancelled?.()) return;
    // Idempotency: skip nodes an earlier pass already handled (done or errored).
    if (el.dataset.mermaidProcessed === '1') continue;
    el.dataset.mermaidProcessed = '1';

    const srcEl = el.querySelector<HTMLElement>('.mermaid-src');
    // .textContent decodes the HTML entities markdown.ts escaped back to the
    // EXACT original diagram source (whitespace preserved) — never live markup.
    const src = srcEl?.textContent ?? '';
    if (src.trim() === '') {
      // Empty diagram — leave the (empty) fallback, mark errored so it is not
      // retried, and move on.
      el.classList.add('mermaid-error');
      continue;
    }

    const id = `loom-mermaid-${renderSeq++}`;
    try {
      // FUTURE-UPGRADE RE-REVIEW (mermaid major bump): mermaid.render appends a
      // TRANSIENT scratch element (enclosing div id 'd'+id) directly to
      // document.body for layout measurement (getBBox), OUTSIDE this .md
      // container and therefore OUTSIDE sanitizeSvg, before returning the SVG
      // STRING we sanitize below. Today this is NOT exploitable: under
      // securityLevel:'strict' htmlLabels are disabled (labels are inert SVG
      // <text>, never HTML/foreignObject), and mermaid emits no <script> into its
      // own output, so the body-level temp node holds nothing executable and
      // there is no XSS window. The only residual (orphan accumulation on the
      // error path — a DoS-adjacent leak from an agent flooding malformed
      // diagrams) is closed by suppressErrorRendering:true PLUS the explicit
      // getElementById('d'+id)/.getElementById(id) removal in the catch below. On
      // a mermaid MAJOR-version bump, re-confirm strict mode STILL disables
      // htmlLabels and that this body-level temp node never receives
      // htmlLabel/foreignObject content; the e2e XSS test (#2) already exercises
      // the real pipeline and would catch a strict-mode label regression.
      const { svg } = await mermaid.render(id, src);
      // The user may have switched files while we awaited layout — do not write
      // a stale diagram into the new file's DOM.
      if (opts?.isCancelled?.()) return;
      // Re-read: the container could have been detached; guard before write.
      if (!el.isConnected) return;
      const clean = sanitizeSvg(svg);
      // Sanitization may strip a diagram down to a bare/empty <svg> with nothing
      // to draw (e.g. mermaid emitted only content the scrub removed). Injecting
      // that empty SVG would replace the readable fallback with a blank box. So
      // unless the sanitized SVG actually carries rendered shapes/text, treat it
      // exactly like a render failure: keep the escaped code-block fallback and
      // tag the error affordance (mirrors the catch path below). svgHasRenderable-
      // Content never throws, so this stays defensive.
      if (!svgHasRenderableContent(clean, el.ownerDocument.defaultView ?? undefined)) {
        srcEl?.remove();
        el.classList.add('mermaid-error');
        continue;
      }
      el.innerHTML = clean;
      el.classList.add('mermaid-done');
      // The escaped source is no longer needed once the diagram is shown; it was
      // replaced by innerHTML above, so nothing further to remove. (We keep the
      // .mermaid-diagram wrapper class for styling.)
    } catch {
      // Render failed OR the diagram type needed eval/Function and was blocked
      // by CSP. Keep the escaped code-block fallback (already present); just
      // remove the hidden source node and flag the error affordance. Never
      // rethrow — one bad diagram must not abort the rest of the document.
      srcEl?.remove();
      el.classList.add('mermaid-error');
      // Defensive cleanup: on a parse/draw failure mermaid can throw BEFORE its
      // own removeTempElements() runs, leaving a body-level temp node it appended
      // during layout (the enclosing div id is 'd' + renderId; the svg id is the
      // renderId itself). suppressErrorRendering:true above closes the common
      // paths, but we remove these by their known ids unconditionally so no
      // orphan accumulates on document.body over a long session (DoS-adjacent
      // leak from an agent flooding malformed diagrams). getElementById-by-id is
      // exact and cheap; absent ids are a harmless no-op.
      const doc = el.ownerDocument;
      doc.getElementById('d' + id)?.remove();
      doc.getElementById(id)?.remove();
    }
  }
}
