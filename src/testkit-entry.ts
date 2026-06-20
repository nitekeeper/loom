/* ============================================================
 * Loom — testkit entry (bundled to dist/testkit.cjs by build.mjs)
 * ------------------------------------------------------------
 * A single CommonJS bundle the acceptance suite (test/acceptance.mjs)
 * requires to exercise the backend WITHOUT Electron. It re-exports the
 * pure, Electron-free building blocks:
 *
 *   createDb       — sql.js store (locates sql-wasm.wasm + schema.sql
 *                    via __dirname, so testkit.cjs MUST sit in dist/
 *                    beside those assets).
 *   createEngine   — the 10 tools as pure fns over (db, bus).
 *   createEventBus — in-process pub/sub for LoomEvent.
 *   kindOf,
 *   dispatchFor    — the canonical file-dispatch table (ext -> kind ->
 *                    render-state), for dispatch/safety assertions.
 *
 * Author as ESM; esbuild emits CJS (platform=node, external electron).
 * ============================================================ */
export { createDb } from './main/db.js';
export type { LoomDb } from './main/db.js';
export { createEngine } from './main/engine.js';

// HUMAN roster curation helpers (IPC-only, NOT MCP tools): the pure fns the
// REMOVE_AGENT / CLEAR_STALE_AGENTS handlers call. Re-exported so the
// agent-remove suite can pin re-validation, the 'gone' AgentEvent publish,
// the preserved-history delete semantics, the stale definition (gone ∪
// active-without-live-session), and the NOT_REGISTERED session ending —
// Electron-free.
export { removeAgentByName, clearStaleAgents, isStaleAgent } from './main/engine.js';
export { createEventBus } from './main/eventbus.js';
export type { EventBus, EventHandler } from './main/eventbus.js';
export { kindOf, dispatchFor, extensionOf } from './shared/dispatch.js';

// Electron-free main-process git-diff layer (the "Changes" viewer). The PURE
// parsers (parseNameStatusZ/parseUnifiedDiff) are the direct unit-test target;
// the async fns (getChanges/getFileDiff/resolveBaseSha) are exercised over a
// REAL temp-git-repo fixture. Electron-free: node:child_process/fs/path + shared
// types only, so it pulls cleanly into the Node test bundle.
export {
  getChanges,
  getFileDiff,
  listChangesWithBase,
  resolveBaseSha,
  resolveFileDiffRequest,
  parseNameStatusZ,
  parseUnifiedDiff,
  // runGit surfaces ONLY so the suite can pin the allowExit1 gate (a --no-index
  // "files differ" exit 1 is success with stdout; exit >= 2 stays fail-soft).
  runGit,
} from './main/git-diff.js';
export type { ChangesWithBase, FileDiffRequest } from './main/git-diff.js';

// Pure DOM-free diff-row view model (the "Changes" viewer's render core).
// Re-exported so the jsdom Tier-1 suite can pin the visual contract (add/del/
// context classes + sigils + accessible-name suffixes, NFR-12) and prove Law-1
// hostile content stays escaped at the presenter sink — without a display.
export { buildDiffRows, classifyDiffLine } from './renderer/lib/diff-view.js';
export type { DiffRow, DiffRowClass } from './renderer/lib/diff-view.js';

// The REAL DiffBody presenter (the production Law-1 render sink). Re-exported so
// the node --test tier can renderToStaticMarkup the ACTUAL component with a
// hostile diff line and prove the serialized HTML escapes '<' — neutering the
// escape in FileDiff.tsx turns that test RED (anti-revert, sdet/F1). DiffBody is
// a pure presenter (no hooks / no window.loom at render time), so it pulls
// cleanly into the Node bundle.
// ChangeKindGlyph is the header's change-kind chip (added + badge / deleted −
// badge / modified dot, NFR-12) — a hook-free pure presenter (DiffBody idiom;
// the full FileDiff block uses useState, and the testkit bundles its OWN React
// copy, so a hooks component cannot render under the suite's react-dom/server).
export { DiffBody, ChangeKindGlyph } from './renderer/components/FileDiff.js';

// The branch "Changes" viewer SHELL. Re-exported so the node --test tier can
// renderToStaticMarkup the REAL component in its hook-free states (changes=null
// / unavailable / empty — no <FileDiff> children, which DO carry useState) and
// pin the NEW header Split toggle's contract: aria-pressed tracks splitView, the
// visible text "Split" equals the accessible name (SC 2.5.3 label-in-name), and
// the SplitIcon is present — the only header affordance that surfaces the
// composable diff+file split (M2). The diff BODY markup is proven separately via
// DiffBody/buildDiffRows; this pins only the added header control.
export { ChangesView } from './renderer/components/ChangesView.js';

// The Explorer's dir-row folder glyph (inline SVG, DiffIcon idiom). Re-exported
// so the node --test tier can renderToStaticMarkup the ACTUAL component and pin
// the SVG contract (aria-hidden, currentColor stroke) + the absence of the
// legacy ▤ text glyph it replaced (anti-revert). FolderIcon is a pure prop-less
// presenter (no hooks / no window.loom at render time), so it pulls cleanly
// into the Node bundle.
export { FolderIcon } from './renderer/components/Explorer.js';

// The Chat roster strip (FR-46) — a hook-free pure presenter (ChangeKindGlyph
// idiom), so the node --test tier can renderToStaticMarkup the ACTUAL
// component and pin the per-chip remove (×) button, the clear-stale (N)
// button (disabled at zero), the sibling-not-nested button structure, and
// the force-remove aria cue. The two focus-target pickers are pure DOM walks
// (no React), exported so the jsdom tier can pin the never-strand-focus
// contract (the App.tsx close-file idiom).
export {
  Roster,
  nextFocusAfterChipRemoval,
  focusTargetAfterClearStale,
} from './renderer/components/Roster.js';

// The renderer-side state store (window.loom consumer). Pure module (no React;
// DOM/`location` access is guarded), so the node tier can boot the REAL store
// over a stubbed window.loom and pin the human roster-curation actions
// (optimistic chip drop, inbox-lens close, gone-count zeroing, fail-soft
// bridge results) without Electron.
export { createStore } from './renderer/lib/client.js';
export type { LoomStore, ViewModel } from './renderer/lib/client.js';

// Project-wide content search (Law 3 confined + bounded). The pure matcher
// (matchFile) re-exported for unit tests, plus createSandbox + createSearch so
// the suite can prove the confined walk over a real temp dir (finds content,
// skips binary/oversize, stays inside the root / rejects an escaping symlink).
// Electron-free: sandbox.ts + search.ts depend only on node:fs/node:path + the
// shared dispatch table.
export { matchFile, MAX_SCAN_LINE_LENGTH } from './main/search-core.js';
export type { LineMatch, MatchOptions } from './main/search-core.js';
export {
  createSearch,
  MAX_TOTAL_SCAN_BYTES,
  MAX_FILE_NAME_MATCHES,
  MAX_FILES,
} from './main/search.js';
export type { Search } from './main/search.js';
export { createSandbox } from './main/sandbox.js';
export type { Sandbox } from './main/sandbox.js';

// Heuristic, non-AST "go to definition" (Law 3 confined + bounded). The PURE
// regex core (findDefinitionsInText) is the direct unit-test target; the
// resolver (createDefinitionFinder) is exercised over a REAL temp dir +
// Sandbox (finds class/function/const/interface/type/enum/python-def across
// files, ranks locality/kind, rejects uses-as-definitions, returns empty on a
// malformed/keyword/over-long symbol, stays inside the root). MAX_DEFS + the
// SHARED MAX_FILES cap are re-exported so the suite pins the bounds + the
// GTD-8 parity without re-deriving literals. Electron-free: definition*.ts
// depend only on the sandbox + shared dispatch + the pure search-core constant.
export {
  findDefinitionsInText,
  MAX_DEFS_PER_FILE,
  MAX_DEF_SCAN_LINE_LENGTH,
  MAX_GENERIC_OCCURRENCES,
  KIND_STRENGTH,
  USE_BAND_FLOOR,
  // CI-1: the single source of truth for "is this kind a real declaration?"
  // (vs a pure use). The resolver ranks declarations above uses regardless of
  // locality, and the dispatch mirror in definition-dispatch.ts is pinned
  // against THIS by a lock-step test.
  isDeclarationKind,
} from './main/definition-core.js';
export type { DefMatch } from './main/definition-core.js';
export {
  createDefinitionFinder,
  MAX_DEFS,
  MAX_SYMBOL_LENGTH,
} from './main/definition.js';
export type { DefinitionFinder } from './main/definition.js';

// RENDERER-side PURE go-to-definition helpers (DOM-free, so they unit-test as
// plain strings under node --test with NO jsdom). wordAt extracts the
// identifier under a (lineText, 0-based column) caret using the SAME identifier
// class + keyword/literal rejection as the highlighter; highlightedMatchHtml /
// hitText are the single shared Law-1 escaped-slice match highlighter (GTD-6)
// used by BOTH SearchView and the DefinitionPicker. KEYWORDS/LITERALS are
// re-exported so the suite can prove wordAt and the highlighter share ONE
// keyword source. Electron-free: highlight.ts / symbol-at.ts / match-highlight.ts
// depend on nothing but each other.
// wordAt extracts the identifier under a caret; lineIdentifiers (A11Y-GTD-01)
// lists every resolvable identifier on a line (the keyboard symbol chooser
// source) — both DOM-free string fns, jsdom-free unit tests.
export { wordAt, lineIdentifiers } from './renderer/lib/symbol-at.js';
export type { WordSpan } from './renderer/lib/symbol-at.js';

// The PURE caret -> (line, 0-based column) reconstruction extracted from
// CodeView's inline glue (TA-3): the TreeWalker offset sum + the GTD-3
// lnEl.contains guard that rejects a caret on a collapsed-header decoration.
// resolveSelectionSymbol (TA-R2) lifts CodeView's selection -> live-caret ->
// lastCaret PRECEDENCE (incl. the GTD-CORR-2 RTL-anchor handling) so the
// jsdom-reachable branches of the F12 symbol-resolution chain are unit-testable.
// Re-exported so the jsdom tier can prove the column math + the contains guard +
// the precedence without Electron (the production glue delegates to THESE fns).
export { columnAt, resolveSelectionSymbol } from './renderer/lib/caret-column.js';
export type { CaretColumn, ResolvedSymbol, SelectionLike } from './renderer/lib/caret-column.js';

// PURE go-to-definition dispatch + history decisions (TA-5 / GTD-CORR-3 / CI-2 /
// TA-R1): the DECLARATION-AWARE jump-vs-pick fork (CI-2 — counts real
// declarations, not raw candidates), the GTD-9 same-location / history-push
// predicates, the declaration/use partition mirror (pinned lock-step with
// definition-core.ts isDeclarationKind), and the pure jump-history stack
// push/cap/pop helpers (TA-R1) — extracted out of App's useCallback so they are
// unit-testable under node --test without Electron.
export {
  classifyDefinitionResult,
  shouldPushHistory,
  isSameLocation,
  isDeclarationCandidate,
  pushJumpHistory,
  popJumpHistory,
} from './renderer/lib/definition-dispatch.js';
export type { DefinitionAction, JumpLocation } from './renderer/lib/definition-dispatch.js';

// PURE mouse-dispatch DECISION helpers (TA-MOUSE): the single-source right-
// button routing (mouseEventDispatchButton) + the matched-command fire/skip
// decision (shouldFireMouseCommand), extracted out of App's onMouse closure +
// the Viewer onCodeClick so the dispatch contract is unit-testable under
// node --test WITHOUT a DOM. The App dispatcher AND the Viewer onCodeClick are
// the live consumers, so the unit suite pins the PRODUCTION logic — any drift
// breaks the build/tests (the definition-dispatch.ts idiom). DOM/React-free.
export {
  mouseEventDispatchButton,
  shouldFireMouseCommand,
} from './renderer/lib/mouse-dispatch.js';
export type { MouseDispatchType, MouseFireFacts } from './renderer/lib/mouse-dispatch.js';
export {
  highlightedMatchHtml,
  hitText,
} from './renderer/lib/match-highlight.js';
export { KEYWORDS, LITERALS } from './renderer/lib/highlight.js';

// The recursive file watcher (FR-14, FR-39). Electron-free: node:fs/node:path
// + bus + chokidar fallback. Re-exported so the acceptance suite can prove the
// live FileEvent contract (add/change/unlink/addDir/unlinkDir, containment,
// ignore filtering) over a real temp dir via the native recursive engine.
export { createWatcher } from './main/watcher.js';
export type { WatcherHandle } from './main/watcher.js';

// Cross-OS path normalization (Law 3 contract <-> native fs). Pure fns,
// parameterized by the path module so the acceptance suite can pin BOTH
// POSIX and the WINDOWS expectation (via path.win32) on a Linux host.
export { nativeToPosixRel, posixRelToNative } from './main/pathutil.js';
export type { PathModule } from './main/pathutil.js';

// The optional external ws observer feed (Electron-free: ws + bus only).
// Re-exported so the acceptance suite can prove the ws JSON serialization
// parity (AC-13) and the transport/feed separation (AC-15, LOOM-AC15-02).
export { createWsFeed, wsEnabled, WS_HOST, WS_PORT } from './main/ws.js';
export type { WsFeedHandle } from './main/ws.js';

// The MCP HTTP server (the AGENT transport, NFR-9). Re-exported so the
// acceptance suite can boot the REAL server in-process and drive it with N
// concurrent SDK clients — proving the room-as-MCP-server handles 10-20 agents
// chatting concurrently (the path the engine-level tests do not exercise).
export { createMcpServer, MCP_HOST, MCP_PORT, MCP_PATH } from './main/mcp.js';
export type { McpServerHandle } from './main/mcp.js';

// Engine bounds the suite asserts (SEC-6 body cap, OQ-1 name cap).
export { MAX_BODY_LENGTH, MAX_NAME_LENGTH } from './shared/types.js';

// Safe markdown renderers (single shared path for Viewer + Chat). Re-exported
// so the acceptance suite can prove content-safety (AC-21/22) at the renderer
// layer without a DOM. These are pure string->string fns (no DOM/Node deps).
export { renderMarkdown, renderInline } from './renderer/lib/markdown.js';
export { escapeHtml, highlightCode } from './renderer/lib/highlight.js';

// "Copy rendered" serializer (pure; DOM via a passed-in window + safeExternalUrl
// only — no mermaid/React). Re-exported so the jsdom suite can prove the
// allowlist rebuild over the REAL renderMarkdown output: clean portable HTML
// (no class/data-*, clean code blocks, vetted links only) + a readable
// text/plain fallback, and that hostile source can never emit script/handlers.
export { serializeRenderedForCopy } from './renderer/lib/copy-serialize.js';
export type { CopyPayload } from './renderer/lib/copy-serialize.js';

// Mermaid SVG sanitizer (DOMPurify-only — NO mermaid import, so it is safe to
// pull into the Node test bundle). Re-exported so the jsdom suite can prove the
// SVG scrub (strips <script>/foreignObject/on*-handlers/javascript: hrefs while
// keeping benign shapes + <style>) by passing its own jsdom window. The actual
// mermaid.render path is browser-only (lib/mermaid-render.ts) and proven in e2e.
// svgHasRenderableContent is the DOMPurify-free predicate the renderer uses to
// decide whether a SANITIZED SVG actually has content to draw (vs degrading to
// the fallback when the scrub left a bare/empty <svg>); jsdom-testable.
export { sanitizeSvg, svgHasRenderableContent } from './renderer/lib/svg-sanitize.js';

// Shared safe-external-URL gate (the single allow-list the renderer link rule,
// the IPC open handler, and the window nav guard all apply). Re-exported so the
// suite can pin which schemes are navigable vs neutralized.
export { safeExternalUrl } from './shared/url.js';

// Renderer click guard (the renderer half of navigable-links). Pure DOM (no
// React/Electron), so the jsdom suite can install it over the REAL renderMarkdown
// output and prove a VETTED external link opens via window.loom.openExternal while
// a neutralized link is blocked — integration of render + guard (AC-21 / SEC-5).
export { installGlobalAnchorGuard, RENDERED_MARKDOWN_SELECTOR } from './renderer/lib/anchor-guard.js';

// Pure code-folding range computation (indentation-based; Law 1 safe — no
// parsing/eval, operates only on raw text). Re-exported so the acceptance
// suite can pin the fold geometry (nesting, blank-line inclusion, dedent
// visibility, trivial-block skipping) without a DOM.
export { computeFoldRanges, TAB_WIDTH } from './renderer/lib/fold.js';
export type { FoldRange } from './renderer/lib/fold.js';

// Pure tail-window helper that bounds the Chat thread + inbox DOM so a 10–20
// agent firehose can't freeze the observer pane. Re-exported so the suite can
// pin the windowing math (cap, hidden count, tail/order preservation) DOM-free.
export { tailWindow, DEFAULT_RENDER_WINDOW, MAX_STORE_MESSAGES } from './renderer/lib/window.js';
export type { TailWindow } from './renderer/lib/window.js';

// Pure live file-tree mutation (FR-39) — keeps the lazily-loaded FileNode tree
// in sync with watcher FileEvents so a file/folder created in an expanded dir
// appears without a relaunch. Re-exported so the suite can pin the splice math
// (loaded-only, sort order, dedup, no-op on unloaded/absent parents) DOM-free.
export { insertNode, removeNode, makeNode } from './renderer/lib/filetree.js';

// Pure close-file Escape coordination (A11Y-CLOSE-05). Re-exported so the
// acceptance suite can pin the de-confliction contract (a consumed/tooltip
// Escape never closes the file; a button-focused Escape rescues focus) without
// a DOM. DOM-free decision logic only.
export { decideEscapeClose } from './renderer/lib/closefile.js';
export type { EscapeCloseAction, EscapeCloseFacts } from './renderer/lib/closefile.js';

// Pure Viewer width-mode resolution (the 120ch "fit" measure vs
// "full" reading column). Re-exported so the node --test suite can pin the
// hint parse, stored coercion, and the hint>stored>default precedence without
// a DOM/localStorage. The impure wrappers (readInitialMdWidth/persistMdWidth)
// stay in the renderer; only the PURE decision fns + type + key surface here.
export {
  parseMdWidthHint,
  coerceStoredMdWidth,
  resolveInitialMdWidth,
  toggleWidthMode,
  MD_WIDTH_KEY,
  MD_WIDTH_DEFAULT,
  MD_WIDTH_ANNOUNCE_FIT,
  MD_WIDTH_ANNOUNCE_FULL,
} from './renderer/lib/md-width.js';
export type { WidthMode } from './renderer/lib/md-width.js';

// Pure frameless edge-resize geometry (Linux-only handles). Re-exported so the
// node --test suite can pin the resize math (grow/move-shrink per edge, the
// min-clamp that keeps the opposite edge fixed without inverting, corner
// combining, integer rounding) without a DOM. The impure drag wiring stays in
// WindowResizeHandles.tsx; only the pure decision fn + types surface here.
export { computeResizeBounds } from './renderer/lib/window-resize.js';
export type { WindowBounds, ResizeDir, MinSize } from './renderer/lib/window-resize.js';

// Pure keyboard-shortcut core (FR-54). Re-exported so the acceptance suite can
// pin combo normalization (modifier order, meta==ctrl, Escape, shift+letter),
// override resolution, conflict detection, and binding validation without a
// DOM. No React/DOM-instance state.
export {
  eventToCombo,
  mouseEventToCombo,
  resolveBindings,
  findConflict,
  isValidBinding,
  bindingAllowedFor,
  formatCombo,
  diffOverrides,
  planReassign,
  isReserved,
  isPlatformCritical,
  isMouseCombo,
  isMouseForbiddenCommand,
  isPositionalCommand,
  MOUSE_KEYS,
  RESERVED_COMBOS,
  COMMANDS,
  DEFAULT_BINDINGS,
} from './renderer/lib/keybindings.js';
export type {
  CommandId,
  CommandSpec,
  KeyComboEvent,
  MouseComboEvent,
  ReassignPlan,
} from './renderer/lib/keybindings.js';

// Re-export the frozen types + error class so the suite can assert shapes
// and catch typed domain errors without reaching into source paths.
export { LoomError } from './shared/types.js';
export type {
  AgentRow,
  ChannelRow,
  MembershipRow,
  MessageRow,
  ReceiptRow,
  Caller,
  LoomEngine,
  LoomEvent,
  LoomEventKind,
  FileDispatch,
  FileKind,
  RenderState,
} from './shared/types.js';

// Pure terminal-dock geometry (the bottom terminal pane's height clamp +
// persistence keys). Re-exported so the node --test suite can pin the clamp
// range (min 120 / max 80% of body / degenerate-body pin) and the persisted
// key names without a DOM. The stateful consumer (useTerminalHeight +
// RowSplitter) stays in App.tsx; only the pure fns + constants surface here.
export {
  clampTerminalHeight,
  terminalHeightMax,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MAX_FRACTION,
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_HEIGHT_STEP,
  TERMINAL_HEIGHT_KEY,
  TERMINAL_OPEN_KEY,
} from './renderer/lib/terminal-pane.js';

// Pure split reading-pane geometry (the side-by-side compare panes' ratio
// clamp + persistence keys + active-pane resolution). Re-exported so the node
// --test suite can pin the clamp range (each pane keeps VIEWER_PANE_MIN /
// degenerate-width centre pin), the stored-ratio coercion, the persisted key
// names, and the active-pane/selection logic without a DOM. The stateful
// consumer (useViewerSplit + ColSplitter) stays in App.tsx; only the pure fns
// + constants + type surface here. Mirrors the terminal-pane export above.
export {
  clampSplitRatio,
  coerceStoredRatio,
  paneForSelection,
  effectiveActivePane,
  activePaneOnSplitOn,
  isSplitRendered,
  nudgeRatio,
  VIEWER_PANE_MIN,
  VIEWER_DIVIDER_W,
  VIEWER_SPLIT_DEFAULT,
  VIEWER_SPLIT_STEP,
  VIEWER_SPLIT_KEY,
  VIEWER_SPLIT_RATIO_KEY,
} from './renderer/lib/viewer-split.js';
export type { ActivePane } from './renderer/lib/viewer-split.js';

// The PURE terminal session manager behind the loom:terminal:* channels
// (single PTY session, payload re-validation, coalesced/bounded output pump,
// kill-on-close). Electron-free AND node-pty-free — the PTY arrives via the
// injected PtyFactory seam, so the suite drives it with a recording fake.
// pty-factory.ts (the only node-pty touchpoint) is deliberately NOT exported.
export {
  createTerminalManager,
  defaultShell,
  stripLoomRoot,
  OUTPUT_BUFFER_CAP,
  MAX_TERMINALS,
} from './main/terminal.js';
export type {
  TerminalManager,
  SessionEntry,
  PtyFactory,
  PtyLike,
  PtySpawnOpts,
} from './main/terminal.js';

// Pure multi-terminal COLUMN geometry (1|2|3-col dock layout). Electron-free,
// mirrors the viewer-split export above so the node --test tier can pin the
// clamp range, grid-template-columns math, the N-pane min-width floor, the
// ratio/count coercion, and the active-index/cycle logic without a DOM. The
// stateful consumer (the dock-wrap + inter-terminal ColSplitter) stays in
// App.tsx; only the pure surface here. (MAX_TERMINALS is re-exported from the
// manager module above — same value 3 — to avoid a duplicate-export clash.)
export {
  clampTerminalColumns,
  terminalColumnsMinWidth,
  clampColumnRatios,
  terminalColumnsTemplate,
  coerceStoredColumns,
  coerceStoredColumnRatios,
  clampActiveTerminalIndex,
  cycleTerminalIndex,
  TERMINAL_COUNT_DEFAULT,
  TERMINAL_PANE_MIN,
  TERMINAL_DIVIDER_W,
  TERMINAL_COLUMNS_RATIOS_KEY,
} from './renderer/lib/terminal-columns.js';
export type { TerminalColumns } from './renderer/lib/terminal-columns.js';

// Pure Linux maximize bounds correction (frameless WM frame-offset fix).
// Re-exported so the node --test suite can pin the display-selection logic
// (nearest display by center distance, workArea return, empty-list fallback)
// without Electron.
export { linuxMaximizeBounds, computeWslToggleMaximize } from './main/linux-maximize.js';
export type { DisplayInfo, WslMaximizeDecision } from './main/linux-maximize.js';

// Pure sandbox-root precedence decision (the resolveRoot fix). Re-exported so
// the node --test suite can pin the ordering — the EXPLICIT positional argv
// folder beats the ambient LOOM_ROOT, LOOM_ROOT is used only when argv is null,
// and null when both are absent — without Electron. The impure wrapper
// (main.ts resolveRoot: env/argv reads, isDirectory checks, picker/cwd fallback)
// stays in the main process; only the pure decision fn + type surface here.
export { chooseRoot } from './main/root-resolve.js';
export type { RootCandidates } from './main/root-resolve.js';

// Persisted config store + bounds (FR-37, AC-20; multi-terminal design §4 AC8 /
// §8 R10). Electron-free: node:fs/node:path + shared types only, so it pulls
// cleanly into the Node test bundle. Re-exported so the node --test tier can
// drive the REAL FileConfigStore over a temp userData dir and pin the tolerant
// config-load coercion — specifically the terminalCount round-trip: a config
// WITHOUT the key loads as the default (1), an in-type out-of-range integer is
// CLAMPED into [1,3], any non-finite-integer garbage falls back to the default,
// an unknown FUTURE key is dropped (no throw), and a valid 2/3 round-trips. The
// private coercers (coerceConfig/coerceTerminalCount) are exercised through the
// store's load path; only the public factory + bounds surface here.
export {
  createConfigStore,
  DEFAULT_CONFIG,
  CONFIG_FILENAME,
  MIN_TERMINAL_COUNT,
  MAX_TERMINAL_COUNT,
  DEFAULT_TERMINAL_COUNT,
} from './main/config.js';
export type { ConfigStore } from './main/config.js';
