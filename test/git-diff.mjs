/* ============================================================
 * Loom — git-diff "Changes" layer suite (node --test)
 * ------------------------------------------------------------
 * Exercises src/main/git-diff.ts over a REAL temp git repo fixture (the
 * execFile/IO half stays node-test-unbound, same boundary as git.ts) plus
 * the PURE parsers (parseNameStatusZ/parseUnifiedDiff) directly. Also
 * pins the Law-3 path-confinement gate the READ_FILE_DIFF handler applies
 * (sandbox.resolveInRoot rejects '../../etc/passwd') over a real temp dir.
 *
 * The fixture isolates from unusual host git config (gpgsign, hooks,
 * init.defaultBranch) per the dev-host flake learnings: `init -q -b main`,
 * user.email/user.name set, commit.gpgsign=false, --no-verify, and a
 * beforeAll git-presence assert that FAILS LOUD if git is absent.
 * DOM-free via the testkit bundle.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

/** Per-invocation `-c` isolation flags PREPENDED to every git() call so a hostile
 *  ~/.gitconfig (global core.hooksPath, init.templateDir, required commit/tag
 *  signing) can't perturb the fixture — belt-and-braces over the repo-level
 *  config set in makeGitRepo + --no-verify on commit. */
const ISOLATION = [
  '-c',
  'core.hooksPath=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
];

/** Run git in `cwd` with a fixed argv (NO shell). The `-c` isolation flags
 *  (ISOLATION) are prepended so the fixture never depends on the host's global
 *  git config — the comment now matches the code (sdet/F5). */
function git(cwd, args) {
  return execFileSync('git', [...ISOLATION, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Detect git presence up front so its absence FAILS LOUD (not as an opaque
 *  spawn error inside a test). */
let GIT_AVAILABLE = false;
test.before(() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    GIT_AVAILABLE = true;
  } catch {
    GIT_AVAILABLE = false;
  }
  assert.ok(
    GIT_AVAILABLE,
    'git is not on PATH — the git-diff suite requires a real git binary (FAIL LOUD, never silently skip).',
  );
});

/** Build a throwaway temp git repo on `main` with a base commit, then a feature
 *  branch carrying the requested mutations. Returns the repo dir. The caller
 *  rmSync's it in a finally. */
function makeGitRepo(seed) {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-diff-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'loom-test@example.com']);
  git(dir, ['config', 'user.name', 'Loom Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  seed(dir);
  return dir;
}

/** Write a file (creating parent dirs is unnecessary for the flat fixtures). */
function w(dir, rel, content) {
  writeFileSync(path.join(dir, rel), content);
}

/** Commit everything with hooks + signing disabled. */
function commitAll(dir, msg) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', msg]);
}

/* ------------------------------------------------------------------ *
 * getChanges over a real repo — added/modified listing                *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getChanges: lists exactly the CREATED + MODIFIED files; untouched is absent', async () => {
  const { getChanges } = await kit();
  const dir = makeGitRepo((d) => {
    w(d, 'keep.txt', 'unchanged\n');
    w(d, 'edit.txt', 'before\n');
    commitAll(d, 'base');
    // Feature branch with one MODIFIED + one CREATED file; keep.txt untouched.
    git(d, ['checkout', '-q', '-b', 'feature']);
    w(d, 'edit.txt', 'after\n');
    w(d, 'new.txt', 'fresh\n');
    commitAll(d, 'feature work');
  });
  try {
    const cs = await getChanges(dir);
    assert.equal(cs.available, true);
    assert.equal(cs.base, 'main');
    assert.equal(cs.branch, 'feature');
    const byPath = new Map(cs.files.map((f) => [f.path, f]));
    assert.ok(byPath.has('edit.txt'), 'modified file listed');
    assert.equal(byPath.get('edit.txt').changeKind, 'modified');
    assert.ok(byPath.has('new.txt'), 'created file listed');
    assert.equal(byPath.get('new.txt').changeKind, 'added');
    assert.ok(!byPath.has('keep.txt'), 'an untouched file is ABSENT');
    assert.equal(cs.files.length, 2, 'exactly the two changed files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Rename → a single new-path row with oldPath, no separate old row    *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getChanges: a rename appears ONCE as the new path (changeKind renamed, oldPath set)', async () => {
  const { getChanges } = await kit();
  const dir = makeGitRepo((d) => {
    w(d, 'old-name.txt', 'line one\nline two\nline three\nline four\n');
    commitAll(d, 'base');
    git(d, ['checkout', '-q', '-b', 'feature']);
    git(d, ['mv', 'old-name.txt', 'new-name.txt']);
    // Edit it too so -M classifies it as a rename WITH content change.
    w(d, 'new-name.txt', 'line one\nline two CHANGED\nline three\nline four\n');
    commitAll(d, 'rename + edit');
  });
  try {
    const cs = await getChanges(dir);
    assert.equal(cs.available, true);
    const renamed = cs.files.filter((f) => f.changeKind === 'renamed');
    assert.equal(renamed.length, 1, 'exactly one renamed row');
    assert.equal(renamed[0].path, 'new-name.txt', 'row keyed on the NEW path');
    assert.equal(renamed[0].oldPath, 'old-name.txt', 'oldPath carries the source');
    assert.ok(
      !cs.files.some((f) => f.path === 'old-name.txt'),
      'the OLD path is NOT a separate row',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * getFileDiff on a RENAMED-and-edited file → a real before→after delta *
 * (NOT an all-additions new file) — the oldPath-in-pathspec fix (SEC-1) *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getFileDiff: a renamed-and-edited file diffs old→new (NOT all-additions)', async () => {
  const { getChanges, getFileDiff, resolveBaseSha } = await kit();
  const dir = makeGitRepo((d) => {
    w(d, 'old-name.txt', 'line one\nline two\nline three\nline four\n');
    commitAll(d, 'base');
    git(d, ['checkout', '-q', '-b', 'feature']);
    git(d, ['mv', 'old-name.txt', 'new-name.txt']);
    // One edited line so -M classifies it as a rename WITH a content change.
    w(d, 'new-name.txt', 'line one\nline two CHANGED\nline three\nline four\n');
    commitAll(d, 'rename + edit');
  });
  try {
    const resolved = await resolveBaseSha(dir);
    assert.ok(resolved !== null, 'base resolves');
    const cs = await getChanges(dir);
    const row = cs.files.find((f) => f.path === 'new-name.txt');
    assert.ok(row, 'the renamed file is listed on the new path');
    assert.equal(row.changeKind, 'renamed');
    assert.equal(row.oldPath, 'old-name.txt');

    const diff = await getFileDiff(
      dir, 'new-name.txt', resolved.mergeBase, row.changeKind, row.oldPath, row.binary,
    );
    assert.equal(diff.binary, false);
    assert.equal(diff.truncated, false);
    assert.ok(Array.isArray(diff.hunks) && diff.hunks.length >= 1, 'at least one hunk');
    const lines = diff.hunks.flatMap((h) => h.lines);

    // The BUG (oldPath omitted from the pathspec) renders the file as an all-new
    // file: EVERY line an addition against /dev/null, no del, no context, every
    // oldLine null. The FIX must show the real before→after delta instead.
    assert.ok(
      lines.some((l) => l.origin === 'del'),
      'a renamed-and-edited file shows at least one REMOVED line (not all-additions)',
    );
    assert.ok(
      lines.some((l) => l.origin === 'context'),
      'a real rename diff carries surrounding CONTEXT lines (not all-additions)',
    );
    assert.ok(
      lines.some((l) => l.oldLine !== null),
      'at least one line carries an OLD-side line number (the before side exists)',
    );
    assert.ok(
      !lines.every((l) => l.origin === 'add'),
      'NOT every line is an addition — the regression would make them all adds',
    );
    // The specific edited line shows as a del/add pair (the actual content change).
    assert.ok(
      lines.some((l) => l.origin === 'del' && l.text === 'line two'),
      'the old text of the edited line is a deletion',
    );
    assert.ok(
      lines.some((l) => l.origin === 'add' && l.text === 'line two CHANGED'),
      'the new text of the edited line is an addition',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Binary file → binary:true (numstat '-\t-')                          *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getChanges: a binary file (NUL bytes) is flagged binary:true', async () => {
  const { getChanges } = await kit();
  const dir = makeGitRepo((d) => {
    w(d, 'text.txt', 'hello\n');
    commitAll(d, 'base');
    git(d, ['checkout', '-q', '-b', 'feature']);
    // A blob with NUL bytes — git classifies it binary in numstat as '-\t-'.
    writeFileSync(path.join(d, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 7, 8]));
    commitAll(d, 'add binary');
  });
  try {
    const cs = await getChanges(dir);
    const bin = cs.files.find((f) => f.path === 'blob.bin');
    assert.ok(bin, 'the binary file is listed');
    assert.equal(bin.binary, true, 'binary flag set from the numstat pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Non-git directory → available:false, files:[] (no throw)            *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getChanges: a non-git directory → available:false, files:[] (no throw)', async () => {
  const { getChanges } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-diff-nogit-'));
  w(dir, 'plain.txt', 'not a repo\n');
  try {
    const cs = await getChanges(dir);
    assert.equal(cs.available, false);
    assert.deepEqual(cs.files, []);
    assert.equal(cs.base, '');
    assert.equal(cs.branch, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Branch even with main (base==HEAD) → available:true, files:[]       *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getChanges: a branch EVEN with main (base==HEAD) → available:true, files:[]', async () => {
  const { getChanges } = await kit();
  const dir = makeGitRepo((d) => {
    w(d, 'a.txt', 'one\n');
    commitAll(d, 'base');
    // Branch off but make NO commits — even with main, three-dot is empty.
    git(d, ['checkout', '-q', '-b', 'feature']);
  });
  try {
    const cs = await getChanges(dir);
    assert.equal(cs.available, true, 'a git repo IS available');
    assert.deepEqual(cs.files, [], 'an even branch yields an EMPTY list, not an error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * getFileDiff over a real repo — a modified file's hunks               *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getFileDiff: a modified file yields parsed add/del hunks; a created file is all-additions', async () => {
  const { getChanges, getFileDiff, resolveBaseSha } = await kit();
  const dir = makeGitRepo((d) => {
    w(d, 'edit.txt', 'alpha\nbeta\ngamma\n');
    commitAll(d, 'base');
    git(d, ['checkout', '-q', '-b', 'feature']);
    w(d, 'edit.txt', 'alpha\nBETA\ngamma\n');
    w(d, 'new.txt', 'first\nsecond\n');
    commitAll(d, 'edits');
  });
  try {
    const resolved = await resolveBaseSha(dir);
    assert.ok(resolved !== null, 'base resolves');
    const cs = await getChanges(dir);
    const editRow = cs.files.find((f) => f.path === 'edit.txt');
    const editDiff = await getFileDiff(
      dir, 'edit.txt', resolved.mergeBase, editRow.changeKind, editRow.oldPath, editRow.binary,
    );
    assert.equal(editDiff.binary, false);
    assert.equal(editDiff.truncated, false);
    assert.ok(Array.isArray(editDiff.hunks) && editDiff.hunks.length >= 1, 'at least one hunk');
    const allLines = editDiff.hunks.flatMap((h) => h.lines);
    assert.ok(allLines.some((l) => l.origin === 'del' && l.text === 'beta'), 'old line shown as a deletion');
    assert.ok(allLines.some((l) => l.origin === 'add' && l.text === 'BETA'), 'new line shown as an addition');

    const newRow = cs.files.find((f) => f.path === 'new.txt');
    const newDiff = await getFileDiff(
      dir, 'new.txt', resolved.mergeBase, newRow.changeKind, newRow.oldPath, newRow.binary,
    );
    const newLines = newDiff.hunks.flatMap((h) => h.lines);
    assert.ok(newLines.length > 0, 'created file has lines');
    assert.ok(newLines.every((l) => l.origin === 'add'), 'a created file is ALL additions');
    assert.ok(newLines.every((l) => l.oldLine === null), 'no old-side line numbers on a created file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * getFileDiff truncation: a blob > MAX_DIFF_BYTES on the BASE side     *
 * short-circuits to {truncated:true, hunks:null}. Pins the "base OR    *
 * head" contract the `basePath = oldPath ?? relPath` size pre-check    *
 * honors — a future refactor that drops the base-side check would      *
 * flip this RED (the HEAD blob here is tiny).                          *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getFileDiff: a file oversize at the BASE (near-total deletion) truncates', async () => {
  const { getChanges, getFileDiff, resolveBaseSha } = await kit();
  // 3 MiB > MAX_DIFF_BYTES (2 MiB); plain 'X' bytes (no NUL) stay TEXT so the
  // numstat pass classifies it non-binary and the cat-file size pre-check — not
  // the binary short-circuit — is what must fire. Base carries the big blob; the
  // branch shrinks it to one line, so HEAD:big is tiny but base:big is 3 MiB.
  const big = 'X'.repeat(3 * 1024 * 1024);
  const dir = makeGitRepo((d) => {
    w(d, 'big.txt', big);
    commitAll(d, 'base');
    git(d, ['checkout', '-q', '-b', 'feature']);
    w(d, 'big.txt', 'tiny\n');
    commitAll(d, 'shrink');
  });
  try {
    const resolved = await resolveBaseSha(dir);
    assert.ok(resolved !== null, 'base resolves');
    const cs = await getChanges(dir);
    const row = cs.files.find((f) => f.path === 'big.txt');
    assert.ok(row, 'the oversize file is listed');
    assert.equal(row.binary, false, 'plain X bytes are TEXT, not binary');
    const diff = await getFileDiff(
      dir, 'big.txt', resolved.mergeBase, row.changeKind, row.oldPath, row.binary,
    );
    // The BASE-side blob (3 MiB) exceeds the cap even though HEAD is tiny.
    assert.equal(diff.truncated, true, 'oversize base blob ⇒ truncated');
    assert.equal(diff.hunks, null, 'a truncated diff carries null hunks');
    assert.equal(diff.binary, false, 'not classified binary');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * getFileDiff on a BINARY file → {binary:true, hunks:null} (drive the  *
 * REAL getFileDiff short-circuit, not just the getChanges flag)        *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getFileDiff: a binary file short-circuits to {binary:true, hunks:null}', async () => {
  const { getChanges, getFileDiff, resolveBaseSha } = await kit();
  const dir = makeGitRepo((d) => {
    w(d, 'text.txt', 'hello\n');
    commitAll(d, 'base');
    git(d, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(path.join(d, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 7, 8]));
    commitAll(d, 'add binary');
  });
  try {
    const resolved = await resolveBaseSha(dir);
    const cs = await getChanges(dir);
    const row = cs.files.find((f) => f.path === 'blob.bin');
    assert.ok(row && row.binary === true, 'the file is classified binary by the listing');
    const diff = await getFileDiff(
      dir, 'blob.bin', resolved.mergeBase, row.changeKind, row.oldPath, row.binary,
    );
    assert.equal(diff.binary, true, 'getFileDiff reports binary:true');
    assert.equal(diff.hunks, null, 'a binary file yields null hunks (no decoded bytes — Law 1)');
    assert.equal(diff.truncated, false, 'binary is not the same as truncated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * getFileDiff on a NO-trailing-newline file → last line text correct +  *
 * the '\ No newline at end of file' annotation dropped (drive real git) *
 * ------------------------------------------------------------------ */
test('GIT-DIFF getFileDiff: a no-trailing-newline file keeps last-line text + drops the "\\ No newline" annotation', async () => {
  const { getChanges, getFileDiff, resolveBaseSha } = await kit();
  const dir = makeGitRepo((d) => {
    // Base HAS a trailing newline; the feature edit REMOVES it (last line has no
    // \n) so git emits the `\ No newline at end of file` annotation in the diff.
    w(d, 'tail.txt', 'one\ntwo\n');
    commitAll(d, 'base');
    git(d, ['checkout', '-q', '-b', 'feature']);
    w(d, 'tail.txt', 'one\ntwoX'); // edited last line, NO trailing newline
    commitAll(d, 'no trailing newline');
  });
  try {
    const resolved = await resolveBaseSha(dir);
    const cs = await getChanges(dir);
    const row = cs.files.find((f) => f.path === 'tail.txt');
    const diff = await getFileDiff(
      dir, 'tail.txt', resolved.mergeBase, row.changeKind, row.oldPath, row.binary,
    );
    assert.equal(diff.binary, false);
    const lines = diff.hunks.flatMap((h) => h.lines);
    // The added last line's text is the literal content, WITHOUT any '\ No newline'
    // annotation row.
    assert.ok(
      lines.some((l) => l.origin === 'add' && l.text === 'twoX'),
      'the new last line text is exactly "twoX" (no stray marker, no annotation)',
    );
    assert.ok(
      lines.some((l) => l.origin === 'del' && l.text === 'two'),
      'the old last line "two" is shown as a deletion',
    );
    assert.ok(
      !lines.some((l) => l.text.includes('No newline')),
      'the "\\ No newline at end of file" annotation is NOT a content line',
    );
    // No line carries the '\' marker as text.
    assert.ok(
      !lines.some((l) => l.text.startsWith('\\')),
      'no diff line is the raw "\\ No newline" annotation',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * parseNameStatusZ (PURE) — A/M/R/C token shapes + skip-source idiom   *
 * ------------------------------------------------------------------ */
test('GIT-DIFF parseNameStatusZ (pure): A/M/R/C shapes; rename carries oldPath; D/T skipped', async () => {
  const { parseNameStatusZ } = await kit();
  // Mirror `git diff --name-status -M -z` -z framing: every field is its own
  // NUL-terminated token; R/C emit `Rxxx\0old\0new`.
  const stdout =
    'A\0added.txt\0' +
    'M\0mod.txt\0' +
    'R097\0src/old.ts\0src/new.ts\0' +
    'C100\0base.ts\0copy.ts\0' +
    'D\0gone.txt\0' +
    'T\0typechange.txt\0';
  const rows = parseNameStatusZ(stdout);
  const byPath = new Map(rows.map((r) => [r.path, r]));
  assert.equal(byPath.get('added.txt').changeKind, 'added');
  assert.equal(byPath.get('mod.txt').changeKind, 'modified');
  assert.equal(byPath.get('src/new.ts').changeKind, 'renamed');
  assert.equal(byPath.get('src/new.ts').oldPath, 'src/old.ts');
  assert.equal(byPath.get('copy.ts').changeKind, 'copied');
  assert.equal(byPath.get('copy.ts').oldPath, 'base.ts');
  assert.ok(!byPath.has('gone.txt'), 'a DELETE is skipped in v1');
  assert.ok(!byPath.has('typechange.txt'), 'a TYPE-change is skipped in v1');
  assert.ok(!byPath.has('src/old.ts'), 'the rename SOURCE is not a separate row');
  // No path escapes the root / contains '..' (these are repo-relative).
  for (const r of rows) {
    assert.ok(!r.path.includes('..'), 'no path contains ".."');
    assert.ok(!r.path.startsWith('/'), 'no path is absolute');
  }
});

/* ------------------------------------------------------------------ *
 * parseUnifiedDiff (PURE) — @@ counts, line classification, edge cases *
 * ------------------------------------------------------------------ */
test('GIT-DIFF parseUnifiedDiff (pure): @@ counts + +/-/context classification with running line numbers', async () => {
  const { parseUnifiedDiff } = await kit();
  const patch = [
    'diff --git a/f.txt b/f.txt',
    'index 111..222 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,3 +1,3 @@ functionHeader()',
    ' alpha',
    '-beta',
    '+BETA',
    ' gamma',
    '',
  ].join('\n');
  const hunks = parseUnifiedDiff(patch);
  assert.equal(hunks.length, 1);
  const h = hunks[0];
  assert.equal(h.oldStart, 1);
  assert.equal(h.oldLines, 3);
  assert.equal(h.newStart, 1);
  assert.equal(h.newLines, 3);
  assert.equal(h.header, 'functionHeader()', 'the @@ function-context header is captured');
  // Running counters: context advances both sides; del advances old only; add new only.
  const [ctx0, del1, add1, ctx2] = h.lines;
  assert.deepEqual(
    { origin: ctx0.origin, oldLine: ctx0.oldLine, newLine: ctx0.newLine, text: ctx0.text },
    { origin: 'context', oldLine: 1, newLine: 1, text: 'alpha' },
  );
  assert.deepEqual(
    { origin: del1.origin, oldLine: del1.oldLine, newLine: del1.newLine, text: del1.text },
    { origin: 'del', oldLine: 2, newLine: null, text: 'beta' },
  );
  assert.deepEqual(
    { origin: add1.origin, oldLine: add1.oldLine, newLine: add1.newLine, text: add1.text },
    { origin: 'add', oldLine: null, newLine: 2, text: 'BETA' },
  );
  assert.deepEqual(
    { origin: ctx2.origin, oldLine: ctx2.oldLine, newLine: ctx2.newLine, text: ctx2.text },
    { origin: 'context', oldLine: 3, newLine: 3, text: 'gamma' },
  );
});

test('GIT-DIFF parseUnifiedDiff (pure): identical input → []; a Binary files differ stub → []', async () => {
  const { parseUnifiedDiff } = await kit();
  assert.deepEqual(parseUnifiedDiff(''), [], 'no hunks for an empty/identical diff');
  const binStub = [
    'diff --git a/x.bin b/x.bin',
    'index 111..222 100644',
    'Binary files a/x.bin and b/x.bin differ',
    '',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiff(binStub), [], 'a Binary files differ stub yields no hunks');
});

test('GIT-DIFF parseUnifiedDiff (pure): a "\\ No newline at end of file" annotation is not a content line', async () => {
  const { parseUnifiedDiff } = await kit();
  const patch = [
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const hunks = parseUnifiedDiff(patch);
  assert.equal(hunks.length, 1);
  const lines = hunks[0].lines;
  assert.equal(lines.length, 2, 'the \\ annotation is skipped — only the - and + lines remain');
  assert.equal(lines[0].origin, 'del');
  assert.equal(lines[1].origin, 'add');
});

test('GIT-DIFF parseUnifiedDiff (pure): a CONCATENATED multi-file patch does NOT bleed file-2 headers into file-1 (sdet/F3)', async () => {
  const { parseUnifiedDiff } = await kit();
  // Two file blocks back-to-back. WITHOUT the between-files boundary reset,
  // file-2's `--- a/f2.txt` / `+++ b/f2.txt` headers get misclassified as a del
  // ('-- a/f2.txt') and an add ('++ b/f2.txt') of file-1's last hunk.
  const patch = [
    'diff --git a/f1.txt b/f1.txt',
    'index 111..222 100644',
    '--- a/f1.txt',
    '+++ b/f1.txt',
    '@@ -1,2 +1,2 @@',
    ' keep1',
    '-old1',
    '+new1',
    'diff --git a/f2.txt b/f2.txt',
    'index 333..444 100644',
    '--- a/f2.txt',
    '+++ b/f2.txt',
    '@@ -1,2 +1,2 @@',
    ' keep2',
    '-old2',
    '+new2',
    '',
  ].join('\n');
  const hunks = parseUnifiedDiff(patch);
  assert.equal(hunks.length, 2, 'exactly two hunks (one per file)');
  // File-1's hunk carries ONLY its own three rows — no phantom '-- a/f2.txt' del
  // or '++ b/f2.txt' add leaked from file-2's header.
  const h1 = hunks[0].lines;
  assert.deepEqual(
    h1.map((l) => `${l.origin}:${l.text}`),
    ['context:keep1', 'del:old1', 'add:new1'],
    'file-1 hunk has exactly its own context/del/add — no leaked file-2 headers',
  );
  assert.ok(
    !h1.some((l) => l.text.includes('f2.txt')),
    'no file-2 header text bled into file-1',
  );
  // File-2's hunk is clean too.
  const h2 = hunks[1].lines;
  assert.deepEqual(
    h2.map((l) => `${l.origin}:${l.text}`),
    ['context:keep2', 'del:old2', 'add:new2'],
    'file-2 hunk parses correctly after the boundary reset',
  );
});

/* ------------------------------------------------------------------ *
 * PATH-CONFINEMENT (Law 3) — the resolveInRoot gate the handler applies *
 * ------------------------------------------------------------------ */
test('GIT-DIFF path-confinement: resolveInRoot rejects "../../etc/passwd" (the READ_FILE_DIFF gate)', async () => {
  const { createSandbox } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-diff-confine-'));
  try {
    const sandbox = createSandbox(dir);
    // The exact gate the READ_FILE_DIFF handler applies before any git read: a
    // crafted escaping path MUST throw (so git is never run on it).
    assert.throws(
      () => sandbox.resolveInRoot('../../etc/passwd'),
      /escapes sandbox root/,
      'an escaping path is rejected by the Law-3 gate',
    );
    // A NUL-byte poison is rejected too.
    assert.throws(
      () => sandbox.resolveInRoot('a\0b'),
      /NUL byte/,
      'a NUL-byte path is rejected',
    );
    // A benign in-root path resolves cleanly (the gate does not over-reject).
    assert.doesNotThrow(() => sandbox.resolveInRoot('sub/file.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * resolveFileDiffRequest (PURE handler decision) — the SAME code the   *
 * READ_FILE_DIFF handler runs: find row → confine path+oldPath →       *
 * catch→empty → else readDiff. Driven with a REAL sandbox confine gate  *
 * and a readDiff SPY so we can assert git is NEVER read on a rejection. *
 * ------------------------------------------------------------------ */
test('GIT-DIFF resolveFileDiffRequest: an escaping relPath is rejected (empty FileDiff, readDiff NEVER called)', async () => {
  const { resolveFileDiffRequest, createSandbox } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-diff-req-'));
  try {
    const sandbox = createSandbox(dir);
    let readCalls = 0;
    // The escaping path IS (defensively) in the authoritative listing so the
    // find-by-path short-circuit does NOT mask the confine gate — this proves the
    // resolveInRoot USE rejects it, git is never read.
    const changeSet = {
      available: true,
      base: 'main',
      branch: 'feature',
      files: [{ path: '../../etc/passwd', changeKind: 'modified', oldPath: null, binary: false }],
    };
    const out = await resolveFileDiffRequest({
      changeSet,
      relPath: '../../etc/passwd',
      mergeBase: 'deadbeef',
      confine: (p) => sandbox.resolveInRoot(p),
      readDiff: () => {
        readCalls += 1;
        return Promise.resolve({ path: 'x', oldPath: null, changeKind: 'modified', binary: false, truncated: false, hunks: [] });
      },
    });
    assert.equal(readCalls, 0, 'readDiff (git) was NEVER invoked on an escaping path');
    assert.deepEqual(out.hunks, [], 'an escaping path yields an empty (no-diff) FileDiff');
    assert.equal(out.changeKind, 'modified', 'the empty diff carries main\'s changeKind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GIT-DIFF resolveFileDiffRequest: a rename whose oldPath ESCAPES is rejected (readDiff NEVER called)', async () => {
  const { resolveFileDiffRequest, createSandbox } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-diff-req-rn-'));
  try {
    const sandbox = createSandbox(dir);
    let readCalls = 0;
    // The NEW path is in-root (passes confine), but the rename SOURCE escapes —
    // the oldPath re-confinement branch MUST reject it before any git read.
    const changeSet = {
      available: true,
      base: 'main',
      branch: 'feature',
      files: [{ path: 'in-root.txt', changeKind: 'renamed', oldPath: '../../etc/passwd', binary: false }],
    };
    const out = await resolveFileDiffRequest({
      changeSet,
      relPath: 'in-root.txt',
      mergeBase: 'deadbeef',
      confine: (p) => sandbox.resolveInRoot(p),
      readDiff: () => {
        readCalls += 1;
        return Promise.resolve({ path: 'x', oldPath: null, changeKind: 'renamed', binary: false, truncated: false, hunks: [] });
      },
    });
    assert.equal(readCalls, 0, 'readDiff (git) was NEVER invoked when a rename oldPath escapes');
    assert.deepEqual(out.hunks, [], 'a rename with an escaping oldPath yields an empty FileDiff');
    assert.equal(out.oldPath, '../../etc/passwd', 'the empty diff carries main\'s oldPath');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GIT-DIFF resolveFileDiffRequest: a relPath ABSENT from the listing is rejected (readDiff NEVER called)', async () => {
  const { resolveFileDiffRequest, createSandbox } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-diff-req-abs-'));
  try {
    const sandbox = createSandbox(dir);
    let readCalls = 0;
    const changeSet = {
      available: true, base: 'main', branch: 'feature',
      files: [{ path: 'listed.txt', changeKind: 'modified', oldPath: null, binary: false }],
    };
    const out = await resolveFileDiffRequest({
      changeSet,
      relPath: 'not-listed.txt',
      mergeBase: 'deadbeef',
      confine: (p) => sandbox.resolveInRoot(p),
      readDiff: () => { readCalls += 1; return Promise.resolve(null); },
    });
    assert.equal(readCalls, 0, 'an unlisted path never reaches git');
    assert.deepEqual(out.hunks, [], 'an unlisted path yields an empty FileDiff');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GIT-DIFF resolveFileDiffRequest: a normal in-root path is confined then readDiff is called with main\'s row', async () => {
  const { resolveFileDiffRequest, createSandbox } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-diff-req-ok-'));
  try {
    const sandbox = createSandbox(dir);
    const calls = [];
    const sentinel = { path: 'ok.txt', oldPath: null, changeKind: 'modified', binary: false, truncated: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }] };
    const changeSet = {
      available: true, base: 'main', branch: 'feature',
      files: [{ path: 'ok.txt', changeKind: 'modified', oldPath: null, binary: false }],
    };
    const out = await resolveFileDiffRequest({
      changeSet,
      relPath: 'ok.txt',
      mergeBase: 'cafef00d',
      confine: (p) => sandbox.resolveInRoot(p),
      readDiff: (rel, mb, kind, oldPath, binary) => {
        calls.push({ rel, mb, kind, oldPath, binary });
        return Promise.resolve(sentinel);
      },
    });
    assert.equal(calls.length, 1, 'readDiff is invoked exactly once for a valid request');
    assert.deepEqual(calls[0], { rel: 'ok.txt', mb: 'cafef00d', kind: 'modified', oldPath: null, binary: false },
      'readDiff gets main\'s re-derived row + the reused mergeBase (not the renderer\'s)');
    assert.equal(out, sentinel, 'the diff readDiff produced is returned verbatim');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GIT-DIFF resolveFileDiffRequest: an unavailable changeSet → empty FileDiff (readDiff NEVER called)', async () => {
  const { resolveFileDiffRequest } = await kit();
  let readCalls = 0;
  const out = await resolveFileDiffRequest({
    changeSet: { available: false, base: '', branch: null, files: [] },
    relPath: 'whatever.txt',
    mergeBase: null,
    confine: () => { throw new Error('confine should not even be reached'); },
    readDiff: () => { readCalls += 1; return Promise.resolve(null); },
  });
  assert.equal(readCalls, 0, 'an unavailable repo never reaches git');
  assert.deepEqual(out.hunks, [], 'an unavailable changeSet yields an empty FileDiff');
});

test('GIT-DIFF resolveFileDiffRequest: a null mergeBase (base unresolved) → empty FileDiff (readDiff NEVER called)', async () => {
  const { resolveFileDiffRequest, createSandbox } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-diff-req-nb-'));
  try {
    const sandbox = createSandbox(dir);
    let readCalls = 0;
    const changeSet = {
      available: true, base: 'main', branch: 'feature',
      files: [{ path: 'ok.txt', changeKind: 'modified', oldPath: null, binary: false }],
    };
    const out = await resolveFileDiffRequest({
      changeSet,
      relPath: 'ok.txt',
      mergeBase: null, // base could not be resolved
      confine: (p) => sandbox.resolveInRoot(p),
      readDiff: () => { readCalls += 1; return Promise.resolve(null); },
    });
    assert.equal(readCalls, 0, 'a null mergeBase never reaches git');
    assert.deepEqual(out.hunks, [], 'a null mergeBase yields an empty FileDiff');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
