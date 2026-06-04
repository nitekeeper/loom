# Tier 2 — Playwright Electron e2e

Real-stack end-to-end tests that launch the **built** Loom app (`dist/main.cjs`)
with Playwright's `_electron` API — a real Chromium renderer driven against the
real Electron main process — so the whole chain is under test. Three features:

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

### `copy-rendered.e2e.ts` — Viewer "Copy rendered"

```
Viewer head button  /  Ctrl(⌘)+Shift+C shortcut
      →  MarkdownCopyHandle.copyRendered  (serializes the LIVE .md DOM)
      →  serializeRenderedForCopy  (allowlist rebuild, lib/copy-serialize.ts)
      →  preload bridge  window.loom.copyToClipboard
      →  COPY_TO_CLIPBOARD IPC  (main re-validation, src/main/ipc.ts)
      →  Electron  clipboard.write({ text, html })
```

This is the **only** layer that can exercise the **main-process** halves and a
**real OS clipboard** end to end: the `COPY_TO_CLIPBOARD` IPC's shape
re-validation and the native `clipboard.write`. The `npm test` node-`--test`
suite (`test/copy-serialize.mjs`) proves the **pure** serializer
(`serializeRenderedForCopy`) in isolation under jsdom — the allowlist rebuild,
the link-href gate, the code-block reconstruction, the hostile-input scrub —
but it never touches the bridge, the IPC, or the clipboard.

Tests, each failing for the right reason:

1. **BUTTON** — open a `.md` with a heading, bold, a list, a safe link, and a
   code block; `clipboard.clear()` first (so a leftover value can't pass it for
   the wrong reason); click the header **Copy rendered** button; assert
   `clipboard.readHTML()` carries the rendered structure (`<h1>`, `<strong>`,
   `<a href="https://…">`, a clean `<pre><code>`) and does **not** contain
   `class="ln"`, `data-loom`, or `javascript:`; assert `clipboard.readText()`
   carries the heading + code text.
2. **SHORTCUT parity + native Ctrl/⌘+C** — with the same file, press the
   platform copy shortcut (`⌘+Shift+C` on macOS, `Ctrl+Shift+C` elsewhere — the
   renderer maps both to the one `copyRendered` command) and assert the
   clipboard matches the **same** cleaned, portable contract as the button.
   Then seed a sentinel, press **plain** Ctrl/⌘+C, and assert the rendered HTML
   did **not** land — plain copy must stay native selection-copy, never
   rendered-copy.
3. **AFFORDANCE** — after a successful copy the button label flips to **Copied**
   (+ a `.copied` class) and a polite `role="status"` region announces it, then
   it reverts to **Copy rendered** (the transient success affordance for
   sighted + AT users). The three success markers are asserted in **one atomic
   `expect.poll`** (one snapshot per poll) so they are observed at the same
   instant of the ~1.5 s transient window — separate awaits could race the
   window under CI load and burn the full expect timeout on a stale revert.
4. **MAIN-process gate (length cap + bad-shape no-op)** — drives the **real**
   preload bridge `window.loom.copyToClipboard` (→ `COPY_TO_CLIPBOARD` IPC →
   `src/main/ipc.ts`) with payloads the renderer never builds: an
   `> 5,000,000`-char `html`, an oversize `text`, and malformed shapes
   (`{ html: 123 }`, a missing field, `null`, a bare string). A seeded sentinel
   is asserted **untouched** after each (the cap / shape check silently dropped
   the write). A final well-formed, in-bounds `{ html, text }` pair **does**
   land — proving the no-ops were the gate, not a broken IPC that drops
   everything. This is the only layer that can reach that main-process branch
   (the jsdom serializer suite cannot), closing the spec checklist's
   *very large doc (length cap)* coverage item.

The clipboard is read back **from the main process** —
`electronApp.evaluate(({ clipboard }) => ({ html: clipboard.readHTML(), text: clipboard.readText() }))`
— so there is **no** renderer-side Clipboard API and **no** production seam (see
*Zero production seam* below). Electron wraps written HTML in a
`<html><body>`/`<meta>` (CF_HTML) fragment, so the HTML assertions check
substrings of the inner markers, not string equality.

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
