/* ============================================================
 * Loom — safe external-URL gate (shared: renderer + main)
 * ------------------------------------------------------------
 * Content rendered in Loom (markdown files, chat messages) is
 * AGENT-AUTHORED and potentially hostile. When the human clicks a
 * link we open it in their real browser via shell.openExternal —
 * but ONLY for schemes that are safe to hand off: http / https (web
 * pages) and mailto (the mail client). Everything else —
 * javascript:, file:, data:, vbscript:, blob:, relative/unparseable
 * — is rejected, so an agent link can neither execute code nor open
 * a local resource.
 *
 * This ONE gate is applied at every layer (renderer link rendering,
 * the IPC open handler, and the window navigation backstop) so the
 * allow-list can never drift between them. Pure (URL only) — no
 * Node/DOM/Electron deps, so it works in all three bundles + tests.
 * ============================================================ */

/** Schemes safe to hand to a browser / shell.openExternal. */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/** Return the NORMALIZED url when `raw` is an absolute http/https/mailto URL,
 *  else null. Relative, unparseable, and dangerous-scheme targets return null
 *  (never navigable, never opened). */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // relative / unparseable — no base document for agent content
  }
  return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
}
