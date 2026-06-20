// @ts-check
/* ============================================================
 * Loom — ESLint flat config (ESLint 9 + typescript-eslint 8)
 * ------------------------------------------------------------
 * Goal: a CORRECT baseline that catches real problems without
 * drowning in config artifacts. Notes on the deliberate choices:
 *
 *  - We use the typescript-eslint "recommended" (NON-type-checked)
 *    set: fast, no project-graph load. It DISABLES core `no-undef`
 *    for TS files on purpose — tsc already proves every identifier
 *    is defined, and core `no-undef` cannot see TS/ambient/DOM/
 *    Electron globals, so on a TS codebase it is a pure
 *    false-positive factory (the trial config's 3,789 `no-undef`
 *    hits were exactly that).
 *  - `ignores` excludes ALL build output, vendored design mockups,
 *    sample fixtures, and capture artifacts. Linting bundled/built
 *    output was the source of the `no-unreachable` /
 *    `no-unused-expressions` floods in the trial run.
 *  - Globals are scoped by area: Node for main-process / build
 *    scripts / tests, browser for the renderer UI.
 * ============================================================ */

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  // ---- Global ignores (most of the trial 17k lived here) --------------
  {
    ignores: [
      'node_modules/',
      'dist/', // esbuild output (build.mjs DIST) — never lint built bundles
      'release/', // scripts/pack-win.mjs portable output
      '.cache/',
      'coverage/',
      'playwright-report/', // Playwright HTML report (generated)
      'test-results/', // Playwright per-run output (generated)
      '.last-run.json',
      'documents/', // design mockups: Loom.html + *.jsx prototypes (not source)
      'fixtures/', // sample target repo used as test data, not Loom code
      'artifacts/', // screenshot captures
      'build/', // electron-builder icons/entitlements (assets, no JS to lint)
      '**/*.min.js',
      '.git/',
      '.loom/',
      '.ai/',
      '.claude/',
      '.atelier-worktrees/',
    ],
  },

  // ---- Base recommended rule sets -------------------------------------
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- Project-wide rule tuning ---------------------------------------
  {
    rules: {
      // Allow irregular whitespace (e.g. U+200B zero-width space, U+00A0
      // NBSP) INSIDE regex literals and strings — the codebase intentionally
      // matches/asserts on those code points (App.tsx strips zero-width
      // spaces; copy-serialize.mjs asserts no NBSP artifacts). Strings are
      // skipped by default; we add regex literals. Stray whitespace in CODE
      // is still flagged.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipRegExps: true }],
    },
  },

  // ---- TypeScript sources ---------------------------------------------
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      // src is authored as ESM (see CONTRACTS.md "Module strategy").
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Allow intentionally-unused identifiers when prefixed with `_`
      // (conventional throwaway args / catch bindings). tsc's
      // noUnusedLocals/noUnusedParameters already catches the rest.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // ---- Renderer / UI code runs in the browser (Chromium) --------------
  // React 18 automatic runtime: enable the react / react-hooks / jsx-a11y
  // plugins so the codebase's existing `eslint-disable react/no-danger`,
  // `react-hooks/exhaustive-deps`, and `jsx-a11y/*` directives resolve AND
  // we get genuine React linting value (rules-of-hooks, etc.).
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // jsx-a11y recommended as WARNINGS, not errors: this Electron UI has
      // many custom interactive widgets (treeitem/option roles, div click
      // handlers) whose full a11y convergence is a risky refactor out of
      // scope for an eslint baseline. We keep the signal (devs see it) but
      // do NOT gate CI on it. The codebase's existing jsx-a11y disable
      // directives are preserved and remain meaningful.
      ...Object.fromEntries(
        Object.keys(jsxA11y.configs.recommended.rules).map((name) => [name, 'warn']),
      ),
      // React 18 automatic JSX runtime — no `import React` needed in scope.
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      // TS provides prop typing; the prop-types runtime check is redundant.
      'react/prop-types': 'off',
      // The codebase deliberately uses dangerouslySetInnerHTML for already-
      // escaped/sanitized HTML (syntax highlight, sanitized markdown) and
      // documents each site with `eslint-disable react/no-danger -- <reason>`.
      // Turn the rule ON so those directives stay meaningful and any NEW,
      // undocumented dangerouslySetInnerHTML is flagged.
      'react/no-danger': 'error',
      // exhaustive-deps is a useful nudge but full convergence is risky on a
      // mature UI; keep it advisory (warn) so it informs without gating CI.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ---- Main process + shared code runs in Node (Electron main) --------
  {
    files: ['src/main/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}', 'src/testkit-entry.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ---- e2e specs: Playwright drives a real browser; Node + browser ----
  {
    files: ['test/e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ---- Build scripts / configs / tests authored as ESM (.mjs) ---------
  {
    files: ['**/*.mjs', 'build.mjs', 'scripts/**/*.mjs', 'tools/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // ---- CommonJS files (.cjs): bin shim + electron-builder config ------
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // `require()` is the native module system in CommonJS files — not an
      // anti-pattern here. (The rule targets ESM modules using require().)
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
