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

export const DEFAULT_CONFIG: LoomConfig = { theme: 'dark' };

export const CONFIG_FILENAME = 'loom-config.json';

export interface ConfigStore {
  read(): LoomConfig;
  setTheme(theme: Theme): void;
}

/** Validate + normalize an unknown parsed object into a LoomConfig. */
function coerceConfig(parsed: unknown): LoomConfig {
  if (parsed && typeof parsed === 'object') {
    const theme = (parsed as { theme?: unknown }).theme;
    if (theme === 'dark' || theme === 'light') {
      return { theme };
    }
  }
  return { ...DEFAULT_CONFIG };
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
