/* ============================================================
 * Loom — Playwright config (TIER 2: real Electron e2e)
 * ------------------------------------------------------------
 * This config drives ONLY the e2e layer (test/e2e/), which launches
 * the REAL Electron main process + REAL Chromium renderer via
 * Playwright's `_electron` API. It is deliberately NOT wired into
 * `npm test` (the node --test Tier-0/Tier-1 suites) — run it with the
 * separate `npm run test:e2e` script.
 *
 * WHY a single project, no `projects` browser matrix:
 *   `_electron.launch()` uses the app's OWN bundled electron (already a
 *   devDependency), NOT a Playwright-managed browser. So there is no
 *   `npx playwright install` step and no chromium/firefox/webkit matrix —
 *   the "browser" is Electron's renderer, launched per test by the spec.
 *
 * WHERE it runs:
 *   - CI (.github/workflows/e2e.yml): ubuntu-latest under `xvfb-run`.
 *   - Locally on real hardware: `npm run build && npm run test:e2e`.
 *   - NOT in the WSL sandbox: a documented Electron-headless gremlin
 *     prevents launch here. `npx playwright test --list` still COMPILES
 *     and ENUMERATES every test without launching electron — that is the
 *     in-sandbox validation gate (see test/e2e/README.md).
 * ============================================================ */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Only the Electron e2e specs live here — kept apart from the node --test
  // suites so `npm test` and `npm run test:e2e` never overlap.
  testDir: './test/e2e',
  testMatch: /.*\.e2e\.(ts|mjs)$/,

  // Launching + driving a real Electron app (build prereq check, did-finish-load
  // wait, IPC round-trips, nav-guard probes) is slower than a unit test. Give
  // each test a generous ceiling so a cold electron spawn under xvfb never
  // flakes on timeout, while still bounding a genuine hang.
  timeout: 60_000,
  expect: { timeout: 15_000 },

  // Electron apps bind a single MCP/WS port + write a discovery file per root;
  // running specs in parallel within one worker would contend. One worker, no
  // intra-file parallelism — correctness over speed for this small suite.
  fullyParallel: false,
  workers: 1,

  // Surface accidental `test.only` left in a spec when running in CI.
  forbidOnly: !!process.env.CI,
  // One retry in CI absorbs a rare cold-spawn flake; none locally so a real
  // failure is loud immediately.
  retries: process.env.CI ? 1 : 0,

  // `list` for human-readable console output (and what `--list` enumerates);
  // `html` produces the report directory CI uploads as an artifact. The HTML
  // reporter is set to never auto-open a browser (open: 'never') so it is
  // CI/headless-safe.
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
});
