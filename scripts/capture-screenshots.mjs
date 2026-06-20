#!/usr/bin/env node
/* ============================================================
 * capture-screenshots.mjs — regenerate artifacts/*.png
 * ------------------------------------------------------------
 * A standalone Playwright-Electron capture harness. It launches the
 * BUILT Loom app (dist/main.cjs) on fixtures/acme-api (or a seeded
 * git copy), drives the renderer into each documented UI state, and
 * writes a deterministic PNG into artifacts/ — REUSING the existing
 * filenames so the README's image refs keep resolving.
 *
 * WHY a standalone driver (not a *.e2e.ts under the Playwright test
 * runner): under a headless xvfb env, Electron's `app.close()` does
 * not reliably resolve (the documented WSL-headless gremlin — see
 * test/e2e/README.md), so the test runner hangs at teardown. This
 * driver owns the process lifecycle instead: each shot launches its
 * own Electron, screenshots, then force-disposes; the driver
 * `process.exit()`s at the end. It is otherwise modeled on the e2e
 * specs — same `_electron.launch({ args:[MAIN_ENTRY], env:{ LOOM_ROOT,
 * XDG_CONFIG_HOME } })`, the same selectors, and the same
 * `waitForSelector` idioms (terminal.e2e.ts / changes.e2e.ts /
 * multi-window.e2e.ts / go-to-definition.e2e.ts).
 *
 * The LIVE-CHAT shots connect real MCP clients to the running Loom's
 * MCP server and replay the canonical acme-api audit timeline — the
 * SAME approach as tools/loom-team.mjs (the shared session is kept
 * consistent with src/main/demo.ts).
 *
 * RUN (headless):
 *     xvfb-run -a npm run capture
 *     xvfb-run -a node scripts/capture-screenshots.mjs            # all
 *     xvfb-run -a node scripts/capture-screenshots.mjs 01 04 08   # subset
 *
 * Every PNG is 1440x900 (matching main.ts's --capture geometry).
 * ============================================================ */
import { _electron as electron } from 'playwright';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/* ------------------------------------------------------------------ */
/* Paths + constants                                                   */
/* ------------------------------------------------------------------ */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main.cjs');
const ARTIFACTS = path.join(PROJECT_ROOT, 'artifacts');
const ACME = path.join(PROJECT_ROOT, 'fixtures', 'acme-api');

/** Same frame geometry main.ts's --capture path uses (CAPTURE_WIDTH/HEIGHT). */
const W = 1440;
const H = 900;

const HERE_TOKEN = '@here';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stderr.write(`[capture] ${m}\n`);

const DONE = [];
const SKIPPED = [];

/* Temp dirs created during the run, removed at the very end. */
const TEMP_DIRS = [];
function tempDir(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  TEMP_DIRS.push(d);
  return d;
}
/** A temp dir whose LEAF name is exactly `acme-api`, so the title bar / sandbox
 *  note show a clean root name (not a mkdtemp suffix). Returns the acme-api
 *  subdir; its parent is tracked for cleanup. */
function acmeCopy() {
  const parent = tempDir('loom-cap-');
  const root = path.join(parent, 'acme-api');
  cpSync(ACME, root, { recursive: true });
  return root;
}

function fileSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Git fixture (Explorer git-status badges + Changes view)             */
/* ------------------------------------------------------------------ */
const GIT_ISOLATION = [
  '-c',
  'core.hooksPath=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'user.email=loom-capture@example.com',
  '-c',
  'user.name=Loom Capture',
];
function git(cwd, args) {
  execFileSync('git', [...GIT_ISOLATION, ...args], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

/** A git copy of acme-api: base commit on `main`, then a `feature` branch with
 *  a modified file (notes.txt), an untracked new file (docs/findings.md), and a
 *  staged new file (CHANGELOG.md) — so the Explorer shows the modified / added /
 *  staged badges AND the branch Changes view has a real diff. */
function makeGitAcme() {
  const root = acmeCopy();
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'base']);
  git(root, ['checkout', '-q', '-b', 'feature']);
  // modified (tracked, uncommitted) -> .dot-git-modified
  writeFileSync(
    path.join(root, 'notes.txt'),
    'Audit notes\n\nRequest lifecycle reviewed.\nConnection pooling flagged.\n',
  );
  // staged new file -> .badge-git-staged ("S")
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n- Initial audit.\n');
  git(root, ['add', 'CHANGELOG.md']);
  // untracked new file -> .badge-git-added ("+")
  writeFileSync(
    path.join(root, 'docs', 'findings.md'),
    '# Findings\n\n- No connection pooling in `db.ts`.\n- Missing validation on `GET /users/:id`.\n',
  );
  return root;
}

/* ------------------------------------------------------------------ */
/* Launch / teardown (e2e-spec idiom, lifecycle-owned)                 */
/* ------------------------------------------------------------------ */
/** Launch the built app rooted at `root` with optional pass-through launcher
 *  args (e.g. ['--explorer-w','360']), isolating Electron userData per launch
 *  so persisted pane/terminal/theme state never leaks between shots (the
 *  terminal.e2e.ts / multi-window.e2e.ts idiom). Returns { app, page }. */
async function launch(root, extraArgs = []) {
  const cfg = tempDir('loom-cap-cfg-');
  const app = await electron.launch({
    args: [MAIN_ENTRY, ...extraArgs],
    env: { ...process.env, LOOM_ROOT: root, SHELL: 'bash', XDG_CONFIG_HOME: cfg },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: W, height: H });
  await page.waitForSelector('.pane.explorer [role="treeitem"]', { timeout: 30_000 });
  return { app, page };
}

/** Force-dispose an Electron app. `app.close()` can hang under headless xvfb
 *  (the WSL gremlin), so race it with a short timeout, then SIGKILL the
 *  underlying process if still alive. Never throws. */
async function dispose(app) {
  if (!app) return;
  let proc;
  try {
    proc = app.process();
  } catch {
    /* no handle */
  }
  await Promise.race([app.close().catch(() => undefined), sleep(4000)]);
  try {
    if (proc && proc.pid && proc.exitCode === null) proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Settle the renderer and force a fresh composited frame before screenshotting
 *  — mirrors runCapture's WSLg flush (settle + double rAF + settle). */
async function settle(page, ms = 700) {
  await sleep(ms);
  await page
    .evaluate(
      () =>
        new Promise((r) =>
          // eslint-disable-next-line no-undef -- runs in the browser context
          requestAnimationFrame(() => requestAnimationFrame(() => r(true))),
        ),
    )
    .catch(() => undefined);
  await sleep(120);
}

async function shot(page, name) {
  await settle(page);
  const out = path.join(ARTIFACTS, name);
  await page.screenshot({ path: out });
  log(`  wrote ${name} (${fileSize(out)} bytes)`);
  if (!DONE.includes(name)) DONE.push(name);
}

/** Run `fn(page)` inside a fresh, force-disposed Electron. Failures are logged
 *  (so one bad shot never aborts the batch) and recorded as skipped. */
async function withApp(root, name, fn, extraArgs = []) {
  let app;
  try {
    const launched = await launch(root, extraArgs);
    app = launched.app;
    await fn(launched.page);
  } catch (err) {
    log(`  !! ${name} failed: ${err?.message ?? err}`);
    if (!DONE.includes(name)) SKIPPED.push(`${name} (${err?.message ?? err})`);
  } finally {
    await dispose(app);
  }
}

/* ------------------------------------------------------------------ */
/* UI helpers (Playwright locator API only)                            */
/* ------------------------------------------------------------------ */
async function openFile(page, basename) {
  await page
    .getByRole('treeitem', { name: new RegExp('^' + basename.replace('.', '\\.') + '$') })
    .first()
    .click();
  await page.waitForSelector('.pane.viewer .render-tag', { timeout: 15_000 });
}

/** Expand src/ and open its first source file (.ts), so the Viewer shows a real
 *  highlighted, foldable source document. */
async function openSource(page) {
  await page.getByRole('treeitem', { name: 'src folder' }).first().click();
  await page.waitForSelector('.pane.explorer [role="treeitem"][aria-label="server.ts"]', {
    timeout: 10_000,
  });
  await page.getByRole('treeitem', { name: 'server.ts' }).first().click();
  await page.waitForSelector('.pane.viewer .render-tag', { timeout: 15_000 });
}

/** Toggle the status-bar theme (sun/moon). Its aria-label is "Switch to light
 *  theme" / "Switch to dark theme"; the renderer sets data-theme on <html>. */
async function setTheme(page, theme) {
  for (let i = 0; i < 2; i++) {
    if ((await page.locator('html').getAttribute('data-theme')) === theme) return;
    await page.locator('.statusbar button[aria-label^="Switch to"]').click();
    await sleep(200);
  }
}

async function openTerminal(page) {
  await page
    .locator('button[aria-label="Terminal"], button[aria-label="Toggle terminal"]')
    .first()
    .click();
  await page.waitForSelector('.pane.terminal .xterm', { timeout: 15_000 });
}

async function runInTerminal(page, command) {
  await page.locator('.pane.terminal .xterm').first().click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await sleep(500);
}

async function foldAll(page) {
  const btn = page.locator('.fold-all-btn').first();
  if ((await btn.count()) > 0) {
    await btn.click();
    await sleep(300);
  }
}

async function openShortcuts(page) {
  await page.keyboard.press('Control+Comma');
  await page.waitForSelector('.sc-dialog, [role="dialog"]', { timeout: 10_000 }).catch(() => undefined);
  await sleep(300);
}

async function runSearch(page, query) {
  await page.locator('.explorer-search-btn').first().click();
  const input = page.locator('.pane.explorer input.search-input').first();
  await input.click();
  await input.fill(query);
  await page
    .waitForSelector('.search-results .search-group, .search-results .search-filegroup', {
      timeout: 10_000,
    })
    .catch(() => undefined);
  await sleep(500);
}

async function openFirstSearchResult(page) {
  const hit = page.locator('.search-results .search-hit, .search-results button').first();
  if ((await hit.count()) > 0) {
    await hit.click();
    await page.waitForSelector('.pane.viewer .render-tag', { timeout: 10_000 }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* MCP live-chat replay (model: tools/loom-team.mjs / src/main/demo.ts)*/
/* ------------------------------------------------------------------ */
const AGENTS = ['lead', 'scout', 'scout-2', 'scribe', 'critic'];
const CHANNELS = [
  { name: 'general', members: ['lead', 'scout', 'scout-2', 'scribe', 'critic'] },
  { name: 'research', members: ['lead', 'scout', 'scout-2'] },
  { name: 'docs', members: ['lead', 'scribe', 'critic'] },
];
const TIMELINE = [
  { ch: 'general', from: 'lead', body: "Kicking off the `acme-api` audit. scout + scout-2 on #research, scribe + critic on #docs. Post findings to your channel — I'll relay across." },
  { ch: 'research', from: 'lead', body: 'Map the request lifecycle. scout: take `server.ts`. scout-2: take `db.ts`.' },
  { ch: 'research', from: 'scout', body: 'On it.' },
  { ch: 'research', from: 'scout-2', body: 'On it.' },
  { ch: 'research', from: 'scout', body: '`server.ts` — Express, 14 routes. Three have no input validation; `GET /users/:id` is the worst offender.' },
  { ch: 'research', from: 'lead', to: 'scout', body: 'Flag `/users/:id` explicitly in the writeup.' },
  { ch: 'research', from: 'scout-2', body: "`db.ts` opens one shared sqlite connection — no pooling. That's the latency spike under load." },
  { ch: 'research', from: 'scout', to: 'lead', body: 'Consolidated findings ready: validation gap + the pooling issue scout-2 found.' },
  { ch: 'general', from: 'lead', body: 'Research is landing. scribe — start `architecture.md` from the #research findings. critic — review as it goes.' },
  { ch: 'docs', from: 'lead', body: 'scribe, focus on the request lifecycle + the pooling issue scout-2 flagged.' },
  { ch: 'docs', from: 'scribe', body: 'Draft of `architecture.md` is up — covered the lifecycle and the pooling issue.' },
  { ch: 'docs', from: 'critic', to: 'scribe', body: 'Solid draft. The lifecycle is missing the auth middleware step. Add it and ship.' },
  { ch: 'docs', from: 'scribe', to: 'critic', body: 'Added the auth step. Thanks for the catch.' },
  { ch: 'docs', from: 'critic', body: 'Approved. Good to merge.' },
  { ch: 'general', from: 'lead', body: 'Docs approved, research wrapped. Nice work, team — merging `architecture.md`.' },
  { ch: 'general', from: 'scribe', body: 'Onward.' },
];

function toolPayload(result) {
  if (result && typeof result === 'object' && 'structuredContent' in result) {
    const sc = result.structuredContent;
    if (sc && typeof sc === 'object') return sc;
  }
  const content = result?.content;
  if (Array.isArray(content)) {
    const textPart = content.find((c) => c?.type === 'text' && typeof c.text === 'string');
    if (textPart) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return { text: textPart.text };
      }
    }
  }
  return result;
}

/** Read the bound MCP url from the running Loom's discovery advert (it scans
 *  upward from 7077, so the port is not fixed). Falls back to the default. */
async function readMcpUrl(root) {
  const advert = path.join(root, '.loom', 'mcp.json');
  for (let i = 0; i < 40; i++) {
    try {
      const j = JSON.parse(readFileSync(advert, 'utf8'));
      if (j && typeof j.url === 'string') return j.url;
    } catch {
      /* not written yet */
    }
    await sleep(100);
  }
  return 'http://127.0.0.1:7077/mcp';
}

function mkClient(name, url) {
  return {
    requested: name,
    name,
    client: new Client({ name: `loom-capture/${name}`, version: '0.11.0' }, { capabilities: {} }),
    transport: new StreamableHTTPClientTransport(new URL(url)),
  };
}
async function callTool(a, tool, args = {}) {
  const r = await a.client.callTool({ name: tool, arguments: args });
  if (r?.isError) throw new Error(`tool ${tool} failed for ${a.name}: ${JSON.stringify(toolPayload(r))}`);
  return toolPayload(r);
}

/** Replay the full audit session against the running Loom MCP server so the
 *  chat pane, receipts, and an inbox all carry real content. Returns the
 *  connected agents (left active for the screenshots) for the caller to close. */
async function replaySession(url) {
  let agents = AGENTS.map((n) => mkClient(n, url));
  let connected = false;
  for (let attempt = 1; attempt <= 30 && !connected; attempt++) {
    try {
      for (const a of agents) await a.client.connect(a.transport);
      connected = true;
    } catch (err) {
      await Promise.all(agents.map((a) => a.client.close().catch(() => undefined)));
      agents = AGENTS.map((n) => mkClient(n, url));
      if (attempt === 30) throw err;
      await sleep(500);
    }
  }
  const byReq = (n) => agents.find((a) => a.requested === n);

  for (const a of agents) {
    const res = await callTool(a, 'register', { name: a.requested });
    if (res && typeof res.name === 'string') a.name = res.name;
    await sleep(30);
  }
  for (const { name, members } of CHANNELS) {
    await callTool(byReq('lead'), 'create_channel', { name });
    for (const m of members) {
      if (m === 'lead') continue;
      await callTool(byReq(m), 'join_channel', { channel: name });
    }
    await sleep(30);
  }
  for (const step of TIMELINE) {
    const sender = byReq(step.from);
    const to = step.to ? byReq(step.to).name : HERE_TOKEN;
    await callTool(sender, 'send_message', { channel: step.ch, to, body: step.body });
    await sleep(60);
  }
  // Turn convention so some receipts flip delivered -> seen (lead + scout). For
  // scout we read but mark only PART read, so the inbox shows both new + read.
  for (const who of ['lead', 'scout']) {
    const a = byReq(who);
    await callTool(a, 'check_inbox', {});
    const unread = await callTool(a, 'read_messages', {});
    const ids = Array.isArray(unread)
      ? unread.map((m) => m?.message_id).filter((id) => typeof id === 'number')
      : [];
    const take = who === 'scout' ? ids.slice(0, Math.max(1, ids.length - 2)) : ids;
    if (take.length > 0) await callTool(a, 'mark_read', { message_ids: take });
  }
  return agents;
}

async function selectChannel(page, name) {
  const tab = page.locator('.channels button.chtab', { hasText: `#${name}` }).first();
  if ((await tab.count()) > 0) {
    await tab.click();
    await sleep(400);
  }
}

async function openInbox(page, agent) {
  const chip = page.locator('.roster .rchip', { hasText: agent }).first();
  if ((await chip.count()) > 0) {
    await chip.click();
    await page.waitForSelector('.inbox-head', { timeout: 10_000 }).catch(() => undefined);
    await sleep(400);
  }
}

/* ------------------------------------------------------------------ */
/* Shot groups                                                         */
/* ------------------------------------------------------------------ */
const want = new Set();
const wants = (name) => want.size === 0 || want.has(name) || want.has(tag(name));
function tag(filename) {
  const m = /^(\d{2})/.exec(filename);
  return m ? m[1] : filename;
}

/** LIVE-CHAT shots: one Electron + an MCP replay session.
 *  02-live-general, 03-research, 08-inbox, 10-live-e2e (#docs). */
async function captureChat() {
  const chatShots = ['02-live-general.png', '03-research.png', '08-inbox.png', '10-live-e2e.png'];
  if (!chatShots.some((n) => wants(n))) return;
  log('=== live-chat shots (MCP replay) ===');

  // The replay writes docs/architecture.md into the root, so use a temp copy of
  // acme-api (the tracked fixture is never mutated). Leaf name = acme-api so the
  // title bar reads cleanly.
  const root = acmeCopy();
  let app;
  let agents = [];
  try {
    const launched = await launch(root);
    app = launched.app;
    const page = launched.page;
    // Open README so the Viewer shows real content next to the live chat.
    await openFile(page, 'README.md');

    const url = await readMcpUrl(root);
    log(`  MCP url ${url}`);
    agents = await replaySession(url);
    log('  replay complete');
    await sleep(1500); // let the renderer fold all live events in

    if (wants('02-live-general.png')) {
      await selectChannel(page, 'general');
      await shot(page, '02-live-general.png');
    }
    if (wants('03-research.png')) {
      await selectChannel(page, 'research');
      await shot(page, '03-research.png');
    }
    if (wants('10-live-e2e.png')) {
      await selectChannel(page, 'docs');
      await shot(page, '10-live-e2e.png');
    }
    if (wants('08-inbox.png')) {
      await openInbox(page, 'scout');
      await shot(page, '08-inbox.png');
    }
  } catch (err) {
    log(`  !! chat shots failed: ${err?.message ?? err}`);
    for (const n of chatShots) {
      if (wants(n) && !DONE.includes(n)) SKIPPED.push(`${n} (chat replay error: ${err?.message ?? err})`);
    }
  } finally {
    await Promise.all(agents.map((a) => a.client.close().catch(() => undefined)));
    await dispose(app);
  }
}

/** GIT-rooted shots: Explorer git-status badges (13) + branch Changes view (14). */
async function captureGit() {
  if (!wants('13-explorer-wide.png') && !wants('14-changes-view.png')) return;
  log('=== git-rooted shots (badges + Changes view) ===');
  const root = makeGitAcme();

  if (wants('13-explorer-wide.png')) {
    await withApp(root, '13-explorer-wide.png', async (page) => {
      // Expand docs/ so the untracked findings.md "+" badge is visible too.
      await page.getByRole('treeitem', { name: 'docs folder' }).first().click();
      await sleep(400);
      await openFile(page, 'notes.txt');
      await shot(page, '13-explorer-wide.png');
    });
  }
  if (wants('14-changes-view.png')) {
    await withApp(root, '14-changes-view.png', async (page) => {
      // Open the branch Changes view (StatusBar Changes toggle).
      await page.locator('.statusbar button[aria-label="Changes"]').click();
      await page.waitForSelector('.pane.viewer.changes', { timeout: 10_000 });
      // Expand the modified file's diff.
      const modified = page.locator('.pane.viewer.changes button', { hasText: /notes\.txt/ }).first();
      if ((await modified.count()) > 0) {
        await modified.click();
        await sleep(400);
      }
      await shot(page, '14-changes-view.png');
    });
  }
}

/** STATIC shots (no chat, no git): viewer/explorer/terminal/etc. */
async function captureStatic() {
  log('=== static shots ===');

  if (wants('01-initial.png')) {
    await withApp(ACME, '01-initial.png', async (page) => {
      await openFile(page, 'README.md');
      await shot(page, '01-initial.png');
    });
  }
  if (wants('04-code-source.png')) {
    await withApp(ACME, '04-code-source.png', async (page) => {
      await openSource(page);
      await shot(page, '04-code-source.png');
    });
  }
  if (wants('05-svg-source.png')) {
    await withApp(ACME, '05-svg-source.png', async (page) => {
      await openFile(page, 'diagram.svg');
      await shot(page, '05-svg-source.png');
    });
  }
  // 06: a real PNG now RENDERS in-app (the new in-app image rendering).
  if (wants('06-image-preview.png')) {
    await withApp(ACME, '06-image-preview.png', async (page) => {
      await openFile(page, 'logo.png');
      await page.waitForSelector('.imgwrap img.img-preview', { timeout: 15_000 }).catch(() => undefined);
      await shot(page, '06-image-preview.png');
    });
  }
  if (wants('07-binary-noprev.png')) {
    await withApp(ACME, '07-binary-noprev.png', async (page) => {
      await openFile(page, 'data.bin');
      await shot(page, '07-binary-noprev.png');
    });
  }
  if (wants('09-light-theme.png')) {
    await withApp(ACME, '09-light-theme.png', async (page) => {
      await openFile(page, 'README.md');
      await setTheme(page, 'light');
      await shot(page, '09-light-theme.png');
    });
  }

  // 11: reading-width FULL (new toggle) ; 12: reading-width FIT (default).
  if (wants('11-chat-wide.png')) {
    await withApp(ACME, '11-chat-wide.png', async (page) => {
      await openFile(page, 'README.md');
      await page.locator('.reading-width-btn').first().click();
      await page.waitForSelector('.viewer[data-mdwidth="full"]', { timeout: 10_000 }).catch(() => undefined);
      await shot(page, '11-chat-wide.png');
    });
  }
  if (wants('12-chat-narrow.png')) {
    await withApp(ACME, '12-chat-narrow.png', async (page) => {
      await openFile(page, 'README.md');
      await shot(page, '12-chat-narrow.png');
    });
  }

  // 15/16/17: explorer hidden / chat hidden / both hidden.
  if (wants('15-explorer-hidden.png')) {
    await withApp(ACME, '15-explorer-hidden.png', async (page) => {
      await openFile(page, 'README.md');
      await page.locator('.statusbar button[aria-label="File explorer"]').click();
      await shot(page, '15-explorer-hidden.png');
    });
  }
  if (wants('16-chat-hidden.png')) {
    await withApp(ACME, '16-chat-hidden.png', async (page) => {
      await openFile(page, 'README.md');
      await page.locator('.statusbar button[aria-label="Agent chat"]').click();
      await shot(page, '16-chat-hidden.png');
    });
  }
  if (wants('17-both-hidden.png')) {
    await withApp(ACME, '17-both-hidden.png', async (page) => {
      await openFile(page, 'README.md');
      await page.locator('.statusbar button[aria-label="File explorer"]').click();
      await page.locator('.statusbar button[aria-label="Agent chat"]').click();
      await shot(page, '17-both-hidden.png');
    });
  }

  // 18: the human terminal dock (NEW) ; 19: the split viewer / file-diff (NEW).
  if (wants('18-terminal.png')) {
    await withApp(ACME, '18-terminal.png', async (page) => {
      await openFile(page, 'README.md');
      await openTerminal(page);
      await runInTerminal(page, 'echo "loom — a real human shell, never reachable by agents"');
      await runInTerminal(page, 'ls -1');
      await shot(page, '18-terminal.png');
    });
  }
  if (wants('19-split-viewer.png')) {
    await withApp(ACME, '19-split-viewer.png', async (page) => {
      await openFile(page, 'README.md');
      await page.locator('.split-view-btn').first().click();
      await page
        .waitForSelector('.viewer-split-wrap:not(.viewer-split-wrap--solo)', { timeout: 10_000 })
        .catch(() => undefined);
      // Open a second file into the now-active split pane.
      await page.getByRole('treeitem', { name: 'package.json' }).first().click();
      await sleep(600);
      await shot(page, '19-split-viewer.png');
    });
  }

  // 20-23: source folds — unfolded vs folded, dark + light.
  if (wants('20-code-folds.png')) {
    await withApp(ACME, '20-code-folds.png', async (page) => {
      await openSource(page);
      await shot(page, '20-code-folds.png');
    });
  }
  if (wants('21-code-folded.png')) {
    await withApp(ACME, '21-code-folded.png', async (page) => {
      await openSource(page);
      await foldAll(page);
      await shot(page, '21-code-folded.png');
    });
  }
  if (wants('22-code-folds-light.png')) {
    await withApp(ACME, '22-code-folds-light.png', async (page) => {
      await openSource(page);
      await setTheme(page, 'light');
      await shot(page, '22-code-folds-light.png');
    });
  }
  if (wants('23-code-folded-light.png')) {
    await withApp(ACME, '23-code-folded-light.png', async (page) => {
      await openSource(page);
      await setTheme(page, 'light');
      await foldAll(page);
      await shot(page, '23-code-folded-light.png');
    });
  }

  // 24/25: the Shortcuts panel (mouse-bindable shortcuts), dark + light.
  if (wants('24-shortcuts-panel.png')) {
    await withApp(ACME, '24-shortcuts-panel.png', async (page) => {
      await openShortcuts(page);
      await shot(page, '24-shortcuts-panel.png');
    });
  }
  if (wants('25-shortcuts-panel-light.png')) {
    await withApp(ACME, '25-shortcuts-panel-light.png', async (page) => {
      await setTheme(page, 'light');
      await openShortcuts(page);
      await shot(page, '25-shortcuts-panel-light.png');
    });
  }

  // 26/27: content search ; 28/29: filename search.
  if (wants('26-search-results.png')) {
    await withApp(ACME, '26-search-results.png', async (page) => {
      await runSearch(page, 'pooling');
      await shot(page, '26-search-results.png');
    });
  }
  if (wants('27-search-open.png')) {
    await withApp(ACME, '27-search-open.png', async (page) => {
      await runSearch(page, 'validation');
      await openFirstSearchResult(page);
      await shot(page, '27-search-open.png');
    });
  }
  if (wants('28-search-files.png')) {
    await withApp(ACME, '28-search-files.png', async (page) => {
      await runSearch(page, 'README');
      await shot(page, '28-search-files.png');
    });
  }
  if (wants('29-search-filename.png')) {
    await withApp(ACME, '29-search-filename.png', async (page) => {
      await runSearch(page, 'diagram');
      await shot(page, '29-search-filename.png');
    });
  }

  // 30: the title bar (native Linux frame) with a file open.
  if (wants('30-titlebar-linux.png')) {
    await withApp(ACME, '30-titlebar-linux.png', async (page) => {
      await openFile(page, 'README.md');
      await shot(page, '30-titlebar-linux.png');
    });
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  if (!existsSync(MAIN_ENTRY)) {
    log(`dist/main.cjs missing at ${MAIN_ENTRY} — run \`npm run build\` first.`);
    process.exit(1);
  }
  mkdirSync(ARTIFACTS, { recursive: true });

  for (const a of process.argv.slice(2).filter((x) => !x.startsWith('-'))) {
    want.add(/^\d{1,2}$/.test(a) ? a.padStart(2, '0') : a);
  }
  if (want.size > 0) log(`subset: ${[...want].join(', ')}`);

  await captureChat();
  await captureGit();
  await captureStatic();

  log(`\nDONE (${DONE.length}): ${[...DONE].sort().join(', ')}`);
  if (SKIPPED.length) log(`SKIPPED (${SKIPPED.length}):\n  - ${SKIPPED.join('\n  - ')}`);

  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  log(`FATAL: ${err?.stack ?? err}`);
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
  process.exit(1);
});
