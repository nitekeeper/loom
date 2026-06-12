# Implementation Plan — Loom Terminal Pane

**Design:** `docs/design/loom-terminal-pane-design.md`
**Repo (all paths relative to):** `/home/nitekeeper/apps/loom/.claude/worktrees/add-terminal-loom`

## Goal

Add a closable, resizable, maximizable bottom-dock terminal pane (xterm.js renderer + node-pty in main) that opens its shell in Loom's launch root, wired over the frozen `loom:<noun>:<verb>` IPC discipline without weakening any renderer hardening.

## Tech constraints

- `@xterm/xterm` + `@xterm/addon-fit` in the **renderer only**, bundled by esbuild (its CSS goes through the existing `loader: { '.css': 'css' }` path into `dist/renderer.css`). DOM renderer; no CSP change (`script-src 'self'`, `connect-src 'none'` stay byte-identical).
- `node-pty` in the **main process only**, as a **native module marked `external` in `build.mjs`'s `mainBuild`** (alongside `'electron'`), rebuilt against Electron 33.4.11 via `@electron/rebuild`. Loaded lazily via `require('node-pty')` inside a factory module so a load failure degrades to "terminal unavailable" instead of crashing boot.
- Runtime resolution of the external: in dev, `dist/main.cjs` `require('node-pty')` resolves up to project `node_modules/` (CJS resolution). In packaged apps, `electron-builder.config.cjs` uses an explicit `files` allowlist (`['dist/**', 'package.json']`) which **excludes node_modules** — so `node_modules/node-pty/**` must be added to `files` AND to `asarUnpack` (Electron's patched `fs` redirects the `.node` load to `app.asar.unpacked`). `node-pty@1.x` has no runtime deps, so only its own tree is needed. `node-pty` must be a **production dependency** so electron-builder's default `npmRebuild` rebuilds it per-platform in the installer workflows.
- New IPC channels: `loom:terminal:open` / `loom:terminal:input` / `loom:terminal:resize` / `loom:terminal:close` (invoke) + `loom:terminal:data` / `loom:terminal:exit` (push). Constants in `IPC` (`src/shared/types.ts`), preload allow-list extended, main re-validates every payload (types, session-id token match, 64 KiB input cap). Renderer never touches `ipcRenderer`.
- `contextIsolation:true` / `sandbox:true` / `nodeIntegration:false` unchanged; PTY lives only in main.
- Pure-logic session manager (`src/main/terminal.ts`) with an **injected fake PTY factory**, exported through `src/testkit-entry.ts` → `dist/testkit.cjs`, unit-tested via `node --test` exactly like `test/linux-maximize.mjs`.
- Electron binary in this sandbox is hand-extracted from `~/.cache/electron/electron-v33.4.11-linux-x64.zip` — **never re-download** (`ELECTRON_SKIP_BINARY_DOWNLOAD=1` on every npm install).

---

## Tasks

### Task 1 — Dependencies, Electron binary re-extraction, electron-rebuild wiring

**Files:** `package.json` (deps + `rebuild` script), `node_modules/` (generated).

**Failing test first:** Not applicable — pure toolchain/dependency wiring; no source logic exists to test. **Verification step instead:** the smoke command at the end of this task (node-pty loads under the Electron ABI).

**Implementation:**
1. Install (node_modules is absent in this worktree; never let electron download):
   ```
   ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
   ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --save @xterm/xterm @xterm/addon-fit node-pty
   ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --save-dev @electron/rebuild
   ```
2. Re-extract the cached Electron binary (NEVER download):
   ```
   mkdir -p node_modules/electron/dist
   unzip -oq ~/.cache/electron/electron-v33.4.11-linux-x64.zip -d node_modules/electron/dist
   printf 'electron' > node_modules/electron/path.txt
   ```
3. Add to `package.json` `scripts`: `"rebuild": "electron-rebuild -f -w node-pty"` (explicit script, NOT `postinstall` — `postinstall` would break the CI `npm ci` ordering where the electron binary may be cache-restored after install; the installer workflows rely on electron-builder's default `npmRebuild:true` instead).
4. Run `npm run rebuild`.

**Verification (run):**
```
node -e "const p=require('node-pty'); console.log(typeof p.spawn)"   # may fail under system-node ABI — that is OK
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron -e "console.log(typeof require('node-pty').spawn)"   # MUST print 'function'
```
(The second command is the authoritative ABI check; design §8 fallback: if the rebuild cannot succeed in this sandbox, proceed — the factory interface in Task 3 is implementation-agnostic and the `script -qfc` fallback can be slotted in without changing any other task.)

**Commit:** `build(deps): add xterm + node-pty and wire @electron/rebuild for electron 33.4.11`

---

### Task 2 — Shared contract: IPC constants, payload types, LoomBridge.terminal

**Files (modify):** `src/shared/types.ts`.

**Failing test first:** Not applicable — this file is pure compile-time contract (types + const objects, no logic); per CONTRACTS.md it must contain no runtime behavior. **Verification step instead:** `npm run typecheck` passes after this task; the payload *validators* (runtime logic) are test-driven in Task 3.

**Implementation (all additive, in `src/shared/types.ts`):**
1. New `IPC` constants:
   - `TERMINAL_OPEN: 'loom:terminal:open'`, `TERMINAL_INPUT: 'loom:terminal:input'`, `TERMINAL_RESIZE: 'loom:terminal:resize'`, `TERMINAL_CLOSE: 'loom:terminal:close'` (invoke)
   - `TERMINAL_DATA: 'loom:terminal:data'`, `TERMINAL_EXIT: 'loom:terminal:exit'` (push)
2. New shapes + constants:
   ```ts
   export interface TerminalOpenParams { cols: number; rows: number; }
   export interface TerminalOpenResult { sessionId: string | null; }   // null = terminal unavailable (pty load/spawn failed)
   export interface TerminalDataPush { sessionId: string; data: string; }
   export interface TerminalExitPush { sessionId: string; exitCode: number; }
   export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
   export const TERMINAL_MIN_COLS = 2; export const TERMINAL_MAX_COLS = 1000;
   export const TERMINAL_MIN_ROWS = 1; export const TERMINAL_MAX_ROWS = 1000;
   ```
3. New `LoomBridge` member (namespaced like `windowControls`):
   ```ts
   terminal: TerminalBridge;
   export interface TerminalBridge {
     open(opts: TerminalOpenParams): Promise<TerminalOpenResult>;
     input(sessionId: string, data: string): Promise<void>;
     resize(sessionId: string, cols: number, rows: number): Promise<void>;
     close(sessionId: string): Promise<void>;
     onData(h: (p: TerminalDataPush) => void): () => void;
     onExit(h: (p: TerminalExitPush) => void): () => void;
   }
   ```

**Run tests:** `npm run typecheck` (types compile standalone since `LoomBridge` is interface-only; the preload implementation lands in Task 4).

**Commit:** `feat(types): add loom:terminal:* IPC contract + LoomBridge.terminal (additive)`

---

### Task 3 — Main-process terminal session manager (pure, testkit-exported) + real pty factory

**Files (create):** `src/main/terminal.ts`, `src/main/pty-factory.ts`, `test/terminal.mjs`. **Files (modify):** `src/testkit-entry.ts`, `build.mjs`, `package.json` (test script).

**Failing test first:** `test/terminal.mjs` (node --test over `dist/testkit.cjs`, exactly the `test/linux-maximize.mjs` idiom — `kit()` loader + `assert/strict`). Key tests/assertions:
- `TERM-OPEN: open spawns via factory with cwd=rootDir and returns a session id` — fake factory records `spawn({ shell, cwd, cols, rows })`; `assert.equal(spawned[0].cwd, '/fake/root')`; `assert.equal(typeof res.sessionId, 'string')`.
- `TERM-SINGLE: a second open kills the first session` — `assert.equal(fakePty1.killed, true)`.
- `TERM-INPUT-VALIDATE: wrong types, oversized input (>64KiB), and stale session ids are silent no-ops` — `mgr.input({ sessionId: 'stale', data: 'x' })`, `mgr.input({ sessionId: id, data: 'x'.repeat(64*1024 + 1) })`, `mgr.input(42)`; `assert.equal(fakePty.written.length, 0)`.
- `TERM-RESIZE-VALIDATE: non-integer / out-of-range cols-rows rejected` — `assert.equal(fakePty.resizes.length, 0)`.
- `TERM-DATA: pty output is forwarded to the attached sink, coalesced` — flush, `assert.deepEqual(sink[0], ['loom:terminal:data', { sessionId, data: 'ab' }])`.
- `TERM-FLOWCAP: buffered output beyond the cap drops oldest` — feed > `OUTPUT_BUFFER_CAP` while no sink attached; assert total forwarded ≤ cap and the tail is preserved.
- `TERM-EXIT: pty exit pushes loom:terminal:exit and invalidates the session` — input-after-exit is a no-op.
- `TERM-CLOSE/DISPOSE: close(id) and disposeAll() call pty.kill()` — `assert.equal(fakePty.killed, true)` (acceptance criterion 2 + kill-on-window-close).
- `TERM-SHELL: defaultShell honors $SHELL, falls back to bash; powershell.exe on win32` — pure fn assertions.

**Implementation:**
1. `src/main/terminal.ts` — PURE (imports only `../shared/types.js` + `node:crypto` for `randomUUID`; NO electron, NO node-pty):
   ```ts
   export interface PtyLike {
     write(data: string): void;
     resize(cols: number, rows: number): void;
     kill(): void;
     onData(cb: (d: string) => void): void;
     onExit(cb: (e: { exitCode: number }) => void): void;
   }
   export interface PtySpawnOpts { shell: string; cwd: string; cols: number; rows: number; env: Record<string, string | undefined>; }
   export type PtyFactory = (opts: PtySpawnOpts) => PtyLike;   // throws => unavailable
   export function defaultShell(platform: string, env: Record<string, string | undefined>): string;  // $SHELL ?? 'bash'; 'powershell.exe' on win32
   export const OUTPUT_BUFFER_CAP = 256 * 1024;  // drop-oldest flow-control bound
   export interface TerminalManager {
     open(payload: unknown): TerminalOpenResult;
     input(payload: unknown): void;       // validates { sessionId, data }
     resize(payload: unknown): void;      // validates { sessionId, cols, rows }
     close(payload: unknown): void;       // validates { sessionId }
     attachSink(send: (channel: string, payload: unknown) => void): () => void;
     disposeAll(): void;
   }
   export function createTerminalManager(deps: {
     factory: PtyFactory;
     rootDir: string;
     platform?: string;                   // default process.platform
     env?: Record<string, string | undefined>;
   }): TerminalManager;
   ```
   Behavior: single live session (open kills the previous); session-id = `randomUUID()` token re-checked on every input/resize/close (stale id ⇒ silent no-op); input rejected when not a string or `Buffer.byteLength(data) > MAX_TERMINAL_INPUT_BYTES`; cols/rows must be finite integers in range; output pump coalesces `onData` chunks into a per-tick flush (setTimeout 8ms, `unref()`), bounded at `OUTPUT_BUFFER_CAP` total pending bytes with drop-oldest; on exit push `TERMINAL_EXIT { sessionId, exitCode }` and clear the session.
2. `src/main/pty-factory.ts` — the ONLY node-pty touchpoint:
   ```ts
   export function createNodePtyFactory(): PtyFactory;
   ```
   Lazily `require('node-pty')` inside the returned function (CJS require survives esbuild externalization); adapt `IPty` to `PtyLike`; a require/spawn failure throws — the manager catches and returns `{ sessionId: null }` (graceful "terminal unavailable").
3. `build.mjs`: `mainBuild.external: ['electron', 'node-pty']`. Testkit build untouched (terminal.ts is node-pty-free; `pty-factory.ts` is NOT exported through testkit).
4. `src/testkit-entry.ts`: `export { createTerminalManager, defaultShell, OUTPUT_BUFFER_CAP } from './main/terminal.js';` (+ types).
5. `package.json` test script: append `test/terminal.mjs`.

**Run tests:** `npm run typecheck && npm run build && node --test test/terminal.mjs`

**Commit:** `feat(main): pure terminal session manager with injected pty factory + validators`

---

### Task 4 — ipc.ts wiring + preload allow-list + main lifecycle kill

**Files (modify):** `src/main/ipc.ts`, `src/preload/preload.ts`, `src/main/main.ts`.

**Failing test first:** The validation/kill logic is already unit-pinned in Task 3 (the handlers are one-line delegations); the cross-process path is only reachable by the Tier-2 e2e (Task 9) — same layering rationale as `navlinks.e2e.ts`. **Verification step instead:** `npm run typecheck && npm run build` green, plus the e2e in Task 9 exercising every channel end-to-end.

**Implementation:**
1. `src/main/ipc.ts`:
   - `IpcDeps` gains `terminal: TerminalManager`.
   - Four handlers, each delegating the RAW payload to the manager (re-validation lives in the pure manager):
     ```ts
     ipcMain.handle(IPC.TERMINAL_OPEN,  (_evt, p: unknown) => deps.terminal.open(p));
     ipcMain.handle(IPC.TERMINAL_INPUT, (_evt, p: unknown): void => deps.terminal.input(p));
     ipcMain.handle(IPC.TERMINAL_RESIZE,(_evt, p: unknown): void => deps.terminal.resize(p));
     ipcMain.handle(IPC.TERMINAL_CLOSE, (_evt, p: unknown): void => deps.terminal.close(p));
     ```
   - In the renderer-push attach path: `const detachTerm = deps.terminal.attachSink(send);` and call it in the dispose fn (pushes stop after detach).
2. `src/main/main.ts`:
   - In `bootServices`: `const terminal = createTerminalManager({ factory: createNodePtyFactory(), rootDir });` pass into `createIpcWiring({ ..., terminal })`; add `terminal` to the `Services` interface.
   - Lifecycle safety: `app.on('will-quit', () => services.terminal.disposeAll());` and `win.on('closed', () => services.terminal.disposeAll());` (kill-on-window-close).
3. `src/preload/preload.ts`:
   - Add `IPC.TERMINAL_OPEN/INPUT/RESIZE/CLOSE` to `INVOKE_CHANNELS`; `IPC.TERMINAL_DATA/TERMINAL_EXIT` to `PUSH_CHANNELS`.
   - Add the `terminal` member to the bridge (open/input/resize/close via `assertInvoke`; onData/onExit via the existing push-subscribe idiom).

**Run tests:** `npm run typecheck && npm run build && npm test`

**Commit:** `feat(ipc): wire loom:terminal:* handlers, preload allow-list, kill on window close`

---

### Task 5 — Height clamp/persistence helper (pure) + `toggleTerminal` keybinding command

**Files (create):** `src/renderer/lib/terminal-pane.ts`, `test/terminal-pane.mjs`. **Files (modify):** `src/renderer/lib/keybindings.ts`, `src/testkit-entry.ts`, `package.json` (test script).

**Failing test first:** `test/terminal-pane.mjs` (testkit idiom):
- `TERM-HEIGHT: clampTerminalHeight clamps into [120 .. 0.8*bodyHeight]` — `assert.equal(clampTerminalHeight(40, 1000), 120)`; `assert.equal(clampTerminalHeight(5000, 1000), 800)`; `assert.equal(clampTerminalHeight(300, 1000), 300)`.
- `TERM-HEIGHT: degenerate body (max < min) pins to min` — `assert.equal(clampTerminalHeight(200, 100), 120)`.
- `TERM-KB: toggleTerminal command exists with default Ctrl+\`` — `COMMANDS.find(c => c.id === 'toggleTerminal')` exists, default binding `Ctrl+\``, `resolveBindings(undefined).toggleTerminal === 'Ctrl+\``, `eventToCombo({ctrlKey:true, key:'\`'}) === 'Ctrl+\``.

**Implementation:**
1. `src/renderer/lib/terminal-pane.ts` — pure, DOM-free: `TERMINAL_MIN_HEIGHT = 120`, `TERMINAL_MAX_FRACTION = 0.8`, `TERMINAL_DEFAULT_HEIGHT = 240`, `TERMINAL_HEIGHT_STEP = 24`, `TERMINAL_HEIGHT_KEY = 'loom-terminal-height'`, `TERMINAL_OPEN_KEY = 'loom-terminal-open'`, `terminalHeightMax(bodyHeight)`, `clampTerminalHeight(raw, bodyHeight)`.
2. `src/renderer/lib/keybindings.ts`: add `'toggleTerminal'` to `CommandId`; add `{ id: 'toggleTerminal', label: 'Toggle terminal', defaultBinding: 'Ctrl+\`' }` to `COMMANDS`.
3. `src/testkit-entry.ts`: export the new helpers/constants (+ `COMMANDS`/`resolveBindings`/`eventToCombo` if not already exported).
4. `package.json` test script: append `test/terminal-pane.mjs`.

**Run tests:** `npm run build && node --test test/terminal-pane.mjs && npm test`

**Commit:** `feat(renderer): terminal height clamp helpers + Ctrl+\` toggleTerminal command`

---

### Task 6 — TerminalPane renderer component

**Files (create):** `src/renderer/components/TerminalPane.tsx`.

**Failing test first:** Not unit-testable — thin xterm/DOM binding over `window.loom.terminal` (xterm needs a real layout engine; jsdom can't drive it). All pure logic lives in Tasks 3/5. **Verification step instead:** Task 9 e2e + `npm run typecheck && npm run build`.

**Implementation:** `TerminalPane({ height, maximized, onToggleMaximize, onClose, focusNonce })`:
1. Imports: `import { Terminal } from '@xterm/xterm'; import { FitAddon } from '@xterm/addon-fit'; import '@xterm/xterm/css/xterm.css';` (CSS bundles into `dist/renderer.css` — no CSP/`<link>` change).
2. Mount effect (once): `readXtermTheme()` reads `getComputedStyle(document.documentElement)` theme tokens into `{ background, foreground, cursor, selectionBackground }`; `new Terminal({ scrollback: 5000, theme })` + `FitAddon`, `term.open(el)`, `fit.fit()`, `const { sessionId } = await window.loom.terminal.open({ cols: term.cols, rows: term.rows })`. `sessionId === null` ⇒ "Terminal unavailable" empty state. Otherwise:
   - `term.onData(d => void window.loom.terminal.input(sessionId, d))`
   - `unsubData = window.loom.terminal.onData(p => { if (p.sessionId === sessionId) term.write(p.data); })`
   - `unsubExit = window.loom.terminal.onExit(p => { if (p.sessionId === sessionId) setEnded(true); })` → "Session ended — close and reopen for a fresh shell" notice.
   - `ResizeObserver` on the container → `fit.fit()` → `void window.loom.terminal.resize(sessionId, term.cols, term.rows)`.
   - `term.focus()` on mount.
   - Cleanup: `unsubData(); unsubExit(); void window.loom.terminal.close(sessionId); term.dispose(); observer.disconnect();` — unmount kills the PTY.
3. Theme reactivity: MutationObserver on `document.documentElement`'s theme attribute re-applies `term.options.theme = readXtermTheme()`.
4. Chrome: `.pane-head`-style header — `<span>Terminal</span>`, maximize/restore button (`aria-label` flips), close button calling `onClose`. Re-fit + refocus when `height`/`maximized`/`focusNonce` change.

**Run tests:** `npm run typecheck && npm run build`

**Commit:** `feat(renderer): TerminalPane component (xterm + fit addon, themed, push-wired)`

---

### Task 7 — App.tsx layout integration: dock row, useTerminalHeight, row splitter, maximize, status-bar toggle, keybinding, focus

**Files (modify):** `src/renderer/components/App.tsx`, `src/renderer/components/StatusBar.tsx`.

**Failing test first:** Pure pieces already pinned by `test/terminal-pane.mjs` (Task 5); the rest is React/DOM wiring not reachable by the node --test tier. **Verification step instead:** Task 9 e2e + `npm run typecheck`.

**Implementation (mirroring the existing chat/explorer idioms):**
1. `useTerminalHeight()` — mirror of `useChatWidth`: lazy init from `localStorage['loom-terminal-height']` (fallback `TERMINAL_DEFAULT_HEIGHT`), setter clamps via `clampTerminalHeight(next, bodyHeight)` and persists in try/catch.
2. State: `terminalOpen` (lazy init from `'loom-terminal-open'`), `terminalMax` (session-only `useState(false)`), `terminalFocusNonce`, `terminalToggleRef`.
3. `toggleTerminal()`: flips + persists; announces via the existing live region ("Terminal opened/closed"); on close, return focus to the toggle button; on open, bump `terminalFocusNonce`. Closing resets `terminalMax`.
4. Dispatcher: add `toggleTerminal` to the command map. NOTE: xterm's textarea is an editable target — exempt `toggleTerminal` from the `isEditableTarget` guard so Ctrl+` both opens and closes from inside the terminal.
5. `RowSplitter` — horizontal mirror of `Splitter`: `role="separator"`, `aria-orientation="horizontal"`, pointer-capture drag on `clientY` (drag up widens), `ArrowUp`/`ArrowDown` by `TERMINAL_HEIGHT_STEP`, `Home`/`End`, aria-value*, `tabIndex={0}`, classes `splitter horizontal [dragging]`.
6. Render inside `.body` after `Chat`: row splitter (hidden when maximized) + `<TerminalPane …/>` when open; `.body` className gains `terminal-open` / `terminal-max`; style gains `['--terminal-h']: terminalHeight + 'px'`.
7. `StatusBar.tsx`: `terminalOpen` / `onToggleTerminal` / `terminalToggleRef` props; toggle button (`aria-pressed`, title "Toggle terminal (Ctrl+\`)") next to the chat toggle.
8. Update the stale App.tsx header comment ("NO terminal pane (OQ-6)", App.tsx:6) to describe the new optional bottom dock (review finding).

**Run tests:** `npm run typecheck && npm run build && npm test`

**Commit:** `feat(app): bottom-dock terminal pane with resize splitter, maximize, status-bar toggle`

---

### Task 8 — CSS: dock grid row, splitter, header, maximize collapse

**Files (modify):** `src/renderer/styles/renderer.css`.

**Failing test first:** Not applicable — pure CSS. **Verification step instead:** Task 9 e2e (pane visible, content renders) + optional `--capture` screenshot.

**Implementation (around `.body`):**
1. Pin existing children to row 1: `.body > * { grid-row: 1; }` (keep existing min-height/min-width rules).
2. Dock rows: `.body.terminal-open { grid-template-rows: minmax(0, 1fr) var(--terminal-h, 240px); }`; `.body.terminal-open.terminal-max { grid-template-rows: 0 minmax(0, 1fr); }`.
3. Terminal items span all columns in row 2: `.body > .splitter.horizontal, .body > .pane.terminal { grid-column: 1 / -1; grid-row: 2; }`; `.splitter.horizontal` at the dock's top edge (`cursor: row-resize`, reuse `.splitter` color/`:focus-visible`/`.dragging` rules, mirrored for the horizontal axis).
4. `.pane.terminal`: column flex — `.pane-head`-style header + `.term-body { flex: 1; min-height: 0; }`; theme-token background.

**Run tests:** `npm run build` — then visual check via Task 9 e2e.

**Commit:** `style(renderer): terminal dock grid row, horizontal splitter, maximize collapse`

---

### Task 9 — Tier-2 e2e: open → pwd prints launch root → close kills the shell

**Files (create):** `test/e2e/terminal.e2e.ts`.

**Failing test first (this IS the test task):** Playwright `_electron`, following `test/e2e/navlinks.e2e.ts` (built `dist/main.cjs` prereq, temp sandbox dir, `LOOM_ROOT` env, `firstWindow()`):
- `terminal opens, shell starts in the launch root (pwd)`: click the "Toggle terminal" button; wait for `.pane.terminal .xterm`; type `echo "PWD:$(pwd)"` + Enter; `expect(page.locator('.pane.terminal')).toContainText('PWD:' + fs.realpathSync(rootDir))` (realpath guards `/tmp` symlinks). **Key assertion:** launch root appears in rendered terminal output (AC 1 + 7).
- `closing the pane kills the PTY process`: `echo "PID:$$"`, parse pid; close the pane; poll `electronApp.evaluate(... process.kill(PID, 0) ...)` until it throws. **Key assertion:** process gone (AC 2).
- `reopen yields a fresh working shell`: toggle open again, `echo round2`, assert `round2` renders (AC 3).
- CI caveat in-file: runs under xvfb in `.github/workflows/e2e.yml`, not in the WSL sandbox; in-sandbox gate is `npx playwright test --list`.

**Run tests:** `npx playwright test --list` (sandbox gate); full run on CI: `npm run build && npm run test:e2e`.

**Commit:** `test(e2e): terminal pane open/pwd-in-root/close-kills round-trip`

---

### Task 10 — Packaging + CI: node-pty in installers, rebuild in workflows

**Files (modify):** `electron-builder.config.cjs`, `.github/workflows/e2e.yml`, `.github/workflows/linux-installer.yml`, `.github/workflows/windows-installer.yml`, `.github/workflows/macos-installer.yml`.

**Failing test first:** Not applicable — packaging/CI config. **Verification step instead:** `npm run dist:linux` locally if tooling permits (deb contains `resources/app.asar.unpacked/node_modules/node-pty/.../pty.node`); otherwise CI verification on push (accepted in design §8).

**Implementation:**
1. `electron-builder.config.cjs`: `files: ['dist/**', 'package.json', 'node_modules/node-pty/**']`; `asarUnpack: [..., 'node_modules/node-pty/**']`; comment noting electron-builder's default `npmRebuild: true` rebuilds node-pty (production dep) per platform.
2. Each workflow: after `npm ci`/install add `npx electron-rebuild -f -w node-pty` (e2e workflow needs it to launch; explicit step in installer workflows fails fast).

**Run tests:** `npm run typecheck && npm run build && npm test` (no regression); CI proof on push.

**Commit:** `build(package): ship node-pty unpacked in installers + rebuild step in CI`

---

### Task 11 — Docs: CONTRACTS.md additive IPC extension + README Design-Laws carve-out

**Files (modify):** `CONTRACTS.md`, `README.md`.

**Failing test first:** Not applicable — documentation. **Verification step instead:** proofread that every channel/shape in CONTRACTS.md matches `src/shared/types.ts` literally.

**Implementation:**
1. `CONTRACTS.md`: add the six `TERMINAL_*` rows to the channel table, the `terminal` bridge member, and a "Terminal (ADDITIVE)" note: payloads re-validated in main (types, session-id token, `MAX_TERMINAL_INPUT_BYTES` cap), single session, PTY killed on window close, **MCP-invisible** (agent surface unchanged).
2. `README.md` Design Laws section: "Human terminal carve-out" paragraph — Law 1 governs content rendering and the agent surface; the terminal is a deliberate human-invoked execution surface in main, never reachable by agents/MCP; Law 3's file sandbox governs the Explorer/Viewer/MCP surface only.

**Run tests:** none (docs); `git diff --stat` sanity.

**Commit:** `docs: CONTRACTS.md terminal IPC extension + README human-terminal carve-out`

---

### Task 12 — Full-suite verification

**Files:** none.

**Verification:**
```
npm run typecheck
npm run typecheck:e2e
npm run build
npm test                      # all existing + test/terminal.mjs + test/terminal-pane.mjs, 0 failures
npx playwright test --list    # e2e compiles + enumerates (sandbox gate; full run on CI)
```
Confirm AC 10 by inspection: `src/renderer/index.html` CSP untouched, `hardenedWebPreferences()` untouched.

**Commit:** none (verification only; fix-forward commits if anything is red).

---

## Dependency order

1 → 2 → 3 → 4 → {5, 6} → 7 → 8 → 9 → 10 → 11 → 12. (5 and 6 are independent of each other; both block 7.)

## Key risks carried from the design (dispositions)

- **node-pty ABI rebuild fails in-sandbox** → Task 3's `PtyFactory` seam means only `src/main/pty-factory.ts` changes for the `script -qfc` Linux fallback; every other task is unaffected.
- **e2e cannot run in WSL sandbox** → `--list` gate locally, full run in `.github/workflows/e2e.yml` (existing, accepted pattern).
- **Renderer flooding** → bounded drop-oldest pump (Task 3, unit-pinned) + xterm `scrollback: 5000`.
