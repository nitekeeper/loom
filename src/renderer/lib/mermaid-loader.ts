/* ============================================================
 * Loom — mermaid LAZY LOADER (mermaid-FREE on purpose)
 * ------------------------------------------------------------
 * A tiny shim the Viewer dynamic-imports when a document actually contains a
 * `.mermaid-diagram`. It injects the SEPARATE dist/mermaid.js bundle as a
 * same-origin classic <script> and hands back the render API that bundle
 * publishes on window.__loomMermaid (see lib/mermaid-entry.ts).
 *
 * CRITICAL — this module MUST NOT statically import `mermaid`, mermaid-render,
 * mermaid-entry, or anything in the mermaid graph. esbuild bundles the renderer
 * as an IIFE (no code-splitting), so ANY static import here would inline mermaid
 * straight back into dist/renderer.js — the exact regression this split exists
 * to prevent. The build-output guard (test/bundle-split.mjs) fails if it does.
 * Keep this file's import list EMPTY.
 *
 * SECURITY (Law 1):
 *   - The script src is the HARDCODED literal './mermaid.js' — NEVER derived
 *     from markdown / agent / diagram content. So script-src 'self' admits it
 *     (a real src load, same-origin, NOT inline -> no 'unsafe-inline' needed,
 *     no CSP change).
 *   - It is a CLASSIC script (no type=module): module/ESM loading over file://
 *     is fragile; the contract is IIFE + a window hand-off.
 *   - On load FAILURE the caller (Viewer) keeps the escaped code-block fallback
 *     (graceful degradation) — the app never breaks if the chunk is missing.
 * ============================================================ */

/** The render API published by dist/mermaid.js on window.__loomMermaid. Mirrors
 *  the surface lib/mermaid-entry.ts assigns; typed structurally so this file
 *  needs NO import from the mermaid graph. */
export interface LoomMermaidApi {
  renderMermaidIn(
    container: HTMLElement,
    opts?: { isCancelled?: () => boolean },
  ): Promise<void>;
}

/** The fixed, same-origin path of the lazily-loaded mermaid bundle. A literal —
 *  see the security note above; it must NEVER be derived from any input. */
const MERMAID_CHUNK_SRC = './mermaid.js';

/** Memoized single in-flight (or resolved) load promise. ensureMermaid() injects
 *  the <script> at most once even when several diagrams (or several files in
 *  quick succession) request it before the first load settles. A REJECTED load
 *  is NOT cached — clearing it on failure lets a later document retry (e.g. if a
 *  transient condition prevented the first load). */
let inflight: Promise<LoomMermaidApi> | null = null;

/** Read the window global the mermaid bundle publishes, or null if absent. */
function readGlobal(): LoomMermaidApi | null {
  const g = window as unknown as { __loomMermaid?: LoomMermaidApi };
  return g.__loomMermaid ?? null;
}

/** Lazily load dist/mermaid.js (once) and resolve its render API.
 *
 *  - Already loaded (window.__loomMermaid present) -> resolve immediately.
 *  - Otherwise inject a classic <script src="./mermaid.js">; on load resolve the
 *    now-present global (reject if the bundle loaded but did NOT publish it);
 *    on error reject (and clear the memo so a later call may retry).
 *
 *  Never throws synchronously; all failure flows through a rejected promise the
 *  Viewer catches to keep its fallback. */
export function ensureMermaid(): Promise<LoomMermaidApi> {
  // Fast path: the bundle already ran (e.g. a previous file rendered a diagram).
  const existing = readGlobal();
  if (existing) return Promise.resolve(existing);

  // Coalesce concurrent callers onto one in-flight load.
  if (inflight) return inflight;

  inflight = new Promise<LoomMermaidApi>((resolve, reject) => {
    // Guard: with no document we cannot inject (non-browser context). Reject so
    // the caller degrades gracefully rather than hanging forever.
    if (typeof document === 'undefined') {
      reject(new Error('mermaid-loader: no document to inject into'));
      return;
    }

    const script = document.createElement('script');
    // Classic script (default type) — NO type=module. Same-origin literal src.
    script.src = MERMAID_CHUNK_SRC;
    script.async = true;

    script.onload = (): void => {
      const api = readGlobal();
      if (api) {
        resolve(api);
      } else {
        // The bundle loaded but did not publish the global (build/contract
        // regression). Treat as a load failure so the caller keeps its fallback,
        // and clear the memo so a later call can retry.
        inflight = null;
        reject(new Error('mermaid-loader: bundle loaded but __loomMermaid absent'));
      }
    };

    script.onerror = (): void => {
      // The chunk failed to load (missing file, blocked, etc.). Clear the memo so
      // a subsequent document may retry, and reject so the Viewer keeps fallback.
      inflight = null;
      reject(new Error('mermaid-loader: failed to load ' + MERMAID_CHUNK_SRC));
    };

    document.head.appendChild(script);
  });

  return inflight;
}
