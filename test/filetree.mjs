/* ============================================================
 * Loom — live file-tree mutation suite (node --test)
 * ------------------------------------------------------------
 * Pins the pure splice logic that keeps the renderer's
 * lazily-loaded FileNode tree in sync with watcher FileEvents, so a
 * file/folder created in an ALREADY-EXPANDED directory shows up
 * without a relaunch. DOM-free via the testkit bundle.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TESTKIT = path.join(root, 'dist', 'testkit.cjs');

let _kit = null;
async function kit() {
  if (_kit) return _kit;
  if (!existsSync(TESTKIT)) {
    throw new Error(`dist/testkit.cjs not found at ${TESTKIT} — run \`npm run build\` first.`);
  }
  _kit = await import(TESTKIT);
  return _kit;
}

/** A loaded root with a loaded `src/`, a COLLAPSED `docs/`, and a root file. */
function sampleTree() {
  return {
    type: 'dir', name: '', path: '', loaded: true, children: [
      { type: 'dir', name: 'docs', path: 'docs', ext: '', loaded: false }, // collapsed
      { type: 'dir', name: 'src', path: 'src', ext: '', loaded: true, children: [
        { type: 'file', name: 'a.ts', path: 'src/a.ts', ext: 'ts', kind: 'code' },
        { type: 'file', name: 'c.ts', path: 'src/c.ts', ext: 'ts', kind: 'code' },
      ] },
      { type: 'file', name: 'readme.md', path: 'readme.md', ext: 'md', kind: 'md' },
    ],
  };
}
const childPaths = (node) => (node.children ?? []).map((c) => c.path);
const find = (node, p) => node.children.find((c) => c.path === p);

test('FILETREE makeNode: a file gets ext + kind; a dir is shallow', async () => {
  const { makeNode } = await kit();
  assert.deepEqual(makeNode('src/new.ts', false), {
    type: 'file', name: 'new.ts', path: 'src/new.ts', ext: 'ts', kind: 'code',
  });
  const d = makeNode('src/newdir', true);
  assert.equal(d.type, 'dir');
  assert.equal(d.name, 'newdir');
  assert.equal(d.loaded, false);
  assert.equal(d.children, undefined, 'a new dir is shallow (reads fresh on expand)');
});

test('FILETREE insertNode: into a loaded subdir, in builder sort order', async () => {
  const { insertNode, makeNode } = await kit();
  const t = insertNode(sampleTree(), makeNode('src/b.ts', false));
  assert.deepEqual(childPaths(find(t, 'src')), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
});

test('FILETREE insertNode: a new dir sorts before files in the same parent', async () => {
  const { insertNode, makeNode } = await kit();
  const t = insertNode(sampleTree(), makeNode('zdir', true));
  assert.deepEqual(childPaths(t), ['docs', 'src', 'zdir', 'readme.md']);
});

test('FILETREE insertNode: into a COLLAPSED (unloaded) dir is a no-op', async () => {
  const { insertNode, makeNode } = await kit();
  const before = sampleTree();
  const after = insertNode(before, makeNode('docs/guide.md', false));
  assert.equal(after, before, 'unloaded parent -> same tree reference; it reads fresh on expand');
});

test('FILETREE insertNode: dedup — inserting an existing path is a no-op', async () => {
  const { insertNode, makeNode } = await kit();
  const before = sampleTree();
  assert.equal(insertNode(before, makeNode('src/a.ts', false)), before);
});

test('FILETREE insertNode: an absent parent is a no-op', async () => {
  const { insertNode, makeNode } = await kit();
  const before = sampleTree();
  assert.equal(insertNode(before, makeNode('nope/x.ts', false)), before);
});

test('FILETREE removeNode: removes from a loaded subdir; no-op when absent', async () => {
  const { removeNode } = await kit();
  const t = removeNode(sampleTree(), 'src/a.ts');
  assert.deepEqual(childPaths(find(t, 'src')), ['src/c.ts']);

  const before = sampleTree();
  assert.equal(removeNode(before, 'src/missing.ts'), before, 'absent child -> unchanged');
  assert.equal(removeNode(before, 'docs/x'), before, 'unloaded parent -> unchanged');
});

test('FILETREE: untouched sibling subtrees keep their identity (React can skip)', async () => {
  const { insertNode, makeNode } = await kit();
  const before = sampleTree();
  const docsBefore = find(before, 'docs');
  const after = insertNode(before, makeNode('src/b.ts', false));
  assert.notEqual(after, before, 'the root object changed');
  assert.equal(find(after, 'docs'), docsBefore, 'the untouched docs subtree keeps its reference');
});
