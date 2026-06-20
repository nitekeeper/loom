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
import { Fragment, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { JSX, RefObject, MouseEvent as ReactMouseEvent } from 'react';
import type { FileContent, RenderState } from '../../shared/types.js';
import { renderMarkdown } from '../lib/markdown.js';
import { highlightCode } from '../lib/highlight.js';
import { wordAt, lineIdentifiers } from '../lib/symbol-at.js';
import { columnAt, resolveSelectionSymbol } from '../lib/caret-column.js';
import { mouseEventToCombo } from '../lib/keybindings.js';
import { mouseEventDispatchButton } from '../lib/mouse-dispatch.js';
import { computeFoldRanges } from '../lib/fold.js';
import type { FoldRange } from '../lib/fold.js';
import { serializeRenderedForCopy } from '../lib/copy-serialize.js';
import type { WidthMode } from '../lib/md-width.js';

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

/** Clipboard glyph for the "Copy rendered" control. Decorative — the
 *  accessible name comes from the button's aria-label. */
function CopyIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Horizontal-arrows glyph for the reading-width toggle (a width measure
 *  stretching between two edges). House icon idiom: inline SVG, viewBox 24,
 *  stroke=currentColor, strokeWidth 2, aria-hidden — decorative; the
 *  accessible name comes from the button's visible text. */
function ReadingWidthIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m18 8 4 4-4 4" />
      <path d="m6 8-4 4 4 4" />
      <path d="M2 12h20" />
    </svg>
  );
}

/** Split-pane glyph for the split-view toggle (a rectangle divided into two
 *  columns by a vertical seam). ReadingWidthIcon idiom: inline SVG, viewBox 24,
 *  stroke=currentColor, strokeWidth 2, aria-hidden — decorative; the accessible
 *  name comes from the button's visible text. */
function SplitIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

/** Checkmark glyph shown transiently after a successful copy. Decorative. */
function CheckIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
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

/** One candidate identifier on a line, for the A11Y-GTD-01 keyboard symbol
 *  chooser: the identifier text + its 1-based start column. */
export interface SymbolChoice {
  symbol: string;
  /** 1-based start column of the identifier on its line. */
  col: number;
}

/** The result of resolving the F12 target. Either a single resolved symbol
 *  (sources 1-3, or the topmost-visible line with exactly one identifier), OR —
 *  A11Y-GTD-01, the pure-keyboard path only — the topmost-visible line with
 *  MORE THAN ONE identifier, surfaced as a chooser so a keyboard-only user can
 *  pick which symbol. */
type GotoResolution =
  | { kind: 'symbol'; symbol: string; line: number; col: number }
  | { kind: 'choices'; line: number; choices: SymbolChoice[] };

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
  gotoCommand,
  onGoToDefinition,
  onChooseSymbol,
  targetLine,
  gotoBinding,
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
  /** A "go to definition" keyboard signal lifted from App (an incrementing
   *  nonce, foldCommand idiom). On each fresh nonce this CodeView derives the
   *  symbol under the caret/selection (selection -> live caret -> lastCaret ->
   *  topmost-visible row) and calls onGoToDefinition. null when no CodeView is
   *  the active F12 consumer (GTD-1: gated to the active store/left Viewer). */
  gotoCommand: { nonce: number } | null;
  /** Resolve a symbol to its definition. Called from the F12 nonce effect AND
   *  the Ctrl/Cmd-click handler. fromPath is this file's path (advisory
   *  locality hint only; main owns every returned definition path). fromLine is
   *  the 1-based line the trigger sat on — the PRECISE caret/click line (GTD-
   *  CORR-1) used for the GTD-9 same-location short-circuit, NOT the coarse
   *  viewport-top. null when this CodeView is not the active consumer. */
  onGoToDefinition: ((symbol: string, fromPath: string, fromLine: number) => void) | null;
  /** A11Y-GTD-01: offer a SYMBOL chooser when F12 fires in the pure-keyboard
   *  path (no caret/selection) on a top line with MORE THAN ONE identifier — so
   *  a keyboard-only user can pick which symbol (pointer parity). App shows a
   *  small picker; choosing one calls onGoToDefinition. null when not the active
   *  consumer. */
  onChooseSymbol: ((choices: SymbolChoice[], fromPath: string, fromLine: number) => void) | null;
  /** A "reveal line" signal from a search-result open: an incrementing nonce +
   *  the target file path + 1-based line. CodeView unfolds any collapsed region
   *  containing the line, scrolls it into view, and briefly flashes it. The
   *  path gate ignores a signal meant for a different (now-closed) file. */
  targetLine: { path: string; line: number; nonce: number } | null;
  /** The RESOLVED goToDefinition binding (defaults merged with user override) —
   *  e.g. 'Ctrl+Click' (the default), or a KEY like 'F12' if the user rebound
   *  the slot, or another mouse combo like 'Alt+RightClick'. onCodeClick fires
   *  the jump ONLY when the click's combo (mouseEventToCombo) EQUALS this. When
   *  goToDefinition is bound to a KEY, no click combo ever equals it, so clicking
   *  never jumps (the keyboard path runs via the App dispatcher). Optional with a
   *  '' default — a non-consumer pane (onGoToDefinition===null) early-returns
   *  before ever reading it, so it is harmless there. */
  gotoBinding?: string;
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

  // ---- Go to Definition: word-under-caret/click extraction ------------------
  // The LAST known caret position inside this CodeView (1-based line + 0-based
  // column), tracked on mouseup/keyup/click so F12 in normal reading flow (no
  // live selection) still resolves a symbol. Reset on file change so a stale
  // caret from the prior file is never reused.
  const lastCaretRef = useRef<{ line: number; col: number } | null>(null);
  useEffect(() => {
    lastCaretRef.current = null;
  }, [path]);

  // Map a (DOM container node, offset) caret position to (lineText, columnOffset)
  // for THIS CodeView, or null when the caret is not inside a real source row.
  // Delegates to the PURE columnAt helper (caret-column.ts) so the error-prone
  // column math + the GTD-3 lnEl.contains guard are unit-testable under jsdom
  // (TA-3) — the production glue and the tested helper are the SAME code.
  const caretToLineCol = useCallback(
    (container: Node | null, offset: number): { line: number; col: number; lineText: string } | null => {
      const root = containerRef.current;
      if (!root) return null;
      return columnAt(root, container, offset);
    },
    [],
  );

  // Resolve the symbol the user is targeting, in priority order:
  //   1. a non-collapsed selection within ONE .ln whose trimmed text is exactly
  //      one identifier -> use it directly (precise user intent),
  //   2. the live caret if it is inside this .code,
  //   3. the lastCaretRef (F12 in reading flow with no live caret),
  //   4. the topmost VISIBLE .ln-wrap[data-line] (so F12 always does something
  //      predictable for a reader).
  // Returns { symbol, fromPath } or null (silent no-op).
  const resolveTargetSymbol = useCallback((): GotoResolution | null => {
    const root = containerRef.current;
    if (!root) return null;

    // (1) selection -> (2) live caret -> (3) lastCaret: the jsdom-reachable
    // precedence, lifted into the PURE resolveSelectionSymbol helper (TA-R2) so
    // it is unit-testable under jsdom — the production glue and the tested helper
    // are the SAME code. Returns null when none of those three resolve a symbol.
    const fromSelection = resolveSelectionSymbol(
      root,
      window.getSelection?.() ?? null,
      lastCaretRef.current,
    );
    if (fromSelection) return { kind: 'symbol', ...fromSelection };

    // (4) The topmost VISIBLE .ln-wrap[data-line] (getBoundingClientRect scan).
    // This is the PURE-KEYBOARD path (no caret/selection a keyboard-only user
    // could place). A11Y-GTD-01: when the top line has MORE THAN ONE resolvable
    // identifier, we do NOT silently take the first — we surface ALL of them as
    // a small chooser so the keyboard user can pick WHICH symbol (pointer parity:
    // Ctrl/Cmd-click already targets per-symbol). Exactly one identifier -> that
    // symbol; zero -> a clean no-op.
    const rootRect = root.getBoundingClientRect();
    const wraps = root.querySelectorAll<HTMLElement>('.ln-wrap[data-line]');
    for (const wrap of Array.from(wraps)) {
      const r = wrap.getBoundingClientRect();
      if (r.bottom <= rootRect.top) continue; // scrolled off the top
      const lnEl = wrap.querySelector<HTMLElement>('.ln');
      const lineText = lnEl?.textContent ?? '';
      const dataLine = wrap.getAttribute('data-line');
      const rowIdx = dataLine === null ? NaN : Number.parseInt(dataLine, 10);
      if (!Number.isFinite(rowIdx)) continue;
      const line = rowIdx + 1;
      // One O(n) left-to-right pass over the SAME IDENT class the highlighter
      // uses (lineIdentifiers calls wordAt per run, so keyword/literal/digit-
      // start rejection still applies). De-duped by symbol text.
      const idents = lineIdentifiers(lineText);
      if (idents.length === 0) break; // no symbol on the top line -> clean no-op
      if (idents.length === 1) {
        const w = idents[0]!;
        return { kind: 'symbol', symbol: w.symbol, line, col: w.start + 1 };
      }
      // A11Y-GTD-01: multiple identifiers, keyboard-only -> offer a chooser.
      return {
        kind: 'choices',
        line,
        choices: idents.map((w) => ({ symbol: w.symbol, col: w.start + 1 })),
      };
    }
    return null;
    // Reads only stable refs (containerRef/lastCaretRef) + module-level helpers
    // (resolveSelectionSymbol/lineIdentifiers) + window — no reactive deps. TA-R2:
    // sources 1-3 now delegate to resolveSelectionSymbol, so caretToLineCol is no
    // longer referenced here.
  }, []);

  // Track the live caret on user interaction so F12 in reading flow resolves.
  const trackCaret = useCallback((): void => {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return;
    const mapped = caretToLineCol(sel.anchorNode, sel.anchorOffset);
    if (mapped) lastCaretRef.current = { line: mapped.line, col: mapped.col };
  }, [caretToLineCol]);

  // Apply the F12 go-to-definition signal: each fresh nonce derives the symbol
  // and calls onGoToDefinition. foldCommand idiom — seed the seen-nonce at mount
  // so switching files never re-fires a stale command.
  const lastGotoNonce = useRef<number | null>(gotoCommand?.nonce ?? null);
  useEffect(() => {
    if (gotoCommand === null) return;
    if (lastGotoNonce.current === gotoCommand.nonce) return;
    lastGotoNonce.current = gotoCommand.nonce;
    if (!onGoToDefinition) return; // not the active consumer (GTD-1)
    const target = resolveTargetSymbol();
    if (!target) return; // blank/keyword/no-symbol -> clean no-op
    if (target.kind === 'choices') {
      // A11Y-GTD-01: pure-keyboard fallback on a multi-identifier top line — let
      // the user pick which symbol (pointer parity). Falls back to resolving the
      // first symbol directly if App did not wire the chooser.
      if (onChooseSymbol) {
        onChooseSymbol(target.choices, path, target.line);
      } else {
        const first = target.choices[0]!;
        onGoToDefinition(first.symbol, path, target.line);
      }
      return;
    }
    // GTD-CORR-1: pass the PRECISE trigger line so the same-location short-
    // circuit compares against where the caret actually is, not the viewport top.
    onGoToDefinition(target.symbol, path, target.line);
  }, [gotoCommand, onGoToDefinition, onChooseSymbol, resolveTargetSymbol, path]);

  // BINDING-AWARE go-to-definition click (IDE/VS-Code style). The click's combo
  // (mouseEventToCombo) is fired ONLY when it equals the RESOLVED goToDefinition
  // binding (gotoBinding) — 'Ctrl+Click' by default, or any mouse combo the user
  // rebound the slot to (e.g. 'Alt+RightClick'). When goToDefinition is bound to
  // a KEY (e.g. F12), the click's combo is a mouse string that never equals the
  // key string, so clicking never jumps (the keyboard path runs in the App
  // dispatcher). Maps the click point to a caret via caretRangeFromPoint
  // (Electron/Chromium), with a caretPositionFromPoint fallback, then derives the
  // symbol via wordAt.
  //
  // SINGLE-SOURCE right button: wired to onClick (primary), onAuxClick (MIDDLE
  // only — a right-button auxclick is dropped below), and onContextMenu (right).
  // The contextmenu event's e.button is unreliable across engines, so it is
  // normalized to 2. This guarantees a right-button gesture fires exactly once
  // (via onContextMenu), never twice (auxclick + contextmenu).
  const onCodeClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      if (!onGoToDefinition) return; // not the active consumer
      // SINGLE-SOURCE button routing (shared mouse-dispatch helper — the SAME
      // rule the App document dispatcher uses, pinned by the unit suite).
      // onAuxClick owns the MIDDLE button only; a right-button auxclick is
      // dropped so onContextMenu is the sole right-button source. contextmenu's
      // e.button is unreliable across engines -> normalized to 2. A null result
      // means SKIP this event.
      const button = mouseEventDispatchButton(
        e.type as 'click' | 'auxclick' | 'contextmenu',
        e.button,
      );
      if (button === null) return;
      const combo = mouseEventToCombo({
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        button,
      });
      if (combo !== gotoBinding) return; // only the exact resolved mouse combo jumps
      // Resolve the caret under the pointer.
      type CaretFromPoint = {
        caretRangeFromPoint?(x: number, y: number): { startContainer: Node; startOffset: number } | null;
        caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
      };
      const doc = document as Document & CaretFromPoint;
      let container: Node | null = null;
      let offset = 0;
      if (typeof doc.caretRangeFromPoint === 'function') {
        const r = doc.caretRangeFromPoint(e.clientX, e.clientY);
        if (r) {
          container = r.startContainer;
          offset = r.startOffset;
        }
      } else if (typeof doc.caretPositionFromPoint === 'function') {
        const p = doc.caretPositionFromPoint(e.clientX, e.clientY);
        if (p) {
          container = p.offsetNode;
          offset = p.offset;
        }
      }
      const mapped = caretToLineCol(container, offset);
      if (!mapped) return;
      const w = wordAt(mapped.lineText, mapped.col);
      if (!w) return; // whitespace/punct/keyword -> no-op
      // A go-to-definition click on a symbol should not also drop a text
      // selection — and for a RightClick binding this same preventDefault
      // suppresses the native context menu. It also sets defaultPrevented so the
      // App-level bubble mouse dispatcher bails (belt-and-suspenders with the
      // positional skip). A non-matching click returns ABOVE without
      // preventDefault, so a normal right-click still shows the native menu.
      e.preventDefault();
      // GTD-CORR-1: the click's own line is the precise trigger line.
      onGoToDefinition(w.symbol, path, mapped.line);
    },
    [onGoToDefinition, caretToLineCol, path, gotoBinding],
  );

  return (
    <div
      className="code"
      ref={containerRef}
      // GTD-2: focusable so F12 works in reading flow (and so the topmost-line
      // fallback has a deterministic home). The picker/dispatcher restore focus
      // here on Escape.
      tabIndex={0}
      // A11Y-GTD-03 (SC 4.1.2 / 1.3.1): the newly-focusable .code is a tab stop,
      // so it MUST have a programmatic role + accessible name. role="group"
      // bundles the source rows; aria-label names which file's source this is
      // (terse — just the basename, the parent region already says "File
      // viewer"); aria-roledescription surfaces the F12 affordance so a screen
      // reader landing here announces "Source code, <file>" plus the available
      // command instead of a bare "group". KEYBOARD-OP NOTE (A11Y-GTD-02): the
      // source view is non-editable, so a pure keyboard user cannot position a
      // caret/selection on a chosen symbol; F12 then falls back to the first
      // identifier on the topmost VISIBLE line (resolveTargetSymbol source 4).
      // The command stays operable (not a total SC 2.1.1 failure); choosing
      // among multiple identifiers without a pointer is a documented v1 limit,
      // tracked as a follow-up to extend the picker over a line's identifiers.
      //
      // BINDING NOTE: Ctrl/Cmd-click is the DEFAULT *mouse* binding for go-to-
      // definition (rebindable like any command), while F12 is the FIXED, always-
      // on keyboard affordance (handled in the App dispatcher). The
      // aria-roledescription keeps "press F12" because F12 is the stable
      // keyboard path a screen-reader user can always rely on, regardless of how
      // the mouse slot is rebound — so the label stays factually correct.
      role="group"
      aria-label={`Source code: ${path.split('/').filter(Boolean).pop() ?? path}`}
      aria-roledescription="Source code (press F12 to go to definition)"
      onMouseUp={trackCaret}
      onKeyUp={trackCaret}
      // SINGLE-SOURCE mouse wiring so MiddleClick/RightClick goToDefinition
      // bindings work (React onClick fires only for the primary button):
      // onClick owns primary, onAuxClick owns MIDDLE only (onCodeClick drops a
      // right-button auxclick), onContextMenu owns right (and onCodeClick's
      // preventDefault on a real jump suppresses the native menu). A non-matching
      // click on any of them returns without preventDefault, so normal
      // selection / middle-paste / the native context menu are untouched.
      onClick={onGoToDefinition ? onCodeClick : undefined}
      onAuxClick={onGoToDefinition ? onCodeClick : undefined}
      onContextMenu={onGoToDefinition ? onCodeClick : undefined}>
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
/** Imperative handle the Viewer head's "Copy rendered" button + the
 *  copyRendered keyboard shortcut invoke. Serializes the LIVE .md DOM (so a
 *  rendered mermaid SVG is captured) into a cleaned, portable {html, text} pair
 *  and writes it to the clipboard via the preload bridge. Resolves to true on a
 *  successful copy, false otherwise (so the head can show a transient state). */
export interface MarkdownCopyHandle {
  copyRendered(): Promise<boolean>;
}

function MarkdownView({
  text,
  path,
  targetLine,
  copyRef,
}: {
  text: string;
  path: string;
  targetLine: { path: string; line: number; nonce: number } | null;
  /** Lifted so the Viewer head + the keyboard shortcut can trigger a copy of
   *  the live rendered content. */
  copyRef: RefObject<MarkdownCopyHandle | null>;
}): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const containerRef = useRef<HTMLDivElement>(null);
  // The .md element that owns the injected HTML (the dangerouslySetInnerHTML
  // sink). mermaid diagrams live inside it; we scan it after each (re)inject.
  const mdRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('');
  // Seed the seen-nonce so a reveal already pending FOR THIS FILE still fires on
  // mount (a search-open sets selectFile(path) + targetLine in one tick, so the
  // nonce is present by the time this mounts). Only pre-consume a STALE signal
  // aimed at a different file. Mirrors CodeView's lastRevealNonce gate.
  const lastRevealNonce = useRef<number | null>(
    targetLine && targetLine.path === path ? null : (targetLine?.nonce ?? null),
  );

  // Expose the copy action to the Viewer head + the keyboard shortcut. Serialize
  // the LIVE .md container's innerHTML (captures any runtime-rendered mermaid
  // SVG), produce the cleaned portable {html, text}, and hand it to main through
  // the preload bridge (the renderer NEVER touches the OS clipboard directly).
  useImperativeHandle(
    copyRef,
    () => ({
      async copyRendered(): Promise<boolean> {
        const host = mdRef.current;
        if (!host) return false;
        try {
          const payload = serializeRenderedForCopy(host.innerHTML);
          // main is authoritative: it RE-VALIDATES the shape + bounds the size
          // and resolves false when the write was DROPPED (oversize / bad
          // shape). Reflect that real outcome so runCopy never shows a
          // false-positive "Copied" affordance for content that wasn't written.
          return await window.loom.copyToClipboard(payload);
        } catch {
          return false;
        }
      },
    }),
    [],
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

  // ---- mermaid: upgrade diagram placeholders AFTER the HTML is injected ------
  // Keyed on the injected HTML so it re-runs whenever the rendered content
  // changes (new file, edited file). It does nothing — and never loads the heavy
  // mermaid bundle — unless the freshly-injected HTML actually contains a
  // `.mermaid-diagram` placeholder, keeping non-diagram files on the hot path.
  //
  // LAZY CHUNK: mermaid (~7-8MB) is NOT in renderer.js. We dynamic-import the
  // mermaid-FREE loader (lib/mermaid-loader.ts), then ensureMermaid() injects the
  // SEPARATE dist/mermaid.js as a same-origin classic <script> on first use and
  // resolves the render API. The loader has no static mermaid import, so the
  // renderer IIFE (which esbuild cannot code-split) stays mermaid-free; mermaid
  // also never enters the shared testkit bundle.
  //
  // Cancellation (Law-1-adjacent correctness): mermaid.render is async; if the
  // user switches files mid-render, the cleanup flips `cancelled` so the loop in
  // renderMermaidIn bails BEFORE writing a stale SVG into the new file's DOM.
  useEffect(() => {
    const host = mdRef.current;
    if (!host) return;
    // Cheap synchronous gate: skip the loader entirely when there is no diagram
    // to render (the overwhelmingly common case).
    if (host.querySelector('.mermaid-diagram') === null) return;

    let cancelled = false;
    void import('../lib/mermaid-loader.js')
      .then(({ ensureMermaid }) => {
        if (cancelled) return;
        // Inject + load dist/mermaid.js on first use; resolves the render API.
        return ensureMermaid().then((api) => {
          if (cancelled) return;
          return api.renderMermaidIn(host, { isCancelled: () => cancelled });
        });
      })
      // Swallow a chunk-load / render failure: the escaped code-block fallback is
      // already on screen, so a failure degrades gracefully (Law 1 safe). This now
      // ALSO covers the new path where dist/mermaid.js itself fails to load —
      // ensureMermaid() rejects, we keep the fallback, and the app never breaks.
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [html]);

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
        ref={mdRef}
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

export function Viewer({
  content,
  onClose,
  foldCommand,
  copyCommand,
  gotoCommand,
  onGoToDefinition,
  onChooseSymbol,
  targetLine,
  gotoBinding,
  mdWidth,
  onToggleMdWidth,
  splitView,
  onToggleSplit,
  splitRole,
  splitActive,
  onActivate,
}: ViewerProps): JSX.Element {
  // Shared split-pane wiring for BOTH the empty and populated <section>s: the
  // split-pane modifier classes (role + active accent border) and the activate
  // handler (a pointer-down / focus-in on the pane makes it the active one so
  // the next Explorer pick lands here). No-ops when not rendered in a split.
  const splitClass = splitRole
    ? ` viewer-split-pane viewer-pane-${splitRole}` + (splitActive ? ' active' : '')
    : '';
  const activateProps = splitRole
    ? { onPointerDownCapture: onActivate, onFocusCapture: onActivate }
    : {};
  // A11Y: in a split, give each file pane a DISTINCT accessible name (so an AT
  // user can tell the two "File viewer" regions apart) AND a programmatic active
  // marker (aria-current) that tracks which pane the next Explorer pick fills —
  // the accent ring is then not the ONLY active cue (SC 1.3.1/1.4.1). The single
  // (non-split) pane keeps the plain name + no aria-current, byte-for-byte
  // today's. The diff (ChangesView) pane is intentionally NOT a doc target, so
  // it gets none of this. Computed once, shared by the empty + populated headers.
  // aria-current uses the "location" token (the defined "this is the current
  // location / you are here" value), NOT the bare boolean form: this <section> is
  // a region landmark (it carries an aria-label), and aria-current="true" on a
  // landmark is non-standard usage that some AT announce oddly — "location" is the
  // closest defined token for "the active reading pane" and maps cleanly (a-nit).
  const paneAriaProps = splitRole
    ? {
        'aria-label':
          splitRole === 'left' ? 'File viewer (left pane)' : 'File viewer (right pane)',
        'aria-current': splitActive ? ('location' as const) : undefined,
      }
    : { 'aria-label': 'File viewer' };

  // Empty state — reinforce the principle (FR-42).
  if (content === null) {
    return (
      // A11Y-CLOSE-04 / SC 1.3.1, 4.1.2: name the Viewer region so a screen-
      // reader user navigating by region can locate it, and give the empty
      // state a real heading so the "no file selected" condition is
      // programmatically conveyed — not styled text alone.
      // data-mdwidth is applied here too (as on the populated branch) so the
      // CSS measure is governed consistently regardless of which branch renders.
      <section
        className={'pane viewer' + splitClass}
        data-mdwidth={mdWidth}
        {...paneAriaProps}
        {...activateProps}
      >
        <div className="viewer-head">
          <span className="crumb">no file selected</span>
          {/* The DEFAULT single-pane empty state is byte-for-byte today's (just
              the breadcrumb + EMPTY ghost chip) — a DELIBERATE constraint (spec:
              "single doc … must behave EXACTLY as before"). So the reading-width
              + Split toggles are omitted here intentionally; entering the split
              with no file open stays reachable via the rebindable Ctrl/Cmd+\
              command (and is listed in the Shortcuts panel with its live
              binding). Consequence for App.closeSplit's focus rescue: when split
              closes onto an EMPTY single pane, `.pane.viewer .split-view-btn` has
              no match, so the rescue falls through to the Explorer's active
              treeitem (then document.body) — a valid, non-stranding target. Only
              WHEN this empty pane is part of a split do the toggles appear, so a
              comparison pane can be opened/closed before a file is picked. */}
          {splitRole && (
            <ViewerHeadToggles
              mdWidth={mdWidth}
              onToggleMdWidth={onToggleMdWidth}
              splitView={splitView}
              onToggleSplit={onToggleSplit}
              splitRole={splitRole}
            />
          )}
          {/* UX-04: a muted right-aligned ghost chip (styled like
              .render-tag.none) keeps the header's two-ended shape stable
              between the empty and populated states. Purely decorative —
              aria-hidden so it adds no noise for AT (the empty state's name +
              live announcement already convey the state, A11Y-CLOSE-02/04). */}
          <span className="render-tag none viewer-empty-tag" aria-hidden="true">
            EMPTY
          </span>
          {/* The split RIGHT pane keeps a close (×) even when empty so the
              comparison pane can be dismissed (turns split off) before a file
              is picked. onClose for the right pane is App's closeSplit. */}
          {splitRole === 'right' && (
            <button
              type="button"
              className="iconbtn viewer-close viewer-close-split"
              aria-label="Close split reading pane"
              title="Close split reading pane"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          )}
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
      copyCommand={copyCommand}
      gotoCommand={gotoCommand}
      onGoToDefinition={onGoToDefinition}
      onChooseSymbol={onChooseSymbol}
      targetLine={targetLine}
      gotoBinding={gotoBinding}
      mdWidth={mdWidth}
      onToggleMdWidth={onToggleMdWidth}
      splitView={splitView}
      onToggleSplit={onToggleSplit}
      splitRole={splitRole}
      splitClass={splitClass}
      activateProps={activateProps}
      paneAriaProps={paneAriaProps}
    />
  );
}

/** The Viewer head's reading-width + split toggle buttons — shared verbatim by
 *  the empty and populated headers so the two surfaces never diverge. Both are
 *  GLOBAL toggles (sticky across files), so they render on EVERY content type. */
function ViewerHeadToggles({
  mdWidth,
  onToggleMdWidth,
  splitView,
  onToggleSplit,
  splitRole,
}: {
  mdWidth: WidthMode;
  onToggleMdWidth(): void;
  splitView: boolean;
  onToggleSplit(): void;
  /** This pane's split role, when rendered inside a split — disambiguates the
   *  otherwise-identical Split toggle so an AT user can tell the two panes'
   *  buttons apart. undefined for the single pane (constant name = visible
   *  text). */
  splitRole?: 'left' | 'right';
}): JSX.Element {
  return (
    <>
      {/* Reading-width quick toggle — flips the reading column fit↔full for
          EVERY content type (the data-mdwidth attribute on the <section>
          governs both the .md and the .code measure). ARIA: a TOGGLE button
          whose constant accessible name is its visible text ("Full width" —
          SC 2.5.3 label-in-name), aria-pressed=true ⇒ FULL-WIDTH IS ON. */}
      <button
        type="button"
        className="reading-width-btn"
        aria-pressed={mdWidth === 'full'}
        title={`Reading width: ${
          mdWidth === 'full' ? 'full' : 'fixed (120 ch)'
        } (Ctrl/Cmd+Shift+W)`}
        onClick={() => onToggleMdWidth()}
      >
        <ReadingWidthIcon />
        <span>Full width</span>
      </button>
      {/* Split reading pane toggle — opens/closes the side-by-side compare
          pane. Mirrors the reading-width-btn idiom (real <button>, keyboard-
          operable, shortcut in the title). ARIA: a TOGGLE button; in the single
          pane its accessible name IS its visible text ("Split" — SC 2.5.3
          label-in-name). In a split BOTH panes render this button, so it carries
          a per-pane aria-label ("Split reading pane (left/right pane)") to keep
          the two distinguishable for AT navigation — the visible word "Split"
          stays a substring so label-in-name (SC 2.5.3) still holds.
          aria-pressed=true ⇒ split IS ON. Shared with the rebindable Ctrl/Cmd+\\
          command. */}
      <button
        type="button"
        className="split-view-btn"
        aria-pressed={splitView}
        aria-label={
          splitRole
            ? `Split reading pane (${splitRole} pane)`
            : undefined
        }
        title={`Split reading pane: ${splitView ? 'on' : 'off'} (Ctrl/Cmd+\\)`}
        onClick={() => onToggleSplit()}
      >
        <SplitIcon />
        <span>Split</span>
      </button>
    </>
  );
}

/** Populated Viewer (a file is open). Owns the SOURCE-only fold-all
 *  controller state so the head's Fold-all button can drive the CodeView. */
function ViewerContent({
  content,
  onClose,
  foldCommand,
  copyCommand,
  gotoCommand,
  onGoToDefinition,
  onChooseSymbol,
  targetLine,
  gotoBinding,
  mdWidth,
  onToggleMdWidth,
  splitView,
  onToggleSplit,
  splitRole,
  splitClass,
  activateProps,
  paneAriaProps,
}: {
  content: FileContent;
  onClose(): void;
  foldCommand: { nonce: number; intent: 'fold' | 'unfold' } | null;
  copyCommand: { nonce: number } | null;
  /** Go-to-definition F12 signal (nonce) — threaded to the CodeView. null when
   *  this Viewer is not the active F12 consumer (GTD-1). */
  gotoCommand: { nonce: number } | null;
  /** Resolve a symbol to its definition (F12 + Ctrl/Cmd-click). The third arg
   *  is the 1-based trigger line (GTD-CORR-1). null when this Viewer is not the
   *  active go-to-definition consumer. */
  onGoToDefinition: ((symbol: string, fromPath: string, fromLine: number) => void) | null;
  /** A11Y-GTD-01 keyboard symbol chooser (multi-identifier top line). null when
   *  not the active consumer. */
  onChooseSymbol: ((choices: SymbolChoice[], fromPath: string, fromLine: number) => void) | null;
  targetLine: { path: string; line: number; nonce: number } | null;
  /** Resolved goToDefinition binding — threaded to CodeView's binding-aware
   *  onCodeClick. Optional ('' default); non-consumer panes ignore it. */
  gotoBinding?: string;
  mdWidth: WidthMode;
  onToggleMdWidth(): void;
  splitView: boolean;
  onToggleSplit(): void;
  splitRole?: 'left' | 'right';
  /** Precomputed split modifier classes (role + active accent border). */
  splitClass: string;
  /** Precomputed activate handlers (pointer-down / focus-in), or {} when not
   *  rendered in a split. */
  activateProps: {
    onPointerDownCapture?(): void;
    onFocusCapture?(): void;
  };
  /** Precomputed pane accessible name + active marker (aria-label per-pane in a
   *  split, aria-current on the active one) — shared verbatim with the empty
   *  header so the two surfaces never diverge. */
  paneAriaProps: {
    'aria-label': string;
    'aria-current'?: 'location';
  };
}): JSX.Element {
  const { dispatch, meta, text, path } = content;
  const { kind, renderState, safetyBanner } = dispatch;
  const fileName = path.split('/').filter((p) => p.length > 0).pop() ?? path;

  const isSource = renderState === 'SOURCE';
  // RENDERED markdown is the ONLY copyable render state (scope: the Viewer .md
  // file only). The MarkdownView publishes its copy handle here so the head
  // button + the keyboard shortcut can trigger a copy of the live content.
  const isRendered = renderState === 'RENDERED';
  const copyHandleRef = useRef<MarkdownCopyHandle | null>(null);
  // Transient "Copied" affordance: flips the button label + announces politely
  // for ~1.5s after a successful copy, then reverts. Cleared on file change.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runCopy = useCallback(async (): Promise<void> => {
    const ok = await copyHandleRef.current?.copyRendered();
    if (!ok) return;
    setCopied(true);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      copyTimer.current = null;
    }, 1500);
  }, []);

  // Reset the transient state + cancel any pending revert when the file changes
  // or the component unmounts (no stale "Copied" carries to the next file).
  useEffect(() => {
    setCopied(false);
    return () => {
      if (copyTimer.current !== null) {
        clearTimeout(copyTimer.current);
        copyTimer.current = null;
      }
    };
  }, [path]);

  // Apply the copyRendered keyboard-shortcut command lifted from App: an
  // incrementing nonce fires the copy exactly once per press. Only meaningful
  // for a RENDERED file (the handle is null otherwise — a harmless no-op). Seed
  // the seen-nonce from whatever exists at mount so switching to a new file does
  // NOT replay a stale command.
  const lastCopyNonce = useRef<number | null>(copyCommand?.nonce ?? null);
  useEffect(() => {
    if (copyCommand === null) return;
    if (lastCopyNonce.current === copyCommand.nonce) return;
    lastCopyNonce.current = copyCommand.nonce;
    if (!isRendered) return; // nothing to copy — harmless no-op
    void runCopy();
  }, [copyCommand, isRendered, runCopy]);

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
    body = (
      <MarkdownView
        text={text ?? ''}
        path={path}
        targetLine={targetLine}
        copyRef={copyHandleRef}
      />
    );
  } else if (renderState === 'SOURCE') {
    const codeView = (
      <CodeView
        code={text ?? ''}
        path={path}
        startFolded={startFolded}
        registerFoldAll={registerFoldAll}
        foldCommand={foldCommand}
        gotoCommand={gotoCommand}
        onGoToDefinition={onGoToDefinition}
        onChooseSymbol={onChooseSymbol}
        targetLine={targetLine}
        gotoBinding={gotoBinding}
      />
    );
    body = dispatch.kind === 'svg' && content.imageData ? (
      <>
        <div className="svg-preview-wrap">
          <img
            src={content.imageData}
            alt={`${fileName} preview`}
            className="img-preview"
          />
        </div>
        {codeView}
      </>
    ) : codeView;
  } else if (renderState === 'PREVIEW') {
    body = content.imageData ? (
      <div className="imgwrap">
        <img
          src={content.imageData}
          alt={fileName}
          className="img-preview"
        />
      </div>
    ) : (
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
    // consistently locatable landmark whether or not a file is open. In a
    // split, splitClass adds the role + active accent border, and activateProps
    // makes a pointer-down / focus-in here select this pane as the active one.
    <section
      className={'pane viewer' + splitClass}
      data-mdwidth={mdWidth}
      {...paneAriaProps}
      {...activateProps}
    >
      <div className="viewer-head">
        <Breadcrumb path={path} />
        {/* Copy rendered — RENDERED (.md) files only. Copies the CLEANED,
            PORTABLE rendered content (formatted html + plaintext fallback) to
            the clipboard via the preload bridge so it pastes formatted into
            Jira/Confluence/Docs/email. A transient "Copied" affordance + a
            polite live announcement confirm success for ~1.5s. Real <button>,
            keyboard-operable, reusing the .fold-all-btn affordances. */}
        {isRendered && (
          <button
            type="button"
            className={'copy-rendered-btn' + (copied ? ' copied' : '')}
            aria-label="Copy rendered content to clipboard"
            title="Copy rendered (Ctrl/Cmd+Shift+C)"
            onClick={() => void runCopy()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span>{copied ? 'Copied' : 'Copy rendered'}</span>
          </button>
        )}
        {/* Reading-width + split-view quick toggles (every content type) —
            shared verbatim with the empty header (ViewerHeadToggles) so the two
            surfaces never diverge. Both are GLOBAL, sticky toggles, so they
            render on EVERY render state and keep a stable header position. */}
        <ViewerHeadToggles
          mdWidth={mdWidth}
          onToggleMdWidth={onToggleMdWidth}
          splitView={splitView}
          onToggleSplit={onToggleSplit}
          splitRole={splitRole}
        />
        {/* SC 4.1.3: announce the successful copy politely so the action is
            perceivable to assistive tech regardless of focus location. */}
        <span className="sr-only" role="status" aria-live="polite">
          {copied ? 'Rendered content copied to clipboard' : ''}
        </span>
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
        {/* Close affordance. For the single pane (and the split LEFT pane) this
            closes the open file → empty Viewer state (FR-42); Esc is documented
            in the title. For the split RIGHT pane it turns split OFF and returns
            to the single pane (spec §7) — a distinct accessible name so AT
            conveys the different outcome. Reuses the .iconbtn affordances for a
            visible :focus-visible ring (FR-54). */}
        <button
          type="button"
          className={
            'iconbtn viewer-close' + (splitRole === 'right' ? ' viewer-close-split' : '')
          }
          aria-label={splitRole === 'right' ? 'Close split reading pane' : 'Close file'}
          title={splitRole === 'right' ? 'Close split reading pane' : 'Close file (Esc)'}
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
  /** Keyboard-shortcut copy command lifted from App (copyRendered) as an
   *  incrementing nonce. ViewerContent copies the rendered content once per
   *  nonce; no-op when the open file is not RENDERED markdown. */
  copyCommand: { nonce: number } | null;
  /** Keyboard-shortcut go-to-definition command lifted from App (goToDefinition,
   *  F12) as an incrementing nonce. The active CodeView derives the symbol under
   *  the caret/selection on each fresh nonce and calls onGoToDefinition. null
   *  when this Viewer is NOT the active F12 consumer (GTD-1: gated to the active
   *  store/left/single Viewer so exactly one CodeView consumes F12). */
  gotoCommand: { nonce: number } | null;
  /** Resolve a symbol to its definition (the F12 nonce effect AND the
   *  Ctrl/Cmd-click handler call this). The third arg is the 1-based trigger
   *  line (GTD-CORR-1). null when this Viewer is not the active go-to-definition
   *  consumer — then F12/Ctrl-click are inert here. */
  onGoToDefinition: ((symbol: string, fromPath: string, fromLine: number) => void) | null;
  /** A11Y-GTD-01: offer a SYMBOL chooser when F12 fires with no caret/selection
   *  (pure-keyboard path) on a top line with MORE THAN ONE identifier, so a
   *  keyboard-only user can pick which symbol (pointer parity with Ctrl/Cmd-
   *  click). null when this Viewer is not the active F12 consumer. */
  onChooseSymbol: ((choices: SymbolChoice[], fromPath: string, fromLine: number) => void) | null;
  /** A "reveal line" signal from a search-result open (incrementing nonce +
   *  target path + 1-based line). CodeView unfolds any region containing the
   *  line, scrolls it into view, and briefly flashes it. null = no reveal. */
  targetLine: { path: string; line: number; nonce: number } | null;
  /** The RESOLVED goToDefinition binding (defaults merged with the user
   *  override) — e.g. 'Ctrl+Click' (default), 'F12'/any key if rebound to a key,
   *  or another mouse combo. CodeView's binding-aware onCodeClick fires the jump
   *  only when the click's combo equals this. OPTIONAL ('' default) so the
   *  non-consumer panes (onGoToDefinition===null) are unaffected — they
   *  early-return before reading it. */
  gotoBinding?: string;
  /** Viewer reading-column width mode, lifted to App (seeded from the capture
   *  hint > localStorage > default via md-width.ts and persisted on change).
   *  Applied as data-mdwidth on the Viewer <section> so the CSS picks the
   *  predefined 120ch measure ('fit') or full Viewer width ('full') for BOTH
   *  the rendered .md column and the source-code .code grid. */
  mdWidth: WidthMode;
  /** Flip the reading-width mode fit↔full (the App-owned quick toggle, shared
   *  with the rebindable Ctrl/Cmd+Shift+W command — persists + announces).
   *  Wired to the header reading-width button. */
  onToggleMdWidth(): void;
  /** Whether the split reading pane (side-by-side compare) is ON. Drives the
   *  header split-toggle button's aria-pressed. Default false ⇒ single pane. */
  splitView: boolean;
  /** Toggle the split reading pane on/off (the App-owned toggle, shared with
   *  the rebindable Ctrl/Cmd+\\ command). Wired to the header split button. */
  onToggleSplit(): void;
  /** This Viewer's role when rendered inside the split — 'left' or 'right' —
   *  or undefined for the single (non-split) pane. Drives the active-pane
   *  visual indicator + activation wiring. */
  splitRole?: 'left' | 'right';
  /** True when this split pane is the ACTIVE one (an Explorer selection opens
   *  here). Paints the subtle accent active border. Ignored when not split. */
  splitActive?: boolean;
  /** Make this split pane the active one (on click / focus-in). Ignored when
   *  not split. */
  onActivate?(): void;
}
