/* ============================================================
 * Loom — Electron main process entry (FR-14, NFR-8)
 * ------------------------------------------------------------
 * The single source of truth. Owns: the sql.js store (db.ts),
 * the engine (engine.ts), the MCP server (mcp.ts), the event
 * bus (eventbus.ts), the chokidar watcher (watcher.ts), config
 * (config.ts), the sandbox (sandbox.ts), and the BrowserWindow
 * lifecycle + IPC handlers (ipc.ts).
 * ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { createDb } from './db.js';
import { createEventBus } from './eventbus.js';
import { createEngine } from './engine.js';
import { createMcpServer } from './mcp.js';
import { createSandbox } from './sandbox.js';
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
 *  sandbox as a second containment layer. GPU is always disabled (WSLg). */
function applyWslSwitches(): void {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  if (!isWsl()) return;
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

/** Boot every main-process service in the required order. When `capturing`,
 *  a failed MCP bind (e.g. :7077 already held by a live Loom instance) is
 *  tolerated: a headless screenshot does NOT serve the agent transport, so the
 *  capture must still proceed rather than abort. A normal launch keeps the bind
 *  fatal (the agent transport is required there). */
async function bootServices(capturing = false): Promise<Services> {
  const rootDir = path.resolve(process.env.LOOM_ROOT ?? process.cwd());

  const db = createDb();
  await db.init(rootDir);

  const bus = createEventBus();
  const engine = createEngine(db, bus);

  const mcp = createMcpServer(engine);
  try {
    await mcp.start();
  } catch (err) {
    if (!capturing) throw err;
    // Capture-only graceful degradation: the screenshot path needs no MCP.
    process.stderr.write(
      `[loom:capture] MCP transport unavailable (${String(err)}); continuing for capture\n`,
    );
  }

  const sandbox = createSandbox(rootDir);
  const watcher = createWatcher(rootDir, bus);
  watcher.start();

  const config = createConfigStore(app.getPath('userData'));
  const ipc = createIpcWiring({ db, sandbox, config, bus });
  ipc.register();

  let ws: Services['ws'] = null;
  if (wsEnabled()) {
    ws = createWsFeed(bus);
    await ws.start();
  }

  return { bus, engine, sandbox, watcher, ipc, mcp, ws, rootDir };
}

/** Create the normal, visible application window. */
function createMainWindow(services: Services): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    backgroundColor: '#0b0d12',
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
      const services = await bootServices(capture !== null);
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
