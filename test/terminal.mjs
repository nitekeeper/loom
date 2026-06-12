/* ============================================================
 * Loom — terminal session manager unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE main-process terminal session manager (src/main/terminal.ts)
 * behind the loom:terminal:* IPC channels, with an INJECTED fake PTY factory
 * (no node-pty, no Electron): spawn-in-root, single-session kill-previous,
 * payload re-validation (types / 64KiB input cap / stale session ids /
 * cols-rows range), coalesced output pump, drop-oldest flow cap, exit
 * invalidation, close/dispose kill, and the defaultShell selection.
 * DOM-free: exercises createTerminalManager from the testkit bundle.
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

/** A recording fake PTY factory (the injected seam — no node-pty). */
function makeFakeFactory() {
  const spawned = [];
  const ptys = [];
  const factory = (opts) => {
    spawned.push(opts);
    const pty = {
      written: [],
      resizes: [],
      killed: false,
      _dataCb: null,
      _exitCb: null,
      write(d) { this.written.push(d); },
      resize(cols, rows) { this.resizes.push([cols, rows]); },
      kill() { this.killed = true; },
      onData(cb) { this._dataCb = cb; },
      onExit(cb) { this._exitCb = cb; },
      emitData(d) { if (this._dataCb) this._dataCb(d); },
      emitExit(e) { if (this._exitCb) this._exitCb(e); },
    };
    ptys.push(pty);
    return pty;
  };
  return { factory, spawned, ptys };
}

/** Let the manager's 8ms coalescing flush timer fire (real, unref'd timer). */
const settle = () => new Promise((r) => setTimeout(r, 30));

const ENV = { SHELL: '/bin/zsh' };

function makeManager(k, factory, overrides = {}) {
  return k.createTerminalManager({
    factory,
    rootDir: '/fake/root',
    platform: 'linux',
    env: ENV,
    ...overrides,
  });
}

test('TERM-OPEN: open spawns via factory with cwd=rootDir and returns a session id', async () => {
  const k = await kit();
  const { factory, spawned } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const res = mgr.open({ cols: 80, rows: 24 });
  assert.equal(typeof res.sessionId, 'string');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cwd, '/fake/root');
  assert.equal(spawned[0].cols, 80);
  assert.equal(spawned[0].rows, 24);
  assert.equal(spawned[0].shell, '/bin/zsh'); // $SHELL honored via injected env
  mgr.disposeAll();
});

test('TERM-OPEN: a throwing factory degrades to sessionId:null (terminal unavailable)', async () => {
  const k = await kit();
  const mgr = makeManager(k, () => { throw new Error('node-pty failed to load'); });
  const res = mgr.open({ cols: 80, rows: 24 });
  assert.equal(res.sessionId, null);
  mgr.disposeAll();
});

test('TERM-OPEN: a malformed open payload never spawns (sessionId:null)', async () => {
  const k = await kit();
  const { factory, spawned } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  assert.equal(mgr.open(42).sessionId, null);
  assert.equal(mgr.open(null).sessionId, null);
  assert.equal(mgr.open({ cols: 1.5, rows: 24 }).sessionId, null);
  assert.equal(mgr.open({ cols: 80, rows: Infinity }).sessionId, null);
  assert.equal(mgr.open({ cols: 0, rows: 24 }).sessionId, null);
  assert.equal(spawned.length, 0);
  mgr.disposeAll();
});

test('TERM-SINGLE: a second open kills the first session', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const first = mgr.open({ cols: 80, rows: 24 });
  const second = mgr.open({ cols: 80, rows: 24 });
  assert.equal(ptys[0].killed, true);
  assert.equal(ptys[1].killed, false);
  assert.equal(typeof second.sessionId, 'string');
  assert.notEqual(second.sessionId, first.sessionId);
  // The first (killed) session's id is stale: input routes nowhere.
  mgr.input({ sessionId: first.sessionId, data: 'x' });
  assert.equal(ptys[1].written.length, 0);
  mgr.disposeAll();
});

test('TERM-INPUT-VALIDATE: wrong types, oversized input (>64KiB), and stale session ids are silent no-ops', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const { sessionId } = mgr.open({ cols: 80, rows: 24 });
  const fakePty = ptys[0];

  mgr.input({ sessionId: 'stale', data: 'x' });                          // stale id
  mgr.input({ sessionId, data: 'x'.repeat(64 * 1024 + 1) });             // > 64KiB cap
  mgr.input(42);                                                          // not an object
  mgr.input(null);
  mgr.input({ sessionId, data: 7 });                                      // non-string data
  mgr.input({ data: 'x' });                                               // missing id
  assert.equal(fakePty.written.length, 0);

  // Valid input passes — including EXACTLY 64KiB (the cap is exclusive-over).
  mgr.input({ sessionId, data: 'ls\n' });
  mgr.input({ sessionId, data: 'y'.repeat(64 * 1024) });
  assert.equal(fakePty.written.length, 2);
  assert.equal(fakePty.written[0], 'ls\n');
  mgr.disposeAll();
});

test('TERM-INPUT-VALIDATE: the cap is measured in BYTES (Buffer.byteLength), not chars', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const { sessionId } = mgr.open({ cols: 80, rows: 24 });
  // 22000 chars × 3 bytes (U+20AC) = 66000 bytes > 65536 — must be rejected.
  mgr.input({ sessionId, data: '€'.repeat(22000) });
  assert.equal(ptys[0].written.length, 0);
  mgr.disposeAll();
});

test('TERM-RESIZE-VALIDATE: non-integer / out-of-range cols-rows rejected', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const { sessionId } = mgr.open({ cols: 80, rows: 24 });
  const fakePty = ptys[0];

  mgr.resize({ sessionId, cols: 1.5, rows: 24 });        // non-integer
  mgr.resize({ sessionId, cols: 80, rows: NaN });        // NaN
  mgr.resize({ sessionId, cols: Infinity, rows: 24 });   // non-finite
  mgr.resize({ sessionId, cols: '80', rows: 24 });       // wrong type
  mgr.resize({ sessionId, cols: 1, rows: 24 });          // < TERMINAL_MIN_COLS (2)
  mgr.resize({ sessionId, cols: 1001, rows: 24 });       // > TERMINAL_MAX_COLS
  mgr.resize({ sessionId, cols: 80, rows: 0 });          // < TERMINAL_MIN_ROWS (1)
  mgr.resize({ sessionId, cols: 80, rows: 1001 });       // > TERMINAL_MAX_ROWS
  mgr.resize({ sessionId: 'stale', cols: 80, rows: 24 });// stale id
  mgr.resize(42);                                        // not an object
  assert.equal(fakePty.resizes.length, 0);

  mgr.resize({ sessionId, cols: 100, rows: 40 });        // valid
  assert.deepEqual(fakePty.resizes, [[100, 40]]);
  mgr.disposeAll();
});

test('TERM-DATA: pty output is forwarded to the attached sink, coalesced', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const sink = [];
  mgr.attachSink((channel, payload) => sink.push([channel, payload]));
  const { sessionId } = mgr.open({ cols: 80, rows: 24 });

  ptys[0].emitData('a');
  ptys[0].emitData('b');
  assert.equal(sink.length, 0); // not synchronous — coalesced by the pump
  await settle();
  assert.equal(sink.length, 1); // ONE flush for both chunks
  assert.deepEqual(sink[0], ['loom:terminal:data', { sessionId, data: 'ab' }]);
  mgr.disposeAll();
});

test('TERM-FLOWCAP: buffered output beyond the cap drops oldest', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  // NO sink attached yet — output must buffer, bounded at OUTPUT_BUFFER_CAP.
  const { sessionId } = mgr.open({ cols: 80, rows: 24 });
  const CAP = k.OUTPUT_BUFFER_CAP;
  assert.equal(CAP, 256 * 1024);

  ptys[0].emitData('A'.repeat(1000)); // the oldest chunk — must be dropped
  const chunk = 'B'.repeat(1024);
  for (let i = 0; i < Math.ceil(CAP / chunk.length) + 8; i++) ptys[0].emitData(chunk);
  ptys[0].emitData('zzz-tail'); // the tail — must survive

  const sink = [];
  mgr.attachSink((channel, payload) => sink.push([channel, payload]));
  await settle();

  const forwarded = sink
    .filter(([ch]) => ch === 'loom:terminal:data')
    .map(([, p]) => p.data)
    .join('');
  assert.ok(forwarded.length > 0, 'buffered output flushes once a sink attaches');
  assert.ok(
    Buffer.byteLength(forwarded) <= CAP,
    `total forwarded (${forwarded.length}) must be <= OUTPUT_BUFFER_CAP (${CAP})`,
  );
  assert.ok(!forwarded.includes('A'), 'oldest chunk dropped');
  assert.ok(forwarded.endsWith('zzz-tail'), 'tail preserved');
  assert.equal(sink[0][1].sessionId, sessionId);
  mgr.disposeAll();
});

test('TERM-EXIT: pty exit pushes loom:terminal:exit and invalidates the session', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const sink = [];
  mgr.attachSink((channel, payload) => sink.push([channel, payload]));
  const { sessionId } = mgr.open({ cols: 80, rows: 24 });

  ptys[0].emitExit({ exitCode: 7 });
  const exits = sink.filter(([ch]) => ch === 'loom:terminal:exit');
  assert.equal(exits.length, 1);
  assert.deepEqual(exits[0][1], { sessionId, exitCode: 7 });

  // Input/resize after exit are silent no-ops (the session id is invalid).
  mgr.input({ sessionId, data: 'x' });
  mgr.resize({ sessionId, cols: 100, rows: 40 });
  assert.equal(ptys[0].written.length, 0);
  assert.equal(ptys[0].resizes.length, 0);
  mgr.disposeAll();
});

test('TERM-EXIT: pending output is flushed before the exit push (no lost tail)', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const sink = [];
  mgr.attachSink((channel, payload) => sink.push([channel, payload]));
  const { sessionId } = mgr.open({ cols: 80, rows: 24 });

  ptys[0].emitData('bye');
  ptys[0].emitExit({ exitCode: 0 });
  assert.deepEqual(sink[0], ['loom:terminal:data', { sessionId, data: 'bye' }]);
  assert.deepEqual(sink[1], ['loom:terminal:exit', { sessionId, exitCode: 0 }]);
  mgr.disposeAll();
});

test('TERM-CLOSE/DISPOSE: close(id) and disposeAll() call pty.kill()', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);

  // close(id) kills; a stale id does NOT.
  const { sessionId } = mgr.open({ cols: 80, rows: 24 });
  mgr.close({ sessionId: 'stale' });
  assert.equal(ptys[0].killed, false);
  mgr.close({ sessionId });
  assert.equal(ptys[0].killed, true);

  // close invalidates: input after close is a no-op.
  mgr.input({ sessionId, data: 'x' });
  assert.equal(ptys[0].written.length, 0);

  // disposeAll() kills the live session (kill-on-window-close).
  mgr.open({ cols: 80, rows: 24 });
  mgr.disposeAll();
  assert.equal(ptys[1].killed, true);
});

test('TERM-CLOSE/DISPOSE: detaching the sink stops pushes', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const sink = [];
  const detach = mgr.attachSink((channel, payload) => sink.push([channel, payload]));
  mgr.open({ cols: 80, rows: 24 });
  detach();
  ptys[0].emitData('after-detach');
  await settle();
  assert.equal(sink.length, 0);
  mgr.disposeAll();
});

test('TERM-SHELL: defaultShell honors $SHELL, falls back to bash; powershell.exe on win32', async () => {
  const k = await kit();
  assert.equal(k.defaultShell('linux', { SHELL: '/bin/zsh' }), '/bin/zsh');
  assert.equal(k.defaultShell('linux', {}), 'bash');
  assert.equal(k.defaultShell('linux', { SHELL: '' }), 'bash');
  assert.equal(k.defaultShell('darwin', { SHELL: '/bin/fish' }), '/bin/fish');
  assert.equal(k.defaultShell('darwin', {}), 'bash');
  assert.equal(k.defaultShell('win32', { SHELL: '/bin/zsh' }), 'powershell.exe');
  assert.equal(k.defaultShell('win32', {}), 'powershell.exe');
});
