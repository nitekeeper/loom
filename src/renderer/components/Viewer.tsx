/* ============================================================
 * Loom — Viewer pane (FR-4..FR-10, FR-40..FR-43, AC-19, AC-22)
 * ------------------------------------------------------------
 * Dispatches by FileContent.dispatch.renderState (resolved once in
 * main via shared/dispatch, delivered through the readFile bridge):
 *   md   -> RENDERED  (safe markdown, FR-5)
 *   code -> SOURCE    (highlighted, FR-6)
 *   svg  -> SOURCE + safety banner (FR-7/41)
 *   html -> SOURCE + safety banner (FR-8/41)
 *   image-> PREVIEW   (safe checkerboard placeholder, never decoded; FR-10)
 *   else -> NO PREVIEW metadata card (name/size/type/modified; FR-43)
 * Shows the per-file render-state badge (FR-40, AC-19).
 *
 * SECURITY (Law 1, FR-52, AC-22): the only dangerouslySetInnerHTML
 * sinks here consume output from lib/markdown (HTML escaped, links
 * neutralized) or lib/highlight (per-token escaped). No other path
 * may inject markup; image bytes are NEVER decoded.
 * ============================================================ */
import { Fragment } from 'react';
import type { JSX } from 'react';
import type { FileContent, RenderState } from '../../shared/types.js';
import { renderMarkdown } from '../lib/markdown.js';
import { highlightCode } from '../lib/highlight.js';

function ShieldIcon(): JSX.Element {
  return (
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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

/** Highlighted, read-only source view with honest line numbers. */
function CodeView({ code }: { code: string }): JSX.Element {
  const lines = highlightCode(code);
  return (
    <div className="code">
      <div className="gutter" aria-hidden="true">
        {lines.map((_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <div className="codecol">
        <pre>
          {lines.map((l, i) => (
            // eslint-disable-next-line react/no-danger -- escaped by lib/highlight
            <span className="ln" key={i} dangerouslySetInnerHTML={{ __html: l }} />
          ))}
        </pre>
      </div>
    </div>
  );
}

/** Map a render-state to its badge CSS class. PREVIEW is styled
 *  DISTINCTLY from RENDERED (OQ-5) so a placeholder is not mistaken
 *  for a true render. */
const TAG_CLASS: Record<RenderState, string> = {
  RENDERED: 'rendered',
  SOURCE: 'source',
  PREVIEW: 'preview',
  'NO PREVIEW': 'none',
};

function Breadcrumb({ path }: { path: string }): JSX.Element {
  const parts = path.split('/').filter((p) => p.length > 0);
  return (
    <span className="crumb">
      {parts.map((p, i) => {
        const last = i === parts.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && <span className="sl">/</span>}
            {last ? <b>{p}</b> : <span>{p}</span>}
          </Fragment>
        );
      })}
    </span>
  );
}

export function Viewer({ content }: ViewerProps): JSX.Element {
  // Empty state — reinforce the principle (FR-42).
  if (content === null) {
    return (
      <div className="pane viewer">
        <div className="viewer-head">
          <span className="crumb">no file selected</span>
        </div>
        <div className="empty-viewer">
          <div>Select a file to view it.</div>
          <div className="mono">Everything renders as something — nothing executes.</div>
        </div>
      </div>
    );
  }

  const { dispatch, meta, text, path } = content;
  const { kind, renderState, safetyBanner } = dispatch;
  const fileName = path.split('/').filter((p) => p.length > 0).pop() ?? path;

  let banner: string | null = null;
  if (safetyBanner) {
    banner =
      kind === 'svg'
        ? 'Shown as source. Loom never renders agent-authored SVG or HTML — that removes the entire sandboxed-webview problem.'
        : 'HTML is shown as source, never rendered or executed.';
  }

  let body: JSX.Element;
  if (renderState === 'RENDERED') {
    body = (
      <div
        className="md"
        // eslint-disable-next-line react/no-danger -- escaped + neutralized by lib/markdown
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text ?? '') }}
      />
    );
  } else if (renderState === 'SOURCE') {
    body = <CodeView code={text ?? ''} />;
  } else if (renderState === 'PREVIEW') {
    // Safe placeholder — NEVER a decoded image (FR-10, AC-19).
    body = (
      <div className="imgwrap">
        <div className="imgprev" role="img" aria-label={`${meta.type} safe preview placeholder`}>
          <span className="ph">{meta.type} · safe preview</span>
        </div>
      </div>
    );
  } else {
    // NO PREVIEW metadata card (FR-43).
    body = (
      <div className="noprev">
        <div className="noprev-card">
          <div className="big" aria-hidden="true">
            ∅
          </div>
          <h4>{meta.name}</h4>
          <p>Binary file — Loom won&apos;t guess at it.</p>
          <dl className="meta-grid">
            <dt>name</dt>
            <dd>{meta.name}</dd>
            <dt>size</dt>
            <dd>{meta.size}</dd>
            <dt>type</dt>
            <dd>{meta.type}</dd>
            <dt>modified</dt>
            <dd>{meta.modified}</dd>
          </dl>
        </div>
      </div>
    );
  }

  return (
    <div className="pane viewer">
      <div className="viewer-head">
        <Breadcrumb path={path} />
        <span
          className={'render-tag ' + TAG_CLASS[renderState]}
          aria-label={`render state: ${renderState}`}
          title={`${fileName} — ${renderState}`}
        >
          {renderState}
        </span>
      </div>
      <div className="viewer-body">
        {banner && (
          <div className="safety-banner" role="note">
            <ShieldIcon />
            {banner}
          </div>
        )}
        {body}
      </div>
    </div>
  );
}

export interface ViewerProps {
  /** Resolved content for the selected file, or null for empty state. */
  content: FileContent | null;
}
