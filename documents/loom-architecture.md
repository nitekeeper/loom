# Loom — Architecture & ADRs

| Field | Value |
|-------|-------|
| **Architect** | Dr. Hiroshi Tanaka (software-architect-1) |
| **Date** | 2026-05-31 |
| **Status** | Contracts FROZEN — skeleton phase |
| **Authoritative requirements** | `documents/loom-requirements.md` (54 FR, 12 NFR, 24 AC, 5 Laws, Appendix A) |
| **Contract surface** | `CONTRACTS.md` (the implementer-facing single source of truth) |

This document records the system-level architecture and the resolved
architectural decisions (ADRs) for the production build of Loom. It does **not**
specify feature logic — only the component topology, the message-flow pipeline,
the security model, and the decisions implementers must build against.

---

## 1. Component topology

Loom is a single Electron application. The **main process is the single source
of truth** (FR-14, NFR-8): it owns the database, the agent transport, the event
bus, the file watcher, config, and the sandbox boundary. The renderer is a
hardened, capability-free React view that derives all state from main through a
thin preload bridge.

```
                          ┌─────────────────────────────────────────────────────────┐
   AI agents (MCP)        │                    MAIN PROCESS                           │
   ───────────────►       │   (single source of truth — FR-14 / NFR-8)               │
   127.0.0.1:7077         │                                                          │
   Streamable-HTTP        │   ┌──────────┐   pure    ┌───────────┐   read/write      │
                          │   │  mcp.ts  │──calls───►│ engine.ts │◄──────► db.ts      │
                          │   │ (thin    │           │(10 tools, │        (sql.js     │
                          │   │  wrapper)│           │  PURE)    │         WASM,      │
                          │   └──────────┘           └─────┬─────┘         in-mem +   │
                          │                                │ publish        flush to  │
   sandbox root           │   ┌───────────┐  FileEvent     ▼          .loom/loom.db)  │
   ~/work/acme-api ──────►│   │ watcher.ts│──────────► ┌──────────┐                   │
   (chokidar)             │   │ (chokidar)│           │eventbus  │                   │
                          │   └───────────┘           │ (pub/sub)│                   │
                          │   ┌───────────┐           └────┬─────┘                   │
                          │   │ sandbox.ts│  tree/file      │ LoomEvent              │
                          │   │ (Law 3)   │  content        ├──────────────┐         │
                          │   └─────┬─────┘                 ▼              ▼         │
                          │         │              ┌─────────────┐  ┌─────────────┐  │
                          │   ┌─────▼─────┐         │   ipc.ts    │  │   ws.ts     │  │
                          │   │ config.ts │         │ (IPC pump + │  │ (optional   │  │
                          │   │ (theme)   │         │  handlers)  │  │  ws feed,   │  │
                          │   └───────────┘         └──────┬──────┘  │  :7078,     │  │
                          │                                │         │  LOOM_WS=1) │  │
                          └────────────────────────────────┼─────────┴──────┬──────┘
                                              IPC (contextBridge)            │ same LoomEvent shape
                                                           │                 ▼
                          ┌────────────────────────────────▼──────┐   external observers
                          │            PRELOAD (preload.ts)        │   (dashboards / loggers)
                          │  contextBridge → window.loom           │
                          │  (the ONLY privileged surface — FR-13) │
                          └────────────────────────────────┬───────┘
                          ┌────────────────────────────────▼───────────────────────┐
                          │   RENDERER (React IIFE) — hardened, no Node             │
                          │   contextIsolation:true · nodeIntegration:false (FR-11/12)│
                          │                                                         │
                          │   App ── TitleBar · StatusBar ── Explorer | Viewer | Chat│
                          │            (chrome)                (3 content panes)      │
                          │   + human-only bottom-dock Terminal (Ctrl+`, @xterm/xterm│
                          │     ⇄ node-pty over loom:terminal:* IPC) — OQ-6 resolved  │
                          │   safe render: lib/markdown (html:false, inert links) + │
                          │   lib/highlight (read-only tokenizer) — Law 1            │
                          └─────────────────────────────────────────────────────────┘
```

Two transports are **deliberately separate** (AC-15, NFR-9 vs NFR-10):

- **Agent transport** — MCP Streamable-HTTP on `127.0.0.1:7077`. How agents act.
- **Observer feed** — Electron IPC (always) + optional external `ws` on
  `127.0.0.1:7078` (`LOOM_WS=1`). How humans/dashboards watch.

Disabling the ws feed never affects agent messaging.

---

## 2. Message-flow pipeline

A single canonical write path keeps the system deterministic and testable:

```
agent ──MCP tool call──► mcp.ts ──► engine.ts (validate Law 4/5, mutate)
                                        │
                                        ├─► db.ts  (insert message + per-recipient
                                        │           receipts; flush to disk)
                                        │
                                        └─► eventbus.publish(LoomEvent)
                                                  │
                          ┌───────────────────────┴───────────────────────┐
                          ▼                                                ▼
                  ipc.ts → webContents.send                       ws.ts → broadcast
                  (IPC 'loom:event')                              (JSON, if LOOM_WS=1)
                          ▼                                                ▼
                  preload onEvent → window.loom                   external observer
                          ▼
                  renderer store reduces event → React re-render
```

The file watcher feeds the **same** bus with `FileEvent`s, so the Explorer's
live activity and the ws feed observe filesystem changes through the identical
mechanism (FR-29/30, FR-39).

`send_message` is the worked example (FR-21, OQ-3): the engine resolves
recipients **at send time** — for `@here`, every current channel member except
the sender; for a direct `to`, the single named member (validated to share the
channel, Law 5). It writes one `messages` row and one `receipts` row per
recipient, then publishes a `MessageEvent` carrying the resolved recipient list.

---

## 3. Security model (Laws 1 & 3, FR-11..FR-14)

**Law 1 — "Nothing executes."** Three independent layers:

1. **Renderer hardening** (FR-11/12, AC-5): `contextIsolation:true`,
   `nodeIntegration:false`, `sandbox:true`; the renderer has no Node, no
   `require`, no direct IPC. All capability arrives via the preload `window.loom`
   bridge (FR-13).
2. **Safe rendering** — one shared renderer (`lib/markdown`, markdown-it with
   `html:false`) escapes all embedded HTML and a custom link rule neutralizes
   every `href` so links render but never navigate (FR-5/48/52, AC-21/22). Code,
   SVG, and HTML are shown only as highlighted **source** by a read-only
   tokenizer that emits escaped text (FR-6/7/8, AC-3b/c). Images are a safe
   checkerboard **placeholder**, never decoded (FR-10).
3. **Content-Security-Policy** (`index.html`) — `default-src 'none'`,
   `script-src 'self'` (only the bundled IIFE; no inline/remote/eval),
   `connect-src 'none'`. Defense-in-depth even if (1) or (2) regressed.

> Note: the Chromium process flag `--no-sandbox` (required under WSL because the
> `chrome-sandbox` SUID bit is unset) is the **OS** process sandbox and is
> orthogonal to the renderer hardening above, which is always kept.

**Law 3 — "Root is a sandbox."** Every path the renderer requests and every path
the watcher reports passes through `sandbox.resolveInRoot()` (FR-3, NFR-2,
AC-2), which rejects absolute paths, `..` traversal, and realpath escapes. The
renderer can only name root-relative paths; it never sees absolute filesystem
paths.

**Laws 4 & 5** are enforced in `engine.ts`: identity is explicit (`register`
binds a name; suffix-on-collision), and a message is only valid when sender and
target share the channel.

---

## 4. Module strategy (the #1 footgun — frozen)

One coherent strategy across `tsc`, `esbuild`, and Electron:

- **Author** every source file as **ESM** (`import`/`export`) `.ts`/`.tsx`.
  `tsconfig` uses `module: ESNext`, `moduleResolution: bundler` so the
  type-checker sees the exact import graph esbuild bundles.
- **Emit** per target via esbuild: **main = CJS** (`dist/main.cjs`,
  `platform=node`), **preload = CJS** (`dist/preload.cjs`), **renderer = IIFE**
  (`dist/renderer.js`, `platform=browser`). Electron loads main/preload as
  CommonJS, which is the friction-free path; `package.json` is therefore
  `"type": "commonjs"` and the main entry is the `.cjs` bundle.
- **`electron` is external** in every bundle; everything else is bundled.
- **sql.js wasm** is *not* bundled — `build.mjs` copies `sql-wasm.wasm` and
  `schema.sql` beside `main.cjs`; `db.ts` locates them via `__dirname` at runtime.

See `CONTRACTS.md` §"Module strategy" for the authoritative table.

---

## 5. Architecture Decision Records

Each ADR records a decision already resolved by the orchestrator; they are not
re-opened here.

### ADR-0001 — Three side-by-side content panes; human-only terminal added as a bottom dock (OQ-6 resolved)
**Decision:** The UI is a CSS grid `auto auto 1fr`: TitleBar + StatusBar chrome
over a body of exactly three side-by-side content panes — Explorer | Viewer | Chat.
The "terminal" named in early project memory is **not** one of those three content
panes; it has since been added as a separate **human-only bottom-dock terminal**
below the body, toggled with **Ctrl+`**, built on **@xterm/xterm** (renderer) and
**node-pty** (main) over `loom:terminal:*` IPC.
**Rationale:** The design prototype mounts only the three content panes, so the
side-by-side layout (FR-34, AC-17) is unchanged. The bottom-dock terminal is
**human-only and MCP-invisible (no agent surface)** — agents cannot see or drive
it — so it does not conflict with Law 1's no-execution guarantee for the rendered
file/message content agents produce. (FR-34, AC-17.)

### ADR-0002 — Storage: sql.js (WASM) substituting for better-sqlite3
**Decision:** Use **sql.js** (pure-WASM SQLite). Run the **exact Appendix-A DDL**.
In-memory DB, durable within a session by flushing the serialized DB to
`<root>/.loom/loom.db` on each mutation. Fresh DB per launch (OQ-2: no
cross-session history by default).
**Rationale:** Native modules (better-sqlite3) fail to build against Electron's
ABI in the WSL sandbox (forbidden). sql.js is pure-WASM, needs no native build,
and satisfies the schema verbatim so **AC-16** holds. Cross-session retention is
explicitly out of scope per OQ-2; the on-disk flush gives within-session
durability (NFR-7) and a future opt-in to reload it.
**Trade-off:** sql.js is synchronous and in-memory (whole-DB serialize on flush);
acceptable at Loom's scale (one team, thousands of messages). Revisit if write
volume grows.

### ADR-0003 — Hand-rolled read-only highlighter (not Monaco/Shiki)
**Decision:** Port the prototype's per-line tokenizer
(`design/app/highlight.jsx` → `highlightLine`/`highlightCode`) to TypeScript.
**Rationale:** The spec permits Monaco/Shiki, but a read-only tokenizer that
executes nothing and only emits escaped `<span class="tok-*">` is strictly safer
(Law 1) and pixel-faithful to the screenshots. It also avoids a heavy editor
dependency and any worker/eval surface. (FR-6, AC-3b.)

### ADR-0004 — One safe markdown renderer for Viewer + Chat
**Decision:** A single `lib/markdown` built on markdown-it with `html:false` and
a custom link rule that neutralizes `href`s. The Viewer's full `.md` render and
the Chat inline message bodies use the **same** renderer.
**Rationale:** A single chokepoint guarantees the cross-pane safety invariant
(FR-52): embedded HTML escaped, links non-navigating. Two renderers would risk
divergent safety. (FR-5/48/52, AC-21/22, Law 1.)

### ADR-0005 — `@here` recipients resolved at SEND time (OQ-3)
**Decision:** `send_message` resolves `@here` to the channel's current members
(except the sender) at the moment of sending and writes one receipt per
recipient. Agents that join later do **not** retroactively receive the message.
**Rationale:** Matches the receipt model (receipts are created at send) and gives
deterministic, testable delivery (AC-8). (FR-21/24.)

### ADR-0006 — Identity: suffix-on-collision vs ANY existing row; max name 64 (OQ-1)
**Decision:** `register(name)` suffixes on collision (`researcher` →
`researcher-2`) against **any** existing `agents` row, active or gone, so the PK
never conflicts. Names are capped at 64 chars.
**Rationale:** The `agents` PK is the name; reusing a gone name would violate the
PK and confuse receipts. Checking against all rows keeps identity monotonic.
(FR-15, AC-6.)

### ADR-0007 — MCP transport: Streamable-HTTP on 127.0.0.1:7077, no extra auth (OQ-4)
**Decision:** `@modelcontextprotocol/sdk` Streamable-HTTP transport bound to
`127.0.0.1:7077`. No authentication beyond `register()`; localhost binding is the
documented mitigation.
**Rationale:** Loom is a local developer tool; binding to loopback keeps the
surface off the network. Auth can be layered later without changing tool shapes.
(NFR-9, OQ-4.)

### ADR-0008 — Optional external ws observer feed (off by default)
**Decision:** A `ws` server on `127.0.0.1:7078`, OFF unless `LOOM_WS=1`, that
broadcasts the **same** `LoomEvent` shape as the IPC feed.
**Rationale:** Decouples external observers from Electron (FR-29/30, AC-13/15)
without coupling the agent transport (NFR-10). Default-off minimizes surface.

### ADR-0009 — Status-bar live state machine (3 real states); demo transport dropped
**Decision:** `LIVE` / `PAUSED` / `CAUGHT_UP`. PAUSED is a real observer control
that freezes incoming events + auto-scroll. The prototype's replay/speed/virtual
clock are **demo-only and dropped**. Counters are **real** telemetry from the
DB + watcher.
**Rationale:** FR-36 requires ≥3 real states; the demo transport is explicitly
non-normative scaffolding. (FR-36.)

### ADR-0010 — Theme persisted via main-process config file (FR-37, AC-20)
**Decision:** `loom-config.json` in `app.getPath('userData')`. Read on boot
(into `InitialState`), written on toggle via the `SET_THEME` IPC handler. Dark
default + light.
**Rationale:** The renderer is capability-free; persistence belongs in main. A
file under userData survives launches without a database dependency.

### ADR-0011 — Accessibility built in from the start (FR-54, NFR-12)
**Decision:** Real button/role/tabindex semantics, visible `:focus-visible`
outlines, the `@here` receipt breakdown reachable on hover **and** keyboard
focus, non-color cues for presence/unread/@here/seen, text labels on every
avatar, and `prefers-reduced-motion` honored for all animations.
**Rationale:** WCAG 2.2 AA is a stated target; retrofitting accessibility is more
expensive than building it in. (FR-54, NFR-12, AC-23.)

### ADR-0012 — Human chat is strictly read-only; observer notice replaces composer
**Decision:** No composer or text input anywhere in Chat; a persistent observer
notice occupies its place.
**Rationale:** The human observes; the chat belongs to agents (FR-32/51,
AC-14/18).

### ADR-0013 — Engine is pure; MCP server is a thin wrapper
**Decision:** All 10 tools (including the human-invoked `purge_all`) live as
pure functions in `engine.ts` over the `db` module + event bus. `mcp.ts` only
validates params and forwards calls.
**Rationale:** Lets the acceptance suite import and test all tools without
launching Electron, and isolates protocol concerns from business logic.

### ADR-0014 — Module strategy: author ESM, emit CJS (main/preload) + IIFE (renderer)
**Decision:** As in §4. `tsc` checks with `moduleResolution: bundler`; esbuild
emits per-target formats; `electron` external; sql.js wasm copied + located at
runtime.
**Rationale:** Keeps `tsc`, esbuild, and Electron in agreement — the single most
common integration failure for Electron + TS + bundler stacks.

### ADR-0015 — Offscreen `--capture` mode is feasible by design
**Decision:** The main process is structured so a later `--capture <out.png>`
mode can create an offscreen `BrowserWindow` (`webPreferences.offscreen:true`)
and `webContents.capturePage()` to a PNG without a display server.
**Rationale:** Screenshot capture must work headless in WSL; designing for it now
avoids a refactor later. (Environment constraint.)

---

## 6. Cross-cutting standards

- **Error handling:** the engine throws `LoomError(code, message)` for contract
  violations (`NOT_REGISTERED`, `NOT_A_MEMBER`, `CHANNEL_EXISTS`, …); `mcp.ts`
  maps these to MCP tool errors. The renderer never throws on bad data — it
  renders empty states (FR-42/53).
- **Logging/observability:** the event bus is the observability spine — every
  state change is a `LoomEvent`, mirrored to IPC and (optionally) ws. The status
  bar counters are the human-facing telemetry.
- **Timestamps:** all `INT` timestamps are epoch **milliseconds**.
- **Paths:** all paths crossing the IPC boundary are **root-relative POSIX**;
  absolute paths never leave main.

---

*End of document.*
