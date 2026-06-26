/* ============================================================
 * Loom — presentation formatters (pure helpers)
 * ------------------------------------------------------------
 * Small pure functions shared across components: human-readable
 * byte sizes, clock/time strings, and the FileMeta type label.
 * No DOM, no Node — trivially testable.
 *
 * These feed the Viewer NO-PREVIEW metadata card (FR-43) and the
 * StatusBar/Explorer chrome. typeLabel mirrors the dispatch table
 * (FR-4..FR-10) so the human label agrees with the render-state.
 * ============================================================ */

/** "2.4 KB" style size from a byte count. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // One decimal place, but drop a trailing ".0" so "1 MB" not "1.0 MB".
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${units[unitIndex]}`;
}

/** "HH:MM" wall-clock string from epoch ms (24-hour, zero-padded). */
export function formatClock(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '--:--';
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Grouped integer token count, e.g. 1234567 -> "1,234,567". Non-finite or
 *  negative/garbage inputs coerce to "0" (the data layer already coerces rows,
 *  but the renderer stays defensive). Truncates any fractional part — token
 *  counts are whole numbers. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** USD cost as "$X.XX". `null`/`undefined`/non-finite render as an em dash
 *  ("—") — the CLI omits cost without `--cost`, and a row may legitimately
 *  carry a null cost. Negative values keep the sign before the dollar. */
export function formatCost(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

/** Human label for a file extension, e.g. "TypeScript", "PNG image". */
export function typeLabel(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '');
  const map: Record<string, string> = {
    md: 'Markdown',
    markdown: 'Markdown',
    js: 'JavaScript',
    mjs: 'JavaScript',
    cjs: 'JavaScript',
    jsx: 'JavaScript (JSX)',
    ts: 'TypeScript',
    mts: 'TypeScript',
    cts: 'TypeScript',
    tsx: 'TypeScript (TSX)',
    json: 'JSON',
    jsonc: 'JSON',
    css: 'CSS',
    scss: 'SCSS',
    less: 'Less',
    py: 'Python',
    txt: 'Plain text',
    yaml: 'YAML',
    yml: 'YAML',
    toml: 'TOML',
    ini: 'INI',
    env: 'Env file',
    sh: 'Shell script',
    bash: 'Shell script',
    sql: 'SQL',
    xml: 'XML',
    csv: 'CSV',
    log: 'Log file',
    rs: 'Rust',
    go: 'Go',
    java: 'Java',
    c: 'C',
    h: 'C header',
    cpp: 'C++',
    rb: 'Ruby',
    svg: 'SVG image',
    html: 'HTML',
    htm: 'HTML',
    png: 'PNG image',
    jpg: 'JPEG image',
    jpeg: 'JPEG image',
    gif: 'GIF image',
    webp: 'WebP image',
    bmp: 'Bitmap image',
    ico: 'Icon',
    avif: 'AVIF image',
    tiff: 'TIFF image',
    bin: 'Binary file',
    pdf: 'PDF document',
    zip: 'Zip archive',
    gz: 'Gzip archive',
    tar: 'Tar archive',
  };
  const label = map[e];
  if (label) return label;
  if (e === '') return 'File';
  return `${e.toUpperCase()} file`;
}
