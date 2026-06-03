/* ============================================================
 * Loom — Channel message thread (FR-44, FR-45, FR-48, FR-53)
 * ------------------------------------------------------------
 * Renders the messages of the active channel. Each Message
 * distinguishes broadcast (@here, accent-emphasized) from direct
 * (-> recipient) and shows a ReceiptStrip. Message bodies render
 * via the safe inline markdown path (neutralized links, escaped
 * HTML). Auto-scrolls to newest UNLESS paused (the human froze the
 * feed). Shows an empty state when the channel has no messages.
 * ============================================================ */
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import type { MessageView } from '../../shared/types.js';
import { Message } from './Message.js';
import { tailWindow, DEFAULT_RENDER_WINDOW } from '../lib/window.js';

export interface ThreadProps {
  channel: string;
  messages: MessageView[];
  paused: boolean;
}

export function Thread(props: ThreadProps): JSX.Element {
  const { messages, paused } = props;
  const ref = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest on message growth — but NOT while paused
  // (PAUSED means the human is inspecting history; FR-36).
  const count = messages.length;
  useEffect(() => {
    if (paused) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, paused]);

  // Bound the rendered set to the most recent N (FR-44 responsiveness): a
  // 10–20 agent firehose can append faster than the human reads, and rendering
  // every message (each running inline markdown) would freeze the observer
  // pane. Only the DOM is windowed — the FULL history stays in the store — and
  // a non-silent banner surfaces how many older messages are hidden.
  const win = tailWindow(messages, DEFAULT_RENDER_WINDOW);

  return (
    <div className="thread" ref={ref} role="log" aria-live="polite">
      {count === 0 ? (
        <div className="inbox-empty">No messages in this channel yet.</div>
      ) : (
        <>
          {win.hidden > 0 ? (
            <div
              className="thread-window-notice"
              role="status"
              style={{
                padding: '5px 12px',
                margin: '0 0 4px',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-faint)',
                textAlign: 'center',
                borderBottom: '1px solid rgba(127,127,127,.18)',
              }}
            >
              ↑ {win.hidden.toLocaleString()} older{' '}
              {win.hidden === 1 ? 'message' : 'messages'} hidden to keep the view
              responsive — showing the latest {win.shown.length.toLocaleString()}.
            </div>
          ) : null}
          {win.shown.map((m) => (
            <Message key={m.id} message={m} />
          ))}
        </>
      )}
    </div>
  );
}
