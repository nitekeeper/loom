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

export function mount(): void {
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
