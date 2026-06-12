# Plan: Loom Image Viewer + Chat Link Opening

## Goal

Render raster images (PNG/JPEG/GIF/WEBP/BMP/ICO/AVIF/TIFF) and SVG files visually in the Viewer, and open safe http/https/mailto links in agent chat messages in the OS browser.

## Tech Constraints

- TypeScript strict mode (`src/tsconfig.json`): no `any`, no unchecked array access without guards.
- All image reading happens in `main/sandbox.ts` (Node.js process); renderer never decodes bytes.
- SVG rendered via `<img src="data:image/svg+xml;base64,…">` — no inline SVG injection.
- Existing CSP `img-src 'self' data:` in `index.html` already allows data URIs.
- No new IPC channels — `OPEN_EXTERNAL` + `openExternal` bridge already exist.
- `npm test` ≥239 passing; `npm run build` exits 0.

## Tasks

### Task 1 — Add `imageData` to `FileContent` type  
**Files**: `src/shared/types.ts`  
**Test**: `tests/shared/types.test.ts` (or nearest existing test that creates a `FileContent` object — verify it still compiles after adding the optional field)  
**Implementation**:  
- In the `FileContent` interface, add:
  ```ts
  /** Base64 data URI for raster images and SVG (e.g. `data:image/png;base64,…`),
   *  present when the file fits within the 10 MB image size cap; null otherwise. */
  imageData?: string | null;
  ```
- This is additive and optional — existing code compiles unchanged.  
**Run tests**: `npm run build && npm test`  
**Commit**: `feat(types): add optional imageData field to FileContent for image rendering`

---

### Task 2 — Read image/SVG bytes as base64 in sandbox  
**Files**: `src/main/sandbox.ts`  
**Test**: `tests/main/sandbox.test.ts` — add tests verifying:
  1. A PNG/JPEG file ≤10 MB has `imageData` set to a `data:image/png;base64,…` string
  2. An SVG file ≤10 MB has `imageData` set + `text` still populated (non-null)
  3. A file over 10 MB returns `imageData: null`
  4. The MIME mapping covers png/jpeg/gif/webp/bmp/ico/avif/tiff/svg correctly  
**Implementation**:  
- Add constant `MAX_IMAGE_BYTES = 10 * 1024 * 1024` near `MAX_TEXT_BYTES`.
- Add pure helper `mimeFor(name: string): string`:
  ```ts
  function mimeFor(name: string): string {
    const ext = extensionOf(name);
    const map: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      ico: 'image/x-icon', avif: 'image/avif', tiff: 'image/tiff',
      svg: 'image/svg+xml',
    };
    return map[ext] ?? 'application/octet-stream';
  }
  ```
- In `readFile()`, after computing `dispatch` and `meta`, add image reading:
  ```ts
  let imageData: string | null = null;
  if ((dispatch.kind === 'image' || dispatch.kind === 'svg') && st.size <= MAX_IMAGE_BYTES) {
    try {
      const buf = readFileSync(abs);
      imageData = `data:${mimeFor(name)};base64,${buf.toString('base64')}`;
    } catch {
      imageData = null;
    }
  }
  ```
- Change the `return` to include `imageData`:
  ```ts
  return { path: relPosix, dispatch, meta, text, imageData };
  ```
- SVG: `isTextKind()` still returns true for SVG, so `text` is still populated — the SVG source view is unchanged.  
**Run tests**: `npm run build && npm test`  
**Commit**: `feat(sandbox): read image/SVG bytes as base64 for in-app rendering`

---

### Task 3 — Render images in the Viewer PREVIEW branch  
**Files**: `src/renderer/components/Viewer.tsx`, `src/renderer/styles/renderer.css`  
**Test**: Visual inspection (build + run). No new unit tests needed for the React render path.  
**Implementation**:  
In `ViewerContent` in `Viewer.tsx`, update the `renderState === 'PREVIEW'` branch:
```tsx
} else if (renderState === 'PREVIEW') {
  body = content.imageData ? (
    <div className="imgwrap">
      <img
        src={content.imageData}
        alt={fileName}
        className="img-preview"
      />
    </div>
  ) : (
    <div className="imgwrap">
      <div className="imgprev" role="img" aria-label={`${meta.type} safe preview placeholder`}>
        <span className="ph">{meta.type} · safe preview</span>
      </div>
    </div>
  );
}
```
For SVG (SOURCE branch), add a visual preview above the source. Just before the `body` assignment for `renderState === 'SOURCE'`, check for SVG:
- The existing SOURCE branch renders `<CodeView …>`. Wrap the body in a fragment to prepend the SVG image when `dispatch.kind === 'svg' && content.imageData`:
```tsx
} else if (renderState === 'SOURCE') {
  const codeView = (
    <CodeView
      code={text ?? ''}
      path={path}
      startFolded={startFolded}
      registerFoldAll={registerFoldAll}
      foldCommand={foldCommand}
      targetLine={targetLine}
    />
  );
  body = dispatch.kind === 'svg' && content.imageData ? (
    <>
      <div className="svg-preview-wrap">
        <img
          src={content.imageData}
          alt={`${fileName} preview`}
          className="img-preview"
        />
      </div>
      {codeView}
    </>
  ) : codeView;
}
```

In `renderer.css`, add:
```css
/* Image viewer */
.img-preview {
  max-width: 100%;
  max-height: 70vh;
  display: block;
  margin: auto;
  object-fit: contain;
}

.svg-preview-wrap {
  padding: 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-alt, var(--bg));
}
```

**Run tests**: `npm run build && npm test`  
**Commit**: `feat(viewer): render PNG/JPEG/SVG images in-app via base64 data URIs`

---

### Task 4 — Verify chat link opening  
**Files**: `src/renderer/components/Message.tsx` (possible fix), `src/renderer/lib/anchor-guard.ts` (read-only verify)  
**Test**: Verify `renderInline` produces `<a href=… data-loom-ext="1">` for `[text](https://url)` markdown. Check existing test coverage.  
**Implementation**:  
1. Verify `anchor-guard.ts` is mounted: `App.tsx` has `useEffect(() => installGlobalAnchorGuard(), [])` — confirmed present.
2. Verify `renderInline` handles links: the same `md` instance with `linkOpenRule` override is used for both `renderMarkdown` and `renderInline`. Test in an existing test or manually confirm.
3. If `renderInline` does NOT produce link anchors (unlikely — markdown-it's renderInline supports links), update `blockBodyNavigation` in `Message.tsx` to call `window.loom.openExternal(href)` for `data-loom-ext='1'` anchors.
4. The existing `blockBodyNavigation` calls `e.preventDefault()` for ALL anchors — that's fine; the anchor-guard (capture phase, document-level) fires before React's bubble handlers and handles the `openExternal` call.  
**Run tests**: `npm run build && npm test`  
**Commit**: `feat(chat): verify/fix link-open via anchor-guard for agent chat messages`
