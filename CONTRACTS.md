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

## (a) MCP tools — the 10 frozen tool shapes

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
| `FIND_DEFINITION`   | `loom:definition:find` | invoke | `(req: DefinitionQuery) → DefinitionResult` — heuristic, **non-AST** "go to definition" over the sandbox root. The renderer sends ONLY a bounded `symbol` string (the identifier under the caret/selection) plus an OPTIONAL advisory `fromPath` (used for ranking ONLY). main RE-VALIDATES the symbol — coerced to string, trimmed, rejected if empty / `> 128` chars / not a single `^[A-Za-z_$][A-Za-z0-9_$]*$` identifier / a keyword or literal — and OWNS every returned candidate path from its OWN confined `sandbox.walkFiles` walk: **the renderer never supplies a definition path.** `fromPath` is re-confined via `sandbox.resolveInRoot` inside a `try/catch` and DROPPED on any escape (`..`, NUL, symlink) — it never reaches a read. Bounded exactly like search (MAX_FILES, MAX_TOTAL_SCAN_BYTES, `MAX_DEFS=200` candidate cap, per-line prefix scan); a cap sets `truncated:true`. Fail-soft: a malformed/keyword/over-long/non-identifier symbol returns `{ candidates: [], truncated: false }` (Law 1/3). |
| `SET_THEME`         | `loom:theme:set`  | invoke | `(theme: Theme) → void` |
| `SET_LIVE_STATE`    | `loom:live:set`   | invoke | `(state: LiveState) → void` — routed to the SENDER window's per-window live-feed pump (a pause in one window never flips another's). |
| `WINDOW_NEW`        | `loom:window:new` | invoke | `() → void` — open ANOTHER window onto the SAME folder in THIS process (shared `db`/`engine`/MCP/`watcher`; each window gets its OWN renderer pump + terminal pool). No args, no sender trust. Same-folder duplication is ALWAYS in-process — a second OS process on one folder would double-write `loom.db`. Joins the no-arg `loom:window:*` window-controls family. |
| `WINDOW_OPEN_FOLDER`| `loom:window:open-folder` | invoke | `() → void` — pop a native folder picker; main decides: pick === current root ⇒ in-process duplicate (`WINDOW_NEW` path); a LIVE Loom already serves the pick (`mcp.json` advert + live pid) ⇒ inform + decline; else spawn a fresh, isolated Loom process on that folder. The renderer NEVER supplies a path — Law 3 containment stays in main. |
| `EVENT`             | `loom:event`      | send   | `(LoomEvent)` main→renderer |
| `COUNTERS`          | `loom:counters`   | send   | `(SessionCounters)` main→renderer |
| `LIVE_STATE`        | `loom:live:state` | send   | `(LiveState)` main→renderer |
| `GIT_STATUS`        | `loom:git:status` | invoke + send | `() → Record<string, GitFileStatus>` (invoke); `(Record<string, GitFileStatus>)` main→renderer push on boot + after each file event |
| `REMOVE_AGENT`      | `loom:agent:remove` | invoke | `(name: string) → boolean` — HUMAN roster curation (UI affordance ONLY; the 10 MCP tools are untouched — agents get no removal tool). DELETEs ONE agent's `agents` row (any status) plus its name-keyed FK children (`memberships`, `receipts`); **messages are PRESERVED** (`messages.sender`/`target` may dangle by design — FK enforcement is toggled off for the single parent-row delete, and the renderer renders senders as plain strings, never a join). For a still-`active` agent this is a **force-deregister**, and there is **no identity capture**: `register()` binds the session's identity to the row's `connection_id` (`Caller.connectionId`, additive), and the engine accepts the session only while the live row's `connection_id` still matches — so the removed session's calls fail `NOT_REGISTERED` immediately AND keep failing after a NEW agent re-registers the freed bare name (EVERY registration mints a fresh `conn-<name>-<ms>-<seq>` id — there is NO branch that reuses a deterministic value, so re-running any register sequence can never recreate an old id); the old session can never read the successor's inbox or send as it. The stale transport object is evicted by the idle reaper once its client stops polling; a client that KEEPS polling refreshes `lastSeen` and lingers unreaped — harmless, since every call it makes is refused with `NOT_REGISTERED`. No new session-teardown path. main RE-VALIDATES the input (string, trimmed non-empty, ≤ `MAX_NAME_LENGTH`, existing row) and is fail-soft `false` — never a throw. Publishes the SAME `'gone'` `AgentEvent` shape `deregister` publishes (the renderer's reducer already drops a gone agent), so the roster updates live with NO new event kind, plus one `ChannelEvent` per channel that lost the agent's membership (member lists stay in sync with `list_channels`). A removed name may immediately `register()` again as a FRESH agent — no blocklist. The clearable backlog is surfaced to the human ONLY as `SessionCounters.staleAgents` (additive), driving the roster's "clear stale (N)" button. |
| `CLEAR_STALE_AGENTS` | `loom:agent:clear-stale` | invoke | `() → number` — HUMAN roster curation: remove ALL **STALE** agents at once with the SAME delete semantics as `REMOVE_AGENT` (messages preserved; one `'gone'` `AgentEvent` per removed row + one `ChannelEvent` per channel that lost members). **STALE = `status='gone'` rows ∪ `status='active'` rows whose `connection_id` is NOT bound to any live MCP session** (`McpServerHandle.liveConnectionIds()`): agents that crash/exit never call `deregister`, and the idle reaper only closes transports — it NEVER touches the db — so dead agents sit `'active'` forever; the dead chips the human sees are these rows, not gone ones. A LIVE connected agent is NEVER swept — the per-chip × (`REMOVE_AGENT`) is the only way to remove one. After an app relaunch every `'active'` row is stale until its agent re-registers (sessions die with the process); sweeping them all is intended. No race with a registering agent: `register()` claims the row + binds the session's `connectionId` in one synchronous unit on the same event loop the (synchronous) sweep runs on. The button count (`SessionCounters.staleAgents`) is recomputed in main with the SAME `isStaleAgent` definition over the SAME live set, but it is an ADVISORY display accurate as of its last recompute — the click itself sweeps by definition, whatever is stale at that instant. Counter pushes fire on every bus event AND on an out-of-bus nudge when the idle reaper evicts a registered session (`McpServerOptions.onSessionsReaped` → `IpcWiring.nudgeCounters`; reaping publishes no bus event, and without the nudge the count froze at its last pushed value). Takes NO args; returns the count removed (0 when none). Fail-soft; UI affordance ONLY (no MCP tool counterpart). |
| `GET_CHANGES`       | `loom:git:changes`| invoke | `() → ChangeSet` — files changed vs the base merge-base: committed branch work UNION uncommitted working-tree changes (staged + unstaged + untracked, `.gitignore` respected; one deduped row per file). Tracked = two-dot worktree diff `git diff <mergeBaseSha> --` (before = merge-base, after = working tree); untracked = `ls-files --others --exclude-standard`, listed as created. Fail-soft `available:false` off a git repo (Law 3 confined; main resolves `rootPath`). Shapes unchanged — this is a semantics-only widening (the old three-dot `<mergeBase>...HEAD` listing missed uncommitted work and was always empty on the base branch). |
| `READ_FILE_DIFF`    | `loom:git:diff`   | invoke | `(path: string) → FileDiff` — the before→after unified diff for ONE changed file: before = merge-base content, after = CURRENT working-tree content (two-dot `git diff <mergeBaseSha> -- <path>`); an untracked file diffs `--no-index` against `/dev/null` (created, empty before); a worktree-deleted file shows as all deletions. `path` is a root-relative POSIX path from a prior `ChangedFile`; main **re-confines it via `sandbox.resolveInRoot` before any git read** (the `git cat-file/diff <sha>:<path>` object-store read bypasses the fs sandbox), pre-resolves the base to a 40-char SHA, and passes paths to git only as positional args after `--`. |
| `TERMINAL_OPEN`     | `loom:terminal:open`   | invoke | `(p: TerminalOpenParams) → TerminalOpenResult` — spawn a terminal PTY session in main, cwd = the launch root. Supports up to 3 concurrent terminal sessions, each addressed by its `sessionId`. `open()` at capacity (3) returns `sessionId: null` and neither spawns nor kills. `sessionId: null` also = terminal unavailable (the node-pty load/spawn failed) — graceful degradation, never a throw. |
| `TERMINAL_INPUT`    | `loom:terminal:input`  | invoke | `(p: { sessionId, data }) → void` — renderer keystrokes → PTY stdin. main RE-VALIDATES (never trust the renderer): non-string data, payloads over `MAX_TERMINAL_INPUT_BYTES`, or a stale `sessionId` are silent no-ops. |
| `TERMINAL_RESIZE`   | `loom:terminal:resize` | invoke | `(p: { sessionId, cols, rows }) → void` — resize the PTY. main RE-VALIDATES: cols/rows must be finite integers within the `TERMINAL_MIN/MAX` bounds; a stale `sessionId` is a silent no-op. |
| `TERMINAL_CLOSE`    | `loom:terminal:close`  | invoke | `(p: { sessionId }) → void` — kill the PTY session (pane closed). A stale `sessionId` is a silent no-op. |
| `TERMINAL_DATA`     | `loom:terminal:data`   | send   | `(TerminalDataPush)` main→renderer — coalesced PTY output chunks. |
| `TERMINAL_EXIT`     | `loom:terminal:exit`   | send   | `(TerminalExitPush)` main→renderer — the PTY exited; the session id is invalidated (input/resize/close after exit are silent no-ops). |

`GitFileStatus = 'modified' | 'added' | 'untracked' | 'staged'`. The git-changes
payload types (`ChangeKind`, `ChangedFile`, `ChangeSet`, `DiffLine`, `DiffHunk`,
`FileDiff`) + `MAX_DIFF_BYTES` are frozen in `src/shared/types.ts` §7b. `path` /
`oldPath` / hunk text are RAW git output — escape at the render sink (Law 1).

Preload bridge (`window.loom: LoomBridge`):

```ts
getInitialState(): Promise<InitialState>
readFile(path: string): Promise<FileContent>
getTree(): Promise<FileNode>
findDefinition(req: DefinitionQuery): Promise<DefinitionResult>  // heuristic go-to-definition (confined + bounded; main owns every returned path)
setTheme(theme: Theme): Promise<void>
setLiveState(state: LiveState): Promise<void>
onEvent(h: (e: LoomEvent) => void): () => void       // returns unsubscribe
onCounters(h: (c: SessionCounters) => void): () => void
onLiveState(h: (s: LiveState) => void): () => void
getGitStatus(): Promise<Record<string, GitFileStatus>>
onGitStatus(h: (s: Record<string, GitFileStatus>) => void): () => void
getChanges(): Promise<ChangeSet>
readFileDiff(path: string): Promise<FileDiff>
removeAgent(name: string): Promise<boolean>     // human roster curation
clearStaleAgents(): Promise<number>             // human roster curation (stale sweep)
windowControls: WindowControls                       // namespaced — frameless chrome + multi-window actions
terminal: TerminalBridge                              // namespaced, like windowControls
```

The `windowControls` bridge member (`WindowControls`, `src/shared/types.ts`) —
the frameless-chrome window controls PLUS the two multi-window actions. Every
method is no-arg / SENDER-scoped in main (the renderer can only act on its OWN
window; the multi-window actions take no path — Law 3 stays in main):

```ts
windowControls.minimize(): Promise<void>
windowControls.toggleMaximize(): Promise<void>
windowControls.close(): Promise<void>
windowControls.isMaximized(): Promise<boolean>
windowControls.onMaximizeChange(cb: (m: boolean) => void): () => void  // returns unsubscribe
windowControls.getBounds(): Promise<WindowBounds>
windowControls.setBounds(b: WindowBounds): Promise<void>
windowControls.newWindow(): Promise<void>     // open ANOTHER window on the SAME folder (in-process, shared db/MCP)
windowControls.openFolder(): Promise<void>    // native folder picker → in-process dup / new isolated process / decline
```

The `terminal` bridge member (`TerminalBridge`, `src/shared/types.ts`):

```ts
terminal.open(opts: TerminalOpenParams): Promise<TerminalOpenResult>
terminal.input(sessionId: string, data: string): Promise<void>
terminal.resize(sessionId: string, cols: number, rows: number): Promise<void>
terminal.close(sessionId: string): Promise<void>
terminal.onData(h: (p: TerminalDataPush) => void): () => void   // returns unsubscribe
terminal.onExit(h: (p: TerminalExitPush) => void): () => void   // returns unsubscribe
```

**Terminal (ADDITIVE).** The `loom:terminal:*` channels carry the human-invoked
terminal pane's PTY session (types frozen in `src/shared/types.ts` §7c:
`TerminalOpenParams`, `TerminalOpenResult`, `TerminalDataPush`,
`TerminalExitPush`). Every payload is RE-VALIDATED in main — types checked, the
per-spawn `sessionId` token re-matched on every input/resize/close (stale id ⇒
silent no-op), and each input write capped at `MAX_TERMINAL_INPUT_BYTES`
(64 KiB). Up to 3 concurrent terminal sessions, each addressed by its
`sessionId`; `open()` at capacity (3) returns `sessionId: null` and neither
spawns nor kills. Each PTY is killed on window close. The terminal is **MCP-invisible**: the
agent-facing tool surface in §(a) is unchanged — no agent can reach, observe,
or drive the PTY.

**Go to Definition (ADDITIVE).** The `loom:definition:find` channel backs the
Viewer's "go to definition" (jump from the symbol under the caret/selection to
where it is defined). It is a self-contained, **non-AST** heuristic resolver — no
language server, tree-sitter, ctags, or external indexer — that walks the
sandbox and matches language-aware DEFINITION patterns by file extension (TS/JS
families, Python, and a generic declaration-keyword fallback covering
Go/Rust/Kotlin/Java/C/C++/Scala). Shapes are frozen in `src/shared/types.ts`:

```ts
DefinitionQuery     = { symbol: string; fromPath?: string }
DefinitionCandidate = { path: string; line: number; col: number; lineText: string; kind: DefinitionKind }
DefinitionResult    = { candidates: DefinitionCandidate[]; truncated: boolean }
DefinitionKind =
  | 'class' | 'interface' | 'type' | 'enum' | 'function' | 'method'
  | 'variable' | 'destructured' | 're-export' | 'generic'
  // USE kinds (NOT real declarations; ranked BELOW every declaration):
  | 'import' | 'property' | 'parameter' | 'other'
```

- **`symbol`** is the identifier under the caret/selection (the renderer derives
  it from the text caret/selection Range, NOT token spans). main RE-VALIDATES it
  (string, trimmed, `≤ 128` chars, single `^[A-Za-z_$][A-Za-z0-9_$]*$`
  identifier, not a keyword/literal) — the symbol arrives over IPC and is never
  trusted.
- **`fromPath`** is ADVISORY only — a root-relative POSIX path used solely for
  locality ranking. main re-confines it via `sandbox.resolveInRoot` and DROPS it
  on any escape; **it is never a read target and never a definition path.**
- **`path`** (every candidate) is OWNED by main — produced by its own confined
  `sandbox.walkFiles` walk. **The renderer NEVER supplies a definition path.**
  When a candidate is opened, the navigation round-trips
  `READ_FILE → sandbox.readFile → resolveInRoot`, which re-proves containment on
  every read (Law 3). `line`/`col` are 1-based (aligning with the Viewer's
  rendered rows + the existing reveal primitive).
- **`lineText`** is RAW, attacker-influenced file content (like
  `SearchMatch.lineText`) — escaped at the render sink, never raw innerHTML
  (Law 1).
- **Ranking** sinks USE kinds (`import`/`property`/`parameter`/`other`) below
  every real declaration, so a single jump always prefers a genuine declaration
  over a mere use. The result drives the UI: **0** candidates → status toast;
  exactly **1** → auto-jump; **>1** → a chooser picker (reusing search-result
  affordances). A companion "Go Back" pops a per-window jump-history stack.
- **Bounded (Law 1 / DoS):** shares search's caps — `MAX_FILES`,
  `MAX_TOTAL_SCAN_BYTES`, `MAX_DEFS=200`, per-line prefix scan; a cap sets
  `truncated:true`. Non-text kinds are never scanned. This channel adds NO new
  agent-facing surface — it is renderer↔main only.

**Mouse-combo shortcuts (ADDITIVE — no new IPC / no shape change).** A click
with modifier(s) is now a first-class shortcut, recorded in the Shortcuts panel
and persisted exactly like a keyboard combo. There is **no new channel and no
new payload**: a mouse binding is an ordinary string in the SAME
`Record<CommandId, string>` config the keyboard bindings already use, so the
keybindings persistence path (`config.keybindings` / `coerceKeybindings`, which
stays string-only) and `resolveBindings` / `diffOverrides` round-trip it
unchanged once the validity layer (`src/renderer/lib/keybindings.ts`) accepts the
mouse tokens. The contract:

- **Grammar.** A mouse combo's FINAL (key-position) token is one of three
  canonical, PERSISTED tokens — `Click` (left), `MiddleClick` (middle),
  `RightClick` (right). The modifier order is UNCHANGED: `Ctrl`, then `Alt`, then
  `Shift`, then the click token, joined by `+` (e.g. `Ctrl+Click`,
  `Alt+Shift+RightClick`, `Ctrl+Shift+MiddleClick`). `metaKey` OR `ctrlKey` both
  collapse to the single `Ctrl` token (Cmd == Ctrl), exactly as for keys.
- **`>= 1` modifier required.** EVERY mouse combo (for ANY command) MUST carry at
  least one modifier — a bare `Click` is structurally valid but DISALLOWED for
  every command (`bindingAllowedFor`), so it is refused on capture, dropped on
  resolve, and never persisted. A bare click can never hijack normal clicking.
- **`closeFile` is MOUSE-FORBIDDEN (no dead bindings).** `closeFile` cannot be
  bound to ANY mouse combo — the document mouse dispatcher hard-skips it
  (keyboard-only: its tooltip/focus-rescue needs the `KeyboardEvent`), so a mouse
  binding would be a SILENT DEAD BINDING (shown as live, never able to fire).
  `bindingAllowedFor('closeFile', <mouseCombo>)` is therefore `false` (refused on
  capture with a precise "cannot be a mouse shortcut" message, dropped on resolve,
  never persisted). `goToDefinition` is the OTHER dispatcher-skip, but it is NOT
  mouse-forbidden: it is `positional` and its mouse path is owned by the Viewer's
  `onCodeClick`, so a mouse binding there is LIVE.
- **`goToDefinition` click gesture is EXACTLY `Ctrl`/`Cmd`-click.** The default
  binding `Ctrl+Click` is matched as the EXACT canonical combo — the primary
  modifier with NO other modifier. `Ctrl`+`Shift`-click / `Ctrl`+`Alt`-click etc.
  produce a DIFFERENT combo that does not equal `Ctrl+Click`, so they do NOT
  jump (and remain freely bindable to other commands). This is a deliberate
  change from the previously-hardcoded Viewer check (`if (!(e.metaKey ||
  e.ctrlKey)) return;`), which jumped on ANY click with `Ctrl`/`Cmd` held
  regardless of extra modifiers — matching VS Code's exact-modifier behaviour.
- **goToDefinition default flip + the FIXED-F12 a11y rule.** The rebindable
  `goToDefinition` slot's default is now `Ctrl+Click` (promoted out of the old
  hardcoded Viewer check; was `F12`). `F12` is NO LONGER the slot default but
  REMAINS a FIXED, always-on, **non-rebindable** keyboard affordance handled
  directly in the App keydown dispatcher (mirroring the fixed `Ctrl+,` Shortcuts
  opener), so a keyboard-only user always retains go-to-definition regardless of
  how the slot is rebound (WCAG 2.1.1). `goToDefinition` is marked `positional`
  (`CommandSpec.positional`): the document mouse dispatcher SKIPS it (it has no
  per-pane caret context) and the Viewer's binding-aware `onCodeClick` owns the
  click path.
- **Right-button SINGLE-SOURCE rule.** A right-button release fires BOTH
  `auxclick` AND `contextmenu` natively, and `defaultPrevented` does not carry
  across the two events. So right-button is dispatched ONLY from `contextmenu`
  (its unreliable `e.button` is normalized to `2`); the `auxclick` listener
  handles the MIDDLE button only (a right-button `auxclick` is dropped). This
  rule holds identically in the App dispatcher, the Viewer `onCodeClick`, and the
  panel's mouse capture, so a `RightClick`-bound command fires EXACTLY ONCE.
- **Rendered-markdown links WIN over a global mouse binding.** The capture-phase
  anchor-guard (`src/renderer/lib/anchor-guard.ts`) calls `e.preventDefault()`
  for every anchor click inside rendered markdown (`.md`/`.msg-body`/`.ib-body`),
  including modified clicks, BEFORE the bubble-phase document mouse dispatcher
  runs; the dispatcher bails on `e.defaultPrevented`, so a `Ctrl+Click`-bound
  global command intentionally does NOT fire over a rendered link (an
  intentional, testable precedence — links win). The anchor-guard listens on
  `click` (primary) only, so a `MiddleClick`/`RightClick` binding over a link is
  unaffected and fires normally.

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
timestamps = epoch ms. Flush to `<root>/.loom/loom.db` on each mutation (NFR-7).

**Persistence (R2, OPTION A — supersedes the original "fresh DB per launch"
OQ-2 default):** chat PERSISTS across launches. `db.init()` loads an existing
`<root>/.loom/loom.db` when present (fresh schema only when absent or the file
is corrupt). Content is removed ONLY by the explicit `purge_all` tool — never on
close. **Single-writer-per-folder assumption (known limitation, not enforced):**
each PROCESS loads + flushes the WHOLE serialized image (last-writer-wins), so
two **processes** on the SAME folder can durably clobber each other on flush.
Same-folder duplicate **windows** are SAFE — they run in ONE process sharing the
single in-memory store, which is exactly why `WINDOW_NEW` always duplicates
in-process and `WINDOW_OPEN_FOLDER` declines (with a notice) to spawn a second
process onto a folder a live Loom already serves. Cross-process same-folder is
mitigated (not solved) by `mcp.json` ownership routing agents to one owning
instance; no folder lock yet (a separate decision). Treat one writer PROCESS per
folder as the contract until a lock lands.

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
| `src/main/engine.ts` | agent-systems-architect | The 10 tools as PURE fns over db + bus. Testable without Electron. |
| `src/main/mcp.ts` | agent-systems-architect | MCP Streamable-HTTP server on :7077; thin wrapper over engine. |
| `src/main/eventbus.ts` | realtime-engineer | In-process pub/sub for `LoomEvent`. |
| `src/main/ws.ts` | realtime-engineer | Optional external ws feed on :7078 (`LOOM_WS=1`). |
| `src/main/watcher.ts` | realtime-engineer | chokidar watcher → `FileEvent`s on the bus. |
| `src/main/sandbox.ts` | security-engineer | Law 3 boundary; tree build; file read + dispatch. |
| `src/main/config.ts` | backend-engineer | Persisted theme in userData/loom-config.json. |
| `src/main/ipc.ts` | backend-engineer | ipcMain handlers + live-feed/counters/live-state pump. |
| `src/main/definition-core.ts` | backend-engineer | PURE (fs/DOM-free) `findDefinitionsInText(text, symbol, ext)` — language-aware DEFINITION regex table by ext family (TS/JS/Python/generic). |
| `src/main/definition.ts` | backend-engineer | `createDefinitionFinder(sandbox)` — validates the symbol, walks the sandbox, ranks + caps candidates (confined + bounded; Law 1/3). |

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
| `src/renderer/lib/symbol-at.ts` | frontend-engineer | PURE `wordAt(lineText, columnOffset)` — expand the identifier under a caret offset (same IDENT class as highlight.ts); rejects keywords/literals/numbers. |
| `src/renderer/lib/caret-column.ts` | frontend-engineer | PURE caret→column mapping helpers for the go-to-definition glue. |
| `src/renderer/lib/definition-dispatch.ts` | frontend-engineer | PURE go-to-definition dispatch logic (0→toast / 1→jump / >1→picker; staleness). |
| `src/renderer/lib/match-highlight.ts` | security-engineer | Single shared Law-1 escaped-slice match highlighter (`highlightedMatchHtml`/`hitText`) shared by SearchView + DefinitionPicker. |
| `src/renderer/components/DefinitionPicker.tsx` | frontend-engineer | Multi-candidate go-to-definition chooser overlay (reuses search-result affordances; modal listbox a11y). |
| `src/renderer/components/SymbolChooser.tsx` | frontend-engineer | Keyboard-only symbol chooser: when F12 fires with no caret on a multi-identifier line, pick WHICH symbol to resolve. |
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
| `test/acceptance.mjs` | sdet | node --test suite exercising the 10 tools + schema + dispatch + safety. |
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
