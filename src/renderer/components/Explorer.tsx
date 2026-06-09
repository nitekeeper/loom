/* ============================================================
 * Loom — Explorer pane (FR-2, FR-3, FR-38, FR-39, FR-54)
 * ------------------------------------------------------------
 * Root-scoped file tree with a persistent sandbox notice (never
 * traverses above root). Surfaces live file activity via three
 * affordances (FR-39): a "NEW" badge, a transient row-flash, and a
 * persistent "just modified" dot — all driven by FileEvents folded
 * into the store.
 *
 * Accessibility (FR-54, NFR-12): the tree follows the WAI-ARIA APG
 * Tree View pattern (A11Y-05): role=tree/treeitem/group with a
 * ROVING tabindex (only the active row is in the tab order) and full
 * keyboard navigation — ArrowUp/Down to move between visible rows,
 * ArrowRight/Left to expand/collapse (or descend/ascend) a folder,
 * Home/End to jump, Enter/Space to activate. Rows remain real
 * keyboard-operable controls with a visible :focus-visible indicator;
 * the flash honors prefers-reduced-motion via CSS.
 * ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent, RefObject } from 'react';
import type { FileKind, FileNode, GitFileStatus } from '../../shared/types.js';

export interface ExplorerProps {
  rootName: string;
  tree: FileNode;
  selected: string | null;
  onSelect(path: string): void;
  /** Fetch a directory's children on expand (lazy load). Fired with the dir's
   *  root-relative path whenever the user opens a folder; the store loads its
   *  one level of children and merges them into `tree`. Idempotent in the
   *  store, so re-opening an already-loaded dir is a no-op. */
  onExpandDir?(path: string): void;
  /** Paths currently flashing (recent FileEvent). */
  flashing: ReadonlySet<string>;
  /** Paths recently changed — persistent "just modified" dot (FR-39c). */
  justModified?: ReadonlySet<string>;
  /** Paths added this session — NEW badge (FR-39a). */
  newlyAdded?: ReadonlySet<string>;
  /** Git working-tree status map (path -> status). Persists until committed. */
  gitStatus?: ReadonlyMap<string, GitFileStatus>;
  /** Open the Explorer's content-search mode (header button + Ctrl/Cmd+Shift+F).
   *  Receives the triggering button so the opener can be recorded for focus
   *  restoration on close (A11Y-SEARCH-02). */
  onOpenSearch?(opener: HTMLElement | null): void;
  /** Ref to the header search button so search-close can restore focus here
   *  even when search was opened via the keyboard command (A11Y-SEARCH-02). */
  searchBtnRef?: RefObject<HTMLButtonElement>;
}

/** Magnifier glyph for the Explorer-header search toggle. Decorative — the
 *  accessible name comes from the button's aria-label. */
function SearchIcon(): JSX.Element {
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
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/** Chip color + glyph per file kind, refined by a few extensions. */
function iconFor(node: FileNode): { bg: string; t: string } {
  const kind: FileKind = node.kind ?? 'binary';
  if (kind === 'code') {
    if (node.ext === 'json') return { bg: 'var(--a-lead)', t: '{}' };
    if (node.ext === 'ts' || node.ext === 'tsx') return { bg: 'var(--a-scout-2)', t: 'TS' };
    if (node.ext === 'txt') return { bg: 'var(--text-faint)', t: 'T' };
    return { bg: 'var(--text-faint)', t: '{}' };
  }
  switch (kind) {
    case 'md':
      return { bg: 'var(--a-scout-2)', t: 'M' };
    case 'svg':
      return { bg: 'var(--a-critic)', t: '<>' };
    case 'html':
      return { bg: 'var(--a-critic)', t: '<>' };
    case 'image':
      return { bg: 'var(--a-scribe)', t: 'IM' };
    default:
      return { bg: 'var(--text-faint)', t: 'B' };
  }
}

/** One row in the flattened, currently-VISIBLE tree (collapsed subtrees
 *  excluded). The flattened order is exactly the visual top-to-bottom order,
 *  which is what ArrowUp/Down step through (APG Tree). */
interface FlatRow {
  node: FileNode;
  depth: number;
  /** True for an expandable directory. */
  isDir: boolean;
  /** Open state for a directory row (undefined for files). */
  open?: boolean;
}

/** Flatten the tree into visible rows, honoring the `open` set. Directories
 *  default to COLLAPSED: a dir is expanded only when its path is in `open`.
 *  This keeps the rendered row list tiny on a large repo (top level only) and
 *  — paired with lazy loading — means children are never fetched or laid out
 *  until the user actually opens the folder. */
function flatten(
  roots: readonly FileNode[],
  open: ReadonlySet<string>,
  depth: number,
  out: FlatRow[],
): void {
  for (const node of roots) {
    if (node.type === 'dir') {
      const isOpen = open.has(node.path);
      out.push({ node, depth, isDir: true, open: isOpen });
      // children is undefined until the dir is lazily loaded; `?? []` keeps a
      // freshly-opened-but-not-yet-loaded dir rendering as empty until the
      // READ_DIR result arrives and repopulates it.
      if (isOpen) flatten(node.children ?? [], open, depth + 1, out);
    } else {
      out.push({ node, depth, isDir: false });
    }
  }
}

/** Fixed row height (px) — must match `.row { height }` in renderer.css. Used
 *  to window the flattened list so only on-screen rows are in the DOM. */
const ROW_H = 28;
/** Extra rows rendered above/below the viewport so fast scrolls stay smooth. */
const OVERSCAN = 8;

function FileIcon({ node }: { node: FileNode }): JSX.Element {
  const ic = iconFor(node);
  return (
    <span className="fileicon" style={{ background: ic.bg }} aria-hidden="true">
      {ic.t}
    </span>
  );
}

export function Explorer({
  rootName,
  tree,
  selected,
  onSelect,
  onExpandDir,
  flashing,
  justModified,
  newlyAdded,
  gitStatus,
  onOpenSearch,
  searchBtnRef,
}: ExplorerProps): JSX.Element {
  const jm = justModified ?? new Set<string>();
  const na = newlyAdded ?? new Set<string>();

  // Which directories are EXPANDED. Default COLLAPSED (empty set): a dir shows
  // its children only once the user opens it — so a freshly-opened repo renders
  // just its top level, and lazy loading fetches deeper levels on demand.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set<string>());
  // The roving-tabindex active row path (the single row with tabIndex 0).
  const [activePath, setActivePath] = useState<string | null>(null);

  const roots = tree.children ?? [];
  const rows: FlatRow[] = [];
  flatten(roots, open, 0, rows);
  // Stable handle to the latest rows for the (memoized) focusPath, which must
  // locate a row by path AFTER a virtualized scroll without re-creating itself.
  const rowsRef = useRef<FlatRow[]>(rows);
  rowsRef.current = rows;

  const treeRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // --- virtualization: track scroll + viewport so only on-screen rows render.
  // Defaults are generous so the FIRST paint (before refs/measurements exist)
  // still windows rather than dumping every row into the DOM — that initial
  // all-rows render is exactly what froze a large tree.
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(800);

  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const update = (): void => {
      setScrollTop(el.scrollTop);
      setViewportH(el.clientHeight);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  // Expand/collapse a directory. Opening fires onExpandDir so the store can
  // lazily fetch the dir's children (idempotent there). `want` forces a state.
  const toggleDir = useCallback(
    (path: string, want?: boolean): void => {
      // Decide from the CURRENT `open` state, read directly here — NOT from a
      // variable assigned inside the setOpen updater. React runs that updater
      // synchronously only when no state update is pending; the onClick handler
      // calls setActivePath first (a pending update) and rapid clicks pile on
      // more, so the updater gets deferred. The old code read `didOpen` from
      // inside it and thus often saw `false`, leaving onExpandDir uncalled — the
      // folder silently failed to open. Computing the decision from `open`
      // (a useCallback dep, so always current) makes expand fire every time.
      const isOpen = open.has(path);
      const shouldOpen = want === undefined ? !isOpen : want;
      if (shouldOpen !== isOpen) {
        setOpen((prev) => {
          const next = new Set(prev);
          if (shouldOpen) next.add(path);
          else next.delete(path);
          return next;
        });
      }
      // Fetch children on a real open. loadDir is idempotent (no-op if already
      // loaded / in flight), so a redundant call is harmless.
      if (shouldOpen && !isOpen) onExpandDir?.(path);
    },
    [open, onExpandDir],
  );

  // Keep the active row valid as the visible set changes (e.g. a collapse
  // hides the previously-active row). Fall back to the first row.
  const activeIndex = rows.findIndex((r) => r.node.path === activePath);
  const effectiveActive =
    activeIndex >= 0 ? activePath : (rows[0]?.node.path ?? null);

  // Set when a keyboard move targets a row that may be windowed-out of the DOM;
  // the focus effect below grabs it once it renders.
  const pendingFocusRef = useRef<string | null>(null);

  // Move focus to the row for `path` (roving tabindex). With virtualization the
  // target row may not be mounted yet, so we first scroll it into range, then
  // defer the actual .focus() to the effect that runs after the render commits.
  const focusPath = useCallback((path: string): void => {
    setActivePath(path);
    pendingFocusRef.current = path;
    const el = treeRef.current;
    const idx = rowsRef.current.findIndex((r) => r.node.path === path);
    if (el && idx >= 0) {
      const listTop = listRef.current?.offsetTop ?? 0;
      const rowTop = listTop + idx * ROW_H;
      const rowBottom = rowTop + ROW_H;
      if (rowTop < el.scrollTop) el.scrollTop = rowTop;
      else if (rowBottom > el.scrollTop + el.clientHeight) {
        el.scrollTop = rowBottom - el.clientHeight;
      }
    }
  }, []);

  // After each render, focus the pending row once it exists in the DOM.
  useEffect(() => {
    const path = pendingFocusRef.current;
    if (path === null) return;
    const el = treeRef.current?.querySelector<HTMLElement>(
      `[data-row-path="${CSS.escape(path)}"]`,
    );
    if (el) {
      el.focus();
      pendingFocusRef.current = null;
    }
  });

  const onRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, index: number): void => {
      const row = rows[index];
      if (!row) return;
      const key = e.key;

      if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
        e.preventDefault();
        if (row.isDir) toggleDir(row.node.path);
        else onSelect(row.node.path);
        return;
      }
      if (key === 'ArrowDown') {
        e.preventDefault();
        const next = rows[Math.min(index + 1, rows.length - 1)];
        if (next) focusPath(next.node.path);
        return;
      }
      if (key === 'ArrowUp') {
        e.preventDefault();
        const prev = rows[Math.max(index - 1, 0)];
        if (prev) focusPath(prev.node.path);
        return;
      }
      if (key === 'Home') {
        e.preventDefault();
        const first = rows[0];
        if (first) focusPath(first.node.path);
        return;
      }
      if (key === 'End') {
        e.preventDefault();
        const last = rows[rows.length - 1];
        if (last) focusPath(last.node.path);
        return;
      }
      if (key === 'ArrowRight') {
        e.preventDefault();
        if (row.isDir && row.open === false) {
          toggleDir(row.node.path, true); // expand
        } else if (row.isDir && row.open) {
          // Already open: move to first child (next visible row).
          const next = rows[index + 1];
          if (next && next.depth > row.depth) focusPath(next.node.path);
        }
        return;
      }
      if (key === 'ArrowLeft') {
        e.preventDefault();
        if (row.isDir && row.open) {
          toggleDir(row.node.path, false); // collapse
        } else {
          // Move to the parent row (nearest preceding row of lower depth).
          for (let i = index - 1; i >= 0; i--) {
            const candidate = rows[i];
            if (candidate && candidate.depth < row.depth) {
              focusPath(candidate.node.path);
              break;
            }
          }
        }
        return;
      }
    },
    [rows, toggleDir, onSelect, focusPath],
  );

  // If the active row was collapsed away, retarget the roving tabindex so
  // exactly one row stays tabbable.
  useEffect(() => {
    if (activeIndex < 0 && rows.length > 0) {
      const first = rows[0];
      if (first) setActivePath(first.node.path);
    }
  }, [activeIndex, rows]);

  // Virtualization window: only rows intersecting the viewport (± overscan) are
  // mounted. `.tree` is position:relative, so the list wrapper's offsetTop is
  // its distance below the scroll-content top (the sandbox notice) — subtract
  // it from scrollTop to get the scroll position WITHIN the list.
  const listOffset = listRef.current?.offsetTop ?? 0;
  const relTop = Math.max(0, scrollTop - listOffset);
  const firstVisible = Math.max(0, Math.floor(relTop / ROW_H) - OVERSCAN);
  const lastVisible = Math.min(
    rows.length,
    Math.ceil((relTop + viewportH) / ROW_H) + OVERSCAN,
  );
  const visibleRows = rows.slice(firstVisible, lastVisible);

  return (
    <div className="pane explorer">
      <div className="pane-head">
        <span style={{ color: 'var(--text-faint)' }} aria-hidden="true">
          ⊞
        </span>
        <span style={{ color: 'var(--text)', letterSpacing: '.04em' }}>EXPLORER</span>
        <span className="grow" />
        {onOpenSearch && (
          <button
            ref={searchBtnRef}
            type="button"
            className="explorer-search-btn iconbtn"
            aria-label="Search file contents"
            title="Search file contents (Ctrl/Cmd+Shift+F)"
            onClick={(e) => onOpenSearch(e.currentTarget)}
          >
            <SearchIcon />
          </button>
        )}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            textTransform: 'none',
            letterSpacing: 0,
          }}
        >
          {rootName}
        </span>
      </div>
      <div className="tree" role="tree" aria-label="File explorer" ref={treeRef}>
        <div className="sandbox-note">
          <span className="lk" aria-hidden="true">
            🔒
          </span>
          <span>
            Root is a sandbox. The explorer never traverses above{' '}
            <b style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
              {rootName}/
            </b>
            .
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="sandbox-note" style={{ color: 'var(--text-faint)' }}>
            <span>This folder is empty.</span>
          </div>
        ) : (
          <div
            ref={listRef}
            className="tree-list"
            // Full-height spacer so the scrollbar reflects ALL rows even though
            // only the visible window is mounted; each row is absolutely placed
            // at its index * ROW_H.
            style={{ position: 'relative', height: rows.length * ROW_H }}
          >
            {visibleRows.map((row, i) => {
              const index = firstVisible + i;
              const { node, depth, isDir, open } = row;
              const pad = {
                paddingLeft: 8 + depth * 14,
                position: 'absolute' as const,
                top: index * ROW_H,
                left: 0,
                right: 0,
                height: ROW_H,
              };
              // Roving tabindex: exactly one row (the active one) is tabbable.
              const tabIndex = node.path === effectiveActive ? 0 : -1;

              if (isDir) {
                return (
                  <div
                    key={node.path}
                    className="row"
                    style={pad}
                    data-row-path={node.path}
                    role="treeitem"
                    aria-expanded={open}
                    aria-label={`${node.name} folder`}
                    tabIndex={tabIndex}
                    onClick={() => {
                      setActivePath(node.path);
                      toggleDir(node.path);
                    }}
                    onFocus={() => setActivePath(node.path)}
                    onKeyDown={(e) => onRowKeyDown(e, index)}
                  >
                    <span className={'twirl' + (open ? ' open' : '')} aria-hidden="true">
                      ▶
                    </span>
                    <span
                      className="fileicon"
                      style={{ background: 'transparent', color: 'var(--text-faint)' }}
                      aria-hidden="true"
                    >
                      ▤
                    </span>
                    <span
                      className="fname"
                      style={{ fontWeight: 600, color: 'var(--text-dim)' }}
                    >
                      {node.name}
                    </span>
                  </div>
                );
              }

              const isSelected = selected === node.path;
            const isNew = na.has(node.path);
            const isFlashing = flashing.has(node.path);
            const justMod = !isNew && jm.has(node.path);
            const gitSt = gitStatus?.get(node.path) ?? null;

            // Activity suffix (NEW / just-modified / git status) for the accessible name.
            const activitySuffix = isNew
              ? ' (new)'
              : justMod
                ? ' (just modified)'
                : gitSt === 'modified'
                  ? ' (modified)'
                  : gitSt === 'added' || gitSt === 'untracked'
                    ? ' (added)'
                    : gitSt === 'staged'
                      ? ' (staged)'
                      : '';
            // UX-01 / SC 3.2.4: re-activating the open file toggles it CLOSED.
            // That toggle is otherwise silent + invisible, so the selected row
            // advertises it — a hover title and an accessible-name suffix tell
            // both sighted and AT users that activating again closes the file,
            // turning an accidental-close hazard into an intentional action.
            const rowLabel =
              node.name +
              activitySuffix +
              (isSelected ? ' (selected — activate to close)' : '');
            const rowTitle = isSelected ? `Close ${node.name}` : undefined;

            return (
              <div
                key={node.path}
                className={
                  'row' + (isSelected ? ' sel' : '') + (isFlashing ? ' flash' : '')
                }
                style={pad}
                data-row-path={node.path}
                role="treeitem"
                aria-selected={isSelected}
                aria-label={rowLabel}
                title={rowTitle}
                tabIndex={tabIndex}
                onClick={() => {
                  setActivePath(node.path);
                  onSelect(node.path);
                }}
                onFocus={() => setActivePath(node.path)}
                onKeyDown={(e) => onRowKeyDown(e, index)}
              >
                <span className="twirl" aria-hidden="true" />
                <FileIcon node={node} />
                <span className="fname">{node.name}</span>
                {isNew && <span className="badge-new">NEW</span>}
                {justMod && (
                  <span
                    className="dot-touch"
                    aria-hidden="true"
                    title="just modified by an agent"
                  />
                )}
                {gitSt === 'modified' && (
                  <span className="dot-git-modified" aria-hidden="true" title="modified (uncommitted)" />
                )}
                {(gitSt === 'added' || gitSt === 'untracked') && (
                  <span className="badge-git-added">+</span>
                )}
                {gitSt === 'staged' && (
                  <span className="badge-git-staged">S</span>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
