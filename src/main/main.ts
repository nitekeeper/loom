/* ============================================================
 * Loom — Electron main process entry (FR-14, NFR-8)
 * ------------------------------------------------------------
 * The single source of truth. Owns: the sql.js store (db.ts),
 * the engine (engine.ts), the MCP server (mcp.ts), the event
 * bus (eventbus.ts), the chokidar watcher (watcher.ts), config
 * (config.ts), the sandbox (sandbox.ts), and the BrowserWindow
 * lifecycle + IPC handlers (ipc.ts).
 * ============================================================ */
import { readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
// Same build-time-inlined app version the MCP server advertises (esbuild
// inlines package.json), so the discovery file can never drift from a literal.
import { version as LOOM_VERSION } from '../../package.json';
import { DEFAULT_MAX_MESSAGES, IPC, MAX_BODY_LENGTH } from '../shared/types.js';
import type { WindowBounds } from '../shared/types.js';
import { safeExternalUrl } from '../shared/url.js';
import { MCP_HOST, MCP_PATH } from './mcp.js';
import { createDb } from './db.js';
import { createEventBus } from './eventbus.js';
import { createEngine } from './engine.js';
import { createMcpServer } from './mcp.js';
import { createSandbox } from './sandbox.js';
import { createSearch } from './search.js';
import { createWatcher } from './watcher.js';
import { createConfigStore } from './config.js';
import { createIpcWiring } from './ipc.js';
import { createTerminalManager } from './terminal.js';
import { createNodePtyFactory } from './pty-factory.js';
import { createWsFeed, wsEnabled } from './ws.js';
import { linuxMaximizeBounds, computeWslToggleMaximize } from './linux-maximize.js';

/** Capture window dimensions (FR — headless screenshots via a normal,
 *  WSLg-composited hidden window; see runCapture + applyWslSwitches). */
const CAPTURE_WIDTH = 1440;
const CAPTURE_HEIGHT = 900;

/** Minimum main-window size (DIP). A hard floor enforced BOTH by the OS via
 *  win.setMinimumSize (so the native/WM resize and the Linux custom edge handles
 *  can never shrink below it) AND re-applied when clamping a WINDOW_SET_BOUNDS
 *  payload. Sized so the 3-pane layout stays usable. NOTE the three pane minimums
 *  (Explorer 180 + Chat 300 + Viewer 320 — App.tsx) sum to 800, which is ABOVE
 *  this 720 floor: that is intentional. At 720 the user keeps the VIEWER + ONE
 *  side pane at-or-above its min (e.g. Explorer 180 + Viewer 540, or Chat 300 +
 *  Viewer 420); with BOTH side panes open the Viewer would be squeezed below its
 *  320 (the layout floors each side pane and lets the Viewer absorb the deficit
 *  under `overflow:hidden`, so nothing inverts or overflows — the user just
 *  collapses one side pane to restore the Viewer's room). 480 keeps the 40px
 *  titlebar + status bar + content readable. */
const MIN_W = 720;
const MIN_H = 480;
/** Sane upper bound for a WINDOW_SET_BOUNDS width/height (DIP). Guards against a
 *  malformed/hostile renderer payload requesting an absurd surface. */
const MAX_WINDOW_DIM = 100_000;
/** Settle delay after did-finish-load before we capture. */
const CAPTURE_SETTLE_MS = 1500;
/** Hard ceiling: a capture that hangs must still exit the process. */
const CAPTURE_TIMEOUT_MS = 30_000;

// Per-window pre-maximize / pre-fullscreen bounds (Linux only). WeakMap avoids
// retaining a closed window. Populated before win.maximize() so the unmaximize
// handler can restore the exact pre-maximize position even if the WM shifted its
// own restore point after our setBounds override. The fullscreen map captures
// bounds on enter-full-screen (before correction) for leave-full-screen restore.
const preMaximizeBoundsMap = new WeakMap<BrowserWindow, Electron.Rectangle>();
const preFullscreenBoundsMap = new WeakMap<BrowserWindow, Electron.Rectangle>();
// WSL2 manual maximize state — tracks whether the window is in our "fake
// maximized" state (setBounds to workArea without calling win.maximize()).
// win.isMaximized() always returns false on WSL2 path, so we maintain this.
const manualMaximizedMap = new WeakMap<BrowserWindow, boolean>();

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
  /** Capture-only RENDERED-markdown reading-column width mode override
   *  ('full' | 'fit'), or null to keep localStorage/default. Lets a headless
   *  screenshot render either the predefined 792px measure or full width. */
  mdWidth: string | null;
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
    mdWidth: flagValue(argv, '--md-width'),
    shortcuts: argv.includes('--shortcuts'),
    search: flagValue(argv, '--search'),
    searchOpen: argv.includes('--search-open'),
    replay: argv.includes('--replay'),
  };
}

/** The layout/boot hints that may be carried into the index.html query on the
 *  NORMAL (interactive) launch path too — NOT just under --capture. These are
 *  the read-only, idempotent pane/measure overrides the renderer already reads
 *  from `location.search` (App.tsx readChat / readExplorer hints, Viewer's
 *  parseMdWidthHint). They are a structural SUBSET of CaptureArgs, so the full
 *  capture struct also satisfies this shape and flows through indexUrl
 *  unchanged. Capture-staging behaviors (--select/--search/--shortcuts/
 *  --fold-all/--replay) are deliberately NOT in this set: they seed/act on
 *  content and are reserved for the capture path. */
interface LayoutHints {
  /** Chat-pane width override (px), or null. */
  chatw: string | null;
  /** Explorer-pane width override (px), or null. */
  explorerw: string | null;
  /** Start with the Explorer collapsed. */
  explorerHidden: boolean;
  /** Start with the Chat collapsed. */
  chatHidden: boolean;
  /** RENDERED-markdown reading-column width mode ('full'|'fit'), or null. */
  mdWidth: string | null;
}

/** Parse ONLY the layout/boot hints (LayoutHints) from argv, with NO --capture
 *  requirement. Lets the interactive launch path honor the same pane/measure
 *  overrides the capture path does (and the renderer already reads) — e.g.
 *  `Loom <folder> --md-width full --chat-hidden`. Mirrors parseCapture's reads
 *  for these fields exactly (incl. the legacy `--chatw` alias). */
function parseLayoutHints(argv: string[]): LayoutHints {
  return {
    chatw: flagValue(argv, '--chat-w') ?? flagValue(argv, '--chatw'),
    explorerw: flagValue(argv, '--explorer-w'),
    explorerHidden: argv.includes('--explorer-hidden'),
    chatHidden: argv.includes('--chat-hidden'),
    mdWidth: flagValue(argv, '--md-width'),
  };
}

/** Build the file:// URL for index.html, carrying nav/layout hints as a query.
 *  Accepts the full CaptureArgs (capture path) OR the LayoutHints subset (the
 *  normal launch path) OR null (no hints). Each field is forwarded only when
 *  present, so the LayoutHints subset simply omits the capture-only params. */
function indexUrl(hints: (CaptureArgs | LayoutHints) | null): string {
  const file = path.join(__dirname, 'index.html');
  const base = `file://${file}`;
  if (!hints) return base;
  const capture: Partial<CaptureArgs> = hints;
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
  // Only the closed 'full'|'fit' set is forwarded; the renderer (parseMdWidthHint)
  // also re-validates, so an unknown value is ignored either way.
  if (capture.mdWidth === 'full' || capture.mdWidth === 'fit') {
    params.set('mdwidth', capture.mdWidth);
  }
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

/** True when the window is either WM-maximized (non-WSL) or manually
 *  maximized via setBounds (WSL2, where win.maximize() causes a Mutter
 *  frame-offset bug — see computeWslToggleMaximize). */
function isEffectivelyMaximized(win: BrowserWindow): boolean {
  if (isWsl()) return manualMaximizedMap.get(win) ?? false;
  return win.isMaximized();
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
  db: ReturnType<typeof createDb>;
  bus: ReturnType<typeof createEventBus>;
  engine: ReturnType<typeof createEngine>;
  sandbox: ReturnType<typeof createSandbox>;
  watcher: ReturnType<typeof createWatcher>;
  ipc: ReturnType<typeof createIpcWiring>;
  /** The human-invoked terminal pane's PTY session manager (loom:terminal:*).
   *  PTY lives ONLY in main; killed on window close / app quit. */
  terminal: ReturnType<typeof createTerminalManager>;
  mcp: ReturnType<typeof createMcpServer>;
  ws: ReturnType<typeof createWsFeed> | null;
  rootDir: string;
  /** True when THIS process wrote+owns `<rootDir>/.loom/mcp.json` and is
   *  therefore responsible for removing it on graceful shutdown (MEDIUM-1).
   *  False when we declined to a live peer (HIGH-1), the write failed, or the
   *  capture path skipped it (HIGH-2). */
  ownsMcpAdvert: boolean;
}

/** Absolute path to a window's MCP endpoint-advertisement file. Lives beside
 *  loom.db in the project's `.loom/` dir (db.init already mkdirSync'd it). */
function mcpAdvertPath(rootDir: string): string {
  return path.join(rootDir, '.loom', 'mcp.json');
}

/** True when a process with `pid` is alive. `process.kill(pid, 0)` sends no
 *  signal — it only probes existence: it throws ESRCH when the pid is dead and
 *  EPERM when it's alive but owned by another user (still "alive" for us). Any
 *  other error (or a non-finite pid) is treated as "not alive" so a malformed
 *  advert never blocks us from taking ownership. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the existing advert at `<rootDir>/.loom/mcp.json`, or null when it's
 *  absent/unreadable/malformed. Only the fields we need to arbitrate ownership
 *  (HIGH-1) are validated. */
function readMcpAdvert(rootDir: string): { pid: number; port: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(mcpAdvertPath(rootDir), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const { pid, port } = parsed as { pid?: unknown; port?: unknown };
    if (typeof pid !== 'number' || typeof port !== 'number') return null;
    return { pid, port };
  } catch {
    return null;
  }
}

/** Discovery use case: write `<rootDir>/.loom/mcp.json` so an agent running
 *  inside THIS project folder can discover exactly which Loom instance (which
 *  bound port) serves it. Returns true ONLY when THIS process wrote+owns the
 *  file (so the caller knows whether to register a removal hook — MEDIUM-1).
 *
 *  HIGH-1 (two windows, SAME project folder): the filename is fixed, so a
 *  second window would clobber the first's advert and either window's quit
 *  would delete the shared file out from under a still-live peer. "First live
 *  writer wins": if an advert already exists, its pid is still alive, and it
 *  advertises a DIFFERENT port, we DECLINE — don't write, return false, and the
 *  caller registers no removal hook. A stale advert (dead/absent pid) is
 *  overwritten and we become the owner. Only called once a real port is bound
 *  (the no-bind path skips it). `maxBodyLength` is the live per-message cap
 *  (R1) advertised for the reader. Best-effort: a write failure must never
 *  prevent the viewer from opening. */
function writeMcpAdvert(
  rootDir: string,
  boundPort: number,
  maxBodyLength: number,
): boolean {
  const existing = readMcpAdvert(rootDir);
  if (
    existing !== null &&
    existing.port !== boundPort &&
    existing.pid !== process.pid &&
    isPidAlive(existing.pid)
  ) {
    // A live peer already serves this folder on another port — decline so we
    // don't clobber its advert or later delete it on our own quit.
    return false;
  }
  // NOTE (TOCTOU, accepted): the read above and the write below are not atomic.
  // Two windows on the SAME folder booting within the same few ms could both
  // observe "no live peer" and both write (last-writer-wins). Impact is bounded
  // to a momentarily wrong advert — never corruption or cross-deletion, since
  // each window only removes the file when it owns it (ownsMcpAdvert). A
  // filesystem compare-and-swap isn't worth the complexity for a discovery file
  // the reader liveness-probes anyway.
  try {
    const advert = {
      url: `http://${MCP_HOST}:${boundPort}${MCP_PATH}`,
      port: boundPort,
      pid: process.pid,
      version: LOOM_VERSION,
      rootDir,
      startedAt: Date.now(),
      // R1: the live per-message body cap a reader should respect.
      maxBodyLength,
    };
    writeFileSync(mcpAdvertPath(rootDir), `${JSON.stringify(advert, null, 2)}\n`);
    return true;
  } catch (err) {
    process.stderr.write(
      `[loom:boot] could not write MCP discovery file (${String(err)}); ` +
        `agents may not be able to auto-discover this instance.\n`,
    );
    return false;
  }
}

/** Best-effort removal of the discovery file on graceful shutdown so a stopped
 *  window stops advertising a dead port. A force-kill won't run this — that's
 *  expected; the reader liveness-probes, so a stale file is tolerated. ENOENT
 *  (never written / already gone) is ignored. */
function removeMcpAdvert(rootDir: string): void {
  try {
    rmSync(mcpAdvertPath(rootDir), { force: true });
  } catch {
    /* best-effort: ignore (e.g. permissions); the reader liveness-probes. */
  }
}

/** Persist + release the chat DB on graceful close (R2/R3). Chat now PERSISTS
 *  across launches (R2, OPTION A), so on teardown we do NOT delete loom.db or
 *  .loom/temp — content is removed ONLY by the explicit purge_all tool. We do a
 *  final synchronous flushNow() so the persisted loom.db reflects the latest
 *  state, then close() (which cancels the debounce + frees the db, leaving the
 *  file in place). Both steps are best-effort so teardown never blocks quit. */
function persistAndCloseDb(db: Services['db']): void {
  try {
    db.flushNow(); // durable: latest state on disk before we stop writing.
    db.close(); // cancels the pending debounce; does NOT delete the file.
  } catch {
    /* best-effort: a teardown failure must not block quit. */
  }
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

  // Resolve the configurable per-message body cap (R1) BEFORE the engine/MCP
  // server are built, so both enforce the SAME runtime value (config override
  // or the MAX_BODY_LENGTH default). The store also drives theme/keybindings
  // for the IPC wiring below — one store, read once here.
  const config = createConfigStore(app.getPath('userData'));
  const cfg = config.read();
  const maxBodyLength = cfg.maxMessageLength ?? MAX_BODY_LENGTH;
  // Persisted-message retention cap (memory + per-flush serialize-cost bound).
  // config.read() coerces this to a non-negative integer (0 = unlimited),
  // defaulting to DEFAULT_MAX_MESSAGES.
  const maxMessages = cfg.maxMessages ?? DEFAULT_MAX_MESSAGES;

  const bus = createEventBus();
  // Engine enforces the body cap (SEC-6) + the retention cap, and needs rootDir
  // to delete .loom/temp report files on purge_all (R4).
  const engine = createEngine(db, bus, { maxBodyLength, rootDir, maxMessages });

  // MCP schema mirrors the SAME cap for an early client-side reject (R1).
  const mcp = createMcpServer(engine, { maxBodyLength });
  let ownsMcpAdvert = false;
  try {
    await mcp.start();
    // start() resolves ONLY once a real port is bound (mcp.ts resolves in the
    // listen callback after setting boundPort) — so mcp.port is the ACTUAL
    // bound port here, never the hardcoded 7077 when 7077 was taken. Advertise
    // it for agent discovery. Skipped on the catch path: no bind, no address.
    // HIGH-2: a headless capture has no long-lived endpoint to advertise (it
    // exits via app.exit(), which never fires will-quit, so it could never
    // clean up) — so don't write the advert when capturing at all.
    if (!capturing) ownsMcpAdvert = writeMcpAdvert(rootDir, mcp.port, maxBodyLength);
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

  // The terminal pane's PTY session manager (human-invoked; MCP-invisible).
  // The node-pty factory loads its native binding LAZILY on first open(), so a
  // missing/ABI-broken node-pty degrades to "terminal unavailable"
  // ({ sessionId: null }) instead of failing boot.
  const terminal = createTerminalManager({ factory: createNodePtyFactory(), rootDir });

  const ipc = createIpcWiring({ db, sandbox, config, bus, search, rootPath: rootDir, terminal });
  ipc.register();

  let ws: Services['ws'] = null;
  if (wsEnabled()) {
    ws = createWsFeed(bus);
    await ws.start();
  }

  return { db, bus, engine, sandbox, watcher, ipc, terminal, mcp, ws, rootDir, ownsMcpAdvert };
}

/** Platform-aware window-chrome options for the MAIN window.
 *
 *  - darwin: titleBarStyle 'hiddenInset' hides the native title bar but keeps
 *    the traffic-light controls floating INSET over our custom title bar, so
 *    the app shows a single clean bar (matching the design). The renderer
 *    title bar reserves left padding for the inset lights + becomes a drag
 *    region (see TitleBar.tsx / renderer.css, gated on the mac platform).
 *    trafficLightPosition nudges the lights to sit centered in the 40px bar.
 *  - win32 / linux (+ any other): FRAMELESS (`frame: false`) — the native OS
 *    frame is removed and the renderer's custom title bar draws our own
 *    minimize / maximize-restore / close controls + handles dragging (the
 *    titlebar is a -webkit-app-region drag region; the controls are no-drag).
 *    The window stays `resizable` (Electron keeps invisible edge resize regions
 *    on Windows; Linux edge-resize is WM-dependent) and keeps backgroundColor.
 *  The hardened webPreferences are IDENTICAL on every platform. */
function mainWindowChrome(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      // Center the ~14px traffic lights vertically in the 40px title bar.
      trafficLightPosition: { x: 14, y: 13 },
    };
  }
  // win32 / linux / other: frameless — our custom TitleBar draws the controls.
  return { frame: false };
}

/** Wire the three frameless window-control IPC handlers ONCE for the whole
 *  process. Each handler resolves its target window from the SENDER
 *  (BrowserWindow.fromWebContents) — NEVER a caller-supplied id — and takes NO
 *  untrusted args, so a renderer can only act on its OWN window. The offscreen
 *  capture window simply never calls these. Guarded by a module flag so a
 *  second window (or app.activate re-create) cannot double-register a handler
 *  (ipcMain.handle throws on a duplicate channel). */
let windowControlsRegistered = false;
function registerWindowControlHandlers(): void {
  if (windowControlsRegistered) return;
  windowControlsRegistered = true;
  const senderWindow = (evt: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(evt.sender);
  ipcMain.handle(IPC.WINDOW_MINIMIZE, (evt) => {
    senderWindow(evt)?.minimize();
  });
  ipcMain.handle(IPC.WINDOW_TOGGLE_MAXIMIZE, (evt) => {
    const win = senderWindow(evt);
    if (!win) return;
    if (isWsl()) {
      // WSL2/WSLg: bypass win.maximize() — Mutter applies a ~1cm decoration
      // offset to frameless windows on maximize that overrides any post-maximize
      // setBounds() correction. Use manual setBounds to workArea instead.
      const cur = win.getBounds();
      const isManual = manualMaximizedMap.get(win) ?? false;
      const decision = computeWslToggleMaximize(isManual, cur, preMaximizeBoundsMap.get(win) ?? null, screen.getAllDisplays());
      if (!isManual) preMaximizeBoundsMap.set(win, cur);
      else preMaximizeBoundsMap.delete(win);
      manualMaximizedMap.set(win, decision.isMaximized);
      win.setBounds(decision.bounds);
      if (!win.isDestroyed()) win.webContents.send(IPC.WINDOW_MAXIMIZED, decision.isMaximized);
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      if (process.platform === 'linux') {
        preMaximizeBoundsMap.set(win, win.getBounds());
      }
      win.maximize();
    }
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, (evt) => {
    senderWindow(evt)?.close();
  });
  // Pull-based authoritative maximize state. The renderer seeds its glyph from
  // this on mount so it never depends on catching the fire-and-forget initial
  // WINDOW_MAXIMIZED push (which is sent on did-finish-load — BEFORE the
  // renderer's onMaximizeChange listener attaches, and Electron does not replay
  // it). Sender-scoped, no untrusted args; false when the window is unresolved.
  ipcMain.handle(IPC.WINDOW_IS_MAXIMIZED, (evt) => {
    const win = senderWindow(evt);
    if (!win) return false;
    return isEffectivelyMaximized(win);
  });
  // Live screen rectangle of the SENDER window — the Linux frameless edge-resize
  // handles read this at drag start to anchor the geometry. Sender-scoped, no
  // untrusted args; a zero rect when the window is unresolved (the renderer
  // guards against a degenerate start anyway).
  ipcMain.handle(IPC.WINDOW_GET_BOUNDS, (evt): WindowBounds => {
    const win = senderWindow(evt);
    if (!win || win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
    const b = win.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  // Apply a resize during a Linux frameless edge-drag. RIGOROUSLY validates the
  // caller-supplied payload (the ONLY WINDOW_* handler that takes args, so it is
  // the only one that must distrust input): every field must be a FINITE integer
  // (rejects NaN/Infinity/non-number/missing), and width/height are CLAMPED to
  // [MIN_W..MAX] / [MIN_H..MAX] so a hostile renderer can neither collapse the
  // window below the usable floor nor request an absurd surface. Sender-scoped
  // (own window only); an invalid payload or an unresolved/destroyed sender is a
  // silent no-op (never trust the renderer; mirror of OPEN_EXTERNAL/clipboard).
  ipcMain.handle(IPC.WINDOW_SET_BOUNDS, (evt, payload: unknown) => {
    const win = senderWindow(evt);
    if (!win || win.isDestroyed()) return;
    const bounds = validateBounds(payload);
    if (bounds === null) return;
    win.setBounds(bounds);
  });
}

/** True for a finite integer (rejects NaN, ±Infinity, non-numbers, floats). */
function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Clamp `v` into [lo, hi]. */
function clampDim(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Soft-clamp the window ORIGIN (x/y) so a malformed/hostile WINDOW_SET_BOUNDS
 *  payload can never park the frameless window unreachably offscreen (a lost-
 *  window soft-DoS — there is no native titlebar to drag it back). The allowed
 *  envelope is the bounding box of every display's workArea, GROWN by the window
 *  size minus a small on-screen MARGIN, so:
 *   - legitimate multi-monitor negative coords and overscan still pass, and
 *   - the window may hang mostly off an edge, but at least a MARGIN-wide strip
 *     always stays on some display (grabbable / reachable via the WM).
 *  Falls back to the ±MAX_WINDOW_DIM bound if the display list can't be read
 *  (e.g. screen not ready), so x/y are never left fully unbounded. */
const OFFSCREEN_MARGIN = 48;
function clampOrigin(x: number, y: number, width: number, height: number): { x: number; y: number } {
  let left = -MAX_WINDOW_DIM;
  let top = -MAX_WINDOW_DIM;
  let right = MAX_WINDOW_DIM;
  let bottom = MAX_WINDOW_DIM;
  try {
    const displays = screen.getAllDisplays();
    if (displays.length > 0) {
      // Union bounding box of all displays' work areas.
      let uL = Infinity;
      let uT = Infinity;
      let uR = -Infinity;
      let uB = -Infinity;
      for (const d of displays) {
        const w = d.workArea;
        uL = Math.min(uL, w.x);
        uT = Math.min(uT, w.y);
        uR = Math.max(uR, w.x + w.width);
        uB = Math.max(uB, w.y + w.height);
      }
      // Allow the window to slide off until only MARGIN px remain on a display:
      //   x in [uL - width + MARGIN, uR - MARGIN]
      //   y in [uT - height + MARGIN, uB - MARGIN]
      left = uL - width + OFFSCREEN_MARGIN;
      top = uT - height + OFFSCREEN_MARGIN;
      right = uR - OFFSCREEN_MARGIN;
      bottom = uB - OFFSCREEN_MARGIN;
      // Degenerate guard: a window wider/taller than the whole desktop would make
      // left > right; keep the origin pinned at the union's top-left in that case.
      if (left > right) left = right = uL;
      if (top > bottom) top = bottom = uT;
    }
  } catch {
    /* screen unavailable (not ready): keep the generous ±MAX_WINDOW_DIM bound. */
  }
  return { x: clampDim(x, left, right), y: clampDim(y, top, bottom) };
}

/** Validate + CLAMP a caller-supplied WINDOW_SET_BOUNDS payload, or null when it
 *  is not a well-formed bounds object. x/y must be finite integers (they may be
 *  negative — multi-monitor layouts put windows at negative screen coords); the
 *  SIZE is clamped to [MIN..MAX] and the ORIGIN is soft-clamped to keep a
 *  grabbable strip on a display (clampOrigin), so a renderer can drive neither a
 *  degenerate size NOR an unrecoverable-offscreen position. */
function validateBounds(payload: unknown): WindowBounds | null {
  if (payload === null || typeof payload !== 'object') return null;
  const { x, y, width, height } = payload as Record<string, unknown>;
  if (!isFiniteInt(x) || !isFiniteInt(y) || !isFiniteInt(width) || !isFiniteInt(height)) {
    return null;
  }
  const w = clampDim(width, MIN_W, MAX_WINDOW_DIM);
  const h = clampDim(height, MIN_H, MAX_WINDOW_DIM);
  const origin = clampOrigin(x, y, w, h);
  return { x: origin.x, y: origin.y, width: w, height: h };
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
  // Hard minimum size (DIP), enforced by the OS/Electron regardless of platform.
  // On Linux the frameless window has no native resize border, so we also draw
  // custom edge handles (WindowResizeHandles) that drive WINDOW_SET_BOUNDS — both
  // honor this same floor, so the 3-pane layout can never be shrunk into collapse.
  win.setMinimumSize(MIN_W, MIN_H);
  // The interactive window honors the layout/boot hints (pane sizes/collapse +
  // the .md reading-column width mode) from argv, mirroring the capture path's
  // forwarding. The renderer reads these from location.search regardless of
  // launch path; absent flags forward nothing, so a plain `Loom <folder>` is
  // unchanged (indexUrl emits no query and persisted localStorage wins).
  void win.loadURL(indexUrl(parseLayoutHints(process.argv)));
  installNavGuard(win);
  // Frameless custom chrome (win32/linux): the renderer draws its own
  // min/max/close controls, so it needs the live maximize state to flip the
  // maximize<->restore glyph. Register the (process-wide, once) sender-scoped
  // control handlers and push the maximize state to THIS window on every
  // toggle. The push is harmless on darwin (the renderer there renders no
  // controls and ignores it).
  registerWindowControlHandlers();
  // Linux frameless maximize / fullscreen correction: some WMs apply a ~1cm
  // frame-decoration offset to frameless windows when maximizing or entering
  // fullscreen. Override with the correct display geometry after the WM fires,
  // and restore the pre-state bounds on exit.
  if (process.platform === 'linux' && !isWsl()) {
    // Non-WSL Linux: setBounds() is deferred via setImmediate on all four
    // handlers to avoid racing with the WM's synchronous maximize/fullscreen
    // operation. On WSL2 this block is skipped — the WINDOW_TOGGLE_MAXIMIZE
    // IPC handler uses manual setBounds (computeWslToggleMaximize) instead of
    // win.maximize(), so these WM events never fire on WSLg.
    win.on('maximize', () => {
      setImmediate(() => {
        if (win.isDestroyed()) return;
        win.setBounds(linuxMaximizeBounds(win.getBounds(), screen.getAllDisplays()));
      });
    });
    win.on('unmaximize', () => {
      const prev = preMaximizeBoundsMap.get(win);
      if (prev) preMaximizeBoundsMap.delete(win);
      setImmediate(() => {
        if (win.isDestroyed()) return;
        if (prev) win.setBounds(prev);
      });
    });
    win.on('enter-full-screen', () => {
      const cur = win.getBounds();
      preFullscreenBoundsMap.set(win, cur);
      const displays = screen.getAllDisplays();
      const nearest = linuxMaximizeBounds(cur, displays.map(d => ({ bounds: d.bounds, workArea: d.bounds })));
      setImmediate(() => {
        if (win.isDestroyed()) return;
        win.setBounds(nearest);
      });
    });
    win.on('leave-full-screen', () => {
      const prev = preFullscreenBoundsMap.get(win);
      if (prev) preFullscreenBoundsMap.delete(win);
      setImmediate(() => {
        if (win.isDestroyed()) return;
        if (prev) win.setBounds(prev);
      });
    });
  }
  const pushMaximized = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.WINDOW_MAXIMIZED, isEffectivelyMaximized(win));
  };
  win.on('maximize', pushMaximized);
  win.on('unmaximize', pushMaximized);
  // INITIAL SEED is pull-based, NOT this push. The renderer queries the
  // authoritative state via the WINDOW_IS_MAXIMIZED invoke inside its mount
  // effect (TitleBar WindowControls), which cannot be missed. We STILL emit one
  // best-effort push on EACH did-finish-load (idempotent boolean) as a belt-and-
  // braces backstop for the live toggle subscription — but correctness no longer
  // DEPENDS on the renderer's onMaximizeChange listener being attached before
  // this fires, so an in-app reload while maximized seeds correctly regardless.
  win.webContents.on('did-finish-load', pushMaximized);
  services.ipc.attachRenderer((channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
  // Kill-on-window-close: the PTY must never outlive the window that owns it
  // (the renderer's pane-close path also kills, but a window closed with the
  // terminal open relies on this). Idempotent with the will-quit disposeAll.
  win.on('closed', () => services.terminal.disposeAll());
  return win;
}

/** Navigation backstop for the navigable-links feature (defense in depth). The
 *  viewer window must NEVER navigate away from its own bundle or open a child
 *  window in-app — that would load arbitrary (agent-influenced) web content with
 *  the app's privileges. Any SAFE http/https/mailto target from a link,
 *  window.open, or ctrl/middle-click is redirected to the EXTERNAL browser;
 *  anything else is dropped. This holds even if the renderer-side click guard is
 *  bypassed. */
function installNavGuard(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalUrl(url);
    if (safe !== null) void shell.openExternal(safe);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    const safe = safeExternalUrl(url);
    if (safe !== null) void shell.openExternal(safe);
  });
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
    // Layer-4 defense-in-depth parity with the main window: deny in-app
    // navigation / child windows and route any SAFE target to the external
    // browser. will-navigate does NOT fire for the programmatic loadURL below,
    // and denying child windows is fine for capture (no popups expected).
    installNavGuard(win);
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
  '--md-width',
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

      // On graceful teardown the OWNING instance stops advertising its MCP
      // port. We gate on ownsMcpAdvert (the folder-ownership signal): a second
      // same-folder window that DECLINED ownership (HIGH-1) — or any window that
      // never bound MCP — does NOT touch the advert, so it can't delete a peer's
      // pointer. `will-quit` (not `before-quit`) is the definitive,
      // non-cancelable teardown signal.
      //
      // NOTE (R3): mcp.json is a LIVENESS POINTER, not content — so only the
      // owner removes it. Chat content (loom.db, .loom/temp) is NOT deleted on
      // close; it PERSISTS across launches (R2) and is removed only by the
      // explicit purge_all tool.
      if (services.ownsMcpAdvert) {
        app.on('will-quit', () => removeMcpAdvert(rootDir));
      }

      // The DB is persisted + released on EVERY graceful quit regardless of MCP
      // ownership (a non-owner window still wrote to its own in-memory db this
      // session and must flush it durably). This NEVER deletes loom.db (R2/R3).
      app.on('will-quit', () => persistAndCloseDb(services.db));

      // Gracefully close the network surface on quit. Without this, mcp.stop() /
      // ws.stop() / watcher.stop() are never called (audit S2): in-flight MCP
      // requests are severed abruptly, and in any in-process / multi-window
      // future the port + every live session would leak. will-quit is the
      // definitive, non-cancelable signal and the process exits right after, so
      // these are best-effort (fire-and-forget).
      app.on('will-quit', () => {
        void services.mcp.stop();
        void services.ws?.stop();
        services.watcher.stop();
      });

      // Lifecycle safety: never leak a live PTY past the app. disposeAll() is
      // idempotent (a second call on an already-killed session is a no-op), so
      // it is safe to fire on BOTH will-quit and window close.
      app.on('will-quit', () => services.terminal.disposeAll());

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
