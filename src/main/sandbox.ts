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
  /** Build the SHALLOW root tree: the root plus its first level of children
   *  only. Directories are returned unloaded (loaded:false); deeper levels are
   *  fetched on demand via listDir() when the user expands a folder. */
  buildTree(): FileNode;
  /** One level of children for a contained directory (root-relative POSIX
   *  path). Used to lazily expand a folder in the explorer. */
  listDir(relPath: string): FileNode[];
  /** Depth-first walk of every FILE under the root (confined + skip-filtered),
   *  bounded by `maxFiles`. Search's traversal primitive — does NOT build the
   *  full tree. */
  walkFiles(maxFiles: number): FileNode[];
  /** Read + dispatch a file for the Viewer (text only for renderable kinds). */
  readFile(relPath: string): FileContent;
}

/** Hard ceiling on text we will read into memory for the Viewer (2 MB).
 *  Larger text files are reported via metadata only (text=null). */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Heavy VCS / dependency / internal dirs the SEARCH walk skips (so content
 *  search doesn't crawl git's binary object store or dep trees). The explorer
 *  TREE does NOT skip these — it shows everything (see classifyEntries). */
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

/** Bytes inspected by the text sniff. A NUL byte anywhere in this prefix marks
 *  the file binary (the heuristic git uses for blobs). */
const SNIFF_BYTES = 64 * 1024;

/** Read a file as UTF-8 text IFF it LOOKS textual — i.e. no NUL byte in its
 *  first SNIFF_BYTES. Returns the decoded string, or null for a binary file or
 *  any read error. This is how the viewer shows source whose EXTENSION isn't in
 *  the dispatch table (Dockerfile, Makefile, artisan, LICENSE, .env, …) without
 *  ever rendering true binaries as garbage. Law 1 safe (byte inspection, no
 *  parse/eval); the caller bounds size to MAX_TEXT_BYTES before calling. */
function readIfText(abs: string): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }
  const sniffLen = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < sniffLen; i += 1) {
    if (buf[i] === 0) return null; // NUL byte -> binary
  }
  return buf.toString('utf8');
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

  /** Read ONE directory level: its immediate entries, skip-filtered and
   *  containment-checked (Law 3), each classified via stat (which follows
   *  symlinks for a path already proven contained), then sorted dirs-first
   *  then case-insensitive alpha. This is the shared primitive behind
   *  listChildren() / buildTree() / listDir() / walkFiles(), so all four apply
   *  identical hygiene + ordering. Sockets/FIFOs/devices/dangling symlinks are
   *  dropped (not representable). */
  function classifyEntries(
    absDir: string,
    skipNoiseDirs = false,
  ): Array<{ name: string; abs: string; isDir: boolean; st: Stats | null }> {
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return [];
    }
    // PERF (Law 3 preserved): the expensive part is per-entry work — a
    // realpathSync.native (which canonicalizes the WHOLE path, resolving a
    // symlink at every level: O(path-depth) syscalls each) plus a statSync.
    // On a large dir, or a network / cloud-synced volume where each syscall has
    // high latency, that dominates listDir() and stalls the lazy expand. Two
    // facts let us skip almost all of it without weakening containment:
    //   1. A NON-symlink entry physically resides in `absDir`, which the caller
    //      already proved contained — only a SYMLINK can point outside root, so
    //      the realpath escape-check is needed for symlinks ONLY.
    //   2. A plain DIRECTORY becomes a shallow node (no size/mtime), so it needs
    //      no statSync at all — the Dirent's own type is enough.
    // The Dirent type comes from readdirSync({withFileTypes}) for free. When the
    // filesystem doesn't report a d_type (some network FS leave it UNKNOWN, so
    // every Dirent.isX() is false), we fall back to the original realpath+stat
    // path — correct everywhere, just without the speedup on those volumes.
    const out: Array<{
      name: string;
      abs: string;
      isDir: boolean;
      st: Stats | null;
    }> = [];
    for (const entry of entries) {
      const name = entry.name;
      // The TREE shows everything (FR-3: nothing hidden — dotfiles, .git,
      // node_modules, .loom all appear; deep dirs stay cheap via lazy loading).
      // Only the SEARCH walk (skipNoiseDirs=true) skips the heavy VCS/dep/
      // internal dirs, so content search doesn't crawl git's binary object
      // store or dependency trees.
      if (skipNoiseDirs && SKIP_NAMES.has(name)) continue;
      const childAbs = path.join(absDir, name);

      let isDir: boolean;
      let st: Stats | null = null;

      if (entry.isDirectory()) {
        // Plain directory: contained by (1), shallow node by (2) — no syscall.
        isDir = true;
      } else if (entry.isFile()) {
        // Plain file: contained by (1); stat ONLY for the node's size + mtime.
        try {
          st = statSync(childAbs, { throwIfNoEntry: true });
        } catch {
          continue; // vanished mid-walk; skip silently
        }
        isDir = false;
      } else {
        // Symlink, special file (socket/fifo/device), or an UNKNOWN-d_type
        // entry: take the original safe path — realpath-contain (Law 3), then
        // stat to follow + classify. Anything not a dir/file is dropped.
        const childPhysical = realpathExistingPrefix(childAbs);
        if (childPhysical !== null && !isInsideRoot(childPhysical)) continue;
        try {
          st = statSync(childAbs, { throwIfNoEntry: true });
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          isDir = true;
          st = null; // dir node carries no size/mtime
        } else if (st.isFile()) {
          isDir = false;
        } else {
          continue; // socket/fifo/device/dangling — not representable
        }
      }

      out.push({ name, abs: childAbs, isDir, st });
    }
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      // Tie-break on exact name so the order is fully deterministic.
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });
    return out;
  }

  /** Build a FILE node with full metadata. */
  function fileNode(name: string, relPosix: string, st: Stats): FileNode {
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

  /** Build a SHALLOW directory node: its children are NOT read yet
   *  (loaded:false, no `children` array). The renderer fetches them via
   *  listDir() only when the user expands the folder — so opening a repo never
   *  reads (or renders) files in unopened subfolders. */
  function dirNodeShallow(name: string, relPosix: string): FileNode {
    return {
      type: 'dir',
      name,
      path: relPosix,
      ext: '',
      loaded: false,
    };
  }

  /** The immediate children of `absDir`, one level deep — directories shallow
   *  (unloaded), files fully described. */
  function listChildren(absDir: string): FileNode[] {
    return classifyEntries(absDir).map((e) => {
      // e.st is non-null exactly when e.isDir is false (a file) — narrow on both
      // so fileNode receives a real Stats without a non-null assertion.
      if (e.isDir || e.st === null) return dirNodeShallow(e.name, toRelPosix(e.abs));
      return fileNode(e.name, toRelPosix(e.abs), e.st);
    });
  }

  /** The root node plus ONLY its first level of children (FR-2). Deeper levels
   *  load lazily via listDir() on expand. The root itself is marked loaded. */
  function buildTree(): FileNode {
    return {
      type: 'dir',
      name: rootName,
      path: '',
      ext: '',
      loaded: true,
      children: listChildren(root),
    };
  }

  /** One level of children for a contained directory, addressed by its
   *  root-relative POSIX path (the renderer contract). Powers lazy expansion.
   *  Throws (via resolveInRoot) on any escape; returns [] when the path is not
   *  a directory (e.g. it vanished, or it is a file). */
  function listDir(relPath: string): FileNode[] {
    const abs = resolveInRoot(relPath);
    let st: Stats;
    try {
      st = statSync(abs, { throwIfNoEntry: true });
    } catch {
      return [];
    }
    if (!st.isDirectory()) return [];
    return listChildren(abs);
  }

  /** Depth-first collect of every FILE under the root (confined + skip-
   *  filtered), in the same dirs-first / alpha order the tree shows, bounded by
   *  `maxFiles`. This is SEARCH's traversal primitive: it walks the filesystem
   *  on the fly and NEVER materializes the full directory tree, so the explorer
   *  tree can stay shallow + lazy. Returns FILE nodes only (callers match file
   *  NAMES via node.path and CONTENT via readFile()). */
  function walkFiles(maxFiles: number): FileNode[] {
    const out: FileNode[] = [];
    const visit = (absDir: string, depth: number): void => {
      if (out.length >= maxFiles) return;
      if (depth > MAX_TREE_DEPTH) return;
      // Search skips the heavy VCS/dep/internal dirs (skipNoiseDirs=true).
      for (const e of classifyEntries(absDir, true)) {
        if (out.length >= maxFiles) return;
        if (e.isDir) {
          visit(e.abs, depth + 1);
        } else if (e.st !== null) {
          out.push(fileNode(e.name, toRelPosix(e.abs), e.st));
        }
      }
    };
    visit(root, 1);
    return out;
  }

  function readFile(relPath: string): FileContent {
    const abs = resolveInRoot(relPath);
    const st = statInRoot(abs);
    if (!st.isFile()) {
      throw new Error(`readFile: not a regular file: ${relPath}`);
    }

    const relPosix = toRelPosix(abs);
    const name = path.basename(abs);
    let dispatch = dispatchFor(name);

    const meta: FileMeta = {
      name,
      size: humanSize(st.size),
      type: typeLabel(name),
      modified: humanModified(st.mtimeMs),
    };

    // Law 2: never read images/binaries (metadata-only); a file over the size
    // cap is also metadata-only to bound memory. Within those bounds:
    //   - a known text-render kind (md/svg/html/code by extension) is read as
    //     UTF-8 and rendered per its dispatch (markdown, safety-bannered HTML/
    //     SVG, or highlighted source);
    //   - an UNKNOWN extension (kind 'binary') is SNIFFED: the extension table
    //     can't enumerate every text file (Dockerfile, Makefile, artisan,
    //     LICENSE, dotfiles, …), so if the bytes look textual we show it as
    //     plain source. True binaries (NUL byte) stay metadata-only.
    let text: string | null = null;
    if (st.size <= MAX_TEXT_BYTES && dispatch.kind !== 'image') {
      if (isTextKind(name)) {
        try {
          text = readFileSync(abs, 'utf8');
        } catch {
          text = null;
        }
      } else if (dispatch.kind === 'binary') {
        const sniffed = readIfText(abs);
        if (sniffed !== null) {
          text = sniffed;
          // Recovered text from an unrecognized extension -> present as plain
          // highlighted source (no markdown render, no HTML/SVG safety banner).
          dispatch = { kind: 'code', renderState: 'SOURCE', safetyBanner: false };
        }
      }
    }

    return { path: relPosix, dispatch, meta, text };
  }

  return {
    root,
    rootName,
    resolveInRoot,
    buildTree,
    listDir,
    walkFiles,
    readFile,
  };
}

/* ------------------------------------------------------------------ */
/* Module-level pure helpers                                           */
/* ------------------------------------------------------------------ */

