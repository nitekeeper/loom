/* ============================================================
 * Loom — RENDERED-markdown reading-column width mode (pure logic)
 * ------------------------------------------------------------
 * The Viewer's RENDERED (.md) reading column has two width modes:
 *   'fit'  — the comfortable predefined measure (CSS max-width:792px).
 *   'full' — the column fills the Viewer width (CSS max-width:none),
 *            keeping the side padding so text never glues to the edges.
 *
 * The chosen mode persists in localStorage (sticky across files AND app
 * restarts; first run / fresh install defaults to 'fit'), exactly like
 * Loom already persists the chat/explorer pane widths. A capture-only
 * `?mdwidth=full|fit` URL hint can override the persisted value so
 * headless e2e capture renders either width deterministically — the same
 * pattern as the `?foldall` / `?chatw` / `?chathidden` capture hints.
 *
 * The DECISION logic lives here as PURE, DOM-free functions (taking their
 * inputs explicitly) so it is unit-testable WITHOUT a DOM/localStorage,
 * mirroring lib/closefile.ts. The thin impure wrappers (readInitialMdWidth /
 * persistMdWidth) touch location.search / window.localStorage and are each
 * guarded in try/catch exactly like the App.tsx readers (localStorage may
 * throw or be absent).
 *
 * SECURITY (Law 1): the hint + stored values are coerced to the closed
 * 'fit'|'full' set and used ONLY to pick a CSS data-attribute — they are
 * NEVER interpolated into markup, so there is no HTML sink here.
 * ============================================================ */

/** The two RENDERED-markdown reading-column width modes. */
export type WidthMode = 'fit' | 'full';

/** Persisted localStorage key for the chosen width mode ('fit'/'full').
 *  Mirrors App.tsx's CHAT_WIDTH_KEY / CHAT_HIDDEN_KEY persistence keys. */
export const MD_WIDTH_KEY = 'loom.viewer.mdWidth';

/** Default mode when nothing is persisted (first run / fresh install): the
 *  comfortable predefined 792px measure. */
export const MD_WIDTH_DEFAULT: WidthMode = 'fit';

/** True only for the two valid modes — the single closed-set gate the hint
 *  + stored coercion both apply (anything else ⇒ null, never a CSS value). */
function isWidthMode(raw: string | null): raw is WidthMode {
  return raw === 'fit' || raw === 'full';
}

/** Parse the capture-only `?mdwidth=full|fit` hint from a query string, or
 *  null when absent/invalid so localStorage/default can take over. Pure:
 *  takes the raw `location.search` (or null) explicitly. Parallel to App's
 *  readChatWidthHint / Viewer's readFoldAllHint, but the closed 'fit'|'full'
 *  set means an unrecognized value is treated as absent (null), not a guess. */
export function parseMdWidthHint(search: string | null): WidthMode | null {
  if (search === null) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const raw = params.get('mdwidth');
  return isWidthMode(raw) ? raw : null;
}

/** Coerce a raw localStorage value to a WidthMode, or null when unset/garbage
 *  (so the default applies). Pure: takes the stored string (or null). */
export function coerceStoredMdWidth(raw: string | null): WidthMode | null {
  return isWidthMode(raw) ? raw : null;
}

/** Resolve the initial mode from the (already-parsed) hint + stored value:
 *  capture hint wins, else persisted, else the default ('fit'). Pure + total.
 *  Mirrors App's initialChatWidth/initialChatHidden precedence (hint>stored>
 *  default). */
export function resolveInitialMdWidth(
  hint: WidthMode | null,
  stored: WidthMode | null,
): WidthMode {
  return hint ?? stored ?? MD_WIDTH_DEFAULT;
}

/** Read the initial width mode for this session: the capture hint wins, else
 *  the persisted value, else the default. Impure wrapper — touches
 *  location.search + window.localStorage, each guarded exactly like the
 *  App.tsx readers (the environment may lack location/localStorage, and
 *  localStorage access can throw). */
export function readInitialMdWidth(): WidthMode {
  let hint: WidthMode | null = null;
  try {
    hint = typeof location === 'undefined' ? null : parseMdWidthHint(location.search);
  } catch {
    hint = null;
  }
  let stored: WidthMode | null = null;
  try {
    stored = coerceStoredMdWidth(window.localStorage.getItem(MD_WIDTH_KEY));
  } catch {
    stored = null;
  }
  return resolveInitialMdWidth(hint, stored);
}

/** Persist the chosen width mode to localStorage so it sticks across files
 *  AND app restarts. Impure wrapper — guarded like the App.tsx setters
 *  (localStorage may be unavailable; the mode still applies in-session). */
export function persistMdWidth(mode: WidthMode): void {
  try {
    window.localStorage.setItem(MD_WIDTH_KEY, mode);
  } catch {
    /* localStorage may be unavailable; the mode still applies in-session. */
  }
}
