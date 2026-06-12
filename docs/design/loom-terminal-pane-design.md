# Design: Loom Terminal Pane

Project: `loom-terminal-pane` (Atelier project id 6) · Author: priya-pm · 2026-06-12
Approval note: drafted and approved under an autonomous `/goal` directive ("add a terminal which I can close and open; when it opens, it should be in the folder where the loom is currently pointing" + follow-up "the terminal pane should be able to be resized or maximized"). Assumptions that would normally be grilled live are listed in §8 with dispositions.

## 1. Goal

Add a human-facing terminal pane to the Loom desktop app that the user can open and close from the UI, that starts its shell in Loom's launch root, and that can be resized and maximized within the window.

## 2. Scope

- A **bottom dock terminal pane** spanning the full width below the Explorer/Viewer/Chat columns, rendered with `@xterm/xterm`, backed by a real PTY (`node-pty`) spawned in the main process.
- **Open/close**: a status-bar icon button plus a keyboard command (`Ctrl+\`` / `Cmd+\``) toggle the pane. Closing the pane kills the shell session; reopening spawns a fresh shell (see Non-goals).
- **Starting directory**: the PTY is spawned with `cwd = rootDir` (the same launch-root value threaded into `createIpcWiring` as `rootPath` — `src/main/main.ts` `resolveRoot()`).
- **Resize**: a horizontal splitter on the pane's top edge, draggable by pointer and operable by keyboard (ArrowUp/ArrowDown), following the existing Explorer/Chat splitter idiom in `App.tsx` (pointer capture, clamping, `:focus-visible` cue). Height clamped (min 120px, max 80% of body) and persisted to localStorage (`loom-terminal-height`), open-state persisted (`loom-terminal-open`).
- **Maximize**: a pane-header button (and the same splitter at max acts naturally) that expands the terminal to fill the entire `.body` area (top columns hidden via CSS grid row collapse); pressing again restores the previous height. Maximize state is session-only (not persisted).
- **PTY plumbing over the frozen IPC contract** (new channels, named per `loom:<noun>:<verb>`):
  - `loom:terminal:open` (invoke → spawns PTY in root, returns session id)
  - `loom:terminal:input` (invoke, renderer → PTY stdin)
  - `loom:terminal:resize` (invoke, cols/rows)
  - `loom:terminal:close` (invoke, kills PTY)
  - `loom:terminal:data` (push, PTY output → renderer)
  - `loom:terminal:exit` (push, PTY exit → renderer shows "session ended" state)
  All constants added to `IPC` in `src/shared/types.ts`, preload allow-lists extended, main handlers re-validate every payload (types, session-id match, input size cap), per CONTRACTS.md §b.
- **Shell selection**: `$SHELL` falling back to `bash` on Linux/macOS; `powershell.exe` on Windows (node-pty conpty).
- **Terminal UI chrome**: `.pane-head`-style header ("Terminal", maximize/restore button, close button), theme-aware xterm colors mapped from the existing CSS custom properties (dark/light), focus management (opening focuses the terminal; closing returns focus to the toggle button).
- **Lifecycle safety**: PTY killed on window close/app quit; data pushes stop after close; single session at a time (one terminal pane).
- **Build/deps**: add `@xterm/xterm` (+ `@xterm/addon-fit`) bundled by esbuild (its CSS imported into the renderer build); add `node-pty` as a main-process external with `@electron/rebuild` wired in (`postinstall`/explicit script) so the native binding matches Electron 33.4.11's ABI.
- **Tests**: unit tests (node --test, testkit pattern) for the pure logic — terminal session manager (spawn/route/kill bookkeeping with an injected fake PTY factory), payload validators, height clamp/persistence helpers; e2e Playwright `_electron` test (CI-only, like navlinks) that opens the pane, runs `pwd`, and asserts the launch root is printed.

## 3. Non-goals

- **No agent/MCP access to the terminal.** No MCP tool touches it; agents cannot read terminal output or write input. The 9-tool MCP surface is unchanged. (Closes the "does this break Loom's substrate purity?" ambiguity.)
- **No session persistence across close/reopen or app restarts.** Close kills the shell; reopen is a fresh shell in the root. (Closes "should it background like VS Code?")
- **No multiple terminals/tabs.** Exactly one session.
- **No sandbox enforcement of the shell's cwd.** The shell *starts* in the root but the user may `cd` anywhere — inherent to a terminal. Law 3 (file-access sandbox) continues to govern the Explorer/Viewer/MCP file surface only.
- **No links/hyperlink detection, search, or scrollback persistence** in the terminal beyond xterm defaults.
- **No change to the Viewer/Explorer/Chat panes' behavior or to content-rendering Law 1 guarantees** (markdown/html/svg still render inert).

## 4. Acceptance criteria

1. With the app launched as `loom <dir>`, clicking the status-bar terminal button (or pressing Ctrl+`) opens a terminal pane at the bottom; running `pwd` prints `<dir>` (boolean — e2e asserted).
2. Clicking the pane's close button (or the toggle again) closes the pane and the PTY process exits (boolean — unit asserts kill called; e2e asserts process gone).
3. Reopening after close yields a working fresh shell (boolean).
4. Dragging the top splitter changes the pane height between 120px and 80% of the body; height survives app restart via localStorage (measurable).
5. ArrowUp/ArrowDown on the focused splitter resizes in steps, matching the existing splitter idiom (boolean).
6. The maximize button expands the terminal to fill the body; restore returns to the prior height (boolean).
7. Typed input reaches the shell and output renders (echo round-trip, e2e).
8. All new IPC payloads are re-validated in main: wrong types, oversized input (>64 KiB per write), or stale session ids are rejected as silent no-ops (unit-asserted).
9. `npm run typecheck`, `npm run build`, and the full `npm test` suite stay green; new unit tests added for the session manager and validators.
10. Renderer hardening unchanged: `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, CSP byte-identical except no change at all is expected (xterm needs none).

## 5. Constraints

- **Frozen IPC contract discipline** (CONTRACTS.md): channels named `loom:<noun>:<verb>`, constants in `src/shared/types.ts`, preload allow-list extension, renderer never touches `ipcRenderer`. CONTRACTS.md gets a documented additive extension.
- **CSP must not weaken**: `script-src 'self'`, `connect-src 'none'` stay as-is; xterm is bundled, DOM renderer (no eval, no network).
- **Law 1 scope preserved**: the terminal is a deliberate, human-invoked execution surface in the *main* process; nothing about content rendering executes. README's Design Laws section gets an explicit "Human terminal" carve-out paragraph so the laws stay honest.
- **No regression to the read-only human chat** (no composer added anywhere else).
- **Electron 33.4.11 pinned**; node-pty must be rebuilt against it (`@electron/rebuild`), not against system Node. Never trigger an Electron re-download (binary is hand-extracted in this sandbox).
- **Renderer stays sandboxed**; PTY lives only in main.
- **Theme/a11y parity**: focus-visible cues, reduced-motion respected, header buttons keyboard-operable, terminal colors meet the existing theme tokens.

## 6. Stakeholders

- **nitekeeper (product owner / sole user)** — wants a convenient in-app terminal rooted at the project folder; set the goal.
- **External chat agents (via MCP)** — must be unaffected; their contract surface does not change.
- **Future maintainers (PM + Atelier workers)** — need the Design-Law carve-out and CONTRACTS.md extension documented so the "nothing executes" story stays coherent.

## 7. Dependencies / Prerequisites

- `node_modules` install in this worktree + the **Electron binary extraction** step (cached `~/.cache/electron/electron-v33.4.11-linux-x64.zip` → `node_modules/electron/dist/` + `path.txt`), per project memory.
- New npm deps: `@xterm/xterm`, `@xterm/addon-fit`, `node-pty`, `@electron/rebuild` (dev).
- Build toolchain for node-pty (verified present: make, g++, python3).
- Existing artifacts built on: splitter/persistence idiom in `src/renderer/components/App.tsx`, IPC idiom (`loom:clipboard:write` end-to-end path), `rootPath` already passed to `createIpcWiring`.

## 8. Risks / Unknowns

- **node-pty native build fails against Electron ABI in this sandbox** — Mitigation: toolchain verified; if `@electron/rebuild` still fails, fall back to spawning via util-linux `script -qfc` (PTY without native code, Linux-only) behind the same session-manager interface; the interface is PTY-implementation-agnostic by design.
- **CI installers (win/mac/linux) need the native rebuild step** — Mitigation: add the rebuild to the packaging workflows; if a platform's CI build breaks, terminal degrades gracefully (pane shows "terminal unavailable") rather than failing the app. Accept: CI verification happens on push, not in this sandbox.
- **xterm rendering under the WSLg/e2e harness** — unit tests can't drive real PTY rendering; only the CI e2e proves the round-trip. Accept (same caveat as mermaid/navlinks; documented in memory).
- **Design-Law purists' objection ("nothing executes")** — Mitigation: explicit scoping in README + CONTRACTS.md: laws govern *content rendering and the agent surface*; the terminal is a human-invoked tool, MCP-invisible.
- **Renderer flooding (cat a huge file) over IPC** — Mitigation: main-side output chunk coalescing + a bounded flow (drop-oldest beyond a buffer cap when the renderer is unresponsive); xterm scrollback capped (default 1000 lines → set 5000).
- **Stale-session races (input after close)** — Mitigation: session-id token per spawn; main validates id on every input/resize/close; unit-tested.

## 9. Success metrics

- All 10 acceptance criteria pass (boolean).
- Full suite green: ≥308 existing tests + new tests, 0 failures; typecheck + build green (boolean).
- e2e `pwd` check prints the launch root in CI (boolean).
- User confirms open/close/resize/maximize works in the installed deb (boolean — user verification step).
