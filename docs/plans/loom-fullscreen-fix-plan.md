# Loom Fullscreen Positioning Fix — Implementation Plan

**Project:** loom-fullscreen-fix  
**Phase:** plan:approved  
**Author:** dr-priya-nair  
**Date:** 2026-06-08

---

## Goal

Fix the ~1cm top+left offset when the Loom window is maximized on Linux by extracting a pure `linuxMaximizeBounds` helper and correcting bounds in the `maximize` event handler.

---

## Tech Constraints

- **Language:** TypeScript (main process); Node.js `--test` for unit tests (ESM `.mjs`)
- **Build:** esbuild via `build.mjs`; testable functions must be exported through `src/testkit-entry.ts` → `dist/testkit.cjs`
- **Electron APIs allowed in `main.ts` only:** `screen.getAllDisplays()`, `BrowserWindow.setBounds()`
- **Pure helper must be Electron-free** so it can be bundled into `testkit.cjs`
- **Platform guard required:** the Linux-specific code path must check `process.platform === 'linux'`

---

## Tasks

### Task 1 — Write failing test for `linuxMaximizeBounds`

**File:** `test/linux-maximize.mjs` *(new)*

**Failing test first:**

```js
// Before linuxMaximizeBounds exists in testkit, this import fails with
// "linuxMaximizeBounds is not a function" — that is the RED.
import test from 'node:test';
import assert from 'node:assert/strict';
const { linuxMaximizeBounds } = await import('../dist/testkit.cjs');
assert.throws(() => linuxMaximizeBounds === undefined);
```

Write all three assertions in the file (they will all fail until Task 2–3):

1. **Single display:** window at (100,100,800,600); display workArea {x:0, y:0, w:1920, h:1040} → returns `{x:0, y:0, width:1920, height:1040}`.
2. **Multi-display nearest:** display A at bounds.x=0, display B at bounds.x=1920; window at x=2100 (on B) → returns display B's workArea, not A's.
3. **Empty displays fallback:** `linuxMaximizeBounds(winBounds, [])` → returns `winBounds` unchanged (safety: never crash when display list is empty).

**Run tests (they must fail RED):**
```
npm run build && node --test test/linux-maximize.mjs
```

**Commit message:** `test(main): failing tests for linuxMaximizeBounds helper`

---

### Task 2 — Create `src/main/linux-maximize.ts`

**File:** `src/main/linux-maximize.ts` *(new)*

**Implementation:**

```typescript
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

  let nearest = displays[0];
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
```

**Run tests (must now be GREEN):**
```
npm run build && node --test test/linux-maximize.mjs
```

**Commit message:** `feat(main): linuxMaximizeBounds pure helper`

---

### Task 3 — Export `linuxMaximizeBounds` from testkit-entry

**File:** `src/testkit-entry.ts` *(modify — append at end)*

Add:
```typescript
// Pure Linux maximize bounds correction (frameless WM frame-offset fix).
// Re-exported so the node --test suite can pin the display-selection logic
// (nearest display by center distance, workArea return, empty-list fallback)
// without Electron.
export { linuxMaximizeBounds } from './main/linux-maximize.js';
export type { DisplayInfo } from './main/linux-maximize.js';
```

**Run tests (must still be GREEN):**
```
npm run build && node --test test/linux-maximize.mjs
```

**Commit message:** `build: export linuxMaximizeBounds from testkit`

---

### Task 4 — Add test file to `package.json` test script

**File:** `package.json` *(modify)*

In the `"test"` script, append `test/linux-maximize.mjs` after `test/window-resize.mjs`:
```
"test": "node --test test/acceptance.mjs ... test/window-resize.mjs test/linux-maximize.mjs"
```

**Run full suite (must be GREEN, 239+N tests):**
```
npm test
```

**Commit message:** `build: add linux-maximize test to npm test`

---

### Task 5 — Fix `src/main/main.ts` maximize behavior on Linux

**File:** `src/main/main.ts` *(modify)*

**Step A — Imports:**

Add `linuxMaximizeBounds` to the main.ts imports (top of file, with other local imports):
```typescript
import { linuxMaximizeBounds } from './linux-maximize.js';
```

Verify `screen` is already imported from `'electron'` (it is used by `clampOrigin`). If not, add it.

**Step B — Module-level pre-maximize bounds store:**

After the existing module-level constants (e.g. after `MAX_WINDOW_DIM`), add:
```typescript
// Per-window pre-maximize bounds (Linux only). Keyed by BrowserWindow instance;
// WeakMap avoids retaining a closed window. Populated in the IPC maximize path
// and consumed on unmaximize to restore the correct pre-maximize size+position
// (the WM's own restore point may shift after our setBounds override).
const preMaximizeBoundsMap = new WeakMap<BrowserWindow, Electron.Rectangle>();
```

**Step C — Modify `registerWindowControlHandlers` maximize handler:**

Change `WINDOW_TOGGLE_MAXIMIZE` handler (line 523–528):
```typescript
ipcMain.handle(IPC.WINDOW_TOGGLE_MAXIMIZE, (evt) => {
  const win = senderWindow(evt);
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    if (process.platform === 'linux') {
      // Capture bounds BEFORE the WM moves the window so the restore on
      // unmaximize returns to the correct pre-maximize position.
      preMaximizeBoundsMap.set(win, win.getBounds());
    }
    win.maximize();
  }
});
```

**Step D — Modify `createMainWindow` to add Linux event listeners:**

In `createMainWindow`, BEFORE the `pushMaximized` definition and its event registrations (after line 670 `registerWindowControlHandlers()`), insert:
```typescript
// Linux frameless maximize correction. On some window managers (Mutter, KWin)
// a frameless window receives a ~1cm top+left decoration-frame offset when
// maximized. We intercept the post-WM `maximize` event and override with the
// workArea of the display the window is on, then restore explicit pre-maximize
// bounds on unmaximize (the WM's own restore point may have shifted).
if (process.platform === 'linux') {
  win.on('maximize', () => {
    if (win.isDestroyed()) return;
    const corrected = linuxMaximizeBounds(
      win.getBounds(),
      screen.getAllDisplays(),
    );
    win.setBounds(corrected);
  });
  win.on('unmaximize', () => {
    if (win.isDestroyed()) return;
    const prev = preMaximizeBoundsMap.get(win);
    if (prev) {
      win.setBounds(prev);
      preMaximizeBoundsMap.delete(win);
    }
  });
}
```

**Important:** these listeners must be registered BEFORE `win.on('maximize', pushMaximized)` so bounds correction fires before the renderer is notified.

**Run full test suite:**
```
npm run build && npm test
```

All 239+ tests must pass. TypeScript must compile cleanly:
```
npm run typecheck
```

**Self-review checklist:**
- [ ] `process.platform === 'linux'` guard present in both Step C and Step D
- [ ] `preMaximizeBoundsMap` is a `WeakMap` (no memory leak on window close)
- [ ] `win.isDestroyed()` guard in maximize/unmaximize handlers
- [ ] Linux listeners registered BEFORE `pushMaximized` listeners
- [ ] No new IPC channels added
- [ ] `screen` is imported from `'electron'` (not duplicated)
- [ ] `linuxMaximizeBounds` import path is `'./linux-maximize.js'` (ESM extension)
- [ ] TypeScript compiles cleanly (no type errors)

**Commit message:** `fix(main): correct maximize position on Linux (frameless WM frame offset)`

---

## Dependency order

```
Task 1 (failing tests) → Task 2 (implementation) → Task 3 (testkit export) → Task 4 (npm test) → Task 5 (main.ts integration)
```

Tasks 3 and 4 can be done together. Task 5 is independent of Tasks 1–4 but should go last so the tests prove correctness first.
