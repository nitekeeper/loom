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
 *   createEngine   — the 9 tools as pure fns over (db, bus).
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

// Engine bounds the suite asserts (SEC-6 body cap, OQ-1 name cap).
export { MAX_BODY_LENGTH, MAX_NAME_LENGTH } from './shared/types.js';

// Safe markdown renderers (single shared path for Viewer + Chat). Re-exported
// so the acceptance suite can prove content-safety (AC-21/22) at the renderer
// layer without a DOM. These are pure string->string fns (no DOM/Node deps).
export { renderMarkdown, renderInline } from './renderer/lib/markdown.js';
export { escapeHtml, highlightCode } from './renderer/lib/highlight.js';

// Pure code-folding range computation (indentation-based; Law 1 safe — no
// parsing/eval, operates only on raw text). Re-exported so the acceptance
// suite can pin the fold geometry (nesting, blank-line inclusion, dedent
// visibility, trivial-block skipping) without a DOM.
export { computeFoldRanges, TAB_WIDTH } from './renderer/lib/fold.js';
export type { FoldRange } from './renderer/lib/fold.js';

// Pure close-file Escape coordination (A11Y-CLOSE-05). Re-exported so the
// acceptance suite can pin the de-confliction contract (a consumed/tooltip
// Escape never closes the file; a button-focused Escape rescues focus) without
// a DOM. DOM-free decision logic only.
export { decideEscapeClose } from './renderer/lib/closefile.js';
export type { EscapeCloseAction, EscapeCloseFacts } from './renderer/lib/closefile.js';

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
