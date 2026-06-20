/* ============================================================
 * Loom — mouse-combo keybindings unit suite (node --test)
 * ------------------------------------------------------------
 * Pins the PURE mouse-combo core added to keybindings.ts (FR-54 mouse
 * bindings): mouseEventToCombo (all buttons x modifier permutations,
 * Cmd==Ctrl collapse, unknown button -> ''), the MOUSE_KEYS / isMouseCombo
 * surface, isValidKeyToken / isValidBinding acceptance of the mouse tokens,
 * the bindingAllowedFor >=1-modifier-for-mouse rule, resolveBindings +
 * diffOverrides round-trip of a mouse combo, formatCombo display, the
 * goToDefinition REBINDABLE-default flip to 'Ctrl+Click' (with F12 still an
 * allowed rebind target + not platform-critical), and isPositionalCommand.
 *
 * It also pins TWO pure DECISION helpers IMPORTED from the production module
 * (src/renderer/lib/mouse-dispatch.ts) — the SAME functions the App document-
 * mouse-dispatcher AND the Viewer onCodeClick now CALL — so the dispatch
 * contract is unit-testable without a DOM and the test pins the LIVE logic
 * (not a hand-kept mirror that could silently drift):
 *   - mouseEventDispatchButton(type, button): the SINGLE-SOURCE right-button
 *     routing rule (auxclick owns MIDDLE only / contextmenu owns RIGHT /
 *     click owns PRIMARY) — proves a right-button gesture dispatches EXACTLY
 *     ONCE (via contextmenu), never twice (auxclick + contextmenu).
 *   - shouldFireMouseCommand(facts): the positional-skip / closeFile-skip /
 *     editable-suppression / defaultPrevented-bail decision.
 * Because the App + Viewer dispatchers consume these exact exports, any drift
 * in the dispatcher would break the build/tests (the definition-dispatch idiom).
 *
 * DOM-free: exercises the testkit re-exports only (no jsdom).
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

/* ------------------------------------------------------------------ */
/* mouseEventToCombo — buttons x modifiers, Cmd==Ctrl, unknown button   */
/* ------------------------------------------------------------------ */

const NOMOD = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

test('MOUSE: mouseEventToCombo maps the three buttons to their canonical tokens', async () => {
  const { mouseEventToCombo } = await kit();
  // Each button with a single Ctrl modifier (a bare button is structurally
  // possible but disallowed per-command; tokens themselves are pinned here).
  assert.equal(mouseEventToCombo({ ...NOMOD, ctrlKey: true, button: 0 }), 'Ctrl+Click');
  assert.equal(mouseEventToCombo({ ...NOMOD, ctrlKey: true, button: 1 }), 'Ctrl+MiddleClick');
  assert.equal(mouseEventToCombo({ ...NOMOD, ctrlKey: true, button: 2 }), 'Ctrl+RightClick');
  // A bare button (no modifier) yields just the token.
  assert.equal(mouseEventToCombo({ ...NOMOD, button: 0 }), 'Click');
  assert.equal(mouseEventToCombo({ ...NOMOD, button: 1 }), 'MiddleClick');
  assert.equal(mouseEventToCombo({ ...NOMOD, button: 2 }), 'RightClick');
});

test('MOUSE: modifier order is Ctrl, then Alt, then Shift, then the click token', async () => {
  const { mouseEventToCombo } = await kit();
  assert.equal(
    mouseEventToCombo({ ctrlKey: false, metaKey: false, altKey: true, shiftKey: true, button: 2 }),
    'Alt+Shift+RightClick',
  );
  assert.equal(
    mouseEventToCombo({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, button: 1 }),
    'Ctrl+Shift+MiddleClick',
  );
  assert.equal(
    mouseEventToCombo({ ctrlKey: true, metaKey: false, altKey: true, shiftKey: true, button: 0 }),
    'Ctrl+Alt+Shift+Click',
  );
});

test('MOUSE: Cmd collapses to Ctrl (metaKey === ctrlKey for the prefix)', async () => {
  const { mouseEventToCombo } = await kit();
  assert.equal(
    mouseEventToCombo({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, button: 0 }),
    'Ctrl+Click',
  );
  // Both flags set still collapses to a single Ctrl.
  assert.equal(
    mouseEventToCombo({ ctrlKey: true, metaKey: true, altKey: false, shiftKey: false, button: 0 }),
    'Ctrl+Click',
  );
});

test('MOUSE: an unknown button yields "" (which isValidBinding rejects)', async () => {
  const { mouseEventToCombo, isValidBinding } = await kit();
  assert.equal(mouseEventToCombo({ ...NOMOD, ctrlKey: true, button: 3 }), '');
  assert.equal(mouseEventToCombo({ ...NOMOD, ctrlKey: true, button: -1 }), '');
  assert.equal(isValidBinding(''), false, 'an empty combo is never a valid binding');
});

/* ------------------------------------------------------------------ */
/* MOUSE_KEYS + isMouseCombo + isValidKeyToken                          */
/* ------------------------------------------------------------------ */

test('MOUSE: MOUSE_KEYS holds exactly the three canonical tokens', async () => {
  const { MOUSE_KEYS } = await kit();
  assert.ok(MOUSE_KEYS.has('Click'));
  assert.ok(MOUSE_KEYS.has('MiddleClick'));
  assert.ok(MOUSE_KEYS.has('RightClick'));
  assert.equal(MOUSE_KEYS.size, 3, 'no extra mouse tokens');
});

test('MOUSE: isMouseCombo detects a mouse final token (and rejects key combos)', async () => {
  const { isMouseCombo } = await kit();
  assert.equal(isMouseCombo('Ctrl+Click'), true);
  assert.equal(isMouseCombo('Alt+Shift+RightClick'), true);
  assert.equal(isMouseCombo('Ctrl+MiddleClick'), true);
  assert.equal(isMouseCombo('Click'), true, 'a bare mouse token is still a mouse combo');
  assert.equal(isMouseCombo('F12'), false);
  assert.equal(isMouseCombo('Ctrl+K'), false);
  assert.equal(isMouseCombo(''), false);
});

test('MOUSE: isValidBinding accepts mouse-token combos but enforces prefix order', async () => {
  const { isValidBinding } = await kit();
  // Valid: modifier(s) then a mouse token in the final position.
  assert.equal(isValidBinding('Ctrl+Click'), true);
  assert.equal(isValidBinding('Alt+Shift+RightClick'), true);
  assert.equal(isValidBinding('Ctrl+Shift+MiddleClick'), true);
  // A bare 'Click' is STRUCTURALLY valid (rejected per-command below, not here).
  assert.equal(isValidBinding('Click'), true, 'bare Click is structurally valid');
  // Out-of-order / token-not-final / repeated -> structurally invalid.
  assert.equal(isValidBinding('Click+Ctrl'), false, 'mouse token must be final');
  assert.equal(isValidBinding('Shift+Ctrl+Click'), false, 'modifier order must hold');
  assert.equal(isValidBinding('Ctrl+Click+Shift'), false, 'no trailing modifier');
});

/* ------------------------------------------------------------------ */
/* bindingAllowedFor — the >=1-modifier-for-mouse rule                  */
/* ------------------------------------------------------------------ */

test('MOUSE: bindingAllowedFor requires >=1 modifier for ANY mouse combo', async () => {
  const { bindingAllowedFor } = await kit();
  // A bare mouse combo is DISALLOWED for every command (would hijack clicking).
  assert.equal(bindingAllowedFor('toggleTheme', 'Click'), false);
  assert.equal(bindingAllowedFor('toggleTheme', 'MiddleClick'), false);
  assert.equal(bindingAllowedFor('toggleTheme', 'RightClick'), false);
  assert.equal(bindingAllowedFor('goToDefinition', 'Click'), false);
  // A modified mouse combo is allowed.
  assert.equal(bindingAllowedFor('toggleTheme', 'Ctrl+Click'), true);
  assert.equal(bindingAllowedFor('toggleTheme', 'Alt+Shift+RightClick'), true);
  // The mouse rule is MOUSE-SCOPED: a bare KEY combo is still allowed for a
  // non-editable-target command (proves the rule does not over-reach to keys).
  assert.equal(bindingAllowedFor('toggleTheme', 'K'), true, 'a bare key is allowed for a non-terminal command');
});

test('MOUSE: closeFile rejects ANY mouse combo (the document dispatcher hard-skips it — no dead binding)', async () => {
  const { bindingAllowedFor, isMouseForbiddenCommand } = await kit();
  // closeFile is MOUSE-FORBIDDEN: the App document mouse dispatcher hard-skips
  // it (keyboard-only), so a mouse binding would be a SILENT DEAD BINDING. A
  // modified mouse combo that is ALLOWED for any other command is REFUSED here.
  assert.equal(bindingAllowedFor('closeFile', 'Ctrl+Click'), false, 'no modified Click for closeFile');
  assert.equal(bindingAllowedFor('closeFile', 'Ctrl+MiddleClick'), false, 'no MiddleClick for closeFile');
  assert.equal(bindingAllowedFor('closeFile', 'Alt+Shift+RightClick'), false, 'no RightClick for closeFile');
  // A KEY combo is STILL allowed for closeFile (the rule is mouse-scoped only).
  assert.equal(bindingAllowedFor('closeFile', 'Ctrl+W'), true, 'a key combo is still allowed for closeFile');
  assert.equal(bindingAllowedFor('closeFile', 'Escape'), true, 'the closeFile default stays allowed');
  // The predicate the panel uses to tailor its "cannot be a mouse shortcut"
  // message: closeFile is mouse-forbidden, ordinary commands are not.
  assert.equal(isMouseForbiddenCommand('closeFile'), true, 'closeFile is mouse-forbidden');
  assert.equal(isMouseForbiddenCommand('toggleTheme'), false, 'toggleTheme is not mouse-forbidden');
  // goToDefinition is NOT mouse-forbidden — its mouse path is Viewer-owned, so a
  // mouse binding there is LIVE (not dead).
  assert.equal(isMouseForbiddenCommand('goToDefinition'), false, 'goToDefinition is not mouse-forbidden');
  assert.equal(bindingAllowedFor('goToDefinition', 'Ctrl+Click'), true, 'goToDefinition still takes a mouse combo');
});

test('MOUSE: a closeFile mouse override never resolves or persists (dropped like a disallowed combo)', async () => {
  const { resolveBindings, diffOverrides, DEFAULT_BINDINGS } = await kit();
  // A persisted mouse override for closeFile is DROPPED on resolve (falls back
  // to its default), mirroring every other disallowed combo — the UI and the
  // live bindings can never silently diverge over a dead mouse binding.
  assert.equal(
    resolveBindings({ closeFile: 'Ctrl+MiddleClick' }).closeFile,
    DEFAULT_BINDINGS.closeFile,
    'a closeFile mouse override falls back to the default',
  );
  // And it is NEVER persisted by diffOverrides (treated like a vacated bind).
  const o = diffOverrides({ ...DEFAULT_BINDINGS, closeFile: 'Ctrl+MiddleClick' });
  assert.deepEqual(o, {}, 'a closeFile mouse combo is never persisted');
});

/* ------------------------------------------------------------------ */
/* resolveBindings + diffOverrides round-trip                          */
/* ------------------------------------------------------------------ */

test('MOUSE: resolveBindings round-trips a valid mouse override + drops a bare Click', async () => {
  const { resolveBindings, DEFAULT_BINDINGS } = await kit();
  // A valid mouse override resolves verbatim.
  assert.equal(
    resolveBindings({ goToDefinition: 'Alt+RightClick' }).goToDefinition,
    'Alt+RightClick',
    'a modified mouse override resolves',
  );
  // A BARE mouse override is dropped (disallowed) -> falls back to the default.
  assert.equal(
    resolveBindings({ toggleTheme: 'Click' }).toggleTheme,
    DEFAULT_BINDINGS.toggleTheme,
    'a bare Click override is dropped (falls back to default)',
  );
});

test('MOUSE: diffOverrides persists a valid mouse override + never a bare Click', async () => {
  const { diffOverrides, DEFAULT_BINDINGS } = await kit();
  const o = diffOverrides({ ...DEFAULT_BINDINGS, toggleTheme: 'Ctrl+MiddleClick' });
  assert.deepEqual(o, { toggleTheme: 'Ctrl+MiddleClick' }, 'a valid mouse override is the only diff');
  // A bare Click is disallowed, so it never persists (treated like a vacated bind).
  const o2 = diffOverrides({ ...DEFAULT_BINDINGS, toggleTheme: 'Click' });
  assert.deepEqual(o2, {}, 'a bare Click is never persisted');
});

/* ------------------------------------------------------------------ */
/* formatCombo display                                                  */
/* ------------------------------------------------------------------ */

test('MOUSE: formatCombo shows Ctrl as Ctrl/Cmd and passes mouse tokens verbatim', async () => {
  const { formatCombo } = await kit();
  assert.equal(formatCombo('Ctrl+Click'), 'Ctrl/Cmd+Click');
  assert.equal(formatCombo('Alt+Shift+RightClick'), 'Alt+Shift+RightClick');
  assert.equal(formatCombo('Ctrl+Shift+MiddleClick'), 'Ctrl/Cmd+Shift+MiddleClick');
});

/* ------------------------------------------------------------------ */
/* goToDefinition REBINDABLE default flip + isPositionalCommand         */
/* ------------------------------------------------------------------ */

test('MOUSE: goToDefinition default is Ctrl+Click; F12 stays an allowed rebind target', async () => {
  const {
    COMMANDS,
    DEFAULT_BINDINGS,
    bindingAllowedFor,
    findConflict,
    resolveBindings,
    isPlatformCritical,
  } = await kit();
  const gtd = COMMANDS.find((c) => c.id === 'goToDefinition');
  assert.ok(gtd, 'goToDefinition is registered');
  assert.equal(gtd.defaultBinding, 'Ctrl+Click', 'rebindable default is Ctrl+Click');
  assert.equal(DEFAULT_BINDINGS.goToDefinition, 'Ctrl+Click', 'resolved default carries Ctrl+Click');
  assert.equal(bindingAllowedFor('goToDefinition', 'Ctrl+Click'), true, 'the default is allowed');
  assert.equal(
    findConflict(resolveBindings({}), 'Ctrl+Click', 'goToDefinition'),
    null,
    'Ctrl+Click collides with no other command',
  );
  // F12 stays a structurally-valid rebind target (the keyboard affordance is
  // FIXED in the App dispatcher, but a user may also bind the slot onto F12).
  assert.equal(bindingAllowedFor('goToDefinition', 'F12'), true, 'F12 is still rebindable');
  assert.equal(isPlatformCritical('F12'), false, 'F12 is not platform-critical');
  assert.equal(isPlatformCritical('Ctrl+Click'), false, 'Ctrl+Click is not platform-critical');
});

test('MOUSE: isPositionalCommand flags goToDefinition only', async () => {
  const { isPositionalCommand } = await kit();
  assert.equal(isPositionalCommand('goToDefinition'), true);
  assert.equal(isPositionalCommand('toggleTheme'), false);
  assert.equal(isPositionalCommand('toggleExplorer'), false);
  assert.equal(isPositionalCommand('closeFile'), false);
});

/* ------------------------------------------------------------------ */
/* Pure dispatch decision + single-source routing                      */
/* ------------------------------------------------------------------ */

test('MOUSE: single-source routing dispatches a right-button gesture EXACTLY once', async () => {
  const { mouseEventDispatchButton } = await kit();
  // A right-button release fires BOTH auxclick AND contextmenu natively. The
  // routing rule must dispatch it ONCE (via contextmenu) and DROP the auxclick.
  assert.equal(mouseEventDispatchButton('auxclick', 2), null, 'right-button auxclick is dropped');
  assert.equal(mouseEventDispatchButton('contextmenu', 2), 2, 'contextmenu owns the right button');
  // contextmenu normalizes ANY reported button to 2 (its e.button is unreliable).
  assert.equal(mouseEventDispatchButton('contextmenu', 0), 2, 'contextmenu normalizes to 2');
  // Middle button: auxclick owns it; click never fires for it.
  assert.equal(mouseEventDispatchButton('auxclick', 1), 1, 'auxclick owns the middle button');
  assert.equal(mouseEventDispatchButton('click', 1), null, 'click never owns the middle button');
  // Primary button: click owns it; an auxclick primary is dropped.
  assert.equal(mouseEventDispatchButton('click', 0), 0, 'click owns the primary button');
  assert.equal(mouseEventDispatchButton('auxclick', 0), null, 'auxclick drops the primary button');
});

test('MOUSE: shouldFireMouseCommand skips positional/closeFile/editable + bails on consumed', async () => {
  const { shouldFireMouseCommand } = await kit();
  const base = {
    defaultPrevented: false,
    isPositional: false,
    isCloseFile: false,
    isEditable: false,
    isTerminalExempt: false,
  };
  // A plain matched global command fires.
  assert.equal(shouldFireMouseCommand(base), true);
  // A consumed event (anchor-guard / Viewer jump) bails.
  assert.equal(shouldFireMouseCommand({ ...base, defaultPrevented: true }), false);
  // A positional command (goToDefinition) is skipped (Viewer-owned).
  assert.equal(shouldFireMouseCommand({ ...base, isPositional: true }), false);
  // closeFile is skipped (keyboard-only).
  assert.equal(shouldFireMouseCommand({ ...base, isCloseFile: true }), false);
  // An editable target suppresses a non-exempt command.
  assert.equal(shouldFireMouseCommand({ ...base, isEditable: true }), false);
  // A terminal-exempt command would fire even in an editable target — but mouse
  // combos are never terminal-exempt in production; this proves the guard logic.
  assert.equal(
    shouldFireMouseCommand({ ...base, isEditable: true, isTerminalExempt: true }),
    true,
  );
});
