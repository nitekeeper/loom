/* ============================================================
 * Loom — global anchor-navigation guard (AC-21 / SEC-5)
 * ------------------------------------------------------------
 * The renderer half of the navigable-links feature, extracted as a
 * PURE-DOM module (no React, no Electron) so it can be unit-tested
 * against a real DOM (jsdom) using the REAL renderMarkdown output —
 * proving a regression in the click guard would be caught.
 *
 * It depends ONLY on DOM globals (document / window) and the typed
 * `window.loom.openExternal` bridge (declared globally in shared/types).
 * ============================================================ */

/** Containers whose innerHTML is agent-authored, renderer-sanitized markdown
 *  (Viewer `.md`, chat `.msg-body`, inbox `.ib-body`). We intercept every anchor
 *  activation (mouse click OR keyboard Enter/Space) here: a VETTED external link
 *  (data-loom-ext — set by the markdown renderer ONLY for safe http/https/mailto)
 *  opens in the user's BROWSER via openExternal; any other (neutralized) link is
 *  blocked. The window never navigates in-app regardless — main's nav guard
 *  backstops this (SEC-5). */
export const RENDERED_MARKDOWN_SELECTOR = '.md, .msg-body, .ib-body';

export function installGlobalAnchorGuard(): () => void {
  const onActivate = (e: Event): void => {
    if (e instanceof KeyboardEvent) {
      const k = e.key;
      if (k !== 'Enter' && k !== ' ' && k !== 'Spacebar') return;
    }
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const anchor = target.closest('a');
    if (anchor && anchor.closest(RENDERED_MARKDOWN_SELECTOR)) {
      // Never navigate in-app. A vetted external link opens in the real browser;
      // an inert/neutralized link is simply blocked.
      e.preventDefault();
      if (anchor.dataset.loomExt === '1') {
        const href = anchor.getAttribute('href');
        if (href) void window.loom.openExternal(href);
      }
    }
  };
  // Capture phase so we run before any bubbling default-navigation occurs.
  document.addEventListener('click', onActivate, true);
  document.addEventListener('keydown', onActivate, true);
  return () => {
    document.removeEventListener('click', onActivate, true);
    document.removeEventListener('keydown', onActivate, true);
  };
}
