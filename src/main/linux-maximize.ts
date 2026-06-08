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

export function linuxMaximizeBounds(
  winBounds: Rect,
  displays: ReadonlyArray<DisplayInfo>,
): Rect {
  if (displays.length === 0) return winBounds;

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

/** Compute the target bounds and resulting maximize state for a manual
 *  toggle on WSL2/WSLg — bypasses win.maximize() entirely to avoid Mutter's
 *  frame-decoration offset applied to frameless windows on maximize. */
export function computeWslToggleMaximize(
  isManualMaximized: boolean,
  currentBounds: Rect,
  preMaxBounds: Rect | null,
  displays: ReadonlyArray<DisplayInfo>,
): WslMaximizeDecision {
  if (isManualMaximized) {
    return { bounds: preMaxBounds ?? currentBounds, isMaximized: false };
  }
  return { bounds: linuxMaximizeBounds(currentBounds, displays), isMaximized: true };
}
