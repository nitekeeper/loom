/* ============================================================
 * Loom — Linux frameless edge-resize handles
 * ------------------------------------------------------------
 * A frameless window (frame:false on win32/linux) loses the native resize
 * border. On Windows Electron keeps invisible edge regions so resizing still
 * works; on Linux/GNOME (incl. WSLg) a frameless window often has NO draggable
 * edges, so the user can maximize but cannot free-resize. This component draws
 * our OWN 8 invisible handles (edges n/s/e/w + corners ne/nw/se/sw) along the
 * window border so a Linux user can drag to resize.
 *
 * LINUX ONLY: Windows already resizes via its native invisible borders (custom
 * handles would conflict), and macOS is a native-ish frame (untouched). The
 * handles are also hidden while MAXIMIZED (a maximized window is not edge-
 * resized). The render gate enforces both; renderer.css adds a belt-and-braces
 * CSS gate so they can never show on a non-linux platform.
 *
 * The geometry is delegated to the PURE, unit-tested computeResizeBounds
 * (lib/window-resize.ts) — this file is only the impure drag wiring:
 *   - pointerdown(dir): read the live start bounds (WINDOW_GET_BOUNDS), record
 *     the start screen coords, setPointerCapture so the drag survives leaving the
 *     thin handle.
 *   - pointermove: compute the next bounds from the screen-px delta and apply via
 *     WINDOW_SET_BOUNDS, rAF-throttled (one in-flight write coalesced).
 *   - pointerup / pointercancel / lostpointercapture: release capture, cancel the
 *     pending rAF, clear the active drag.
 *
 * Accessibility: the handles are aria-hidden pointer affordances (keyboard users
 * resize via the OS/maximize). Security (Law 1): they are inert transparent divs
 * — no HTML/JS sink, no agent content. Every window.loom access is optional-
 * chained behind a typeof-window guard so a partial/absent bridge (the capture
 * process, a test harness) no-ops instead of throwing.
 *
 * KNOWN GOTCHA: on fractional-HiDPI scaling, the screen-px pointer delta and the
 * DIP setBounds can drift slightly; on the common WSLg scaleFactor=1 it is 1:1.
 * setMinimumSize (main.ts) gives a hard floor regardless.
 * ============================================================ */
import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { computeResizeBounds, type ResizeDir, type WindowBounds } from '../lib/window-resize.js';

/** The eight handles, in DOM order. The class suffix is the direction; corners
 *  are layered above edges in CSS so a corner drag wins in the overlap zone. */
const HANDLES: readonly ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** Minimum window size floor for the pure geometry. MUST match main.ts MIN_W/
 *  MIN_H (the OS also enforces it via setMinimumSize, so a small drift here is
 *  harmless — the OS floor wins — but they are kept in sync deliberately). */
const MIN: { width: number; height: number } = { width: 720, height: 480 };

/** The window-control surface, read once with a typeof-window guard so a missing
 *  bridge (capture process / tests) yields undefined and every call no-ops. */
function windowControls(): Window['loom']['windowControls'] | undefined {
  try {
    if (typeof window !== 'undefined') return window.loom?.windowControls;
  } catch {
    /* window.loom unavailable; treat as absent. */
  }
  return undefined;
}

/** Host platform, read with the same guard + safe default as index.tsx /
 *  TitleBar ('linux' ⇒ handles render). */
function hostPlatform(): string {
  try {
    if (typeof window !== 'undefined' && typeof window.loom?.platform === 'string') {
      return window.loom.platform;
    }
  } catch {
    /* window.loom unavailable; keep the default. */
  }
  return 'linux';
}

/** The live drag, captured at pointerdown. */
interface ActiveDrag {
  dir: ResizeDir;
  startScreenX: number;
  startScreenY: number;
  startBounds: WindowBounds;
}

/**
 * The 8 invisible Linux frameless edge/corner resize handles. Renders null on
 * any non-linux platform OR while the window is maximized (matching the spec:
 * Windows resizes natively, macOS is untouched, a maximized window is not edge-
 * resized).
 */
export function WindowResizeHandles(): JSX.Element | null {
  // Linux-only (read once; the platform never changes at runtime).
  const isLinux = hostPlatform() === 'linux';
  const [maximized, setMaximized] = useState(false);
  // Tri-state ready gate: isMaximized() is async, so on a window that BOOTS
  // already-maximized `maximized` would initialize false and the 8 handles would
  // flash over the maximized window's edges for the sub-frame until the pull
  // resolves (a drag there would un-maximize+resize). Hold the handles back until
  // the FIRST isMaximized() pull resolves so they never render over a maximized
  // window on mount. (After the seed, live toggles flip `maximized` directly.)
  const [maximizeKnown, setMaximizeKnown] = useState(false);

  // The active drag + the coalesced rAF id + the latest pending bounds. Refs (not
  // state) so a high-frequency pointermove never triggers a React re-render — the
  // resize is a side effect on the window, not UI state.
  const active = useRef<ActiveDrag | null>(null);
  const rafId = useRef<number | null>(null);
  const pendingBounds = useRef<WindowBounds | null>(null);
  // The id of the pointer currently held DOWN on a handle, or null when none is.
  // Set synchronously at pointerdown and cleared synchronously at endDrag, so the
  // async getBounds().then() can tell whether the press is STILL live before it
  // arms the drag — closing the stale-arm race where a fast tap (pointerup before
  // getBounds resolves) would otherwise re-arm `active` after the button is up.
  const downPointer = useRef<number | null>(null);

  // Track maximized so the handles disappear when maximized (an edge drag makes
  // no sense on a maximized window). Seed via the authoritative isMaximized()
  // pull (with a .catch so the capture-only process — which registers no window
  // handlers — fails soft), then subscribe to live changes. Mirrors TitleBar's
  // WindowControls maximize subscription.
  useEffect(() => {
    if (!isLinux) return undefined;
    const controls = windowControls();
    if (!controls) {
      // No bridge (capture process / tests): nothing to gate on — reveal the
      // handles so the linux render path is not permanently suppressed.
      setMaximizeKnown(true);
      return undefined;
    }
    let mounted = true;
    void controls
      .isMaximized()
      .then((m) => {
        if (mounted) {
          setMaximized(m);
          setMaximizeKnown(true);
        }
      })
      .catch(() => {
        // The pull failed (e.g. a handler-less process); don't strand the handles
        // hidden forever — reveal them and rely on the live subscription.
        if (mounted) setMaximizeKnown(true);
      });
    const unsubscribe = controls.onMaximizeChange(setMaximized);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [isLinux]);

  // Cancel any pending rAF on unmount so a late frame never calls setBounds after
  // the component is gone.
  useEffect(() => {
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
    };
  }, []);

  if (!isLinux || maximized || !maximizeKnown) return null;

  /** Flush the latest pending bounds to the window (one in-flight write). */
  const flush = (): void => {
    rafId.current = null;
    const next = pendingBounds.current;
    pendingBounds.current = null;
    if (next === null) return;
    void windowControls()?.setBounds(next)?.catch?.(() => {});
  };

  /** Schedule a coalesced setBounds for the next animation frame. */
  const schedule = (next: WindowBounds): void => {
    pendingBounds.current = next;
    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(flush);
    }
  };

  const onPointerDown = (dir: ResizeDir) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Left button only — ignore right/middle so a context-menu/aux click never
    // starts a resize.
    if (e.button !== 0) return;
    const controls = windowControls();
    if (!controls) return;
    e.preventDefault();
    const target = e.currentTarget;
    const startScreenX = e.screenX;
    const startScreenY = e.screenY;
    // Mark this pointer DOWN synchronously (before the async getBounds resolves)
    // so the .then() can verify the press is STILL live before arming the drag.
    const pointerId = e.pointerId;
    downPointer.current = pointerId;
    // Read the LIVE start bounds, then arm the drag once they resolve. Capture the
    // pointer up front so a fast drag that leaves the thin handle keeps delivering
    // move events to it.
    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* setPointerCapture can throw if the pointer is already gone; ignore. */
    }
    void controls
      .getBounds()
      .then((startBounds) => {
        // STALE-ARM GUARD: if the pointer was released (endDrag cleared/changed
        // downPointer) before getBounds resolved — a fast tap, or a slow IPC
        // roundtrip — do NOT arm. Otherwise a button-less hover over the edge
        // would compute a delta from the stale start and fire a phantom resize.
        if (downPointer.current !== pointerId) return;
        // A degenerate (zero) start rect means the sender window was unresolved —
        // don't arm a drag that would compute nonsense.
        if (startBounds.width <= 0 || startBounds.height <= 0) return;
        active.current = { dir, startScreenX, startScreenY, startBounds };
      })
      .catch(() => {});
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Defense in depth: a move with NO button held can never be a drag. Bail and
    // disarm — this closes the stale-arm race even if a late getBounds().then()
    // armed `active` after the button was already up (no button => no resize).
    if (e.buttons === 0) {
      active.current = null;
      return;
    }
    const drag = active.current;
    if (drag === null) return;
    const dx = e.screenX - drag.startScreenX;
    const dy = e.screenY - drag.startScreenY;
    const next = computeResizeBounds(drag.dir, drag.startBounds, dx, dy, MIN);
    schedule(next);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Clear the down marker FIRST (synchronously) so an in-flight getBounds().then()
    // sees the press is no longer live and refuses to (re-)arm the drag.
    downPointer.current = null;
    active.current = null;
    // Flush the final pending bounds synchronously so the window lands EXACTLY at
    // the last computed position. Cancelling the in-flight rAF without flushing
    // would leave the window up to one frame stale from where the pointer was
    // released (the last pointermove's bounds would be silently dropped).
    const finalBounds = pendingBounds.current;
    pendingBounds.current = null;
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    if (finalBounds !== null) {
      void windowControls()?.setBounds(finalBounds)?.catch?.(() => {});
    }
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* release can throw if the capture is already gone; ignore. */
    }
  };

  return (
    <div className="win-resize" aria-hidden="true">
      {HANDLES.map((dir) => (
        <div
          key={dir}
          className={`win-resize-handle win-resize-${dir}`}
          // Inert pointer affordance: decorative, keyboard users resize via the OS.
          aria-hidden="true"
          onPointerDown={onPointerDown(dir)}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        />
      ))}
    </div>
  );
}
