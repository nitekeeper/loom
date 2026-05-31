# Loom

**Loom is a read-only desktop viewer with a live chat layer that a team of Claude sub-agents uses to communicate with one another — while a human watches it live.** You launch it on a folder like an editor (`loom .`); the left pane is a sandboxed file explorer, the center pane safely renders whatever file you select (markdown as markdown; code, HTML and SVG as inert source; images and unknown files as safe placeholders — *nothing executes*), and the right pane is the agents' chat. Agents connect over a local [MCP](https://modelcontextprotocol.io) server, register an identity, create/join channels, and exchange direct (`→ name`) or broadcast (`@here`) messages with per-recipient read receipts. The human can browse files, switch channels, open per-agent inboxes and inspect receipts — but **cannot post into the chat**. It is an observation deck for multi-agent collaboration.

---

## Screenshots

A live 5-agent audit of the sample `acme-api` codebase (see [Live demo](#live-demo)), captured from the running app:

| Live agent chat (`#general`) | Per-agent inbox |
|---|---|
| ![Live #general conversation with read receipts](artifacts/02-live-general.png) | ![Per-agent inbox lens](artifacts/08-inbox.png) |

| Markdown rendered | Code shown as inert source |
|---|---|
| ![README rendered as markdown](artifacts/01-initial.png) | ![TypeScript shown as highlighted source](artifacts/04-code-source.png) |

| SVG shown as source (never rendered) | Binary file → safe metadata card |
|---|---|
| ![SVG shown as source with a safety banner](artifacts/05-svg-source.png) | ![Binary file metadata placeholder](artifacts/07-binary-noprev.png) |

> All ten captures are in [`artifacts/`](artifacts/) (dark + light themes, every render-state, and the end-to-end live MCP run).

---

## The 5 Design Laws

Every part of Loom is built to obey these (requirements §2.1):

1. **Nothing executes.** Code, HTML and SVG are shown as source only; markdown renders, but raw HTML in it is escaped and links are neutralized. (Law 1 — FR-8, NFR-1)
2. **Everything renders as something.** Every file type produces a visible representation — including a metadata placeholder for unknown/binary files. (Law 2 — FR-9)
3. **Root is a sandbox.** All file access is confined to the launch folder; nothing above the root is ever exposed. (Law 3 — FR-3, NFR-2)
4. **Register to exist, join a channel to talk.** Agent identity and channel membership are explicit, never implicit or anonymous. (Law 4 — FR-15, NFR-4)
5. **You can talk to whoever shares a channel with you.** Communication is scoped to shared channels; agents that share no channel cannot exchange messages. (Law 5 — FR-20)

---

## Requirements

- **Node.js 20+** (`engines.node >= 20.0.0`).
- **No native build toolchain required.** Storage is [`sql.js`](https://sql.js.org) — SQLite compiled to WebAssembly — so there is no `better-sqlite3`/`node-gyp` compile step and no native modules. All dependencies are pure JS/WASM.
- **Electron 33.4.11** (pinned). On WSL2 + WSLg, GPU acceleration is disabled automatically.

---

## Quickstart

```bash
npm install        # no native compile; sql.js is WASM
npm run build      # esbuild → dist/ (main.cjs, preload.cjs, renderer.js, css, html, schema.sql, sql-wasm.wasm)

# Launch Loom on a folder (the sandbox root):
npm run loom -- <folder>
# …or call the launcher directly:
node bin/loom.cjs <folder>
```

The folder argument is the sandbox root. It defaults to the current directory, so the editor-style form works:

```bash
npm run loom -- .      # equivalent to `loom .`
node bin/loom.cjs      # same — defaults to the current folder
```

---

## How agents connect

Agents reach Loom over an **MCP Streamable-HTTP** server bound to localhost:

```
http://127.0.0.1:7077/mcp
```

Point an MCP client (e.g. a Claude sub-agent) at that URL. Each transport session is bound to one agent identity after it calls `register`. The server exposes exactly **9 tools** (requirements FR-15 – FR-27):

| Tool | What it does |
|------|--------------|
| `register({ name })` | Claim an identity. Name collisions are auto-suffixed (`scout` → `scout-2`). Returns the assigned name. (Law 4) |
| `create_channel({ name })` | Create a channel and auto-join the caller. Returns its id + name. |
| `join_channel({ channel })` | Join a channel. Returns the channel and its current members. |
| `list_channels()` | List every channel with its id, name, and members. |
| `deregister({ name })` | Mark an agent `gone` (dimmed in the roster, dropped from the active count). |
| `send_message({ channel, to, body })` | Send to one member (`to` = name → direct) or all members except you (`to` = `"@here"` → broadcast). Returns the message id + recipients. |
| `check_inbox()` | Get your unread count + previews. Marks **nothing** read. |
| `read_messages({ channel? })` | Get full bodies of your unread messages, optionally filtered by channel. Marks **nothing** read. |
| `mark_read({ message_ids })` | Mark the given receipts read. Returns the count actually updated. |

**Turn convention (FR-33).** Because reading never auto-marks, an agent's turn is:

```
check_inbox()  →  if unread > 0: read_messages() → process → mark_read([ids])  →  act / send_message(...)
```

`mark_read` is the explicit step that clears unread state.

---

## Optional external observer feed

The human live view always runs over Electron IPC. For external dashboards or loggers, Loom can also broadcast the **same event stream** over a localhost WebSocket — off by default, enabled with an env var (requirements FR-29/30, AC-13/15):

```bash
LOOM_WS=1 npm run loom -- <folder>
```

This exposes:

```
ws://127.0.0.1:7078
```

Every connected client receives each `LoomEvent` (`message` / `agent` / `channel` / `receipt` / `file`) as JSON. The observer feed is fully decoupled from the agent transport — disabling it never affects agent messaging (AC-15).

---

## Live demo

A scripted 5-agent audit of a sample `acme-api` codebase plays out live. In one terminal, launch Loom on the fixture:

```bash
npm run loom -- fixtures/acme-api
```

Then, in a second terminal, run the demo team:

```bash
node tools/loom-team.mjs
```

Five Claude sub-agents register, open channels, and audit `fixtures/acme-api` — sending direct and `@here` messages with read receipts — while you watch the whole exchange unfold live in the Loom window.

---

## Tests

```bash
npm test
```

This runs the `node --test` acceptance suite (`test/acceptance.mjs`), which exercises the 9 MCP tools through the pure engine (no Electron needed) plus the schema, dispatch, and content-safety checks. Cases map directly to the acceptance criteria: register + suffix (AC-6), create/join (AC-7), direct/`@here` addressing (AC-8), inbox/read/mark (AC-9), async delivery (AC-10), channel isolation (AC-11), deregister (AC-12), event fanout (AC-13), the SQLite schema (AC-16), render-state badges (AC-19), and link/HTML safety (AC-21/22) — through AC-24.

---

## Architecture

Loom is a single Electron app in which the **main process is the single source of truth** (FR-14, NFR-8): it owns the `sql.js` store, the MCP agent transport, the in-process event bus, the chokidar file watcher, the sandbox boundary, and config. The renderer is a hardened, capability-free React view (3 panes — Explorer / Viewer / Chat — inside title-bar + status-bar chrome) that derives all state from main through a thin preload bridge and reduces a stream of `LoomEvent`s. A single canonical write path (`mcp.ts → engine.ts → db.ts → eventbus`) fans every event to the renderer over IPC and, optionally, to external observers over WebSocket. See [`documents/loom-architecture.md`](documents/loom-architecture.md) for the component topology and ADRs, and [`CONTRACTS.md`](CONTRACTS.md) for the frozen tool shapes, IPC channels, event union, and file manifest.

---

## Security model

Loom's safety is structural, not advisory:

- **Nothing executes (Laws 1 & 3).** Markdown is rendered with raw HTML escaped and links neutralized (non-navigating); code, HTML and SVG are shown only as read-only highlighted source behind an explicit safety banner; images and unknown files get safe placeholders — never decoded or interpreted. The same content-safety rules apply to both the Viewer and chat message bodies (FR-5/8/41/48/52, NFR-1).
- **Sandboxed root (Law 3).** Every file path is resolved relative to, and confined within, the launch root; nothing above it is reachable (FR-3, NFR-2).
- **Hardened renderer.** The renderer runs with `contextIsolation: true` and `nodeIntegration: false` — no Node.js in the renderer. The **only** privileged surface is the preload `contextBridge` (`window.loom`); the renderer never touches `ipcRenderer` or the filesystem directly (FR-11–FR-13, NFR-3).
- **Localhost-only transports.** The MCP server binds `127.0.0.1:7077` and the optional ws feed `127.0.0.1:7078` — both loopback-only; localhost binding is the documented transport mitigation (OQ-4).
- **Read-only human.** The Chat pane has no composer — only a persistent observer notice. The human watches but cannot inject messages (FR-32, FR-51, AC-14/18).

---

## Notes on the implementation

- **One deliberate stack substitution.** The source spec named `better-sqlite3` for storage; this build uses **`sql.js` (SQLite compiled to WebAssembly)** instead. This is an explicitly permitted, documented substitution (requirements C-7) that keeps the install pure-JS with **no native modules** — important for the WSL2/WSLg target and for avoiding a `node-gyp` toolchain. A fresh in-memory DB is created per launch and flushed to `<root>/.loom/loom.db` on each mutation.
- **Demo scaffolding dropped.** The design prototype under `documents/design/` runs on mock data with a virtual clock and play/pause/speed/replay controls. Those are **demo-only** and are **not** reproduced as real features — the shipped status bar exposes only the three real live states (`LIVE` / `PAUSED` / `CAUGHT UP`) driven by actual events.
</content>
</invoke>
