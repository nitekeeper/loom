/* ============================================================
 * Loom — one collapsible per-file before→after diff block (Changes viewer)
 * ------------------------------------------------------------
 * Renders ONE ChangedFile as a collapsible block: a header row (escaped
 * path crumb + an added/modified/renamed sigil with an accessible-name
 * suffix) that, on expand, lazily fetches the file's diff via
 * window.loom.readFileDiff(path) and renders the returned hunks as a
 * READ-ONLY unified diff.
 *
 * SECURITY (Law 1 — nothing executes): every old/new line's text is
 * routed through highlightCode/escapeHtml (the SOLE sanctioned markup
 * path, highlight.ts) before any dangerouslySetInnerHTML — exactly like
 * CodeView (Viewer.tsx:441-446). The +/− sigils, gutter line numbers,
 * and row class (.diff-add/.diff-del/.diff-ctx) are pure React/CSS
 * rendered OUTSIDE the escaped span, so attacker-influenced file bytes
 * can neither inject markup nor spoof a diff marker. A binary file shows
 * an inert 'Binary file changed' card (never decoded bytes); a too-large
 * file shows a 'Diff too large' card. NOTHING here routes diff content
 * through renderMarkdown, <img>, inline <svg>, or raw innerHTML.
 *
 * Accessibility (NFR-12): change kind is conveyed by glyph + text, never
 * color alone — the path-crumb sigil carries an aria-label suffix and
 * each diff row's sigil carries an sr-only 'added line'/'removed line'.
 * ============================================================ */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ChangedFile, FileDiff as FileDiffData } from '../../shared/types.js';
import { highlightCode } from '../lib/highlight.js';
import { buildDiffRows } from '../lib/diff-view.js';

export interface FileDiffProps {
  /** The changed-file row this block renders (path + changeKind + binary). */
  file: ChangedFile;
}

/** A short, human label for a ChangeKind — used in the visible chip AND the
 *  accessible-name suffix so the change kind is never conveyed by color/glyph
 *  alone (NFR-12). */
function changeKindLabel(file: ChangedFile): string {
  switch (file.changeKind) {
    case 'added':
      return 'added';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'copied';
    case 'deleted':
      return 'deleted';
    case 'modified':
    default:
      return 'modified';
  }
}

/** Lazily fetch ONE file's diff via the bridge once the block is expanded.
 *  Returns null while idle/loading; ignores stale responses via a requestId
 *  guard (mirrors useFileContent at App.tsx:52). Re-fetches if the path changes
 *  while expanded; does nothing until `expanded` flips true (bounds IPC + memory
 *  for a large changeset rendered collapsed-by-default). */
function useFileDiff(path: string, expanded: boolean): FileDiffData | null {
  const [diff, setDiff] = useState<FileDiffData | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!expanded) return;
    const id = ++requestId.current;
    let cancelled = false;
    void window.loom
      .readFileDiff(path)
      .then((d) => {
        if (!cancelled && id === requestId.current) setDiff(d);
      })
      .catch(() => {
        if (!cancelled && id === requestId.current) setDiff(null);
      });
    return () => {
      cancelled = true;
    };
  }, [path, expanded]);

  return diff;
}

/** Render the parsed hunks as a unified diff. Each line's text goes through
 *  highlightCode (escaped, Law 1) and is injected via dangerouslySetInnerHTML on
 *  a leaf span — the sigil/gutter/row class sit OUTSIDE it (pure React/CSS).
 *  EXPORTED (pure presenter, no hooks / no window.loom) so the node --test tier
 *  can renderToStaticMarkup the REAL render sink and prove Law-1 escaping at the
 *  ACTUAL component — neutering the escape here turns that test RED (sdet/F1). */
export function DiffBody({ diff }: { diff: FileDiffData }): JSX.Element {
  if (diff.binary) {
    return (
      <div className="diff-binary-card">
        Binary file changed — no text diff.
      </div>
    );
  }
  if (diff.truncated) {
    return (
      <div className="diff-too-large-card">
        Diff too large to display.
      </div>
    );
  }
  const rows = buildDiffRows(diff);
  if (rows.length === 0) {
    return <div className="diff-identical">No textual changes.</div>;
  }
  return (
    <div className="diff-body" role="presentation">
      {rows.map((row, i) => {
        // Escape + highlight the RAW line text (Law 1). highlightCode returns one
        // escaped HTML string per line; a single line yields one entry. A blank
        // line yields '&nbsp;' (highlight.ts), keeping the row height stable.
        const html = highlightCode(row.text)[0] ?? '&nbsp;';
        return (
          <div
            key={`${row.hunkIndex}:${i}`}
            className={'diff-row ' + row.rowClass}
          >
            {/* Old-side gutter line number (decorative — the change kind rides in
                the sr-only suffix below). */}
            <span className="diff-gutter diff-gutter-old" aria-hidden="true">
              {row.oldGutter}
            </span>
            <span className="diff-gutter diff-gutter-new" aria-hidden="true">
              {row.newGutter}
            </span>
            {/* The +/− sigil — a NON-color cue (NFR-12) rendered via CSS content
                outside the escaped span so file bytes can never spoof it. */}
            <span className="diff-sigil" aria-hidden="true" />
            {/* sr-only change-kind suffix so an AT user hears 'added line' /
                'removed line', not just a colored row (NFR-12 / SC 1.4.1). */}
            <span className="sr-only">{row.a11ySuffix}: </span>
            {/* eslint-disable-next-line react/no-danger -- escaped by lib/highlight */}
            <span className="diff-text" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        );
      })}
    </div>
  );
}

export function FileDiff({ file }: FileDiffProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const diff = useFileDiff(file.path, expanded);
  const kindLabel = changeKindLabel(file);
  // The added sigil reuses the green .badge-git-added chip; modified/renamed use
  // the amber .dot-git-modified dot — both paired with a text label (NFR-12).
  const isAdded = file.changeKind === 'added';

  // A stable, escaped-by-React path crumb. The basename is bolded; the dir
  // prefix is dimmed. React text children auto-escape (Law 1) — the path is
  // attacker-influenced bytes rendered as data, never markup.
  const parts = file.path.split('/').filter((p) => p.length > 0);
  const basename = parts.length > 0 ? parts[parts.length - 1] : file.path;
  const dir = parts.slice(0, -1).join('/');

  return (
    <div className={'changes-file' + (expanded ? ' expanded' : '')}>
      <button
        type="button"
        className="changes-file-head"
        aria-expanded={expanded}
        // The accessible name folds in the change kind + (for a rename) the old
        // path, so an AT user hears WHAT changed, not just the new path (NFR-12).
        aria-label={
          `${kindLabel}: ${file.path}` +
          (file.oldPath !== null ? ` (renamed from ${file.oldPath})` : '') +
          (file.binary ? ', binary' : '')
        }
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={'twirl' + (expanded ? ' open' : '')} aria-hidden="true">
          ▶
        </span>
        <span className="changes-file-path" aria-hidden="true">
          {dir.length > 0 ? <span className="changes-file-dir">{dir}/</span> : null}
          <b>{basename}</b>
        </span>
        {/* Non-color change-kind cue: a glyph chip AND a text label. */}
        {isAdded ? (
          <span className="badge-git-added" aria-hidden="true">
            +
          </span>
        ) : (
          <span className="dot-git-modified" aria-hidden="true" />
        )}
        <span className="changes-file-kind" aria-hidden="true">
          {file.binary ? `${kindLabel} · binary` : kindLabel}
        </span>
      </button>
      {expanded ? (
        diff === null ? (
          <div className="diff-loading" role="status">
            Loading diff…
          </div>
        ) : (
          <DiffBody diff={diff} />
        )
      ) : null}
    </div>
  );
}
