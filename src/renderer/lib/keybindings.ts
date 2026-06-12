/* ============================================================
 * Loom — keyboard-shortcut core (pure, fully unit-testable)
 * ------------------------------------------------------------
 * The single source of truth for the customizable commands, their
 * default bindings, and the pure functions that turn a keyboard event
 * into a canonical combo string, merge user overrides over defaults,
 * detect conflicts, and validate a candidate binding.
 *
 * DESIGN: this module has NO React / DOM-instance state and imports
 * nothing from the DOM or Node, so it bundles into the Electron-free
 * testkit (dist/testkit.cjs) and is unit-tested without a browser.
 * The App dispatcher (App.tsx) and the Shortcuts panel
 * (ShortcutsPanel.tsx) are the only stateful consumers.
 *
 * CANONICAL COMBO FORMAT (the persisted + compared string):
 *   modifier order is FIXED — "Ctrl", then "Alt", then "Shift", then
 *   the key — joined by "+". The platform primary modifier (Cmd on
 *   macOS / Ctrl elsewhere) is normalized to the single token "Ctrl"
 *   so a binding persisted on one platform matches on the other
 *   (metaKey OR ctrlKey ⇒ "Ctrl"). Single-character keys are
 *   upper-cased ("k" ⇒ "K"); named keys keep their DOM name
 *   ("Escape", "ArrowLeft", "."). Examples:
 *     {ctrl, shift, 'k'}      -> "Ctrl+Shift+K"
 *     {meta, 'b'}             -> "Ctrl+B"     (Cmd == Ctrl)
 *     {key:'Escape'}          -> "Escape"
 *     {ctrl, '.'}             -> "Ctrl+."
 * ============================================================ */

/** Stable command identifier — persisted as the override-map key. */
export type CommandId =
  | 'toggleExplorer'
  | 'toggleChat'
  | 'closeFile'
  | 'foldAll'
  | 'unfoldAll'
  | 'toggleTheme'
  | 'togglePause'
  | 'openSearch'
  | 'copyRendered'
  | 'toggleTerminal';

/** A command entry shown in the Shortcuts panel. */
export interface CommandSpec {
  /** Stable id (override-map key + dispatcher lookup key). */
  id: CommandId;
  /** Human label shown verbatim in the panel. */
  label: string;
  /** Canonical default combo string (see CANONICAL COMBO FORMAT). */
  defaultBinding: string;
}

/** The customizable commands, in panel display order, with their default
 *  bindings. The labels are shown verbatim in the panel rows. */
export const COMMANDS: readonly CommandSpec[] = [
  { id: 'toggleExplorer', label: 'Toggle file explorer', defaultBinding: 'Ctrl+B' },
  { id: 'toggleChat', label: 'Toggle agent chat', defaultBinding: 'Ctrl+J' },
  { id: 'toggleTerminal', label: 'Toggle terminal', defaultBinding: 'Ctrl+`' },
  { id: 'openSearch', label: 'Search file contents', defaultBinding: 'Ctrl+Shift+F' },
  { id: 'closeFile', label: 'Close file', defaultBinding: 'Escape' },
  { id: 'foldAll', label: 'Fold all regions', defaultBinding: 'Ctrl+K' },
  { id: 'unfoldAll', label: 'Unfold all regions', defaultBinding: 'Ctrl+Shift+K' },
  { id: 'copyRendered', label: 'Copy rendered content', defaultBinding: 'Ctrl+Shift+C' },
  { id: 'toggleTheme', label: 'Toggle theme', defaultBinding: 'Ctrl+T' },
  { id: 'togglePause', label: 'Pause / resume live feed', defaultBinding: 'Ctrl+.' },
] as const;

/** Resolved default bindings as a plain id -> combo record. Frozen so a
 *  consumer cannot mutate the shared default map. */
export const DEFAULT_BINDINGS: Readonly<Record<CommandId, string>> = Object.freeze(
  COMMANDS.reduce<Record<CommandId, string>>(
    (acc, c) => {
      acc[c.id] = c.defaultBinding;
      return acc;
    },
    {} as Record<CommandId, string>,
  ),
);

/** The set of command ids — for cheap membership tests / iteration. */
const COMMAND_IDS: readonly CommandId[] = COMMANDS.map((c) => c.id);

/** A minimal KeyboardEvent shape so the pure core never touches the DOM
 *  KeyboardEvent type directly (keeps it Node/testkit-safe). */
export interface KeyComboEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** DOM KeyboardEvent.key (e.g. 'k', 'K', 'Escape', '.', 'ArrowLeft'). */
  key: string;
}

/** Modifier key names that are NOT, on their own, a valid binding key.
 *  When `key` is one of these the press is "modifier-only" (no real key). */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'OS', // legacy Meta alias
  'AltGraph',
]);

/** Normalize the non-modifier key token to its canonical form.
 *  - Single printable characters upper-case (so 'k' and 'K' agree).
 *  - The space key (' ') canonicalizes to the readable token 'Space'.
 *  - Named keys (length > 1, e.g. 'Escape', 'ArrowLeft') pass through. */
function normalizeKey(key: string): string {
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Turn a keyboard-event-like object into the canonical combo string.
 *  metaKey OR ctrlKey both map to the single 'Ctrl' token (Cmd == Ctrl).
 *  A modifier-only press (key is itself a modifier) yields just the
 *  ordered modifier list (e.g. 'Ctrl+Shift'); isValidBinding() rejects
 *  such a result, so the panel ignores it while the user is still
 *  holding modifiers. */
export function eventToCombo(e: KeyComboEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (!MODIFIER_KEYS.has(e.key)) {
    parts.push(normalizeKey(e.key));
  }
  return parts.join('+');
}

/** The three canonical modifier tokens, in their FIXED serialization order
 *  (see CANONICAL COMBO FORMAT). A valid combo's leading segments must be a
 *  prefix of this sequence — no repeats, no out-of-order, no unknown token. */
const CANONICAL_MODIFIERS: readonly string[] = ['Ctrl', 'Alt', 'Shift'];

/** Named (length > 1) keys that are allowed as a binding's final key token.
 *  Anything not in this set, and not a single printable character, is treated
 *  as garbage (a string no real keypress through eventToCombo could produce).
 *  Covers the shipped defaults (Escape) plus the common editing/navigation
 *  keys a user might reasonably bind. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  'Escape',
  'Enter',
  'Tab',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
]);

/** True when a single segment is a usable FINAL key token: either a single
 *  printable, non-space character (canonically upper-cased — but we accept any
 *  single char so punctuation like '.' or '/' passes) OR a known named key. */
function isValidKeyToken(token: string): boolean {
  if (token.length === 0) return false;
  if (token.length === 1) {
    // A lone space is never a key token — Space is the canonical name for it.
    return token !== ' ';
  }
  return NAMED_KEYS.has(token);
}

/** True when a canonical combo is a STRUCTURALLY-VALID, usable binding —
 *  i.e. a string eventToCombo could actually produce. It must:
 *    - be a non-empty string,
 *    - split on '+' into all-non-empty segments,
 *    - have its leading segments be an in-order, non-repeating PREFIX of
 *      {Ctrl, Alt, Shift} (the fixed modifier order), and
 *    - end with a real key token (single printable char or a known named key).
 *  This rejects '' and pure-modifier strings ('Ctrl', 'Ctrl+Shift') AND
 *  garbage that no keypress can match ('+K', 'a+b', 'Ctrl+ +K', ' ',
 *  'garbagekey'), so a corrupt persisted override can never SHADOW a command
 *  with a dead, unmatchable binding. */
export function isValidBinding(combo: string): boolean {
  if (typeof combo !== 'string' || combo.length === 0) return false;
  const parts = combo.split('+');
  // Every segment must be non-empty (rejects '+K', 'Ctrl+ +K', 'Ctrl+', '').
  if (parts.some((p) => p.length === 0)) return false;
  const last = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1);
  // Leading modifiers must be a strictly-increasing SUBSEQUENCE of the fixed
  // order [Ctrl, Alt, Shift] — each present modifier known, in order, no
  // repeats. (Alt may be absent: 'Ctrl+Shift+K' is valid; 'Shift+Ctrl+K' and
  // 'Ctrl+Ctrl+K' are not.)
  let expected = 0;
  for (const mod of modifiers) {
    while (expected < CANONICAL_MODIFIERS.length && CANONICAL_MODIFIERS[expected] !== mod) {
      expected++;
    }
    if (expected >= CANONICAL_MODIFIERS.length) return false;
    expected++; // consume this modifier slot so repeats / regressions fail
  }
  // The final segment must be a real, non-modifier key.
  if (CANONICAL_MODIFIERS.includes(last)) return false;
  return isValidKeyToken(last);
}

/** True when `combo` is a valid binding FOR THE GIVEN COMMAND. On top of the
 *  structural isValidBinding check, toggleTerminal must carry at least one
 *  modifier: it is the one command the App dispatcher fires even inside
 *  editable targets (so Ctrl/Cmd+` can close the dock from xterm's own
 *  textarea) — a bare-key binding (e.g. 'K') would therefore fire, and KILL
 *  the shell session, on every plain keystroke in any text field. */
export function bindingAllowedFor(id: CommandId, combo: string): boolean {
  if (!isValidBinding(combo)) return false;
  // isValidBinding guarantees every non-final segment is a modifier, so
  // "has a modifier" reduces to "more than one segment".
  if (id === 'toggleTerminal' && combo.split('+').length < 2) return false;
  return true;
}

/** Merge user overrides onto the defaults, returning the FULL resolved
 *  id -> combo map for all commands. Only override entries for known
 *  command ids whose value is a valid binding FOR THAT COMMAND are applied
 *  (bindingAllowedFor: structural validity + the toggleTerminal modifier
 *  requirement); anything else (unknown id, empty/invalid combo) falls back
 *  to the default so a corrupt persisted map can never blank a command. */
export function resolveBindings(
  overrides: Readonly<Record<string, string>> | null | undefined,
): Record<CommandId, string> {
  const resolved: Record<CommandId, string> = { ...DEFAULT_BINDINGS };
  if (!overrides || typeof overrides !== 'object') return resolved;
  for (const id of COMMAND_IDS) {
    const o = overrides[id];
    if (typeof o === 'string' && bindingAllowedFor(id, o)) {
      resolved[id] = o;
    }
  }
  return resolved;
}

/** Given a resolved bindings map and a candidate combo, return the id of
 *  the command ALREADY bound to that combo (excluding `exceptId`), or
 *  null when the combo is free. Used to surface the live conflict warning
 *  in the panel before a rebind is committed. */
export function findConflict(
  bindings: Readonly<Record<string, string>>,
  combo: string,
  exceptId: string | null,
): CommandId | null {
  for (const id of COMMAND_IDS) {
    if (id === exceptId) continue;
    if (bindings[id] === combo) return id;
  }
  return null;
}

/** Combos RESERVED by the app shell that a command may NOT be rebound to —
 *  each is intercepted by the App dispatcher BEFORE matching any rebindable
 *  command, so a command bound to one would be permanently dead. The panel
 *  treats a captured reserved combo as a hard conflict and refuses the
 *  assignment (KB-2).
 *
 *  ORDER MATTERS: the Shortcuts-panel opener is `Array.from(RESERVED_COMBOS)[0]`
 *  (ShortcutsPanel.OPENER_COMBO), so 'Ctrl+,' (the Shortcuts opener) MUST stay
 *  at index 0 — APPEND new reserved combos, never prepend. 'Ctrl+Shift+G' is the
 *  fixed Changes-viewer toggle (App.tsx dispatcher intercepts it before the
 *  rebindable-command loop), reserved here so a rebind onto it is hard-blocked
 *  rather than silently shadowed. */
export const RESERVED_COMBOS: ReadonlySet<string> = new Set([
  'Ctrl+,',
  'Ctrl+Shift+G',
]);

/** True when `combo` is reserved by the app shell (see RESERVED_COMBOS) and
 *  must never be assigned to a rebindable command. */
export function isReserved(combo: string): boolean {
  return RESERVED_COMBOS.has(combo);
}

/** Platform/browser/Electron combos that are load-bearing (reload, close,
 *  quit, …). Binding a command onto one of these SHADOWS the native action
 *  once the dispatcher preventDefaults it. Not a hard block — customization is
 *  preserved — but the panel surfaces a soft warning so accidental shadowing
 *  is visible (KB-5). Stored in canonical combo form (Cmd == Ctrl). */
const PLATFORM_CRITICAL_COMBOS: ReadonlySet<string> = new Set([
  'Ctrl+R', // reload
  'Ctrl+Shift+R', // hard reload
  'Ctrl+W', // close window/tab
  'Ctrl+Q', // quit
  'Ctrl+N', // new window
  'F5', // reload
  'F11', // fullscreen
]);

/** True when `combo` shadows a load-bearing platform/browser/Electron default.
 *  Used for a SOFT (non-blocking) warning in the panel (KB-5). */
export function isPlatformCritical(combo: string): boolean {
  return PLATFORM_CRITICAL_COMBOS.has(combo);
}

/** Pretty display string for a combo. Cmd/Ctrl is shown as "Ctrl/Cmd" so
 *  the cross-platform meaning is explicit; 'Space' shows as 'Space'. The
 *  canonical stored string is unchanged — this is display-only. */
export function formatCombo(combo: string): string {
  if (!combo) return '';
  return combo
    .split('+')
    .map((part) => (part === 'Ctrl' ? 'Ctrl/Cmd' : part))
    .join('+');
}

/** Outcome of planning a conflict reassignment (KB-3). */
export interface ReassignPlan {
  /** The full resolved map after assigning `combo` to the new command and
   *  resolving the DISPLACED command's binding. */
  next: Record<CommandId, string>;
  /** The displaced command's new combo, or null when it was VACATED because
   *  its default would have re-collided (the panel must prompt for a fresh
   *  key). */
  displacedCombo: string | null;
  /** True when the displaced command could not be given a non-colliding
   *  binding and was left needing one (drives a re-capture in the panel). */
  displacedNeedsRebind: boolean;
}

/** Plan a conflict reassignment WITHOUT ever producing a duplicate binding
 *  (KB-3). Assigns `combo` to `id`, then tries to restore the displaced
 *  command (`conflictWith`) to ITS default. If that default would collide with
 *  the just-assigned combo (or any other current binding), the displaced
 *  command is VACATED (set to '' — an invalid combo that resolveBindings drops
 *  to default on the next boot, but which the panel surfaces as needing a
 *  rebind) instead of silently shadowing two commands onto one combo.
 *
 *  Invariant: in the returned `next` map, no two commands share a non-empty
 *  combo. */
export function planReassign(
  working: Readonly<Record<string, string>>,
  id: CommandId,
  combo: string,
  conflictWith: CommandId,
): ReassignPlan {
  const next: Record<CommandId, string> = { ...DEFAULT_BINDINGS, ...working };
  next[id] = combo;
  const displacedDefault = DEFAULT_BINDINGS[conflictWith];
  // Would the displaced command's default re-collide with any OTHER command's
  // current binding (including the just-assigned `combo`)? Exclude the
  // displaced command itself from the conflict scan.
  const reCollides =
    findConflict(next, displacedDefault, conflictWith) !== null;
  if (reCollides) {
    // Vacate rather than create a duplicate: '' is invalid, so the panel can
    // detect "needs rebind" and resolveBindings will restore the default only
    // when it no longer collides.
    next[conflictWith] = '';
    return { next, displacedCombo: null, displacedNeedsRebind: true };
  }
  next[conflictWith] = displacedDefault;
  return { next, displacedCombo: displacedDefault, displacedNeedsRebind: false };
}

/** Diff a resolved bindings map against the defaults, returning ONLY the
 *  entries that differ (the minimal override map to persist). An empty
 *  object means "all defaults". This is what the panel writes through
 *  store.setKeybindings so the config never stores redundant defaults. */
export function diffOverrides(
  resolved: Readonly<Record<string, string>>,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const id of COMMAND_IDS) {
    const v = resolved[id];
    // Persist ONLY real, differing-from-default bindings. A VACATED command
    // (combo === '' from a reassign that re-collided, KB-3) is structurally
    // invalid, so we never persist it — it falls back to its default on
    // resolve, and the panel re-captures it before close anyway.
    if (typeof v === 'string' && v !== DEFAULT_BINDINGS[id] && isValidBinding(v)) {
      overrides[id] = v;
    }
  }
  return overrides;
}
