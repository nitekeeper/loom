/* ============================================================
 * Loom — daily token-usage rollup (TOKENS_DAILY data layer)
 * ------------------------------------------------------------
 * Produces a daily token-usage rollup (DailyTokenResult) by SPAWNING
 * atelier's already-shipped `token_usage.py` CLI — the sibling of
 * git-diff.ts: a fail-soft, never-throws producer that runs an external
 * process via `execFile` with a FIXED argv array and NO shell (argument
 * injection is impossible) under a bounded timeout + maxBuffer.
 *
 * SECURITY (mirrors git-diff.ts):
 *   - execFile, NEVER exec/shell — the python binary + the script path +
 *     every flag ride as discrete argv entries; no string is ever
 *     interpolated into a shell command line.
 *   - The renderer supplies ONLY the advisory cost/since OPTIONS. The
 *     script path + python command are resolved by MAIN alone (config
 *     override or a glob over the plugin cache) — a hostile renderer can
 *     never point us at an arbitrary executable.
 *   - The CLI's stdout is UNTRUSTED DATA: it is JSON.parsed inside a
 *     try/catch (bad_json on failure) and returned as data rows; it is
 *     NEVER evaluated. The renderer escapes every field before render
 *     (Law 1), exactly like ChangedFile.path.
 *
 * FAIL-SOFT: every failure mode resolves to a typed {ok:false, reason}
 * union value rather than rejecting — the IPC layer always receives a
 * benign value (mirrors getChanges' available:false contract):
 *   atelier_not_found | spawn_failed | nonzero_exit | bad_json | timeout.
 *
 * Electron-free (node:child_process + node:fs + node:os + node:path +
 * shared types only) so it is unit-testable without a display.
 * ============================================================ */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  DailyTokenReason,
  DailyTokenResult,
  DailyTokenRow,
  DailyTokenTotals,
  LoomConfig,
} from '../shared/types.js';

/** Per-call CLI timeout (ms). A daily rollup is a cheap read; a hung/slow CLI
 *  must not wedge the IPC handler, so we cap it (mirrors git-diff's timeout). */
const TOKENS_TIMEOUT_MS = 8000;
/** maxBuffer for the CLI stdout — a daily JSON rollup is small, but bound it so
 *  a runaway/hostile CLI cannot flood main's memory (16 MiB headroom). */
const TOKENS_MAX_BUFFER = 16 * 1024 * 1024;
/** Default python interpreter when config does not override `tokens.python`. */
const DEFAULT_PYTHON = 'python3';

/** The resolved location of atelier's token_usage.py + the python to run it. */
export interface TokenScriptLocation {
  /** The python interpreter command (argv[0] of execFile). */
  python: string;
  /** Absolute path to token_usage.py (the first script-arg). */
  scriptPath: string;
}

/** Optional MAIN-side dependency seam for getDailyTokens, kept SEPARATE from the
 *  renderer-facing options so the renderer can never inject a python/scriptPath.
 *  Production passes `config`; the unit suite injects `location` (a fake script)
 *  or a `homeDir` (an empty tree) to stay hermetic — no real atelier needed. */
export interface DailyTokenDeps {
  /** An already-resolved location (highest precedence). `null` is an explicit
   *  "nothing found" signal (=> atelier_not_found); `undefined` means "resolve
   *  it yourself" from config + glob. */
  location?: TokenScriptLocation | null;
  /** The loom config store, read for a `tokens.atelierScript` / `tokens.python`
   *  override before falling back to glob discovery. */
  config?: { read(): LoomConfig };
  /** Home directory for the glob fallback (default os.homedir()) — injectable so
   *  the suite can point discovery at an empty temp tree. */
  homeDir?: string;
}

/** Compare two version-dir names (e.g. "1.10.1" vs "1.9.0") so the NEWEST sorts
 *  first. Splits on '.', compares numeric components left-to-right; a non-numeric
 *  component sorts as 0 so a malformed dir never throws. */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10);
    const nb = Number.parseInt(pb[i] ?? '0', 10);
    const va = Number.isFinite(na) ? na : 0;
    const vb = Number.isFinite(nb) ? nb : 0;
    if (va !== vb) return vb - va; // descending: bigger version first
  }
  return 0;
}

/**
 * Resolve where to find atelier's token_usage.py + which python runs it.
 * Order:
 *   (1) config `tokens.atelierScript` (used VERBATIM; `tokens.python` overrides
 *       the interpreter, default 'python3') — the configurable seam;
 *   (2) otherwise GLOB the newest version dir under
 *       <home>/.claude/plugins/cache/agora/atelier/<ver>/scripts/token_usage.py
 *       (highest version wins) with the default 'python3'.
 * Returns null when neither yields an existing script (=> atelier_not_found).
 * NEVER throws — a missing/unreadable cache dir resolves to null.
 */
export function resolveTokenScript(deps?: DailyTokenDeps): TokenScriptLocation | null {
  // (0) An explicitly-injected location (test seam / pre-resolved) wins.
  if (deps?.location !== undefined) return deps.location;

  // (1) Config override — the script path is used verbatim (configurable).
  const cfg = deps?.config?.read();
  const scriptOverride = cfg?.tokens?.atelierScript;
  if (typeof scriptOverride === 'string' && scriptOverride.length > 0) {
    const python =
      typeof cfg?.tokens?.python === 'string' && cfg.tokens.python.length > 0
        ? cfg.tokens.python
        : DEFAULT_PYTHON;
    return { python, scriptPath: scriptOverride };
  }

  // (2) Glob fallback: newest version dir under the agora atelier plugin cache.
  const home = deps?.homeDir ?? homedir();
  const atelierDir = join(home, '.claude', 'plugins', 'cache', 'agora', 'atelier');
  let versions: string[];
  try {
    versions = readdirSync(atelierDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null; // cache dir absent/unreadable — atelier not installed
  }
  versions.sort(compareVersionDesc);
  for (const ver of versions) {
    const candidate = join(atelierDir, ver, 'scripts', 'token_usage.py');
    if (existsSync(candidate)) {
      return { python: DEFAULT_PYTHON, scriptPath: candidate };
    }
  }
  return null;
}

/** Build the failure half of the union with a typed reason + readable message. */
function fail(reason: DailyTokenReason, error: string): DailyTokenResult {
  return { ok: false, reason, error };
}

/** ISO calendar-day shape the CLI's `--since` accepts (YYYY-MM-DD). A renderer
 *  value that does not match is dropped rather than forwarded, so only a
 *  well-formed operand ever reaches the CLI. */
const SINCE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Sanitize the renderer-supplied options — never trust the renderer (the IPC
 *  payload arrives as `unknown`). Only a boolean `cost` and a `YYYY-MM-DD`
 *  `since` string are honored; anything else is dropped (the flag is simply
 *  omitted from the argv). */
function sanitizeOptions(raw?: unknown): { cost: boolean; since: string | null } {
  const opts = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const cost = opts.cost === true;
  const since =
    typeof opts.since === 'string' && SINCE_RE.test(opts.since) ? opts.since : null;
  return { cost, since };
}

/** Coerce one untrusted CLI row into a well-formed DailyTokenRow, or null if it
 *  is not an object. Numeric fields default to 0 and strings to a safe value so
 *  the renderer never has to defend against missing/NaN/non-string fields. */
function _num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function coerceRow(raw: unknown): DailyTokenRow | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const row: DailyTokenRow = {
    day: typeof r.day === 'string' && r.day.length > 0 ? r.day : 'unknown',
    model: typeof r.model === 'string' ? r.model : '',
    input_tokens: _num(r.input_tokens),
    output_tokens: _num(r.output_tokens),
    cache_creation_input_tokens: _num(r.cache_creation_input_tokens),
    cache_read_input_tokens: _num(r.cache_read_input_tokens),
  };
  if (r.cost_usd === null) row.cost_usd = null;
  else if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) row.cost_usd = r.cost_usd;
  return row;
}
function coerceRows(arr: readonly unknown[]): DailyTokenRow[] {
  return arr.map(coerceRow).filter((r): r is DailyTokenRow => r !== null);
}

/** Run the resolved python+script with a FIXED argv (NO shell), resolving to the
 *  fail-soft union. Mirrors git-diff's runGit error classification:
 *   - a timeout kill (SIGTERM, no maxBuffer-overflow code) => timeout;
 *   - a numeric non-zero exit code               => nonzero_exit;
 *   - anything else (ENOENT, maxBuffer overflow) => spawn_failed.
 *  stdout is JSON.parsed inside a try/catch (=> bad_json) and matched against
 *  BOTH CLI shapes (a bare rows array, OR a {rows, totals} object). */
function runScript(
  loc: TokenScriptLocation,
  args: readonly string[],
): Promise<DailyTokenResult> {
  return new Promise((resolve) => {
    execFile(
      loc.python,
      args as string[],
      { timeout: TOKENS_TIMEOUT_MS, maxBuffer: TOKENS_MAX_BUFFER },
      (err, stdout) => {
        if (err) {
          const code: unknown = (err as { code?: unknown }).code;
          const killed = (err as { killed?: unknown }).killed === true;
          const signal = (err as { signal?: unknown }).signal;
          const overflow = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          if (killed && signal === 'SIGTERM' && !overflow) {
            resolve(fail('timeout', `token_usage.py timed out after ${TOKENS_TIMEOUT_MS}ms`));
            return;
          }
          if (typeof code === 'number') {
            resolve(fail('nonzero_exit', `token_usage.py exited with code ${code}`));
            return;
          }
          // ENOENT (python/script missing), maxBuffer overflow, or any other
          // spawn-level failure: the process never produced usable output.
          resolve(fail('spawn_failed', `failed to spawn token_usage.py: ${err.message}`));
          return;
        }
        resolve(parseStdout(stdout));
      },
    );
  });
}

/** Parse the CLI stdout into the success union, handling BOTH documented shapes
 *  (a bare DailyTokenRow[] without --cost, or a { rows, totals } object with
 *  --cost). Untrusted DATA: any parse failure or unrecognized shape degrades to
 *  bad_json (never throws). */
export function parseStdout(stdout: string): DailyTokenResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail('bad_json', 'token_usage.py stdout was not valid JSON');
  }
  // Shape A — a bare rows array (no --cost). Each row is coerced so the renderer
  // never sees a missing/NaN/non-string field, even from a malformed CLI line.
  if (Array.isArray(parsed)) {
    return { ok: true, rows: coerceRows(parsed) };
  }
  // Shape B — { rows, totals } (under --cost). `totals` is optional/best-effort.
  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as { rows?: unknown; totals?: unknown };
    if (Array.isArray(obj.rows)) {
      const result: DailyTokenResult = { ok: true, rows: coerceRows(obj.rows) };
      if (obj.totals !== null && typeof obj.totals === 'object') {
        result.totals = obj.totals as DailyTokenTotals;
      }
      return result;
    }
  }
  return fail('bad_json', 'token_usage.py stdout was not a known rows shape');
}

/**
 * Produce a daily token-usage rollup by spawning atelier's token_usage.py CLI.
 * `opts` carries the renderer-facing cost/since options (re-validated here);
 * `deps` is the MAIN-side seam (config for the path override, or an injected
 * location/homeDir for hermetic tests). Resolves the fail-soft DailyTokenResult
 * union and NEVER throws:
 *   - no script resolved   => {ok:false, reason:'atelier_not_found'};
 *   - spawn/timeout/exit   => the matching reason;
 *   - unparseable stdout   => {ok:false, reason:'bad_json'};
 *   - success              => {ok:true, rows[, totals]}.
 * Fixed argv: [scriptPath, 'daily', '--format', 'json', --cost?, --since?].
 */
export async function getDailyTokens(
  opts?: unknown,
  deps?: DailyTokenDeps,
): Promise<DailyTokenResult> {
  const loc = resolveTokenScript(deps);
  if (loc === null) {
    return fail('atelier_not_found', 'no atelier token_usage.py found (config unset + glob empty)');
  }

  const { cost, since } = sanitizeOptions(opts);
  const args: string[] = [
    loc.scriptPath,
    'daily',
    '--format',
    'json',
    ...(cost ? ['--cost'] : []),
    ...(since !== null ? ['--since', since] : []),
  ];
  return runScript(loc, args);
}
