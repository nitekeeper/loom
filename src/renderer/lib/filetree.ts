/* ============================================================
 * Loom — live file-tree mutation (FR-39)
 * ------------------------------------------------------------
 * Keeps the renderer's lazily-loaded FileNode tree in sync with live
 * FileEvents (add / addDir / unlink / unlinkDir) from the watcher — so a
 * file or folder created in an ALREADY-EXPANDED directory appears
 * immediately, instead of only after a relaunch (the bug this fixes).
 *
 * Pure + immutable: returns a NEW tree (sharing untouched subtrees so
 * React can skip them) or the SAME reference when nothing changed. Only a
 * LOADED directory (one that already has a `children` array) is spliced —
 * a collapsed / not-yet-loaded dir reads fresh from disk on expand, so
 * there is nothing to insert into and we leave it alone. Insert position
 * matches sandbox.buildTree's order exactly (dirs-first, then
 * case-insensitive name) so a live insert lands where a relaunch shows it.
 *
 * No DOM/React deps so it is unit-tested via the testkit bundle.
 * ============================================================ */
import type { FileNode } from '../../shared/types.js';
import { extensionOf, kindOf } from '../../shared/dispatch.js';

/** Parent directory path of a root-relative POSIX path ('' = the root). */
function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Last path segment (base name). */
function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** Order two siblings EXACTLY as sandbox.buildTree does: directories first,
 *  then case-insensitive name, tie-broken on the exact name. Keep in sync. */
function compareNodes(a: FileNode, b: FileNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** Build a FileNode for a path first seen via a live FileEvent. A file gets
 *  ext + kind from the dispatch table; a directory is SHALLOW (loaded:false,
 *  no children) so expanding it reads fresh. size/mtimeMs are unknown from a
 *  FileEvent and omitted (filled in on the next full tree read). */
export function makeNode(path: string, isDir: boolean): FileNode {
  const name = baseName(path);
  if (isDir) return { type: 'dir', name, path, ext: '', loaded: false };
  return { type: 'file', name, path, ext: extensionOf(name), kind: kindOf(name) };
}

/** Apply `fn` to the LOADED directory at `dirPath` ('' = root) within `tree`,
 *  immutably, descending ONLY toward the target. Returns the same reference
 *  when nothing changed, or when the target dir is absent / not yet loaded
 *  (no `children` array) — so untouched subtrees keep their identity. */
function mutateDir(
  tree: FileNode,
  dirPath: string,
  fn: (dir: FileNode) => FileNode,
): FileNode {
  if (tree.path === dirPath) {
    if (tree.type !== 'dir' || tree.children === undefined) return tree;
    return fn(tree);
  }
  if (tree.children === undefined) return tree;
  let changed = false;
  const next = tree.children.map((child) => {
    // Recurse only into the directory on the target's ancestor chain.
    if (
      child.type !== 'dir' ||
      (dirPath !== child.path && !dirPath.startsWith(`${child.path}/`))
    ) {
      return child;
    }
    const updated = mutateDir(child, dirPath, fn);
    if (updated !== child) changed = true;
    return updated;
  });
  return changed ? { ...tree, children: next } : tree;
}

/** Insert `node` into its parent dir (derived from node.path), immutably,
 *  keeping builder sort order. No-op when the parent is absent/unloaded or a
 *  child with the same path already exists. */
export function insertNode(tree: FileNode, node: FileNode): FileNode {
  return mutateDir(tree, parentOf(node.path), (dir) => {
    const children = dir.children ?? [];
    if (children.some((c) => c.path === node.path)) return dir;
    return { ...dir, children: [...children, node].sort(compareNodes) };
  });
}

/** Remove the node at `path` from its parent dir, immutably. No-op when the
 *  parent is unloaded or the child is absent. */
export function removeNode(tree: FileNode, path: string): FileNode {
  return mutateDir(tree, parentOf(path), (dir) => {
    if (dir.children === undefined) return dir;
    const next = dir.children.filter((c) => c.path !== path);
    return next.length === dir.children.length ? dir : { ...dir, children: next };
  });
}
