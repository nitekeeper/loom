/* ============================================================
 * Loom — TitleBar chrome (FR-35)
 * ------------------------------------------------------------
 * Shows the sandbox root name with a lock/sandbox glyph and the
 * "Loom" product identity, plus the non-normative "loom ." label.
 * Traffic-light dots are OS-provided / non-normative chrome kept
 * here purely for visual parity with the prototype.
 * ============================================================ */
import type { JSX } from 'react';

export interface TitleBarProps {
  rootName: string;
}

export function TitleBar({ rootName }: TitleBarProps): JSX.Element {
  return (
    <div className="titlebar">
      {/* Non-normative macOS-style window controls (FR-35: not required). */}
      <div className="traffic" aria-hidden="true">
        <i className="r" />
        <i className="y" />
        <i className="g" />
      </div>
      <div className="title-center">
        <span className="lock" role="img" aria-label="sandboxed">
          🔒
        </span>
        <b className="mono">{rootName}</b>
        <span style={{ color: 'var(--text-faint)' }}>— Loom</span>
      </div>
      <div className="title-right">
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-faint)',
          }}
        >
          loom .
        </span>
      </div>
    </div>
  );
}
