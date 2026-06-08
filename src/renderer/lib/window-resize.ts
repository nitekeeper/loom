/* ============================================================
 * Loom — frameless edge-resize geometry (Linux only; pure)
 * ------------------------------------------------------------
 * A frameless window (frame:false, win32/linux) loses the native resize
 * border. On Windows Electron keeps invisible edge regions so resizing still
 * works; on Linux/GNOME (incl. WSLg) a frameless window often has NO draggable
 * edges, so WindowResizeHandles.tsx draws its own 8 handles. THIS module is the
 * single source of truth for the geometry the handle drag applies — extracted
 * here, DOM-free, so it can be unit-tested in isolation (test/window-resize.mjs)
 * the same way the md-width / fold math is.
 *
 * No DOM, no Electron, no `window` — pure number-in/number-out, importable into
 * the Node test bundle via testkit-entry.ts.
 * ============================================================ */

/** A window's screen rectangle, in DIP (matches BrowserWindow.getBounds()). */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The eight resize directions — four edges + four corners. The letters are the
 *  compass directions of the edge/corner being dragged (n=top, s=bottom,
 *  e=right, w=left), matching the CSS `*-resize` cursor names. */
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** A minimum size floor for the resize (mirrors the OS setMinimumSize floor). */
export interface MinSize {
  width: number;
  height: number;
}

/** True when the direction includes the named edge. */
function hasEdge(dir: ResizeDir, edge: 'n' | 's' | 'e' | 'w'): boolean {
  return dir.includes(edge);
}

/** Compute the new window bounds for a handle drag.
 *
 *  `start` is the window's bounds captured at pointerdown; `dx`/`dy` are the
 *  pointer's screen-pixel delta SINCE that start (e.screenX - startScreenX, …).
 *  Returns the bounds to apply for the dragged `dir`.
 *
 *  Rules (the bug-prone part, pinned by the unit suite):
 *   - EAST / SOUTH edges grow width/height by dx/dy (the opposite edge — left/
 *     top — stays put because x/y are unchanged).
 *   - WEST / NORTH edges MOVE x/y by dx/dy AND shrink width/height by the same
 *     amount, so the opposite (right/bottom) edge stays put.
 *   - The min clamp keeps width>=min.width and height>=min.height. On a west/
 *     north drag, when the clamp engages, x/y STOP at
 *     start.x + start.width - min.width (resp. y), so the opposite edge never
 *     moves and the window never inverts or jumps past the floor.
 *   - Corners combine their two edges independently (each axis resolved on its
 *     own — a se corner is e on x + s on y, an nw corner is w on x + n on y).
 *   - Every field is rounded to an integer (setBounds takes integers).
 */
export function computeResizeBounds(
  dir: ResizeDir,
  start: WindowBounds,
  dx: number,
  dy: number,
  min: MinSize,
): WindowBounds {
  let { x, y, width, height } = start;

  // ---- Horizontal axis (e / w) ----
  if (hasEdge(dir, 'e')) {
    // East edge: grow rightward; left edge (x) fixed. Floor the width.
    width = Math.max(min.width, start.width + dx);
  } else if (hasEdge(dir, 'w')) {
    // West edge: the RIGHT edge (start.x + start.width) is the anchor. Moving the
    // left edge by dx shrinks width by dx; clamp width to the floor, then derive
    // x from the FIXED right edge so the opposite side never moves on clamp.
    const right = start.x + start.width;
    width = Math.max(min.width, start.width - dx);
    x = right - width;
  }

  // ---- Vertical axis (n / s) ----
  if (hasEdge(dir, 's')) {
    // South edge: grow downward; top edge (y) fixed. Floor the height.
    height = Math.max(min.height, start.height + dy);
  } else if (hasEdge(dir, 'n')) {
    // North edge: the BOTTOM edge (start.y + start.height) is the anchor. Moving
    // the top edge by dy shrinks height by dy; clamp to the floor, then derive y
    // from the FIXED bottom edge so the opposite side never moves on clamp.
    const bottom = start.y + start.height;
    height = Math.max(min.height, start.height - dy);
    y = bottom - height;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}
