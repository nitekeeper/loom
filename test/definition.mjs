/* ============================================================
 * Loom — go-to-definition resolver unit tests (Electron-free)
 * ------------------------------------------------------------
 * Exercises the MAIN-process heuristic "go to definition" slice over the
 * built dist/testkit.cjs bundle (no Electron, no DOM):
 *
 *   - findDefinitionsInText (PURE regex core): per-language declaration
 *     forms with the right kind, whole-word boundaries (a substring of a
 *     longer name is NOT a match), 1-based line/col aligned with the Viewer,
 *     and the GTD-5 invariant (a USE — object-literal property / parameter —
 *     is tagged with a LOW-rank kind, never the strong declaration kind).
 *   - createDefinitionFinder (the Law-3-confined resolver) over a REAL temp
 *     dir + a Sandbox: finds class/function/const/interface/type/enum/python
 *     def, cross-file, ranks locality + declaration-kind strength, a USE
 *     (call site) is NOT mistaken for a definition, a malformed/keyword/
 *     over-long/non-identifier symbol returns empty, an escaping symlink
 *     yields nothing, and an escaping fromPath is dropped (no throw).
 *   - Bounds + determinism: MAX_DEFS cap -> truncated; repeated runs over the
 *     same corpus return an identical (strict-total-order) candidate order;
 *     the GTD-8 parity pin (the resolver's file-walk cap IS search.ts's
 *     exported MAX_FILES).
 *
 * Pattern mirrors test/acceptance.mjs (lazy testkit loader, real temp dirs,
 * symlink-tolerant Law-3 assertion) and the package.json EXPLICIT test list
 * (this file MUST be appended there or it never runs).
 * ============================================================ */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TESTKIT = path.join(root, 'dist', 'testkit.cjs');

let _kit = null;
async function kit() {
  if (_kit) return _kit;
  _kit = await import(TESTKIT);
  return _kit;
}

before(async () => {
  // Fail loud + early if the bundle is missing (build must run first).
  await import(TESTKIT).catch((e) => {
    throw new Error(
      `dist/testkit.cjs not found at ${TESTKIT} — run \`npm run build\` first. (${e})`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* findDefinitionsInText — PURE per-language declaration matcher        */
/* ------------------------------------------------------------------ */

test('def-core: TS class/interface/type/enum/function/const point at the symbol', async () => {
  const { findDefinitionsInText } = await kit();
  const ts = [
    'export class Widget {}', // line 1
    'export interface Shape { x: number }', // line 2
    'export type ID = string;', // line 3
    'export enum Color { Red, Blue }', // line 4
    'export function build() {}', // line 5
    'const total = 0;', // line 6
  ].join('\n');

  const cls = findDefinitionsInText(ts, 'Widget', 'ts');
  assert.equal(cls.length, 1, 'class Widget: one match');
  assert.equal(cls[0].line, 1, '1-based line');
  assert.equal(cls[0].kind, 'class');
  // col points at the SYMBOL (W of Widget at index 13 -> col 14), not `class`.
  assert.equal(cls[0].col, 'export class '.length + 1, 'col points at the symbol');

  assert.equal(findDefinitionsInText(ts, 'Shape', 'ts')[0].kind, 'interface');
  assert.equal(findDefinitionsInText(ts, 'ID', 'ts')[0].kind, 'type');
  assert.equal(findDefinitionsInText(ts, 'Color', 'ts')[0].kind, 'enum');
  assert.equal(findDefinitionsInText(ts, 'build', 'ts')[0].kind, 'function');
  assert.equal(findDefinitionsInText(ts, 'total', 'ts')[0].kind, 'variable');
});

test('def-core: const arrow + destructured + method shorthand kinds', async () => {
  const { findDefinitionsInText } = await kit();
  const ts = [
    'const handler = () => {};', // line 1: variable (arrow)
    'const { alpha, beta } = opts;', // line 2: destructured
    'class C {', // line 3
    '  doWork() { return 1; }', // line 4: method
    '}', // line 5
  ].join('\n');
  assert.equal(findDefinitionsInText(ts, 'handler', 'ts')[0].kind, 'variable');
  assert.equal(findDefinitionsInText(ts, 'alpha', 'ts')[0].kind, 'destructured');
  assert.equal(findDefinitionsInText(ts, 'beta', 'ts')[0].kind, 'destructured');
  assert.equal(findDefinitionsInText(ts, 'doWork', 'ts')[0].kind, 'method');
});

test('def-core: JS subset (function/class/const) — no TS-only forms needed', async () => {
  const { findDefinitionsInText } = await kit();
  const js = [
    'function makeThing() {}', // line 1
    'class Box {}', // line 2
    'const ratio = 1.5;', // line 3
  ].join('\n');
  assert.equal(findDefinitionsInText(js, 'makeThing', 'js')[0].kind, 'function');
  assert.equal(findDefinitionsInText(js, 'Box', 'js')[0].kind, 'class');
  assert.equal(findDefinitionsInText(js, 'ratio', 'js')[0].kind, 'variable');
});

test('def-core: Python def/class + column-0 module assignment', async () => {
  const { findDefinitionsInText } = await kit();
  const py = [
    'class Animal:', // line 1
    '    def speak(self):', // line 2: function (def)
    '        pass', // line 3
    'def main():', // line 4
    'MAX = 100', // line 5: column-0 assign
    'TIMEOUT: int = 30', // line 6: column-0 annotated assign
    '    indented = 1', // line 7: NOT module-level (indented) -> no match
  ].join('\n');
  assert.equal(findDefinitionsInText(py, 'Animal', 'py')[0].kind, 'class');
  assert.equal(findDefinitionsInText(py, 'speak', 'py')[0].kind, 'function');
  assert.equal(findDefinitionsInText(py, 'main', 'py')[0].kind, 'function');
  assert.equal(findDefinitionsInText(py, 'MAX', 'py')[0].kind, 'variable');
  assert.equal(findDefinitionsInText(py, 'TIMEOUT', 'py')[0].kind, 'variable');
  // An indented assignment is a local, not a module-level declaration.
  assert.deepEqual(
    findDefinitionsInText(py, 'indented', 'py'),
    [],
    'indented (non-column-0) assignment is not a module-level definition',
  );
});

test('def-core: generic fallback covers Go/Rust/Java declaration keywords', async () => {
  const { findDefinitionsInText, KIND_STRENGTH } = await kit();
  const go = [
    'func Compute(x int) int { return x }', // line 1: func declaration
    'type Server struct {}', // line 2: type
    'const Limit = 42', // line 3: const
    'result := Compute(5)', // line 4: a USE, not a decl
  ].join('\n');
  // Unknown extension -> generic family; declaration keyword union, low rank.
  // The DECLARATION line (1) is tagged 'generic' (a DECLARATION band kind); the
  // keyword-union match wins the (line,col) over the plain-occurrence fallback
  // because generic (DECLARATION band) outranks 'other' (the weakest USE).
  const compute = findDefinitionsInText(go, 'Compute', 'go');
  const decl = compute.find((d) => d.line === 1);
  assert.ok(decl, 'the func declaration is found');
  assert.equal(decl.kind, 'generic', 'the declaration line is tagged generic');
  assert.equal(findDefinitionsInText(go, 'Server', 'go')[0].kind, 'generic');
  assert.equal(findDefinitionsInText(go, 'Limit', 'go')[0].kind, 'generic');
  // TA-6: the call `Compute(5)` on line 4 is surfaced via the plain-occurrence
  // fallback, but tagged with the WEAKEST kind ('other') — never a declaration
  // kind — so it can never outrank the real `func Compute` declaration.
  const use = compute.find((d) => d.line === 4);
  assert.ok(use, 'the bare use is surfaced as a last-resort occurrence');
  assert.equal(use.kind, 'other', 'a call site is tagged the weakest kind, not a declaration');
  assert.ok(
    KIND_STRENGTH[decl.kind] < KIND_STRENGTH[use.kind],
    'the declaration outranks the bare-use occurrence',
  );
});

test('def-core: TA-6 — generic plain-occurrence fallback is capped at MAX_GENERIC_OCCURRENCES', async () => {
  const { findDefinitionsInText, MAX_GENERIC_OCCURRENCES } = await kit();
  // A symbol that appears ONLY as bare uses (no declaration keyword) in an
  // unknown-extension file, far more than the cap. All are kind 'other'; the
  // count is bounded so a pathological file cannot flood the candidate list.
  const lines = [];
  for (let i = 0; i < MAX_GENERIC_OCCURRENCES + 30; i++) lines.push(`x = Widget + ${i}`);
  const m = findDefinitionsInText(lines.join('\n'), 'Widget', 'xyz');
  assert.ok(m.length > 0, 'bare uses ARE surfaced for an unknown language (last resort)');
  assert.ok(m.length <= MAX_GENERIC_OCCURRENCES, 'plain occurrences are capped');
  assert.ok(m.every((d) => d.kind === 'other'), 'all bare occurrences are the weakest kind');
});

test('def-core: whole-word boundary — a substring of a longer name is NOT a match', async () => {
  const { findDefinitionsInText } = await kit();
  const js = ['const username = 1;', 'const user = 2;', 'const user_id = 3;'].join('\n');
  const m = findDefinitionsInText(js, 'user', 'js');
  assert.equal(m.length, 1, 'only the exact identifier `user` matches');
  assert.equal(m[0].line, 2, 'username / user_id are NOT mistaken for user');
});

test('def-core: TA-1 — the W(S) look-around treats `$` as part of the identifier (NOT a \\b boundary)', async () => {
  const { findDefinitionsInText } = await kit();
  // The DISTINGUISHING case for the look-around vs \b (definition-core.ts:24-25):
  // /\bfoo\b/ MATCHES `foo` inside `foo$bar` (\b treats `$` as a word boundary),
  // but W(S) = (?<![A-Za-z0-9_$])foo(?![A-Za-z0-9_$]) correctly REJECTS it
  // because `$` is an identifier char. This makes the look-around load-bearing:
  // a future "simplification" back to \b would turn THIS test red.
  const js = ['const foo$bar = 1;', 'const foo = 2;'].join('\n');
  const m = findDefinitionsInText(js, 'foo', 'js');
  assert.equal(m.length, 1, '`foo$bar` is NOT matched as `foo` (W(S), not \\b)');
  assert.equal(m[0].line, 2, 'only the real `const foo` on line 2 matches');
});

test('def-core: GTD-5 — a USE (property / parameter) is tagged LOW-rank, never a strong kind', async () => {
  const { findDefinitionsInText, KIND_STRENGTH } = await kit();
  const ts = [
    'function foo() { return 1; }', // line 1: the REAL declaration
    'const obj = { foo: 1 };', // line 2: object-literal property (a use)
    'function take(foo: number) { return foo; }', // line 3: parameter (a use)
  ].join('\n');
  const matches = findDefinitionsInText(ts, 'foo', 'ts');
  // The real `function foo` must be present AND its kind must be stronger than
  // any property/parameter match for the SAME symbol.
  const decl = matches.find((m) => m.line === 1);
  assert.ok(decl, 'the real function declaration is found');
  assert.equal(decl.kind, 'function');
  const prop = matches.find((m) => m.line === 2);
  assert.ok(prop, 'the object-literal property use is surfaced (last-resort)');
  assert.equal(prop.kind, 'property', 'property shorthand/key is tagged property');
  const param = matches.find((m) => m.line === 3 && m.col < 20);
  assert.ok(param, 'the parameter use is surfaced');
  assert.equal(param.kind, 'parameter', '(foo: T) parameter is tagged parameter');
  // The decisive invariant: the declaration kind is STRONGER (lower strength
  // number) than both the property and parameter uses, so the resolver can
  // never auto-jump to a use over the real declaration.
  assert.ok(
    KIND_STRENGTH[decl.kind] < KIND_STRENGTH[prop.kind],
    'function outranks property',
  );
  assert.ok(
    KIND_STRENGTH[decl.kind] < KIND_STRENGTH[param.kind],
    'function outranks parameter',
  );
});

test('def-core: empty / non-string / unknown symbol yields no matches', async () => {
  const { findDefinitionsInText } = await kit();
  assert.deepEqual(findDefinitionsInText('const a = 1;', '', 'ts'), []);
  assert.deepEqual(findDefinitionsInText('const a = 1;', 'zzz', 'ts'), []);
  // Defensive: a non-string text or symbol returns [] (never throws).
  assert.deepEqual(findDefinitionsInText(/** @type any */ (null), 'a', 'ts'), []);
});

/* ------------------------------------------------------------------ */
/* createDefinitionFinder — Law-3-confined resolver over a real tree    */
/* ------------------------------------------------------------------ */

test('finder: finds a class definition across files (cross-file resolution)', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    writeFileSync(path.join(dir, 'model.ts'), 'export class User {\n  name = "";\n}\n');
    mkdirSync(path.join(dir, 'app'));
    writeFileSync(path.join(dir, 'app', 'main.ts'), 'const u = new User();\n');
    const finder = createDefinitionFinder(createSandbox(dir));
    const res = finder.find({ symbol: 'User' });
    assert.equal(res.truncated, false);
    // The class declaration is found; the `new User()` USE in main.ts is a
    // call site and must NOT be reported as a definition.
    const decl = res.candidates.find((c) => c.path === 'model.ts');
    assert.ok(decl, 'the cross-file class declaration is found');
    assert.equal(decl.line, 1);
    assert.equal(decl.kind, 'class');
    assert.ok(
      !res.candidates.some((c) => c.path === 'app/main.ts'),
      'the `new User()` use is NOT mistaken for a definition',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finder: resolves function / const / interface / type / enum / python def', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    writeFileSync(
      path.join(dir, 'lib.ts'),
      [
        'export function calc() { return 1; }',
        'export const RATE = 0.1;',
        'export interface Opts { v: number }',
        'export type Id = string;',
        'export enum Mode { A, B }',
      ].join('\n') + '\n',
    );
    writeFileSync(path.join(dir, 'svc.py'), 'class Service:\n    def run(self):\n        pass\n');
    const finder = createDefinitionFinder(createSandbox(dir));
    const k = (s) => finder.find({ symbol: s }).candidates[0]?.kind;
    assert.equal(k('calc'), 'function');
    assert.equal(k('RATE'), 'variable');
    assert.equal(k('Opts'), 'interface');
    assert.equal(k('Id'), 'type');
    assert.equal(k('Mode'), 'enum');
    assert.equal(k('Service'), 'class', 'python class resolves');
    assert.equal(k('run'), 'function', 'python def resolves');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finder: ranks the SAME-FILE / SAME-DIR candidate above elsewhere (locality)', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    // Three real `const Token` declarations in different locations.
    writeFileSync(path.join(dir, 'here.ts'), 'const Token = 1;\n');
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub', 'near.ts'), 'const Token = 2;\n');
    writeFileSync(path.join(dir, 'far.ts'), 'const Token = 3;\n');
    const finder = createDefinitionFinder(createSandbox(dir));

    // From here.ts: the SAME-FILE declaration must rank first.
    const fromHere = finder.find({ symbol: 'Token', fromPath: 'here.ts' });
    assert.equal(fromHere.candidates[0].path, 'here.ts', 'same-file wins');

    // From sub/other.ts: the SAME-DIR declaration (sub/near.ts) must rank first.
    const fromSub = finder.find({ symbol: 'Token', fromPath: 'sub/other.ts' });
    assert.equal(fromSub.candidates[0].path, 'sub/near.ts', 'same-dir wins');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finder: TA-2 — the export-visibility tier decides between two equal-locality/kind candidates', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    // Two SAME-DIR files declaring `Token` as the SAME kind (variable); one is
    // exported, one is not. From a third same-dir file, locality (same-dir) and
    // kind (variable) are equal, so the EXPORT tier is the sole deciding factor —
    // the exported declaration must rank first. (Flipping exportRank turns this
    // red: the only thing distinguishing the two is `export`.)
    writeFileSync(path.join(dir, 'exported.ts'), 'export const Token = 1;\n');
    writeFileSync(path.join(dir, 'plain.ts'), 'const Token = 2;\n');
    const finder = createDefinitionFinder(createSandbox(dir));
    const res = finder.find({ symbol: 'Token', fromPath: 'caller.ts' });
    assert.equal(res.candidates.length, 2, 'both declarations are found');
    assert.equal(res.candidates[0].path, 'exported.ts', 'the exported declaration ranks first');
    assert.equal(res.candidates[1].path, 'plain.ts', 'the non-exported declaration ranks below');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finder: CI-1 — the cross-file DECLARATION outranks same-file USES (import/property/parameter)', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    // The exact CI-1 reproduction: the declaration lives in model.ts; the
    // ORIGIN file (view.ts) only USES the symbol — a same-file import binding +
    // a parameter. Under the OLD locality-first ranking the same-file import
    // (locality tier 0) floated to index 0, so a freshly-imported symbol jumped
    // to its own import line instead of the real declaration. The CI-1 fix ranks
    // the DECLARATION-vs-USE band BEFORE locality, so the cross-file class wins.
    writeFileSync(path.join(dir, 'model.ts'), 'export class Account {}\n');
    writeFileSync(
      path.join(dir, 'view.ts'),
      'import { Account } from "./model";\nconst a = new Account();\nfunction render(Account) {}\n',
    );
    const finder = createDefinitionFinder(createSandbox(dir));
    const res = finder.find({ symbol: 'Account', fromPath: 'view.ts' });
    // The TOP candidate MUST be the real declaration, NOT the same-file import.
    assert.equal(res.candidates[0].path, 'model.ts', 'cross-file declaration is #1');
    assert.equal(res.candidates[0].kind, 'class', 'the #1 candidate is the class decl');
    // The same-file import binding is present but ranked BELOW the declaration
    // and tagged 'import' (NOT mis-tagged 'property').
    const imp = res.candidates.find((c) => c.path === 'view.ts' && c.line === 1);
    assert.ok(imp, 'the import binding is surfaced (last-resort)');
    assert.equal(imp.kind, 'import', 'an import binding is tagged import, not property');
    // Exactly ONE real declaration -> the classify layer auto-jumps (CI-2);
    // proven here by the declaration being the sole non-use candidate.
    const decls = res.candidates.filter(
      (c) => !['import', 'property', 'parameter', 'other'].includes(c.kind),
    );
    assert.equal(decls.length, 1, 'exactly one real declaration in the set');
    assert.equal(decls[0].path, 'model.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('def-core: CI-1 — every import form is tagged "import" (a USE band, never a declaration)', async () => {
  const { findDefinitionsInText, isDeclarationKind } = await kit();
  const forms = [
    'import foo from "x";',
    'import { foo } from "x";',
    'import { bar as foo } from "x";',
    'import * as foo from "x";',
    'import def, { foo } from "x";',
  ];
  for (const line of forms) {
    const m = findDefinitionsInText(line + '\n', 'foo', 'ts');
    const imp = m.find((x) => x.line === 1);
    assert.ok(imp, `the import binding is matched in: ${line}`);
    assert.equal(imp.kind, 'import', `tagged import: ${line}`);
    assert.equal(isDeclarationKind('import'), false, 'import is in the USE band');
  }
  // A plain object literal { foo } on its own is NOT an import -> tagged property.
  const obj = findDefinitionsInText('const o = { foo: 1 };\n', 'foo', 'ts');
  assert.equal(obj.find((x) => x.line === 1)?.kind, 'property', 'a non-import { foo } stays property');
});

test('def-core: CI-1 — within the USE band a real declaration is still STRONGER than an import', async () => {
  const { KIND_STRENGTH, USE_BAND_FLOOR } = await kit();
  // The band split is the invariant CI-1 ranking + CI-2 dispatch both rely on.
  for (const k of ['class', 'interface', 'enum', 'type', 'function', 'method', 'variable', 'destructured', 're-export', 'generic']) {
    assert.ok(KIND_STRENGTH[k] < USE_BAND_FLOOR, `${k} is in the DECLARATION band (< ${USE_BAND_FLOOR})`);
  }
  for (const k of ['import', 'property', 'parameter', 'other']) {
    assert.ok(KIND_STRENGTH[k] >= USE_BAND_FLOOR, `${k} is in the USE band (>= ${USE_BAND_FLOOR})`);
  }
  // import is the STRONGEST use (so an import line is reported as 'import', not
  // a weaker property/parameter when the regex overlaps).
  assert.ok(KIND_STRENGTH['import'] < KIND_STRENGTH['property'], 'import < property');
  assert.ok(KIND_STRENGTH['property'] < KIND_STRENGTH['parameter'], 'property < parameter');
});

test('finder: a use (call / reference) is NOT mistaken for a definition', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    writeFileSync(path.join(dir, 'def.ts'), 'export function doThing() {}\n');
    writeFileSync(
      path.join(dir, 'use.ts'),
      'import { doThing } from "./def";\ndoThing();\nconst x = doThing;\n',
    );
    const finder = createDefinitionFinder(createSandbox(dir));
    const res = finder.find({ symbol: 'doThing' });
    // The strongest (top) candidate MUST be the real declaration in def.ts.
    assert.equal(res.candidates[0].path, 'def.ts');
    assert.equal(res.candidates[0].kind, 'function');
    // The bare call `doThing();` (line 2 of use.ts) is not a declaration form,
    // so it is not surfaced as one — only the import/assignment lines could be,
    // and never with a strong declaration kind.
    // CORR-1: assert against the STRONG kinds 'function' AND 'method' — the old
    // test only checked 'function', so a method-tagged call site (the CORR-1
    // bug) slipped through; the bare `doThing();` must NOT be tagged as either.
    const useDecls = res.candidates.filter(
      (c) =>
        c.path === 'use.ts' && (c.kind === 'function' || c.kind === 'method'),
    );
    assert.equal(
      useDecls.length,
      0,
      'no USE in use.ts is tagged as a function/method declaration',
    );
    // Specifically the bare call line (line 2) must contribute no STRONG-kind
    // candidate at all (it may legitimately appear as a low-rank 'other'/none).
    const callLine = res.candidates.filter(
      (c) => c.path === 'use.ts' && c.line === 2,
    );
    for (const c of callLine) {
      assert.notEqual(c.kind, 'method', 'bare call line is not tagged method');
      assert.notEqual(c.kind, 'function', 'bare call line is not tagged function');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finder: a malformed / keyword / over-long / non-identifier symbol returns empty', async () => {
  const { createSandbox, createDefinitionFinder, MAX_SYMBOL_LENGTH } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    writeFileSync(path.join(dir, 'a.ts'), 'export class Real {}\n');
    const finder = createDefinitionFinder(createSandbox(dir));
    const empty = { candidates: [], truncated: false };
    assert.deepEqual(finder.find({ symbol: '   ' }), empty, 'whitespace -> empty');
    assert.deepEqual(finder.find({ symbol: 'class' }), empty, 'keyword -> empty');
    assert.deepEqual(finder.find({ symbol: 'true' }), empty, 'literal -> empty');
    assert.deepEqual(finder.find({ symbol: 'a.b.c' }), empty, 'dotted path -> empty');
    assert.deepEqual(finder.find({ symbol: 'a b' }), empty, 'multi-token -> empty');
    assert.deepEqual(finder.find({ symbol: '../secret' }), empty, 'path-like -> empty');
    assert.deepEqual(finder.find({ symbol: 'a.*b' }), empty, 'regex metachar -> empty');
    assert.deepEqual(
      finder.find({ symbol: 'x'.repeat(MAX_SYMBOL_LENGTH + 1) }),
      empty,
      'over-long -> empty',
    );
    // A non-object / missing symbol also fail-softs (never throws).
    assert.deepEqual(finder.find(undefined), empty, 'no req -> empty');
    assert.deepEqual(finder.find({}), empty, 'no symbol field -> empty');
    assert.deepEqual(finder.find({ symbol: 42 }), empty, 'non-string symbol -> empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finder: stays CONFINED — an escaping symlink yields nothing (Law 3)', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'loom-def-secret-'));
  try {
    // A secret OUTSIDE the root that DECLARES the symbol.
    writeFileSync(path.join(outside, 'secret.ts'), 'export class Secret {}\n');
    // A legitimate in-root declaration so the run isn't empty for a wrong reason.
    writeFileSync(path.join(dir, 'inside.ts'), 'export class Secret {}\n');
    let symlinked = true;
    try {
      symlinkSync(path.join(outside, 'secret.ts'), path.join(dir, 'escape.ts'));
    } catch {
      symlinked = false; // some sandboxes disallow symlink creation
    }
    // TA-4: when symlinks are UNSUPPORTED here, the escaping symlink was never
    // created, so a bare `leaked===false` would pass vacuously (nothing to leak).
    // Make the assertion non-vacuous by writing a REAL in-root file named
    // `escape.ts` containing the symbol — proving an `escape`-named path IS
    // reachable, so the only reason it would be ABSENT in symlink mode is the
    // symlink-containment exclusion, not a path-substring coincidence.
    if (!symlinked) {
      writeFileSync(path.join(dir, 'escape.ts'), 'export class Secret {}\n');
    }
    const finder = createDefinitionFinder(createSandbox(dir));
    const res = finder.find({ symbol: 'Secret' });
    if (symlinked) {
      // The escaping SYMLINK target must never leak.
      const leaked = res.candidates.some((c) => c.path.includes('escape'));
      assert.equal(leaked, false, 'the escaping symlink target must not leak (Law 3)');
    } else {
      // No symlink: the in-root `escape.ts` we just wrote IS in the root, so it
      // MUST be found — proving the name is reachable (the symlink-mode absence
      // above is a real exclusion, not a coincidence).
      assert.ok(
        res.candidates.some((c) => c.path === 'escape.ts'),
        'a REAL in-root escape.ts is found (symlink unsupported; name reachability proven)',
      );
    }
    assert.ok(
      res.candidates.some((c) => c.path === 'inside.ts'),
      symlinked
        ? 'the in-root declaration is found while the symlink escape is excluded'
        : 'the in-root declaration is found (symlink unsupported here; confinement holds)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('finder: an escaping fromPath is DROPPED (no throw), the run still resolves', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    writeFileSync(path.join(dir, 'a.ts'), 'export class Thing {}\n');
    const finder = createDefinitionFinder(createSandbox(dir));
    // A traversal fromPath must not throw — it is dropped and only the ranking
    // loses its locality hint; the run still returns the in-root declaration.
    const res = finder.find({ symbol: 'Thing', fromPath: '../../../etc/passwd' });
    assert.equal(res.candidates.length, 1, 'the in-root declaration still resolves');
    assert.equal(res.candidates[0].path, 'a.ts');
    // A NUL-byte fromPath is likewise dropped, not thrown.
    const res2 = finder.find({ symbol: 'Thing', fromPath: 'a\0.ts' });
    assert.equal(res2.candidates.length, 1, 'NUL-byte fromPath dropped, run resolves');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finder: binary / image files are never scanned', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    // A .png whose raw bytes literally contain "class Hidden" — must be skipped.
    writeFileSync(path.join(dir, 'img.png'), Buffer.from('class Hidden {}', 'binary'));
    writeFileSync(path.join(dir, 'real.ts'), 'export class Hidden {}\n');
    const finder = createDefinitionFinder(createSandbox(dir));
    const res = finder.find({ symbol: 'Hidden' });
    assert.ok(
      !res.candidates.some((c) => c.path.endsWith('.png')),
      'image bytes are never scanned for definitions',
    );
    assert.ok(res.candidates.some((c) => c.path === 'real.ts'), 'the real source is found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Bounds + determinism                                                 */
/* ------------------------------------------------------------------ */

test('finder: MAX_DEFS cap produces truncated:true', async () => {
  const { createSandbox, createDefinitionFinder, MAX_DEFS } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    // MAX_DEFS + a margin of real declarations of the SAME symbol, one per file
    // (so the global candidate cap — not the per-file cap — is the one hit).
    const n = MAX_DEFS + 25;
    for (let i = 0; i < n; i++) {
      writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.ts`), 'const Dup = 1;\n');
    }
    const finder = createDefinitionFinder(createSandbox(dir));
    const res = finder.find({ symbol: 'Dup' });
    assert.equal(res.truncated, true, 'exceeding MAX_DEFS sets truncated');
    assert.ok(res.candidates.length <= MAX_DEFS, 'candidate list is capped at MAX_DEFS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finder: ranking is a strict TOTAL ORDER — repeated runs are byte-identical', async () => {
  const { createSandbox, createDefinitionFinder } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-def-'));
  try {
    // Several equal-strength declarations across files + dirs so the path-lex
    // final tie-break is exercised; the order must be reproducible.
    writeFileSync(path.join(dir, 'b.ts'), 'const Key = 1;\n');
    writeFileSync(path.join(dir, 'a.ts'), 'const Key = 2;\n');
    mkdirSync(path.join(dir, 'm'));
    writeFileSync(path.join(dir, 'm', 'c.ts'), 'const Key = 3;\n');
    const finder = createDefinitionFinder(createSandbox(dir));
    const run1 = finder.find({ symbol: 'Key' }).candidates.map((c) => `${c.path}:${c.line}:${c.col}`);
    const run2 = finder.find({ symbol: 'Key' }).candidates.map((c) => `${c.path}:${c.line}:${c.col}`);
    assert.deepEqual(run1, run2, 'identical corpus -> identical candidate order');
    // The final tie-break is path-lexicographic among equal locality/kind, so
    // a.ts precedes b.ts precedes m/c.ts.
    assert.deepEqual(run1, ['a.ts:1:7', 'b.ts:1:7', 'm/c.ts:1:7'], 'path-lex total order');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finder: GTD-8 parity pin — the resolver file-walk cap IS search.ts MAX_FILES', async () => {
  const { MAX_FILES } = await kit();
  // The resolver imports MAX_FILES directly from search.ts (single source of
  // truth). This pins the exported value so a future change to search.ts's cap
  // that the resolver does not track would fail CI here. (The resolver has no
  // separate file-walk cap constant — it re-uses this one — so equality with
  // the documented 2000 is the contract.)
  assert.equal(MAX_FILES, 2_000, 'MAX_FILES is the shared 2000 file-walk cap');
});

test('def-core: GTD-8 parity — MAX_DEFS_PER_FILE bounds a single pathological file', async () => {
  const { findDefinitionsInText, MAX_DEFS_PER_FILE } = await kit();
  // A file declaring the same symbol far more than the per-file cap.
  const lines = [];
  for (let i = 0; i < MAX_DEFS_PER_FILE + 50; i++) lines.push('const Spam = 1;');
  const m = findDefinitionsInText(lines.join('\n'), 'Spam', 'ts');
  assert.ok(m.length <= MAX_DEFS_PER_FILE, 'per-file matches are capped');
});

test('def-core: SEC-GTD-1 — a deeply-indented line that mentions the symbol does NOT blow up the method pattern (no ReDoS)', async () => {
  const { findDefinitionsInText, MAX_DEF_SCAN_LINE_LENGTH } = await kit();
  // The adversarial shape that drove the catastrophic backtracking: a long run
  // of leading whitespace followed by the searched symbol with NO opening paren
  // (e.g. a deeply-indented YAML/Markdown-table/comment line `        foo: x`).
  // With the vulnerable pattern this took ~5s on a 50k-space line and scaled
  // quadratically; the strictly-linear `(?:modifier\s+)*` pattern (SEC-GTD-1)
  // plus the tight per-line prefix clip (SEC-GTD-2) keep it sub-millisecond.
  const widths = [10_000, 30_000, 60_000];
  for (const w of widths) {
    const line = ' '.repeat(w) + 'foo: bar';
    const t0 = process.hrtime.bigint();
    const m = findDefinitionsInText(line, 'foo', 'ts');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // A generous wall-clock budget (the fixed pattern is ~0.1ms; the old one was
    // hundreds of ms to ~5s) — orders of magnitude of headroom so this fails
    // ONLY if a future edit reintroduces super-linear backtracking.
    assert.ok(
      ms < 250,
      `findDefinitionsInText on a ${w}-space line stayed fast (was ${ms.toFixed(1)}ms)`,
    );
    // `foo` past the prefix clip is not matched as a method (no '(' anyway), but
    // the inline `foo:` property within the scan window is still surfaced (a use,
    // low rank) — so the scan still produces correct, bounded results.
    assert.ok(Array.isArray(m), 'returns an array (never throws / never hangs)');
  }
  // The per-line definition scan window is the stricter of the two bounds.
  assert.ok(
    MAX_DEF_SCAN_LINE_LENGTH <= 50_000,
    'the definition per-line scan window is no looser than search-core',
  );
});

test('def-core: SEC-GTD-1 — the method pattern still matches every legitimate form', async () => {
  const { findDefinitionsInText } = await kit();
  // The fixed `(?:modifier\s+)*` method pattern must NOT regress recall: each of
  // these is a real method/class-field declaration of `render` and must resolve.
  // CORR-1: the pattern now requires the signature to be followed by a BODY
  // brace `{` (with an optional return type) so a CALL statement is rejected —
  // every form below ends in `{` (or `{}`), incl. the `(): number {` return-type
  // form, and must still match.
  const forms = [
    '  render() {}',
    '  public render() {}',
    '  public static async render () {}',
    '  get render() {}',
    '  private readonly render(arg) {}',
    '  render(): number { return 1; }',
  ];
  for (const form of forms) {
    const m = findDefinitionsInText(`class C {\n${form}\n}`, 'render', 'ts');
    const onLine2 = m.find((d) => d.line === 2);
    assert.ok(onLine2, `method form is matched: "${form.trim()}"`);
    assert.equal(onLine2.kind, 'method', `"${form.trim()}" is tagged method`);
  }
});

test('def-core: CORR-1 — a bare CALL statement is NOT mis-tagged as a method definition', async () => {
  const { findDefinitionsInText } = await kit();
  // The earlier method pattern stopped at the opening paren, so it could not tell
  // a SIGNATURE (`render() {`) from a CALL STATEMENT (`render();`) and mis-tagged
  // call sites as STRONG `method` definitions — leaking into the candidate count
  // (breaking 1->auto-jump) and even letting a sole out-of-tree symbol auto-jump
  // onto a call site. The body-brace requirement rejects ALL of these calls.
  const calls = [
    'render();',
    '  render();',
    'render(a, b);',
    'render()',
    'const r = render();',
    'await render();',
    'return render();',
  ];
  for (const call of calls) {
    const m = findDefinitionsInText(call, 'render', 'ts');
    const asMethod = m.find((d) => d.kind === 'method');
    assert.equal(
      asMethod,
      undefined,
      `call statement is NOT tagged method: "${call}"`,
    );
  }
  // End-to-end shape from CORR-1: one real declaration + two bare call sites.
  // The real `function render` resolves; the call sites are NOT method defs.
  const text =
    'export function render() { return draw(); }\nrender();\nconst x = () => render();\n';
  const defs = findDefinitionsInText(text, 'render', 'ts');
  const fns = defs.filter((d) => d.kind === 'function');
  const methods = defs.filter((d) => d.kind === 'method');
  assert.equal(fns.length, 1, 'exactly one function declaration is found');
  assert.equal(fns[0].line, 1, 'the function declaration is on line 1');
  assert.equal(methods.length, 0, 'no call site leaks in as a method definition');
});

test('def-core: SEC-1 / SEC-GTD-A — the GENERIC family declaration pattern does NOT blow up (no ReDoS)', async () => {
  const { findDefinitionsInText } = await kit();
  // SEC-2: the only prior ReDoS test drove ext='ts' (the method pattern) and
  // NEVER reached the generic-family union, which runs for unknown/other
  // extensions. The generic pattern reintroduced the ambiguous-whitespace
  // overlap SEC-GTD-1 fixed: `<keyword> <many spaces> <non-matching tail>`
  // backtracked quadratically (~14ms per clipped 4000-char line, minutes
  // aggregated). The unambiguous `(?:[A-Za-z0-9_$<>,]+\s+)*` form is linear.
  //
  // The fast-reject is defeated on purpose by placing a whole-word `foo` early
  // on the line (so the symbol genuinely occurs), then a declaration keyword
  // followed by a long space run that never completes a match.
  const genericExts = ['', 'go', 'rs', 'java', 'md', 'json', 'txt', 'yaml'];
  for (const ext of genericExts) {
    for (const w of [10_000, 30_000, 60_000]) {
      const line = 'foo; class ' + ' '.repeat(w) + 'q';
      const t0 = process.hrtime.bigint();
      const m = findDefinitionsInText(line, 'foo', ext);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(
        ms < 250,
        `generic family (ext='${ext}') on a ${w}-space line stayed fast (was ${ms.toFixed(1)}ms)`,
      );
      assert.ok(Array.isArray(m), 'returns an array (never throws / never hangs)');
    }
  }
  // Aggregate (multi-line product): MANY adversarial lines must also stay bounded
  // — the byte budget is checked only BETWEEN files, so this guards the per-find
  // wall clock the per-line clip alone does not bound.
  const adversarialLine = 'foo; class ' + ' '.repeat(3_990) + 'q';
  const bigText = Array.from({ length: 1_000 }, () => adversarialLine).join('\n');
  const t0 = process.hrtime.bigint();
  const m = findDefinitionsInText(bigText, 'foo', '');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(
    ms < 1_000,
    `1000 adversarial generic-family lines stayed bounded (was ${ms.toFixed(1)}ms)`,
  );
  assert.ok(Array.isArray(m), 'returns an array on the multi-line corpus');
});

test('def-core: SEC-1 / SEC-GTD-A — the GENERIC family still matches every legitimate form', async () => {
  const { findDefinitionsInText } = await kit();
  // The fixed generic pattern must NOT regress recall: each is a real
  // declaration of `fooBarBaz` in some non-TS/JS/PY language and must resolve.
  const forms = [
    'class fooBarBaz',
    'public static final fooBarBaz',
    'export interface Foo<T, U> extends Bar fooBarBaz',
    'impl <T> Trait for fooBarBaz',
    'const fooBarBaz = 1',
    'func fooBarBaz()',
    'fn fooBarBaz()',
    'struct fooBarBaz {',
  ];
  for (const form of forms) {
    // ext '' / 'go' route to the generic family.
    const m = findDefinitionsInText(form, 'fooBarBaz', 'go');
    const hit = m.find((d) => d.kind === 'generic');
    assert.ok(hit, `generic declaration form is matched: "${form}"`);
  }
  // A Go method-receiver form `func (r *T) fooBarBaz()` is (intentionally) NOT a
  // generic-keyword match — the receiver parens break the qualifier run — so it
  // is only surfaced as a bare 'other' occurrence, never a 'generic' declaration.
  // This parity with the pre-fix behavior confirms no spurious widening.
  const recv = findDefinitionsInText('func (r *T) fooBarBaz()', 'fooBarBaz', 'go');
  const asGeneric = recv.find((d) => d.kind === 'generic');
  assert.equal(asGeneric, undefined, 'receiver-method form is not a generic decl');
});

/* ------------------------------------------------------------------ */
/* RENDERER SLICE — wordAt (word-under-caret extraction, PURE/no DOM)   */
/* ------------------------------------------------------------------ */

test('wordAt: extracts the identifier the caret is inside', async () => {
  const { wordAt } = await kit();
  const line = 'const widget = makeWidget();';
  // Caret in the middle of `widget` (col 8, 0-based, points at 'd').
  const w = wordAt(line, 8);
  assert.ok(w, 'an identifier is found');
  assert.equal(w.symbol, 'widget');
  assert.equal(w.start, 6, '0-based start of widget');
  assert.equal(w.end, 12, '0-based end (exclusive) of widget');
  // The slice [start,end) round-trips to the symbol.
  assert.equal(line.slice(w.start, w.end), 'widget');
});

test('wordAt: a caret at the RIGHT edge of an identifier still resolves it', async () => {
  const { wordAt } = await kit();
  const line = 'return total;';
  // Caret AFTER the last char of `total` (col 12 = the ';'); the char to the
  // LEFT is an identifier char, so `total` is resolved (editor word-at-caret).
  const w = wordAt(line, 12);
  assert.ok(w, 'the left identifier is resolved at the right edge');
  assert.equal(w.symbol, 'total');
});

test('wordAt: member access resolves the HOVERED segment (dot stops expansion)', async () => {
  const { wordAt } = await kit();
  const line = 'obj.method.deep';
  // Caret in `method` (col 6) resolves `method`, not `obj.method.deep`.
  assert.equal(wordAt(line, 6).symbol, 'method');
  // Caret in `obj` (col 1) resolves `obj`.
  assert.equal(wordAt(line, 1).symbol, 'obj');
  // Caret in `deep` (col 12) resolves `deep`.
  assert.equal(wordAt(line, 12).symbol, 'deep');
});

test('wordAt: a pure number is NOT a symbol; the numeric prefix of a token is skipped', async () => {
  const { wordAt } = await kit();
  // A bare number returns null (a number is never a symbol).
  assert.equal(wordAt('const x = 42;', 10), null, 'caret in 42 -> null');
  assert.equal(wordAt('3.14', 1), null, 'caret in a float -> null');
  // `42px`-style: the digit-start guard walks past leading digits to the first
  // identifier-start char, yielding the identifier tail.
  const w = wordAt('42px', 0);
  assert.ok(w, 'a digit-led token still resolves its identifier tail');
  assert.equal(w.symbol, 'px');
  assert.equal(w.start, 2, 'start advanced past the leading digits');
});

test('wordAt: whitespace / punctuation / blank line / empty -> null (no symbol)', async () => {
  const { wordAt } = await kit();
  // 'a + b' indices: 0='a' 1=' ' 2='+' 3=' ' 4='b'. A caret with NEITHER side an
  // identifier char (col 2 between space+plus, col 3 between plus+space) -> null.
  // (Col 1 — the right edge of `a` — intentionally resolves `a`, per the right-
  // edge probe; that case is covered by the right-edge test.)
  assert.equal(wordAt('a + b', 2), null, 'caret on the +');
  assert.equal(wordAt('a + b', 3), null, 'caret on the space after +');
  assert.equal(wordAt('   ', 1), null, 'caret on blank text');
  assert.equal(wordAt('', 0), null, 'empty line -> null');
});

test('wordAt: a KEYWORD or LITERAL is never offered as a symbol', async () => {
  const { wordAt, KEYWORDS, LITERALS } = await kit();
  // Spot-check a few; then assert EVERY keyword/literal is rejected so the
  // rejection list shares ONE source with the highlighter.
  assert.equal(wordAt('return x;', 2), null, 'return is a keyword');
  assert.equal(wordAt('if (x) {}', 0), null, 'if is a keyword');
  assert.equal(wordAt('class Foo {}', 2), null, 'class is a keyword');
  assert.equal(wordAt('const ok = true;', 12), null, 'true is a literal');
  for (const kw of [...KEYWORDS, ...LITERALS]) {
    // Each keyword/literal on its own line, caret at col 0, must be rejected.
    assert.equal(wordAt(kw + ' ', 0), null, `keyword/literal '${kw}' is rejected`);
  }
});

test('wordAt: out-of-range / non-finite offset clamps without throwing', async () => {
  const { wordAt } = await kit();
  const line = 'value';
  // A column past the end clamps to the end -> resolves the trailing identifier.
  assert.equal(wordAt(line, 999).symbol, 'value', 'past-end col clamps to end');
  // A negative column clamps to 0 -> resolves the leading identifier.
  assert.equal(wordAt(line, -5).symbol, 'value', 'negative col clamps to 0');
  // NaN / non-finite offset returns null (defensive, never throws).
  assert.equal(wordAt(line, NaN), null, 'NaN offset -> null');
  // A non-string line returns null (defensive).
  assert.equal(wordAt(/** @type any */ (null), 0), null, 'non-string line -> null');
});

test('wordAt: $ and _ are identifier chars (matches highlight.ts IDENT class)', async () => {
  const { wordAt } = await kit();
  assert.equal(wordAt('const $el = 1;', 7).symbol, '$el', '$ leads an identifier');
  assert.equal(wordAt('const _priv = 1;', 7).symbol, '_priv', '_ leads an identifier');
  assert.equal(wordAt('a_b$c2', 3).symbol, 'a_b$c2', 'mixed _/$/digits in the tail');
});

test('lineIdentifiers: A11Y-GTD-01 — lists every resolvable identifier left-to-right, de-duped, keywords/numbers skipped', async () => {
  const { lineIdentifiers } = await kit();
  // The finding's example: a keyboard-only user must be able to reach ANY of
  // these, not just the first.
  assert.deepEqual(
    lineIdentifiers('const result = transform(input)').map((w) => w.symbol),
    ['result', 'transform', 'input'],
    'all three identifiers surface (const is a keyword -> skipped)',
  );
  // De-dupe by symbol text (first occurrence kept).
  assert.deepEqual(
    lineIdentifiers('const foo = foo + foo').map((w) => w.symbol),
    ['foo'],
    'repeated symbol appears once',
  );
  // Keywords + literals + pure numbers are never offered.
  assert.deepEqual(
    lineIdentifiers('if (true) return x42 + 99').map((w) => w.symbol),
    ['x42'],
    'keyword/literal/number skipped; only the real identifier',
  );
  // Each entry carries its 0-based start so the chooser can map it to a column.
  const got = lineIdentifiers('  alpha beta');
  assert.equal(got[0].symbol, 'alpha');
  assert.equal(got[0].start, 2, '0-based start of the first identifier');
  assert.equal(got[1].symbol, 'beta');
  assert.equal(got[1].start, 8);
  // Empty / blank / punctuation-only lines -> [].
  assert.deepEqual(lineIdentifiers(''), []);
  assert.deepEqual(lineIdentifiers('   '), []);
  assert.deepEqual(lineIdentifiers('=> { } ;'), []);
});

/* ------------------------------------------------------------------ */
/* RENDERER SLICE — shared match highlighter (GTD-6, Law-1 escaping)    */
/* ------------------------------------------------------------------ */

test('match-highlight: highlightedMatchHtml escapes EACH slice independently + marks the hit', async () => {
  const { highlightedMatchHtml } = await kit();
  // Hostile content in every slice: before/hit/after must each be escaped, and
  // ONLY the hit is wrapped in <mark class="search-hit">.
  const line = '<a>foo</a>';
  // Mark the `foo` run (indices 3..6).
  const html = highlightedMatchHtml(line, 3, 6);
  assert.equal(
    html,
    '&lt;a&gt;<mark class="search-hit">foo</mark>&lt;/a&gt;',
    'before/after escaped, hit marked (no raw markup survives)',
  );
  // No unescaped angle bracket from the FILE content ever survives.
  assert.ok(!/[<>](?!mark|\/mark)/.test(html.replace(/<\/?mark[^>]*>/g, '')), 'no raw < or > leaks');
});

test('match-highlight: a hostile hit is itself escaped inside the <mark>', async () => {
  const { highlightedMatchHtml } = await kit();
  const line = 'x<script>y';
  // Mark the `<script>` run (indices 1..9).
  const html = highlightedMatchHtml(line, 1, 9);
  assert.equal(
    html,
    'x<mark class="search-hit">&lt;script&gt;</mark>y',
    'the marked hit is escaped — no executable markup',
  );
});

test('match-highlight: clamps a bad offset + empty match -> escaped line, no empty <mark>', async () => {
  const { highlightedMatchHtml } = await kit();
  const line = 'a<b';
  // An empty/zero-width match region renders the escaped line with no <mark>.
  assert.equal(highlightedMatchHtml(line, 1, 1), 'a&lt;b', 'empty match -> escaped, no mark');
  // Out-of-range offsets clamp into the string (never slice outside).
  assert.equal(highlightedMatchHtml(line, -5, 999), '<mark class="search-hit">a&lt;b</mark>');
});

test('match-highlight: hitText returns the RAW bounded slice (for accessible name)', async () => {
  const { hitText } = await kit();
  const line = 'hello WORLD here';
  assert.equal(hitText(line, 6, 11), 'WORLD', 'the bounded raw run is returned');
  // Clamped + empty region -> empty string (no throw).
  assert.equal(hitText(line, 11, 11), '', 'zero-width -> empty');
  assert.equal(hitText(line, -5, 999), line, 'clamped to the whole line');
});

/* ------------------------------------------------------------------ */
/* RENDERER SLICE — dispatch decisions (TA-5, GTD-CORR-3, GTD-9)        */
/* ------------------------------------------------------------------ */

test('dispatch: classifyDefinitionResult — 0 -> none, 1 strong -> jump, >1 decls -> pick', async () => {
  const { classifyDefinitionResult } = await kit();
  const cand = (kind) => ({ path: 'a.ts', line: 1, col: 1, lineText: 'x', kind });
  // 0 candidates -> toast (none).
  assert.deepEqual(classifyDefinitionResult([]), { action: 'none' });
  assert.deepEqual(classifyDefinitionResult(undefined), { action: 'none' });
  // Exactly 1 STRONG declaration -> auto-jump.
  const one = classifyDefinitionResult([cand('function')]);
  assert.equal(one.action, 'jump');
  assert.equal(one.candidate.kind, 'function');
  // >1 DECLARATIONS -> chooser (genuinely ambiguous).
  assert.deepEqual(classifyDefinitionResult([cand('function'), cand('class')]), {
    action: 'pick',
  });
});

test('dispatch: CI-2 — ONE declaration + several USES auto-jumps to the declaration (not pick)', async () => {
  const { classifyDefinitionResult } = await kit();
  // The CI-2 regression: a freshly-imported symbol resolves to the cross-file
  // declaration PLUS the same-file import + a parameter use. A pure COUNT would
  // show the picker (3 candidates); a DECLARATION-AWARE dispatch auto-jumps to
  // the single real declaration (which CI-1 ranking floats to index 0).
  const candidates = [
    { path: 'model.ts', line: 1, col: 14, lineText: 'export class Account {}', kind: 'class' },
    { path: 'view.ts', line: 1, col: 10, lineText: 'import { Account }', kind: 'import' },
    { path: 'view.ts', line: 3, col: 17, lineText: 'function render(Account)', kind: 'parameter' },
  ];
  const decision = classifyDefinitionResult(candidates);
  assert.equal(decision.action, 'jump', 'one declaration + uses -> jump');
  assert.equal(decision.candidate.kind, 'class', 'jumps to the real declaration');
  assert.equal(decision.candidate.path, 'model.ts', 'jumps to the cross-file decl');
  // Two real declarations among uses -> pick (genuinely ambiguous).
  const twoDecls = [
    { path: 'a.ts', line: 1, col: 1, lineText: 'class Foo {}', kind: 'class' },
    { path: 'b.ts', line: 1, col: 1, lineText: 'class Foo {}', kind: 'class' },
    { path: 'c.ts', line: 1, col: 1, lineText: 'import { Foo }', kind: 'import' },
  ];
  assert.equal(classifyDefinitionResult(twoDecls).action, 'pick', '2 decls -> pick');
});

test('dispatch: GTD-CORR-3 — a SOLE pure-use candidate (import/property/parameter/other) does NOT auto-jump', async () => {
  const { classifyDefinitionResult } = await kit();
  const cand = (kind) => ({ path: 'a.ts', line: 1, col: 1, lineText: 'x', kind });
  // A lone use (import binding / object-literal property / parameter / bare
  // occurrence) is NOT a definition, so it resolves to 'none' (the flow shows
  // the no-definition toast) — never an auto-jump that silently lands on a use.
  for (const k of ['import', 'property', 'parameter', 'other']) {
    assert.deepEqual(classifyDefinitionResult([cand(k)]), { action: 'none' }, `lone ${k} -> none`);
  }
  // A re-export / variable / generic IS a real declaration site -> jump.
  for (const k of ['variable', 're-export', 'generic', 'type', 'method', 'destructured']) {
    assert.equal(classifyDefinitionResult([cand(k)]).action, 'jump', `lone ${k} -> jump`);
  }
  // 0 declarations but MULTIPLE uses -> picker (surfaced last-resort).
  assert.equal(
    classifyDefinitionResult([cand('property'), cand('parameter')]).action,
    'pick',
    'no declaration, multiple uses -> pick',
  );
});

test('dispatch: CI-1 — isDeclarationCandidate is the EXACT complement of definition-core isDeclarationKind', async () => {
  const { isDeclarationCandidate, isDeclarationKind } = await kit();
  // The renderer dispatch mirror MUST agree with the main resolver's partition
  // for every DefinitionKind — else the count (renderer) and the ranking (main)
  // could disagree about what counts as a declaration (CI-1/CI-2 coupling).
  const allKinds = [
    'class', 'interface', 'type', 'enum', 'function', 'method', 'variable',
    'destructured', 're-export', 'generic', 'import', 'property', 'parameter', 'other',
  ];
  for (const kind of allKinds) {
    const main = isDeclarationKind(kind);
    const renderer = isDeclarationCandidate({ path: '', line: 1, col: 1, lineText: '', kind });
    assert.equal(renderer, main, `partition agrees for kind '${kind}'`);
  }
  // Spot-check the band: declarations vs uses.
  for (const k of ['class', 'function', 'variable', 'generic', 're-export']) {
    assert.equal(isDeclarationKind(k), true, `${k} is a declaration`);
  }
  for (const k of ['import', 'property', 'parameter', 'other']) {
    assert.equal(isDeclarationKind(k), false, `${k} is a use`);
  }
});

test('dispatch: TA-R1 — pushJumpHistory caps at max (drop OLDEST), popJumpHistory is LIFO + empty->null', async () => {
  const { pushJumpHistory, popJumpHistory } = await kit();
  // (a) Pushing MAX+5 entries keeps exactly MAX with the OLDEST dropped.
  const MAX = 50;
  const stack = [];
  for (let i = 0; i < MAX + 5; i++) {
    pushJumpHistory(stack, { path: `f${i}.ts`, line: i }, MAX);
  }
  assert.equal(stack.length, MAX, 'capped at max');
  assert.equal(stack[0].path, 'f5.ts', 'the 5 OLDEST entries (f0..f4) were dropped');
  assert.equal(stack[stack.length - 1].path, `f${MAX + 4}.ts`, 'the newest survives');
  // (b) popJumpHistory is LIFO (most-recent first) and mutates in place.
  assert.deepEqual(popJumpHistory(stack), { path: `f${MAX + 4}.ts`, line: MAX + 4 });
  assert.equal(stack.length, MAX - 1, 'pop shrinks the stack');
  // (c) popJumpHistory on an empty stack -> null (the "No previous location" path).
  assert.equal(popJumpHistory([]), null, 'empty stack pops null');
  // (d) a non-positive cap keeps only the just-pushed entry (defensive).
  const s2 = [{ path: 'old.ts', line: 1 }];
  pushJumpHistory(s2, { path: 'new.ts', line: 2 }, 0);
  assert.deepEqual(s2, [{ path: 'new.ts', line: 2 }], 'cap<=0 keeps only the newest');
});

test('dispatch: GTD-9 — shouldPushHistory / isSameLocation guard the jump-history stack', async () => {
  const { shouldPushHistory, isSameLocation } = await kit();
  const target = { path: 'a.ts', line: 10 };
  // Same path + line as where the trigger sits -> in-place no-op: no push.
  assert.equal(isSameLocation({ path: 'a.ts', line: 10 }, target), true);
  assert.equal(shouldPushHistory({ path: 'a.ts', line: 10 }, target), false);
  // A different line in the same file MOVES the caret -> push.
  assert.equal(isSameLocation({ path: 'a.ts', line: 3 }, target), false);
  assert.equal(shouldPushHistory({ path: 'a.ts', line: 3 }, target), true);
  // A different file -> push.
  assert.equal(shouldPushHistory({ path: 'b.ts', line: 10 }, target), true);
  // No file open (null path) -> never push (nothing to return to).
  assert.equal(shouldPushHistory({ path: null, line: 10 }, target), false);
  assert.equal(isSameLocation({ path: null, line: 10 }, target), false);
});

/* ------------------------------------------------------------------ */
/* RENDERER SLICE — keybindings (goToDefinition + goBack commands)      */
/* ------------------------------------------------------------------ */

test('keybindings: goToDefinition + goBack are registered, valid, non-colliding, un-reserved', async () => {
  const {
    COMMANDS,
    DEFAULT_BINDINGS,
    resolveBindings,
    findConflict,
    isReserved,
    isPlatformCritical,
    bindingAllowedFor,
  } = await kit();
  const gtd = COMMANDS.find((c) => c.id === 'goToDefinition');
  const back = COMMANDS.find((c) => c.id === 'goBack');
  assert.ok(gtd, 'a goToDefinition command is registered');
  assert.ok(back, 'a goBack command is registered');
  assert.equal(gtd.defaultBinding, 'F12', 'goToDefinition default is F12');
  assert.equal(back.defaultBinding, 'Alt+ArrowLeft', 'goBack default is Alt+ArrowLeft');
  assert.equal(DEFAULT_BINDINGS.goToDefinition, 'F12', 'resolved default carries F12');
  assert.equal(DEFAULT_BINDINGS.goBack, 'Alt+ArrowLeft', 'resolved default carries Alt+ArrowLeft');

  const resolved = resolveBindings({});
  for (const id of ['goToDefinition', 'goBack']) {
    const combo = DEFAULT_BINDINGS[id];
    assert.ok(bindingAllowedFor(id, combo), `${id} default is a valid binding`);
    assert.equal(findConflict(resolved, combo, id), null, `${id} collides with no other command`);
    assert.equal(isReserved(combo), false, `${id} default is not an app-shell reserved combo`);
  }
  // F12 is NOT a platform-critical combo (only F5/F11 are), so it shadows no
  // load-bearing native action.
  assert.equal(isPlatformCritical('F12'), false, 'F12 is not platform-critical');
  assert.equal(isPlatformCritical('Alt+ArrowLeft'), false, 'Alt+ArrowLeft is not platform-critical');
});

test('keybindings: goToDefinition + goBack round-trip through an override + resolveBindings', async () => {
  const { resolveBindings } = await kit();
  // A user rebind of both commands resolves to the overrides; the rest stay
  // default. (Proves the two new ids participate in the override merge.)
  const resolved = resolveBindings({ goToDefinition: 'F8', goBack: 'Alt+ArrowRight' });
  assert.equal(resolved.goToDefinition, 'F8', 'goToDefinition override applied');
  assert.equal(resolved.goBack, 'Alt+ArrowRight', 'goBack override applied');
});
