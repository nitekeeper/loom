/* ============================================================
 * Loom — esbuild build script
 * ------------------------------------------------------------
 * Produces dist/ with three bundles + runtime assets:
 *
 *   dist/main.cjs        main process     (format=cjs,  platform=node)
 *   dist/preload.cjs     preload bridge   (format=cjs,  platform=node)
 *   dist/renderer.js     React UI bundle  (format=iife, platform=browser)
 *   dist/renderer.css    bundled styles
 *   dist/index.html      copied shell
 *   dist/schema.sql      copied DDL (loaded by main at runtime)
 *   dist/sql-wasm.wasm   sql.js WASM binary (loaded by main at runtime)
 *
 * RUNTIME ASSET LOCATION:
 *   main.cjs resolves schema.sql and sql-wasm.wasm relative to its
 *   own __dirname (i.e. dist/). sql.js is initialized via
 *   initSqlJs({ locateFile: () => path.join(__dirname, 'sql-wasm.wasm') }).
 *   So both files MUST sit beside main.cjs in dist/ — this script
 *   copies them there. index.html loads ./renderer.js + ./renderer.css
 *   (relative), so the renderer bundle must sit beside index.html.
 *
 * MODULE STRATEGY (must match tsconfig + CONTRACTS.md):
 *   - Author everything as ESM .ts/.tsx.
 *   - 'electron' is marked EXTERNAL in every bundle (Electron provides it).
 *   - Everything else (react, markdown-it, @modelcontextprotocol/sdk,
 *     chokidar, ws, sql.js JS glue) is BUNDLED.
 *   - sql.js's .wasm is NOT bundled — it is copied and located at runtime.
 * ============================================================ */

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DIST = path.join(__dirname, 'dist');
const watch = process.argv.includes('--watch');

async function clean() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
}

/** Locate the sql.js wasm binary inside node_modules.
 *  sql.js's package "exports" map does NOT expose ./package.json, so we
 *  resolve the package's main entry (dist/sql-wasm.js) and take its dir. */
function sqlWasmPath() {
  const entry = require.resolve('sql.js'); // -> node_modules/sql.js/dist/sql-wasm.js
  return path.join(path.dirname(entry), 'sql-wasm.wasm');
}

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const mainBuild = {
  ...common,
  entryPoints: [path.join(__dirname, 'src/main/main.ts')],
  outfile: path.join(DIST, 'main.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Electron is provided by the runtime; never bundle it.
  // sql.js JS glue is bundled; its .wasm is copied + located at runtime.
  external: ['electron'],
};

const preloadBuild = {
  ...common,
  entryPoints: [path.join(__dirname, 'src/preload/preload.ts')],
  outfile: path.join(DIST, 'preload.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
};

const rendererBuild = {
  ...common,
  entryPoints: [path.join(__dirname, 'src/renderer/index.tsx')],
  outfile: path.join(DIST, 'renderer.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  // React et al. are bundled into the IIFE. No node builtins here.
  loader: { '.css': 'css' },
};

// Electron-free CJS bundle the acceptance suite requires (db + engine +
// eventbus + dispatch). It sits in dist/ so db.ts locates sql-wasm.wasm and
// schema.sql via __dirname, exactly like main.cjs does.
const testkitBuild = {
  ...common,
  entryPoints: [path.join(__dirname, 'src/testkit-entry.ts')],
  outfile: path.join(DIST, 'testkit.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
};

async function copyAssets() {
  // Schema + wasm beside main.cjs; html beside renderer.js.
  await cp(path.join(__dirname, 'src/main/schema.sql'), path.join(DIST, 'schema.sql'));
  const wasm = sqlWasmPath();
  if (existsSync(wasm)) {
    await cp(wasm, path.join(DIST, 'sql-wasm.wasm'));
  } else {
    console.warn('[build] WARNING: sql.js wasm not found at', wasm, '(run npm install)');
  }
  await cp(path.join(__dirname, 'src/renderer/index.html'), path.join(DIST, 'index.html'));
}

async function run() {
  await clean();
  await Promise.all([
    build(mainBuild),
    build(preloadBuild),
    build(rendererBuild),
    build(testkitBuild),
  ]);
  await copyAssets();
  console.log('[build] done ->', DIST);
}

run().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});

void watch; // reserved: a later phase may add esbuild context() watch mode.
