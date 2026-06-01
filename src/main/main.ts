/* ============================================================
 * Loom — Electron main process entry (FR-14, NFR-8)
 * ------------------------------------------------------------
 * The single source of truth. Owns: the sql.js store (db.ts),
 * the engine (engine.ts), the MCP server (mcp.ts), the event
 * bus (eventbus.ts), the chokidar watcher (watcher.ts), config
 * (config.ts), the sandbox (sandbox.ts), and the BrowserWindow
 * lifecycle + IPC handlers (ipc.ts).
 * ============================================================ */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { createDb } from './db.js';
import { createEventBus } from './eventbus.js';
import { createEngine } from './engine.js';
import { createMcpServer } from './mcp.js';
import { createSandbox } from './sandbox.js';
import { createSearch } from './search.js';
import { createWatcher } from './watcher.js';
import { createConfigStore } from './config.js';
import { createIpcWiring } from './ipc.js';
import { createWsFeed, wsEnabled } from './ws.js';

/** Capture window dimensions (FR — headless screenshots via a normal,
 *  WSLg-composited hidden window; see runCapture + applyWslSwitches). */
const CAPTURE_WIDTH = 1440;
const CAPTURE_HEIGHT = 900;
/** Settle delay after did-finish-load before we capture. */
const CAPTURE_SETTLE_MS = 1500;
/** Hard ceiling: a capture that hangs must still exit the process. */
const CAPTURE_TIMEOUT_MS = 30_000;

/** Parsed --capture invocation. */
interface CaptureArgs {
  out: string;
  select: string | null;
  channel: string | null;
  inbox: string | null;
  /** Capture-only theme override ('dark' | 'light'), or null to keep config. */
  theme: string | null;
  /** Capture-only chat-pane width override (px), or null. */
  chatw: string | null;
  /** Capture-only explorer-pane width override (px), or null. */
  explorerw: string | null;
  /** Capture-only flag to start with the Explorer collapsed. */
  explorerHidden: boolean;
  /** Capture-only flag to start with the Chat collapsed. */
  chatHidden: boolean;
  /** Capture-only flag to start a SOURCE file with all top-level folds
   *  collapsed (so a headless screenshot can show the folded state). */
  foldAll: boolean;
  /** Capture-only flag to open the Keyboard Shortcuts panel on boot (so a
   *  headless screenshot can prove the modal). */
  shortcuts: boolean;
  /** Capture-only content-search query: opens the Explorer SEARCH mode,
   *  prefills the input, and runs the query on boot. null when absent. */
  search: string | null;
  /** Capture-only flag to open the FIRST search result at its line on boot
   *  (so a headless screenshot can prove the reveal). */
  searchOpen: boolean;
  replay: boolean;
}

/** Pull a `--flag value` pair out of argv, or null when absent. */
function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) {
    const v = argv[i + 1];
    return v === undefined ? null : v;
  }
  return null;
}

/** Parse --capture <out.png> and its companions, or null when not capturing. */
function parseCapture(argv: string[]): CaptureArgs | null {
  const out = flagValue(argv, '--capture');
  if (!out) return null;
  return {
    out,
    select: flagValue(argv, '--select'),
    channel: flagValue(argv, '--channel'),
    inbox: flagValue(argv, '--inbox'),
    theme: flagValue(argv, '--theme'),
    // UX-CHAT-03: standardize on the dashed `--chat-w` to match `--explorer-w`
    // and the `--chat-hidden`/`--explorer-hidden` style. The legacy `--chatw`
    // (no separator) is still accepted for back-compat so existing capture
    // scripts keep working.
    chatw: flagValue(argv, '--chat-w') ?? flagValue(argv, '--chatw'),
    explorerw: flagValue(argv, '--explorer-w'),
    explorerHidden: argv.includes('--explorer-hidden'),
    chatHidden: argv.includes('--chat-hidden'),
    foldAll: argv.includes('--fold-all'),
    shortcuts: argv.includes('--shortcuts'),
    search: flagValue(argv, '--search'),
    searchOpen: argv.includes('--search-open'),
    replay: argv.includes('--replay'),
  };
}

/** Build the file:// URL for index.html, carrying nav selectors as a query. */
function indexUrl(capture: CaptureArgs | null): string {
  const file = path.join(__dirname, 'index.html');
  const base = `file://${file}`;
  if (!capture) return base;
  const params = new URLSearchParams();
  if (capture.select) params.set('select', capture.select);
  if (capture.channel) params.set('channel', capture.channel);
  if (capture.inbox) params.set('inbox', capture.inbox);
  if (capture.theme) params.set('theme', capture.theme);
  if (capture.chatw) params.set('chatw', capture.chatw);
  if (capture.explorerw) params.set('explorerw', capture.explorerw);
  if (capture.explorerHidden) params.set('explorerhidden', '1');
  if (capture.chatHidden) params.set('chathidden', '1');
  if (capture.foldAll) params.set('foldall', '1');
  if (capture.shortcuts) params.set('shortcuts', '1');
  // URLSearchParams.set url-encodes the value, so a query with spaces/special
  // chars is carried safely (the renderer decodes it via URLSearchParams.get).
  if (capture.search) params.set('search', capture.search);
  if (capture.searchOpen) params.set('searchopen', '1');
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Shared hardened webPreferences for every window (NFR-3). */
function hardenedWebPreferences(): Electron.WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: path.join(__dirname, 'preload.cjs'),
  };
}

/** True when running under WSL/WSLg (where Chromium's OS-level renderer
 *  sandbox cannot be used — see SEC-4). Detected via the WSL kernel markers
 *  Microsoft injects, plus the WSLg display env. Conservative: only WSL
 *  flips the flags off; any other Linux/host keeps the OS sandbox. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    const release = readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

/** Apply WSL/WSLg-required GPU + OS-sandbox switches (must run pre-ready).
 *
 *  SEC-4: process-wide --no-sandbox / --no-zygote disable Chromium's
 *  OS-level renderer sandbox (seccomp-bpf + namespace isolation). They are a
 *  WSL-forced concession (the sandbox's seccomp filter breaks the offscreen
 *  shm path AND, under WSLg, the renderer's namespace sandbox), NOT a default.
 *  The PRIMARY renderer defense — contextIsolation / nodeIntegration:false /
 *  sandbox:true webPreferences / preload / CSP, plus the single safe
 *  markdown+highlight escaping path (guarded by the adversarial corpus in the
 *  acceptance suite) — is preserved verbatim and is unaffected. We GATE these
 *  OS flags behind WSL detection so a future non-WSL build keeps the OS
 *  sandbox as a second containment layer.
 *
 *  GPU: WSLg exposes no working GPU, so hardware acceleration must be OFF
 *  under WSL — but ONLY under WSL. On macOS / Windows / non-WSL Linux the
 *  GPU is real and hardware acceleration stays ON (smoother compositing,
 *  correct color, lower CPU). So both the GPU-off switches AND the OS-sandbox
 *  switches now live behind the same isWsl() gate. */
function applyWslSwitches(): void {
  if (!isWsl()) return;
  // WSLg-only: disable the (absent) GPU so Chromium uses SwiftShader/CPU.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  // --no-zygote is REQUIRED for capturePage() in this WSL2 sandbox: the zygote
  // forwards an inherited seccomp filter to renderer/GPU children that makes
  // their shared-memory syscalls (memfd/access on /dev/shm + tmp) return ESRCH
  // ("No such process"), so the compositor frame readback yields a 0-byte PNG.
  // Spawning each child fresh (no zygote) sidesteps that filter; the frame
  // transport then succeeds and capturePage() returns real pixels. Harmless for
  // the normal interactive window (slightly slower child spawn only).
  app.commandLine.appendSwitch('no-zygote');
}

/** The composed main-process services. */
interface Services {
  bus: ReturnType<typeof createEventBus>;
  engine: ReturnType<typeof createEngine>;
  sandbox: ReturnType<typeof createSandbox>;
  watcher: ReturnType<typeof createWatcher>;
  ipc: ReturnType<typeof createIpcWiring>;
  mcp: ReturnType<typeof createMcpServer>;
  ws: ReturnType<typeof createWsFeed> | null;
  rootDir: string;
}

/** Boot every main-process service in the required order. A failed MCP bind
 *  (e.g. :7077 already held by a live Loom instance, even after scanning the
 *  next ports) is tolerated on BOTH paths: a headless capture needs no agent
 *  transport, and a normal launch must still open the viewer for the human
 *  rather than crash. The bind is therefore never fatal — see the catch below.
 *
 *  `rootDir` is the already-resolved + validated sandbox root (Law 3 boundary).
 *  Resolution happens in resolveRoot() before boot so the (possibly async,
 *  dialog-based) packaged path is awaited up front. */
async function bootServices(rootDir: string, capturing = false): Promise<Services> {
  const db = createDb();
  await db.init(rootDir);

  const bus = createEventBus();
  const engine = createEngine(db, bus);

  const mcp = createMcpServer(engine);
  try {
    await mcp.start();
  } catch (err) {
    // The agent transport scans MCP_PORT..+N for a free port; if EVERY
    // candidate is held (or the bind otherwise fails), DO NOT abort the
    // launch — the human viewer must still open. We degrade gracefully on
    // BOTH the capture path and a normal launch: a missing agent transport
    // means agents can't connect to THIS instance (the one holding the port
    // already serves them), but the file viewer + live feed work regardless.
    // Previously a normal launch rethrew here, so a stale/second instance
    // made the whole window fail to appear.
    const label = capturing ? 'loom:capture' : 'loom:boot';
    process.stderr.write(
      `[${label}] MCP agent transport unavailable (${String(err)}); ` +
        `the viewer will open but agents cannot connect to this instance. ` +
        `This usually means another Loom instance is already running.\n`,
    );
  }

  const sandbox = createSandbox(rootDir);
  // Content search reuses the SAME sandbox for all file access (Law 3) — no
  // second, unconfined walker. It walks the confined tree + reads via readFile.
  const search = createSearch(sandbox);
  const watcher = createWatcher(rootDir, bus);
  watcher.start();

  const config = createConfigStore(app.getPath('userData'));
  const ipc = createIpcWiring({ db, sandbox, config, bus, search });
  ipc.register();

  let ws: Services['ws'] = null;
  if (wsEnabled()) {
    ws = createWsFeed(bus);
    await ws.start();
  }

  return { bus, engine, sandbox, watcher, ipc, mcp, ws, rootDir };
}

/** Platform-aware window-chrome options for the MAIN window.
 *
 *  - darwin: titleBarStyle 'hiddenInset' hides the native title bar but keeps
 *    the traffic-light controls floating INSET over our custom title bar, so
 *    the app shows a single clean bar (matching the design). The renderer
 *    title bar reserves left padding for the inset lights + becomes a drag
 *    region (see TitleBar.tsx / renderer.css, gated on the mac platform).
 *    trafficLightPosition nudges the lights to sit centered in the 40px bar.
 *  - win32 / linux (+ any other): keep the DEFAULT native frame — the OS
 *    frame draws the controls and handles window dragging. (Fully frameless /
 *    custom controls are intentionally out of scope.)
 *  The hardened webPreferences are IDENTICAL on every platform. */
function mainWindowChrome(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      // Center the ~14px traffic lights vertically in the 40px title bar.
      trafficLightPosition: { x: 14, y: 13 },
    };
  }
  return {}; // win32 / linux / other: default native frame.
}

/** Create the normal, visible application window. */
function createMainWindow(services: Services): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    backgroundColor: '#0b0d12',
    ...mainWindowChrome(),
    webPreferences: hardenedWebPreferences(),
  });
  void win.loadURL(indexUrl(null));
  services.ipc.attachRenderer((channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
  return win;
}

/** Poll the renderer until `selector` matches an element, or `timeoutMs`
 *  elapses. Used by the capture path to gate on real rendered content (e.g. a
 *  pre-selected file's Viewer badge) so a deterministic screenshot never races
 *  an async readFile. Resolves regardless on timeout so capture can't hang. */
async function waitForRendererSelector(
  win: BrowserWindow,
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const probe = `!!document.querySelector(${JSON.stringify(selector)})`;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false;
    try {
      const found = (await win.webContents.executeJavaScript(probe)) as boolean;
      if (found) return true;
    } catch {
      /* page mid-navigation; retry until the deadline */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 50);
      (t as { unref?: () => void }).unref?.();
    });
  }
  return false;
}

/** Run the capture path (normal hidden window, WSLg-composited), then quit. */
async function runCapture(services: Services, capture: CaptureArgs): Promise<void> {
  let finished = false;
  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    app.exit(code);
  };

  // Hard timeout: never let a stuck render hold the process open.
  const timeout = setTimeout(() => {
    process.stderr.write('[loom:capture] timed out\n');
    finish(1);
  }, CAPTURE_TIMEOUT_MS);
  (timeout as { unref?: () => void }).unref?.();

  try {
    // --replay: seed a scripted demo session first so events render.
    if (capture.replay) {
      // demo.ts is authored by the integration engineer; imported lazily so
      // this module compiles + runs even when no replay is requested.
      const demo = (await import('./demo.js')) as {
        seed: (engine: Services['engine'], root: string) => Promise<void> | void;
      };
      await demo.seed(services.engine, services.rootDir);
    }

    // NORMAL (non-offscreen) window: WSLg composits it via the real display,
    // bypassing Chromium's offscreen shared-memory path (which the sandbox
    // intercepts — ESRCH on /tmp shm). capturePage() works on a normal hidden
    // window because WSLg keeps a live backing surface. Renderer hardening is
    // preserved verbatim (contextIsolation/nodeIntegration/sandbox/preload).
    // show:false works in WSLg once the zygote seccomp filter is bypassed
    // (see applyWslSwitches). LOOM_CAPTURE_SHOW=1 forces a visible window as a
    // fallback escape hatch; not needed in this environment.
    const captureShow = process.env.LOOM_CAPTURE_SHOW === '1';
    const win = new BrowserWindow({
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      show: captureShow,
      backgroundColor: '#0b0d12',
      webPreferences: {
        ...hardenedWebPreferences(),
        offscreen: false,
      },
    });
    services.ipc.attachRenderer((channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });

    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve());
      void win.loadURL(indexUrl(capture));
    });

    // Deterministic content gate: when a file is pre-selected (--select), the
    // Viewer loads its content via an async readFile IPC. Under --replay the
    // renderer is busy folding the seeded session, so that read can resolve
    // AFTER a fixed settle. Poll the renderer for the loaded-file signal
    // (`.viewer .render-tag`, which only mounts once content !== null) so the
    // capture waits for the file to actually render into the DOM. Bounded so a
    // genuinely-absent file can't hang capture.
    if (capture.select) {
      await waitForRendererSelector(win, '.pane.viewer .render-tag', 8000);
    }

    // Search captures: wait for the debounced search to land its results into
    // the DOM (a CONTENT group header OR the file-NAME "Files" group appears
    // once a match is found — a filename-only query has no content group). When
    // also opening the first result, additionally wait for the Viewer to render.
    if (capture.search) {
      await waitForRendererSelector(
        win,
        '.search-results .search-group, .search-results .search-filegroup',
        8000,
      );
      if (capture.searchOpen) {
        await waitForRendererSelector(win, '.pane.viewer .render-tag', 8000);
      }
    }

    // Settle: a normal window emits no offscreen 'paint' event, so wait a
    // fixed interval for the renderer to fetch state + paint into WSLg's
    // backing surface before we grab the frame.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, CAPTURE_SETTLE_MS);
      (t as { unref?: () => void }).unref?.();
    });

    // Compositor flush (WSLg): even once the DOM is fully updated,
    // capturePage() on this non-offscreen window can grab a STALE composited
    // frame (e.g. the empty Viewer painted before the file's content landed) —
    // the DOM is correct but the rasterized surface lags. Force a fresh repaint
    // (invalidate) and await two rAF turns so the new frame is committed and
    // composited before we capture. This removes the residual screenshot race.
    if (!win.isDestroyed()) win.webContents.invalidate();
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
    );
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 120);
      (t as { unref?: () => void }).unref?.();
    });

    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    if (png.length === 0) {
      process.stderr.write('[loom:capture] empty PNG\n');
      clearTimeout(timeout);
      finish(1);
      return;
    }
    writeFileSync(capture.out, png);
    clearTimeout(timeout);
    finish(0);
  } catch (err) {
    process.stderr.write(`[loom:capture] failed: ${String(err)}\n`);
    clearTimeout(timeout);
    finish(1);
  }
}

/** True when `p` exists and is a directory. Never throws. */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The argv entries that come AFTER the app/script path, i.e. the real
 *  user-supplied arguments. In a packaged app argv is
 *  [exePath, ...userArgs] so the user args start at index 1; in dev
 *  (electron .) argv is [electronBin, appPath, ...userArgs] so they start at
 *  index 2. Electron exposes this exact split via app.isPackaged. */
function userArgv(): string[] {
  return process.argv.slice(app.isPackaged ? 1 : 2);
}

/** First existing-directory positional argument (ignoring --flags and the
 *  values consumed by known value-flags like --capture/--select/etc.), or
 *  null. This powers `Loom.exe C:\path` and drag-a-folder-onto-the-exe.
 *
 *  We only treat a token as a candidate root if it does NOT start with '-'.
 *  To avoid mistaking a value that belongs to a value-flag (e.g. the PNG path
 *  after --capture) for a folder, we skip the token immediately following any
 *  known `--flag value` flag. Capture flags are mutually exclusive with the
 *  normal launch in practice, but this keeps the parse robust regardless. */
const VALUE_FLAGS = new Set([
  '--capture',
  '--select',
  '--channel',
  '--inbox',
  '--theme',
  '--chat-w',
  '--chatw',
  '--explorer-w',
  '--search',
]);

function argvFolder(): string | null {
  const args = userArgv();
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === undefined) continue;
    if (tok.startsWith('-')) {
      // Skip the value that belongs to a known value-flag so we don't treat it
      // as a positional folder.
      if (VALUE_FLAGS.has(tok)) i++;
      continue;
    }
    if (isDirectory(tok)) return path.resolve(tok);
  }
  return null;
}

/** Resolve the sandbox root (Law 3 boundary) BEFORE bootServices, in priority:
 *   1. LOOM_ROOT env (the bin/loom.cjs launcher + capture path set this).
 *   2. A folder passed on argv (`Loom.exe C:\path` / drag-onto-exe).
 *   3. Packaged + still unresolved: a native folder picker (cancel => quit).
 *   4. Dev (not packaged): cwd — the existing behavior, unchanged.
 *  An argv/env root that is not an existing directory is rejected and we fall
 *  through to the picker (packaged) or cwd (dev). Resolves to null ONLY when a
 *  packaged user cancels the picker, signaling the caller to quit gracefully. */
async function resolveRoot(): Promise<string | null> {
  // 1. LOOM_ROOT — honored byte-for-byte for the launcher + capture paths.
  const envRoot = process.env.LOOM_ROOT;
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (isDirectory(resolved)) return resolved;
    // An explicitly-set-but-invalid LOOM_ROOT: don't silently open elsewhere.
    // Fall through to picker (packaged) or cwd (dev) below.
    process.stderr.write(
      `[loom:boot] LOOM_ROOT is not a directory: ${resolved}; falling back\n`,
    );
  }

  // 2. A folder argument on argv.
  const fromArgv = argvFolder();
  if (fromArgv) return fromArgv;

  // 3. Packaged with no usable cwd/env: ask the user (modal, post-ready).
  if (app.isPackaged) {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a folder for Loom to open',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const picked = result.filePaths[0];
    if (picked && isDirectory(picked)) return path.resolve(picked);
    // A picked path that vanished/isn't a dir: treat as cancel rather than
    // booting on a bogus root.
    return null;
  }

  // 4. Dev (not packaged): cwd — unchanged from the original behavior.
  return path.resolve(process.cwd());
}

/** Entry point invoked at module load by Electron. */
export function bootstrap(): void {
  applyWslSwitches();

  const capture = parseCapture(process.argv);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app
    .whenReady()
    .then(async () => {
      // Resolve (and validate) the sandbox root BEFORE any service boots. The
      // packaged folder-picker is awaited here so db.init/bootServices/window
      // creation all see a settled root.
      const rootDir = await resolveRoot();
      if (rootDir === null) {
        // Packaged user cancelled the folder picker: quit gracefully.
        app.quit();
        return;
      }

      const services = await bootServices(rootDir, capture !== null);
      if (capture) {
        await runCapture(services, capture);
      } else {
        createMainWindow(services);
        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) createMainWindow(services);
        });
      }
    })
    .catch((err) => {
      process.stderr.write(`[loom:boot] fatal: ${String(err)}\n`);
      app.exit(1);
    });
}

// Auto-run when launched by Electron.
bootstrap();
