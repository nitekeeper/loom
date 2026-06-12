/* ============================================================
 * Loom — MCP server (thin wrapper over engine.ts)
 * ------------------------------------------------------------
 * Exposes the 10 tools over the @modelcontextprotocol/sdk
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
// The MCP server advertises this version in its initialize handshake. Pulled
// from package.json at BUILD time (esbuild inlines the JSON), so it tracks the
// real app version automatically and can never drift from a hardcoded string.
import { version as LOOM_VERSION } from '../../package.json';

export interface McpServerHandle {
  /** Begin listening on 127.0.0.1:7077. */
  start(): Promise<void>;
  /** Stop the server and close transports. */
  stop(): Promise<void>;
  /** The TCP port the agent transport listens on (NFR-9, OQ-4). */
  readonly port: number;
  /** Number of live MCP sessions currently held (monitoring + tests). */
  sessionCount(): number;
  /** The connection_ids bound to currently-LIVE sessions (each set on the
   *  session's Caller by register()). This is the authority the human
   *  stale-agent sweep (CLEAR_STALE_AGENTS) and the staleAgents counter
   *  consult: an agents row whose connection_id is absent here has no live
   *  session — its process died, was reaped, or predates this launch — and
   *  is sweepable. Unregistered sessions contribute nothing (their caller
   *  carries no binding yet), so they never shield a row. */
  liveConnectionIds(): Set<string>;
  /** Evict every session last seen at or before `idleSince` (epoch ms),
   *  closing its transport + server. Returns the count reaped. The idle reaper
   *  calls this with (now - sessionIdleTtlMs); exposed so a test can force
   *  reaping deterministically without waiting on the timer. */
  reapIdleSessions(idleSince: number): Promise<number>;
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
  /** Epoch ms of the last request routed to (or creating) this session.
   *  Drives the idle reaper (S1) — a session not seen for the TTL is evicted. */
  lastSeen: number;
}

/** How many consecutive ports to try (MCP_PORT..MCP_PORT+N-1) before giving
 *  up, when the preferred port is already held — e.g. by a second Loom
 *  instance. The viewer must still open even if every candidate is taken
 *  (main.ts degrades gracefully); the scan just lets a second instance get a
 *  working agent transport on the next free port instead of crashing. */
const MAX_PORT_ATTEMPTS = 16;

/** Runtime MCP-server options (R1). */
export interface McpServerOptions {
  /** Per-message body cap (SEC-6), resolved from config; defaults to
   *  MAX_BODY_LENGTH. Mirrored into the send_message zod schema + description
   *  so a client sees the SAME live limit the engine enforces. */
  maxBodyLength?: number;
  /** M3: max concurrent sessions before a NEW initialize is rejected with 503.
   *  Well above the 10-20 target; guards a local runaway. Default 100. */
  maxSessions?: number;
  /** S1: a session not seen for this many ms is evicted by the reaper (its
   *  transport + server closed). Real agents exit without DELETE, so the SDK's
   *  onclose never fires — the reaper is the backstop. Default 5 min. */
  sessionIdleTtlMs?: number;
  /** S1: how often the idle reaper sweeps, in ms. Default 60s. */
  sessionReaperIntervalMs?: number;
  /** Starting TCP port for the listen scan (default MCP_PORT). Pass 0 to bind
   *  an ephemeral OS-assigned port — used by tests so concurrent server boots
   *  never contend for a fixed port or scan into the ws feed's port. */
  startPort?: number;
  /** Invoked after reapIdleSessions evicts >= 1 REGISTERED session, with the
   *  count of registered sessions evicted. Reaping publishes NO bus event,
   *  yet it changes the stale-agent picture (an evicted registered session's
   *  row loses its live binding) — without this nudge the renderer's
   *  staleAgents counter froze at its last pushed value and the "clear
   *  stale" button sat disabled next to dead chips. main wires this to
   *  ipc.nudgeCounters(). Unregistered evictions don't fire it (they bind no
   *  row, so nothing about staleness changed). Failures are swallowed —
   *  the reaper must never die to an observer callback. */
  onSessionsReaped?: (registeredEvicted: number) => void;
}

export function createMcpServer(
  engine: LoomEngine,
  opts: McpServerOptions = {},
): McpServerHandle {
  // Resolve the body cap mirrored into the schema (R1): a positive integer
  // from config, else the default. The engine enforces the same value.
  const maxBodyLength =
    typeof opts.maxBodyLength === 'number' &&
    Number.isInteger(opts.maxBodyLength) &&
    opts.maxBodyLength > 0
      ? opts.maxBodyLength
      : MAX_BODY_LENGTH;
  // M3 ceiling + S1 reaper TTL/interval, resolved from opts with safe defaults.
  const maxSessions =
    typeof opts.maxSessions === 'number' && Number.isInteger(opts.maxSessions) && opts.maxSessions > 0
      ? opts.maxSessions
      : 100;
  const sessionIdleTtlMs =
    typeof opts.sessionIdleTtlMs === 'number' && opts.sessionIdleTtlMs > 0
      ? opts.sessionIdleTtlMs
      : 5 * 60_000;
  const sessionReaperIntervalMs =
    typeof opts.sessionReaperIntervalMs === 'number' && opts.sessionReaperIntervalMs > 0
      ? opts.sessionReaperIntervalMs
      : 60_000;
  const startPort =
    typeof opts.startPort === 'number' && Number.isInteger(opts.startPort) && opts.startPort >= 0
      ? opts.startPort
      : MCP_PORT;
  const sessions = new Map<string, Session>();
  let http: HttpServer | undefined;
  let reaperTimer: ReturnType<typeof setInterval> | null = null;
  // The port actually bound (may differ from MCP_PORT if it was in use). The
  // Host/Origin allow-lists are derived from THIS value so SEC-1 stays correct
  // on whatever port we end up on.
  let boundPort = MCP_PORT;

  /** Loopback Host headers accepted on the CURRENT bound port (SEC-1). */
  const allowedHostsNow = (): string[] => [
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
  ];
  /** Loopback Origins accepted on the CURRENT bound port (SEC-1). */
  const allowedOriginsNow = (): string[] => [
    `http://127.0.0.1:${boundPort}`,
    `http://localhost:${boundPort}`,
  ];

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
    // A non-LoomError throw is an INTERNAL fault, not domain feedback. Don't
    // echo its raw message (paths/stack fragments) to the semi-trusted client
    // (L3): emit a correlation id, return a generic message carrying only that
    // id, and log the real detail server-side under it for the operator.
    const ref = randomUUID();
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[loom:mcp] internal tool error ref=${ref}: ${detail}\n`);
    const message = `internal error (ref: ${ref})`;
    return {
      content: [{ type: 'text', text: `INTERNAL_ERROR: ${message}` }],
      isError: true,
      structuredContent: { code: 'INTERNAL_ERROR', message, ref },
    };
  }
  function run(fn: () => unknown): ToolResult {
    try {
      return ok(fn());
    } catch (err) {
      return fail(err);
    }
  }

  /** Build a fresh McpServer with all 10 tools registered, bound to the
   *  given per-session Caller. The handlers close over `caller`, and
   *  register() mutates `caller.name` so the binding follows the session. */
  function buildServer(caller: Caller): McpServer {
    const server = new McpServer(
      { name: 'loom', version: LOOM_VERSION },
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
            .max(maxBodyLength)
            .describe(`Message body (max ${maxBodyLength} chars).`),
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

    // 10. purge_all() -> { ok, deleted } — human-invoked TOTAL delete (R4).
    //     Empties every table + removes .loom/temp report files. The calling
    //     session's identity is STALE afterward (its agents row is gone), so the
    //     caller MUST register() again before any further tool call.
    server.registerTool(
      'purge_all',
      {
        description:
          'Delete ALL chat content for this folder (agents, channels, messages, receipts) and remove .loom/temp report files. Returns counts removed. Destructive + irreversible; the caller must register() again afterward.',
        inputSchema: {},
      },
      () => run(() => engine.purge_all(caller)),
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
    if (host === undefined || !allowedHostsNow().includes(host)) {
      res.writeHead(403).end('forbidden host');
      return true;
    }
    const originHeader = req.headers['origin'];
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    // Only validate Origin when present: non-browser loopback clients omit it.
    if (origin !== undefined && origin !== '' && !allowedOriginsNow().includes(origin)) {
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
      existing.lastSeen = Date.now(); // keep the session out of the idle reaper
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'POST') {
      // No (or unknown) session id: treat as a new session's initialize.
      // M3: bound concurrent sessions. Loopback blocks the external threat, but
      // not a local agent opening unbounded handshakes (worsened by any leak).
      if (sessions.size >= maxSessions) {
        res.writeHead(503, { 'Retry-After': '5' }).end('too many sessions');
        return;
      }
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
        allowedHosts: allowedHostsNow(),
        allowedOrigins: allowedOriginsNow(),
        onsessioninitialized: (newId: string) => {
          sessions.set(newId, { transport, server, caller, lastSeen: Date.now() });
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

  /** S1: evict every session last seen at or before `idleSince` (epoch ms),
   *  closing its transport + server. Deletes from the Map FIRST so the
   *  transport.onclose handler's own delete is a harmless no-op. Returns the
   *  number reaped. The reaper timer calls this with (now - sessionIdleTtlMs);
   *  also exposed on the handle for monitoring + deterministic tests. */
  async function reapIdleSessions(idleSince: number): Promise<number> {
    let reaped = 0;
    let registeredEvicted = 0;
    for (const [id, s] of [...sessions]) {
      if (s.lastSeen > idleSince) continue;
      sessions.delete(id);
      // A REGISTERED session's eviction changes the stale-agent picture (its
      // row loses its live binding); count it so the caller can be nudged.
      if (s.caller.connectionId != null && s.caller.connectionId !== '') {
        registeredEvicted += 1;
      }
      try {
        await s.transport.close();
      } catch {
        /* ignore */
      }
      try {
        await s.server.close();
      } catch {
        /* ignore */
      }
      reaped += 1;
    }
    // Nudge the observer (ipc counters push) ONLY when a registered session
    // left — reaping never publishes a bus event, so without this the
    // staleAgents count froze until an unrelated event arrived.
    if (registeredEvicted > 0) {
      try {
        opts.onSessionsReaped?.(registeredEvicted);
      } catch {
        /* observer callback must never break the reaper */
      }
    }
    return reaped;
  }

  return {
    get port(): number {
      return boundPort;
    },

    sessionCount(): number {
      return sessions.size;
    },

    liveConnectionIds(): Set<string> {
      const ids = new Set<string>();
      for (const s of sessions.values()) {
        const id = s.caller.connectionId;
        if (typeof id === 'string' && id !== '') ids.add(id);
      }
      return ids;
    },

    reapIdleSessions,

    start(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const makeServer = (): HttpServer =>
          createServer((req, res) => {
            handle(req, res).catch((err: unknown) => {
              // SEC-3: an over-cap body surfaces as PayloadTooLarge -> 413.
              if (err instanceof PayloadTooLarge) {
                // M2: close the keep-alive socket so an undrained over-cap body
                // cannot desync the HTTP/1.1 stream and wedge the connection.
                if (!res.headersSent) res.writeHead(413, { Connection: 'close' });
                res.end('payload too large');
                req.destroy();
                return;
              }
              // L3: generic client body + correlation id; the real fault is
              // logged server-side under that id (never echo internals).
              const ref = randomUUID();
              const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
              process.stderr.write(`[loom:mcp] internal http error ref=${ref}: ${detail}\n`);
              if (!res.headersSent) res.writeHead(500);
              res.end(`internal error (ref: ${ref})`);
            });
          });

        // Try MCP_PORT first, then the next few ports if it is already held
        // (typically by another live Loom instance). EADDRINUSE retries on the
        // next port; any other listen error (or exhausting the range) rejects
        // so the caller can decide whether to degrade or fail.
        const tryListen = (port: number, attempt: number): void => {
          const srv = makeServer();
          const onError = (err: NodeJS.ErrnoException): void => {
            srv.removeListener('error', onError);
            // L4: await the close (via its callback) before relistening on the
            // next port, so the failed listener is fully released first.
            srv.close(() => {
              if (err.code === 'EADDRINUSE' && attempt + 1 < MAX_PORT_ATTEMPTS) {
                tryListen(port + 1, attempt + 1);
              } else {
                reject(err);
              }
            });
          };
          srv.on('error', onError);
          srv.listen(port, MCP_HOST, () => {
            srv.removeListener('error', onError);
            // Read the ACTUAL bound port (matters when startPort is 0 = an
            // ephemeral OS-assigned port). The Host/Origin allow-lists derive
            // from boundPort, so they must reflect what we really bound.
            const addr = srv.address();
            boundPort = addr !== null && typeof addr === 'object' ? addr.port : port;
            http = srv;
            // S1: start the idle-session reaper. It sweeps every
            // sessionReaperIntervalMs and evicts sessions not seen for
            // sessionIdleTtlMs — the backstop for agents that exit without
            // DELETE (the SDK's onclose never fires then). unref'd so it never
            // holds the process open on its own.
            reaperTimer = setInterval(() => {
              void reapIdleSessions(Date.now() - sessionIdleTtlMs);
            }, sessionReaperIntervalMs);
            (reaperTimer as { unref?: () => void }).unref?.();
            resolve();
          });
        };
        tryListen(startPort, 0);
      });
    },

    async stop(): Promise<void> {
      // Stop the idle reaper first so it cannot fire mid-teardown.
      if (reaperTimer !== null) {
        clearInterval(reaperTimer);
        reaperTimer = null;
      }
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
