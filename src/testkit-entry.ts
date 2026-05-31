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
