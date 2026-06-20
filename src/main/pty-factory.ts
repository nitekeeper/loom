/* ============================================================
 * Loom — node-pty factory (the ONLY node-pty touchpoint)
 * ------------------------------------------------------------
 * Adapts node-pty's IPty to the manager's PtyLike seam. node-pty is a
 * NATIVE module marked `external` in build.mjs's mainBuild (alongside
 * 'electron') and is loaded LAZILY via require() inside the returned
 * factory — a CJS require survives esbuild externalization, and a load
 * or spawn failure THROWS here, which createTerminalManager catches and
 * degrades to { sessionId: null } ("terminal unavailable") instead of
 * crashing boot. Kept out of testkit-entry: the unit suite injects a
 * fake factory; this file is exercised by the Tier-2 e2e
 * (test/e2e/terminal.e2e.ts) once built; not unit-testable by design.
 * ============================================================ */
import type { PtyFactory, PtyLike, PtySpawnOpts } from './terminal.js';

export function createNodePtyFactory(): PtyFactory {
  return (opts: PtySpawnOpts): PtyLike => {
    // Lazy load on FIRST spawn (not at import time) so a missing/ABI-broken
    // native binding degrades gracefully per open() instead of failing boot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pty is a native module kept EXTERNAL by esbuild and require()'d lazily on first spawn (see build.mjs); a static ESM import would break the bundle and fail boot on a missing binding
    const nodePty = require('node-pty') as typeof import('node-pty');

    // Drop undefined values: node-pty's env is Record<string, string>.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) {
      if (typeof v === 'string') env[k] = v;
    }

    const pty = nodePty.spawn(opts.shell, [], {
      name: 'xterm-256color',
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env,
    });

    return {
      // onData/onExit drop node-pty's IDisposable returns: the manager attaches
      // exactly ONE listener each per pty lifetime and drops the pty after
      // kill/exit, so there is nothing left to unsubscribe.
      write: (data: string): void => pty.write(data),
      resize: (cols: number, rows: number): void => pty.resize(cols, rows),
      kill: (): void => pty.kill(),
      onData: (cb: (d: string) => void): void => {
        pty.onData(cb);
      },
      onExit: (cb: (e: { exitCode: number }) => void): void => {
        pty.onExit((e) => cb({ exitCode: e.exitCode }));
      },
    };
  };
}
