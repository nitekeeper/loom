/* ============================================================
 * Loom — terminal session manager unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE main-process terminal session manager (src/main/terminal.ts)
 * behind the loom:terminal:* IPC channels, with an INJECTED fake PTY factory
 * (no node-pty, no Electron). This is the MULTI-SESSION manager: up to
 * MAX_TERMINALS concurrent sessionId-keyed PTY sessions, each owning its OWN
 * coalescing output pump.
 *
 * Coverage:
 *   - open: spawn-in-root, payload re-validation (types / cols-rows range),
 *     throwing-factory degradation, MULTIPLE live sessions (no kill-previous),
 *     and the at-capacity { sessionId: null } sentinel (spawns/kills nothing);
 *   - input: type / 64KiB byte-cap / stale-id validation, PER-SESSION routing;
 *   - resize: range validation, PER-SESSION routing;
 *   - per-session PUMP isolation: a chunk on session A NEVER appears in
 *     session B's TERMINAL_DATA push, and OUTPUT_BUFFER_CAP drop-oldest
 *     accounting is PER SESSION (the R1 regression guard);
 *   - exit invalidates ONLY that session (others stay live);
 *   - close kills ONLY the matching session; disposeAll() reaps EVERY session;
 *   - the coalesced pump, drop-oldest flow cap, multibyte truncation, and the
 *     defaultShell selection.
 *
 * DOM-free: exercises createTerminalManager (+ the re-exported terminal-columns
 * and keybindings surfaces) from the testkit bundle.
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

/** Let each session's 8ms coalescing flush timer fire (real, unref'd timer). */
const settle = () => new Promise((r) => setTimeout(r, 50));

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

/** Collect the TERMINAL_DATA pushes addressed to one sessionId. */
function dataFor(sink, sessionId) {
  return sink
    .filter(([ch, p]) => ch === 'loom:terminal:data' && p.sessionId === sessionId)
    .map(([, p]) => p.data)
    .join('');
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

test('TERM-MULTI: 3 opens yield 3 live, DISTINCT sessions — none killed by a later open', async () => {
  const k = await kit();
  const { factory, spawned, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);

  const a = mgr.open({ cols: 80, rows: 24 });
  const b = mgr.open({ cols: 100, rows: 30 });
  const c = mgr.open({ cols: 120, rows: 40 });

  // Three real spawns, three distinct ptys, three distinct string tokens.
  assert.equal(spawned.length, 3);
  assert.equal(ptys.length, 3);
  for (const r of [a, b, c]) assert.equal(typeof r.sessionId, 'string');
  const ids = new Set([a.sessionId, b.sessionId, c.sessionId]);
  assert.equal(ids.size, 3, 'every open returns a fresh, distinct token');

  // A later open NEVER kills an earlier session (the old single-session
  // kill-previous behavior is gone).
  assert.equal(ptys[0].killed, false);
  assert.equal(ptys[1].killed, false);
  assert.equal(ptys[2].killed, false);

  // All three are LIVE: input routes to each pty independently.
  mgr.input({ sessionId: a.sessionId, data: 'a' });
  mgr.input({ sessionId: b.sessionId, data: 'b' });
  mgr.input({ sessionId: c.sessionId, data: 'c' });
  assert.deepEqual(ptys[0].written, ['a']);
  assert.deepEqual(ptys[1].written, ['b']);
  assert.deepEqual(ptys[2].written, ['c']);
  mgr.disposeAll();
});

test('TERM-MULTI: a 4th open at MAX_TERMINALS is REJECTED — spawns nothing, kills nothing', async () => {
  const k = await kit();
  const { factory, spawned, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  assert.equal(k.MAX_TERMINALS, 3);

  const live = [];
  for (let i = 0; i < k.MAX_TERMINALS; i++) live.push(mgr.open({ cols: 80, rows: 24 }));
  assert.equal(spawned.length, k.MAX_TERMINALS);

  // The (MAX+1)th open: graceful sentinel, no spawn, no kill of any live one.
  const overflow = mgr.open({ cols: 80, rows: 24 });
  assert.equal(overflow.sessionId, null, 'at-capacity open returns { sessionId: null }');
  assert.equal(spawned.length, k.MAX_TERMINALS, 'no additional spawn');
  assert.equal(ptys.length, k.MAX_TERMINALS, 'no additional pty created');
  for (const pty of ptys) assert.equal(pty.killed, false, 'no live session killed by the rejected open');

  // Every prior session is STILL live (input still routes).
  for (let i = 0; i < live.length; i++) {
    mgr.input({ sessionId: live[i].sessionId, data: `x${i}` });
    assert.deepEqual(ptys[i].written, [`x${i}`], `session ${i} survived the rejected open`);
  }

  // Closing one frees a slot — the NEXT open succeeds (capacity is a live count,
  // not a high-water mark).
  mgr.close({ sessionId: live[0].sessionId });
  assert.equal(ptys[0].killed, true);
  const reopened = mgr.open({ cols: 80, rows: 24 });
  assert.equal(typeof reopened.sessionId, 'string', 'a freed slot accepts a new open');
  assert.equal(spawned.length, k.MAX_TERMINALS + 1);
  mgr.disposeAll();
});

test('TERM-ROUTE: input/resize/close addressed by one sessionId affect ONLY that session', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const a = mgr.open({ cols: 80, rows: 24 });
  const b = mgr.open({ cols: 80, rows: 24 });
  const c = mgr.open({ cols: 80, rows: 24 });
  const [pa, pb, pc] = ptys;

  // input -> only A's pty.
  mgr.input({ sessionId: a.sessionId, data: 'only-a' });
  assert.deepEqual(pa.written, ['only-a']);
  assert.equal(pb.written.length, 0);
  assert.equal(pc.written.length, 0);

  // resize -> only B's pty.
  mgr.resize({ sessionId: b.sessionId, cols: 100, rows: 40 });
  assert.deepEqual(pb.resizes, [[100, 40]]);
  assert.equal(pa.resizes.length, 0);
  assert.equal(pc.resizes.length, 0);

  // close -> only C's pty is killed; A and B stay live + routable.
  mgr.close({ sessionId: c.sessionId });
  assert.equal(pc.killed, true);
  assert.equal(pa.killed, false);
  assert.equal(pb.killed, false);
  mgr.input({ sessionId: a.sessionId, data: 'still-a' });
  mgr.input({ sessionId: b.sessionId, data: 'still-b' });
  assert.deepEqual(pa.written, ['only-a', 'still-a']);
  assert.deepEqual(pb.written, ['still-b']);
  // The closed session's id is now stale: input routes nowhere.
  mgr.input({ sessionId: c.sessionId, data: 'x' });
  assert.equal(pc.written.length, 0);
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

test('TERM-PUMP-ISOLATE: a chunk on session A never appears in session B\'s push', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const sink = [];
  mgr.attachSink((channel, payload) => sink.push([channel, payload]));
  const a = mgr.open({ cols: 80, rows: 24 });
  const b = mgr.open({ cols: 80, rows: 24 });
  const c = mgr.open({ cols: 80, rows: 24 });
  const [pa, pb, pc] = ptys;

  // Interleave output across the three sessions within one pump window.
  pa.emitData('A1'); pb.emitData('B1'); pa.emitData('A2');
  pc.emitData('C1'); pb.emitData('B2');
  await settle();

  // Each session's push carries ONLY its own coalesced output — no cross-talk.
  assert.equal(dataFor(sink, a.sessionId), 'A1A2');
  assert.equal(dataFor(sink, b.sessionId), 'B1B2');
  assert.equal(dataFor(sink, c.sessionId), 'C1');

  // Every TERMINAL_DATA push is addressed to exactly one of the three ids, and
  // no push body leaks another session's marker.
  const pushes = sink.filter(([ch]) => ch === 'loom:terminal:data');
  for (const [, p] of pushes) {
    assert.ok([a.sessionId, b.sessionId, c.sessionId].includes(p.sessionId));
    if (p.sessionId === a.sessionId) assert.ok(!/[BC]/.test(p.data), 'A push has no B/C output');
    if (p.sessionId === b.sessionId) assert.ok(!/[AC]/.test(p.data), 'B push has no A/C output');
    if (p.sessionId === c.sessionId) assert.ok(!/[AB]/.test(p.data), 'C push has no A/B output');
  }
  mgr.disposeAll();
});

test('TERM-FLOWCAP-ISOLATE: OUTPUT_BUFFER_CAP drop-oldest accounting is PER SESSION (R1 guard)', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  // NO sink yet — output buffers per-entry, each bounded at OUTPUT_BUFFER_CAP.
  const a = mgr.open({ cols: 80, rows: 24 });
  const b = mgr.open({ cols: 80, rows: 24 });
  const [pa, pb] = ptys;
  const CAP = k.OUTPUT_BUFFER_CAP;
  assert.equal(CAP, 256 * 1024);

  // Session A floods PAST its own cap (drop-oldest must trim A only).
  pa.emitData('A'.repeat(1000)); // A's oldest — must be dropped
  const chunk = 'B'.repeat(1024);
  for (let i = 0; i < Math.ceil(CAP / chunk.length) + 8; i++) pa.emitData(chunk);
  pa.emitData('a-tail'); // A's tail — must survive

  // Session B stays well UNDER its cap; a shared/global pump (the R1 bug) would
  // let A's flood evict B's tiny buffer. Per-session accounting protects B.
  pb.emitData('b-small');

  const sink = [];
  mgr.attachSink((channel, payload) => sink.push([channel, payload]));
  await settle();

  const aData = dataFor(sink, a.sessionId);
  const bData = dataFor(sink, b.sessionId);

  // A: bounded at its OWN cap, oldest dropped, tail preserved.
  assert.ok(Buffer.byteLength(aData) <= CAP, `A forwarded (${aData.length}) <= CAP (${CAP})`);
  assert.ok(!aData.includes('A'), "A's oldest chunk dropped");
  assert.ok(aData.endsWith('a-tail'), "A's tail preserved");

  // B: untouched by A's flood — its small buffer survives in full.
  assert.equal(bData, 'b-small', "B's buffer is NOT evicted by A's flood (per-session cap)");
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

test('TERM-FLOWCAP: a single over-cap MULTIBYTE chunk is truncated to strictly <= CAP', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  mgr.open({ cols: 80, rows: 24 });
  const CAP = k.OUTPUT_BUFFER_CAP;

  // CAP is not divisible by 3, so the byte-wise tail slice splits a '€' at the
  // head and U+FFFD replacement would inflate past CAP without the strict trim.
  ptys[0].emitData('€'.repeat(CAP) + 'zzz-tail');

  const sink = [];
  mgr.attachSink((channel, payload) => sink.push([channel, payload]));
  await settle();

  const forwarded = sink
    .filter(([ch]) => ch === 'loom:terminal:data')
    .map(([, p]) => p.data)
    .join('');
  assert.ok(
    Buffer.byteLength(forwarded) <= CAP,
    `forwarded bytes (${Buffer.byteLength(forwarded)}) must be strictly <= CAP (${CAP})`,
  );
  assert.ok(forwarded.endsWith('zzz-tail'), 'tail preserved');
  mgr.disposeAll();
});

test('TERM-EXIT: pty exit pushes loom:terminal:exit and invalidates ONLY that session', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const sink = [];
  mgr.attachSink((channel, payload) => sink.push([channel, payload]));
  const a = mgr.open({ cols: 80, rows: 24 });
  const b = mgr.open({ cols: 80, rows: 24 });
  const [pa, pb] = ptys;

  pa.emitExit({ exitCode: 7 });
  const exits = sink.filter(([ch]) => ch === 'loom:terminal:exit');
  assert.equal(exits.length, 1);
  assert.deepEqual(exits[0][1], { sessionId: a.sessionId, exitCode: 7 });

  // Input/resize on the EXITED session are silent no-ops (its id is invalid).
  mgr.input({ sessionId: a.sessionId, data: 'x' });
  mgr.resize({ sessionId: a.sessionId, cols: 100, rows: 40 });
  assert.equal(pa.written.length, 0);
  assert.equal(pa.resizes.length, 0);

  // Session B is UNAFFECTED — still live, still routable.
  assert.equal(pb.killed, false);
  mgr.input({ sessionId: b.sessionId, data: 'b-lives' });
  mgr.resize({ sessionId: b.sessionId, cols: 120, rows: 50 });
  assert.deepEqual(pb.written, ['b-lives']);
  assert.deepEqual(pb.resizes, [[120, 50]]);
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

test('TERM-DISPOSE: disposeAll() kills + forgets EVERY live session', async () => {
  const k = await kit();
  const { factory, ptys } = makeFakeFactory();
  const mgr = makeManager(k, factory);
  const a = mgr.open({ cols: 80, rows: 24 });
  const b = mgr.open({ cols: 80, rows: 24 });
  const c = mgr.open({ cols: 80, rows: 24 });

  mgr.disposeAll();

  // EVERY pty is killed.
  for (const pty of ptys) assert.equal(pty.killed, true);

  // EVERY session is forgotten — input/resize/close on each are now no-ops.
  for (const r of [a, b, c]) {
    mgr.input({ sessionId: r.sessionId, data: 'x' });
    mgr.resize({ sessionId: r.sessionId, cols: 100, rows: 40 });
  }
  for (const pty of ptys) {
    assert.equal(pty.written.length, 0, 'no input routes after disposeAll');
    assert.equal(pty.resizes.length, 0, 'no resize routes after disposeAll');
  }

  // The dock is empty: a fresh open works (and lands as the first new pty).
  const reopened = mgr.open({ cols: 80, rows: 24 });
  assert.equal(typeof reopened.sessionId, 'string');
  assert.equal(ptys.length, 4);
  mgr.disposeAll();
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

test('TERM-SURFACE: the re-exported manager + columns + keybindings surfaces are importable', async () => {
  const k = await kit();
  // Manager surface (this suite's primary subject).
  for (const name of ['createTerminalManager', 'MAX_TERMINALS', 'OUTPUT_BUFFER_CAP', 'defaultShell']) {
    assert.notEqual(k[name], undefined, `manager export ${name} is present`);
  }
  assert.equal(k.MAX_TERMINALS, 3);
  assert.equal(k.OUTPUT_BUFFER_CAP, 256 * 1024);

  // Pure multi-terminal COLUMN geometry surface (no prior unit pin — guard the
  // re-export contract so a build/bundle break is caught here).
  const columnFns = [
    'clampTerminalColumns',
    'terminalColumnsTemplate',
    'terminalColumnsMinWidth',
    'clampColumnRatios',
    'coerceStoredColumns',
    'coerceStoredColumnRatios',
    'clampActiveTerminalIndex',
    'cycleTerminalIndex',
  ];
  for (const name of columnFns) assert.equal(typeof k[name], 'function', `${name} is a fn`);
  for (const name of [
    'TERMINAL_COUNT_DEFAULT',
    'TERMINAL_PANE_MIN',
    'TERMINAL_DIVIDER_W',
    'TERMINAL_COLUMNS_RATIOS_KEY',
  ]) {
    assert.notEqual(k[name], undefined, `column constant ${name} is present`);
  }

  // Keybindings surface the terminal pane depends on (also pinned in detail by
  // terminal-pane.mjs — here we only guard importability of the named exports).
  for (const name of ['COMMANDS', 'resolveBindings', 'DEFAULT_BINDINGS', 'findConflict', 'isValidBinding', 'RESERVED_COMBOS']) {
    assert.notEqual(k[name], undefined, `keybindings export ${name} is present`);
  }
  assert.ok(Array.isArray(k.COMMANDS), 'COMMANDS is the command registry array');
});
