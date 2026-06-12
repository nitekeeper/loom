/* ============================================================
 * Loom — terminal session manager (loom:terminal:* — PURE)
 * ------------------------------------------------------------
 * The main-process bookkeeping behind the human-invoked terminal pane:
 * one live PTY session at a time, spawned in the launch root via an
 * INJECTED PtyFactory (the only seam to node-pty — src/main/pty-factory.ts),
 * with every renderer payload RE-VALIDATED here (never trust the renderer):
 *
 *   - open    -> kill the previous session, spawn cwd=rootDir, return a
 *                fresh randomUUID() session token (null = unavailable).
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

/** Drop-oldest flow-control bound (bytes) on PENDING (unflushed) PTY output.
 *  Bounds the renderer-bound backlog when the sink is detached or the pump is
 *  behind a flood — the oldest chunks are dropped, the tail is preserved. */
export const OUTPUT_BUFFER_CAP = 256 * 1024;

/** Coalescing flush cadence: one TERMINAL_DATA push per tick at most. */
const FLUSH_MS = 8;

export interface TerminalManager {
  /** Validates { cols, rows }; kills any previous session; spawns via the
   *  factory. { sessionId: null } on invalid payload or factory throw. */
  open(payload: unknown): TerminalOpenResult;
  /** Validates { sessionId, data } (live token, string, byte cap). */
  input(payload: unknown): void;
  /** Validates { sessionId, cols, rows } (live token, in-range ints). */
  resize(payload: unknown): void;
  /** Validates { sessionId }; kills the live session on a match. */
  close(payload: unknown): void;
  /** Attach the renderer push sink (send(channel, payload)). Buffered output
   *  flushes once attached. Returns a detach fn — pushes stop after detach. */
  attachSink(send: (channel: string, payload: unknown) => void): () => void;
  /** Kill the live session unconditionally (window close / app quit). */
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

  /** The SINGLE live session, or null. The id is the per-spawn random token
   *  re-checked on every input/resize/close (stale id = silent no-op). */
  let session: { id: string; pty: PtyLike } | null = null;
  let sink: ((channel: string, payload: unknown) => void) | null = null;
  /** Pending (unflushed) output chunks + their byte total, bounded at
   *  OUTPUT_BUFFER_CAP with drop-oldest. */
  let pending: { data: string; bytes: number }[] = [];
  let pendingBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** True when `payload` is an object carrying the LIVE session's token. */
  function liveSession(payload: unknown): { id: string; pty: PtyLike } | null {
    if (session === null) return null;
    if (payload === null || typeof payload !== 'object') return null;
    const { sessionId } = payload as { sessionId?: unknown };
    return sessionId === session.id ? session : null;
  }

  function clearPending(): void {
    pending = [];
    pendingBytes = 0;
  }

  /** Buffer one PTY chunk, enforcing the drop-oldest byte cap. A single
   *  over-cap chunk is tail-truncated (byte-wise) so the newest output —
   *  what the user needs to see — always survives. */
  function buffer(data: string): void {
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
      clearPending();
    }
    pending.push({ data: chunk, bytes });
    pendingBytes += bytes;
    while (pendingBytes > OUTPUT_BUFFER_CAP && pending.length > 1) {
      const oldest = pending.shift();
      if (oldest !== undefined) pendingBytes -= oldest.bytes;
    }
  }

  /** Flush the pending output as ONE TERMINAL_DATA push (sink + session
   *  permitting; otherwise the bounded buffer simply keeps accumulating). */
  function flush(): void {
    if (sink === null || session === null || pending.length === 0) return;
    const push: TerminalDataPush = {
      sessionId: session.id,
      data: pending.map((c) => c.data).join(''),
    };
    clearPending();
    sink(IPC.TERMINAL_DATA, push);
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_MS);
    (flushTimer as { unref?: () => void }).unref?.();
  }

  /** Kill + forget the live session (best-effort kill; never throws). */
  function killSession(): void {
    if (session === null) return;
    const { pty } = session;
    session = null;
    clearPending();
    try {
      pty.kill();
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

      // Single live session: a second open kills the previous one first.
      killSession();

      let pty: PtyLike;
      try {
        pty = deps.factory({
          shell: defaultShell(platform, env),
          cwd: deps.rootDir,
          cols,
          rows,
          env,
        });
      } catch {
        // Graceful "terminal unavailable" (node-pty load/spawn failure).
        return { sessionId: null };
      }

      const id = randomUUID();
      session = { id, pty };

      pty.onData((d: string) => {
        // Output from a superseded/killed session is dropped at the token gate.
        if (session === null || session.id !== id) return;
        buffer(d);
        scheduleFlush();
      });

      pty.onExit((e: { exitCode: number }) => {
        if (session === null || session.id !== id) return;
        // Flush the pending tail FIRST so no output is lost, then push the
        // exit and invalidate the session (input-after-exit is a no-op).
        flush();
        const push: TerminalExitPush = { sessionId: id, exitCode: e.exitCode };
        session = null;
        clearPending();
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
      if (liveSession(payload) === null) return;
      killSession();
    },

    attachSink(send: (channel: string, payload: unknown) => void): () => void {
      sink = send;
      // Anything buffered while detached flushes on the next pump tick.
      scheduleFlush();
      return () => {
        if (sink === send) sink = null;
      };
    },

    disposeAll(): void {
      killSession();
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    },
  };
}
