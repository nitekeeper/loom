/* ============================================================
 * Loom — renderer entry (React root)
 * ------------------------------------------------------------
 * Bundled as an IIFE (format=iife, platform=browser). Mounts the
 * App into #root and bootstraps state from window.loom (the only
 * privileged surface). NO Node APIs here (nodeIntegration:false).
 *
 * Imports renderer.css so esbuild bundles it to dist/renderer.css,
 * which index.html links.
 * ============================================================ */
import './styles/renderer.css';
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { App } from './components/App.js';

/** Stamp the host platform onto <html data-platform> BEFORE first paint so
 *  platform-gated CSS (notably the macOS hiddenInset title-bar padding +
 *  drag-region) applies to the very first render, including the pre-boot
 *  shell. The value comes from the preload bridge (window.loom.platform =
 *  process.platform); we fall back to 'linux' if the bridge is somehow absent
 *  so the safe default (native frame, no inset padding) is used. */
function applyPlatformAttr(): void {
  let platform = 'linux';
  try {
    if (typeof window !== 'undefined' && typeof window.loom?.platform === 'string') {
      platform = window.loom.platform;
    }
  } catch {
    /* window.loom unavailable (e.g. a future test harness); keep the default. */
  }
  document.documentElement.setAttribute('data-platform', platform);
}

export function mount(): void {
  applyPlatformAttr();
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('renderer.mount: #root not found');
  }
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

mount();
