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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { FileContent, RenderState } from '../../shared/types.js';
import { renderMarkdown } from '../lib/markdown.js';
import { highlightCode } from '../lib/highlight.js';
import { computeFoldRanges } from '../lib/fold.js';
import type { FoldRange } from '../lib/fold.js';

/** Close (×) glyph for the Viewer-head close control. Decorative — the
 *  accessible name comes from the button's aria-label (FR-54, FR-42). */
function CloseIcon(): JSX.Element {
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
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

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

/** Chevron glyph for a fold-header toggle. Rotated via CSS when collapsed
 *  (▾ expanded → ▸ collapsed), with the rotation honored under
 *  prefers-reduced-motion (the global override pins transition-duration).
 *  Decorative — the accessible name lives on the wrapping <button>. */
function ChevronIcon(): JSX.Element {
  return (
    <svg
      className="fold-chevron-icon"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* A downward chevron (expanded ▾). CSS rotates it -90deg when the
          header is collapsed to read as ▸. */}
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Read the capture-only `?foldall` hint (presence ⇒ start collapsed), or
 *  false when absent. Parallel to App's select/theme/chatw capture hints;
 *  read here since fold state is Viewer-local. `?foldall` (no value) or
 *  `=1`/`=true` ⇒ collapsed; `=0`/`=false` ⇒ expanded. */
function readFoldAllHint(): boolean {
  if (typeof location === 'undefined') return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return false;
  }
  if (!params.has('foldall')) return false;
  const raw = params.get('foldall');
  return raw !== '0' && raw !== 'false';
}

/** Top-level headers are those whose region is NOT nested inside another
 *  region's body. "Fold all" collapses exactly these (collapsing a parent
 *  hides its children anyway); the per-line chevrons still toggle children
 *  once a parent is expanded. */
function topLevelHeaders(ranges: readonly FoldRange[]): number[] {
  return ranges
    .filter(
      (r) =>
        !ranges.some(
          (other) => other !== r && r.start >= other.start && r.end <= other.end,
        ),
    )
    .map((r) => r.header);
}

/** Highlighted, read-only source view with honest line numbers + folding.
 *
 *  Law 1: highlightCode() still produces the per-line escaped HTML; folding
 *  ONLY hides/shows those already-rendered rows. Fold ranges are derived from
 *  the RAW text (computeFoldRanges) — never re-parsing the escaped output.
 *
 *  `path` keys the memo + resets fold state when the open file changes.
 *  `startFolded` seeds the collapsed state (capture `?foldall` / Fold-all). */
function CodeView({
  code,
  path,
  startFolded,
  registerFoldAll,
  foldCommand,
  targetLine,
}: {
  code: string;
  path: string;
  startFolded: boolean;
  /** Lets the Viewer head's Fold-all button drive this view: receives a
   *  controller exposing the current all-folded state + a toggle, or null
   *  when the file has no foldable ranges (button hidden). */
  registerFoldAll(api: { allFolded: boolean; toggleAll(): void } | null): void;
  /** A keyboard-shortcut fold command lifted from App: an incrementing nonce
   *  + intent. CodeView applies it via an effect (fold-all / unfold-all),
   *  no-op when the file has no foldable ranges. null = no command yet. */
  foldCommand: { nonce: number; intent: 'fold' | 'unfold' } | null;
  /** A "reveal line" signal from a search-result open: an incrementing nonce +
   *  the target file path + 1-based line. CodeView unfolds any collapsed region
   *  containing the line, scrolls it into view, and briefly flashes it. The
   *  path gate ignores a signal meant for a different (now-closed) file. */
  targetLine: { path: string; line: number; nonce: number } | null;
}): JSX.Element {
  // Per-line escaped display HTML — unchanged highlight path (Law 1).
  const lines = useMemo(() => highlightCode(code), [code]);
  // Fold ranges computed ONCE per file (raw text), memoized on path+code so a
  // large file does not recompute on every fold toggle / re-render.
  const ranges = useMemo(() => computeFoldRanges(code), [code]);

  // Fast lookups: header line -> its range; sorted top-level header list.
  const rangeByHeader = useMemo(() => {
    const m = new Map<number, FoldRange>();
    for (const r of ranges) m.set(r.header, r);
    return m;
  }, [ranges]);
  const tops = useMemo(() => topLevelHeaders(ranges), [ranges]);

  // Collapsed header indices. Reset whenever the file path changes; seed all
  // top-level headers when starting folded (capture hint / Fold-all on boot).
  const [folded, setFolded] = useState<Set<number>>(() =>
    startFolded ? new Set(tops) : new Set(),
  );
  // A11Y-FOLD-03 / SC 4.1.3: a terse polite status message announced whenever a
  // fold changes the visible rows, so a screen-reader user perceives the
  // MAGNITUDE of the change (N lines hidden/shown), not just the button's
  // expanded/pressed flip. Reset on file change so a stale message never lingers.
  const [status, setStatus] = useState('');
  useEffect(() => {
    setFolded(startFolded ? new Set(tops) : new Set());
    setStatus('');
    // Re-seed on a new file OR a changed fold-all intent. `tops` is derived
    // from `ranges`, which is memoized on `code`, so this keys on the file.
  }, [path, startFolded, tops]);

  const toggle = useCallback(
    (header: number): void => {
      const r = rangeByHeader.get(header);
      const count = r ? r.end - r.start + 1 : 0;
      setFolded((prev) => {
        const collapsing = !prev.has(header);
        const next = new Set(prev);
        if (collapsing) next.add(header);
        else next.delete(header);
        // Announce the change politely (A11Y-FOLD-03).
        setStatus(collapsing ? `Collapsed ${count} lines` : `Expanded ${count} lines`);
        return next;
      });
    },
    [rangeByHeader],
  );

  // A line is HIDDEN iff it lies within start..end of ANY currently-collapsed
  // header. Nesting falls out for free: a collapsed parent hides a child
  // header's own line, so the child's chevron never renders while the parent
  // is folded. Line NUMBERS are never renumbered — each visible row shows its
  // true 1-based index (i + 1).
  const hidden = useMemo(() => {
    const h = new Array<boolean>(lines.length).fill(false);
    for (const header of folded) {
      const r = rangeByHeader.get(header);
      if (!r) continue;
      for (let i = r.start; i <= r.end && i < h.length; i++) h[i] = true;
    }
    return h;
  }, [folded, rangeByHeader, lines.length]);

  // Whether ALL top-level regions are currently collapsed (drives the head
  // button's Fold-all ⇄ Unfold-all label + pressed state).
  const allFolded = tops.length > 0 && tops.every((h) => folded.has(h));

  // Expose a Fold-all controller to the Viewer head (or null when nothing is
  // foldable, so the head hides the button). Registered as an effect so the
  // parent state update happens after render, not during it.
  useEffect(() => {
    if (ranges.length === 0) {
      registerFoldAll(null);
      return;
    }
    registerFoldAll({
      allFolded,
      toggleAll(): void {
        setFolded(allFolded ? new Set() : new Set(tops));
        // A11Y-FOLD-03 / SC 4.1.3: the bulk fold-all change otherwise only
        // surfaces via the head button's aria-pressed flip; announce the
        // magnitude (how many regions) politely so AT conveys the scale.
        setStatus(
          allFolded
            ? 'Unfolded all regions'
            : `Folded all ${tops.length} ${tops.length === 1 ? 'region' : 'regions'}`,
        );
      },
    });
    // Re-register whenever the foldability or the all-folded state changes.
  }, [ranges.length, allFolded, tops, registerFoldAll]);

  // Apply a keyboard-shortcut fold command (foldAll / unfoldAll) lifted from
  // App as an incrementing nonce. Each DISTINCT nonce fires exactly once; a
  // no-op when the file has no foldable ranges (tops empty) so the shortcut is
  // harmless on markdown/image/binary code. A11Y-FOLD-03 / SC 4.1.3: announce
  // the bulk change like the head button.
  //
  // IMPORTANT: seed the "last seen" nonce from whatever command already exists
  // at MOUNT time (lazy init) so switching to a new SOURCE file does NOT re-fire
  // a stale command on it — only a command issued AFTER this CodeView mounted
  // (a fresh nonce) takes effect. The fold state itself is re-seeded on file
  // change by the effect above (path/startFolded), so a new file starts clean.
  const lastFoldNonce = useRef<number | null>(foldCommand?.nonce ?? null);
  useEffect(() => {
    if (foldCommand === null) return;
    if (lastFoldNonce.current === foldCommand.nonce) return;
    lastFoldNonce.current = foldCommand.nonce;
    if (tops.length === 0) return; // nothing foldable — harmless no-op
    if (foldCommand.intent === 'fold') {
      setFolded(new Set(tops));
      setStatus(
        `Folded all ${tops.length} ${tops.length === 1 ? 'region' : 'regions'}`,
      );
    } else {
      setFolded(new Set());
      setStatus('Unfolded all regions');
    }
  }, [foldCommand, tops]);

  // ---- Reveal a target line (search-result open) ----------------------------
  // The 0-based index of the line to flash, or null. Set when a reveal signal
  // for THIS file arrives; cleared on file change. Drives the .code-line-active
  // class so the row briefly highlights (the flash decays via CSS animation).
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  // Seed the seen-nonce so a reveal already pending FOR THIS FILE still fires on
  // mount: a search-open sets store.selectFile(path) + targetLine in one tick,
  // so by the time this CodeView mounts the nonce is already present. We must
  // NOT pre-consume it when targetLine targets THIS path (the common
  // newly-opened-file case) — only when it is a stale signal for another file.
  const lastRevealNonce = useRef<number | null>(
    targetLine && targetLine.path === path ? null : (targetLine?.nonce ?? null),
  );

  // Reset the active line whenever the open file changes. Seed the seen-nonce to
  // the CURRENT nonce ONLY when targetLine points at a DIFFERENT file (a stale
  // signal from the previously-open file); when it targets the new file, leave
  // it unconsumed so the reveal effect below fires for the fresh open.
  useEffect(() => {
    setActiveLine(null);
    lastRevealNonce.current =
      targetLine && targetLine.path === path ? null : (targetLine?.nonce ?? null);
    // Only re-run on a file change (path) — NOT on every targetLine tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Apply a reveal signal: only when it targets THIS file and is a fresh nonce.
  // Unfold any collapsed region containing the line, then mark it active +
  // scroll it into view after paint.
  useEffect(() => {
    if (targetLine === null) return;
    if (targetLine.nonce === lastRevealNonce.current) return;
    if (targetLine.path !== path) return;
    lastRevealNonce.current = targetLine.nonce;
    const lineIdx = targetLine.line - 1; // to 0-based
    if (lineIdx < 0 || lineIdx >= lines.length) return;

    // Unfold every collapsed header whose range contains the target line so the
    // row is actually visible (a line inside a collapsed fold is hidden).
    setFolded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const header of prev) {
        const r = rangeByHeader.get(header);
        if (r && lineIdx >= r.start && lineIdx <= r.end) {
          next.delete(header);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setActiveLine(lineIdx);
  }, [targetLine, path, lines.length, rangeByHeader]);

  // After the active line renders (post-unfold), scroll it into view + announce.
  useEffect(() => {
    if (activeLine === null) return;
    const raf = requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector<HTMLElement>(
        `[data-line="${activeLine}"]`,
      );
      el?.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
    setStatus(`Revealed line ${activeLine + 1}`);
    return () => cancelAnimationFrame(raf);
  }, [activeLine]);

  return (
    <div className="code" ref={containerRef}>
      {/* A11Y-FOLD-03 / SC 4.1.3: a single visually-hidden polite live region.
          Terse fold-change messages ("Collapsed N lines" / "Folded all N
          regions") are written here so AT conveys the magnitude of the change
          without interrupting (polite, never assertive). */}
      <span className="sr-only" role="status" aria-live="polite">
        {status}
      </span>
      {lines.map((l, i) => {
        if (hidden[i]) return null;
        const range = rangeByHeader.get(i);
        const collapsed = range !== undefined && folded.has(i);
        const foldable = range !== undefined;
        const hiddenCount = range ? range.end - range.start + 1 : 0;
        // A11Y-FOLD-02 / A11Y-FOLD-04 / FOLD-UX-07: both states use a self-
        // contained LINE COUNT, not a line-number range. The gutter is
        // aria-hidden, so a range like "Collapse lines 2–9" referenced a
        // coordinate system AT cannot perceive (SC 1.3.1) and the en-dash
        // pronounced inconsistently (SC 1.3.1 robustness). A count mirrors the
        // Expand label, is what the user can actually act on, and unifies the
        // two states' mental model.
        const label = collapsed
          ? `Expand ${hiddenCount} hidden lines`
          : foldable
            ? `Collapse ${hiddenCount} lines`
            : '';
        return (
          <Fragment key={i}>
            {/* Fold column: a real <button> on foldable headers, else an
                aria-hidden spacer so the gutter stays aligned. */}
            <div className="fold-col">
              {foldable ? (
                <button
                  type="button"
                  className="fold-toggle"
                  aria-expanded={!collapsed}
                  aria-label={label}
                  title={label}
                  onClick={() => toggle(i)}
                >
                  <ChevronIcon />
                </button>
              ) : (
                <span className="fold-spacer" aria-hidden="true" />
              )}
            </div>
            {/* Line-number gutter: ALWAYS the true 1-based number (folding
                never renumbers). aria-hidden — line numbers are decorative. */}
            <span className="gutter-num" aria-hidden="true">
              {i + 1}
            </span>
            {/* The escaped, highlighted source row (Law 1: display only). The
                row carries data-line (0-based index) so a search reveal can
                scroll to it, and .code-line-active briefly flashes the revealed
                line (the highlight decays via CSS). */}
            <span
              className={'ln-wrap' + (i === activeLine ? ' code-line-active' : '')}
              data-line={i}
            >
              {/* eslint-disable-next-line react/no-danger -- escaped by lib/highlight */}
              <span className="ln" dangerouslySetInnerHTML={{ __html: l }} />
              {collapsed && (
                <>
                  <span className="fold-ellipsis" aria-hidden="true">
                    {' ⋯'}
                  </span>
                  {/* FOLD-UX-06 / SC 1.3.2: sequential SR reading of the source
                      otherwise jumps from the header straight to the dedent line
                      with no in-content cue that lines were elided. A visually-
                      hidden count on the collapsed header makes the gap audible
                      without relying on the user landing on the toggle. */}
                  <span className="sr-only">{` ${hiddenCount} lines hidden`}</span>
                </>
              )}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Safe-rendered markdown body with search-result reveal (A11Y-SEARCH-01 /
 *  UX-SEARCH-01). The rendered HTML (escaped + link-neutralized by
 *  lib/markdown) carries `data-srcline` source-line attributes on its block
 *  elements; on a fresh reveal signal for THIS file we scroll the block whose
 *  source range CONTAINS the target line into view, briefly flash it, and
 *  announce "Revealed line N" to a polite live region — so the open-at-line
 *  promise holds for the most common searchable file type (.md), conveyed both
 *  visually and to assistive tech. The path gate ignores a signal meant for a
 *  now-closed file (mirrors CodeView). */
function MarkdownView({
  text,
  path,
  targetLine,
}: {
  text: string;
  path: string;
  targetLine: { path: string; line: number; nonce: number } | null;
}): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('');
  // Seed the seen-nonce so a reveal already pending FOR THIS FILE still fires on
  // mount (a search-open sets selectFile(path) + targetLine in one tick, so the
  // nonce is present by the time this mounts). Only pre-consume a STALE signal
  // aimed at a different file. Mirrors CodeView's lastRevealNonce gate.
  const lastRevealNonce = useRef<number | null>(
    targetLine && targetLine.path === path ? null : (targetLine?.nonce ?? null),
  );

  // Reset on file change: re-arm for a reveal that targets the new file, else
  // pre-consume a stale signal for the previous file.
  useEffect(() => {
    setStatus('');
    lastRevealNonce.current =
      targetLine && targetLine.path === path ? null : (targetLine?.nonce ?? null);
    // Only on a file change — not on every targetLine tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Apply a reveal signal: only when it targets THIS file and is a fresh nonce.
  // Find the block whose source range CONTAINS the target line — the LAST block
  // whose data-srcline <= target (block start lines are monotonic in document
  // order) — scroll it into view, flash it, and announce. Best-effort: if no
  // mapped block precedes the line, fall back to the first block / top.
  useEffect(() => {
    if (targetLine === null) return;
    if (targetLine.nonce === lastRevealNonce.current) return;
    if (targetLine.path !== path) return;
    lastRevealNonce.current = targetLine.nonce;
    const container = containerRef.current;
    if (!container) return;

    const raf = requestAnimationFrame(() => {
      const blocks = container.querySelectorAll<HTMLElement>('[data-srcline]');
      let target: HTMLElement | null = null;
      for (const el of blocks) {
        const srcLine = Number.parseInt(el.dataset.srcline ?? '', 10);
        if (Number.isFinite(srcLine) && srcLine <= targetLine.line) {
          target = el; // keep the last (deepest-starting) block <= the line
        } else if (Number.isFinite(srcLine) && srcLine > targetLine.line) {
          break; // past the target — the previous kept block contains it
        }
      }
      // Fall back to the first mapped block (or the container) if nothing
      // precedes the line, so the user is never left silently at the top.
      const reveal = target ?? blocks[0] ?? null;
      (reveal ?? container).scrollIntoView({ block: 'center', behavior: 'auto' });
      if (reveal) {
        // Restart the flash animation even if the same node is re-revealed.
        reveal.classList.remove('md-line-active');
        // Force reflow so removing + re-adding re-triggers the keyframes.
        void reveal.offsetWidth;
        reveal.classList.add('md-line-active');
      }
    });
    // Announce regardless so AT perceives the line position even when the
    // precise block could not be located (honest feedback, not silence).
    setStatus(`Revealed line ${targetLine.line}`);
    return () => cancelAnimationFrame(raf);
  }, [targetLine, path]);

  return (
    <div className="md-scroll" ref={containerRef}>
      {/* SC 4.1.3: a polite live region announces the revealed line so a
          screen-reader user perceives where the search match landed, matching
          the SOURCE (CodeView) reveal announcement. */}
      <span className="sr-only" role="status" aria-live="polite">
        {status}
      </span>
      <div
        className="md"
        // eslint-disable-next-line react/no-danger -- escaped + neutralized by lib/markdown
        dangerouslySetInnerHTML={{ __html: html }}
      />
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

export function Viewer({ content, onClose, foldCommand, targetLine }: ViewerProps): JSX.Element {
  // Empty state — reinforce the principle (FR-42).
  if (content === null) {
    return (
      // A11Y-CLOSE-04 / SC 1.3.1, 4.1.2: name the Viewer region so a screen-
      // reader user navigating by region can locate it, and give the empty
      // state a real heading so the "no file selected" condition is
      // programmatically conveyed — not styled text alone.
      <section className="pane viewer" aria-label="File viewer">
        <div className="viewer-head">
          <span className="crumb">no file selected</span>
          {/* UX-04: a muted right-aligned ghost chip (styled like
              .render-tag.none) keeps the header's two-ended shape stable
              between the empty and populated states. Purely decorative —
              aria-hidden so it adds no noise for AT (the empty state's name +
              live announcement already convey the state, A11Y-CLOSE-02/04). */}
          <span className="render-tag none viewer-empty-tag" aria-hidden="true">
            EMPTY
          </span>
        </div>
        <div className="empty-viewer">
          <h2 className="empty-viewer-title">No file selected</h2>
          <div>Select a file to view it.</div>
          <div className="mono">Everything renders as something — nothing executes.</div>
        </div>
      </section>
    );
  }

  // Populated state lives in a child component so its folding hooks are called
  // unconditionally (the null-guard early return above precludes hooks here).
  return (
    <ViewerContent
      content={content}
      onClose={onClose}
      foldCommand={foldCommand}
      targetLine={targetLine}
    />
  );
}

/** Populated Viewer (a file is open). Owns the SOURCE-only fold-all
 *  controller state so the head's Fold-all button can drive the CodeView. */
function ViewerContent({
  content,
  onClose,
  foldCommand,
  targetLine,
}: {
  content: FileContent;
  onClose(): void;
  foldCommand: { nonce: number; intent: 'fold' | 'unfold' } | null;
  targetLine: { path: string; line: number; nonce: number } | null;
}): JSX.Element {
  const { dispatch, meta, text, path } = content;
  const { kind, renderState, safetyBanner } = dispatch;
  const fileName = path.split('/').filter((p) => p.length > 0).pop() ?? path;

  const isSource = renderState === 'SOURCE';
  // Capture/initial fold-all intent: read once on mount; re-evaluated per file
  // so a `?foldall` capture seeds the first-opened SOURCE file collapsed.
  const startFolded = useMemo(() => (isSource ? readFoldAllHint() : false), [isSource]);

  // Controller published by the CodeView when the file has foldable ranges
  // (null otherwise → the head's Fold-all button is hidden). Stored as state
  // so the head button reflects the live all-folded label/pressed value.
  //
  // NOTE: the CodeView OWNS the lifecycle of this handle — it calls
  // registerFoldAll(null) for a non-foldable / non-SOURCE file and
  // re-registers when ranges/all-folded change. We deliberately do NOT reset
  // it from here on a file change: React runs CHILD effects before PARENT
  // effects, so a parent reset would clobber the child's fresh registration on
  // every mount and the button would never appear. Switching to a non-SOURCE
  // render state unmounts the CodeView, and `isSource` gates the button, so a
  // stale handle can never leak the control into a markdown/image/binary head.
  const [foldAll, setFoldAll] = useState<{ allFolded: boolean; toggleAll(): void } | null>(
    null,
  );

  const registerFoldAll = useCallback(
    (api: { allFolded: boolean; toggleAll(): void } | null) => {
      setFoldAll(api);
    },
    [],
  );

  let banner: string | null = null;
  if (safetyBanner) {
    banner =
      kind === 'svg'
        ? 'Shown as source. Loom never renders agent-authored SVG or HTML — that removes the entire sandboxed-webview problem.'
        : 'HTML is shown as source, never rendered or executed.';
  }

  let body: JSX.Element;
  if (renderState === 'RENDERED') {
    body = <MarkdownView text={text ?? ''} path={path} targetLine={targetLine} />;
  } else if (renderState === 'SOURCE') {
    body = (
      <CodeView
        code={text ?? ''}
        path={path}
        startFolded={startFolded}
        registerFoldAll={registerFoldAll}
        foldCommand={foldCommand}
        targetLine={targetLine}
      />
    );
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
    // Same named region as the empty state (A11Y-CLOSE-04) so the Viewer is a
    // consistently locatable landmark whether or not a file is open.
    <section className="pane viewer" aria-label="File viewer">
      <div className="viewer-head">
        <Breadcrumb path={path} />
        {/* Fold-all / Unfold-all — SOURCE files only, and only when the file
            actually has foldable regions (foldAll !== null). Hidden for
            markdown/image/binary render states. Real <button>, keyboard-
            operable, with a live pressed state so AT conveys the toggle. */}
        {isSource && foldAll && (
          <button
            type="button"
            className="fold-all-btn"
            aria-pressed={foldAll.allFolded}
            aria-label={foldAll.allFolded ? 'Unfold all regions' : 'Fold all regions'}
            title={foldAll.allFolded ? 'Unfold all' : 'Fold all'}
            onClick={() => foldAll.toggleAll()}
          >
            {foldAll.allFolded ? 'Unfold all' : 'Fold all'}
          </button>
        )}
        <span
          className={'render-tag ' + TAG_CLASS[renderState]}
          aria-label={`render state: ${renderState}`}
          title={`${fileName} — ${renderState}`}
        >
          {renderState}
        </span>
        {/* Close the open file → empty Viewer state (FR-42). Only rendered with
            a file open (this branch); the empty state below omits it. Reuses
            the .iconbtn affordances for a visible :focus-visible ring (FR-54).
            Esc is documented in the title so the keyboard path is discoverable. */}
        <button
          type="button"
          className="iconbtn viewer-close"
          aria-label="Close file"
          title="Close file (Esc)"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
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
    </section>
  );
}

export interface ViewerProps {
  /** Resolved content for the selected file, or null for empty state. */
  content: FileContent | null;
  /** Dismiss the open file → return to the empty Viewer state (FR-42).
   *  Wired to the close (×) button, only rendered when a file is open. */
  onClose(): void;
  /** Keyboard-shortcut fold command lifted from App (foldAll / unfoldAll) as
   *  an incrementing nonce + intent. CodeView applies it once per nonce;
   *  no-op when the open file is not foldable code. */
  foldCommand: { nonce: number; intent: 'fold' | 'unfold' } | null;
  /** A "reveal line" signal from a search-result open (incrementing nonce +
   *  target path + 1-based line). CodeView unfolds any region containing the
   *  line, scrolls it into view, and briefly flashes it. null = no reveal. */
  targetLine: { path: string; line: number; nonce: number } | null;
}
