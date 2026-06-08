# Loom Fullscreen Positioning Fix — Design Document

**Project:** loom-fullscreen-fix  
**Phase:** design:approved  
**Author:** dr-priya-nair  
**Date:** 2026-06-08

---

## 1. Goal

When the Loom window is maximized on Linux, it shall fill the current display's work area with no visible positional offset on any edge.

---

## 2. Scope

- Fix the `WINDOW_TOGGLE_MAXIMIZE` IPC handler in `src/main/main.ts` so that on Linux, maximizing calls `win.setBounds(display.workArea)` on the display nearest the window, rather than relying on `win.maximize()` which allows the window manager to apply its own frame decoration offset.
- Add a unit-testable pure helper (`linuxMaximizeBounds(winBounds, displays)`) that computes the correct work-area bounds for a given window position — enabling regression coverage without E2E.
- Apply the fix only when `process.platform === 'linux'`.

---

## 3. Non-goals

- OS-level fullscreen (`setFullScreen` / F11) — not currently implemented and not requested.
- macOS or Windows maximize behavior — both work correctly; no changes.
- Redesigning or restyling the custom chrome or titlebar.
- Multi-display spanning or snapping features.

---

## 4. Acceptance Criteria

1. **[Boolean]** On Linux: after clicking maximize, `win.getBounds()` returns coordinates equal to `screen.getDisplayNearestPoint(priorBounds).workArea`.
2. **[Boolean]** On Linux: clicking maximize then unmaximize restores the window to its pre-maximize size and position (within 1px).
3. **[Boolean]** On macOS and Windows: `win.maximize()` / `win.unmaximize()` is still called; `setBounds` is not called during maximize.
4. **[Boolean]** The new `linuxMaximizeBounds` helper: given a window rect that falls on display A in a two-display setup, returns display A's workArea (not display B's).
5. **[Boolean]** All 239 existing unit tests pass without modification.
6. **[Boolean]** Edge-resize handles (`WindowResizeHandles.tsx`) still render and respond when the window is not maximized, same as before.

---

## 5. Constraints

- The fix must not call `win.setBounds()` on macOS or Windows (platform guard required).
- Must not skip or modify the existing `MAX_WINDOW_DIM` / `MIN_W` / `MIN_H` guards that protect against runaway bounds.
- Must not introduce new IPC channels — uses existing `WINDOW_TOGGLE_MAXIMIZE`.

---

## 6. Stakeholders

- **User/developer** running Loom on Linux (WSL2 or native) — wants the window to actually fill the screen when maximized.

---

## 7. Dependencies / Prerequisites

- Electron `screen` API: `screen.getDisplayNearestPoint({ x, y })` — available in Electron main process, no version change needed.
- `src/main/main.ts` — the only file requiring changes.
- `src/shared/types.ts` — no changes (IPC constants unchanged).

---

## 8. Risks / Unknowns

| Risk | Mitigation |
|---|---|
| Window manager returns bounds before position settles, causing a race between `win.setBounds()` and the WM's own maximize geometry | **Mitigate:** call `win.setBounds` in the `maximize` event handler (after the WM has acted), not before. If the race persists, wrap in a `setImmediate` defer as a fallback. |
| WSL2 `workArea` may report different coordinates than native Linux (XCB vs. WSLg) | **Accept:** hard to test in CI; manual verification by the user is the gate. A regression here is visible immediately. |
| `getDisplayNearestPoint` called at maximize time uses stale window position if window is mid-drag | **Mitigate:** call `win.getBounds()` first, then `getDisplayNearestPoint` — same pattern already used by `clampOrigin()`. |
| Unmaximize restores to the wrong size (if we called `setBounds` instead of native `maximize`) | **Mitigate:** capture `win.getBounds()` before calling `setBounds`; on `unmaximize` event, restore captured bounds. |

---

## 9. Success Metrics

- **[Boolean]** Manual verify: on Linux, clicking maximize fills the screen edge-to-edge with no visible gap. User confirms.
- **[Boolean]** New unit test for `linuxMaximizeBounds` passes in CI.
- **[Boolean]** All 239 existing tests still pass in CI.
