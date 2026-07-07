/* ============================================================
 * Loom — terminal session manager (loom:terminal:* — PURE)
 * ------------------------------------------------------------
 * The main-process bookkeeping behind the human-invoked terminal pane:
 * up to MAX_TERMINALS concurrent sessionId-keyed PTY sessions, each spawned
 * in the launch root via an INJECTED PtyFactory (the only seam to node-pty —
 * src/main/pty-factory.ts), each owning its OWN coalescing output pump, with
 * every renderer payload RE-VALIDATED here (never trust the renderer):
 *
 *   - open    -> at capacity return { sessionId: null } (spawn/kill nothing);
 *                else spawn cwd=rootDir, insert an entry, return a fresh
 *                randomUUID() session token (null = unavailable/at-capacity).
 *   - input   -> string data only, <= MAX_TERMINAL_INPUT_BYTES (byte-
 *                measured), live session token only; else silent no-op.
 *   - resize  -> cols/rows finite integers within the TERMINAL_MIN/MAX
 *                bounds, live token only; else silent no-op.
 *   - close   -> kill on a live token; stale token = silent no-op.
 *
 * Output flows through a COALESCING pump: PTY chunks are buffered and
 * flushed to the attached sink as ONE TERMINAL_DATA push per 8ms tick
 * (unref'd timer), bounded at OUTPUT_BUFFER_CAP pending bytes with
 * drop-OLDEST overflow (a `cat hugefile` cannot flood the renderer;
 * the tail — what the user needs to see — survives). PTY exit flushes
 * the pending tail, pushes TERMINAL_EXIT, and invalidates the session.
 *
 * PURE: imports only the shared contract + node:crypto. NO electron,
 * NO node-pty — exported through testkit-entry and unit-tested with a
 * fake factory (test/terminal.mjs). MCP-invisible: no agent surface.
 * ============================================================ */
import { randomUUID } from 'node:crypto';
import {
  IPC,
  MAX_TERMINAL_INPUT_BYTES,
  TERMINAL_MIN_COLS,
  TERMINAL_MAX_COLS,
  TERMINAL_MIN_ROWS,
  TERMINAL_MAX_ROWS,
  type TerminalDataPush,
  type TerminalExitPush,
  type TerminalOpenResult,
} from '../shared/types.js';

/** The minimal PTY surface the manager drives. node-pty's IPty is adapted to
 *  this in pty-factory.ts; the unit suite injects a recording fake. */
export interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

/** Everything a factory needs to spawn one PTY. */
export interface PtySpawnOpts {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string | undefined>;
}

/** Spawns a PtyLike, or THROWS — a throw degrades open() to
 *  { sessionId: null } ("terminal unavailable"), never a crash. */
export type PtyFactory = (opts: PtySpawnOpts) => PtyLike;

/** Shell selection: $SHELL falling back to bash on POSIX; powershell.exe on
 *  win32 (node-pty conpty). Pure — platform/env are parameters. */
export function defaultShell(
  platform: string,
  env: Record<string, string | undefined>,
): string {
  // Deliberately NOT %COMSPEC% (that names cmd.exe) — the design picks
  // PowerShell as the win32 terminal shell.
  if (platform === 'win32') return 'powershell.exe';
  // A bogus $SHELL is fine: the factory's spawn throw degrades open() to
  // { sessionId: null } ("terminal unavailable") rather than crashing.
  return env.SHELL || 'bash';
}

/** Strip LOOM_ROOT from a child PTY's environment so Loom's OWN integrated
 *  terminal can never propagate a stale sandbox root to a nested `loom`.
 *
 *  WHY: when Loom is launched via bin/loom.cjs (or the --capture path), it sets
 *  LOOM_ROOT in its own process.env to communicate the resolved root. That env
 *  is the default the PTY would inherit — so a `loom .` typed INSIDE Loom's
 *  terminal would see the parent's LOOM_ROOT and (before main.ts now prefers the
 *  explicit positional arg) reopen the parent's folder. Even with the precedence
 *  fix, a bare `loom` with no positional should resolve from the user's actual
 *  cwd, not a leaked parent root — so we remove the var at the PTY boundary.
 *
 *  Pure + non-mutating: returns a SHALLOW copy with LOOM_ROOT deleted, keeping
 *  EVERY other var (incl. SHELL, which defaultShell still reads from the kept
 *  env). The injected env is never mutated. */
export function stripLoomRoot(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const { LOOM_ROOT: _drop, ...rest } = env;
  return rest;
}

/** Ensure the child PTY has a UTF-8 locale so Korean/CJK I/O is not mojibaked.
 *
 *  WHY: node-pty inherits Loom's OWN environment verbatim. When Loom is launched
 *  WITHOUT a UTF-8 locale — the classic macOS GUI-launch case (LANG unset) or a
 *  minimal Linux / cron launch (LANG=C / POSIX) — the shell and child programs
 *  treat multibyte (Korean) bytes as the C charset and emit mojibake at the pty
 *  layer, before xterm or fonts are ever involved.
 *
 *  Pure + non-mutating (returns a SHALLOW copy). NO-OP on win32 (conpty/
 *  PowerShell drives Unicode via its code page, not POSIX locale vars) and NO-OP
 *  when the GOVERNING charset category — the highest-precedence of LC_ALL >
 *  LC_CTYPE > LANG that is set — ALREADY selects UTF-8 (never override the user's
 *  deliberate locale). Otherwise forces UTF-8 by writing ONLY the governing
 *  variable (LC_ALL when it is set, else LC_CTYPE, which outranks LANG for the
 *  charset category); LANG is deliberately LEFT INTACT so the user's collation/
 *  messages are preserved. The target keeps the governing locale's language
 *  (`ko_KR` -> `ko_KR.UTF-8`), else defaults to C.UTF-8 on Linux (present on
 *  minimal glibc, keeps C collation) / en_US.UTF-8 on macOS (which has no C.UTF-8). */
export function withUtf8Locale(
  env: Record<string, string | undefined>,
  platform: string,
): Record<string, string | undefined> {
  if (platform === 'win32') return env;
  const isUtf8 = (v: string | undefined): boolean =>
    typeof v === 'string' && /utf-?8/i.test(v);
  // Treat an empty string as unset (POSIX ignores empty locale vars).
  const val = (v: string | undefined): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined;
  const lcAll = val(env.LC_ALL);
  // The EFFECTIVE charset is governed by POSIX precedence LC_ALL > LC_CTYPE > LANG.
  const governingVal = lcAll ?? val(env.LC_CTYPE) ?? val(env.LANG);
  // Already UTF-8 via the WINNING category → never override the user's locale
  // (a UTF-8 LANG does NOT count if a non-UTF-8 LC_ALL/LC_CTYPE outranks it).
  if (isUtf8(governingVal)) return env;
  // Preserve the governing locale's language (`de_DE.ISO-8859-1` -> `de_DE.UTF-8`),
  // else a UTF-8 locale that EXISTS on the platform: C.UTF-8 on Linux (present on
  // minimal glibc without locale-gen, and keeps C collation/formatting), and
  // en_US.UTF-8 on macOS (which ships no C.UTF-8).
  const m = /^([a-z]{2,3}_[A-Z]{2})/.exec(governingVal ?? '');
  const target = m ? `${m[1]}.UTF-8` : platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  // LC_CTYPE cannot override an LC_ALL, so when LC_ALL is set it MUST be the var
  // we change; otherwise set LC_CTYPE (it outranks LANG for the charset category)
  // and leave LANG's collation/messages exactly as the user had them.
  const setVar = lcAll !== undefined ? 'LC_ALL' : 'LC_CTYPE';
  return { ...env, [setVar]: target };
}

/** Drop-oldest flow-control bound (bytes) on PENDING (unflushed) PTY output.
 *  Bounds the renderer-bound backlog when the sink is detached or the pump is
 *  behind a flood — the oldest chunks are dropped, the tail is preserved. */
export const OUTPUT_BUFFER_CAP = 256 * 1024;

/** Coalescing flush cadence: one TERMINAL_DATA push per tick at most. */
const FLUSH_MS = 8;

/** Hard cap on concurrent live terminals. open() at capacity spawns nothing,
 *  kills nothing, and returns the { sessionId: null } graceful sentinel. */
export const MAX_TERMINALS = 3;

/** One live terminal: its OWN pty PLUS its OWN coalescing-pump state
 *  (`pending`/`pendingBytes`/`flushTimer`). Keeping the pump per-entry is what
 *  isolates 3 terminals' output — a shared global pump would interleave their
 *  chunks and mis-account the per-session OUTPUT_BUFFER_CAP (risk R1). */
export interface SessionEntry {
  id: string;
  pty: PtyLike;
  /** Pending (unflushed) output chunks + their byte total, bounded at
   *  OUTPUT_BUFFER_CAP with drop-oldest — PER ENTRY. */
  pending: { data: string; bytes: number }[];
  pendingBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalManager {
  /** Validates { cols, rows }; spawns via the factory and inserts a new entry
   *  (does NOT kill prior sessions). { sessionId: null } on invalid payload,
   *  factory throw, or at MAX_TERMINALS capacity (spawns/kills nothing). */
  open(payload: unknown): TerminalOpenResult;
  /** Validates { sessionId, data } (live token, string, byte cap). */
  input(payload: unknown): void;
  /** Validates { sessionId, cols, rows } (live token, in-range ints). */
  resize(payload: unknown): void;
  /** Validates { sessionId }; kills + removes ONLY the matching entry. */
  close(payload: unknown): void;
  /** Attach the renderer push sink (send(channel, payload)). Buffered output
   *  flushes once attached. Returns a detach fn — pushes stop after detach. */
  attachSink(send: (channel: string, payload: unknown) => void): () => void;
  /** Kill EVERY live session unconditionally (window close / app quit). */
  disposeAll(): void;
}

/** True for a finite integer within [lo, hi]. */
function intInRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

export function createTerminalManager(deps: {
  factory: PtyFactory;
  rootDir: string;
  /** Default process.platform (injected for the pure unit suite). */
  platform?: string;
  /** Default process.env (injected for the pure unit suite). */
  env?: Record<string, string | undefined>;
}): TerminalManager {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;

  /** The live sessions, keyed by their per-spawn random token. The id is
   *  re-checked on every input/resize/close via sessions.get(sessionId)
   *  (unknown id = silent no-op). Each entry owns its OWN pump state. */
  const sessions = new Map<string, SessionEntry>();
  let sink: ((channel: string, payload: unknown) => void) | null = null;

  /** Resolve the live entry carrying `payload.sessionId`, or null. */
  function liveSession(payload: unknown): SessionEntry | null {
    if (payload === null || typeof payload !== 'object') return null;
    const { sessionId } = payload as { sessionId?: unknown };
    if (typeof sessionId !== 'string') return null;
    return sessions.get(sessionId) ?? null;
  }

  function clearPending(entry: SessionEntry): void {
    entry.pending = [];
    entry.pendingBytes = 0;
  }

  /** Buffer one PTY chunk into ITS entry, enforcing the drop-oldest byte cap.
   *  A single over-cap chunk is tail-truncated (byte-wise) so the newest output
   *  — what the user needs to see — always survives. */
  function buffer(entry: SessionEntry, data: string): void {
    let chunk = data;
    let bytes = Buffer.byteLength(chunk);
    if (bytes > OUTPUT_BUFFER_CAP) {
      // Keep only the trailing CAP bytes (may split a multibyte char at the
      // very head of the kept tail — acceptable degradation under a flood).
      // U+FFFD replacement of the split head can INFLATE the byte count back
      // over the cap, so trim leading CHARS (strictly decreasing — a byte-wise
      // re-slice could re-split the U+FFFD) until <= CAP holds strictly.
      chunk = Buffer.from(chunk).subarray(-OUTPUT_BUFFER_CAP).toString();
      bytes = Buffer.byteLength(chunk);
      while (bytes > OUTPUT_BUFFER_CAP) {
        chunk = chunk.slice(1);
        bytes = Buffer.byteLength(chunk);
      }
      clearPending(entry);
    }
    entry.pending.push({ data: chunk, bytes });
    entry.pendingBytes += bytes;
    while (entry.pendingBytes > OUTPUT_BUFFER_CAP && entry.pending.length > 1) {
      const oldest = entry.pending.shift();
      if (oldest !== undefined) entry.pendingBytes -= oldest.bytes;
    }
  }

  /** Flush ONE entry's pending output as ONE TERMINAL_DATA push (sink +
   *  liveness permitting; otherwise the bounded buffer keeps accumulating). */
  function flush(entry: SessionEntry): void {
    if (sink === null || entry.pending.length === 0) return;
    if (sessions.get(entry.id) !== entry) return;
    const push: TerminalDataPush = {
      sessionId: entry.id,
      data: entry.pending.map((c) => c.data).join(''),
    };
    clearPending(entry);
    sink(IPC.TERMINAL_DATA, push);
  }

  function scheduleFlush(entry: SessionEntry): void {
    if (entry.flushTimer !== null) return;
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      flush(entry);
    }, FLUSH_MS);
    (entry.flushTimer as { unref?: () => void }).unref?.();
  }

  /** Kill + forget ONE entry: remove it from the map, clear its timer, kill
   *  its pty (best-effort; never throws). */
  function killSession(entry: SessionEntry): void {
    sessions.delete(entry.id);
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    clearPending(entry);
    try {
      entry.pty.kill();
    } catch {
      /* best-effort: a dying PTY must never take the app down. */
    }
  }

  return {
    open(payload: unknown): TerminalOpenResult {
      // RE-VALIDATE in main — never trust the renderer. cols/rows must be
      // finite integers within the shared bounds.
      if (payload === null || typeof payload !== 'object') return { sessionId: null };
      const { cols, rows } = payload as { cols?: unknown; rows?: unknown };
      if (
        !intInRange(cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS) ||
        !intInRange(rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
      ) {
        return { sessionId: null };
      }

      // At capacity: spawn nothing, kill nothing — graceful sentinel.
      if (sessions.size >= MAX_TERMINALS) return { sessionId: null };

      let pty: PtyLike;
      try {
        pty = deps.factory({
          // defaultShell reads $SHELL — resolved from `env` (which still carries
          // SHELL) before LOOM_ROOT is stripped for the child's environment.
          shell: defaultShell(platform, env),
          cwd: deps.rootDir,
          cols,
          rows,
          // Strip LOOM_ROOT so a nested `loom` inside this terminal can never
          // inherit Loom's own (possibly stale) sandbox root — keeping all other
          // vars (SHELL included) — then guarantee a UTF-8 locale so Korean/CJK
          // I/O is never mojibaked when Loom itself was launched without one.
          env: withUtf8Locale(stripLoomRoot(env), platform),
        });
      } catch {
        // Graceful "terminal unavailable" (node-pty load/spawn failure).
        return { sessionId: null };
      }

      const id = randomUUID();
      const entry: SessionEntry = {
        id,
        pty,
        pending: [],
        pendingBytes: 0,
        flushTimer: null,
      };
      sessions.set(id, entry);

      pty.onData((d: string) => {
        // Output from a superseded/killed session is dropped at the token gate.
        if (sessions.get(id) !== entry) return;
        buffer(entry, d);
        scheduleFlush(entry);
      });

      pty.onExit((e: { exitCode: number }) => {
        if (sessions.get(id) !== entry) return;
        // Flush the pending tail FIRST so no output is lost, then push the
        // exit and invalidate the session (input-after-exit is a no-op).
        flush(entry);
        const push: TerminalExitPush = { sessionId: id, exitCode: e.exitCode };
        sessions.delete(id);
        if (entry.flushTimer !== null) {
          clearTimeout(entry.flushTimer);
          entry.flushTimer = null;
        }
        clearPending(entry);
        if (sink !== null) sink(IPC.TERMINAL_EXIT, push);
      });

      return { sessionId: id };
    },

    input(payload: unknown): void {
      const live = liveSession(payload);
      if (live === null) return;
      const { data } = payload as { data?: unknown };
      if (typeof data !== 'string') return;
      if (Buffer.byteLength(data) > MAX_TERMINAL_INPUT_BYTES) return;
      live.pty.write(data);
    },

    resize(payload: unknown): void {
      const live = liveSession(payload);
      if (live === null) return;
      const { cols, rows } = payload as { cols?: unknown; rows?: unknown };
      if (
        !intInRange(cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS) ||
        !intInRange(rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
      ) {
        return;
      }
      live.pty.resize(cols, rows);
    },

    close(payload: unknown): void {
      const live = liveSession(payload);
      if (live === null) return;
      killSession(live);
    },

    attachSink(send: (channel: string, payload: unknown) => void): () => void {
      sink = send;
      // Anything buffered while detached flushes on the next pump tick —
      // per entry, so every terminal's backlog drains.
      for (const entry of sessions.values()) scheduleFlush(entry);
      return () => {
        if (sink === send) sink = null;
      };
    },

    disposeAll(): void {
      // Reap EVERY live session: kill each pty + clear each per-entry timer.
      for (const entry of [...sessions.values()]) killSession(entry);
    },
  };
}
