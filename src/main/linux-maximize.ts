export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  bounds: Rect;
  workArea: Rect;
}

/** Overlap area between two rects (0 when disjoint). */
function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function linuxMaximizeBounds(
  winBounds: Rect,
  displays: ReadonlyArray<DisplayInfo>,
): Rect {
  if (displays.length === 0) return winBounds;

  // Pick the display the window is actually ON: largest bounds-intersection
  // area (Electron getDisplayMatching semantics). Nearest-display-CENTER is
  // wrong with mixed-resolution monitors — a window fully on one display can
  // sit closer to the OTHER display's center (e.g. on a large secondary near
  // the edge shared with a small primary), which maximized the window onto
  // the wrong monitor.
  let best: DisplayInfo | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const area = intersectionArea(winBounds, d.bounds);
    if (area > bestArea) {
      bestArea = area;
      best = d;
    }
  }
  if (best) return best.workArea;

  // Fallback (window fully offscreen, e.g. mid-drag past an edge): nearest
  // display by center distance, so we always resolve to a real display.
  const cx = winBounds.x + winBounds.width / 2;
  const cy = winBounds.y + winBounds.height / 2;
  let nearest: DisplayInfo = displays[0]!;
  let minDist = Infinity;
  for (const d of displays) {
    const dcx = d.bounds.x + d.bounds.width / 2;
    const dcy = d.bounds.y + d.bounds.height / 2;
    const dist = Math.hypot(cx - dcx, cy - dcy);
    if (dist < minDist) {
      minDist = dist;
      nearest = d;
    }
  }
  return nearest.workArea;
}

export interface WslMaximizeDecision {
  bounds: Rect;
  isMaximized: boolean;
}

/** Per-edge tolerance (px) for "still at its maximized bounds" detection.
 *  WSLg/Mutter can perturb applied bounds by a pixel or two after setBounds
 *  (DIP rounding under fractional display scale); exact equality would then
 *  make every toggle re-maximize and restore unreachable (stuck-maximized
 *  loop). A real drag moves the window far more than this. */
const MAXIMIZED_BOUNDS_TOLERANCE = 2;

/** Rect equality with a small per-field tolerance (x, y, width, height each
 *  within MAXIMIZED_BOUNDS_TOLERANCE px). */
function rectsAlmostEqual(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= MAXIMIZED_BOUNDS_TOLERANCE &&
    Math.abs(a.y - b.y) <= MAXIMIZED_BOUNDS_TOLERANCE &&
    Math.abs(a.width - b.width) <= MAXIMIZED_BOUNDS_TOLERANCE &&
    Math.abs(a.height - b.height) <= MAXIMIZED_BOUNDS_TOLERANCE
  );
}

/** Compute the target bounds and resulting maximize state for a manual
 *  toggle on WSL2/WSLg — bypasses win.maximize() entirely to avoid Mutter's
 *  frame-decoration offset applied to frameless windows on maximize.
 *
 *  Stale-flag recovery: the fake-maximized state is only a flag — the WM still
 *  lets the user DRAG the window (e.g. onto another monitor) without any
 *  unmaximize event firing. If the flag says "maximized" but the window no
 *  longer sits at the maximized workArea of the display now under it (beyond
 *  the small WM-rounding tolerance of rectsAlmostEqual), the user moved it:
 *  the toggle RE-MAXIMIZES onto the current display instead of restoring
 *  stale pre-maximize bounds recorded on the old monitor. */
export function computeWslToggleMaximize(
  isManualMaximized: boolean,
  currentBounds: Rect,
  preMaxBounds: Rect | null,
  displays: ReadonlyArray<DisplayInfo>,
): WslMaximizeDecision {
  const target = linuxMaximizeBounds(currentBounds, displays);
  if (isManualMaximized) {
    if (!rectsAlmostEqual(currentBounds, target)) {
      // Dragged/moved while fake-maximized — re-maximize onto the display
      // currently under the window (the caller keeps preMaxBounds intact so a
      // later undisturbed toggle still restores the original floating bounds).
      return { bounds: target, isMaximized: true };
    }
    return { bounds: preMaxBounds ?? currentBounds, isMaximized: false };
  }
  return { bounds: target, isMaximized: true };
}
