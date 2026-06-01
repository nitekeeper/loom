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
- **Electron 33.4.11** (pinned; cross-platform — a clean `npm install` fetches the per-OS binary). On WSL2 + WSLg only, GPU acceleration and the OS-level renderer sandbox are disabled automatically; on macOS / Windows / non-WSL Linux they stay ON.

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

## Cross-platform (macOS / Windows / Linux)

Loom runs on **macOS, Windows, and Linux** with **no native build step**. Storage is [`sql.js`](https://sql.js.org) (SQLite compiled to WebAssembly), so there is no `node-gyp`/`better-sqlite3` compile and no native modules — the dependency tree is pure JS/WASM. The install / build / launch commands are **identical on every OS**:

```bash
npm install                  # no native compile (sql.js is WASM)
npm run build                # esbuild → dist/
npm run loom -- <folder>     # launch on a sandbox root
# …or simply:
npm start                    # electron .  (defaults to the current folder)
```

Electron itself is cross-platform: a clean `npm install` fetches the correct per-OS Electron binary automatically.

Platform-specific behavior is handled at runtime, all additively:

- **GPU + OS sandbox.** Hardware acceleration and Chromium's OS-level renderer sandbox stay **ON** on macOS, Windows, and non-WSL Linux. They are disabled **only** under WSL2 + WSLg (which has no working GPU and breaks the renderer's seccomp/namespace sandbox); detection is automatic.
- **Title bar.** On macOS the main window uses Electron's `titleBarStyle: 'hiddenInset'`, so the native traffic-light controls float inset over Loom's own single, clean title bar (the bar is a window drag region; the identity content is padded clear of the lights). On Windows and Linux the standard **native window frame** draws the controls and handles dragging. There are **no faux/painted window controls** on any platform — the real OS controls are used everywhere.
- **File watching.** The chokidar watcher uses each OS's native backend automatically (FSEvents on macOS, `inotify` on Linux, `ReadDirectoryChangesW` on Windows).
- **Paths.** Every path in the renderer contract (the file tree, file events, search results) is **POSIX (`/`-separated) on every OS**, while filesystem access uses the platform's native separators — so the UI behaves identically on Windows (backslash) and POSIX hosts, and the sandbox containment (Law 3) holds on all three.

**Verification status.** This project is currently **runtime-verified on Linux/WSL** (the build/CI host). The macOS and Windows paths are **code-level cross-platform** (separator normalization, GPU/sandbox gating, and the macOS title-bar integration are correct-by-construction and unit-tested where pure) and should be **smoke-tested on those OSes** before shipping there.

### Run on Windows (portable build)

You can produce a **self-contained Windows portable build** — a folder you copy to a Windows PC and run, with **no install and no Node/Electron required on the target machine**. It is **cross-built from Linux** (it downloads the official `win32-x64` Electron prebuilt; no Wine needed):

```bash
npm run package:win          # → release/Loom-win32-x64.zip
```

This bundles the built `dist/`, a **production** `node_modules` (so the runtime `require()`s for `ajv` / `ajv-formats` via the MCP SDK resolve), and the Windows Electron runtime, then renames `electron.exe` → `Loom.exe`.

On the **Windows** PC:

1. **Unzip** `Loom-win32-x64.zip` anywhere (e.g. `C:\Tools\Loom\`).
2. **Run `Loom.exe`.** Because a double-clicked app has no useful working directory, Loom opens a native **"Choose a folder for Loom to open"** picker on first launch — pick the project folder you want as the sandbox root. Cancelling the picker quits gracefully.

You can also skip the picker by giving the folder up front:

```bat
Loom.exe C:\path\to\project
```

…or simply **drag a folder onto `Loom.exe`** — the dropped folder becomes the sandbox root.

The chosen folder is the Law 3 sandbox boundary: Loom confines all file access to it, exactly as the `loom <folder>` launcher does on Linux/macOS.

> **Unverified on Windows.** This portable build is **cross-built on Linux and has NOT been executed on Windows** (the build host has no Windows and no Wine). It is correct-by-construction and structurally verified (every required file is present, no Linux native `.node` binaries ship). **Smoke-test it on a real Windows PC before relying on it.**
>
> **Default icon / no exe branding.** The executable keeps the **default Electron icon** and generic version metadata — custom icon + exe metadata require `rcedit` (which needs Wine) and are intentionally skipped in the Wine-free build.

### Windows installer (NSIS, built by CI)

For a **proper installer** — a `Loom-Setup-<version>.exe` with a Start Menu shortcut, a desktop shortcut, an uninstaller, and a "choose install directory" step — Loom uses [`electron-builder`](https://www.electron.build) on a **real Windows runner**. The NSIS installer **cannot be built on Linux** (it needs `makensis`, which needs Wine), so it is produced by **GitHub Actions on `windows-latest`** via the **`Windows installer`** workflow (`.github/workflows/windows-installer.yml`). The same job also emits an unpacked **portable `.exe`**.

**To build it:**

- **Tagged release** — push a version tag and the workflow builds *and* publishes a GitHub Release with the installer attached:
  ```bash
  git tag v0.5.0
  git push origin v0.5.0
  ```
- **Manual** — trigger the workflow with no tag (builds the installer as a downloadable artifact, no Release):
  ```bash
  gh workflow run "Windows installer"
  ```
  …or use the **Actions** tab → **Windows installer** → **Run workflow**.

**To get the installer:**

- On a **tag** build: download `Loom-Setup-<version>.exe` from the **GitHub Release**.
- On **any** build (tag or manual): download it from the workflow run's **`loom-windows-installer`** artifact (Actions → the run → Artifacts).

**Installing on Windows:** run `Loom-Setup-<version>.exe`. It is a **standard per-user installer** (no admin required) — it lets you choose the install directory, creates Start Menu and desktop shortcuts named **Loom**, and registers an uninstaller (Settings → Apps, or Add/Remove Programs). Launched from the Start Menu, Loom shows the **"Choose a folder for Loom to open"** picker (same as the portable build), since a shortcut launch has no folder argument.

> **Unsigned — SmartScreen will warn.** The installer is **not code-signed** (no certificate), so Windows SmartScreen shows a *"Windows protected your PC"* dialog on first run. Click **More info → Run anyway** to proceed. As with the portable build, the installer is **built on CI but UNVERIFIED on Windows** until smoke-tested on a real Windows PC — **smoke-test it before relying on it.**

### macOS installer (.dmg, built by CI)

For macOS, Loom ships a standard **`.dmg` disk image** (drag-to-`/Applications`) built with [`electron-builder`](https://www.electron.build) on a **real macOS runner**. A macOS app bundle / `.dmg` **cannot be built on Linux or Windows** — it needs Apple's `hdiutil` + `codesign` — so it is produced by **GitHub Actions on `macos-latest`** via the **`macOS installer`** workflow (`.github/workflows/macos-installer.yml`). Two architecture builds are produced so it runs on either Mac: **`arm64`** (Apple Silicon — M1/M2/M3…) and **`x64`** (Intel). A matching `.zip` of the app bundle is emitted alongside each `.dmg`.

> **Note — CI minutes cost.** `macos-latest` runners bill Actions minutes at a **10x multiplier on private repos** (and draw from a smaller free-minutes pool) than Linux/Windows runners. Keep tag pushes deliberate.

**To build it:**

- **Tagged release** — push a version tag and the workflow builds *and* publishes a GitHub Release with the `.dmg`s + `.zip`s attached:
  ```bash
  git tag v0.5.0
  git push origin v0.5.0
  ```
- **Manual** — trigger the workflow with no tag (builds the installer as a downloadable artifact, no Release):
  ```bash
  gh workflow run "macOS installer"
  ```
  …or use the **Actions** tab → **macOS installer** → **Run workflow**.

**To get the installer:**

- On a **tag** build: download `Loom-<version>-arm64.dmg` (Apple Silicon) or `Loom-<version>-x64.dmg` (Intel) from the **GitHub Release**.
- On **any** build (tag or manual): download them from the workflow run's **`loom-macos-installer`** artifact (Actions → the run → Artifacts).

**Installing on macOS:** open the `.dmg` and drag **Loom** to your **Applications** folder. Launched from Launchpad / Applications (no folder argument), Loom shows the **"Choose a folder for Loom to open"** picker (same as on Windows) — pick the project folder to use as the sandbox root.

> **Unsigned + un-notarized — Gatekeeper will block it.** The `.dmg` is **not code-signed with an Apple Developer ID and not notarized** (it uses an ad-hoc codesign — `identity: null`). On first open, macOS **Gatekeeper** refuses to launch it ("Loom can't be opened because Apple cannot check it for malicious software", or on Apple Silicon a misleading **"Loom is damaged and can't be opened"**). This is expected for an unsigned build — clear it with **any one** of:
>
> 1. **Right-click → Open.** In `/Applications` (or on the mounted `.dmg`), **right-click** (or Control-click) **Loom → Open**, then click **Open** in the dialog. This adds a one-time exception.
> 2. **Strip the quarantine attribute** from a terminal:
>    ```bash
>    xattr -dr com.apple.quarantine "/Applications/Loom.app"
>    ```
>    This removes the `com.apple.quarantine` flag macOS sets on downloaded apps (the cause of the "damaged" message on Apple Silicon).
> 3. **System Settings → Privacy & Security.** After a blocked launch attempt, open **System Settings → Privacy & Security**, scroll to the security notice about Loom, and click **Open Anyway**.
>
> **Apple Silicon "damaged" note.** On Apple Silicon, the block often surfaces as a *"damaged"* message rather than an "unidentified developer" one — the app is **not** actually damaged; it is the quarantine flag on an unsigned/un-notarized build. Clearing the quarantine (option 2) resolves it.
>
> **Proper distribution.** Shipping a Mac app that opens with no Gatekeeper friction requires an **Apple Developer ID certificate (~$99/yr)** for code-signing plus **notarization** (Apple's automated malware scan). Both can be added later via electron-builder (set a signing `identity`, supply the cert, and add an `afterSign` notarize hook) without changing the app itself. Until then the bypass steps above are required.

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
