/* ============================================================
 * Loom — MCP-server concurrency test (node --test)
 * ------------------------------------------------------------
 * The question this answers: can the REAL Loom MCP HTTP server
 * handle 10-20 external agents chatting CONCURRENTLY through it,
 * without crashing, leaking, stalling, or corrupting state?
 *
 * Unlike acceptance.mjs/concurrency.mjs (which drive the pure
 * engine directly), this boots the actual createMcpServer over its
 * Streamable-HTTP transport and connects N independent MCP SDK
 * clients — the same client pattern tools/loom-team.mjs uses — then
 * has all N hammer it at once (register, join, @here broadcast,
 * check_inbox, read_messages, mark_read). It asserts:
 *   1. CORRECTNESS — exact message + receipt counts via direct db
 *      inspection (the server + db live in this process), no rows
 *      lost or duplicated across concurrent HTTP sessions.
 *   2. LIVENESS — the whole storm completes within a generous bound
 *      and the server still answers afterwards (list_channels shows
 *      all N members).
 *   3. NO LEAK — every session is torn down on client close.
 *
 * DEPENDENCY: dist/testkit.cjs must re-export createDb, createEngine,
 * createEventBus, createMcpServer (run `npm run build`). The SDK
 * client transport comes from @modelcontextprotocol/sdk (a dep).
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

/** Parse a CallToolResult the way real consumers do: structuredContent for
 *  plain objects, else the JSON in the first text block (arrays/primitives). */
function payload(result) {
  if (result && result.structuredContent !== undefined) return result.structuredContent;
  const text = result && result.content && result.content[0] && result.content[0].text;
  return text === undefined ? undefined : JSON.parse(text);
}

const scalar = (db, sql) => {
  const out = db.exec(sql);
  return out.length === 0 ? 0 : Number(out[0].values[0][0]);
};

test('MCP-CONCURRENCY: 20 agents register/join/broadcast/poll concurrently over the real HTTP server', { timeout: 120000 }, async () => {
  const mod = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-mcp-'));
  const db = mod.createDb();
  await db.init(dir);
  const bus = mod.createEventBus();
  const engine = mod.createEngine(db, bus);
  const server = mod.createMcpServer(engine);
  await server.start();
  const url = `http://${mod.MCP_HOST}:${server.port}${mod.MCP_PATH}`;

  const sessions = [];
  const N = 20; // concurrent agents
  const M = 10; // broadcast rounds per agent -> N*M total messages
  try {
    const names = Array.from({ length: N }, (_, i) => `agent-${i}`);

    // 1. Connect + register all N concurrently (20 simultaneous initialize +
    //    register round-trips against the real transport).
    await Promise.all(
      names.map(async (name) => {
        const client = new Client({ name: `c-${name}`, version: '1.0.0' }, { capabilities: {} });
        const transport = new StreamableHTTPClientTransport(new URL(url));
        await client.connect(transport);
        sessions.push({ client, transport, name });
        const reg = payload(await client.callTool({ name: 'register', arguments: { name } }));
        assert.equal(reg.ok, true, `register failed for ${name}`);
        assert.equal(reg.name, name, `unique names must not be suffixed; got ${reg.name}`);
      }),
    );
    assert.equal(sessions.length, N, 'all clients connected + registered');

    // 2. One agent creates the room; the rest join concurrently.
    const lead = sessions[0];
    await lead.client.callTool({ name: 'create_channel', arguments: { name: 'room' } });
    await Promise.all(
      sessions.slice(1).map(({ client }) =>
        client.callTool({ name: 'join_channel', arguments: { channel: 'room' } }),
      ),
    );

    // 3. The storm: all N clients concurrently run M rounds of
    //    @here-broadcast -> check_inbox -> read_messages -> mark_read. Up to N
    //    tool calls are in flight against the server at any instant.
    const t0 = Date.now();
    await Promise.all(
      sessions.map(async ({ client, name }) => {
        for (let r = 0; r < M; r += 1) {
          await client.callTool({
            name: 'send_message',
            arguments: { channel: 'room', to: '@here', body: `r${r} from ${name}` },
          });
          await client.callTool({ name: 'check_inbox', arguments: {} });
          const unread = payload(await client.callTool({ name: 'read_messages', arguments: { channel: 'room' } }));
          if (Array.isArray(unread) && unread.length > 0) {
            await client.callTool({
              name: 'mark_read',
              arguments: { message_ids: unread.slice(0, 5).map((u) => u.message_id) },
            });
          }
        }
      }),
    );
    const elapsed = Date.now() - t0;

    // --- CORRECTNESS (direct db inspection: server + db share this process) ---
    const totalMessages = db.listMessages().length;
    assert.equal(totalMessages, N * M, `expected ${N * M} messages over the wire, got ${totalMessages}`);

    const totalReceipts = scalar(db, 'SELECT COUNT(*) AS c FROM receipts');
    assert.equal(
      totalReceipts,
      N * M * (N - 1),
      `each @here must write N-1 receipts with none lost/duplicated across concurrent HTTP sessions; ` +
        `expected ${N * M * (N - 1)}, got ${totalReceipts}`,
    );
    const read = scalar(db, 'SELECT COUNT(*) AS c FROM receipts WHERE read_at IS NOT NULL');
    const unread = scalar(db, 'SELECT COUNT(*) AS c FROM receipts WHERE read_at IS NULL');
    assert.equal(read + unread, totalReceipts, 'read + unread receipts must equal total (no corruption)');

    // --- LIVENESS: the server still answers, and shows all N members ---
    const channels = payload(await lead.client.callTool({ name: 'list_channels', arguments: {} }));
    const room = channels.find((c) => c.name === 'room');
    assert.ok(room, 'room must still be listed after the storm');
    assert.equal(room.members.length, N, `room must have all ${N} members; got ${room.members.length}`);
    assert.ok(elapsed < 90000, `the concurrent storm must stay live; took ${elapsed}ms`);
  } finally {
    // --- NO LEAK: tear every session down; the server's session Map must drain ---
    for (const { client, transport } of sessions) {
      try { await client.close(); } catch { /* ignore */ }
      try { await transport.close(); } catch { /* ignore */ }
    }
    try { await server.stop(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
