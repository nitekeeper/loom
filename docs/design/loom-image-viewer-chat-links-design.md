# Design: Loom Image Viewer + Chat Link Opening

## 1. Goal

Render PNG/JPEG/GIF/WEBP/BMP/ICO/AVIF/TIFF images and SVG files visually in the Viewer pane, and enable safe opening of http/https/mailto links from agent chat messages in the user's default browser.

## 2. Scope

- **Image rendering**: PNG, JPEG, GIF, WEBP, BMP, ICO, AVIF, TIFF files open in the Viewer as actual rendered images (not a placeholder) using a data URI passed from the main process.
- **SVG rendering**: SVG files show a rendered visual preview (via `<img src="data:image/svg+xml;base64,…">`) above the existing source-code view — both visual and source are visible.
- **Size cap**: Images/SVG over 10 MB fall back to the existing placeholder/metadata card.
- **Chat links**: Clicking a safe http/https/mailto link in an agent chat message body opens the URL in the user's default browser via `shell.openExternal`. Links are validated by the existing `safeExternalUrl` gate in `shared/url.ts`.
- **Security preserved**: SVG is rendered via `<img>` (not inline SVG), preventing script execution and external resource loads. The existing CSP `img-src 'self' data:` covers data URIs.

## 3. Non-goals

- **No Node APIs in the renderer**: image bytes are read and base64-encoded exclusively in `main/sandbox.ts`.
- **No `<webview>` or dynamic `<script>`** for image rendering.
- **No change to `FileContent.text`**: SVG still returns UTF-8 text for the source view.
- **No inline SVG injection** (`dangerouslySetInnerHTML` is not used for SVG).
- **No new link schemes**: only http/https/mailto pass the existing `safeExternalUrl` gate.
- **No new IPC channels**: the existing `OPEN_EXTERNAL` channel and `openExternal` bridge method are sufficient.

## 4. Acceptance Criteria

- AC-1: Selecting a PNG, JPEG, GIF, WEBP, BMP, ICO, AVIF, or TIFF file ≤10 MB in the Explorer renders the image in the Viewer body (not the placeholder text).
- AC-2: Selecting an SVG file ≤10 MB shows the rendered SVG image above the source code block with the safety banner.
- AC-3: An image or SVG file >10 MB shows the existing safe placeholder / metadata card (unchanged fallback).
- AC-4: Clicking an `[text](https://…)` link in a chat message body opens the URL in the OS default browser (not in-app).
- AC-5: Clicking a link with a dangerous scheme (javascript:, file:, data:) in chat does NOT open anything.
- AC-6: `npm test` passes with ≥239 tests (no regressions).
- AC-7: `npm run build` succeeds with no TypeScript errors.
- AC-8: The render-state badge shows `PREVIEW` for images; SVG continues to show `SOURCE`.

## 5. Constraints

- TypeScript strict mode — no `any` casts, no unchecked array access without guard.
- The existing security model (Law 1/2/3 from the sandbox) must not be weakened.
- CSP: the existing `img-src 'self' data:` policy already allows data URIs — no CSP change needed.
- The preload bridge and IPC channel list are already complete — no new IPC channels.
- The `OPEN_EXTERNAL` IPC handler in `ipc.ts` already re-validates URLs — no change needed there.

## 6. Stakeholders

- **User (Loom observer)**: wants to see image files rendered and click links in chat to browse references without leaving Loom.

## 7. Dependencies / Prerequisites

- `src/shared/types.ts` — `FileContent` interface (adding `imageData` field)
- `src/main/sandbox.ts` — `readFile()` (reading image bytes as base64)
- `src/shared/dispatch.ts` — unchanged dispatch logic; only comment update
- `src/renderer/components/Viewer.tsx` — PREVIEW and SOURCE/SVG branches
- `src/renderer/styles/renderer.css` — new `.img-preview` and `.svg-preview-wrap` rules
- `src/renderer/lib/anchor-guard.ts` — already implements link-open logic (verify only)
- `src/renderer/components/App.tsx` — already mounts `installGlobalAnchorGuard()` (verify only)

## 8. Risks / Unknowns

- **Risk: SVG data URI rendering browser support** — all Chromium-based Electron versions support `<img src="data:image/svg+xml;base64,…">`. Mitigation: accepted; Electron's embedded Chromium is the sole rendering target.
- **Risk: Large image transfer overhead** — a 10 MB image becomes ~13.3 MB base64. The IPC bridge can handle this (Electron's IPC has no practical size limit for in-process comms). Mitigation: accepted with the 10 MB cap.
- **Risk: Chat links already work via anchor-guard** — `anchor-guard.ts` is already mounted and handles `.msg-body` anchors. If `renderInline` does not produce real `<a>` tags for links, no clicking would work. Mitigation: verify `renderInline` produces link anchors before declaring Feature 2 done; fix `Message.tsx` only if needed.

## 9. Success Metrics

- `npm test` green (≥239 tests, zero failures).
- `npm run build` exits 0.
- PNG/JPEG/GIF/SVG/WEBP files selected in the Explorer pane show their actual visual content in the Viewer.
- A markdown link `[foo](https://example.com)` in a chat message, when clicked, opens `https://example.com` in the OS browser.
