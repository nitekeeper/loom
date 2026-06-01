/* ============================================================
 * Loom — receipt indicator (FR-45, AC-23, NFR-12)
 * ------------------------------------------------------------
 * Direct message: a two-state delivered -> seen indicator
 * (single check vs double check + text — a NON-COLOR cue).
 * @here message: an aggregate "N/M read" count + a read-progress
 * bar, with a per-recipient breakdown panel (each recipient's
 * seen/unread state). ACCESSIBILITY: the breakdown is reachable on
 * BOTH hover AND keyboard focus (the trigger is a real <button>),
 * with non-color cues for seen/unread (FR-45, NFR-12 SC 1.4.13/1.4.1).
 *
 * Receipt state is REAL (from MessageView.receipts), not faked.
 *
 * The prototype showed the breakdown via `.receipt:hover .tip` only
 * (hover-only — an SC 1.4.13 failure). Because this file may not edit
 * CSS, visibility is driven by React state (hover + focus-within) and
 * forced with inline styles so the panel is keyboard/touch reachable
 * regardless of the stylesheet.
 * ============================================================ */
import { useId, useRef, useState } from 'react';
import type { FocusEvent, JSX, KeyboardEvent } from 'react';
import type { Addressing, ReceiptView } from '../../shared/types.js';
import { Avatar } from './Avatar.js';

export interface ReceiptStripProps {
  addressing: Addressing;
  target: string | null;
  receipts: ReceiptView[];
}

function isSeen(r: ReceiptView): boolean {
  return r.read_at !== null;
}

export function ReceiptStrip(props: ReceiptStripProps): JSX.Element {
  const { addressing, target, receipts } = props;
  const [open, setOpen] = useState(false);

  /* ---- direct: two-state delivered -> seen ---- */
  if (addressing === 'direct') {
    // For a direct message there is exactly one receipt (the target).
    const r = receipts[0];
    const seen = r ? isSeen(r) : false;
    const who = target ?? r?.recipient ?? '';
    return (
      <div className={'receipt' + (seen ? ' seen' : '')}>
        {/* Non-color cue: glyph (single vs double check) + the word. */}
        <span className="chk" aria-hidden="true">{seen ? '✓✓' : '✓'}</span>
        <span>
          {'→'} {who} {'·'} {seen ? 'seen' : 'delivered'}
        </span>
      </div>
    );
  }

  /* ---- @here: aggregate N/M read + breakdown ---- */
  const read = receipts.filter(isSeen).length;
  const total = receipts.length;
  const full = total > 0 && read === total;
  const pct = total ? (read / total) * 100 : 0;
  // Unique per instance (A11Y-10): multiple @here messages render at once, so
  // a hard-coded id would duplicate and make aria-controls ambiguous.
  const tipId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const show = (): void => setOpen(true);
  const hide = (): void => setOpen(false);
  const toggle = (): void => setOpen((o) => !o);

  // Persistent/Hoverable (SC 1.4.13, A11Y-02): only collapse when focus
  // leaves the WHOLE receipt subtree, so a keyboard user can move into the
  // panel without it vanishing. relatedTarget is the element gaining focus.
  const onBlurCapture = (e: FocusEvent<HTMLDivElement>): void => {
    const next = e.relatedTarget as Node | null;
    if (!next || !wrapRef.current || !wrapRef.current.contains(next)) hide();
  };

  // Dismissable (SC 1.4.13, A11Y-02): Escape closes and returns focus to the
  // trigger so the keyboard user is not stranded.
  //
  // De-confliction with the document-level file-close Escape handler
  // (A11Y-CLOSE-05): when this tooltip consumes Escape it BOTH stops
  // propagation (so the bubble-phase document handler never fires) AND calls
  // preventDefault (so even if the event ever reached that handler, its
  // `e.defaultPrevented` guard is a second, independent barrier). The result:
  // an Escape that dismisses a receipt breakdown can NEVER also close the open
  // file (SC 2.1.2 robustness), regardless of future event-delegation changes.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <div
      ref={wrapRef}
      className={'receipt' + (full ? ' seen' : '')}
      onMouseEnter={show}
      onMouseLeave={hide}
      onBlur={onBlurCapture}
      onKeyDown={onKeyDown}
    >
      <span className="chk" aria-hidden="true">{full ? '✓✓' : '✓'}</span>
      <span>{'→'} @here</span>
      {/* progress bar — supplementary, non-color text carries the value */}
      <span className="bar" aria-hidden="true">
        <i style={{ width: pct + '%' }} />
      </span>
      {/* The trigger is a focusable button AND a real toggle so the breakdown
          opens on tap/click (touch, SC 1.4.13 / A11Y-01), keyboard (SC 2.1.1),
          and hover. The count is announced via aria-expanded. */}
      <button
        type="button"
        ref={triggerRef}
        className="receipt-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={tipId}
        onClick={toggle}
        onFocus={show}
        style={{
          background: 'none',
          border: 0,
          padding: 0,
          margin: 0,
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
        }}
      >
        {read}/{total} read
        {/* A11Y-03 hardening: a non-color word reinforcing the aggregate
            seen-state, in addition to the ✓/✓✓ glyph + the N/M count. */}
        <span className="sr-only">
          {' '}({full ? 'fully read' : 'partially read'})
        </span>
      </button>
      {/* Hover-, focus-, OR tap-revealed breakdown (FR-45 / AC-23 / SC 1.4.13). */}
      <div
        id={tipId}
        className="tip"
        role="dialog"
        aria-label={`Read receipts: ${read} of ${total} recipients have read this message`}
        style={
          open
            ? { opacity: 1, pointerEvents: 'auto', transform: 'none' }
            : undefined
        }
      >
        <div className="tip-title">delivered to @here</div>
        {receipts.length === 0 && (
          <div className="tip-row">
            <span className="who">no recipients</span>
          </div>
        )}
        {receipts.map((r) => {
          const seen = isSeen(r);
          return (
            <div className="tip-row" key={r.recipient}>
              <Avatar name={r.recipient} status="active" size={18} decorative />
              <span className="who">{r.recipient}</span>
              {/* Non-color cue: the word seen/unread plus a glyph. */}
              <span className={'st' + (seen ? ' read' : '')}>
                <span aria-hidden="true">{seen ? '✓✓ ' : '✓ '}</span>
                {seen ? 'seen' : 'unread'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
