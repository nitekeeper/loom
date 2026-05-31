#!/usr/bin/env node
/* ============================================================
 * Loom — `loom .` launcher (FR-1)
 * ------------------------------------------------------------
 * Resolves the sandbox root from argv[2] (default '.'), exports it
 * via LOOM_ROOT, then spawns Electron with the built main bundle.
 * Any remaining args (e.g. --capture <out.png> --select <path>
 * --channel <name> --inbox <agent> --replay) are passed through to
 * the Electron main process unchanged. Child stdio is inherited and
 * this launcher exits with the child's exit code.
 * ============================================================ */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// argv[2] is the target folder (default '.'); everything after is passed on.
const rawRoot = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : '.';
const passthroughStart = rawRoot === process.argv[2] ? 3 : 2;
const passthrough = process.argv.slice(passthroughStart);

const root = path.resolve(rawRoot);

// The project root holds package.json + dist/main.cjs (bin/ is one level down).
const projectRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(projectRoot, 'dist', 'main.cjs');

// require('electron') resolves to the Electron executable path (a string).
const electronBin = require('electron');

const child = spawn(electronBin, [mainEntry, ...passthrough], {
  stdio: 'inherit',
  cwd: projectRoot,
  env: {
    ...process.env,
    LOOM_ROOT: root,
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});

child.on('error', (err) => {
  process.stderr.write(`[loom] failed to launch Electron: ${err.message}\n`);
  process.exit(1);
});
