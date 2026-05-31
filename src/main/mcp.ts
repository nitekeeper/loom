/* ============================================================
 * Loom — MCP server (thin wrapper over engine.ts)
 * ------------------------------------------------------------
 * Exposes the 9 tools over the @modelcontextprotocol/sdk
 * Streamable-HTTP transport, bound to 127.0.0.1:7077 (NFR-9,
 * OQ-4: localhost binding is the documented mitigation; no auth
 * beyond register()). Each transport SESSION binds a Caller (the
 * registered agent name) and forwards tool calls to the engine,
 * mapping LoomError -> an MCP tool error carrying the code.
 *
 * Client URL (used by the demo driver + acceptance tests via the
 * SDK Client + StreamableHTTPClientTransport):
 *
 *     http://127.0.0.1:7077/mcp
 *
 *   - POST   /mcp  -> JSON-RPC tool calls (and the initialize handshake)
 *   - GET    /mcp  -> the SSE stream for server-initiated messages
 *   - DELETE /mcp  -> end the session
 *
 * NFR-9: this is the AGENT transport. It is SEPARATE from the
 * observer live feed (IPC + optional ws) in eventbus/ws (NFR-10).
 *
 * Session model: one McpServer + one StreamableHTTPServerTransport
 * per client session (keyed by the `mcp-session-id` header the
 * transport assigns on initialize). A per-session Caller object is
 * threaded into every tool handler; register() mutates it so all
 * subsequent calls on that session act as the assigned name.
 * ============================================================ */
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  HERE_TOKEN,
  LoomError,
  MAX_BODY_LENGTH,
  type Caller,
  type LoomEngine,
} from '../shared/types.js';

export interface McpServerHandle {
  /** Begin listening on 127.0.0.1:7077. */
  start(): Promise<void>;
  /** Stop the server and close transports. */
  stop(): Promise<void>;
  /** The TCP port the agent transport listens on (NFR-9, OQ-4). */
  readonly port: number;
}

export const MCP_HOST = '127.0.0.1';
export const MCP_PORT = 7077;
export const MCP_PATH = '/mcp';

/** Host headers the agent transport accepts (SEC-1, NFR-9, OQ-4).
 *  DNS-rebinding protection: a browser tricked into resolving an
 *  attacker domain to 127.0.0.1 still sends the attacker's Host header,
 *  which is NOT in this allow-list -> 403. Legitimate loopback clients
 *  (the SDK Node client, the demo driver) send 127.0.0.1:7077. */
export const ALLOWED_HOSTS: readonly string[] = [
  `127.0.0.1:${MCP_PORT}`,
  `localhost:${MCP_PORT}`,
];

/** Origins the agent transport accepts (SEC-1). The SDK only validates an
 *  Origin when it is PRESENT; a non-browser loopback client (Node SDK
 *  client / demo driver) sends NO Origin and therefore passes. A browser
 *  cross-origin fetch() from a web page the user is visiting sends that
 *  page's Origin, which is not loopback -> 403, blocking the CSRF vector
 *  (any page POSTing to http://127.0.0.1:7077/mcp to register()/read the
 *  agents' private chat). */
export const ALLOWED_ORIGINS: readonly string[] = [
  `http://127.0.0.1:${MCP_PORT}`,
  `http://localhost:${MCP_PORT}`,
];

/** Hard cap on a single MCP request body (SEC-3). Mirrors the explicit cap
 *  on the ws observer feed (ws.ts maxPayload). A multi-gigabyte body must
 *  not be buffered into the main process (the single source of truth,
 *  FR-14) — we destroy the request and return 413 once exceeded. */
export const MAX_REQUEST_BODY_BYTES = 1 << 20; // 1 MiB

/** Shape returned to the MCP client for every tool call. */
type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/** Per-session state: the live transport/server pair + its bound caller. */
interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  caller: Caller;
}

export function createMcpServer(engine: LoomEngine): McpServerHandle {
  const sessions = new Map<string, Session>();
  let http: HttpServer | undefined;

  /** Wrap an engine call: serialize the result as JSON text content, and
   *  map a LoomError to an MCP tool error carrying its code (OQ-4). */
  function ok(value: unknown): ToolResult {
    // MCP's CallToolResult requires structuredContent to be a RECORD (object),
    // not an array — the SDK client validates this and rejects arrays. Some
    // tools (read_messages, list_channels, check_inbox previews) return arrays,
    // so we only attach structuredContent for plain objects. Arrays/primitives
    // travel in the `content` text block as JSON (the frozen wire payload),
    // which every consumer (driver toolPayload, tests) already parses.
    const isPlainObject =
      value !== null && typeof value === 'object' && !Array.isArray(value);
    const result: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify(value) }],
    };
    if (isPlainObject) {
      result.structuredContent = value as Record<string, unknown>;
    }
    return result;
  }
  function fail(err: unknown): ToolResult {
    if (err instanceof LoomError) {
      return {
        content: [{ type: 'text', text: `${err.code}: ${err.message}` }],
        isError: true,
        structuredContent: { code: err.code, message: err.message },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `BAD_REQUEST: ${message}` }],
      isError: true,
      structuredContent: { code: 'BAD_REQUEST', message },
    };
  }
  function run(fn: () => unknown): ToolResult {
    try {
      return ok(fn());
    } catch (err) {
      return fail(err);
    }
  }

  /** Build a fresh McpServer with all 9 tools registered, bound to the
   *  given per-session Caller. The handlers close over `caller`, and
   *  register() mutates `caller.name` so the binding follows the session. */
  function buildServer(caller: Caller): McpServer {
    const server = new McpServer(
      { name: 'loom', version: '0.5.0' },
      { capabilities: { tools: {} } },
    );

    // 1. register(name) -> { ok, name, channels: [] } (FR-15)
    server.registerTool(
      'register',
      {
        description:
          'Register an explicit agent identity. Suffixes -2, -3 … on name collision; returns the assigned name.',
        inputSchema: { name: z.string().describe('Desired agent name (<=64 chars).') },
      },
      ({ name }) => run(() => engine.register(caller, { name })),
    );

    // 2. create_channel(name) -> { id, name } (FR-16, auto-joins caller)
    server.registerTool(
      'create_channel',
      {
        description: 'Create a channel and auto-join the calling agent.',
        inputSchema: { name: z.string().describe('Unique channel name.') },
      },
      ({ name }) => run(() => engine.create_channel(caller, { name })),
    );

    // 3. join_channel(channel) -> { channel, members } (FR-17)
    server.registerTool(
      'join_channel',
      {
        description: 'Join a channel; returns the channel and its current members.',
        inputSchema: { channel: z.string().describe('Channel name to join.') },
      },
      ({ channel }) => run(() => engine.join_channel(caller, { channel })),
    );

    // 4. list_channels() -> [{ id, name, members }] (FR-18)
    server.registerTool(
      'list_channels',
      {
        description: 'List all channels with id, name, and members.',
        inputSchema: {},
      },
      () => run(() => engine.list_channels(caller)),
    );

    // 5. deregister(name) -> { ok, name } (FR-19, sets status='gone')
    server.registerTool(
      'deregister',
      {
        description: "Mark an agent 'gone' (excluded from the active count; stays visible, dimmed).",
        inputSchema: { name: z.string().describe('Agent name to deregister.') },
      },
      ({ name }) => run(() => engine.deregister(caller, { name })),
    );

    // 6. send_message(channel, to, body) -> { message_id, recipients } (FR-21)
    server.registerTool(
      'send_message',
      {
        description:
          `Send a message in a channel. 'to' is a member name (direct) or the token "${HERE_TOKEN}" (broadcast to all members except the sender).`,
        inputSchema: {
          channel: z.string().describe('Channel to send in (sender must be a member).'),
          to: z.string().describe(`Recipient member name, or "${HERE_TOKEN}" to broadcast.`),
          body: z
            .string()
            .max(MAX_BODY_LENGTH)
            .describe(`Message body (max ${MAX_BODY_LENGTH} chars).`),
        },
      },
      ({ channel, to, body }) =>
        run(() => engine.send_message(caller, { channel, to, body })),
    );

    // 7. check_inbox() -> { unread, previews } — marks NOTHING read (FR-25)
    server.registerTool(
      'check_inbox',
      {
        description: 'Return the caller unread count + previews. Marks nothing read.',
        inputSchema: {},
      },
      () => run(() => engine.check_inbox(caller)),
    );

    // 8. read_messages(channel?) -> full unread bodies — marks NOTHING read (FR-26)
    server.registerTool(
      'read_messages',
      {
        description:
          'Return full bodies of the caller unread messages (optionally filtered by channel). Marks nothing read.',
        inputSchema: {
          channel: z.string().optional().describe('Optional channel-name filter.'),
        },
      },
      ({ channel }) => run(() => engine.read_messages(caller, { channel })),
    );

    // 9. mark_read(message_ids) -> { marked } (FR-27)
    server.registerTool(
      'mark_read',
      {
        description: "Set read_at for the caller's receipts on the given message ids.",
        inputSchema: {
          message_ids: z.array(z.number()).describe('Message ids to mark read.'),
        },
      },
      ({ message_ids }) => run(() => engine.mark_read(caller, { message_ids })),
    );

    return server;
  }

  /** Thrown by readBody when the accumulated request body exceeds the cap
   *  (SEC-3). handle() maps it to a 413 so a flood cannot exhaust memory. */
  class PayloadTooLarge extends Error {}

  /** Read the raw request body and JSON-parse it (POST only). Enforces a
   *  hard byte cap (SEC-3): once the accumulated body exceeds
   *  MAX_REQUEST_BODY_BYTES we stop reading, destroy the socket, and throw
   *  so an attacker streaming a huge body cannot exhaust main-process
   *  memory. A Content-Length that already declares an over-cap body is
   *  rejected up front before any bytes are buffered. */
  async function readBody(req: IncomingMessage): Promise<unknown> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
      // Stop reading immediately; the caller writes a 413 then ends the
      // response (which closes the connection). We pause rather than destroy
      // so the 413 status reaches the client before the socket is torn down.
      req.pause();
      throw new PayloadTooLarge();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        req.pause();
        throw new PayloadTooLarge();
      }
      chunks.push(buf);
    }
    if (chunks.length === 0) return undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  function sessionIdOf(req: IncomingMessage): string | undefined {
    const header = req.headers['mcp-session-id'];
    if (Array.isArray(header)) return header[0];
    return header;
  }

  /** Defense-in-depth (SEC-1): reject a request whose Host is not loopback,
   *  or whose Origin (when present) is not loopback, BEFORE any body is read
   *  or a transport is constructed. The SDK transport enforces the same
   *  policy internally for the session path; this guards the brand-new-session
   *  POST (whose body we read first) and any path the transport delegates.
   *  Returns true and writes a 403 when the request must be refused. */
  function rejectForbiddenOrigin(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    const hostHeader = req.headers['host'];
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (host === undefined || !ALLOWED_HOSTS.includes(host)) {
      res.writeHead(403).end('forbidden host');
      return true;
    }
    const originHeader = req.headers['origin'];
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    // Only validate Origin when present: non-browser loopback clients omit it.
    if (origin !== undefined && origin !== '' && !ALLOWED_ORIGINS.includes(origin)) {
      res.writeHead(403).end('forbidden origin');
      return true;
    }
    return false;
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = req.url ?? '';
    const path = url.split('?')[0];
    if (path !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }

    // SEC-1: pin Host/Origin at the http layer before reading any body.
    if (rejectForbiddenOrigin(req, res)) return;

    const sid = sessionIdOf(req);
    const existing = sid !== undefined ? sessions.get(sid) : undefined;

    if (existing !== undefined) {
      // Subsequent request on a known session (POST call, GET SSE, DELETE).
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'POST') {
      // No (or unknown) session id: treat as a new session's initialize.
      const body = await readBody(req);
      const caller: Caller = { name: null };
      const server = buildServer(caller);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // SEC-1: pin Host + Origin so a browser DNS-rebinding / cross-origin
        // CSRF cannot drive the agent transport. The SDK validates these only
        // when enableDnsRebindingProtection is true; binding to 127.0.0.1
        // alone does NOT stop a page already running on this machine.
        enableDnsRebindingProtection: true,
        allowedHosts: [...ALLOWED_HOSTS],
        allowedOrigins: [...ALLOWED_ORIGINS],
        onsessioninitialized: (newId: string) => {
          sessions.set(newId, { transport, server, caller });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id !== undefined) sessions.delete(id);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // GET/DELETE without a valid session id -> bad request.
    res.writeHead(400).end('missing or invalid mcp-session-id');
  }

  return {
    port: MCP_PORT,

    start(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const srv = createServer((req, res) => {
          handle(req, res).catch((err: unknown) => {
            // SEC-3: an over-cap body surfaces as PayloadTooLarge -> 413.
            if (err instanceof PayloadTooLarge) {
              if (!res.headersSent) res.writeHead(413);
              res.end('payload too large');
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            if (!res.headersSent) res.writeHead(500);
            res.end(`internal error: ${message}`);
          });
        });
        srv.on('error', reject);
        srv.listen(MCP_PORT, MCP_HOST, () => {
          http = srv;
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      // Close every live session transport/server first.
      for (const { transport, server } of sessions.values()) {
        try {
          await transport.close();
        } catch {
          /* ignore */
        }
        try {
          await server.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();

      const srv = http;
      http = undefined;
      if (srv === undefined) return;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
      });
    },
  };
}
