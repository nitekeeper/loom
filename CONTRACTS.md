# Loom — CONTRACTS (FROZEN)

This is the single source of truth every implementer builds against. Shapes here
are frozen — changing one is a breaking change to the whole app. The canonical
TypeScript home of every type below is **`src/shared/types.ts`**; the canonical
file-dispatch logic is **`src/shared/dispatch.ts`**; the canonical DDL is
**`src/main/schema.sql`**. This document mirrors them in prose.

> Authoritative requirements: `documents/loom-requirements.md`.
> Architecture + ADRs: `documents/loom-architecture.md`.

---

## Module strategy (read this first — the #1 integration footgun)

| Layer | Author as | esbuild emits | Format | Electron loads as |
|-------|-----------|---------------|--------|-------------------|
| `src/main/*`     | ESM `.ts`  | `dist/main.cjs`    | `cjs`  (platform=node)    | CommonJS main |
| `src/preload/*`  | ESM `.ts`  | `dist/preload.cjs` | `cjs`  (platform=node)    | CommonJS preload |
| `src/renderer/*` | ESM `.tsx` | `dist/renderer.js` | `iife` (platform=browser) | `<script>` in index.html |
| `src/shared/*`   | ESM `.ts`  | bundled into each  | (inlined) | — |

- Author **everything** as ESM (`import`/`export`). `tsconfig` uses
  `module: ESNext`, `moduleResolution: bundler` so `tsc --noEmit` checks the same
  graph esbuild bundles.
- `package.json` is `"type": "commonjs"`; `main` is `dist/main.cjs`.
- **`electron` is `external`** in every bundle; everything else is bundled.
- **sql.js wasm is NOT bundled.** `build.mjs` copies `sql-wasm.wasm` and
  `schema.sql` beside `main.cjs`; `db.ts` locates them via `__dirname`
  (`initSqlJs({ locateFile: () => path.join(__dirname, 'sql-wasm.wasm') })`,
  `readFileSync(path.join(__dirname, 'schema.sql'))`).
- Relative ESM imports use `.js` specifiers (e.g. `'../shared/types.js'`) —
  required by `moduleResolution: bundler` + esbuild for `.ts` sources.

WSL runtime flags (set in main): `app.disableHardwareAcceleration()`,
`app.commandLine.appendSwitch('disable-gpu')`,
`app.commandLine.appendSwitch('no-sandbox')`. These are the **OS** sandbox /
GPU flags — they are SEPARATE from the renderer hardening below, which is kept.

---

## (a) MCP tools — the 9 frozen tool shapes

`to` token `"@here"` (agent-facing) maps to stored `addressing='here'` (M-6).
Every tool call is made on behalf of a `Caller` (the session's registered name);
`check_inbox` / `read_messages` / `mark_read` operate on the **caller's**
receipts. Engine signatures take `(caller, params)`; the MCP layer binds
`caller` per transport session.

| # | Tool | Params | Returns |
|---|------|--------|---------|
| 1 | `register` | `{ name: string }` | `{ ok: true, name: string, channels: [] }` |
| 2 | `create_channel` | `{ name: string }` | `{ id: number, name: string }` |
| 3 | `join_channel` | `{ channel: string }` | `{ channel: string, members: string[] }` |
| 4 | `list_channels` | _(none)_ | `{ id: number, name: string, members: string[] }[]` |
| 5 | `deregister` | `{ name: string }` | `{ ok: true, name: string }` |
| 6 | `send_message` | `{ channel: string, to: string, body: string }` | `{ message_id: number, recipients: string[] }` |
| 7 | `check_inbox` | _(none)_ | `{ unread: number, previews: InboxPreview[] }` |
| 8 | `read_messages` | `{ channel?: string }` | `UnreadMessage[]` |
| 9 | `mark_read` | `{ message_ids: number[] }` | `{ marked: number }` |

Auxiliary shapes:

```ts
InboxPreview  = { message_id, channel, sender, addressing, preview, created_at }
UnreadMessage = { message_id, channel, sender, addressing, target, body, created_at }
```

Behavioral contract (enforced in `engine.ts`):

- **register** — assign `name`; if it collides with ANY existing `agents` row
  (active or gone), suffix `-2`, `-3`, … (FR-15, OQ-1). Max name length 64;
  longer → `LoomError('NAME_TOO_LONG')`. Returns `channels: []`.
- **create_channel** — create channel; **auto-join** caller (FR-16). Duplicate
  name → `LoomError('CHANNEL_EXISTS')`.
- **join_channel** — add caller membership; return current members (FR-17).
- **list_channels** — all channels with members (FR-18).
- **deregister** — set `agents.status='gone'`; excluded from the active count,
  shown dimmed (FR-19). Returns `{ ok, name }`. **Authorization (SEC-2):** a
  caller may ONLY deregister **itself** (`params.name` must equal the session's
  registered name); deregistering any other agent → `NOT_AUTHORIZED`. Identity
  is bound to the transport session at `register()` time.
- **'gone' vs delivery (FR-19, decision = keep-and-document):** `status='gone'`
  is a **roster / active-count** concern ONLY. A gone agent that is still a
  channel member STILL receives messages — it remains an `@here` recipient and a
  valid direct-send target, and continues to accrue unread receipts. This is the
  send-time-membership rule (OQ-3): "excluded from the active count" (FR-19) does
  NOT mean "removed from channels". Enforced by an acceptance test.
- **send_message** — resolve recipients **at send time** (OQ-3): `to="@here"` →
  all current members except sender (`addressing='here'`, `target=NULL`); `to=`
  name → that member (`addressing='direct'`, `target=name`). Sender + target
  MUST share the channel else `LoomError('NOT_A_MEMBER'|'RECIPIENT_NOT_MEMBER')`
  (Law 5). Body length is capped at `MAX_BODY_LENGTH` (16 384 chars) at the
  engine boundary (SEC-6) → `BODY_TOO_LONG`; the MCP input schema mirrors the
  cap. Writes 1 message + 1 receipt per recipient; publishes `MessageEvent`.
- **join_channel** — an idempotent **re-join is silent** (LOOM-AC13-05): a
  `ChannelEvent` is published ONLY when the caller actually joined, never on a
  no-op re-join of an existing member.
- **check_inbox / read_messages** — read the caller's unread receipts; mark
  **nothing** read (FR-25/26).
- **mark_read** — set `read_at = now` for the caller's receipts on the given
  message ids; return count actually updated (FR-27).
- Unregistered caller invoking any tool except `register` →
  `LoomError('NOT_REGISTERED')`.

Errors: `LoomError(code, message)` with `code` in
`NOT_REGISTERED | NAME_TOO_LONG | BODY_TOO_LONG | CHANNEL_EXISTS |
CHANNEL_NOT_FOUND | NOT_A_MEMBER | RECIPIENT_NOT_MEMBER | AGENT_NOT_FOUND |
NOT_AUTHORIZED | BAD_REQUEST`. (`BODY_TOO_LONG` = SEC-6 body cap;
`NOT_AUTHORIZED` = SEC-2 self-only deregister.)

**MCP transport hardening (SEC-1/SEC-3, NFR-9, OQ-4):** the agent transport on
`127.0.0.1:7077` enables DNS-rebinding protection — `allowedHosts` =
`127.0.0.1:7077`/`localhost:7077`, `allowedOrigins` = the loopback origins. A
browser cross-origin `fetch()` (which always sends an `Origin`) or a rebound
host is rejected with 403, blocking the local-page CSRF / DNS-rebinding vector;
non-browser loopback SDK clients send no `Origin` and pass. The MCP request body
is capped at 1 MiB (`MAX_REQUEST_BODY_BYTES`) → 413, mirroring the ws feed's
`maxPayload`, so a flood cannot exhaust the main process. WSL forces process-wide
`--no-sandbox`/`--no-zygote` (gated behind WSL detection so a non-WSL build keeps
the OS renderer sandbox); the markdown+highlight escaping is the sole remaining
barrier there and is guarded by an adversarial-corpus acceptance test (SEC-4).

---

## (b) IPC channels — every name + payload

Naming `loom:<noun>:<verb>`. `invoke` = renderer→main request/response;
`send` = main→renderer push. Constants live in `IPC` (`src/shared/types.ts`).
The renderer NEVER touches `ipcRenderer` directly — only `window.loom`.

| Constant | Channel string | Direction | Payload → Result |
|----------|----------------|-----------|------------------|
| `GET_INITIAL_STATE` | `loom:state:get`  | invoke | `() → InitialState` |
| `READ_FILE`         | `loom:file:read`  | invoke | `(path: string) → FileContent` |
| `GET_TREE`          | `loom:tree:get`   | invoke | `() → FileNode` |
| `SET_THEME`         | `loom:theme:set`  | invoke | `(theme: Theme) → void` |
| `SET_LIVE_STATE`    | `loom:live:set`   | invoke | `(state: LiveState) → void` |
| `EVENT`             | `loom:event`      | send   | `(LoomEvent)` main→renderer |
| `COUNTERS`          | `loom:counters`   | send   | `(SessionCounters)` main→renderer |
| `LIVE_STATE`        | `loom:live:state` | send   | `(LiveState)` main→renderer |

Preload bridge (`window.loom: LoomBridge`):

```ts
getInitialState(): Promise<InitialState>
readFile(path: string): Promise<FileContent>
getTree(): Promise<FileNode>
setTheme(theme: Theme): Promise<void>
setLiveState(state: LiveState): Promise<void>
onEvent(h: (e: LoomEvent) => void): () => void       // returns unsubscribe
onCounters(h: (c: SessionCounters) => void): () => void
onLiveState(h: (s: LiveState) => void): () => void
```

---

## (c) EventBus — the `LoomEvent` union

The SAME shape is fanned to IPC `loom:event` AND the optional ws feed
(`127.0.0.1:7078`, `LOOM_WS=1`) (FR-29/30, AC-13/15).

```ts
type LoomEvent =
  | { kind: 'message'; message: MessageRow; recipients: string[]; channel: string }
  | { kind: 'agent';   agent: AgentRow }
  | { kind: 'channel'; channel: ChannelRow; members: string[] }
  | { kind: 'receipt'; receipt: ReceiptRow }
  | { kind: 'file';    action: FileAction; path: string; at: number }

FileAction = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
```

All timestamps are epoch **ms**. `file.path` is **root-relative POSIX**.

---

## (d) File-dispatch table — ext → kind → render-state

Canonical in `src/shared/dispatch.ts` (`kindOf`, `dispatchFor`). Deterministic
by extension (NFR-6). The Viewer and Explorer both import it.

| Extension(s) | `FileKind` | `RenderState` | Safety banner | FR |
|--------------|-----------|---------------|:---:|----|
| `.md` `.markdown` | `md` | `RENDERED` | — | FR-5, AC-3a |
| `.js .mjs .cjs .jsx .ts .mts .cts .tsx .json .css .scss .less .py .txt .yaml .yml .toml .ini .env .sh .bash .sql .xml .csv .log .rs .go .java .c .h .cpp .rb` | `code` | `SOURCE` | — | FR-6, AC-3b |
| `.svg` | `svg` | `SOURCE` | **yes** | FR-7, FR-41, AC-3c |
| `.html` `.htm` | `html` | `SOURCE` | **yes** | FR-8, FR-41 |
| `.png .jpg .jpeg .gif .webp .bmp .ico .avif .tiff` | `image` | `PREVIEW` | — | FR-10, AC-19 |
| _anything else / no ext_ | `binary` | `NO PREVIEW` | — | FR-9, FR-43, AC-3d |

- `RENDERED` → safe markdown (`lib/markdown.renderMarkdown`).
- `SOURCE` → read-only highlighter (`lib/highlight.highlightCode`); svg/html add
  the safety banner (FR-41).
- `PREVIEW` → safe checkerboard placeholder, **never** a decoded image (FR-10).
- `NO PREVIEW` → metadata card (name/size/type/modified) (FR-43).

---

## SQLite schema (Appendix A — see `src/main/schema.sql`)

Verified to load in sql.js with all constraints enforced (AC-16): 5 tables,
`agents.status` + `messages.addressing` CHECK enums, `channels.name` UNIQUE,
composite PKs on `memberships(channel_id, agent_name)` and
`receipts(message_id, recipient)`, FKs as specified, and the partial index
`idx_receipts_unread ON receipts(recipient) WHERE read_at IS NULL`. INT
timestamps = epoch ms. Fresh DB per launch (OQ-2); flush to
`<root>/.loom/loom.db` on each mutation (NFR-7).

---

## (e) FILE MANIFEST — every source file, one owner

Roles: `backend-engineer`, `agent-systems-architect`, `realtime-engineer`,
`frontend-engineer`, `sdet`, `technical-writer`, `security-engineer`.

### Shared (the type/dispatch contract)
| Path | Owner | Purpose |
|------|-------|---------|
| `src/shared/types.ts` | agent-systems-architect | All shared interfaces, tool shapes, `LoomEvent`, IPC constants, enums, snapshot + tree types. FROZEN. |
| `src/shared/dispatch.ts` | frontend-engineer | Canonical ext→kind→render-state table (FR-4..FR-10). Implemented. |

### Main process (single source of truth)
| Path | Owner | Purpose |
|------|-------|---------|
| `src/main/main.ts` | backend-engineer | Electron entry; WSL flags; boot order; hardened BrowserWindow; `--capture` mode hook. |
| `src/main/schema.sql` | backend-engineer | Appendix-A DDL (verbatim-faithful). Implemented. |
| `src/main/db.ts` | backend-engineer | sql.js store; load wasm + schema; typed CRUD; flush-to-disk. |
| `src/main/engine.ts` | agent-systems-architect | The 9 tools as PURE fns over db + bus. Testable without Electron. |
| `src/main/mcp.ts` | agent-systems-architect | MCP Streamable-HTTP server on :7077; thin wrapper over engine. |
| `src/main/eventbus.ts` | realtime-engineer | In-process pub/sub for `LoomEvent`. |
| `src/main/ws.ts` | realtime-engineer | Optional external ws feed on :7078 (`LOOM_WS=1`). |
| `src/main/watcher.ts` | realtime-engineer | chokidar watcher → `FileEvent`s on the bus. |
| `src/main/sandbox.ts` | security-engineer | Law 3 boundary; tree build; file read + dispatch. |
| `src/main/config.ts` | backend-engineer | Persisted theme in userData/loom-config.json. |
| `src/main/ipc.ts` | backend-engineer | ipcMain handlers + live-feed/counters/live-state pump. |

### Preload
| Path | Owner | Purpose |
|------|-------|---------|
| `src/preload/preload.ts` | security-engineer | contextBridge `window.loom` (the only privileged surface). |

### Renderer (React)
| Path | Owner | Purpose |
|------|-------|---------|
| `src/renderer/index.html` | security-engineer | Shell + strict CSP; loads renderer bundle + css. |
| `src/renderer/index.tsx` | frontend-engineer | React root; mounts App from initial state. |
| `src/renderer/styles/renderer.css` | frontend-engineer | Theme tokens, 3-pane grid, focus-visible, reduced-motion (port of loom.css). |
| `src/renderer/lib/markdown.ts` | security-engineer | Single safe markdown renderer (Viewer + Chat). |
| `src/renderer/lib/highlight.ts` | security-engineer | Read-only syntax tokenizer (port of highlight.jsx). |
| `src/renderer/lib/client.ts` | frontend-engineer | Store over window.loom; reduces LoomEvents. |
| `src/renderer/lib/format.ts` | frontend-engineer | Pure presentation formatters (bytes/clock/type). |
| `src/renderer/components/App.tsx` | frontend-engineer | Window shell grid; top-level UI state. |
| `src/renderer/components/TitleBar.tsx` | frontend-engineer | Root name + lock glyph + product identity (FR-35). |
| `src/renderer/components/StatusBar.tsx` | frontend-engineer | Live state machine, real counters, pause, theme toggle (FR-36/37). |
| `src/renderer/components/Explorer.tsx` | frontend-engineer | Root-scoped tree, sandbox notice, live activity (FR-38/39). |
| `src/renderer/components/Viewer.tsx` | frontend-engineer | Render-state dispatch + badges + safety banner (FR-40/41/43). |
| `src/renderer/components/Chat.tsx` | frontend-engineer | Chat container; observer notice replaces composer (FR-51). |
| `src/renderer/components/Roster.tsx` | frontend-engineer | Agent roster chips with presence/unread/gone (FR-46). |
| `src/renderer/components/Avatar.tsx` | frontend-engineer | Initial chip with text label + non-color cues (NFR-12). |
| `src/renderer/components/ChannelTabs.tsx` | frontend-engineer | Selectable channel tabs + count badges (FR-47). |
| `src/renderer/components/Thread.tsx` | frontend-engineer | Channel message thread + empty state (FR-53). |
| `src/renderer/components/Message.tsx` | frontend-engineer | One message; safe inline body; addressing tag (FR-44/48). |
| `src/renderer/components/ReceiptStrip.tsx` | frontend-engineer | Delivered→seen / N/M read + focusable breakdown (FR-45/AC-23). |
| `src/renderer/components/InboxLens.tsx` | frontend-engineer | Per-agent inbox view + empty state (FR-50/53). |

### Tooling, tests, launcher, docs
| Path | Owner | Purpose |
|------|-------|---------|
| `bin/loom.cjs` | backend-engineer | `loom .` launcher; resolves root; spawns Electron with WSL flags. |
| `build.mjs` | backend-engineer | esbuild build → dist/ (3 bundles + html/schema/wasm copy). Implemented. |
| `package.json` | backend-engineer | Pins (electron 33.4.11); scripts build/start/loom/test/typecheck. Implemented. |
| `tsconfig.json` | backend-engineer | strict, ES2021, bundler resolution, jsx react-jsx, noEmit. Implemented. |
| `test/acceptance.mjs` | sdet | node --test suite exercising the 9 tools + schema + dispatch + safety. |
| `CONTRACTS.md` | software-architect | This document. Implemented. |
| `documents/loom-architecture.md` | software-architect | Architecture + ADRs. Implemented. |

---

## Verification status of this skeleton

- `npm run typecheck` (`tsc --noEmit`) → **exit 0** (strict).
- `npm run build` (esbuild) → **exit 0**; dist/ contains main.cjs, preload.cjs,
  renderer.js, renderer.css, index.html, schema.sql, sql-wasm.wasm.
- `schema.sql` loaded in sql.js → all 5 tables, both CHECK enums, UNIQUE,
  composite PKs, and the partial index verified (AC-16 at DDL level).
- Electron pinned to `33.4.11`; install with
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` uses the cached binary (no re-download).
