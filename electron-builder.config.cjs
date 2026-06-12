/* ============================================================
 * Loom — electron-builder configuration (CommonJS)
 * ------------------------------------------------------------
 * This file replaces the former `build` key in package.json. It is the
 * SINGLE source of electron-builder config. (Having both a package.json
 * `build` block AND this file can conflict; the `build` key was removed.)
 *
 * NOTE on loading: electron-builder auto-detects only the bare-prefix names
 * `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}` — it does NOT
 * auto-detect the `*.config.cjs` suffix. So every invocation passes this file
 * explicitly via `--config electron-builder.config.cjs` (the npm `dist:*`
 * scripts and both CI workflows). Without that flag electron-builder would
 * silently fall back to its built-in defaults (packing node_modules instead
 * of dist/**) and fail the asar sanity check.
 *
 * WHY a .cjs file instead of static JSON: the macOS *signing* fields must
 * be computed FROM THE ENVIRONMENT at build time, so that:
 *   - with NO certificate secret  -> a PROVEN UNSIGNED build (identity:null,
 *     no hardened runtime, no entitlements) — this is the build that is
 *     already green in CI today and must stay green;
 *   - with a certificate secret    -> a real Developer-ID-signed (and, when
 *     the APPLE_* creds are present, notarized) build.
 *
 * The toggle is `CSC_LINK`. The CI workflows export CSC_LINK into the
 * environment ONLY when a non-empty cert secret exists (see
 * .github/workflows/*.yml -> "Configure code signing" step). So:
 *
 *   process.env.CSC_LINK present  ==  "we have a cert, sign the build"
 *   process.env.CSC_LINK absent   ==  "no cert, produce the proven unsigned build"
 *
 * IMPORTANT: this works because the workflow leaves CSC_LINK genuinely
 * UNSET (not an empty string) for unsigned builds. A defined-but-empty
 * CSC_LINK would make electron-builder 26 treat "" as a cert path and try
 * to load it from cwd -> "<dir> not a file" -> exit 1 (the bug this fixes).
 *
 * NOTE on `mac.identity`:
 *   identity: null      -> electron-builder does NO signing itself. We then
 *                          AD-HOC sign in the afterPack hook below (see there):
 *                          a no-cert build still gets a valid CodeDirectory so
 *                          a downloaded copy opens via "unidentified developer"
 *                          /Open Anyway instead of failing as "damaged" on
 *                          Apple Silicon. No Apple account required.
 *   identity: undefined -> electron-builder auto-discovers a Developer ID
 *                          identity from the imported cert. Use when signing
 *                          (afterPack skips ad-hoc — the real signature stands).
 *
 * NOTE on `mac.notarize`: deliberately left UNSET (undefined). electron-builder
 * 26 notarizes ONLY when the APPLE_* env vars are present AND the app carries a
 * Developer ID signature. Leaving it unset means notarization turns itself on
 * exactly when the credentials exist — no code change per release.
 * ============================================================ */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

// CSC_LINK is exported by the CI workflow ONLY when a cert secret is non-empty.
// Its mere presence is our "should we sign?" signal.
const signed = Boolean(process.env.CSC_LINK);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.nitekeeper.loom',
  productName: 'Loom',
  copyright: 'Copyright © 2026 nitekeeper',
  directories: {
    output: 'release',
  },
  // Ad-hoc sign the UNSIGNED macOS build. electron-builder has no native ad-hoc
  // identity, and `mac.identity: null` leaves the .app with NO signature at all
  // — which on Apple Silicon makes a downloaded (quarantined) copy fail as
  // "Loom is damaged and can't be opened". An ad-hoc signature (`codesign -s -`)
  // gives every binary a valid CodeDirectory, so Gatekeeper instead shows the
  // ordinary "unidentified developer" prompt (one-time Open Anyway in System
  // Settings → Privacy & Security) — no Apple Developer account needed. When a
  // real Developer ID cert is present (`signed`), electron-builder signs the app
  // properly and this hook stands aside so that signature is preserved.
  afterPack: async (context) => {
    if (signed) return;
    if (context.electronPlatformName !== 'darwin') return;
    if (process.platform !== 'darwin') return; // codesign only exists on macOS
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);
    // --deep so the nested Electron frameworks/helpers are signed too; -s -
    // is the ad-hoc identity. Inherit stdio so the codesign line shows in logs.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'inherit',
    });
  },
  // node-pty (terminal pane PTY) is the ONE native production dependency. It is
  // marked `external` in build.mjs's mainBuild (never bundled), so the packaged
  // app must SHIP its tree: the explicit `files` allowlist below otherwise
  // excludes node_modules entirely. It must ALSO be asar-unpacked — Electron's
  // patched `fs` cannot dlopen a `.node` binary from inside app.asar, so the
  // require() is redirected to app.asar.unpacked. node-pty@1.x has no runtime
  // deps, so only its own tree is needed. electron-builder's DEFAULT
  // `npmRebuild: true` (not overridden here) rebuilds it against the packaged
  // Electron's ABI per platform in the installer workflows.
  files: ['dist/**', 'package.json', 'node_modules/node-pty/**'],
  asar: true,
  asarUnpack: ['dist/sql-wasm.wasm', 'node_modules/node-pty/**'],
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'build/icon.ico',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Loom',
    runAfterFinish: true,
    artifactName: 'Loom-Setup-${version}.${ext}',
  },
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.png',
    gatekeeperAssess: false,

    // ---- Signing fields, computed from env (see header) ----------------
    // Unsigned (no CSC_LINK): identity:null — electron-builder signs nothing;
    // the afterPack hook then AD-HOC signs the .app (no hardened runtime, no
    // entitlements) so a downloaded copy opens via "unidentified developer"
    // rather than failing as "damaged". Signed (CSC_LINK present):
    // identity:undefined = auto-discover Developer ID, hardened runtime +
    // entitlements ON (both required for notarization); afterPack stands aside.
    identity: signed ? undefined : null,
    hardenedRuntime: signed,
    entitlements: signed ? 'build/entitlements.mac.plist' : undefined,
    entitlementsInherit: signed ? 'build/entitlements.mac.plist' : undefined,
    // mac.notarize intentionally omitted — env-driven (APPLE_* + signature).
  },
  dmg: {
    title: 'Loom ${version}',
  },
  // ---- Linux ---------------------------------------------------------------
  // Produces a Debian package installable via `sudo apt install ./Loom_*.deb`.
  // electron-builder builds the .deb natively (uses fakeroot/dpkg, both present
  // on the target). `executableName: 'loom'` makes the launcher binary and the
  // /usr/bin symlink lowercase `loom`, so a system install exposes `loom <dir>`
  // — the packaged main process resolves that folder from argv (or shows a
  // folder picker when launched bare), matching bin/loom.cjs's LOOM_ROOT path.
  // No signing concept on Linux, so this block is env-independent.
  linux: {
    target: [{ target: 'deb', arch: ['x64'] }],
    icon: 'build/icon.png',
    executableName: 'loom',
    category: 'Development',
    maintainer: 'nitekeeper <130331363+nitekeeper@users.noreply.github.com>',
    synopsis:
      'Desktop viewer with a built-in chat layer that AI agents use to communicate, watched live by a human.',
    artifactName: 'Loom_${version}_${arch}.${ext}',
  },
};
