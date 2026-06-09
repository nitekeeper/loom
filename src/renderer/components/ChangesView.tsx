/* ============================================================
 * Loom — branch "Changes" viewer (center-pane MODE)
 * ------------------------------------------------------------
 * Rendered into the center 1fr grid track (replacing the Viewer) when
 * diffMode is true — the exact SearchView swap idiom, but targeting the
 * Viewer track because a diff is CONTENT, not navigation. Lists every
 * file CREATED or MODIFIED on the current branch vs. the base merge-base
 * (three-dot, committed branch work), each rendered as a READ-ONLY
 * before→after unified diff via <FileDiff> (collapsed-by-default; the
 * per-file diff is fetched lazily on expand).
 *
 * Three terminal states mirror the Viewer:
 *   - loading        — changes not yet fetched (null);
 *   - unavailable    — not a git repo / git missing (available:false);
 *   - empty          — a git repo with no branch changes (the base==HEAD
 *                      default — an honest 'no changes', NOT an error).
 *
 * SECURITY (Law 1): all diff content is escaped at the <FileDiff> sink;
 * this shell renders only React text children (auto-escaped) + fixed
 * chrome. NOTHING here routes file bytes through innerHTML.
 * ============================================================ */
import type { JSX } from 'react';
import type { ChangeSet } from '../../shared/types.js';
import { FileDiff } from './FileDiff.js';

export interface ChangesViewProps {
  /** The fetched change listing, or null until loadChanges() resolves. */
  changes: ChangeSet | null;
  /** Close the Changes viewer → return to the previously-selected file's
   *  Viewer (re-click the toggle / Esc / the × button). */
  onClose(): void;
}

/** A small branch glyph for the header — decorative (aria-hidden); the region's
 *  accessible name + the crumb text carry the meaning. */
function BranchIcon(): JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 10.5a6 6 0 0 1-6 6H8.5" />
    </svg>
  );
}

export function ChangesView({ changes, onClose }: ChangesViewProps): JSX.Element {
  const base = changes?.base ?? '';
  const files = changes?.files ?? [];
  const crumb = base.length > 0 ? `Changes vs ${base}` : 'Changes';

  // Pick the body for the current state. All three states keep the same header
  // shape (crumb + count chip + × close) so the pane reads consistently.
  let body: JSX.Element;
  if (changes === null) {
    body = (
      <div className="changes-empty" role="status">
        <h2 className="changes-empty-title">Loading changes…</h2>
      </div>
    );
  } else if (!changes.available) {
    body = (
      <div className="changes-empty">
        <h2 className="changes-empty-title">No changes to show</h2>
        <div>Not a git repository — there is no branch to compare.</div>
      </div>
    );
  } else if (files.length === 0) {
    body = (
      <div className="changes-empty">
        <h2 className="changes-empty-title">No changes on this branch</h2>
        <div>
          This branch is even with{' '}
          <span className="mono">{base.length > 0 ? base : 'the base'}</span> —
          nothing has been created or modified.
        </div>
      </div>
    );
  } else {
    body = (
      <div className="changes-list">
        {files.map((file) => (
          <FileDiff key={file.path} file={file} />
        ))}
      </div>
    );
  }

  return (
    <section
      className="pane viewer changes"
      aria-label="Changes on this branch"
    >
      <div className="viewer-head">
        <span className="crumb changes-crumb">
          <span className="changes-head-icon" aria-hidden="true">
            <BranchIcon />
          </span>
          <b>{crumb}</b>
        </span>
        {/* Changed-file count chip — reuses the .render-tag header chip slot so
            the head keeps its two-ended shape (mirrors the Viewer). */}
        <span
          className="render-tag source changes-count"
          aria-label={`${files.length} ${files.length === 1 ? 'file changed' : 'files changed'}`}
          title={`${files.length} ${files.length === 1 ? 'file changed' : 'files changed'}`}
        >
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
        {/* Close → back to the previously-selected file's Viewer. Reuses the
            .iconbtn .viewer-close affordances (focus-visible ring); Esc is
            documented in the title so the keyboard path is discoverable. */}
        <button
          type="button"
          className="iconbtn viewer-close"
          aria-label="Close changes"
          title="Close changes (Esc)"
          onClick={onClose}
        >
          <svg
            width="16"
            height="16"
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
      {body}
    </section>
  );
}
