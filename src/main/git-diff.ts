/* ============================================================
 * Loom — git-diff "Changes" layer (Electron-FREE sibling to git.ts)
 * ------------------------------------------------------------
 * Lists every file changed on the current branch vs. the base
 * merge-base — the UNION of committed branch work AND uncommitted
 * working-tree changes (staged + unstaged + untracked, .gitignore
 * respected) — and produces a READ-ONLY before→after unified diff per
 * file for the renderer's "Changes" viewer. The tracked side is the
 * two-dot worktree diff `git diff <mergeBaseSha> --` (before =
 * merge-base, after = CURRENT working tree), which naturally dedupes a
 * file changed both in commits and in the worktree to ONE row; untracked
 * files come from `git ls-files --others --exclude-standard` and show as
 * created (empty before). On the base branch itself (mergeBase == HEAD)
 * uncommitted edits therefore still appear — the old three-dot
 * `<mergeBase>...HEAD` producer was permanently empty there.
 *
 * INTENDED behavior (not an oversight): an UNCOMMITTED `mv` shows as a
 * 'deleted' old path + an 'added' (untracked) new path, NOT as one
 * 'renamed' row — the new path has no index entry, so git's -M
 * similarity pairing cannot see it; only a committed (or staged) rename
 * pairs into 'renamed'. This matches `git status` porcelain semantics
 * for an unstaged move.
 *
 * LAW 1 (nothing executes): this module returns RAW git output as DATA
 * — file paths (ChangedFile.path/oldPath) and DiffHunk line text are
 * attacker-influenced bytes. They are NEVER interpreted here; the
 * renderer escapes every one of them through highlight.ts/escapeHtml
 * before any markup (exactly like CodeView). A binary blob is reported
 * as `binary:true` with null hunks — its bytes are never decoded.
 *
 * LAW 3 (root is a sandbox): the git subprocess is confined by
 * `cwd:root` (the caller resolves `root`; these functions take no
 * renderer-supplied directory). The genuine gap is that
 * `git show <sha>:<path>` / `git diff ... -- <path>` read git's OBJECT
 * STORE, which bypasses the fs sandbox — so the IPC handler MUST call
 * `sandbox.resolveInRoot(path)` (and oldPath for renames) BEFORE calling
 * getFileDiff. The base is pre-resolved to a 40-char SHA so NO ref name
 * ever flows into a content command, and every path is passed to git
 * ONLY as a positional arg AFTER a mandatory `--` separator
 * (execFile, NO shell, fixed argv — argument injection is impossible).
 *
 * Hygiene mirrors git.ts verbatim in structure: a `.git` access()
 * fast-path, execFile with NO shell + a fixed argv array + a 5s timeout
 * + a bounded maxBuffer, the ERR_CHILD_PROCESS_STDIO_MAXBUFFER
 * warn-and-degrade branch, and fail-soft-empty on ANY error (never
 * throws — a thrown rejection must never escape to the IPC layer).
 *
 * Electron-free (node:child_process + node:fs/promises + node:path +
 * shared types only) so it is unit-testable without a display.
 * ============================================================ */
import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_DIFF_BYTES,
  type ChangeKind,
  type ChangedFile,
  type ChangeSet,
  type DiffHunk,
  type DiffLine,
  type FileDiff,
} from '../shared/types.js';

/** Per-call git timeout (ms) — identical to git.ts. */
const GIT_TIMEOUT_MS = 5000;
/** maxBuffer for the metadata (name-status / numstat / rev) calls — the LIST
 *  carries no file CONTENT, so a modest buffer is ample. */
const META_MAX_BUFFER = 5 * 1024 * 1024;
/** maxBuffer for a single-file unified diff: the per-side MAX_DIFF_BYTES cap
 *  plus headroom for the +/-/space markers and the hunk headers. */
const DIFF_MAX_BUFFER = MAX_DIFF_BYTES + 256 * 1024;

/** A successful git invocation result (stdout) or a typed failure marker so the
 *  callers can branch on overflow vs. plain error without re-stringifying. */
type GitRun =
  | { ok: true; stdout: string }
  | { ok: false; overflow: boolean };

/** Run git with a FIXED argv array and NO shell, resolving to a GitRun rather
 *  than rejecting — so every caller stays fail-soft. `maxBuffer` defaults to the
 *  metadata size; pass DIFF_MAX_BUFFER for a content-bearing call. `allowExit1`
 *  treats a clean exit code 1 (NOT a kill/timeout, NOT an overflow) as success
 *  with whatever stdout was produced — `git diff --no-index` implies
 *  `--exit-code`, so "files differ" is exit 1 carrying the diff we want.
 *  Exported ONLY so the unit suite can pin the allowExit1 gate (exit 1 ok /
 *  exit >= 2 still fail-soft) directly; production callers live in this file. */
export function runGit(
  root: string,
  args: readonly string[],
  maxBuffer: number = META_MAX_BUFFER,
  allowExit1 = false,
): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args as string[],
      { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer },
      (err, stdout) => {
        if (err) {
          const code: unknown = (err as { code?: unknown }).code;
          const overflow = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          if (
            allowExit1 &&
            !overflow &&
            code === 1 &&
            err.signal == null &&
            err.killed !== true
          ) {
            // --no-index "files differ" — exit 1 IS the success path here.
            resolve({ ok: true, stdout });
            return;
          }
          resolve({ ok: false, overflow });
          return;
        }
        resolve({ ok: true, stdout });
      },
    );
  });
}

/** Normalize a git-emitted path to its root-relative POSIX form (mirrors
 *  parsePortcelain at git.ts:62): backslashes → '/', strip any leading '/'. The
 *  `-c core.quotepath=false` + `-z` flags already suppress git's octal quoting,
 *  so no unescaping is needed here. */
function posixify(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\//, '');
}

/** Map a git name-status letter to a ChangeKind. A/M/R-dest plus D (a file
 *  deleted on the branch or rm'd in the working tree shows as 'deleted');
 *  T (type-change) stays filtered, and 'copied' stays in the type for
 *  forward-compat. The status token may carry a similarity score (e.g. 'R097'),
 *  so we switch on the leading letter only. */
function changeKindFor(statusLetter: string): ChangeKind | null {
  switch (statusLetter) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      // Forward-compat only: the production listing uses `-M` WITHOUT `-C`, under
      // which git reports a copy as 'A' (added) — so 'copied' is never emitted by
      // the live path today. Kept so the ChangeKind contract stays complete for a
      // future `-C` producer (and exercised directly by the parseNameStatusZ unit
      // test, which hand-feeds a synthetic `C` token).
      return 'copied';
    default:
      return null; // T / U / unknown — not surfaced
  }
}

/**
 * Parse the NUL-terminated output of
 * `git diff --name-status -M -z <range> --` into ChangedFile rows. PURE — no
 * I/O. Each entry is a status token (A/M/D/T or Rxxx/Cxxx with a similarity
 * score) followed by ONE path, OR — for a rename/copy — TWO NUL-separated paths
 * (old then new). Mirrors parsePortcelain's skip-a-source-token idiom
 * (git.ts:58-60): for R/C we consume the NEXT token as the destination and
 * carry the first as `oldPath`. T is skipped; D surfaces as 'deleted'. The
 * `binary` flag is folded in later by getChanges from the numstat
 * pass — it is always false here.
 */
export function parseNameStatusZ(stdout: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  // -z mode: every field (status token AND each path) is its own NUL-terminated
  // entry. Split and walk with an explicit cursor so a rename can consume two
  // path tokens.
  const tokens = stdout.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const statusTok = tokens[i] ?? '';
    i += 1;
    if (statusTok.length === 0) continue; // trailing NUL / blank
    const letter = statusTok[0] ?? '';
    const kind = changeKindFor(letter);
    const isRenameOrCopy = letter === 'R' || letter === 'C';

    // Read the path(s) that follow this status token.
    if (isRenameOrCopy) {
      // `Rxxx\0<old>\0<new>` — old then new.
      const oldRaw = tokens[i] ?? '';
      i += 1;
      const newRaw = tokens[i] ?? '';
      i += 1;
      if (kind === null) continue;
      const path = posixify(newRaw);
      if (path.length === 0) continue;
      const oldPath = oldRaw.length > 0 ? posixify(oldRaw) : null;
      out.push({ path, changeKind: kind, oldPath, binary: false });
    } else {
      // `<status>\0<path>` — a single path follows.
      const raw = tokens[i] ?? '';
      i += 1;
      if (kind === null) continue; // T/U — consumed its path, then skipped
      const path = posixify(raw);
      if (path.length === 0) continue;
      out.push({ path, changeKind: kind, oldPath: null, binary: false });
    }
  }
  return out;
}

/** Parse `git diff --numstat -z <range> --` into the SET of binary paths. Git
 *  emits `<added>\t<deleted>\t<path>` per record (NUL-terminated in -z mode),
 *  with literal dashes (`-\t-`) for a binary blob. A rename in -z numstat emits
 *  `<a>\t<d>\t\0<old>\0<new>` (empty path field then old+new), so we resolve the
 *  effective NEW path the same way name-status does. PURE — no I/O. */
function parseNumstatBinaryPaths(stdout: string): Set<string> {
  const binary = new Set<string>();
  const tokens = stdout.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i] ?? '';
    i += 1;
    if (head.length === 0) continue;
    // head = "<added>\t<deleted>\t<path-or-empty>"
    const parts = head.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] ?? '';
    const deleted = parts[1] ?? '';
    const inlinePath = parts.slice(2).join('\t');
    const isBinary = added === '-' && deleted === '-';
    let newPath: string;
    if (inlinePath.length === 0) {
      // Rename/copy: the path field is empty; old + new follow as their own
      // NUL-separated tokens.
      i += 1; // skip the OLD path token
      const newRaw = tokens[i] ?? '';
      i += 1;
      newPath = posixify(newRaw);
    } else {
      newPath = posixify(inlinePath);
    }
    if (isBinary && newPath.length > 0) binary.add(newPath);
  }
  return binary;
}

/**
 * Resolve the base ref then its merge-base with HEAD, returning SHAs only so NO
 * ref name ever flows into a content command (Law 3 / ref-injection defense).
 * Order:
 *   (1) `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` → strip the
 *       leading 'origin/';
 *   (2) on failure, the first of ['main','master'] that
 *       `git rev-parse --verify --quiet refs/heads/<name>` resolves;
 * then `git merge-base <base> HEAD` → the merge-base SHA. Returns null on ANY
 * failure (no base, no HEAD/no commits, detached with no common ancestor).
 * NEVER throws.
 */
export async function resolveBaseSha(
  root: string,
): Promise<{ base: string; mergeBase: string } | null> {
  // (1) origin/HEAD → short name (e.g. "main").
  let base: string | null = null;
  const originHead = await runGit(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead.ok) {
    const short = originHead.stdout.trim();
    // Strip a leading 'origin/' so only the bare branch name remains.
    base = short.replace(/^origin\//, '') || null;
  }

  // (2) Fall back to the first existing of main/master.
  if (base === null) {
    for (const name of ['main', 'master']) {
      const ref = await runGit(root, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${name}`,
      ]);
      // rev-parse --verify --quiet exits 0 (with the SHA on stdout) when the ref
      // resolves; non-zero (treated as !ok) otherwise.
      if (ref.ok && ref.stdout.trim().length > 0) {
        base = name;
        break;
      }
    }
  }

  if (base === null) return null;

  // merge-base <base> HEAD → the fork-point SHA. Fails (unrelated/no HEAD) → null.
  const mb = await runGit(root, ['merge-base', base, 'HEAD']);
  if (!mb.ok) return null;
  const mergeBase = mb.stdout.trim();
  if (mergeBase.length === 0) return null;

  return { base, mergeBase };
}

/** A ChangeSet plus the merge-base SHA it was computed against. The SHA is the
 *  per-file-diff input (the diff's "before" side); it is NOT part of the
 *  IPC-serialized ChangeSet (the renderer never needs it), so the handler reads
 *  it from here to avoid resolving the base a SECOND time per file expand. Null
 *  when the repo is unavailable / has no base. */
export interface ChangesWithBase {
  changeSet: ChangeSet;
  mergeBase: string | null;
}

/**
 * List every file changed vs. the base merge-base — the UNION of committed
 * branch work AND uncommitted working-tree changes — AND return the resolved
 * merge-base SHA alongside it so a caller fetching per-file diffs does not have
 * to re-resolve the base. Tracked changes come from the two-dot worktree diff
 * `git diff <mergeBaseSha> --` (committed + staged + unstaged in ONE deduped
 * pass; after = working tree); untracked files come from
 * `git ls-files --others --exclude-standard` (.gitignore respected) and are
 * appended as 'added' rows. Fail-soft: a non-git dir / git-missing / no-base all
 * resolve to a benign ChangeSet (mergeBase:null) rather than throwing.
 * `available:true` with `files:[]` is the CORRECT default when the branch is
 * even with the base AND the working tree is clean — an empty list is not an
 * error.
 */
export async function listChangesWithBase(root: string): Promise<ChangesWithBase> {
  const empty: ChangeSet = { available: false, base: '', branch: null, files: [] };

  // Fast-path: skip entirely if .git is not present (mirrors getGitStatus).
  try {
    await access(join(root, '.git'));
  } catch {
    return { changeSet: empty, mergeBase: null };
  }

  const resolved = await resolveBaseSha(root);
  if (resolved === null) return { changeSet: empty, mergeBase: null }; // no base / no commits
  const { base, mergeBase } = resolved;

  // Current branch name (null when detached) — symbolic-ref of HEAD.
  let branch: string | null = null;
  const head = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.ok) {
    const name = head.stdout.trim();
    branch = name.length > 0 ? name : null;
  }

  // TWO-DOT worktree diff: a single commit arg compares <mergeBase> against the
  // CURRENT WORKING TREE, so committed branch work AND uncommitted (staged +
  // unstaged) edits land in ONE naturally-deduped listing whose "after" side is
  // what is on disk right now. (The old three-dot `<mergeBase>...HEAD` listed
  // committed work only — permanently empty when working directly on the base.)
  const range = mergeBase;

  // name-status list. `-c core.quotepath=false` + `-z` suppress git's octal path
  // quoting; `-M` enables rename detection; the trailing `--` ends options so a
  // pathological ref/path can never be read as a flag (defense in depth — the
  // range here is already a SHA).
  const nameStatus = await runGit(root, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-status',
    '-M',
    '-z',
    range,
    '--',
  ]);
  if (!nameStatus.ok) {
    if (nameStatus.overflow) {
      console.warn(
        '[git-diff] name-status output exceeded maxBuffer; changes suppressed',
      );
    }
    // Degrade (never crash): the repo IS available, we just can't list it. The
    // base IS resolved, so still hand back the mergeBase.
    return { changeSet: { available: true, base, branch, files: [] }, mergeBase };
  }

  // Parallel numstat pass for binary classification (`-\t-` ⇒ binary).
  const numstat = await runGit(root, ['diff', '--numstat', '-z', range, '--']);
  const binaryPaths =
    numstat.ok ? parseNumstatBinaryPaths(numstat.stdout) : new Set<string>();

  const files = parseNameStatusZ(nameStatus.stdout).map((f) => ({
    ...f,
    binary: binaryPaths.has(f.path),
  }));

  // UNTRACKED (never-added) files — invisible to `git diff`, so they ride in
  // from `ls-files --others --exclude-standard` (porcelain `??` semantics:
  // .gitignore respected, every file listed individually). Each shows as
  // created ('added', empty before). Deduped against the tracked rows — and
  // when an untracked path COLLIDES with a tracked 'deleted' row (the
  // `git rm --cached` shape: dropped from the index, still ON DISK), the row
  // flips to 'modified': the file exists in the worktree, so the honest
  // before→after is base→disk, never "deleted" with the disk content silently
  // dropped (getFileDiff renders that pair via its index-absent branch).
  // `binary` stays false on untracked rows: the per-file diff's `Binary files`
  // backstop reclassifies an untracked binary on expand (Law 1 holds — its
  // bytes are never decoded either way). Fail-soft: an ls-files error just
  // means no untracked rows.
  const untracked = await runGit(root, [
    '-c',
    'core.quotepath=false',
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (untracked.ok) {
    const rowIndex = new Map(files.map((f, i) => [f.path, i]));
    for (const tok of untracked.stdout.split('\0')) {
      const path = posixify(tok);
      if (path.length === 0) continue;
      const existing = rowIndex.get(path);
      if (existing !== undefined) {
        const row = files[existing];
        if (row !== undefined && row.changeKind === 'deleted') {
          // On disk (ls-files --others saw it) AND tracked-diff says D: the
          // rm --cached shape — surface as base→worktree modified.
          files[existing] = { ...row, changeKind: 'modified' };
        }
        continue;
      }
      rowIndex.set(path, files.length);
      files.push({ path, changeKind: 'added', oldPath: null, binary: false });
    }
  }

  return { changeSet: { available: true, base, branch, files }, mergeBase };
}

/**
 * List every file changed vs. the base merge-base — committed branch work UNION
 * uncommitted working-tree changes (staged + unstaged + untracked). Thin wrapper
 * over listChangesWithBase that drops the merge-base SHA — the GET_CHANGES
 * handler's shape (the renderer never needs the SHA). Fail-soft, never throws.
 */
export async function getChanges(root: string): Promise<ChangeSet> {
  return (await listChangesWithBase(root)).changeSet;
}

/** Lines that begin a NEW file block in a (possibly multi-file) unified diff —
 *  the `diff --git`/`index`/`---`/`+++`/mode/rename/similarity preamble. When the
 *  scanner is INSIDE a hunk and sees one of these, it must reset to the preamble
 *  state (current=null) so file-2's `--- a/f2` / `+++ b/f2` headers are NOT
 *  misclassified as a del/add of file-1's last hunk. The `--- ` / `+++ ` headers
 *  are distinguishable from a real body deletion/addition because git body lines
 *  are exactly one marker char then the text, whereas the file headers are the
 *  three-char run `---`/`+++` FOLLOWED BY A SPACE (and a real `-`/`+` body line of
 *  literal text `-- a/f2` keeps its leading marker, so this only fires on the
 *  genuine `---`/`+++` headers). */
function isBetweenFilesBoundary(line: string): boolean {
  return (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ') ||
    line.startsWith('dissimilarity ') ||
    line.startsWith('copy ') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode')
  );
}

/**
 * Parse a unified diff into DiffHunk[]. PURE — no I/O. Skips the
 * diff/index/---/+++ preamble BEFORE the first hunk, parses each
 * `@@ -oldStart,oldLines +newStart,newLines @@ [header]` hunk, classifies each
 * body line by its leading char (' '→context, '+'→add, '-'→del), strips the
 * marker into DiffLine.text, and tracks running old/new line counters (null on
 * the absent side). Returns [] for an identical file or a `Binary files ...
 * differ` stub. Robust to a CONCATENATED multi-file patch: a between-files
 * boundary line (`diff --git `/`index `/`--- `/`+++ `/rename/mode preamble) seen
 * while inside a hunk resets to the preamble state so file-2's headers do not
 * corrupt file-1's last hunk. (getFileDiff invokes git with a single pathspec, so
 * its output is single-file in practice — this hardening protects parseUnifiedDiff
 * as a re-exported general-purpose parser.) The scan is a char-class line walk
 * (no global backtracking regex) so there is no ReDoS surface even on
 * adversarial input.
 */
export function parseUnifiedDiff(stdout: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  // A trailing newline would yield a spurious empty final line; the per-line
  // marker classification below treats it harmlessly, but trimming keeps the
  // counters honest.
  const lines = stdout.split('\n');
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // Hunk header: @@ -oldStart[,oldLines] +newStart[,newLines] @@ [context]
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (m === null) {
        // Not a well-formed hunk header — ignore (defensive).
        current = null;
        continue;
      }
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      const headerCtx = (m[5] ?? '').replace(/^ /, '');
      current = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      if (headerCtx.length > 0) current.header = headerCtx;
      hunks.push(current);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }
    // A between-files boundary (the next file's `diff --git`/`---`/`+++`/mode
    // preamble) ends the current hunk: reset so file-2's headers are parsed as
    // preamble, never as a del/add of file-1. Must come BEFORE the body
    // classifier so `--- a/f2` / `+++ b/f2` never reach it.
    if (current !== null && isBetweenFilesBoundary(line)) {
      current = null;
      continue;
    }

    if (current === null) continue; // still in the preamble / between files

    // A genuinely EMPTY string is NOT a diff body line — a real context line is
    // a single space (' '), an addition '+...', a deletion '-...'. The only way
    // to see '' here is the trailing entry from splitting on a final '\n', so
    // skip it rather than mis-classifying it as an empty context line (which
    // would corrupt the running counters and add a phantom row).
    if (line.length === 0) continue;

    // Body lines. The FIRST char is the marker; the rest is the literal text.
    const marker = line[0];
    const text = line.slice(1);
    if (marker === '+') {
      const dl: DiffLine = { origin: 'add', oldLine: null, newLine: newNo, text };
      current.lines.push(dl);
      newNo += 1;
    } else if (marker === '-') {
      const dl: DiffLine = { origin: 'del', oldLine: oldNo, newLine: null, text };
      current.lines.push(dl);
      oldNo += 1;
    } else if (marker === ' ') {
      const dl: DiffLine = { origin: 'context', oldLine: oldNo, newLine: newNo, text };
      current.lines.push(dl);
      oldNo += 1;
      newNo += 1;
    } else if (marker === '\\') {
      // "\ No newline at end of file" — a git annotation, not a content line.
      // Skip it without advancing the counters.
      continue;
    }
    // Any other leading char (a stray blank trailing split entry) is ignored.
  }

  return hunks;
}

/**
 * Produce the before→after unified diff for ONE changed file, as parsed hunks.
 * The handler MUST have already re-confined `relPath` (and a rename's oldPath)
 * via sandbox.resolveInRoot (Law 3) — this function trusts its caller for
 * containment but still passes every path to git ONLY as a positional arg after
 * `--` (no interpolation, no shell). The "after" side is the CURRENT WORKING
 * TREE (two-dot `git diff <mergeBase> -- <path>`), so uncommitted edits render;
 * the "before" side is the merge-base blob (== committed-only old content when
 * on the base branch, where mergeBase == HEAD). An UNTRACKED file (changeKind
 * 'added' with no index entry) is diffed `--no-index` against /dev/null — a
 * pure all-additions created-file view. Pre-checks BOTH side sizes — the base
 * blob via `git cat-file -s <mergeBase>:<oldPath??path>` AND the worktree file
 * via fs stat — so a file multi-megabyte on EITHER side short-circuits to
 * `truncated:true` (null hunks) before the diff is ever buffered (the
 * MAX_DIFF_BYTES "either side" contract). A `binary` file (flagged by the LIST)
 * short-circuits to `binary:true` (null hunks) — its bytes are never decoded
 * (Law 1). For a renamed/copied file the OLD path is added to the pathspec so
 * git's -M pairing can render the real old→new delta (without it a rename
 * renders as an all-additions new file). NEVER throws; any git error degrades
 * to a no-diff FileDiff (binary:false, truncated:false, hunks:[]).
 */
export async function getFileDiff(
  root: string,
  relPath: string,
  mergeBase: string,
  changeKind: ChangeKind,
  oldPath: string | null,
  binary: boolean,
): Promise<FileDiff> {
  const result: FileDiff = {
    path: relPath,
    oldPath,
    changeKind,
    binary: false,
    truncated: false,
    hunks: [],
  };

  // Binary (per the LIST's numstat classification): no text diff, ever.
  if (binary) {
    return { ...result, binary: true, hunks: null };
  }

  // Pre-check BOTH side sizes so a giant file never floods the highlighter,
  // honoring the MAX_DIFF_BYTES "either side" contract (types.ts). The BEFORE
  // side is the base blob (`git cat-file -s <mergeBase>:<oldPath??path>` — a
  // single POSITIONAL arg, NO interpolation, NO shell; the base is a SHA so no
  // ref name reaches git). The AFTER side is now the WORKING TREE, so its size
  // is a plain fs stat of the (handler-confined, Law 3) on-disk file — a
  // worktree-deleted / missing file just fails the stat and is skipped. A
  // missing base blob (a freshly-created file) likewise !ok's and is skipped —
  // the other side or the diff maxBuffer backstop still bounds it.
  const basePath = oldPath ?? relPath;
  const [worktreeSize, baseSize] = await Promise.all([
    stat(join(root, relPath)).then(
      (s) => s.size,
      () => null,
    ),
    runGit(root, ['cat-file', '-s', `${mergeBase}:${basePath}`]),
  ]);
  if (worktreeSize !== null && worktreeSize > MAX_DIFF_BYTES) {
    return { ...result, truncated: true, hunks: null };
  }
  if (baseSize.ok) {
    const bytes = Number(baseSize.stdout.trim());
    if (Number.isFinite(bytes) && bytes > MAX_DIFF_BYTES) {
      return { ...result, truncated: true, hunks: null };
    }
  }

  // An INDEX-ABSENT file is (fully or partly) invisible to `git diff <commit>`,
  // so detect it up front (`ls-files -z -- <path>` prints nothing) for the two
  // kinds the listing can hand us:
  //   - 'added' (untracked): diff `--no-index` against /dev/null — the
  //     canonical empty-before → worktree-after created-file view;
  //   - 'modified' (the `git rm --cached`-then-kept-on-disk shape the listing
  //     flipped from D): the two-dot diff alone would show a bogus all-deletions
  //     "delete" while the file EXISTS on disk — so COMBINE the base-side
  //     deletion diff with a /dev/null→worktree `--no-index` addition diff into
  //     one full base→worktree rewrite (parseUnifiedDiff's between-files
  //     boundary reset parses the concatenation safely).
  // `--no-index` implies `--exit-code` (1 = files differ), so runGit's
  // allowExit1 treats that as the success it is. Every path is
  // handler-confined (Law 3) and rides as a positional arg after `--`. A
  // binary file emits only a `Binary files ... differ` line, caught by the
  // backstop below.
  if (changeKind === 'added' || changeKind === 'modified') {
    const indexEntry = await runGit(root, ['ls-files', '-z', '--', relPath]);
    const notInIndex = indexEntry.ok && indexEntry.stdout.length === 0;
    if (notInIndex) {
      const noIndexArgs = [
        '-c',
        'core.quotepath=false',
        'diff',
        '--unified=3',
        '--no-color',
        '--no-index',
        '--',
        '/dev/null',
        relPath,
      ];
      if (changeKind === 'added') {
        const noIndex = await runGit(root, noIndexArgs, DIFF_MAX_BUFFER, true);
        if (!noIndex.ok) {
          if (noIndex.overflow) {
            console.warn(
              `[git-diff] diff output for "${relPath}" exceeded maxBuffer; shown as too large`,
            );
            return { ...result, truncated: true, hunks: null };
          }
          return { ...result, hunks: [] };
        }
        if (/^Binary files /m.test(noIndex.stdout)) {
          return { ...result, binary: true, hunks: null };
        }
        return { ...result, hunks: parseUnifiedDiff(noIndex.stdout) };
      }
      // 'modified' + index-absent: base→worktree as deletion-of-base +
      // addition-of-disk-content. Both halves are bounded by DIFF_MAX_BUFFER
      // and the size pre-checks above.
      const [baseSide, worktreeSide] = await Promise.all([
        runGit(
          root,
          [
            '-c',
            'core.quotepath=false',
            'diff',
            '--unified=3',
            '--no-color',
            mergeBase,
            '--',
            relPath,
          ],
          DIFF_MAX_BUFFER,
        ),
        runGit(root, noIndexArgs, DIFF_MAX_BUFFER, true),
      ]);
      if (!baseSide.ok || !worktreeSide.ok) {
        const overflowed =
          (!baseSide.ok && baseSide.overflow) ||
          (!worktreeSide.ok && worktreeSide.overflow);
        if (overflowed) {
          console.warn(
            `[git-diff] diff output for "${relPath}" exceeded maxBuffer; shown as too large`,
          );
          return { ...result, truncated: true, hunks: null };
        }
        return { ...result, hunks: [] };
      }
      const combined = baseSide.stdout + worktreeSide.stdout;
      if (/^Binary files /m.test(combined)) {
        return { ...result, binary: true, hunks: null };
      }
      return { ...result, hunks: parseUnifiedDiff(combined) };
    }
  }

  // The unified diff for this one path — TWO-DOT vs the WORKING TREE (a single
  // commit arg), so the "after" side is what is on disk right now (uncommitted
  // edits included; a worktree deletion renders as all-deletions). `-M` keeps
  // rename detection, but git's similarity pairing only fires when BOTH the old
  // and new path are VISIBLE to the diff: restricting the pathspec to just the
  // new path makes git treat a renamed-and-edited file as a freshly-created
  // file (an all-additions diff against /dev/null), losing the real
  // before→after delta. So for a rename/copy we include the OLD path in the
  // pathspec too. The handler has ALREADY resolveInRoot-vetted both paths
  // (Law 3); both ride as POSITIONAL args AFTER `--` (no interpolation, no
  // shell). The SHA sits BEFORE `--`.
  const pathspec =
    oldPath !== null && oldPath !== relPath ? [oldPath, relPath] : [relPath];
  const diff = await runGit(
    root,
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--unified=3',
      '--no-color',
      '-M',
      mergeBase,
      '--',
      ...pathspec,
    ],
    DIFF_MAX_BUFFER,
  );
  if (!diff.ok) {
    if (diff.overflow) {
      console.warn(
        `[git-diff] diff output for "${relPath}" exceeded maxBuffer; shown as too large`,
      );
      return { ...result, truncated: true, hunks: null };
    }
    // A plain git error → treat as no-diff/unavailable (degrade, never throw).
    return { ...result, hunks: [] };
  }

  // Defensive: if the numstat binary classification was lost (e.g. that pass
  // overflowed while name-status succeeded) a real binary reaches here with
  // binary:false. git emits ONLY a `Binary files a/x and b/x differ` line for a
  // binary, so surface the inert binary card rather than an empty "No textual
  // changes" — the bytes are never decoded either way (Law 1 holds regardless).
  if (/^Binary files /m.test(diff.stdout)) {
    return { ...result, binary: true, hunks: null };
  }

  return { ...result, hunks: parseUnifiedDiff(diff.stdout) };
}

/** The arguments of the READ_FILE_DIFF decision: the authoritative changeSet
 *  (re-derived by main), the renderer-supplied relPath, an INJECTED `confine`
 *  gate (the Electron-bound sandbox.resolveInRoot in production; a stub in
 *  tests) and an INJECTED `readDiff` reader (getFileDiff in production). Keeping
 *  this Electron-free lets the unit suite drive the SAME decision the handler
 *  runs. */
export interface FileDiffRequest {
  changeSet: ChangeSet;
  relPath: string;
  mergeBase: string | null;
  /** Throw to reject a path that escapes the sandbox root (Law 3). */
  confine: (p: string) => void;
  /** Produce the diff for a confined, authoritative row. */
  readDiff: (
    relPath: string,
    mergeBase: string,
    changeKind: ChangeKind,
    oldPath: string | null,
    binary: boolean,
  ) => Promise<FileDiff>;
}

/**
 * The PURE (Electron-free) decision logic behind the READ_FILE_DIFF handler,
 * extracted so production AND the unit suite run the SAME code (the handler is
 * Electron-bound and untestable). Decides, in order:
 *   (1) the relPath MUST be in main's authoritative changeSet — an unknown /
 *       escaping path that is not a listed change short-circuits to an empty
 *       FileDiff and git is NEVER read;
 *   (2) the NEW path AND a rename's OLD path MUST both pass `confine` (Law 3 —
 *       `git show/diff <sha>:<path>` reads the object store, bypassing the fs
 *       sandbox); a `confine` throw is caught and returns the empty FileDiff so
 *       an out-of-root path can never reach git;
 *   (3) the base MUST be resolved (mergeBase non-null);
 *   (4) only then is `readDiff` invoked with main's re-derived
 *       changeKind/oldPath/binary (never the renderer's shape).
 * NEVER throws — every rejection resolves to an empty (no-diff) FileDiff so the
 * IPC layer always gets a benign value.
 */
export async function resolveFileDiffRequest(
  req: FileDiffRequest,
): Promise<FileDiff> {
  const { changeSet, relPath, mergeBase, confine, readDiff } = req;
  const empty: FileDiff = {
    path: relPath,
    oldPath: null,
    changeKind: 'modified',
    binary: false,
    truncated: false,
    hunks: [],
  };

  if (!changeSet.available) return empty;
  const row = changeSet.files.find((f) => f.path === relPath);
  if (row === undefined) return empty; // not a listed change → no diff, no git

  // Law-3 re-confinement: NEW path AND a rename's OLD path BOTH resolve inside
  // the sandbox root before any git read. A throw (escape attempt) short-circuits
  // to the empty diff — git is never run.
  try {
    confine(relPath);
    if (row.oldPath !== null) confine(row.oldPath);
  } catch {
    return { ...empty, oldPath: row.oldPath, changeKind: row.changeKind };
  }

  if (mergeBase === null) {
    return { ...empty, oldPath: row.oldPath, changeKind: row.changeKind };
  }

  return readDiff(relPath, mergeBase, row.changeKind, row.oldPath, row.binary);
}
