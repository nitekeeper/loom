# Tier 2 — Playwright Electron e2e

Real-stack end-to-end tests that launch the **built** Loom app (`dist/main.cjs`)
with Playwright's `_electron` API — a real Chromium renderer driven against the
real Electron main process — so the whole chain is under test. Two features:

### `navlinks.e2e.ts` — navigable links

```
markdown link rule  →  renderer click guard  →  preload bridge
      →  OPEN_EXTERNAL IPC (re-validation)  →  shell.openExternal
nav backstop:  will-navigate  +  setWindowOpenHandler  (installNavGuard)
```

This is the **only** layer that can exercise the **main-process** halves:
the `OPEN_EXTERNAL` IPC re-validation and the window navigation guard. The
`npm test` node-`--test` suites and the jsdom Tier-1 harness
(`test/anchor-guard.mjs`) cannot reach those.

### `mermaid.e2e.ts` — Viewer mermaid diagrams

```
```mermaid fence  →  inert .mermaid-diagram placeholder (renderMarkdown)
      →  Viewer effect dynamic-imports lib/mermaid-loader.ts (mermaid-FREE)
      →  ensureMermaid() injects dist/mermaid.js (classic <script>, lazy, once)
      →  renderMermaidIn → mermaid.render (securityLevel:'strict')
      →  sanitizeSvg (DOMPurify)
      →  innerHTML  →  .mermaid-done (or .mermaid-error fallback)
```

This is the **only** layer that can exercise the mermaid feature's **runtime**
half: `mermaid.render` needs real SVG layout (`getBBox`) that jsdom does not
implement, so the actual fence → `<svg>` upgrade can only be proven in real
Chromium. The Tier-1 suite (`test/mermaid.mjs`) covers the pure placeholder
markup and `sanitizeSvg` in isolation, but cannot run a real render nor prove
`securityLevel:'strict'` + the DOMPurify scrub hold on what mermaid **actually
produces** from a hostile diagram under the app's real CSP (no `unsafe-eval`).

Tests, each failing for the right reason:

1. **RENDER** — a valid `graph TD` fence becomes a real `<svg>` (`.mermaid-done`
   + a non-empty SVG body); the window never navigates; no uncaught page error.
2. **XSS NEUTRALIZED** — a hostile diagram (a node label smuggling
   `<img onerror>` + a `click … "javascript:…"` interaction directive) renders
   inert: **no** `<script>`/`<foreignObject>`, **no** `on*` handler attribute,
   **no** `<img>` element, the javascript: target **never** reaches the
   `shell.openExternal` spy, and **no** native dialog fires. Proves strict mode
   + DOMPurify hold in real Chromium.
3. **DEGRADE** — a garbage diagram body errors gracefully: `.mermaid-error` is
   set, `.mermaid-done` is not, and the escaped code-block fallback stays
   visible (no crash, no blank).
4. **FILE-SWITCH RACE / CANCELLATION** — opening a heavy multi-diagram file and
   immediately switching to another file mid-render must **not** leak a stale SVG
   into the new file's DOM. Exercises the Viewer effect cleanup (`cancelled =
   true`) + `renderMermaidIn`'s `isCancelled()` / `el.isConnected` guards — the
   one path no Tier-1 test can reach (the unit layer never calls
   `mermaid.render`), so a regressed guard would leave every other test green.
   The second file's own diagram still renders to `.mermaid-done`; the first
   file's diagrams never appear; no uncaught page error.
5. **NON-FLOWCHART TYPES UNDER CSP** — one test per additional type
   (`sequenceDiagram`, `pie`) asserts each renders to `.mermaid-done` (a real
   `<svg>`), **not** `.mermaid-error`, under the locked CSP (`script-src 'self'`,
   **no** `'unsafe-eval'`). See the per-type support note below.

### Supported diagram types under the locked CSP

Loom runs mermaid under `script-src 'self'` with **no** `'unsafe-eval'`. The
question "which diagram types degrade?" was independently verified:

- mermaid 11.15.0's `dist/mermaid.core.mjs` contains **zero** `eval(` /
  `new Function` (`grep` = 0), and esbuild **inlines every diagram-type module
  into a single browser IIFE** with **zero** runtime `import(...)`, **zero**
  `import.meta`, and **zero** `new Function`/`eval(`. As of the lazy-chunk split,
  that IIFE is a SEPARATE bundle — **`dist/mermaid.js`** (~7MB) — injected as a
  same-origin classic `<script src="./mermaid.js">` by `lib/mermaid-loader.ts`
  only when a document actually contains a `.mermaid-diagram`. The startup
  bundle, **`dist/renderer.js`**, is mermaid-FREE (back to a few hundred KB) and
  the eval-free guarantee holds for BOTH bundles (the `test/bundle-split.mjs`
  unit guard asserts mermaid-library signatures are absent from `renderer.js`
  and that neither bundle contains `eval(`/`new Function(`).
- Therefore every standard v11 type (flowchart, sequenceDiagram, classDiagram,
  stateDiagram, erDiagram, gantt, pie, gitGraph, …) is **bundled and available
  at `file://` runtime** with no module-loader fetch and no CSP `eval`
  violation — **none hard-degrades** for want of eval.
- Tests 1–2 prove the flowchart path end-to-end; test 5 locks the non-flowchart
  paths (sequence + pie) so a **future** mermaid bump that reintroduced
  `eval`/`new Function` in any of those layouts fails here (the diagram would
  throw under CSP and land `.mermaid-error`, not `.mermaid-done`).
- The graceful-degradation fallback (test 3) is the safety net for **any**
  future eval-dependent type: it keeps the escaped code-block fallback instead
  of crashing, so an unsupported type never blanks the document.

## Run it locally (real hardware)

```bash
npm run build      # produces dist/main.cjs — a prerequisite
npm run test:e2e   # playwright test
```

`_electron` launches the app's **own** bundled Electron (a devDependency), **not**
a Playwright-managed browser — so there is **no** `npx playwright install` step
and no browser download.

## It does NOT run in the WSL sandbox

There is a documented Electron-headless gremlin in this WSL2 dev sandbox: the
Electron renderer's shared-memory / sandbox path is intercepted, so a launched
window cannot composite/readback reliably. (It is the same reason `loom`'s
screenshot capture needs `--no-zygote` + `--no-sandbox` here.) So **do not** try
to `npm run test:e2e` in the sandbox — it will not launch.

What you **can** do in the sandbox is compile + enumerate the suite without
launching Electron:

```bash
npx playwright test --list   # transpile + enumerate every test (exit code)
npm run typecheck:e2e        # strict tsc over the e2e spec + playwright.config
```

`--list` transpiles `playwright.config.ts` + `test/e2e/*.e2e.ts` via Playwright's
own loader and prints every test it would run, with an exit code — the in-sandbox
enumeration gate. It proves the config and specs are well-formed; it does **not**
prove they pass (that requires a real display).

`npm run typecheck:e2e` is a stricter, complementary gate: the base
`npm run typecheck` scopes `tsc` to `src/**` and **excludes** `test/`, so it
never sees these artifacts, and Playwright's transpiler tolerates type errors a
strict `tsc` would reject. This script type-checks **only** `playwright.config.ts`
+ `test/e2e/**` (via `tsconfig.e2e.json`, which extends the base strict options)
so a type regression in the spec fails fast — display-free — instead of only
when Electron launches. The e2e CI job runs it before the build/launch.

## How it runs in CI

`.github/workflows/e2e.yml` runs on `ubuntu-latest`:

```
checkout → setup-node (20) → npm ci → npm run typecheck:e2e
        → npm run build → xvfb-run -a npm run test:e2e
```

`xvfb-run -a` provides the virtual X display Electron needs on a headless runner.
The Playwright **HTML report** is uploaded as the `playwright-report` artifact
(always, even on failure) for triage.

## Zero production seam

The tests add **no** hook to `src/`. To observe what the app hands to the OS they
monkeypatch `shell.openExternal` **in the main process at runtime**:

```ts
await electronApp.evaluate(({ shell }) => {
  globalThis.__opened = [];
  shell.openExternal = (u) => { globalThis.__opened.push(u); return Promise.resolve(); };
});
// …interact…
const opened = await electronApp.evaluate(() => globalThis.__opened);
```

Both `ipc.ts` and `main.ts` import the same `electron` singleton (esbuild marks
`electron` external), so patching the one `shell.openExternal` is seen by every
call site.

## The capture-window caveat (test `e`)

The capture path (`runCapture`) creates its own hidden window, takes one
screenshot, then calls `app.exit()` and tears the process down — a one-shot,
self-exiting batch mode with no deterministic seam to drive a navigation from a
test **without** adding a production test hook (forbidden). So test `e` is a
**documented `test.skip`**, not a fake always-pass test. The capture window's
guard is instead covered by:

1. `runCapture` calling the **same** `installNavGuard(win)` helper that the main
   window uses (and that tests `c`/`d` prove) — one implementation, so a
   regression fails `c`/`d`; and
2. code review of that single explicit call site.

See the block comment on test `e` in `navlinks.e2e.ts` for the exact assertion
to add if the capture window ever becomes externally driveable without a prod
seam.
