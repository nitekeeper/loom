/* ============================================================
 * Loom — file-dispatch table (FR-4..FR-10, FR-40, NFR-6)
 * ------------------------------------------------------------
 * The canonical, deterministic extension -> FileKind -> RenderState
 * mapping. Pure + dependency-free so BOTH the main process
 * (sandbox.ts) and the renderer (Viewer) import the SAME source of
 * truth — there must be exactly one dispatch decision per file.
 *
 * This file is implemented (not a stub): the mapping itself IS the
 * contract, and it is trivial, total, and safety-critical.
 *
 * Rules:
 *   .md                                  -> md     / RENDERED   (FR-5)
 *   .js .ts .jsx .tsx .json .css .py
 *      .txt + other text                 -> code   / SOURCE     (FR-6)
 *   .html .htm                           -> html   / SOURCE + banner (FR-8/41)
 *   .svg                                 -> svg    / SOURCE + banner (FR-7/41)
 *   .png .jpg .jpeg .gif .webp .bmp .ico -> image  / PREVIEW    (FR-10)
 *   unknown / binary                     -> binary / NO PREVIEW (FR-9/43)
 * ============================================================ */
import type { FileDispatch, FileKind, RenderState } from './types.js';

/** Extensions (no dot, lowercase) that render as highlighted source. */
export const CODE_EXTS: ReadonlySet<string> = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'json', 'jsonc', 'css', 'scss', 'less', 'py', 'txt',
  'yaml', 'yml', 'toml', 'ini', 'env', 'sh', 'bash',
  'sql', 'md', // md handled before this set, listed for completeness
  'xml', 'csv', 'log', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'rb',
]);

/** Extensions treated as images -> PREVIEW placeholder (never decoded). */
export const IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tiff',
]);

/** Extract a lowercase extension without the dot ('' if none). */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** Classify a filename into a FileKind by extension. Deterministic. */
export function kindOf(name: string): FileKind {
  const ext = extensionOf(name);
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'svg') return 'svg';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (CODE_EXTS.has(ext)) return 'code';
  return 'binary';
}

const RENDER_STATE: Record<FileKind, RenderState> = {
  md: 'RENDERED',
  code: 'SOURCE',
  svg: 'SOURCE',
  html: 'SOURCE',
  image: 'PREVIEW',
  binary: 'NO PREVIEW',
};

/** Full dispatch decision for a filename. */
export function dispatchFor(name: string): FileDispatch {
  const kind = kindOf(name);
  return {
    kind,
    renderState: RENDER_STATE[kind],
    // SVG + HTML shown as source carry the explicit safety banner (FR-41).
    safetyBanner: kind === 'svg' || kind === 'html',
  };
}
