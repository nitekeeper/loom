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
 * Beyond the scheme allow-list, the gate enforces three extra rules
 * that close known abuse surfaces in agent-authored content:
 *   - NO userinfo: a URL carrying any username/password (e.g.
 *     `http://u:p@host` — and the classic spoof `http://legit.com@evil.com`
 *     which parses to host evil.com) is rejected. Legit web/mail links
 *     never embed credentials, so nothing legitimate breaks.
 *   - NO padded input: a `raw` with leading/trailing whitespace is
 *     rejected outright (explicit, rather than relying on URL()
 *     normalization to silently trim it).
 *   - mailto is BARE-SINGLE-ADDRESS ONLY: `mailto:a@b.com` is accepted, but
 *     any mailto with a query (?subject=/?body=), a fragment, no `@`
 *     (e.g. `mailto:foo`), or a multi-recipient list is rejected. The check
 *     validates the PERCENT-DECODED path (so a `%3F`-encoded `?` or `%0D%0A`
 *     CRLF that an RFC-6068 handler would decode cannot smuggle header/option
 *     metacharacters past url.search/url.hash): the decoded payload must be a
 *     single addr-spec (one `@`, no ? # & , ; or whitespace/CR/LF). This
 *     removes the OS mail-handler argument-injection surface — no
 *     agent-supplied subject/body/cc.
 *
 * This ONE gate is applied at every layer (renderer link rendering,
 * the IPC open handler, and BOTH window navigation backstops — main +
 * capture) so the allow-list can never drift between them. Pure (URL
 * only) — no Node/DOM/Electron deps, so it works in all bundles + tests.
 * ============================================================ */

/** Schemes safe to hand to a browser / shell.openExternal. */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/** Return the NORMALIZED url when `raw` is an absolute http/https/mailto URL
 *  with NO embedded credentials, NO surrounding whitespace, and — for mailto —
 *  a BARE single address (no query/fragment, no header/option metacharacters in
 *  the DECODED path, exactly one `@`). Else null. Relative, unparseable,
 *  dangerous-scheme, userinfo-bearing, padded, and parameterized (incl.
 *  percent-encoded) mailto targets all return null (never navigable, never
 *  opened). */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  // Reject padded input explicitly rather than relying on URL() to trim it.
  if (raw !== raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // relative / unparseable — no base document for agent content
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
  // Reject embedded credentials/userinfo. Closes the exfil finding AND the
  // classic spoof `http://legit.com@evil.com` (host parses to evil.com).
  if (url.username !== '' || url.password !== '') return null;
  // mailto: accept ONLY a bare single-recipient address — no injectable
  // subject/body/cc params, no fragment, no header metacharacters. Removes the
  // OS mail-handler argument surface. Note: a literal `?`/`#` populates
  // url.search/url.hash, but an agent can PERCENT-ENCODE the separator
  // (%3F for `?`, %0D%0A for CRLF) so those stay empty while url.pathname still
  // carries the payload — and RFC 6068 handlers percent-decode the path before
  // parsing, reconstituting subject/body/cc. So we validate the DECODED path:
  // it must be exactly one bare addr-spec (one `@`, no header/option/separator
  // metacharacters ? # & , ; or whitespace incl. CR/LF).
  if (url.protocol === 'mailto:') {
    if (url.search !== '' || url.hash !== '') return null;
    let addr: string;
    try {
      addr = decodeURIComponent(url.pathname);
    } catch {
      return null; // malformed percent-encoding — not a clean bare address
    }
    if (!/^[^\s?#&,;]+@[^\s?#&,;]+$/.test(addr)) return null;
  }
  return url.href;
}
