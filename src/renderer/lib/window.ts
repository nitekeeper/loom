/* ============================================================
 * Loom — pure tail-window helper (renderer DOM bound)
 * ------------------------------------------------------------
 * Bounds how many items a live list renders to the DOM: keep the
 * most recent `limit`, report how many older ones were hidden.
 *
 * Why: the Chat thread + per-agent inbox render EVERY message, each
 * running inline markdown. With 10–20 agents posting concurrently the
 * transcript can grow faster than the human reads it; rendering the
 * whole list would freeze the observer pane (the human-visible
 * "crash"). We window only the DOM — the FULL history stays in the
 * store — and callers surface a NON-SILENT banner from `hidden` so
 * windowed-away messages are never a silent omission.
 *
 * Pure + DOM-free (no React/Node) so it is unit-tested via the
 * testkit bundle exactly like the other renderer libs.
 * ============================================================ */

/** Default number of trailing items rendered before windowing kicks in. */
export const DEFAULT_RENDER_WINDOW = 400;

export interface TailWindow<T> {
  /** The items to actually render (the most recent `limit`, order preserved). */
  shown: T[];
  /** How many older items were hidden (0 when not capped). */
  hidden: number;
  /** Total input length. */
  total: number;
  /** True when the input exceeded the limit and was trimmed. */
  capped: boolean;
}

/** Return the trailing `limit` items of `items`, preserving order, plus the
 *  count hidden. A non-positive, non-integer, or >= total limit renders
 *  everything (no cap). Never mutates the input. */
export function tailWindow<T>(
  items: readonly T[],
  limit: number = DEFAULT_RENDER_WINDOW,
): TailWindow<T> {
  const total = items.length;
  if (!Number.isInteger(limit) || limit <= 0 || total <= limit) {
    return { shown: items.slice(), hidden: 0, total, capped: false };
  }
  return {
    shown: items.slice(total - limit),
    hidden: total - limit,
    total,
    capped: true,
  };
}
