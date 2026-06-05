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
export { createEventBus } from './main/eventbus.js';
export type { EventBus, EventHandler } from './main/eventbus.js';
export { kindOf, dispatchFor, extensionOf } from './shared/dispatch.js';

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
} from './main/search.js';
export type { Search } from './main/search.js';
export { createSandbox } from './main/sandbox.js';
export type { Sandbox } from './main/sandbox.js';

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

// Pure RENDERED-markdown width-mode resolution (the Viewer's 792px "fit" vs
// "full" reading column). Re-exported so the node --test suite can pin the
// hint parse, stored coercion, and the hint>stored>default precedence without
// a DOM/localStorage. The impure wrappers (readInitialMdWidth/persistMdWidth)
// stay in the renderer; only the PURE decision fns + type + key surface here.
export {
  parseMdWidthHint,
  coerceStoredMdWidth,
  resolveInitialMdWidth,
  MD_WIDTH_KEY,
  MD_WIDTH_DEFAULT,
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
  resolveBindings,
  findConflict,
  isValidBinding,
  formatCombo,
  diffOverrides,
  planReassign,
  isReserved,
  isPlatformCritical,
  RESERVED_COMBOS,
  COMMANDS,
  DEFAULT_BINDINGS,
} from './renderer/lib/keybindings.js';
export type {
  CommandId,
  CommandSpec,
  KeyComboEvent,
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
