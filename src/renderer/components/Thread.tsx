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

  return (
    <div className="thread" ref={ref} role="log" aria-live="polite">
      {count === 0 ? (
        <div className="inbox-empty">No messages in this channel yet.</div>
      ) : (
        messages.map((m) => <Message key={m.id} message={m} />)
      )}
    </div>
  );
}
