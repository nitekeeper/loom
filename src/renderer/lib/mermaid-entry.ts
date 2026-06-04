/* ============================================================
 * Loom — mermaid LAZY-CHUNK entry (its OWN esbuild bundle)
 * ------------------------------------------------------------
 * THE ONLY module that statically pulls in mermaid (via mermaid-render.ts,
 * which imports `mermaid` + the SVG sanitizer). build.mjs compiles THIS file
 * into a SEPARATE browser IIFE — dist/mermaid.js (~7-8MB) — so the heavy
 * mermaid library is kept OUT of the startup bundle (dist/renderer.js).
 *
 * The renderer never statically imports this file (that would drag mermaid
 * back into renderer.js). Instead lib/mermaid-loader.ts injects dist/mermaid.js
 * as a same-origin classic <script> ONLY when a Viewer document actually
 * contains a `.mermaid-diagram` placeholder. When that script runs, this entry
 * publishes the render API on a window global the loader then reads.
 *
 * WHY a window global (not a module export): the renderer loads over file://
 * where ESM/module-CORS is fragile, so the contract is classic IIFE scripts +
 * a window hand-off — NO `type=module`, NO dynamic ESM import across bundles.
 *
 * SECURITY (Law 1): unchanged. This entry adds NO new capability — it only
 * re-exposes renderMermaidIn (strict mermaid.render -> DOMPurify sanitizeSvg ->
 * inject, with graceful fallback on throw/empty). The injected script src is a
 * FIXED literal in the loader, never derived from agent/markdown content.
 * ============================================================ */
import { renderMermaidIn } from './mermaid-render.js';

/** The shape the loader resolves to. Kept minimal: just the one entry point the
 *  Viewer needs. Declared here AND mirrored in mermaid-loader.ts (the loader
 *  must NOT import this module, or it would re-enter the mermaid graph). */
interface LoomMermaidApi {
  renderMermaidIn: typeof renderMermaidIn;
}

// Publish the API on window. The loader (mermaid-free) reads window.__loomMermaid
// after the injected dist/mermaid.js finishes loading. Assigning idempotently is
// harmless — the script is injected at most once (the loader memoizes).
(window as unknown as { __loomMermaid?: LoomMermaidApi }).__loomMermaid = {
  renderMermaidIn,
};
