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
 *   identity: null      -> electron-builder does NO signing at all (the
 *                          proven unsigned build; NOT ad-hoc). Use when unsigned.
 *   identity: undefined -> electron-builder auto-discovers a Developer ID
 *                          identity from the imported cert. Use when signing.
 *
 * NOTE on `mac.notarize`: deliberately left UNSET (undefined). electron-builder
 * 26 notarizes ONLY when the APPLE_* env vars are present AND the app carries a
 * Developer ID signature. Leaving it unset means notarization turns itself on
 * exactly when the credentials exist — no code change per release.
 * ============================================================ */

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
  files: ['dist/**', 'package.json'],
  asar: true,
  asarUnpack: ['dist/sql-wasm.wasm'],
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
    // Unsigned (no CSC_LINK): identity:null = proven unsigned build, NO
    // hardened runtime, NO entitlements — identical effect to the green
    // build today. Signed (CSC_LINK present): identity:undefined =
    // auto-discover Developer ID, hardened runtime + entitlements ON
    // (both required for notarization).
    identity: signed ? undefined : null,
    hardenedRuntime: signed,
    entitlements: signed ? 'build/entitlements.mac.plist' : undefined,
    entitlementsInherit: signed ? 'build/entitlements.mac.plist' : undefined,
    // mac.notarize intentionally omitted — env-driven (APPLE_* + signature).
  },
  dmg: {
    title: 'Loom ${version}',
  },
};
