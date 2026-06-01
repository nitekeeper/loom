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
import type { FileKind, FileNode } from '../../shared/types.js';

export interface ExplorerProps {
  rootName: string;
  tree: FileNode;
  selected: string | null;
  onSelect(path: string): void;
  /** Paths currently flashing (recent FileEvent). */
  flashing: ReadonlySet<string>;
  /** Paths recently changed — persistent "just modified" dot (FR-39c). */
  justModified?: ReadonlySet<string>;
  /** Paths added this session — NEW badge (FR-39a). */
  newlyAdded?: ReadonlySet<string>;
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

/** Flatten the tree into visible rows, honoring the open/closed set.
 *  A directory defaults to OPEN unless its path is in `closed`. */
function flatten(
  roots: readonly FileNode[],
  closed: ReadonlySet<string>,
  depth: number,
  out: FlatRow[],
): void {
  for (const node of roots) {
    if (node.type === 'dir') {
      const open = !closed.has(node.path);
      out.push({ node, depth, isDir: true, open });
      if (open) flatten(node.children ?? [], closed, depth + 1, out);
    } else {
      out.push({ node, depth, isDir: false });
    }
  }
}

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
  flashing,
  justModified,
  newlyAdded,
  onOpenSearch,
  searchBtnRef,
}: ExplorerProps): JSX.Element {
  const jm = justModified ?? new Set<string>();
  const na = newlyAdded ?? new Set<string>();

  // Directory open/closed state lives here (was per-TreeNode useState) so the
  // flattened visible-row list — and thus arrow navigation — stays correct.
  // Default OPEN: a path is only in this set once explicitly collapsed.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set<string>());
  // The roving-tabindex active row path (the single row with tabIndex 0).
  const [activePath, setActivePath] = useState<string | null>(null);

  const roots = tree.children ?? [];
  const rows: FlatRow[] = [];
  flatten(roots, closed, 0, rows);

  const treeRef = useRef<HTMLDivElement>(null);

  const toggleDir = useCallback((path: string, want?: boolean): void => {
    setClosed((prev) => {
      const next = new Set(prev);
      const isClosed = next.has(path);
      const shouldClose = want === undefined ? !isClosed : !want;
      if (shouldClose) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  // Keep the active row valid as the visible set changes (e.g. a collapse
  // hides the previously-active row). Fall back to the first row.
  const activeIndex = rows.findIndex((r) => r.node.path === activePath);
  const effectiveActive =
    activeIndex >= 0 ? activePath : (rows[0]?.node.path ?? null);

  // Move focus to the row element for the given path (roving tabindex).
  const focusPath = useCallback((path: string): void => {
    setActivePath(path);
    const el = treeRef.current?.querySelector<HTMLElement>(
      `[data-row-path="${CSS.escape(path)}"]`,
    );
    el?.focus();
  }, []);

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
          rows.map((row, index) => {
            const { node, depth, isDir, open } = row;
            const pad = { paddingLeft: 8 + depth * 14 };
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
                  <span className="fname" style={{ fontWeight: 600, color: 'var(--text-dim)' }}>
                    {node.name}
                  </span>
                </div>
              );
            }

            const isSelected = selected === node.path;
            const isNew = na.has(node.path);
            const isFlashing = flashing.has(node.path);
            const justMod = !isNew && jm.has(node.path);

            // Activity suffix (NEW / just-modified) for the accessible name.
            const activitySuffix = isNew
              ? ' (new)'
              : justMod
                ? ' (just modified)'
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
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
