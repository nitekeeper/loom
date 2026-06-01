/* ============================================================
 * Loom — sandbox boundary (Law 3, FR-3, NFR-2, AC-2)
 * ------------------------------------------------------------
 * Confines ALL filesystem access to the launch root. Every path the
 * renderer requests (via the readFile IPC bridge) and every path the
 * watcher reports passes through resolveInRoot(), which rejects:
 *   - absolute paths that resolve outside the root,
 *   - '..' traversal that escapes the root,
 *   - symlinks whose real target points outside the root.
 *
 * Containment is enforced both lexically (on the resolved logical path)
 * AND physically (on fs.realpath, which collapses symlinks). The
 * physical check is the authoritative one — a symlink inside the root
 * pointing to /etc/passwd is rejected because its realpath is outside.
 *
 * Reading policy (Law 1 / Law 2):
 *   - md / code / svg / html  -> return UTF-8 text (shown as source or
 *     safe-rendered markdown by the Viewer; NEVER executed).
 *   - image / binary          -> text=null. We NEVER read or encode the
 *     bytes; the Viewer shows a safe placeholder / metadata card only.
 *   - A max text size (MAX_TEXT_BYTES) guards against pathological reads.
 * ============================================================ */
import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import * as path from 'node:path';
import type { FileContent, FileMeta, FileNode } from '../shared/types.js';
import { dispatchFor, extensionOf, kindOf } from '../shared/dispatch.js';
import { nativeToPosixRel } from './pathutil.js';

export interface Sandbox {
  /** The absolute, canonical root. */
  readonly root: string;
  /** Display name shown in title bar / explorer (FR-35, FR-38). */
  readonly rootName: string;
  /** Resolve a root-relative path to an absolute one, or throw if it escapes. */
  resolveInRoot(relPath: string): string;
  /** Build the full root-scoped tree. */
  buildTree(): FileNode;
  /** Read + dispatch a file for the Viewer (text only for renderable kinds). */
  readFile(relPath: string): FileContent;
}

/** Hard ceiling on text we will read into memory for the Viewer (2 MB).
 *  Larger text files are reported via metadata only (text=null). */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Directory / entry names never surfaced in the tree (FR-3 hygiene).
 *  '.loom' is Loom's own DB dir under the root; the rest are noise/secrets. */
const SKIP_NAMES: ReadonlySet<string> = new Set([
  '.loom',
  'node_modules',
  '.git',
]);

/** Guard against unbounded/cyclic walks via symlinked directories. */
const MAX_TREE_DEPTH = 64;

/* ------------------------------------------------------------------ */
/* Pure formatters for the FileMeta card (FR-43). Self-contained so    */
/* the main process has no renderer dependency.                        */
/* ------------------------------------------------------------------ */

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const unit = units[unitIdx] ?? 'KB';
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

/** Human-readable type label from extension + kind (e.g. "PNG image"). */
function typeLabel(name: string): string {
  const ext = extensionOf(name);
  const kind = kindOf(name);
  switch (kind) {
    case 'md':
      return 'Markdown document';
    case 'svg':
      return 'SVG source';
    case 'html':
      return 'HTML source';
    case 'image':
      return ext ? `${ext.toUpperCase()} image` : 'Image';
    case 'code':
      return ext ? `${ext.toUpperCase()} source` : 'Text file';
    case 'binary':
    default:
      return ext ? `${ext.toUpperCase()} file` : 'Binary file';
  }
}

function humanModified(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs)) return 'unknown';
  // Deterministic ISO-like local string; the renderer may reformat.
  const d = new Date(mtimeMs);
  return d.toLocaleString();
}

/** Kinds whose textual content the Viewer renders (Law 1: as source /
 *  safe markdown). All other kinds are placeholder/metadata only. */
function isTextKind(name: string): boolean {
  const kind = kindOf(name);
  return kind === 'md' || kind === 'code' || kind === 'svg' || kind === 'html';
}

/* ------------------------------------------------------------------ */
/* Sandbox factory                                                     */
/* ------------------------------------------------------------------ */

export function createSandbox(rootArg: string): Sandbox {
  // Canonicalize the root ONCE at construction. realpathSync collapses
  // any symlinks in the root path itself so later containment checks
  // compare like-for-like physical paths. If the root cannot be
  // canonicalized (missing), fall back to a lexical resolve and let
  // per-operation stats surface the error.
  const resolvedRoot = path.resolve(rootArg);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(resolvedRoot);
  } catch {
    canonicalRoot = resolvedRoot;
  }
  const root = canonicalRoot;
  const rootName = path.basename(root) || root;

  /** True iff `abs` is the root itself or strictly contained within it.
   *  Uses path.relative so the check is robust on both POSIX and Win32
   *  separators and is not fooled by a sibling prefix (e.g. /root-evil).
   *  WINDOWS: the live `path` is path.win32, whose `path.relative` is
   *  CASE-INSENSITIVE — so a request for 'C:\\SRV\\root\\x' against canonical
   *  root 'C:\\srv\\root' correctly stays contained (the real, case-insensitive
   *  FS resolves them to the same entry, and realpathSync.native canonicalizes
   *  case). Containment is therefore correct on win32; the emitted contract
   *  path preserves the as-requested case verbatim (a cosmetic dedup concern
   *  for the renderer's keying, never a Law-3 escape). */
  function isInsideRoot(abs: string): boolean {
    if (abs === root) return true;
    const rel = path.relative(root, abs);
    // Outside if relative escapes ('..') or is itself absolute (different drive).
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /** Resolve a (possibly absolute) request path and PROVE it is inside
   *  the root both lexically and — when the entry exists — physically.
   *  Throws on any escape. This is the single chokepoint (Law 3). */
  function resolveInRoot(relPath: string): string {
    if (typeof relPath !== 'string') {
      throw new Error('resolveInRoot: path must be a string');
    }
    // Reject NUL bytes outright (path-truncation / poison-null defense).
    if (relPath.includes('\0')) {
      throw new Error('resolveInRoot: path contains NUL byte');
    }

    // Resolve the request AGAINST the root. path.resolve treats an
    // absolute relPath as overriding the base, which is exactly how an
    // attacker would try to escape — so we must re-verify containment
    // of the RESULT, never trust the input shape.
    // WINDOWS: relPath is the POSIX ('/'-separated) contract path from the
    // renderer. Node's win32 path.resolve accepts '/' as a separator, so a
    // contract path like 'sub/b.md' resolves into the native 'C:\\root\\sub\\
    // b.md'. No manual separator swap is needed (and we must NOT hardcode '/'
    // in the native join). isInsideRoot below uses path.relative, robust to
    // drive-letter + backslash forms, and realpath collapses the canonical
    // (backslash) physical path — so containment holds with native separators.
    const candidate = path.resolve(root, relPath);

    // Lexical containment: collapses '.'/'..' segments logically.
    if (!isInsideRoot(candidate)) {
      throw new Error(`resolveInRoot: path escapes sandbox root: ${relPath}`);
    }

    // Physical containment: realpath collapses symlinks. If the entry
    // (or its nearest existing ancestor) resolves outside the root, the
    // request is a symlink escape and is rejected. We walk up to the
    // nearest existing path because a not-yet-created file legitimately
    // has no realpath, but every existing ancestor MUST be contained.
    const physical = realpathExistingPrefix(candidate);
    if (physical !== null && !isInsideRoot(physical)) {
      throw new Error(`resolveInRoot: path escapes sandbox root via symlink: ${relPath}`);
    }

    return candidate;
  }

  /** realpath the deepest existing prefix of `abs`. Returns the canonical
   *  path of that prefix, or null if nothing in the chain exists. */
  function realpathExistingPrefix(abs: string): string | null {
    let current = abs;
    // Bound the climb to the filesystem root to avoid an infinite loop.
    for (let i = 0; i < 4096; i += 1) {
      try {
        return realpathSync.native(current);
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return null; // reached fs root
        current = parent;
      }
    }
    return null;
  }

  /** lstat-free safe stat: resolveInRoot has already proven containment,
   *  so a plain statSync here follows the (contained) link target. */
  function statInRoot(abs: string): Stats {
    return statSync(abs);
  }

  /** Convert an absolute, contained path to its root-relative POSIX form for
   *  the renderer contract. WINDOWS: nativeToPosixRel converts the native '\\'
   *  separators that path.relative produces into '/' so FileNode.path /
   *  FileContent.path are POSIX on every OS (the renderer contract). The
   *  inverse (POSIX rel -> native abs) happens in resolveInRoot via
   *  path.resolve(root, relPath), whose win32 parser accepts '/' separators. */
  function toRelPosix(abs: string): string {
    return nativeToPosixRel(root, abs, path);
  }

  function buildNode(abs: string, name: string, depth: number): FileNode | null {
    let st: Stats;
    try {
      // stat (FOLLOWS symlinks). Symlink ESCAPES are already dropped by the
      // realpathExistingPrefix + isInsideRoot guard in the CALLER (buildTree /
      // the recursive loop below) BEFORE we ever recurse here, and again
      // physically in resolveInRoot for reads (Law 3). This stat does NOT guard
      // containment — it only CLASSIFIES file vs dir for a path already proven
      // contained. (Same on Windows: NTFS symlinks/junctions are likewise
      // pre-filtered by the caller's realpath check, not by this stat.)
      st = statSync(abs, { throwIfNoEntry: true });
    } catch {
      return null; // vanished mid-walk; skip silently
    }

    const relPosix = toRelPosix(abs);

    if (st.isDirectory()) {
      const children: FileNode[] = [];
      if (depth < MAX_TREE_DEPTH) {
        let entries: Dirent[];
        try {
          entries = readdirSync(abs, { withFileTypes: true });
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          const entryName = entry.name;
          if (shouldSkip(entryName)) continue;
          const childAbs = path.join(abs, entryName);
          // Containment guard: an entry that resolves (via symlink) out of
          // the root is dropped from the tree entirely (Law 3).
          const childPhysical = realpathExistingPrefix(childAbs);
          if (childPhysical !== null && !isInsideRoot(childPhysical)) continue;
          const child = buildNode(childAbs, entryName, depth + 1);
          if (child) children.push(child);
        }
        sortNodes(children);
      }
      return {
        type: 'dir',
        name,
        path: relPosix,
        ext: '',
        children,
      };
    }

    if (st.isFile()) {
      return {
        type: 'file',
        name,
        path: relPosix,
        ext: extensionOf(name),
        kind: kindOf(name),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    }

    // Sockets / FIFOs / devices / dangling symlinks: not representable.
    return null;
  }

  function buildTree(): FileNode {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const children: FileNode[] = [];
    for (const entry of entries) {
      const entryName = entry.name;
      if (shouldSkip(entryName)) continue;
      const childAbs = path.join(root, entryName);
      const childPhysical = realpathExistingPrefix(childAbs);
      if (childPhysical !== null && !isInsideRoot(childPhysical)) continue;
      const child = buildNode(childAbs, entryName, 1);
      if (child) children.push(child);
    }
    sortNodes(children);
    return {
      type: 'dir',
      name: rootName,
      path: '',
      ext: '',
      children,
    };
  }

  function readFile(relPath: string): FileContent {
    const abs = resolveInRoot(relPath);
    const st = statInRoot(abs);
    if (!st.isFile()) {
      throw new Error(`readFile: not a regular file: ${relPath}`);
    }

    const relPosix = toRelPosix(abs);
    const name = path.basename(abs);
    const dispatch = dispatchFor(name);

    const meta: FileMeta = {
      name,
      size: humanSize(st.size),
      type: typeLabel(name),
      modified: humanModified(st.mtimeMs),
    };

    let text: string | null = null;
    // Law 2: only renderable text kinds are read; images/binaries are
    // NEVER read or encoded — metadata/placeholder only. A text file
    // over the size cap is also treated as metadata-only to bound memory.
    if (isTextKind(name) && st.size <= MAX_TEXT_BYTES) {
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        text = null;
      }
    }

    return { path: relPosix, dispatch, meta, text };
  }

  return {
    root,
    rootName,
    resolveInRoot,
    buildTree,
    readFile,
  };
}

/* ------------------------------------------------------------------ */
/* Module-level pure helpers                                           */
/* ------------------------------------------------------------------ */

/** True if a directory entry must be excluded from the tree:
 *  Loom's own state dir, VCS/dep noise, and dotfiles/dotdirs. */
function shouldSkip(name: string): boolean {
  if (SKIP_NAMES.has(name)) return true;
  // Skip all dotfiles/dotdirs (secrets, caches) but never '.'/'..'.
  if (name.startsWith('.')) return true;
  return false;
}

/** Sort: directories first, then case-insensitive alpha, stable. */
function sortNodes(nodes: FileNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    // Tie-break on exact name so the order is fully deterministic.
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
}
