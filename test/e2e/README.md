# Tier 2 — Playwright Electron e2e

Real-stack end-to-end tests for the **navigable-links** feature. They launch the
**built** Loom app (`dist/main.cjs`) with Playwright's `_electron` API — a real
Chromium renderer driven against the real Electron main process — so the whole
chain is under test:

```
markdown link rule  →  renderer click guard  →  preload bridge
      →  OPEN_EXTERNAL IPC (re-validation)  →  shell.openExternal
nav backstop:  will-navigate  +  setWindowOpenHandler  (installNavGuard)
```

This is the **only** layer that can exercise the **main-process** halves:
the `OPEN_EXTERNAL` IPC re-validation and the window navigation guard. The
`npm test` node-`--test` suites and the jsdom Tier-1 harness
(`test/anchor-guard.mjs`) cannot reach those.

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
