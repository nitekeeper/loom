/* ============================================================
 * Loom — persisted config (FR-37, AC-20)
 * ------------------------------------------------------------
 * Reads/writes loom-config.json in app.getPath('userData'). Holds
 * the theme, which is read on boot (into InitialState) and written
 * on the renderer's theme toggle (via the SET_THEME IPC handler).
 * Persists across launches.
 *
 * Tolerates a missing or corrupt file by falling back to the
 * default { theme: 'dark' } and rewriting a clean file on the next
 * mutation. Writes are atomic (write tmp, then rename).
 * ============================================================ */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MAX_MESSAGES,
  MAX_BODY_LENGTH,
  type LoomConfig,
  type Theme,
} from '../shared/types.js';

/** Inclusive bounds for the persisted terminal-pane count. Mirrors the
 *  renderer's MAX_TERMINALS (lib/terminal-columns.ts) without importing renderer
 *  code into main: the contract caps the layout at 3 columns / 3 terminals, and
 *  at least 1 pane is always present. */
export const MIN_TERMINAL_COUNT = 1;
export const MAX_TERMINAL_COUNT = 3;
/** DEFAULT terminal-pane count — a back-compat no-op for single-terminal users
 *  whose config predates the field (missing/garbage coerces to this). */
export const DEFAULT_TERMINAL_COUNT = 1;

export const DEFAULT_CONFIG: LoomConfig = {
  theme: 'dark',
  keybindings: {},
  maxMessageLength: MAX_BODY_LENGTH,
  maxMessages: DEFAULT_MAX_MESSAGES,
  terminalCount: DEFAULT_TERMINAL_COUNT,
};

export const CONFIG_FILENAME = 'loom-config.json';

export interface ConfigStore {
  read(): LoomConfig;
  setTheme(theme: Theme): void;
  /** Persist the user keyboard-shortcut OVERRIDES (sparse id -> combo map).
   *  Tolerates a non-object by storing {} (mirror of theme persistence). */
  setKeybindings(map: Record<string, string>): void;
  /** Persist the desired terminal-pane count (clamped to [1,3]); garbage
   *  coerces to the default (1). Mirror of setTheme persistence. */
  setTerminalCount(count: number): void;
}

/** Coerce an unknown value into a sparse string->string keybinding override
 *  map, dropping any non-string entries. Tolerates missing/corrupt input by
 *  returning {} so a damaged config can never throw or blank a command. */
function coerceKeybindings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

/** Coerce an unknown value into a valid maxMessageLength (a POSITIVE INTEGER),
 *  falling back to the MAX_BODY_LENGTH default on anything else (missing,
 *  non-number, NaN/Infinity, zero/negative, or non-integer). Mirrors the
 *  tolerant theme/keybinding coercion: a damaged config never throws. */
function coerceMaxMessageLength(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return MAX_BODY_LENGTH;
}

/** Coerce an unknown value into a valid maxMessages cap (a NON-NEGATIVE
 *  INTEGER — 0 means unlimited/disabled), falling back to DEFAULT_MAX_MESSAGES
 *  on anything else (missing, non-number, NaN/Infinity, negative, non-integer).
 *  Mirrors the tolerant body-cap coercion: a damaged config never throws. Note
 *  0 is a VALID, explicit "unlimited" choice — distinct from absent (default). */
function coerceMaxMessages(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return DEFAULT_MAX_MESSAGES;
}

/** Coerce an unknown value into a valid terminalCount — an INTEGER CLAMPED to
 *  [MIN_TERMINAL_COUNT, MAX_TERMINAL_COUNT] ([1,3]). Mirrors coerceMaxMessages's
 *  tolerant integer check, but an in-type out-of-range integer is CLAMPED into
 *  range (a count of 5 means "as many as allowed" = 3) rather than rejected,
 *  while anything not a finite integer (missing, non-number, NaN/Infinity,
 *  non-integer) falls back to the DEFAULT (1). A damaged config never throws. */
function coerceTerminalCount(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return Math.min(MAX_TERMINAL_COUNT, Math.max(MIN_TERMINAL_COUNT, value));
  }
  return DEFAULT_TERMINAL_COUNT;
}

/** Validate + normalize an unknown parsed object into a LoomConfig. */
function coerceConfig(parsed: unknown): LoomConfig {
  let theme: Theme = DEFAULT_CONFIG.theme;
  let keybindings: Record<string, string> = {};
  let maxMessageLength = MAX_BODY_LENGTH;
  let maxMessages = DEFAULT_MAX_MESSAGES;
  let terminalCount = DEFAULT_TERMINAL_COUNT;
  if (parsed && typeof parsed === 'object') {
    const t = (parsed as { theme?: unknown }).theme;
    if (t === 'dark' || t === 'light') theme = t;
    keybindings = coerceKeybindings((parsed as { keybindings?: unknown }).keybindings);
    maxMessageLength = coerceMaxMessageLength(
      (parsed as { maxMessageLength?: unknown }).maxMessageLength,
    );
    maxMessages = coerceMaxMessages(
      (parsed as { maxMessages?: unknown }).maxMessages,
    );
    terminalCount = coerceTerminalCount(
      (parsed as { terminalCount?: unknown }).terminalCount,
    );
  }
  return { theme, keybindings, maxMessageLength, maxMessages, terminalCount };
}

class FileConfigStore implements ConfigStore {
  private readonly file: string;
  private current: LoomConfig;

  constructor(private readonly userDataDir: string) {
    this.file = path.join(userDataDir, CONFIG_FILENAME);
    this.current = this.load();
  }

  /** Read + parse, tolerating missing/corrupt files. */
  private load(): LoomConfig {
    try {
      const raw = readFileSync(this.file, 'utf8');
      return coerceConfig(JSON.parse(raw));
    } catch {
      // Missing file, bad JSON, or unreadable -> default.
      return { ...DEFAULT_CONFIG };
    }
  }

  read(): LoomConfig {
    return { ...this.current };
  }

  setTheme(theme: Theme): void {
    this.current = { ...this.current, theme };
    this.write(this.current);
  }

  setKeybindings(map: Record<string, string>): void {
    this.current = { ...this.current, keybindings: coerceKeybindings(map) };
    this.write(this.current);
  }

  setTerminalCount(count: number): void {
    // Clamp/normalize via the same tolerant coercer the load path uses, so a
    // bad renderer value can never persist out of range (mirror of setTheme).
    this.current = { ...this.current, terminalCount: coerceTerminalCount(count) };
    this.write(this.current);
  }

  /** Atomic write: tmp file + rename. Best-effort (never throws to caller). */
  private write(cfg: LoomConfig): void {
    try {
      mkdirSync(this.userDataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // Persistence is best-effort; an unwritable userData dir must not crash.
    }
  }
}

/** @param userDataDir typically app.getPath('userData'). */
export function createConfigStore(userDataDir: string): ConfigStore {
  return new FileConfigStore(userDataDir);
}
