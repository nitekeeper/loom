/* ============================================================
 * Loom — optional external WebSocket observer feed (FR-29/30, NFR-10)
 * ------------------------------------------------------------
 * OFF by default; enabled by env LOOM_WS=1. Bound to
 * 127.0.0.1:7078. Subscribes to the event bus and broadcasts the
 * SAME LoomEvent shape as the IPC feed to external observers
 * (dashboards/loggers) without coupling them to Electron
 * (AC-13, AC-15). Decoupled from the MCP agent transport (NFR-10).
 *
 * Design notes (realtime concerns):
 *   - Bound to the loopback host ONLY (127.0.0.1) — never 0.0.0.0.
 *   - One JSON.stringify per event, reused for every client (cheap
 *     fan-out under burst load; O(clients) sends, O(1) serialize).
 *   - Backpressure policy: observers are best-effort. If a client's
 *     kernel send buffer (`bufferedAmount`) grows past a cap, we DROP
 *     that slow client (terminate) rather than let it back-pressure the
 *     bus. The live feed must never block message persistence (NFR-10).
 *   - Per-message-deflate disabled: it adds CPU + latency and buffers,
 *     working against a low-latency observer feed.
 * ============================================================ */
import { WebSocket, WebSocketServer } from 'ws';
import type { EventBus } from './eventbus.js';
import type { LoomEvent } from '../shared/types.js';

export interface WsFeedHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const WS_HOST = '127.0.0.1';
export const WS_PORT = 7078;

/** Max bytes allowed to sit in a single client's outbound buffer before
 *  we consider it too slow and drop it. Keeps one stalled observer from
 *  growing memory unbounded under a burst. */
const MAX_CLIENT_BUFFERED_BYTES = 1 << 20; // 1 MiB

/** Whether the external ws feed is enabled (LOOM_WS=1). */
export function wsEnabled(): boolean {
  return process.env.LOOM_WS === '1';
}

export function createWsFeed(bus: EventBus): WsFeedHandle {
  let server: WebSocketServer | null = null;
  let unsubscribe: (() => void) | null = null;

  function broadcast(e: LoomEvent): void {
    const srv = server;
    if (!srv) return;
    // Serialize ONCE; every connected observer gets the identical bytes.
    let payload: string;
    try {
      payload = JSON.stringify(e);
    } catch {
      // A non-serializable event would only ever be a programming error
      // upstream; never let it bubble back into the bus publisher.
      return;
    }
    for (const client of srv.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // Drop slow consumers instead of blocking the bus on them.
      if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        try {
          client.terminate();
        } catch {
          /* already dead — ignore */
        }
        continue;
      }
      try {
        // Fire-and-forget; the send callback only surfaces socket errors,
        // which we treat as a client problem, not a feed problem.
        client.send(payload, (err?: Error) => {
          if (err) {
            try {
              client.terminate();
            } catch {
              /* ignore */
            }
          }
        });
      } catch {
        // Synchronous throw (e.g. socket closed mid-iteration) — skip.
      }
    }
  }

  function start(): Promise<void> {
    if (server) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const srv = new WebSocketServer({
        host: WS_HOST,
        port: WS_PORT,
        clientTracking: true,
        perMessageDeflate: false,
        // Observers are read-only sinks; reject any sizeable inbound frame.
        maxPayload: 4 * 1024,
      });

      const onError = (err: Error): void => {
        // Bind failure (port in use, EACCES, …): tear down and reject so
        // the caller can decide. The observer feed is OPTIONAL — main
        // should log and continue, never crash on this.
        srv.removeListener('listening', onListening);
        try {
          srv.close();
        } catch {
          /* ignore */
        }
        server = null;
        reject(err);
      };

      const onListening = (): void => {
        srv.removeListener('error', onError);
        // Subsequent runtime errors (post-listen) must not crash the app.
        srv.on('error', (err: Error) => {
          try {
            // eslint-disable-next-line no-console
            console.error('[loom:ws] server error:', err);
          } catch {
            /* ignore */
          }
        });
        server = srv;
        // Only NOW subscribe to the bus, so we never broadcast into a
        // not-yet-listening server.
        unsubscribe = bus.subscribe(broadcast);
        resolve();
      };

      srv.once('error', onError);
      srv.once('listening', onListening);

      srv.on('connection', (socket: WebSocket) => {
        // Tolerate per-socket errors (RST, abrupt disconnect) silently —
        // a misbehaving observer must not affect the others or the bus.
        socket.on('error', () => {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
        });
        // We never read from observers; ignore any inbound message.
        socket.on('message', () => {
          /* observer feed is broadcast-only — discard inbound frames */
        });
      });
    });
  }

  function stop(): Promise<void> {
    // Detach from the bus first so no further broadcasts are attempted.
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
    }
    const srv = server;
    server = null;
    if (!srv) return Promise.resolve();
    // Forcibly drop any lingering clients so close() resolves promptly
    // even if an observer is wedged.
    for (const client of srv.clients) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }
    return new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }

  return { start, stop };
}
