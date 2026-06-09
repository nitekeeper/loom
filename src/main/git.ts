import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitFileStatus } from '../shared/types.js';

/** Run `git status --porcelain -uall -z` in `root` and parse the output into
 *  a map of root-relative POSIX paths → GitFileStatus.
 *  Returns an empty map when root is not a git repo or git is not available.
 *  The -z flag uses NUL terminators and suppresses git's path quoting, so
 *  filenames with spaces, non-ASCII bytes, or backslashes are handled correctly
 *  without any unquoting/unescaping logic. */
export async function getGitStatus(root: string): Promise<Map<string, GitFileStatus>> {
  // Fast-path: skip entirely if .git is not present
  try {
    await access(join(root, '.git'));
  } catch {
    return new Map();
  }

  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain', '-uall', '-z'],
      { cwd: root, timeout: 5000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // Warn on buffer overflow so the operator knows why badges disappeared,
          // rather than silently treating it the same as "git not installed".
          if ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            console.warn('[git] git status output exceeded maxBuffer (20 MB); badges suppressed');
          }
          resolve(new Map());
          return;
        }
        resolve(parsePortcelain(stdout));
      },
    );
  });
}

function parsePortcelain(output: string): Map<string, GitFileStatus> {
  const result = new Map<string, GitFileStatus>();
  // -z mode: entries are NUL-terminated; rename entries have two NUL-separated
  // paths (old NUL new NUL).  We split on NUL and handle the XY+path tokens.
  // A rename entry looks like "R  new\0old\0" — the first token carries the XY
  // and the destination path; the second token is the source (we skip it).
  const tokens = output.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    i += 1;
    if (token.length < 4) continue; // need at least "XY p"

    const xy = token.slice(0, 2);
    const filePath = token.slice(3); // path follows "XY "
    if (!filePath) continue;

    // For rename/copy entries, git -z emits "XY dest\0src\0"; skip the source.
    const x = xy[0] ?? ' ';
    if (x === 'R' || x === 'C') i += 1;

    const posixPath = filePath.replace(/\\/g, '/').replace(/^\//, '');
    if (!posixPath) continue;

    const y = xy[1] ?? ' '; // worktree status

    let status: GitFileStatus;
    if (xy === '??') {
      // Untracked file
      status = 'untracked';
    } else if (x === 'A') {
      // Newly added to index (possibly also dirty in the worktree — AM, etc.)
      // Always show as 'added' so new files never appear as 'modified'.
      status = 'added';
    } else if (x !== ' ' && x !== '?' && y === ' ') {
      // Purely staged change (not a new file)
      status = 'staged';
    } else if (y !== ' ' && y !== '?') {
      // Worktree modification (staged or not)
      status = 'modified';
    } else if (x !== ' ' && x !== '?') {
      // Staged-only (index changed, worktree clean)
      status = 'staged';
    } else {
      continue;
    }
    result.set(posixPath, status);
  }
  return result;
}
