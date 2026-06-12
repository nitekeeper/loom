/* ============================================================
 * Loom — terminal-pane helpers unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE renderer-side terminal-dock logic: the height clamp
 * (min 120px, max 80% of the body, degenerate-body pin) behind the
 * RowSplitter, and the rebindable `toggleTerminal` keyboard command
 * (default Ctrl/Cmd+`). DOM-free: exercises terminal-pane.ts +
 * keybindings.ts from the testkit bundle.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TESTKIT = path.join(root, 'dist', 'testkit.cjs');

let _kit = null;
async function kit() {
  if (_kit) return _kit;
  if (!existsSync(TESTKIT)) {
    throw new Error(`dist/testkit.cjs not found at ${TESTKIT} — run \`npm run build\` first.`);
  }
  _kit = await import(TESTKIT);
  return _kit;
}

test('TERM-HEIGHT: clampTerminalHeight clamps into [120 .. 0.8*bodyHeight]', async () => {
  const { clampTerminalHeight } = await kit();
  assert.equal(clampTerminalHeight(40, 1000), 120, 'below the floor pins to 120');
  assert.equal(clampTerminalHeight(5000, 1000), 800, 'above the ceiling pins to 0.8*body');
  assert.equal(clampTerminalHeight(300, 1000), 300, 'in-range value passes through');
});

test('TERM-HEIGHT: degenerate body (max < min) pins to min', async () => {
  const { clampTerminalHeight } = await kit();
  // 0.8 * 100 = 80 < 120 — the floor wins so the pane stays usable.
  assert.equal(clampTerminalHeight(200, 100), 120);
});

test('TERM-HEIGHT: constants carry the documented dock geometry', async () => {
  const {
    TERMINAL_MIN_HEIGHT,
    TERMINAL_MAX_FRACTION,
    TERMINAL_DEFAULT_HEIGHT,
    TERMINAL_HEIGHT_STEP,
    TERMINAL_HEIGHT_KEY,
    TERMINAL_OPEN_KEY,
    terminalHeightMax,
  } = await kit();
  assert.equal(TERMINAL_MIN_HEIGHT, 120);
  assert.equal(TERMINAL_MAX_FRACTION, 0.8);
  assert.equal(TERMINAL_DEFAULT_HEIGHT, 240);
  assert.equal(TERMINAL_HEIGHT_STEP, 24);
  assert.equal(TERMINAL_HEIGHT_KEY, 'loom-terminal-height');
  assert.equal(TERMINAL_OPEN_KEY, 'loom-terminal-open');
  assert.equal(terminalHeightMax(1000), 800, 'max is 80% of the body height');
});

test('TERM-KB: toggleTerminal command exists with default Ctrl+`', async () => {
  const { COMMANDS, resolveBindings, eventToCombo } = await kit();
  const spec = COMMANDS.find((c) => c.id === 'toggleTerminal');
  assert.ok(spec, 'a toggleTerminal command is registered');
  assert.equal(spec.label, 'Toggle terminal', 'label matches the design');
  assert.equal(spec.defaultBinding, 'Ctrl+`', 'default binding is Ctrl/Cmd+`');
  assert.equal(
    resolveBindings(undefined).toggleTerminal,
    'Ctrl+`',
    'resolved default carries the combo',
  );
  // The backtick keypress canonicalizes to the default binding.
  assert.equal(
    eventToCombo({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: '`' }),
    'Ctrl+`',
  );
});
