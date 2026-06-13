# Implementation Plan — Viewer Reading Width: 120ch Fixed + Quick Toggle

**Design:** `docs/design/loom-reading-width-120ch-design.md` · Repo: `/home/nitekeeper/apps/loom` (main checkout, branch main at 3ed2bcc+)

## Goal

Fixed reading width becomes `120ch`, applies to all viewer content, with a persisted Viewer-header + `Ctrl+Shift+W` toggle kept in sync with the Settings panel.

## Tech constraints

Pure renderer; existing md-width.ts machinery + localStorage key unchanged; keybindings COMMANDS append idiom (count pin 10→11); Viewer header button mirrors `copy-rendered-btn`; live-region announcements; no IPC/CSP/main edits.

## Tasks

### Task 1 — Pure logic + keybinding (TDD)

**Files:** modify `src/renderer/lib/md-width.ts` (add `toggleWidthMode(m: WidthMode): WidthMode`, update any 792px-referencing doc text), `src/renderer/lib/keybindings.ts` (`toggleReadingWidth`, label "Toggle reading width", default `Ctrl+Shift+W`), `src/testkit-entry.ts` (export new symbols if absent), `test/md-width.mjs` (new pins), `test/acceptance.mjs` (COMMANDS pin 10→11), `package.json` only if a new test file is added (none planned).

**Failing test first:** in `test/md-width.mjs`: `toggleWidthMode('fit')==='full'` and inverse; in the keybindings section of acceptance or md-width tests: command exists with default `Ctrl+Shift+W`, `findConflict(DEFAULT_BINDINGS,'Ctrl+Shift+W','toggleReadingWidth')===null`, `isReserved('Ctrl+Shift+W')===false`. RED → implement → GREEN.

**Run:** `npm run build && node --test test/md-width.mjs && npm test`
**Commit:** `feat(viewer): toggleReadingWidth command + width-mode toggle helper`

### Task 2 — CSS 120ch + apply to all content + UI toggle

**Files:** modify `src/renderer/styles/renderer.css` (`.md` max-width 792px→`120ch`; add the equivalent capped+centered rule for the code/plaintext content wrapper under `[data-mdwidth="fit"]`, full bypass under `"full"` — read the actual code-view wrapper class first), `src/renderer/components/Viewer.tsx` (ensure `data-mdwidth` present on the section for ALL content types — recon says it already is on the section; verify code path; add header toggle button after copy-rendered: `reading-width-btn`, `aria-pressed={mdWidth==='fit'? false-or-semantics-chosen}`, title `Reading width: …(Ctrl/Cmd+Shift+W)`, inline SVG icon per house idiom, onClick → `onMdWidthChange(toggleWidthMode(mdWidth))` via a new prop or the existing flow), `src/renderer/components/App.tsx` (dispatcher entry `toggleReadingWidth` → `setMdWidthMode(toggleWidthMode(mdWidth))` + live-region announce "Reading width set to …"), `src/renderer/components/SettingsPanel.tsx` (label "Fixed (792px)"→"Fixed (120 ch)", announcement string update).

**Failing test first:** not unit-reachable (CSS/JSX wiring) — verification = Task 3 e2e + gates; the pure toggle logic is already pinned in Task 1.

**Run:** `npm run typecheck && npm run build && npm test`
**Commit:** `feat(viewer): 120ch fixed reading width for all content + header/shortcut toggle`

### Task 3 — e2e + docs touch-up

**Files:** extend the existing reading-width e2e (or `test/e2e/` file that covers viewer settings; if none covers it, add `test/e2e/reading-width.e2e.ts` following navlinks idioms): open a file, assert `data-mdwidth` flips via the header button and via Ctrl+Shift+W, persists across reload of state (localStorage). Update README/docs only if they mention 792px.

**Failing test first (is the test):** e2e assertions above; in-sandbox gate `npm run typecheck:e2e && npx playwright test --list` exit 0.
**Run:** gates + `--list`.
**Commit:** `test(e2e): reading-width 120ch toggle coverage`

### Task 4 — Full-suite verification

`npm run typecheck && npm run typecheck:e2e && npm run build && npm test && npx playwright test --list` all exit 0; then `npm run dist:linux` for the user-verification deb.

## Dependency order

1 → 2 → 3 → 4.
