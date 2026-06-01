#!/usr/bin/env node
/* ============================================================
 * Loom — Windows portable build packer (Wine-free, cross-built)
 * ------------------------------------------------------------
 * Assembles a runnable Windows portable build of Loom by combining:
 *   - the esbuild output (dist/),
 *   - a PRODUCTION node_modules (npm ci --omit=dev) so the runtime
 *     dynamic require()s in dist/main.cjs resolve on Windows:
 *       * ajv + ajv-formats        (via @modelcontextprotocol/sdk)
 *       * bufferutil/utf-8-validate (optional ws addons — PRUNED, see below)
 *   - the win32-x64 prebuilt Electron runtime (downloaded + cached).
 *
 * The result is release/Loom-win32-x64/ (a directory you can copy to a
 * Windows PC and run Loom.exe), plus release/Loom-win32-x64.zip.
 *
 * WHY A PRODUCTION node_modules: build.mjs marks ONLY 'electron' external,
 * but dist/main.cjs still issues bare runtime require()s for ajv/ajv-formats
 * (pulled in dynamically by the MCP SDK's JSON-schema validation) and the
 * optional ws addons. Those bare specifiers must resolve from
 * resources/app/node_modules at runtime.
 *
 * WHY PRUNE bufferutil/utf-8-validate: they are OPTIONAL native addons of
 * `ws` (loaded in a try/catch; ws degrades to pure JS without them). If npm
 * installed them on THIS Linux box they would carry Linux-built .node
 * binaries that are useless — and potentially confusing — on Windows. We
 * delete them so the payload is Linux-binary-free; ws still works.
 *
 * WINE-FREE: this never runs any Windows executable. It only downloads the
 * official electron-v<ver>-win32-x64.zip, unzips it, swaps in our app
 * payload, and renames electron.exe -> Loom.exe. exe-icon / version-metadata
 * branding needs rcedit (which needs Wine) and is intentionally SKIPPED.
 *
 * VERIFICATION CAVEAT: this build CANNOT be executed here (no Windows, no
 * Wine). It is correct-by-construction and structurally verified (file
 * presence + zip listing); it is UNVERIFIED on real Windows — smoke-test it
 * on a Windows PC before relying on it.
 * ============================================================ */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  renameSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// --- Constants ----------------------------------------------------------
const ELECTRON_VERSION = '33.4.11'; // MUST match package.json devDependency.
const ELECTRON_ZIP = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
const ELECTRON_URL = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ELECTRON_ZIP}`;
const MIN_ELECTRON_ZIP_BYTES = 50 * 1024 * 1024; // sanity floor: > 50MB.

const CACHE_DIR = path.join(os.homedir(), '.cache', 'loom-pack');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
const STAGING_DIR = path.join(RELEASE_DIR, '.staging-deps');
const APP_PAYLOAD_DIR = path.join(RELEASE_DIR, 'app');
const BUILD_NAME = 'Loom-win32-x64';
const BUILD_DIR = path.join(RELEASE_DIR, BUILD_NAME);
const FINAL_ZIP = path.join(RELEASE_DIR, `${BUILD_NAME}.zip`);

// Optional ws native addons: PRUNE so no Linux .node ships.
const PRUNE_OPTIONAL_NATIVE = ['bufferutil', 'utf-8-validate'];

// --- Logging helpers ----------------------------------------------------
let step = 0;
function log(msg) {
  process.stdout.write(`[pack-win] ${msg}\n`);
}
function stepLog(msg) {
  step += 1;
  process.stdout.write(`\n[pack-win] ===== STEP ${step}: ${msg} =====\n`);
}
function fail(msg) {
  process.stderr.write(`\n[pack-win] FATAL: ${msg}\n`);
  process.exit(1);
}

/** Run a command, inheriting stdio, and FAIL LOUDLY on non-zero exit. */
function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}${opts.cwd ? `   (cwd: ${opts.cwd})` : ''}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) fail(`${cmd} failed to spawn: ${res.error.message}`);
  if (typeof res.status === 'number' && res.status !== 0) {
    fail(`${cmd} ${args.join(' ')} exited with code ${res.status}`);
  }
  if (res.signal) fail(`${cmd} ${args.join(' ')} killed by signal ${res.signal}`);
  return res;
}

function humanSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function assertExists(p, what) {
  if (!existsSync(p)) fail(`expected ${what} at ${p} but it is missing`);
}

// ========================================================================
// STEP 1 — Ensure dist/ is freshly built.
// ========================================================================
function buildDist() {
  stepLog('Build dist/ (npm run build)');
  run('npm', ['run', 'build'], { cwd: PROJECT_ROOT });
  // The runtime assets that MUST sit beside main.cjs.
  for (const f of ['main.cjs', 'preload.cjs', 'renderer.js', 'index.html', 'schema.sql', 'sql-wasm.wasm']) {
    assertExists(path.join(PROJECT_ROOT, 'dist', f), `dist/${f}`);
  }
  log('dist/ built and required assets present.');
}

// ========================================================================
// STEP 2 — Stage PRODUCTION deps (npm ci --omit=dev) in a temp dir.
// ========================================================================
function stageProdDeps() {
  stepLog('Stage production node_modules (npm ci --omit=dev)');
  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });

  // Copy the lockfile + package.json so `npm ci` reproduces EXACTLY the
  // production dependency tree (ci requires a lockfile + package.json).
  assertExists(path.join(PROJECT_ROOT, 'package.json'), 'package.json');
  assertExists(path.join(PROJECT_ROOT, 'package-lock.json'), 'package-lock.json');
  cpSync(path.join(PROJECT_ROOT, 'package.json'), path.join(STAGING_DIR, 'package.json'));
  cpSync(path.join(PROJECT_ROOT, 'package-lock.json'), path.join(STAGING_DIR, 'package-lock.json'));

  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: STAGING_DIR });

  const stagedModules = path.join(STAGING_DIR, 'node_modules');
  assertExists(stagedModules, 'staged node_modules');
  // Spot-check the runtime-required deps landed.
  for (const dep of ['ajv', 'ajv-formats', '@modelcontextprotocol/sdk', 'ws', 'sql.js', 'chokidar']) {
    assertExists(path.join(stagedModules, dep), `staged node_modules/${dep}`);
  }
  log('Production node_modules staged with runtime deps present.');
  return stagedModules;
}

// ========================================================================
// STEP 3 — Assemble the app payload at release/app/.
// ========================================================================
function buildAppPayload(stagedModules) {
  stepLog('Build app payload (release/app/)');
  rmSync(APP_PAYLOAD_DIR, { recursive: true, force: true });
  mkdirSync(APP_PAYLOAD_DIR, { recursive: true });

  // Trimmed production package.json. main MUST stay dist/main.cjs, type
  // commonjs (matches the source package.json + how main.cjs is authored).
  const realPkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const trimmedPkg = {
    name: 'loom',
    productName: 'Loom',
    version: realPkg.version,
    main: 'dist/main.cjs',
    type: 'commonjs',
  };
  writeFileSync(
    path.join(APP_PAYLOAD_DIR, 'package.json'),
    `${JSON.stringify(trimmedPkg, null, 2)}\n`,
  );
  log(`Wrote trimmed package.json (version ${trimmedPkg.version}, main ${trimmedPkg.main}).`);

  // Copy dist/ -> release/app/dist/ (exclude sourcemaps to keep payload lean).
  const srcDist = path.join(PROJECT_ROOT, 'dist');
  const dstDist = path.join(APP_PAYLOAD_DIR, 'dist');
  cpSync(srcDist, dstDist, {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
  });
  log('Copied dist/ -> release/app/dist/ (excluding .map sourcemaps).');

  // Copy staged node_modules -> release/app/node_modules/.
  const dstModules = path.join(APP_PAYLOAD_DIR, 'node_modules');
  cpSync(stagedModules, dstModules, { recursive: true });
  log('Copied staged node_modules -> release/app/node_modules/.');

  // PRUNE optional native addons that would ship Linux .node files.
  for (const mod of PRUNE_OPTIONAL_NATIVE) {
    const p = path.join(dstModules, mod);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      log(`Pruned optional native addon: node_modules/${mod}`);
    } else {
      log(`Optional native addon not present (ok): node_modules/${mod}`);
    }
  }

  // Defensive sweep: delete any remaining prebuilt *.node addons (none should
  // exist) and LOUDLY log if any survive — a Linux .node on Windows is a bug.
  const strayNodes = findNodeAddons(dstModules);
  if (strayNodes.length > 0) {
    for (const n of strayNodes) {
      rmSync(n, { force: true });
      log(`WARNING: removed stray native addon (Linux binary, useless on Windows): ${path.relative(APP_PAYLOAD_DIR, n)}`);
    }
  } else {
    log('No stray *.node native addons in payload (good).');
  }
}

/** Recursively collect every *.node file under `dir`. */
function findNodeAddons(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.node')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// ========================================================================
// STEP 4 — Download + cache the win32-x64 Electron prebuilt, then extract.
// ========================================================================
function fetchAndExtractElectron() {
  stepLog('Download + extract win32-x64 Electron runtime');
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachedZip = path.join(CACHE_DIR, ELECTRON_ZIP);

  const cachedOk = existsSync(cachedZip) && statSync(cachedZip).size > MIN_ELECTRON_ZIP_BYTES;
  if (cachedOk) {
    log(`Using cached Electron zip: ${cachedZip} (${humanSize(statSync(cachedZip).size)}).`);
  } else {
    if (existsSync(cachedZip)) {
      log('Cached Electron zip too small / corrupt — re-downloading.');
      rmSync(cachedZip, { force: true });
    }
    log(`Downloading ${ELECTRON_URL}`);
    // -L follows the GitHub 302 redirect to the asset CDN; -f fails on HTTP
    // errors (so a 404 is a hard failure, not a saved error page).
    run('curl', ['-Lf', '--retry', '3', '-o', cachedZip, ELECTRON_URL]);
    if (!existsSync(cachedZip) || statSync(cachedZip).size <= MIN_ELECTRON_ZIP_BYTES) {
      fail(
        `downloaded Electron zip is missing or too small (< ${humanSize(MIN_ELECTRON_ZIP_BYTES)}); got ${
          existsSync(cachedZip) ? humanSize(statSync(cachedZip).size) : 'nothing'
        }`,
      );
    }
    log(`Downloaded + cached: ${cachedZip} (${humanSize(statSync(cachedZip).size)}).`);
  }

  // Extract fresh into release/Loom-win32-x64/.
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });
  // -q quiet, -o overwrite.
  run('unzip', ['-q', '-o', cachedZip, '-d', BUILD_DIR]);

  assertExists(path.join(BUILD_DIR, 'electron.exe'), 'extracted electron.exe');
  assertExists(path.join(BUILD_DIR, 'resources'), 'extracted resources/ dir');
  log('Extracted Electron runtime into release/Loom-win32-x64/.');
}

// ========================================================================
// STEP 5 — Assemble: swap default_app.asar -> our app; rename to Loom.exe.
// ========================================================================
function assembleBuild() {
  stepLog('Assemble final build (app payload + Loom.exe)');
  const resourcesDir = path.join(BUILD_DIR, 'resources');

  // Remove the stock default_app.asar so Electron loads OUR resources/app.
  const defaultAsar = path.join(resourcesDir, 'default_app.asar');
  if (existsSync(defaultAsar)) {
    rmSync(defaultAsar, { force: true });
    log('Removed resources/default_app.asar.');
  } else {
    log('resources/default_app.asar not present (ok).');
  }

  // Move release/app/ -> release/Loom-win32-x64/resources/app/.
  const destApp = path.join(resourcesDir, 'app');
  rmSync(destApp, { recursive: true, force: true });
  renameSync(APP_PAYLOAD_DIR, destApp);
  log('Moved app payload -> resources/app/.');
  assertExists(path.join(destApp, 'dist', 'main.cjs'), 'resources/app/dist/main.cjs');
  assertExists(path.join(destApp, 'package.json'), 'resources/app/package.json');

  // Rename electron.exe -> Loom.exe (Electron loads resources/app by exe-name
  // independence; the renamed exe still finds resources/ beside it).
  const electronExe = path.join(BUILD_DIR, 'electron.exe');
  const loomExe = path.join(BUILD_DIR, 'Loom.exe');
  assertExists(electronExe, 'electron.exe (pre-rename)');
  renameSync(electronExe, loomExe);
  log('Renamed electron.exe -> Loom.exe.');

  // Branding note: exe icon + version metadata need rcedit (Wine). SKIPPED.
  log('NOTE: exe icon / version-metadata branding SKIPPED (needs rcedit/Wine); default Electron icon shipped.');

  // Tidy: remove the staging dir (the cache is intentionally preserved).
  rmSync(STAGING_DIR, { recursive: true, force: true });
}

// ========================================================================
// STEP 6 — Zip the build directory.
// ========================================================================
function zipBuild() {
  stepLog('Zip the portable build');
  rmSync(FINAL_ZIP, { force: true });
  // zip relative to release/ so the archive root is Loom-win32-x64/.
  run('zip', ['-r', '-q', `${BUILD_NAME}.zip`, `${BUILD_NAME}/`], { cwd: RELEASE_DIR });
  assertExists(FINAL_ZIP, 'final zip');
  log(`Created ${FINAL_ZIP} (${humanSize(statSync(FINAL_ZIP).size)}).`);
}

// ========================================================================
// Summary tree.
// ========================================================================
function printSummary() {
  stepLog('Summary');
  const zipSize = statSync(FINAL_ZIP).size;
  process.stdout.write('\n');
  log(`ARTIFACT: ${FINAL_ZIP}`);
  log(`SIZE:     ${humanSize(zipSize)} (${zipSize} bytes)`);

  const listDir = (dir, label, limit = 40) => {
    process.stdout.write(`\n[pack-win] ${label}:\n`);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      process.stdout.write('  (unreadable)\n');
      return;
    }
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .forEach((e) => {
        process.stdout.write(`  ${e.isDirectory() ? 'd' : '-'} ${e.name}\n`);
      });
    if (entries.length > limit) process.stdout.write(`  … (${entries.length - limit} more)\n`);
  };

  listDir(BUILD_DIR, 'Top of Loom-win32-x64/');
  listDir(path.join(BUILD_DIR, 'resources', 'app'), 'resources/app/');
  listDir(path.join(BUILD_DIR, 'resources', 'app', 'dist'), 'resources/app/dist/');

  process.stdout.write('\n[pack-win] DONE. (Cross-built on Linux; UNVERIFIED on Windows — smoke-test before relying on it.)\n');
}

// ========================================================================
// Main.
// ========================================================================
function main() {
  log(`Loom Windows portable packer — Electron v${ELECTRON_VERSION} (win32-x64).`);
  log(`Project root: ${PROJECT_ROOT}`);
  mkdirSync(RELEASE_DIR, { recursive: true });

  buildDist();
  const stagedModules = stageProdDeps();
  buildAppPayload(stagedModules);
  fetchAndExtractElectron();
  assembleBuild();
  zipBuild();
  printSummary();
}

main();
