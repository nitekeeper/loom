/* ============================================================
 * Loom — pure sandbox-root precedence decision (Law 3 boundary, PURE)
 * ------------------------------------------------------------
 * chooseRoot({ argvFolder, envRoot }) decides WHICH of two already-validated
 * candidate roots wins — the EXPLICIT positional folder argument (`loom .` /
 * `loom <dir>`) or the ambient LOOM_ROOT env var — returning the winner or null
 * when neither is present.
 *
 * WHY a pure module (mirrors search-core.ts / linux-maximize.ts): the precedence
 * RULE is the bug-prone part and must be unit-testable WITHOUT Electron. The thin
 * electron-aware wrapper (main.ts resolveRoot) does the impure work — reading
 * process.env/argv, the isDirectory() checks, and the packaged picker / dev cwd
 * fallback — then hands this fn the two pre-validated candidates.
 *
 * PRECEDENCE (the fix): the explicit positional argument takes priority OVER the
 * ambient LOOM_ROOT env var. A STALE/INHERITED LOOM_ROOT (e.g. leaked into the
 * user's shell by Loom's own integrated terminal, which previously spawned its
 * PTY with the parent's LOOM_ROOT) must NEVER make `loom .` silently reopen the
 * old folder — the folder the user explicitly named always wins. When NO
 * positional arg is given, LOOM_ROOT is still honored (the bin/loom.cjs launcher
 * and the --capture path communicate the root via LOOM_ROOT with no positional).
 *
 * PURE: imports nothing — no fs, no electron, no env/argv access. Both inputs are
 * already-resolved absolute directory paths (or null when absent/invalid), so
 * this fn only encodes the ordering. Re-exported via testkit-entry and unit-
 * tested in test/root-resolve.mjs.
 * ============================================================ */

/** The two pre-validated candidate roots, in no particular order. Each is an
 *  absolute directory path that the caller has ALREADY confirmed exists (via
 *  isDirectory), or null when that source is absent / set-but-invalid. */
export interface RootCandidates {
  /** The explicit positional folder argument (`loom .` / `loom <dir>`), or null
   *  when no usable positional folder was supplied. Takes PRECEDENCE. */
  argvFolder: string | null;
  /** The ambient LOOM_ROOT env var (validated to an existing dir), or null when
   *  unset / set-but-not-a-directory. Used ONLY when argvFolder is null. */
  envRoot: string | null;
}

/** Choose the sandbox root from the two candidates, encoding the precedence:
 *  the EXPLICIT positional argument beats the ambient LOOM_ROOT, so a stale /
 *  inherited LOOM_ROOT can never override the folder the user named. Returns the
 *  winning path, or null when BOTH candidates are absent (the caller then falls
 *  back to the packaged picker / dev cwd). */
export function chooseRoot({ argvFolder, envRoot }: RootCandidates): string | null {
  return argvFolder ?? envRoot ?? null;
}
