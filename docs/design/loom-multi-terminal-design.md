# Design — Loom: Multiple Terminal Support

> Atelier project #12 (`loom-multi-terminal`, workspace `loom`). Phase: design:approved.
> Authored by the PM (Dr. Priya Nair) from a 6-specialist recon + architect synthesis.
> Status of open questions: all resolved (see §Decisions).

## 1. Goal

Loom supports up to **3 concurrent terminals** (today: exactly 1), each with the **same features** as the current single pane, laid out in **2 columns (2 terminals) or 3 columns (3 terminals)**, with **rebindable** per-terminal focus shortcuts and a focus-switch ("move to another terminal") shortcut.

## 2. Scope (in)

1. **Multi-session terminal manager** — `src/main/terminal.ts` converts its single `session` to a `Map<sessionId, SessionEntry>`; **each entry owns its own pty AND its own output-pump state** (`pending`/`pendingBytes`/`flushTimer`); `MAX_TERMINALS = 3`. `open()` STOPS killing the previous session; `close()` removes one entry; `disposeAll()` reaps every entry (clearing each per-entry timer).
2. **Up to 3 renderer panes** — mount up to 3 `TerminalPane` instances, each fully featured (xterm + FitAddon + ResizeObserver + per-pane head buttons: maximize/close), self-filtering the shared `onData`/`onExit` broadcast by its own `sessionId`. A new `slot`/`index` prop gives a unique `aria-label` (`Terminal N`) + a per-pane data attribute (e2e selectors) + per-index focus targeting.
3. **Column layout** — a NEW pure module `src/renderer/lib/terminal-columns.ts` (modeled 1:1 on `lib/viewer-split.ts`): `clampTerminalColumns(1..3)`, column track math, **N-pane min-width floor clamp**, `coerceStoredColumns`/count, active-terminal-index resolution. A `.terminal-dock-wrap` sub-grid inside the existing bottom-dock row lays 1/2/3 columns (grid-template-columns from the viewer-split pattern), with **resizable** inter-terminal dividers reusing the existing `ColSplitter`.
4. **Per-terminal solo-maximize** — maximize expands the focused terminal and **hides the other terminals** within the dock (NOT whole-dock). Needs an App `maximizedTerminalIndex` state (`null` = none) + NEW CSS state classes that hide the non-maximized siblings (must NOT reuse the legacy `.body.terminal-max > :not(.pane.terminal){visibility:hidden}` rule, which would hide all terminals once a wrapper exists — risk R11).
5. **Rebindable shortcuts** — add 4 `CommandId`s (`focusTerminal1`, `focusTerminal2`, `focusTerminal3`, `cycleTerminalFocus`) to `src/renderer/lib/keybindings.ts` + 4 `COMMANDS` rows. Defaults: **`Ctrl+1` / `Ctrl+2` / `Ctrl+3`** (focus) and **`Ctrl+Alt+\``** (cycle/move-focus). Focus commands get the `toggleTerminal`-style **editable-target exception** (via `bindingAllowedFor`) so they fire from inside a focused terminal, and a modifier is required so a bare key can never be bound. These auto-flow into `DEFAULT_BINDINGS`, `resolveBindings`, `diffOverrides`, `findConflict`, and the ShortcutsPanel rows with no panel wiring.
6. **Persistence** — persist `terminalCount` (and optionally column count) in **`loom-config.json`** via the keybindings round-trip pattern: optional `LoomConfig` fields + a range-validating coercer in `config.ts` (default count = 1 on missing/garbage) + a setter + a new `SET_TERMINAL_LAYOUT` IPC channel + handler + `buildInitialState` threading. New bindings persist automatically via the existing flat keybindings override map. Column WIDTH ratios stay ephemeral in localStorage (mirroring viewer-split). Existing dock-open/height localStorage keys keep their meaning (the first/shared dock terminal).
7. **Affordances** — StatusBar add/close-terminal affordance + a SettingsPanel terminal-count/column control wired to the new setter.
8. **Contract prose** — amend `CONTRACTS.md` (TERMINAL_* + §7c) and the `src/shared/types.ts` §7c JSDoc from "SINGLE live session / a second open kills the previous" to "up to 3 concurrent `sessionId`-keyed sessions; open at capacity returns `sessionId:null`". The 6 channels + `TerminalBridge` method signatures are UNCHANGED.
9. **Tests** — unit (node --test over `dist/testkit.cjs`) + e2e (Playwright `_electron`). See §4 + §8.

## 3. Non-goals (explicitly out)

- **Per-terminal distinct cwd/shell** — all 3 terminals spawn the same default shell at the launch `rootDir`. (Adding differing cwd/shell would widen `open()`/`TerminalOpenParams` + the contract — out of scope.)
- **More than 3 terminals** — hard cap = 3 (column layout maxes at 3).
- **Non-column layouts** — no rows/grid-tiling; columns only.
- **A config migration runner** — none exists in Loom; new config fields are additive + optional + tolerant only.
- **Per-terminal channel names** — routing stays by `sessionId` in payload on the existing 6 fixed channels.

## 4. Acceptance criteria (testable)

1. Opening up to 3 terminals yields **3 live, independent PTYs with distinct PIDs**; opening a 2nd/3rd does NOT kill the first. *(unit + e2e)*
2. A **4th open is rejected** — returns `sessionId: null`, spawns nothing, kills nothing; UI surfaces "at capacity". *(unit)*
3. **Output isolation**: a chunk emitted on session A NEVER appears in session B's push; `OUTPUT_BUFFER_CAP` flow-cap accounting is per-session. *(unit — the highest-risk regression, R1)*
4. **Lifecycle**: `close(one)` kills only that PTY; reload (`did-navigate`), window-close, and `will-quit` each reap ALL live PTYs. *(unit + e2e via `process.kill(pid,0)` probes)*
5. **Layout**: 2 terminals → 2 columns, 3 → 3 columns; columns resizable via `ColSplitter`; N-pane min-width floor enforced. *(unit for the clamp/track math; e2e for `boundingBox` widths)*
6. **Solo-maximize**: maximizing terminal *i* hides the other terminals and expands *i*; un-maximize restores the column layout. *(unit/state + e2e)*
7. **Shortcuts**: `Ctrl+1/2/3` focus the respective terminal **even from inside another terminal**; `Ctrl+Alt+\`` advances focus (clamped/no-op at edges per live count); all 4 are rebindable via the Settings panel; the chosen defaults are **conflict-free against the 15 existing defaults + RESERVED combos** (author-time guard test). *(unit + e2e rebind flow)*
8. **Persistence/back-compat**: `terminalCount` persists across restart; an existing config with NO `terminalCount` key loads as **1 terminal** (visual no-op for upgrading single-terminal users); an unknown future config key is tolerated. *(unit — mirror `test/retention.mjs`)*
9. **Gates green**: `npm test` (node --test, incl. the new/rewritten suites) passes; `npm run typecheck` and `npm run typecheck:e2e` clean; `npx playwright test --list` resolves the new e2e specs. (Real e2e pass is a CI/xvfb gate — e2e cannot launch in the WSL sandbox.)

## 5. Constraints

- Keep the 6 fixed `loom:terminal:*` channels and the preload **fail-closed** `INVOKE_CHANNELS`/`PUSH_CHANNELS` allowlist UNCHANGED — route by `sessionId`.
- `src/main/pty-factory.ts` is UNCHANGED (already per-spawn / multi-instance-safe).
- Config changes are additive/optional/tolerant (no migration runner).
- New shortcut defaults must NOT collide with the 15 existing defaults or RESERVED combos (esp. `Ctrl+Shift+Tab`, the xterm focus-escape).
- Every NEW `.mjs` test file MUST be (a) appended to `package.json` `scripts.test` AND (b) any new pure module re-exported from `src/testkit-entry.ts` — both are silent-skip traps (R4, R5).
- E2E cannot LAUNCH in WSL — gate sandbox validation to `--list` + `typecheck:e2e`; real pass is a CI gate.
- `.ai/` (atelier scaffolding) must be gitignored, never committed.

## 6. Stakeholders

- **NiteKeeper (Loom user)** — wants multi-terminal productivity with easy focus-switching.
- **Dr. Priya Nair (PM)** — orchestration, design/decisions, review-fix loop.
- **Dr. Samuel Okafor (backend-engineer-1)** — multi-session manager + config persistence.
- **Dr. Amara Diallo (frontend-engineer-1)** — layout module, App state/dispatcher, TerminalPane, CSS, affordances.
- **Dr. Hiroshi Tanaka (software-architect-1)** — contract amendment + cross-cutting standards.
- **Dr. Chioma Obi (sdet-1) + Dr. Blessing Chukwu (qa-engineer-1)** — unit + e2e test extension.
- **Dr. Ingrid Larsen (security-engineer-1)** — security review (IPC/preload boundary).

## 7. Dependencies / Prerequisites

- Loom's v0.8.x **rebindable-shortcuts system** (`keybindings.ts`, ShortcutsPanel, `resolveBindings`/`findConflict`).
- The **`viewer-split`** precedent (`lib/viewer-split.ts` + `test/viewer-split.mjs`) and the **`ColSplitter`** component.
- The **`loom-config.json`** coercer/round-trip pattern (`config.ts`, `coerceMaxMessages` as the template) + `buildInitialState`.
- The **`testkit-entry.ts` / `dist/testkit.cjs`** Electron-free test harness and the explicit `package.json` test list.
- **node-pty** native binding (e2e tier only; unit tier injects a fake factory).

## 8. Risks / Unknowns (each mitigated)

| # | Risk | Disposition |
|---|---|---|
| R1 | Shared output-pump left global while sessions become a map → interleaved/corrupt output + mis-accounted `OUTPUT_BUFFER_CAP` | **Move ALL pump state into each `SessionEntry`**; unit test asserts A→B no cross-talk + per-session flow-cap |
| R2 | Removing kill-on-open without a cap → runaway PTY leak | Pair with `MAX_TERMINALS=3` reject; unit-test 4th open neither spawns nor kills |
| R3 | `disposeAll` map version regresses reap-all → orphan PTYs on reload/quit | Iterate the map; e2e `process.kill(pid,0)` probes on every spawned pid after reload/quit |
| R4 | New `.mjs` not appended to `package.json` test list → silently never runs | Explicit `package.json` append in W3-T12 + reviewer checklist item |
| R5 | New pure module not re-exported from `testkit-entry.ts` → `undefined is not a function` | W3-T10 (re-export) is a hard dep of the unit tasks |
| R6 | A shipped default binding collides with an existing/RESERVED combo → command ships DEAD (`findConflict` only guards user rebinds) | **Author-time uniqueness/not-reserved guard test**; chosen defaults pre-verified conflict-free |
| R7 | Focus commands without editable-target exception are dead inside a terminal; bare-key would swallow shell keys | Grant editable-target exception in dispatcher + require a modifier via `bindingAllowedFor` |
| R8 | Single shared `focusNonce` focuses the wrong pane with 3 instances | Model focus as `{targetIndex, nonce}`; each pane compares its own slot |
| R9 | Multi-terminal makes e2e selectors non-unique (Playwright strict mode) | slot data attribute + indexed aria-label (W2-T7) + per-index scoped selectors (W3-T13) |
| R10 | No migration runner; tolerant-coerce dropping the field loses count silently | Additive/optional fields + count=1 default; config-load unit test for old + future-unknown keys |
| R11 | Legacy whole-dock maximize CSS would hide ALL terminals once a wrapper exists | Per-terminal solo-maximize uses NEW state classes hiding only the OTHER terminals; do not reuse the legacy rule |
| R12 | E2E cannot launch in WSL → false green | Gate to `--list` + `typecheck:e2e`; real pass on CI/xvfb only |

## 9. Success metrics

- 3 independent terminals are usable simultaneously (distinct PIDs, isolated I/O).
- The focus-switch shortcut works and is rebindable; per-terminal focus shortcuts work.
- `npm test` green including the new multi-session, column-layout, and binding-guard suites; `typecheck`/`typecheck:e2e` clean; CI e2e green.
- Zero regression to single-terminal UX for upgrading users (default count = 1).

## Decisions (resolved open questions)

- **Shortcuts:** `Ctrl+1/2/3` (focus) + `Ctrl+Alt+\`` (cycle/move-focus). All rebindable.
- **Maximize:** per-terminal **solo-maximize** (hides other terminals) — IN scope for v1.
- **At capacity (4th open):** **reject** + "at capacity" hint (returns `sessionId:null`); never evict.
- **cwd/shell:** identical default shell at `rootDir` for all terminals.
- **Default count:** 1 (back-compat no-op for existing users).
- **Edge behavior:** `cycleTerminalFocus` and `focusTerminalN` clamp/no-op to the live terminal count.
- **Column ratios:** ephemeral in localStorage; `terminalCount`/layout in `loom-config.json`.

## Implementation waves (task DAG → host dispatch)

- **Wave 1 (parallel, disjoint files):** W1-T1 `terminal.ts` multi-session manager · W1-T2 `terminal-columns.ts` (new) · W1-T3 `keybindings.ts` commands · W1-T4 contract prose (`CONTRACTS.md`, `types.ts`).
- **Wave 2 (glue, depends on W1):** W2-T5 config persistence (`config.ts`, `ipc.ts`) · W2-T6 `App.tsx` state+dispatcher+mount+solo-maximize · W2-T7 `TerminalPane.tsx` slot prop + per-pane maximize button · W2-T8 `renderer.css` column grid + solo-maximize classes · W2-T9 `StatusBar.tsx`/`SettingsPanel.tsx` affordances.
- **Wave 3 (tests, depends on W1/W2):** W3-T10 `testkit-entry.ts` re-export · W3-T11 rewrite `test/terminal.mjs` (multi-session) · W3-T12 `test/terminal-columns.mjs` (new) + `test/terminal-pane.mjs` (4 commands + default-binding guard) + `package.json` test list · W3-T13 e2e (`terminal.e2e.ts`, `keyboard-shortcuts.e2e.ts`).
