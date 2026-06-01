/* ============================================================
 * Loom — cross-OS path normalization (Law 3 helpers)
 * ------------------------------------------------------------
 * The renderer-facing CONTRACT (FileNode.path, FileEvent.path,
 * FileSearchResult.path, FileNameMatch.path) is ALWAYS root-relative
 * POSIX ('/'-separated) on EVERY OS, while all fs access uses the
 * platform's NATIVE separators. These two pure functions are the
 * single conversion chokepoint between the two worlds:
 *
 *   nativeToPosixRel(root, abs)      native abs path -> POSIX rel  (for the contract)
 *   posixRelToNative(root, posixRel) POSIX rel  -> native abs path (for fs access)
 *
 * WINDOWS-SPECIFIC HANDLING (cannot be runtime-tested here — no Windows):
 *   - On Windows, `path.sep` is '\\' and `path.relative` returns a
 *     backslash-separated path (e.g. 'sub\\b.md'). nativeToPosixRel
 *     replaces EVERY native separator with '/' so the contract is POSIX.
 *   - Going the other way, a POSIX rel from the renderer (e.g. 'sub/b.md')
 *     is passed to the NATIVE `path.join(root, rel)`. Node's win32 path
 *     parser accepts '/' as a separator, so the forward slashes resolve
 *     correctly into 'C:\\root\\sub\\b.md'. We DO NOT hardcode '/' in fs
 *     joins nor '\\' in the contract — the active `path` module decides
 *     the native separator, and POSIX is produced explicitly.
 *   - A drive-relative or absolute POSIX rel (an escape attempt) survives
 *     into the native join unchanged; the caller (resolveInRoot) re-proves
 *     containment lexically + physically AFTER this conversion, so an
 *     escape on any OS is still rejected (Law 3 holds).
 *
 * `pathMod` is injected (defaults to the live `node:path`) so the unit
 * tests can pin BOTH `path.posix` and `path.win32` behavior on Linux,
 * encoding the Windows expectation correct-by-construction.
 * ============================================================ */
import nodePath from 'node:path';

/** The slice of `node:path` these helpers use (so `path.posix` / `path.win32`
 *  can be injected for cross-OS unit testing on a single host). */
export interface PathModule {
  sep: string;
  relative(from: string, to: string): string;
  join(...parts: string[]): string;
}

/** Convert a NATIVE absolute path (already known/proven to be inside `root`)
 *  to its root-relative POSIX form for the renderer contract. The native
 *  separators produced by `path.relative` are normalized to '/' on every OS
 *  (a no-op on POSIX; converts '\\' -> '/' on Windows). Returns '' for the
 *  root itself. */
export function nativeToPosixRel(
  root: string,
  abs: string,
  pathMod: PathModule = nodePath,
): string {
  const rel = pathMod.relative(root, abs);
  // WINDOWS: split on the native sep ('\\') and rejoin with '/'. On POSIX the
  // sep is already '/' so this is an identity transform.
  return rel.split(pathMod.sep).join('/');
}

/** Convert a root-relative POSIX path from the renderer contract back to a
 *  NATIVE absolute path for fs access. The POSIX '/'-separated rel is handed
 *  to the NATIVE `path.join`, which yields native separators; Node's win32
 *  parser accepts '/' as a separator so this round-trips on Windows. The
 *  caller MUST still re-prove containment on the result (Law 3) — this helper
 *  performs NO security check; it is purely a separator/shape conversion. */
export function posixRelToNative(
  root: string,
  posixRel: string,
  pathMod: PathModule = nodePath,
): string {
  // path.join collapses '.'/'..' segments and emits native separators. We pass
  // the POSIX rel verbatim; win32's parser treats '/' and '\\' equivalently.
  return pathMod.join(root, posixRel);
}
