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
import type { LoomConfig, Theme } from '../shared/types.js';

export const DEFAULT_CONFIG: LoomConfig = { theme: 'dark', keybindings: {} };

export const CONFIG_FILENAME = 'loom-config.json';

export interface ConfigStore {
  read(): LoomConfig;
  setTheme(theme: Theme): void;
  /** Persist the user keyboard-shortcut OVERRIDES (sparse id -> combo map).
   *  Tolerates a non-object by storing {} (mirror of theme persistence). */
  setKeybindings(map: Record<string, string>): void;
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

/** Validate + normalize an unknown parsed object into a LoomConfig. */
function coerceConfig(parsed: unknown): LoomConfig {
  let theme: Theme = DEFAULT_CONFIG.theme;
  let keybindings: Record<string, string> = {};
  if (parsed && typeof parsed === 'object') {
    const t = (parsed as { theme?: unknown }).theme;
    if (t === 'dark' || t === 'light') theme = t;
    keybindings = coerceKeybindings((parsed as { keybindings?: unknown }).keybindings);
  }
  return { theme, keybindings };
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
