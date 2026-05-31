/* ============================================================
 * Loom — App shell (FR-34, AC-17)
 * ------------------------------------------------------------
 * The window root: a CSS grid of rows `auto auto 1fr` —
 * TitleBar (chrome) / StatusBar (chrome) / body of three content
 * panes (Explorer | Viewer | Chat). NO terminal pane (OQ-6).
 * Owns top-level UI state: selected file, active channel, theme,
 * derived from the LoomStore (FR-14 single source of truth).
 * ============================================================ */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import type { FileContent, Theme } from '../../shared/types.js';
import { createStore } from '../lib/client.js';
import type { LoomStore, ViewModel } from '../lib/client.js';
import { TitleBar } from './TitleBar.js';
import { StatusBar } from './StatusBar.js';
import { Explorer } from './Explorer.js';
import { Viewer } from './Viewer.js';
import { Chat } from './Chat.js';

/** Subscribe a React component to the store via useSyncExternalStore. */
function useViewModel(store: LoomStore): ViewModel | null {
  return useSyncExternalStore(store.subscribe, store.getViewModel, store.getViewModel);
}

/** Resolve FileContent for the selected path via the readFile bridge.
 *  Returns null while empty or loading; ignores stale responses. */
function useFileContent(selected: string | null): FileContent | null {
  const [content, setContent] = useState<FileContent | null>(null);
  // Track the latest request so an out-of-order resolve can't clobber state.
  const requestId = useRef(0);

  useEffect(() => {
    if (selected === null) {
      setContent(null);
      return;
    }
    const id = ++requestId.current;
    let cancelled = false;
    void window.loom
      .readFile(selected)
      .then((c) => {
        if (!cancelled && id === requestId.current) setContent(c);
      })
      .catch(() => {
        if (!cancelled && id === requestId.current) setContent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return content;
}

/** Containers whose innerHTML is agent-authored, renderer-sanitized markdown
 *  (Viewer `.md`, chat `.msg-body`, inbox `.ib-body`). Neutralized links in
 *  these already carry NO href, but we belt-and-braces preventDefault any
 *  anchor activation (mouse click OR keyboard Enter/Space) globally so a
 *  link can never navigate even if a future sink slips an href through
 *  (AC-21 / FR-52 / SEC-5). */
const RENDERED_MARKDOWN_SELECTOR = '.md, .msg-body, .ib-body';

function installGlobalAnchorGuard(): () => void {
  const onActivate = (e: Event): void => {
    if (e instanceof KeyboardEvent) {
      const k = e.key;
      if (k !== 'Enter' && k !== ' ' && k !== 'Spacebar') return;
    }
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const anchor = target.closest('a');
    if (anchor && anchor.closest(RENDERED_MARKDOWN_SELECTOR)) {
      e.preventDefault();
    }
  };
  // Capture phase so we run before any bubbling default-navigation occurs.
  document.addEventListener('click', onActivate, true);
  document.addEventListener('keydown', onActivate, true);
  return () => {
    document.removeEventListener('click', onActivate, true);
    document.removeEventListener('keydown', onActivate, true);
  };
}

export function App(): JSX.Element {
  // One store instance for the lifetime of the app.
  const store = useMemo(() => createStore(), []);
  const started = useRef(false);

  // Global belt-and-braces anchor-navigation guard (AC-21 / SEC-5).
  useEffect(() => installGlobalAnchorGuard(), []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void store.start();
  }, [store]);

  const vm = useViewModel(store);

  // Apply the persisted theme to <html data-theme> (FR-37, AC-20).
  const theme: Theme = vm?.theme ?? 'dark';
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const content = useFileContent(vm?.selected ?? null);

  if (vm === null) {
    // Pre-boot: render the empty shell so the window is never blank.
    return (
      <div className="win" aria-busy="true">
        <TitleBar rootName="loom" />
      </div>
    );
  }

  return (
    <div className="win">
      <TitleBar rootName={vm.rootName} />
      <StatusBar
        liveState={vm.liveState}
        counters={vm.counters}
        theme={vm.theme}
        onTogglePause={() => void store.togglePause()}
        onToggleTheme={() =>
          void store.setTheme(vm.theme === 'dark' ? 'light' : 'dark')
        }
      />
      <div className="body">
        <Explorer
          rootName={vm.rootName}
          tree={vm.tree}
          selected={vm.selected}
          onSelect={(path) => store.selectFile(path)}
          flashing={vm.flashing}
          justModified={vm.justModified}
          newlyAdded={vm.newlyAdded}
        />
        <Viewer content={content} />
        <Chat
          agents={vm.agents}
          channels={vm.channels}
          messages={vm.messages}
          paused={vm.liveState === 'PAUSED'}
          activeChannel={vm.activeChannel}
          inboxAgent={vm.inboxAgent}
          onSelectChannel={(name) => store.setActiveChannel(name)}
          onOpenInbox={(name) => store.openInbox(name)}
          onCloseInbox={() => store.closeInbox()}
        />
      </div>
    </div>
  );
}
