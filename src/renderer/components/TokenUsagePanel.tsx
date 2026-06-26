/* ============================================================
 * Loom — Token Usage panel (daily rollup viewer)
 * ------------------------------------------------------------
 * An accessible MODAL dialog that renders atelier's daily token-usage rollup,
 * fetched via window.loom.getDailyTokens (the TOKENS_DAILY bridge — main spawns
 * atelier's token_usage.py and returns a FAIL-SOFT union). It mirrors
 * SettingsPanel's modal shell + a11y contract EXACTLY (role="dialog",
 * aria-modal, focus trap, Escape-to-close, backdrop-mousedown close, opener
 * focus restore owned by App).
 *
 * The DailyTokenResult union is rendered EXHAUSTIVELY:
 *   - loading            → a polite "Loading…" status.
 *   - ok:false           → a friendly per-`reason` message (never a raw crash).
 *                          atelier_not_found gets install guidance; the rest
 *                          surface the typed `error` string.
 *   - ok:true, 0 rows    → an empty state.
 *   - ok:true, rows      → a TABLE (day, model, input, output, cache-create,
 *                          cache-read, + cost when the cost toggle is on), with
 *                          a totals footer when the CLI returned one.
 *
 * A cost toggle re-fetches with { cost } (the CLI omits per-row cost + the
 * totals object without --cost); a Refresh button re-runs the current query.
 *
 * SECURITY (Law 1): `day`/`model` are RAW CLI output — rendered as escaped React
 * text content only (never an HTML sink). Numbers route through the pure
 * lib/format formatters (defensive on null/garbage). NO HTML sink here.
 * ============================================================ */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type { DailyTokenResult } from '../../shared/types.js';
import { formatCost, formatTokens } from '../lib/format.js';

export interface TokenUsagePanelProps {
  /** Close the dialog AND return focus to the opener (App owns the state). */
  onClose(): void;
}

/** Selector for every tabbable control inside the dialog (focus trap). Shared
 *  verbatim with SettingsPanel / ShortcutsPanel so all modals trap identically. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** True when an element is currently rendered/laid-out (has client rects) OR is
 *  the active element. Robust for position:fixed controls where offsetParent is
 *  null. Mirrors SettingsPanel.isVisible. */
function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 || el === document.activeElement;
}

/** Human-readable, per-`reason` message for the fail-soft union. atelier_not_
 *  found gets actionable install guidance; the rest surface the typed `error`
 *  the data layer already produced (NEVER a raw crash). */
function describeError(
  reason: Extract<DailyTokenResult, { ok: false }>['reason'],
  error: string,
): string {
  if (reason === 'atelier_not_found') {
    return (
      "atelier's token_usage.py was not found — install atelier ≥ 1.11.0, or set " +
      '`tokens.atelierScript` in loom config.'
    );
  }
  return error;
}

export function TokenUsagePanel({ onClose }: TokenUsagePanelProps): JSX.Element {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Whether to request per-row + totals USD cost (the CLI's --cost flag).
  const [cost, setCost] = useState(false);
  // null while the first fetch is in flight; the fail-soft union once resolved.
  const [result, setResult] = useState<DailyTokenResult | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by Refresh to force a re-fetch of the SAME query.
  const [reloadKey, setReloadKey] = useState(0);

  // Fetch the rollup on mount, whenever the cost toggle flips, and on Refresh.
  // A per-effect `cancelled` guard drops a stale resolution if the inputs change
  // (or the panel unmounts) before the bridge call returns.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void window.loom
      .getDailyTokens({ cost })
      .then((res) => {
        if (!cancelled) {
          setResult(res);
          setLoading(false);
        }
      })
      .catch(() => {
        // The bridge is fail-soft (returns ok:false, never rejects), but stay
        // defensive: a transport-level throw degrades to a typed error state
        // rather than an unhandled rejection.
        if (!cancelled) {
          setResult({
            ok: false,
            reason: 'spawn_failed',
            error: 'The token-usage rollup could not be loaded.',
          });
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cost, reloadKey]);

  // Focus the first control (the cost toggle) on open, deferred to after paint.
  // App restores opener focus on unmount/close.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLInputElement>('input[name="tu-cost"]')
        ?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Dialog-level key handling: focus trap (Tab/Shift+Tab) + Escape (close).
  // Mirrors SettingsPanel.onKeyDown.
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
        ).filter(isVisible);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !dialog.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !dialog.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [onClose],
  );

  // Clicking the backdrop closes the dialog (a standard modal affordance).
  const onBackdropMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div
      className="sc-backdrop"
      onMouseDown={onBackdropMouseDown}
      onKeyDown={onKeyDown}
    >
      {/* Reuse the shared modal shell (.sc-dialog) for visual parity; the stable
          "token-usage-dialog" class lets the e2e target this dialog. */}
      <div
        className="sc-dialog token-usage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        ref={dialogRef}
      >
        <div className="sc-head">
          <h2 className="sc-title" id={titleId}>
            Token Usage
          </h2>
          <button
            type="button"
            className="iconbtn sc-close"
            aria-label="Close token usage"
            title="Close (Esc)"
            onClick={onClose}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="sc-hint" id={descId}>
          Daily token usage per model, from atelier&apos;s usage log.
        </p>

        {/* Controls: the cost toggle re-fetches with --cost; Refresh re-runs the
            current query. */}
        <div className="tu-controls">
          <label className="set-radio">
            <input
              type="checkbox"
              name="tu-cost"
              checked={cost}
              onChange={(e) => setCost(e.target.checked)}
            />
            <span>Show cost (USD)</span>
          </label>
          <button
            type="button"
            className="sc-btn"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
          >
            Refresh
          </button>
        </div>

        <div className="tu-body">
          <TokenUsageContent loading={loading} cost={cost} result={result} />
        </div>

        <div className="sc-foot">
          <span />
          <button
            type="button"
            className="sc-btn sc-btn-primary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** The body that renders the fail-soft union exhaustively (loading / error /
 *  empty / table). Split out so the branch logic reads top-to-bottom. */
function TokenUsageContent({
  loading,
  cost,
  result,
}: {
  loading: boolean;
  cost: boolean;
  result: DailyTokenResult | null;
}): JSX.Element {
  if (loading || result === null) {
    return (
      <p className="tu-state" role="status" aria-live="polite">
        Loading…
      </p>
    );
  }

  if (!result.ok) {
    return (
      <p className="tu-state tu-error" role="alert">
        {describeError(result.reason, result.error)}
      </p>
    );
  }

  if (result.rows.length === 0) {
    return <p className="tu-state">No token usage found.</p>;
  }

  const { rows, totals } = result;
  return (
    <table className="tu-table">
      <thead>
        <tr>
          <th scope="col" className="tu-col-text">
            Day
          </th>
          <th scope="col" className="tu-col-text">
            Model
          </th>
          <th scope="col" className="tu-col-num">
            Input
          </th>
          <th scope="col" className="tu-col-num">
            Output
          </th>
          <th scope="col" className="tu-col-num">
            Cache create
          </th>
          <th scope="col" className="tu-col-num">
            Cache read
          </th>
          {cost && (
            <th scope="col" className="tu-col-num">
              Cost
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          // The CLI may emit multiple rows per (day, model) is not guaranteed
          // unique, so the index keeps keys stable for this static render.
          <tr key={`${row.day} ${row.model} ${i}`}>
            <td className="tu-col-text">{row.day}</td>
            <td className="tu-col-text">{row.model}</td>
            <td className="tu-col-num">{formatTokens(row.input_tokens)}</td>
            <td className="tu-col-num">{formatTokens(row.output_tokens)}</td>
            <td className="tu-col-num">
              {formatTokens(row.cache_creation_input_tokens)}
            </td>
            <td className="tu-col-num">
              {formatTokens(row.cache_read_input_tokens)}
            </td>
            {cost && <td className="tu-col-num">{formatCost(row.cost_usd)}</td>}
          </tr>
        ))}
      </tbody>
      {cost && totals && (
        <tfoot>
          <tr className="tu-totals">
            <th scope="row" className="tu-col-text" colSpan={2}>
              Total
            </th>
            <td className="tu-col-num">{formatTokens(totals.input_tokens)}</td>
            <td className="tu-col-num">{formatTokens(totals.output_tokens)}</td>
            <td className="tu-col-num">
              {formatTokens(totals.cache_creation_input_tokens)}
            </td>
            <td className="tu-col-num">
              {formatTokens(totals.cache_read_input_tokens)}
            </td>
            <td className="tu-col-num">{formatCost(totals.cost_usd)}</td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
