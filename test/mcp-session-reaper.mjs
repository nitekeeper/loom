/* ============================================================
 * Loom — MCP session-reaper + ceiling suite (node --test)
 * ------------------------------------------------------------
 * Real agents exit their process — they never send DELETE /mcp —
 * so the SDK's transport.onclose never fires and a session would
 * leak in the server's Map forever (audit S1). This proves the
 * idle reaper evicts such sessions (closing transport + server),
 * that a still-active session survives, and that the M3 ceiling
 * rejects new sessions past the configured max.
 *
 * The reaper tests use the DEFAULT (5-min) idle TTL so the
 * background sweep can't race the assertions; eviction is forced
 * deterministically via the exposed reapIdleSessions(idleSince).
 *
 * DEPENDENCY: dist/testkit.cjs re-exports createDb/createEngine/
 * createEventBus/createMcpServer (+ MCP_HOST/MCP_PATH). SDK client
 * transport from @modelcontextprotocol/sdk.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

async function boot(opts) {
  const mod = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-reap-'));
  const db = mod.createDb();
  await db.init(dir);
  const bus = mod.createEventBus();
  const engine = mod.createEngine(db, bus);
  const server = mod.createMcpServer(engine, { startPort: 0, ...opts }); // ephemeral port: no cross-test contention
  await server.start();
  const url = `http://${mod.MCP_HOST}:${server.port}${mod.MCP_PATH}`;
  const teardown = async () => {
    try { await server.stop(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { server, url, teardown };
}

async function connect(url, name) {
  const client = new Client({ name: `c-${name}`, version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport };
}
async function shut(c) {
  try { await c?.client.close(); } catch { /* ignore */ }
  try { await c?.transport.close(); } catch { /* ignore */ }
}

test('MCP-REAPER (S1): an idle session (agent exited without DELETE) is reaped', { timeout: 30000 }, async () => {
  const { server, url, teardown } = await boot({}); // default 5-min TTL: bg sweep won't fire mid-test
  let c;
  try {
    c = await connect(url, 'ghost');
    await c.client.callTool({ name: 'register', arguments: { name: 'ghost' } });
    assert.equal(server.sessionCount(), 1, 'one live session after register');

    // The agent vanishes WITHOUT a clean close (no DELETE). Force the reap
    // deterministically — cutoff in the future, so the session's lastSeen is
    // <= cutoff and it's evicted, exactly as the idle timer would after the TTL.
    const reaped = await server.reapIdleSessions(Date.now() + 1000);
    assert.equal(reaped, 1, 'the idle session must be reaped (transport+server closed, map drained)');
    assert.equal(server.sessionCount(), 0, 'session map drained after reap');
  } finally {
    await shut(c);
    await teardown();
  }
});

test('MCP-REAPER: a freshly-seen (active) session is NOT reaped', { timeout: 30000 }, async () => {
  const { server, url, teardown } = await boot({});
  let c;
  try {
    c = await connect(url, 'busy');
    await c.client.callTool({ name: 'register', arguments: { name: 'busy' } });
    assert.equal(server.sessionCount(), 1);
    // Reap only sessions idle since BEFORE this one existed -> none.
    const reaped = await server.reapIdleSessions(Date.now() - 60_000);
    assert.equal(reaped, 0, 'a freshly-seen session must survive the reaper');
    assert.equal(server.sessionCount(), 1);
  } finally {
    await shut(c);
    await teardown();
  }
});

test('MCP-CEILING (M3): a new session past maxSessions is rejected', { timeout: 30000 }, async () => {
  const { server, url, teardown } = await boot({ maxSessions: 2 });
  const conns = [];
  try {
    conns.push(await connect(url, 's0'));
    conns.push(await connect(url, 's1'));
    assert.equal(server.sessionCount(), 2, 'two sessions fill the ceiling');

    // The 3rd initialize must be rejected (503) -> the SDK connect rejects.
    let rejected = false;
    try {
      conns.push(await connect(url, 's2'));
    } catch {
      rejected = true;
    }
    assert.ok(rejected, 'connecting past maxSessions must fail');
    assert.equal(server.sessionCount(), 2, 'no session created past the ceiling');
  } finally {
    for (const c of conns) await shut(c);
    await teardown();
  }
});
