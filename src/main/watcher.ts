/* ============================================================
 * Loom — file watcher (FR-14, FR-39, NFR-8)
 * ------------------------------------------------------------
 * Watches the sandbox root recursively and publishes FileEvents
 * to the event bus (add/change/unlink/addDir/unlinkDir). All
 * emitted paths are root-relative POSIX and MUST be contained to
 * the root (Law 3) — anything that resolves outside is dropped.
 *
 * ENGINE (the v0.5.4 fix):
 *   - macOS / Windows: a SINGLE native recursive `fs.watch(root,
 *     {recursive:true})`. The OS (FSEvents / ReadDirectoryChangesW)
 *     handles the whole subtree under one handle — no startup crawl
 *     and no per-directory descriptor. This replaces chokidar 4,
 *     which on macOS has no fsevents and instead sets up one
 *     `fs.watch` PER directory: on a large repo that crawl was both
 *     slow on every launch AND exhausted file descriptors (EMFILE),
 *     leaving the watch set partial. Native recursive watch sets up
 *     in sub-millisecond time regardless of repo size.
 *   - Linux: `fs.watch` has NO recursive mode, so chokidar remains
 *     the engine there (and as a fallback if native watch throws).
 *
 * The FROZEN factory signature is createWatcher(rootDir, bus). The
 * sandbox module is NOT injected here, so containment is enforced
 * locally: each path is resolved against the canonical root and
 * rejected if it escapes. (The renderer-facing readFile path goes
 * through sandbox.ts separately.)
 *
 * Realtime concerns:
 *   - The startup crawl is NOT reported: the native engine emits no
 *     initial snapshot, and the chokidar fallback uses
 *     ignoreInitial:true. The tree snapshot already covers the
 *     initial set; we only publish live mutations.
 *   - .loom/, dotfiles, node_modules and .git are ignored so the DB
 *     flush + VCS churn don't flood the bus (FR-39 live activity should
 *     reflect user/agent file work, not Loom's own writes).
 *   - Rapid duplicate (action,path) pairs are coalesced within a short
 *     window to avoid burst spam from editors doing multi-write saves.
 * ============================================================ */
import path from 'node:path';
import fs from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { EventBus } from './eventbus.js';
import type { FileAction, FileEvent } from '../shared/types.js';
import { nativeToPosixRel } from './pathutil.js';

export interface WatcherHandle {
  start(): void;
  stop(): Promise<void>;
}

/** Names that must never appear as a path segment (Loom internals + VCS +
 *  deps churn). Matches the directory itself and anything beneath it. */
const IGNORED_SEGMENTS = new Set<string>(['.loom', '.git', 'node_modules']);

/** Coalesce window: identical (action,path) events seen within this many
 *  ms of each other are collapsed into one. Editors frequently emit a
 *  burst of change events for a single save. */
const COALESCE_MS = 50;

/** Platforms where `fs.watch` supports `{recursive:true}` natively
 *  (one OS-level handle for the whole subtree). Linux does not. */
const NATIVE_RECURSIVE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Decide whether a path segment should cause the path to be ignored.
 * Drops .loom/ and well-known noise dirs, plus all other dotfiles/dirs.
 */
function isIgnoredSegment(seg: string): boolean {
  if (IGNORED_SEGMENTS.has(seg)) return true;
  // Any dotfile/dotdir (e.g. .DS_Store, .env is intentionally watched as a
  // regular file by dispatch, but as a watch target dotfiles are noise).
  return seg.length > 0 && seg.startsWith('.');
}

export function createWatcher(rootDir: string, bus: EventBus): WatcherHandle {
  // Canonicalize the root once. realpathSync collapses symlinks so the
  // containment check below compares like-for-like; fall back to resolve
  // if the root does not yet exist on disk.
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(path.resolve(rootDir));
  } catch {
    canonicalRoot = path.resolve(rootDir);
  }

  // Closes the active engine (native fs.FSWatcher or chokidar FSWatcher).
  // Null when stopped. A single closer keeps stop() engine-agnostic.
  let closer: (() => void | Promise<void>) | null = null;

  // Last-seen timestamp per "action\0path" key, for coalescing.
  const recent = new Map<string, number>();

  // Directories we've observed live (root-relative POSIX). The native engine
  // can't stat a path that's already gone, so on a deletion we consult this set
  // to emit unlinkDir vs unlink. Files default to unlink. Seeded lazily from
  // live events only — never from a crawl (that's the whole point).
  const knownDirs = new Set<string>();

  // Files observed live, so an atomic save (write-temp + rename-over) of a
  // file we already reported is a 'change', not a second 'add'. Grows only
  // with distinct files touched this session — the same accounting the NEW
  // badge already keeps renderer-side. (Native engine only.)
  const seenFiles = new Set<string>();

  /**
   * chokidar's `ignored` matcher (also reused by the native engine).
   * Returning true means "do not watch / drop". Receives absolute paths.
   * We ignore anything whose path, relative to the root, contains an ignored
   * segment, and anything that escapes root.
   */
  function ignored(absPath: string): boolean {
    // The root itself is always watched.
    if (absPath === canonicalRoot) return false;
    const rel = path.relative(canonicalRoot, absPath);
    // Escapes root (starts with '..' or is absolute) → ignore.
    if (rel === '') return false;
    if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
    const segments = rel.split(path.sep);
    for (const seg of segments) {
      if (isIgnoredSegment(seg)) return true;
    }
    return false;
  }

  /**
   * Convert an absolute path to a contained, root-relative POSIX path, or
   * null if it escapes the root (Law 3 belt-and-braces).
   */
  function toContainedRelPosix(absPath: string): string | null {
    const resolved = path.resolve(absPath);
    const rel = path.relative(canonicalRoot, resolved);
    if (rel === '') return ''; // the root itself
    // Escapes root (starts with '..' or is absolute / a different drive).
    // WINDOWS: path.relative across drive letters returns an ABSOLUTE path
    // (e.g. 'D:\\x'), which path.isAbsolute(win32) catches here -> dropped.
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    // WINDOWS: chokidar/fs.watch yield native ('\\'-separated) paths; convert
    // the native rel to POSIX ('/' ) for the FileEvent.path contract on every
    // OS. nativeToPosixRel is an identity transform on POSIX hosts.
    return nativeToPosixRel(canonicalRoot, resolved, path);
  }

  /** Drop coalescing keys older than the window so the map stays small. */
  function pruneRecent(now: number): void {
    if (recent.size < 256) return;
    for (const [key, ts] of recent) {
      if (now - ts > COALESCE_MS) recent.delete(key);
    }
  }

  function emit(action: FileAction, absPath: string): void {
    const relPosix = toContainedRelPosix(absPath);
    if (relPosix === null) return; // escaped root — never publish (Law 3)
    if (relPosix === '') return; // the root dir itself is not an event

    const now = Date.now();
    const key = `${action} ${relPosix}`;
    const last = recent.get(key);
    if (last !== undefined && now - last < COALESCE_MS) {
      // Duplicate within the coalesce window — collapse it.
      recent.set(key, now);
      return;
    }
    recent.set(key, now);
    pruneRecent(now);

    const event: FileEvent = {
      kind: 'file',
      action,
      path: relPosix,
      at: now,
    };
    bus.publish(event);
  }

  /** Best-effort error log that never throws (a watcher error must not crash
   *  the main process: transient EPERM, a deleted root, fd pressure, etc.). */
  function logError(err: unknown): void {
    try {
      console.error('[loom:watcher] error:', err);
    } catch {
      /* ignore */
    }
  }

  /**
   * Map one native fs.watch notification onto the FileEvent contract.
   * `eventType` is 'rename' (create/delete/move) or 'change' (content), and
   * `relNative` is the path relative to the root in native separators. The
   * on-disk existence check is the source of truth for add-vs-unlink; the
   * eventType disambiguates add (rename, exists) from change (change, exists).
   */
  function handleNative(eventType: string, relNative: string): void {
    const abs = path.resolve(canonicalRoot, relNative);
    if (ignored(abs)) return;
    const rel = toContainedRelPosix(abs);
    if (rel === null || rel === '') return;

    let stat: fs.Stats | null;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null; // vanished → a deletion
    }

    if (stat === null) {
      const wasDir = knownDirs.has(rel);
      knownDirs.delete(rel);
      emit(wasDir ? 'unlinkDir' : 'unlink', abs);
      return;
    }

    if (stat.isDirectory()) {
      // A directory 'change' (mtime touch on its entries) is noise; only the
      // first appearance is interesting. knownDirs gates the addDir + lets a
      // later deletion classify itself as unlinkDir.
      if (!knownDirs.has(rel)) {
        knownDirs.add(rel);
        emit('addDir', abs);
      }
      return;
    }

    if (!stat.isFile()) return; // sockets/fifos/etc. — not surfaced

    // A file. 'rename' on a path that now exists is a creation (or an
    // atomic-save move-over: if we've already seen it as a file, treat the
    // re-appearance as a change so it isn't re-counted as NEW). 'change' is a
    // plain content write.
    if (eventType === 'rename' && !knownDirs.has(rel) && !seenFiles.has(rel)) {
      seenFiles.add(rel);
      emit('add', abs);
    } else {
      seenFiles.add(rel);
      emit('change', abs);
    }
  }

  /** macOS / Windows: one native recursive watcher for the whole subtree. */
  function startNative(): void {
    const w = fs.watch(canonicalRoot, { recursive: true });
    w.on('change', (eventType, filename) => {
      if (filename === null || filename === undefined) return; // no path → can't act
      const name =
        typeof filename === 'string' ? filename : filename.toString('utf8');
      try {
        handleNative(String(eventType), name);
      } catch (err) {
        logError(err);
      }
    });
    w.on('error', (err: unknown) => logError(err));
    closer = () => w.close();
  }

  /** Linux (and native-failure fallback): chokidar walks + watches per-dir. */
  function startChokidar(): void {
    const w: FSWatcher = chokidar.watch(canonicalRoot, {
      ignoreInitial: true,
      ignored,
      // We resolve symlinks at the root boundary already; do not follow
      // symlinks into arbitrary locations (containment + avoids loops).
      followSymlinks: false,
      // Drain editor multi-writes before reporting a finished write so a
      // single save is one 'change', not a storm.
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 20,
      },
    });

    w.on('add', (p: string) => emit('add', p));
    w.on('change', (p: string) => emit('change', p));
    w.on('unlink', (p: string) => emit('unlink', p));
    w.on('addDir', (p: string) => emit('addDir', p));
    w.on('unlinkDir', (p: string) => emit('unlinkDir', p));
    w.on('error', (err: unknown) => logError(err));

    closer = () => w.close();
  }

  function start(): void {
    if (closer) return;
    if (NATIVE_RECURSIVE) {
      try {
        startNative();
        return;
      } catch (err) {
        // Native recursive watch unavailable on this host/FS — degrade to the
        // chokidar engine rather than running blind.
        logError(err);
        closer = null;
      }
    }
    startChokidar();
  }

  async function stop(): Promise<void> {
    const close = closer;
    closer = null;
    recent.clear();
    knownDirs.clear();
    seenFiles.clear();
    if (!close) return;
    await close();
  }

  return { start, stop };
}
