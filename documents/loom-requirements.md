# Loom — Requirements Document

| Field | Value |
|-------|-------|
| **Author** | Dr. Isabelle Fontaine |
| **Date** | 2026-05-31 |
| **Status** | Draft |
| **Version** | 0.5 |
| **Source** | Claude artifact: "Loom — Full Application Spec" (`d7dafc7d-b5bc-4cb1-87e8-15ddaebb1a32`) |

> **Traceability note:** All requirements below are grounded in the source artifact. Statements not explicitly supported by the source are marked **(inferred)**, and requirements derived from the design prototype are tagged **(inferred from design prototype)**, so each is distinguishable from sourced requirements.

### Design References

The following design assets were reviewed for v0.4 (located under `/home/nitekeeper/apps/loom/documents/design/`):

- **React UI prototype:** `design/Loom.html` and `design/app/` (`app.jsx`, `chat.jsx`, `explorer.jsx`, `highlight.jsx`, `data.jsx`, `loom.css`).
- **Screenshots (state captures):** `design/screenshots/` — `01-initial.png`, `01-live.png`, `01-states.png`, `02-live.png`, `02-states.png`, `03-states.png`, `04-states.png`, `05-states.png` (light theme), `06-end.png` (CAUGHT UP / README state).

> **Design-prototype caveat:** The prototype runs on mock/in-memory data. UI/UX requirements below are taken as authoritative for layout and interaction, but **no backend requirement is inferred from it**, and **no requirement is derived from placeholder content or demo-only scaffolding** (virtual clock, play/pause/speed/replay controls, scripted timings, faked receipt/membership math). There is no teardown screenshot, and the deregistered ("gone") agent styling exists in code but is not exercised in any screenshot (`goneSet` is always empty).

### Revision History

- **v0.2** — Expanded after independent review to restore MCP tool signatures and return shapes, the column-level SQLite schema, Electron renderer security architecture, the message-flow pipeline, the agent turn convention and lifecycle, verbatim design laws, and stack alternatives; corrected the human's chat role (read-only observation, no posting).
- **v0.3** — Removed a spurious 7-vs-9 MCP tool-count open question; the source heading is "4.2 MCP tool surface" with no count and exactly nine tools.
- **v0.4 (design reconciliation)** — Added UI/UX functional requirements (FR-34–FR-51) and acceptance criteria (AC-17–AC-20) derived from the design prototype, each tagged "(inferred from design prototype)". **Corrected the "4-pane" description to a 3-pane content layout (Explorer / Viewer / Chat) within title-bar + status-bar chrome, and flagged the absence of any "terminal" pane in the design (now OQ-6).** Reconciled OQ-5 (image preview is a first-class viewer render-state with a safe placeholder now, full decoding deferred). Softened FR-19's "drop from active rosters" to "marked gone, visually de-emphasized, excluded from the active count." Added observer-navigation requirements so "read-only" is not misread as "non-interactive." No backend requirement was changed.
- **v0.5 (UX review follow-up)** — Strengthened message-body and Viewer-markdown link/HTML safety as the chat/viewer analogues of Law 1 (FR-48, FR-5, new FR-52, AC-21, AC-22); made the receipt model testable and precise (FR-45); added chat empty-states (FR-53); expanded Explorer live-activity to three affordances — NEW badge, transient flash, persistent just-modified marker (FR-39); added a forward-looking **Accessibility** section targeting WCAG 2.2 AA (NFR-12, FR-54). Refined title-bar chrome notes (FR-35), channel-tab badge behavior (FR-47), inbox header fidelity (FR-50), and the Section 1 grid wording. No backend requirement was changed.

---

## 1. Overview / Purpose

Loom is, in the source's words, **"A desktop viewer with a built-in chat layer that AI agents use to communicate"** — launched like VS Code (`loom .`) — for teams of Claude sub-agents using async messaging with live human observation.

It combines two capabilities:

1. **A file explorer + content viewer** scoped to a folder's tree (the directory from which it is launched).
2. **An asynchronous messaging system** that AI agents use to communicate with one another while a human **watches it live** (the human does not participate in the chat).

The purpose of this document is to capture the functional and non-functional requirements for Loom as described in the source specification, providing a testable basis for design, build, and acceptance.

> **Layout terminology — "pane" (corrected in v0.4):** Earlier descriptions (and the project memory note) referred to a **"4-pane"** layout naming "explorer / viewer / chat / terminal." The design prototype shows **three content panes** — **Explorer** (left), **Viewer** (center), and **Chat** (right) — arranged inside a **chrome** of a **title bar** (row 1) and a **status bar** (row 2) stacked above the **3-pane body** (row 3) — i.e. a CSS grid with rows `auto auto 1fr`. Throughout this document, **"pane" refers only to one of those three content panes**; the title bar and status bar are "chrome," not panes. **There is no "terminal" pane anywhere in the design** — only Explorer, Viewer, and Chat are mounted. Whether the previously-described terminal pane was dropped or merely deferred cannot be determined from the design; see **OQ-6**.

---

## 2. Background & Context

Loom is a human-observable workspace for multi-agent (Claude sub-agent) collaboration. It pairs a read-only, sandboxed view of a project folder with a structured chat layer that agents use to coordinate, while a human observes the live feed. The design is governed by five explicit **Design Laws**.

### 2.1 Design Laws (verbatim)
1. **"Nothing executes"**
2. **"Everything renders as something"**
3. **"Root is a sandbox"**
4. **"Register to exist, join a channel to talk"**
5. **"You can talk to whoever shares a channel with you"**

*Interpretation sub-note (inferred):* Law 1 means markdown is rendered but code/HTML/SVG are shown as source only; Law 2 means every file type yields a visible representation (including metadata placeholders for unknown/binary); Law 3 confines all access to the launch root; Laws 4–5 mean identity and channel membership are explicit and communication is scoped to shared channels.

### 2.2 Build sequence
Development proceeds in phases (see Section 8). The source explicitly notes that **viewer phases (1–2) and chat phases (3–4) can be built in parallel** — they are not a strict linear dependency chain. (See M-3 reconciliation in Section 8.)

---

## 3. Goals & Non-Goals

### Goals
- Provide a safe, read-only file explorer and content viewer scoped to a single root folder.
- Render every file type as something visible to the human observer.
- Enforce a sandbox boundary at the root folder.
- Provide an asynchronous messaging substrate for AI agents with explicit identity and channel membership.
- Allow a human to **watch** agent-to-agent communication live (observation only).

### Non-Goals
- **Code/HTML/SVG execution** — Loom must never execute file content; code, HTML, and SVG are shown as source only (Law 1).
- **Human participation in chat** — the chat is the agents' communication channel; the human watches but does not post into it.
- **Image previews in the initial release** — safe image previews are deferred (see image-phase inconsistency note in Section 11, OQ-5).
- **Cross-channel agent communication** — agents communicate only within channels they share (Law 5).

---

## 4. Stakeholders / Target Users

| Stakeholder | Role / Need |
|-------------|-------------|
| **AI agents (Claude sub-agents)** | Primary actors in the messaging system; register, create/join channels, and exchange async messages via MCP tools. |
| **Human observer** | Watches agent communication live and browses the scoped folder tree. **The human cannot type into the chat** — the chat is the agents' communication channel and the human only observes it. "Read-only" applies to *posting*, not to *navigation*: the observer may interactively select files, switch channels, open per-agent inboxes, inspect receipts, and toggle the theme (see FR-45–FR-47, FR-50, FR-37). |
| **Lead agent / orchestrator** | Spawns sub-agents (assigning each a name), and calls `deregister(name)` for each when work is finished (see lifecycle, Section 7). |
| **Developers / builders of Loom** | Implement the phased build sequence and the defined technical stack. **(inferred)** |
| **External observers** | Optional dashboards/loggers that subscribe to the live feed over a WebSocket endpoint, decoupled from Electron. |

---

## 5. Functional Requirements

Keywords MUST / SHOULD / MAY are used per RFC 2119 conventions.

### Launcher & Explorer
- **FR-1** — The application MUST be launchable via the command `loom .` (launched like VS Code on a folder).
- **FR-2** — The application MUST present a file explorer scoped to the launch folder's tree.
- **FR-3** — The root folder MUST act as a sandbox boundary; the application MUST NOT expose files outside that root. (Law 3)

### Content Viewer / File Rendering
- **FR-4** — The viewer MUST dispatch files by extension deterministically.
- **FR-5** — `.md` files MUST render as processed markdown. The markdown renderer MUST HTML-escape all embedded/raw HTML (so no agent-authored HTML is interpreted) and MUST render any links as **non-navigating** (href neutralized), consistent with FR-8 / Law 1. **(escaping/inert-link behavior inferred from design prototype)**
- **FR-6** — Code/text files (`.js`, `.ts`, `.json`, `.css`, `.py`, `.html`) MUST display as syntax-highlighted source. Other text extensions (e.g. `.txt`) MUST default to the source view as well; the governing rule is the extension→source *mapping*, not any specific filename. **(`.txt`/other-text default inferred from design prototype.)**
- **FR-7** — `.svg` files MUST be treated as code source and MUST NOT be rendered as images.
- **FR-8** — The viewer MUST NOT execute any file content; markdown renders, but code, HTML, and SVG are shown as source only. (Law 1)
- **FR-9** — Every file type MUST render as something visible; unknown/binary files MUST display a metadata placeholder. (Law 2)
- **FR-10** — Images MUST be handled as a **first-class viewer render-state** (`PREVIEW`): the Viewer MUST display a **safe placeholder** for image files (labeled e.g. "{type} · safe preview", shown as a checkerboard card — **not** a decoded image). **Full image decoding/preview is deferred** (the prior "phase 2"/phase-5 Polish item). *(Reconciled in v0.4 — see OQ-5.)* **(safe-placeholder behavior inferred from design prototype)**

### Electron Renderer Security Architecture
- **FR-11** — The renderer MUST run with `contextIsolation: true`.
- **FR-12** — The renderer MUST run with `nodeIntegration: false` (no Node.js in the renderer).
- **FR-13** — All privileged access between renderer and main MUST flow through a thin **preload bridge**; the renderer MUST NOT have direct privileged access.
- **FR-14** — The **main process MUST be the single source of truth**, owning the SQLite store, the MCP server, the event bus, the file watcher, and lifecycle management.

### Chat — Identity & Channels (MCP Tool Surface)

- **FR-15** — `register(name)` — An agent MUST be able to register an explicit identity by name. The system MUST bind name→connection and **enforce uniqueness by suffixing on collision** (e.g. `researcher` → `researcher-2`). It MUST return the assigned name and an empty channels list — i.e. `{ ok, name, channels: [] }`. (Law 4)
- **FR-16** — `create_channel(name)` — An agent MUST be able to create a channel. Creation MUST **auto-join the calling agent**. It MUST return the channel id and name.
- **FR-17** — `join_channel(channel)` — An agent MUST be able to join a channel; the call MUST return the channel and its members list.
- **FR-18** — `list_channels()` — Takes no parameters; MUST return all channels with id, name, and members.
- **FR-19** — `deregister(name)` — Takes a name; MUST mark the agent's status as `gone`, visually de-emphasize it, and exclude it from the active-roster count, and return `{ ok, name }`. **(Reconciled in v0.4 with the design):** the design keeps a gone agent *visible but dimmed* in the roster (greyed presence) rather than removing it outright, so "gone" means de-emphasized and excluded from the active count — not necessarily deleted from view. **Note:** this gone-state UI exists in the prototype code but is not demonstrated in any screenshot.
- **FR-20** — Two agents MUST be able to communicate only if they share a channel; the system MUST prevent communication between agents that do not share a channel. (Law 5)

### Chat — Messaging
- **FR-21** — `send_message(channel, to, body)` — Takes three parameters. `to` MUST accept either a member name (**direct**) or the token `"@here"` (**broadcast**). Sending MUST create the message plus per-recipient receipts and MUST return the message id and the list of recipients.
- **FR-22** — The messaging system MUST support asynchronous messaging: agents post and read messages asynchronously. **Testable form:** a message sent while a recipient is offline MUST be retrievable by that recipient when it next calls `check_inbox()` / `read_messages()`.
- **FR-23** — The system MUST support **direct** messaging targeting an individual recipient (`to` = member name), stored with `addressing = 'direct'` and the recipient in `target`. (See schema FR-31; terminology mapping in M-6 note below.)
- **FR-24** — The system MUST support **broadcast** messaging via `to = "@here"`, delivered to all channel members except the sender, stored with `addressing = 'here'` and `target` NULL. (Schema FR-31)
- **FR-25** — `check_inbox()` — Takes no parameters; MUST return an unread count plus preview items, and MUST NOT mark anything read.
- **FR-26** — `read_messages(channel?)` — Takes an optional channel filter; MUST return the full bodies of unread messages, and MUST NOT mark them read.
- **FR-27** — `mark_read(message_ids)` — Takes an **array of message IDs**; MUST set `read_at` for the corresponding receipts and return the count marked.
- **FR-28** — The system MUST track per-recipient read state via the `receipts` table (a NULL `read_at` denotes unread), and this state MUST drive per-agent inboxes and unread counts. (Schema FR-31)

> **Terminology mapping (M-6):** The `send_message` parameter token `"@here"` maps to the stored `messages.addressing` enum value `'here'`. The `"@here"` form is the agent-facing API token; `'here'` is the persisted enum value.

### Live Feed & Event Distribution
- **FR-29** — On message persistence, the main process MUST publish the event to an **event bus** that fans the event out to (a) the renderer via **Electron IPC** (the built-in live view for the human) and (b) an **optional WebSocket** endpoint exposing the same feed to external observers (dashboards, loggers) without coupling them to Electron.
- **FR-30** — The human-facing live view MUST be driven by Electron IPC; the external-observer feed, when enabled, MUST be served over WebSocket and MUST expose the same event stream.

### Persistence (Schema)
- **FR-31** — The system MUST persist chat state in SQLite using the schema in Appendix A, including: `agents.status` enum (`'active' | 'gone'`), `channels.name` UNIQUE, `messages.addressing` enum (`'direct' | 'here'`) with a nullable `target`, `receipts.read_at` (NULL = unread) with a composite primary key `(message_id, recipient)`, and the partial index `idx_receipts_unread` on `(recipient) WHERE read_at IS NULL`. Primary and foreign keys MUST be enforced as specified in Appendix A.

### Human Observation
- **FR-32** — The chat MUST be **read-only for the human**; the human MUST be able to watch the live feed but MUST NOT be able to post messages into the chat.

### Agent Behavior
- **FR-33** — Agents SHOULD follow the **turn convention**: call `check_inbox()`; if the unread count > 0, call `read_messages()`, process the messages, then call `mark_read()`; then act/send as needed. (Because `read_messages()` does not auto-mark, `mark_read()` is the explicit step that clears unread state.)

### UI / UX (derived from design prototype)

> Each requirement in this subsection is tagged **(inferred from design prototype)**. None are derived from placeholder content or demo-only controls (virtual clock, play/pause/speed, replay), and none imply backend behavior beyond the existing FR-11–FR-14 / FR-29–FR-31.

#### Window Shell & Chrome
- **FR-34** — The application MUST present a window composed of a **title bar** and a **status bar** (chrome) above a **body of three side-by-side content panes**: **Explorer** (left), **Viewer** (center), and **Chat** (right). Default widths MUST be fixed-left / fluid-center / fixed-right (≈248px | 1fr | ≈400px), collapsing to narrower fixed widths (≈210px | 1fr | ≈360px) at small window widths (≈≤1080px). *(Note: the design renders the pane header labels uppercased — "EXPLORER" and "AGENT CHAT"; this document uses the conceptual names "Explorer" and "Chat", which is acceptable and non-normative as to casing.)* **(inferred from design prototype)**
- **FR-35** — The title bar MUST display the root folder name (with a lock/sandbox glyph) and the "Loom" product identity. The design additionally shows macOS-style traffic-light dots (left) and a right-aligned "loom ." launch-command label; these are **present-but-non-normative chrome** — in particular the traffic lights are likely OS-provided window controls and are **NOT** a requirement. **(inferred from design prototype)**
- **FR-36** — The status bar MUST display a **live-session state indicator** with at least three states: **LIVE**, **PAUSED**, and **CAUGHT UP**. *(The session counters — agents / channels / messages / receipts / files — MAY be specced separately as telemetry; in the prototype they are derived from mock arrays and faked receipt math and MUST NOT be read as live telemetry requirements. The transport/replay/speed controls are demo scaffolding and are NOT requirements.)* **(inferred from design prototype)**
- **FR-37** — The application MUST provide both a **light** and a **dark** theme, defaulting to dark, with the chosen theme **persisted across launches**. **(inferred from design prototype)**

#### Explorer Pane
- **FR-38** — The Explorer MUST display the root folder name together with a **persistent, visible sandbox notice** stating that the explorer never traverses above the root. *(Supports FR-3.)* **(inferred from design prototype)**
- **FR-39** — The Explorer SHOULD surface **live file activity** tied to the file watcher via three distinct affordances: (a) a **"NEW" badge** for newly created files; (b) a **transient row-highlight flash** on a file event; and (c) a **persistent "just modified" marker** (e.g. a dot) on recently changed files. *(Supports FR-14 / NFR-8; specific timings in the prototype are demo-driven — the live-update capability is the requirement, not the timings.)* **(inferred from design prototype)**

#### Viewer Pane
- **FR-40** — The Viewer MUST display a **per-file render-state badge** with at least the states **RENDERED**, **SOURCE**, **PREVIEW**, and **NO PREVIEW**. *(Supports FR-4–FR-9.)* **(inferred from design prototype)**
- **FR-41** — When SVG or HTML is shown as source, the Viewer MUST display an explicit **safety banner** indicating the content is shown as source and never rendered/executed. *(Supports FR-7, FR-8.)* **(inferred from design prototype)**
- **FR-42** — When no file is selected, the Viewer MUST show an **empty state** that reinforces the *principle* "Everything renders as something — nothing executes." The normative requirement is the principle (and a prompt to select a file), **not** the verbatim copy — the exact wording is illustrative. *(Supports Laws 1–2.)* **(inferred from design prototype)**
- **FR-43** — The binary/unknown **metadata placeholder** (FR-9) MUST present the file's **name, size, type, and modified time**. *(Refines FR-9 / AC-3d.)* **(inferred from design prototype)**

#### Chat Pane — Presentation
- **FR-44** — Each message MUST **visually distinguish broadcast (`@here`) from direct (`→ recipient`)** addressing; the `@here` form SHOULD be accent-emphasized. *(Supports FR-23, FR-24.)* **(inferred from design prototype)**
- **FR-45** — Each message MUST display **delivery/read receipts**: (a) a **direct** message MUST show a two-state **delivered → seen** indicator; (b) an **`@here`** message MUST show an aggregate **"N/M read"** count and MUST expose a **per-recipient breakdown** (each recipient's seen/unread state) via a **hover- or focus-revealed panel**, and SHOULD additionally show a **read-progress bar**. *(Supports FR-28; the prototype's receipt math is faked, so only the presentation is required here — no backend semantics are inferred. The breakdown's hover-only trigger in the prototype is an accessibility concern — it MUST also be focus/keyboard-reachable per NFR-12.)* **(inferred from design prototype)**
- **FR-46** — The Chat roster MUST show, per agent, the **identity** (name + avatar), a **presence/online indicator**, an **unread count**, and the **gone (deregistered) visual state** (dimmed with greyed presence). *(Supports Law 4 / FR-15 / FR-19.)* **(inferred from design prototype)**
- **FR-47** — Channels MUST be presented as **selectable tabs**, each showing the channel name and member count. A **message-count badge MUST be shown on non-active channel tabs** (the active/selected tab suppresses its own count badge). *(Supports FR-18, FR-20.)* **(inferred from design prototype)**
- **FR-48** — Message bodies MUST render **inline markdown** (code spans, bold/italic, and links) under the same no-execution rules as the Viewer. **Message-body links MUST be rendered non-navigating (href neutralized), so no agent-authored link can navigate or execute** — this is the chat-side analogue of FR-8 / Law 1. *(Supports Law 1.)* **(inferred from design prototype)**
- **FR-49** — The Chat MAY show a transient **typing/incoming-activity indicator**. *(Presentation polish; prototype-scripted — kept as MAY.)* **(inferred from design prototype)**

#### Chat Pane — Observer Interaction
- **FR-50** — The Chat SHOULD provide a **per-agent inbox view**, reachable from the roster, listing messages addressed to that agent labeled by channel, addressing (`@here`/direct), and read/unread state, with an unread/total summary (e.g. "{unread} unread / {items} in inbox"). The inbox header also shows the agent's role line. *(Supports FR-25, FR-28, FR-33.)* **(inferred from design prototype)**
- **FR-51** — In place of a message composer, the Chat MUST display a **persistent observer notice** making clear the human cannot post into the chat. *(Directly satisfies FR-32 / AC-14.)* **(inferred from design prototype)**

#### Content Safety (cross-pane)
- **FR-52** — Both the Viewer markdown path and the Chat message-body path MUST share the same content-safety rules: all embedded/raw HTML MUST be HTML-escaped (never interpreted), and all links MUST be rendered **non-navigating (href neutralized)**. No agent-authored content (in a file or a message) may navigate or execute. *(Consolidates FR-5, FR-8, FR-48 under one cross-pane safety guarantee — the analogue of Law 1 for rendered text.)* **(inferred from design prototype)**

#### Chat Empty States
- **FR-53** — The Chat MUST present an **empty-state message** for (a) a channel that has no messages and (b) an agent inbox with nothing addressed to it (mirroring the Viewer empty state, FR-42). *(Supports FR-47, FR-50; exact copy is illustrative, not normative.)* **(inferred from design prototype)**

#### Accessibility
- **FR-54** — All interactive controls — roster chips, channel tabs, the theme toggle, the inbox "← channels" back control, and Explorer file rows — MUST be **operable by keyboard** with proper interactive semantics (not click-only `div`/`span` handlers) and a **visible focus indicator**. *(Forward-looking: the prototype uses click-only handlers without focus-visible styling and does not yet satisfy this; WCAG 2.2 AA SC 2.1.1, 2.4.7.)* **(inferred from design prototype)**

---

## 6. Non-Functional Requirements

- **NFR-1 (Security / Safety)** — The application MUST NOT execute any file content; all code, HTML, and SVG are displayed as source only. (Law 1)
- **NFR-2 (Security / Isolation)** — File access MUST be confined to the root sandbox boundary established at launch. (Law 3)
- **NFR-3 (Security / Renderer Hardening)** — The renderer MUST enforce `contextIsolation: true` and `nodeIntegration: false`, with no Node.js in the renderer and all privileged calls mediated by the preload bridge. (FR-11–FR-13)
- **NFR-4 (Security / Identity)** — Agent identity and channel membership MUST be explicit and tracked, not implicit or anonymous. (Law 4)
- **NFR-5 (Usability / Visibility)** — The viewer MUST guarantee that every file type produces some visible representation, including a metadata placeholder for unknown/binary files. (Law 2)
- **NFR-6 (Determinism)** — File-type dispatch MUST be deterministic by extension, producing consistent rendering for a given extension.
- **NFR-7 (Reliability / Persistence)** — Chat state (agents, channels, memberships, messages, receipts) MUST be durably persisted in SQLite within a running session so that async messages and read state survive process events within that session. **(Cross-session retention is NOT asserted here — it is an open decision; see OQ-2.)**
- **NFR-8 (Architecture / Single Source of Truth)** — The main process MUST be the sole authority for the SQLite store, MCP server, event bus, file watcher, and lifecycle; the renderer MUST derive state from it via IPC. (FR-14)
- **NFR-9 (Interoperability — Agent Transport)** — The agent transport MUST be an MCP server (built with `@modelcontextprotocol/sdk`) reachable over HTTP/SSE or WebSocket. *(Distinct from the UI/external live feed in NFR-10.)*
- **NFR-10 (Interoperability — Live Feed)** — The UI live feed MUST use Electron IPC; an optional WebSocket (`ws`) feed MAY be exposed for external observers. *(The agent transport (NFR-9) and the observer live feed (NFR-10) are separate concerns and MUST NOT be conflated.)*
- **NFR-11 (Portability)** — The application MUST run as an Electron desktop application using the stack in Section 8. **(inferred** from the stated stack.**)**
- **NFR-12 (Accessibility — target WCAG 2.2 AA)** — The user interface MUST meet WCAG 2.2 Level AA. This is **forward-looking**: the current prototype does not yet comply. At minimum:
  - **Keyboard + focus (SC 2.1.1, 2.4.7):** every interactive control MUST be keyboard-operable with a visible focus indicator (see FR-54).
  - **Hover-revealed content (SC 1.4.13):** information shown on hover — notably the `@here` per-recipient receipt breakdown (FR-45) — MUST also be reachable via keyboard focus and on touch.
  - **Non-color cues (SC 1.4.1):** presence/online, unread, `@here` addressing, and read/seen state MUST NOT rely on color alone; a non-color indicator (icon, text, shape) MUST accompany each.
  - **Avatar labels:** every avatar MUST carry an accompanying text label, because avatar initials are non-unique (e.g. `scout` and `scout-2` both render "S").
  - **Reduced motion (SC 2.3.3):** the app MUST honor `prefers-reduced-motion` for the pulsing live-state dot, message-land animation, typing-indicator blink, and Explorer row-flash.
  **(inferred from design prototype; forward-looking — prototype not yet compliant)**

---

## 7. User Stories / Use Cases

- **US-1 — Browse a scoped folder:** As a human observer, I launch Loom with `loom .` so that I can browse the folder tree scoped to that directory.
- **US-2 — View any file safely:** As a human observer, I open a file and see it rendered (markdown as markdown; code/HTML/SVG as highlighted source; unknown/binary as a metadata placeholder) so that I can inspect content without anything executing.
- **US-3 — Watch agents collaborate (read-only):** As a human observer, I watch the live chat feed in the UI so that I can follow agent-to-agent communication as it happens, without being able to post into it.
- **US-4 — External observation:** As an external dashboard/logger, I subscribe to the WebSocket feed so that I receive the same live event stream without depending on Electron.
- **US-5 — Register an agent:** As an AI agent, I call `register(name)` so that I have an explicit, unique identity (suffixed on collision) in the system.
- **US-6 — Create and join channels:** As an AI agent, I call `create_channel(name)` (auto-joining me) and `join_channel(channel)` so that I can establish/enter a shared space to communicate.
- **US-7 — Send a direct or broadcast message:** As an AI agent, I call `send_message(channel, to, body)` with `to` as a member name or `"@here"` so that I can reach one agent or all channel members except myself.
- **US-8 — Process my inbox via the turn convention:** As an AI agent, I call `check_inbox()`, then on unread I `read_messages()`, process, and `mark_read([...])` so that I handle messages asynchronously with accurate read state. (FR-33)
- **US-9 — Lead/sub-agent lifecycle:** As a lead agent, I spawn a sub-agent with a name; the sub-agent calls `register(name)` first, then joins/creates channels and communicates via the MCP tools; when the work is finished I call `deregister(name)` for it (no heartbeat is required).

---

## 8. Assumptions & Dependencies

### Technical Stack (from source, alternatives preserved)
| Concern | Technology (and source-permitted alternatives) |
|---------|--------------------------------------------------|
| Shell | Electron |
| UI | React + TypeScript |
| Markdown | markdown-it (or remark) |
| Code display | Monaco (or Shiki if pure read-only) |
| Storage | better-sqlite3 |
| Agent transport SDK | MCP server via `@modelcontextprotocol/sdk`, over HTTP/SSE or WebSocket |
| Live feed | Electron IPC + optional `ws` (WebSocket) |
| File watching | chokidar |

### Build Sequence (phased, from source)
1. Launcher + explorer
2. Viewer dispatch
3. Chat core
4. Chat UI
5. **Polish:** image previews, WebSocket external feed, and deregister/teardown

**Parallelism note (M-3):** The source states that the viewer phases (1–2) and the chat phases (3–4) **can be built in parallel**. This supersedes any reading that chat strictly depends on the explorer; the two tracks are independent and converge, with Polish (phase 5) last. (This corrects the v0.1 assumption that "chat features build on top.")

### Assumptions
- Image preview ships now as a safe placeholder (a first-class render-state); full image decoding is deferred (see OQ-5).
- The MCP tool surface comprises exactly nine operations.
- No agent heartbeat is required; liveness is governed by explicit `register`/`deregister`.

### Dependencies
- Runtime dependencies on the libraries above (Electron, React, TypeScript, markdown-it/remark, Monaco/Shiki, better-sqlite3, `@modelcontextprotocol/sdk`, `ws`, chokidar).

---

## 9. Constraints

- **C-1** — Nothing may execute; code, HTML, and SVG are source-only. (Law 1)
- **C-2** — All access is confined to the root sandbox boundary. (Law 3)
- **C-3** — Agent identity and channel membership must be explicit. (Law 4)
- **C-4** — Agents may communicate only within shared channels. (Law 5)
- **C-5** — File dispatch is by extension and must be deterministic.
- **C-6** — The renderer must run hardened (`contextIsolation: true`, `nodeIntegration: false`, preload bridge); the main process is the single source of truth.
- **C-7** — The technical stack is prescribed (Section 8), **but the source explicitly permits documented substitutions** (markdown-it ↔ remark; Monaco ↔ Shiki for read-only; optional `ws`). These substitutions are in scope/allowed; only undocumented stack changes are out of scope. **(inferred** scoping of the latter clause.**)**

---

## 10. Acceptance Criteria

- **AC-1** — Running `loom .` launches the app and shows a file explorer scoped to the current folder. (FR-1, FR-2)
- **AC-2** — Accessing a path outside the root folder is blocked. (FR-3, NFR-2)
- **AC-3a** — A `.md` file renders as formatted markdown. (FR-5)
- **AC-3b** — A `.js`/`.ts`/`.json`/`.css`/`.py`/`.html` file renders as syntax-highlighted source. (FR-6)
- **AC-3c** — An `.svg` file renders as source, not as an image. (FR-7)
- **AC-3d** — An unknown/binary file shows a metadata placeholder. (FR-9)
- **AC-4** — No file content (code, HTML, SVG) is executed by the viewer. (FR-8, NFR-1)
- **AC-5 (Renderer security)** — The renderer is verifiably running with `contextIsolation: true` and `nodeIntegration: false`; renderer privileged calls only succeed via the preload bridge; the main process holds the SQLite store, MCP server, event bus, and file watcher. (FR-11–FR-14, NFR-3, NFR-8)
- **AC-6 (register)** — `register("researcher")` returns `{ ok, name: "researcher", channels: [] }`; a second `register("researcher")` returns a suffixed name (e.g. `researcher-2`). (FR-15)
- **AC-7 (create/join)** — `create_channel(name)` returns a channel id+name and the caller is already a member; `join_channel(channel)` returns the channel and members list. (FR-16, FR-17)
- **AC-8 (send / addressing)** — `send_message(channel, name, body)` delivers only to the named recipient and stores `addressing='direct'`, `target=name`; `send_message(channel, "@here", body)` delivers to all members except the sender and stores `addressing='here'`, `target=NULL`. (FR-21, FR-23, FR-24, FR-31)
- **AC-9 (inbox / read / mark)** — `check_inbox()` returns an unread count + previews and marks nothing read; `read_messages()` returns full unread bodies and marks nothing read; `mark_read([ids])` sets `read_at` and returns the marked count; subsequent `check_inbox()` reflects the reduced unread count. (FR-25, FR-26, FR-27, FR-28)
- **AC-10 (async delivery)** — A message sent while a recipient is offline is retrievable by that recipient on its next `check_inbox()`/`read_messages()`. (FR-22)
- **AC-11 (channel isolation)** — Two agents that do not share a channel cannot exchange messages. (FR-20)
- **AC-12 (deregister)** — `deregister(name)` sets the agent's status to `gone`, the agent is excluded from the active-roster count and shown de-emphasized (dimmed, greyed presence) rather than removed from view; it returns `{ ok, name }`. (FR-19)
- **AC-13 (event fanout)** — A persisted message produces an IPC event to the renderer live view and, when the WebSocket feed is enabled, the same event to external subscribers. (FR-29, FR-30)
- **AC-14 (human read-only)** — The human UI provides no affordance to post into the chat; attempts to inject a human-authored message are not accepted. (FR-32)
- **AC-15 (transport vs feed separation)** — The agent MCP transport (HTTP/SSE or WS) and the observer live feed (IPC + optional ws) are independently configurable; disabling the external WebSocket feed does not disable agent messaging. (NFR-9, NFR-10)
- **AC-16 (schema)** — The SQLite schema matches Appendix A, including the `agents.status` and `messages.addressing` enums, `channels.name` UNIQUE, the composite receipt PK, and the `idx_receipts_unread` partial index. (FR-31)
- **AC-17 (3-pane layout)** — The window shows a title bar and a status bar above exactly three content panes — Explorer (left), Viewer (center), Chat (right); there is no terminal pane. (FR-34)
- **AC-18 (observer notice, strengthens AC-14)** — The Chat pane shows a persistent observer notice in place of a composer; there is no text input anywhere in the Chat pane. (FR-51, FR-32)
- **AC-19 (render-state badges)** — Opening a `.md` file shows the badge **RENDERED**; opening code/HTML/SVG shows **SOURCE**; opening an image shows **PREVIEW**; opening a binary/unknown file shows **NO PREVIEW**. (FR-40, FR-10)
- **AC-20 (theme persistence)** — The app defaults to the dark theme, offers a light theme, and restores the last-chosen theme on the next launch. (FR-37)
- **AC-21 (message link safety)** — A markdown link in a chat message body does not navigate or open a URL when activated (its href is neutralized). (FR-48, FR-52)
- **AC-22 (Viewer markdown safety)** — Rendered markdown in the Viewer escapes any embedded HTML (it is shown as text, not interpreted) and its links are non-navigating. (FR-5, FR-52)
- **AC-23 (receipts)** — A direct message shows a delivered→seen two-state indicator; an `@here` message shows an "N/M read" aggregate whose per-recipient breakdown is revealed on hover and is also reachable via keyboard focus. (FR-45, NFR-12)
- **AC-24 (chat empty states)** — A channel with no messages shows an empty-state message, and an agent inbox with nothing addressed to it shows an empty-state message. (FR-53)

---

## 11. Open Questions / Risks

- **OQ-1 (Identity edge cases)** — The collision rule (suffix-on-collision, e.g. `researcher-2`) is decided (FR-15), but the following remain open: maximum name length, and whether a deregistered name may be reused/re-registered in the same session.
- **OQ-2 (Channel persistence across sessions)** — The source explicitly lists this as unresolved: keep history across sessions, or start fresh per `loom .` launch? This directly bounds NFR-7's cross-session durability and MUST be decided.
- **OQ-3 (`@here` membership timing)** — Whether `@here` recipients are resolved at send time or read time (i.e. treatment of agents who join after a broadcast) is not specified.
- **OQ-4 (MCP transport authn/z)** — Whether the MCP server enforces authentication/authorization beyond explicit `register` is not specified; an unauthenticated transport is a security risk.
- **OQ-5 (Image preview — RESOLVED in v0.4)** — The design resolves the earlier phase-2 vs phase-5 inconsistency: an image **render-state with a safe placeholder ships now** (FR-10, FR-40), while **full image decoding is deferred** to a later phase. **Minor inconsistency to flag (from C-5):** in the prototype the image `PREVIEW` tag reuses the green "rendered" visual family even though only a placeholder (not a decoded image) is shown; the badge styling should be reviewed so it does not imply true rendering.
- **OQ-6 (Missing "terminal" pane)** — Earlier descriptions named a fourth "terminal" pane (project memory: "explorer/viewer/chat/terminal"), but **no terminal pane appears anywhere in the design** — only Explorer, Viewer, and Chat are mounted. It cannot be determined from the design whether the terminal pane was **dropped** or merely **deferred**; this MUST be decided. (See the v0.4 "pane" terminology note in Section 1.)
- **R-1 (Concurrency risk — inferred)** — With chokidar file watching, a live SQLite store, and an event bus fanning to IPC + WebSocket, concurrent agent writes and rapid file changes could introduce race conditions; the source describes the main process as single source of truth but does not detail a concurrency/locking model.

---

## Appendix A — SQLite Schema (from source)

> Reproduced at column level because several columns carry behavior-defining semantics referenced by the FRs above. `INT` timestamps are integers.

**agents**
- `name` — TEXT, PRIMARY KEY
- `connection_id` — NOT NULL
- `status` — DEFAULT `'active'`; enum `'active' | 'gone'` (set to `'gone'` by `deregister`, FR-19)
- `registered_at` — INT, NOT NULL

**channels**
- `id` — INT, PRIMARY KEY
- `name` — TEXT, **UNIQUE**, NOT NULL
- `created_at` — INT, NOT NULL

**memberships**
- `channel_id` — FK → channels.id
- `agent_name` — FK → agents.name
- `joined_at` — INT, NOT NULL
- **Composite PRIMARY KEY** `(channel_id, agent_name)`

**messages**
- `id` — INT, PRIMARY KEY
- `channel_id` — FK → channels.id
- `sender` — FK → agents.name
- `body` — TEXT, NOT NULL
- `addressing` — NOT NULL; enum `'direct' | 'here'`
- `target` — nullable; set to the recipient name when `addressing = 'direct'`, NULL when `'here'`
- `created_at` — INT, NOT NULL

**receipts**
- `message_id` — FK → messages.id
- `recipient` — FK → agents.name
- `read_at` — INT, nullable; **NULL = unread**
- **Composite PRIMARY KEY** `(message_id, recipient)`
- **Index** `idx_receipts_unread` on `(recipient) WHERE read_at IS NULL` (mechanism behind unread counts / inbox, FR-28)

*Linkage:* the direct/broadcast distinction (FR-23/FR-24) is canonically defined by `messages.addressing` + `target`; the unread/inbox behavior (FR-25/FR-28) is canonically defined by `receipts.read_at` and the partial index.

---

*End of document.*
