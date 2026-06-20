/* ============================================================
 * Loom — SVG sanitizer for rendered mermaid diagrams (Law 1)
 * ------------------------------------------------------------
 * mermaid.render() produces an SVG string. Even under
 * securityLevel:'strict' (no htmlLabels, no click/script directives),
 * that SVG is still injected into the Viewer DOM, so it crosses the
 * Law-1 boundary: it MUST be treated as untrusted markup and scrubbed
 * before it touches innerHTML. This module is the scrub.
 *
 * It depends ONLY on DOMPurify (Cure53's battle-tested sanitizer). It
 * MUST NOT import mermaid or any DOM globals at module scope, and MUST
 * NOT be pulled into testkit-entry.ts's Node bundle by mermaid — but it
 * IS testable under node+jsdom by passing a jsdom window (DOMPurify is a
 * factory: DOMPurify(window) binds it to that window's DOM, so the same
 * code runs in the browser and in a node test).
 *
 * Threat model recap (Law 1): the diagram SOURCE is hostile,
 * agent-authored. mermaid could (now or after a future upgrade/bug)
 * emit attacker-influenced bytes into the SVG. We do not trust mermaid
 * to be safe; we sanitize its output unconditionally.
 * ============================================================ */
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';

/* Per-instance cache: DOMPurify is bound to a specific window. In the browser
   there is exactly one window; a node test may pass its own jsdom window. Key
   the instance by window so we build a configured purifier at most once per
   window (the addHook policy is installed once, at construction). */
type PurifyInstance = ReturnType<typeof DOMPurify>;
const instances = new WeakMap<object, PurifyInstance>();

/* ASCII whitespace + C0 control characters (NUL..space). The browser ignores
   these when resolving a URL, so "java\tscript:" resolves to the javascript:
   scheme; we strip them before testing the scheme/fragment. Built via
   `new RegExp` from \u-escapes so the SOURCE stays pure ASCII (no raw control
   bytes in the file). */
// eslint-disable-next-line no-control-regex -- intentional: matching C0 control chars (NUL..space) is the whole point — they are stripped to defeat "java\tscript:" scheme-spoofing before the scheme test
const URL_NOISE = new RegExp('[\\u0000-\\u0020]+', 'g');

/* Whether an href / xlink:href value is safe to keep. mermaid in strict mode
   emits no links by default, but a diagram MAY legitimately carry an in-document
   fragment ("#id") (e.g. a marker reference). We allow ONLY same-document
   fragments; everything else — javascript:, data:, file:, http(s):, relative
   paths — is dropped from the href so a sanitized diagram can never navigate or
   execute. (data: raster images are not relevant: mermaid emits vector shapes,
   not <image> data URIs; a future diagram that needed one would simply lose the
   href, the safe failure.) */
function hrefIsSafe(value: string): boolean {
  const v = value.replace(URL_NOISE, '').toLowerCase();
  return v.startsWith('#');
}

/** Build (once per window) a DOMPurify instance hardened for SVG diagrams.
 *  All policy lives here and is documented inline. */
function purifierFor(win: Window): PurifyInstance {
  const key = win as unknown as object;
  const existing = instances.get(key);
  if (existing) return existing;

  const dp = DOMPurify(win as unknown as Window & typeof globalThis);

  /* Drop any href / xlink:href whose value is not a same-document fragment.
     DOMPurify already strips on*-handlers and (by default) javascript: URIs,
     but we add an explicit, conservative gate so the guarantee does not rely on
     DOMPurify's URI allow-list staying in sync with our threat model. The
     'uponSanitizeAttribute' entry point sees every attribute on every element. */
  dp.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName;
    if (name === 'href' || name === 'xlink:href') {
      if (!hrefIsSafe(data.attrValue)) {
        data.keepAttr = false;
      }
    }
  });

  instances.set(key, dp);
  return dp;
}

/* DOMPurify config — documented choice by choice:

   - USE_PROFILES { svg: true, svgFilters: true }: restricts the allow-list to
     the SVG + SVG-filter element/attribute set (paths, groups, shapes, text,
     markers, gradients, filters). This is the correct profile for mermaid's
     vector output and excludes the entire HTML element surface by default.

   - ADD_TAGS ['style']: mermaid emits an in-SVG <style> block carrying the
     diagram's theme CSS. The svg profile does not include <style> by default,
     so we re-add it explicitly.
       IMPORTANT — DOMPurify does NOT scrub the CSS *body* of a kept <style>
       under the svg profile. It sanitizes element/attribute STRUCTURE, not CSS
       declarations: a hostile CSS body such as `@import url("https://evil/x")`,
       `background:url(https://evil/track.png)`, `expression(alert(1))`, or
       `background:url(javascript:alert(1))` survives the scrub VERBATIM. (Only
       structural script-smuggling like `<style></style><script>` is collapsed.)
       So the safety of the kept <style> is NOT provided by this sanitizer; it
       is provided by the app's locked CSP and the browser engine:
         · script-src 'self' (no 'unsafe-eval')  → kills expression().
         · Chromium (Electron) never executes javascript: in url(), nor
           supports -moz-binding.
         · style-src 'self' 'unsafe-inline'       → blocks remote @import.
         · img-src 'self' data:                   → blocks remote url() beacons
           (a data: url() background remains, and is inert).
         · font-src 'self'                         → blocks remote @font-face.
         · connect-src 'none'                      → blocks all other fetches.
       Under strict mode mermaid emits this <style> from a TRUSTED theme
       template (not from the diagram source), so an attacker normally cannot
       control its CSS; even mermaid's attacker-influenced classDef styles are
       contained by the CSP above. The residual is inert. Do NOT loosen the CSP
       on the assumption that this sanitizer covers CSS — it does not.

   - FORBID_TAGS: belt-and-braces removal of the dangerous tags even if a future
     profile change or attacker input would otherwise admit them:
       script         — executable, the primary XSS vector.
       foreignObject  — the SVG->HTML escape hatch (htmlLabels live here; strict
                        mode disables them, but forbid the element regardless so
                        no HTML — and thus no <script>/<img onerror> — can ride
                        inside the SVG).
       iframe/object/embed — external/embedded content + script surfaces.
       annotation-xml — a MathML/foreignObject-adjacent HTML-smuggling vector.

   - FORBID_ATTR is deliberately NOT used for href/xlink:href: a blanket forbid
     is too aggressive (the brief flagged it as such). Instead we rely on
     (a) DOMPurify's built-in on*-handler stripping, plus (b) the
     uponSanitizeAttribute hook above that drops any href/xlink:href that is not
     a same-document '#fragment'. This keeps benign marker references working
     while neutralizing javascript:/data:/external navigation.

   - FORBID_ATTR ['data-loom-ext','data-loom-link','data-loom-img']: DOMPurify's
     svg profile allows data-* attributes by default, so a HOSTILE diagram could
     emit an SVG <a data-loom-ext="1" …> that survives the scrub WITH that flag
     intact. data-loom-ext is the renderer's external-link TRUST flag (the global
     anchor-guard opens a link only when anchor.dataset.loomExt === '1'), and
     mermaid NEVER legitimately emits any data-loom-* attribute. So we strip the
     three Loom-internal data attributes unconditionally: no diagram can ever
     carry the renderer's trust flags. This makes the SVG scrub SELF-SUFFICIENT —
     the renderer's anchor-guard check no longer depends on main's openExternal
     re-validation as the sole load-bearing layer for diagram anchors (Law-1:
     the scrub must stand on its own, not lean on a downstream re-check).

   - We do NOT set RETURN_TRUSTED_TYPE / RETURN_DOM: the default string return is
     exactly what the Viewer injects via innerHTML. */
const SVG_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['style'],
  FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'annotation-xml'],
  // Strip the renderer's Loom-internal trust/marker attributes so no diagram can
  // ever carry the anchor-guard's external-link trust flag (see FORBID_ATTR note
  // above). mermaid emits none of these legitimately.
  FORBID_ATTR: ['data-loom-ext', 'data-loom-link', 'data-loom-img'],
};

/** Sanitize a mermaid-produced SVG string into safe markup for innerHTML.
 *  Pass `win` in a node+jsdom test; in the browser it defaults to the global
 *  window. Returns a sanitized SVG string (never throws on benign input; on a
 *  missing window it returns '' so the caller keeps its fallback). */
export function sanitizeSvg(svg: string, win?: Window): string {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!w) return '';
  const dp = purifierFor(w);
  // sanitize() returns a string under our (non-RETURN_DOM) config.
  return dp.sanitize(svg, SVG_CONFIG) as string;
}

/* The SVG drawing elements that constitute a *rendered* diagram. If a sanitized
   SVG contains none of these (e.g. it is empty, or the only content was a
   <script>/<foreignObject> the scrub stripped, leaving a bare <svg></svg>),
   there is nothing to show and the caller MUST keep its escaped code-block
   fallback instead of injecting an empty SVG. We look for ANY descendant SVG
   shape/text/structural drawing element; <defs>/<style>/<metadata> alone do
   NOT count as renderable content. */
const RENDERABLE_SVG_ELEMENTS = new Set([
  'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'image', 'use', 'marker', 'symbol',
]);

/** Pure predicate (DOMPurify-free, jsdom-testable): does this SANITIZED SVG
 *  string actually carry rendered content, or did sanitization leave a bare/
 *  empty <svg> with nothing to draw?
 *
 *  Returns true ONLY when the parsed SVG has at least one descendant drawing
 *  element (g/path/rect/circle/ellipse/line/polyline/polygon/text/tspan/
 *  textPath/image/use/marker/symbol). An empty string, parse failure, an <svg>
 *  with zero element children, or an <svg> whose only children are inert
 *  containers (defs/style/metadata/title/desc) → false, so the caller degrades
 *  to the fallback.
 *
 *  Defensive: never throws (returns false on any anomaly). Uses the supplied
 *  window's DOMParser; in the browser `win` defaults to the global window. */
export function svgHasRenderableContent(svg: string, win?: Window): boolean {
  if (!svg || svg.trim() === '') return false;
  const w = (win ?? (typeof window !== 'undefined' ? window : undefined)) as
    | (Window & typeof globalThis)
    | undefined;
  if (!w || typeof w.DOMParser === 'undefined') return false;
  try {
    const doc = new w.DOMParser().parseFromString(svg, 'image/svg+xml');
    // A parse error yields a <parsererror> document (or no root) — not renderable.
    if (!doc || doc.getElementsByTagName('parsererror').length > 0) return false;
    const root = doc.documentElement;
    if (!root) return false;
    // Walk every descendant element; localName is namespace-agnostic and
    // lower-cased by the SVG parser, so it matches our allow-list directly.
    const all = root.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const node = all[i];
      if (!node) continue;
      const name = (node.localName || '').toLowerCase();
      if (RENDERABLE_SVG_ELEMENTS.has(name)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
