/* ============================================================
 * Loom — Event bus (FR-29/30, NFR-8)
 * ------------------------------------------------------------
 * A tiny in-process pub/sub. The engine + watcher publish
 * LoomEvents; subscribers fan them out to (a) the renderer via
 * Electron IPC and (b) the optional external WebSocket feed.
 * The SAME event shape goes to both sinks (AC-13, AC-15).
 *
 * No Electron import here so engine tests can subscribe directly.
 *
 * Semantics (frozen):
 *   - publish(e) delivers SYNCHRONOUSLY to every subscriber that is
 *     registered at the moment publish() is called.
 *   - subscribe(h) returns an idempotent unsubscribe fn.
 *   - A throwing subscriber MUST NOT break delivery to the others
 *     and MUST NOT propagate back to the publisher (error isolation).
 *   - Subscribe/unsubscribe during a publish does not disturb the
 *     in-flight fan-out (we snapshot the subscriber set per publish).
 * ============================================================ */
import type { LoomEvent } from '../shared/types.js';

export type EventHandler = (e: LoomEvent) => void;

export interface EventBus {
  publish(e: LoomEvent): void;
  subscribe(handler: EventHandler): () => void;
}

export function createEventBus(): EventBus {
  /* A Set gives O(1) add/delete and natural dedupe of a handler ref.
   * We snapshot to an array per publish so that handlers which
   * (un)subscribe during dispatch never mutate the iteration we are in
   * the middle of — a classic re-entrancy footgun under burst load. */
  const handlers = new Set<EventHandler>();

  function publish(e: LoomEvent): void {
    if (handlers.size === 0) return;
    // Snapshot: stable, point-in-time view of subscribers for THIS event.
    const snapshot = Array.from(handlers);
    for (const handler of snapshot) {
      try {
        handler(e);
      } catch (err) {
        // Isolate subscriber faults: one bad sink (IPC, ws, a test
        // listener) must never poison the others or the publisher.
        // No Electron/console contract here; emit a best-effort warn.
        try {
          // eslint-disable-next-line no-console
          console.error('[loom:eventbus] subscriber threw:', err);
        } catch {
          /* even logging can fail in odd environments — swallow. */
        }
      }
    }
  }

  function subscribe(handler: EventHandler): () => void {
    handlers.add(handler);
    let active = true;
    return () => {
      // Idempotent: calling the unsubscribe twice is a no-op.
      if (!active) return;
      active = false;
      handlers.delete(handler);
    };
  }

  return { publish, subscribe };
}
