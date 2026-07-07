/* ============================================================
 * Loom — Korean / CJK regression suite (node --test)
 * ------------------------------------------------------------
 * There was ZERO non-ASCII coverage before this file, so a font-stack,
 * locale, or search-normalization edit could silently re-break 한국어 with the
 * whole suite green. These tests PIN the Korean-support fixes:
 *
 *   1. withUtf8Locale (src/main/terminal.ts) — a child PTY always gets a UTF-8
 *      locale by TRUE POSIX precedence (LC_ALL > LC_CTYPE > LANG), never
 *      overriding an existing UTF-8 governing locale, minimal (charset only),
 *      platform-correct default, and a no-op on win32.
 *   2. matchFile (src/main/search-core.ts) — NFC normalization so a composed
 *      (IME) query matches decomposed (macOS NFD) content, with self-consistent
 *      offsets; and Hangul columns count as their code units.
 *   3. createSearch name matching (src/main/search.ts) — an NFC query finds an
 *      NFD filename AND the emitted path OPENS (raw on-disk path, no ENOENT),
 *      with a precise highlight span for already-NFC names.
 *   4. The bundled Korean fonts (Regular + Bold, D2Coding + Noto Sans KR) ship:
 *      dist/renderer.css declares the @font-face families, the mono chain tails
 *      Noto Sans KR (jamo), and every referenced .woff2 exists beside it.
 *
 * All pure/DOM-free, driven through the Electron-free dist/testkit.cjs bundle.
 * ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(root, 'dist');
const TESTKIT = path.join(DIST, 'testkit.cjs');

let _kit = null;
async function kit() {
  if (_kit) return _kit;
  if (!existsSync(TESTKIT)) {
    throw new Error(`dist/testkit.cjs not found at ${TESTKIT} — run \`npm run build\` first.`);
  }
  _kit = await import(TESTKIT);
  return _kit;
}

// Sample Hangul. NFC '한' is 1 UTF-16 unit; its NFD form is 3 (ㅎ+ㅏ+ㄴ).
const HAN_NFC = '한'; // U+D55C
const HANGUL_NFC = '한국어'; // composed
const HANGUL_NFD = HANGUL_NFC.normalize('NFD'); // decomposed (what macOS stores)

// ---------------------------------------------------------------------------
// 1. withUtf8Locale — PTY UTF-8 locale guarantee, by POSIX precedence
// ---------------------------------------------------------------------------

test('withUtf8Locale: LANG=C injects LC_CTYPE=C.UTF-8 on Linux, leaving LANG collation untouched', async () => {
  const { withUtf8Locale } = await kit();
  const out = withUtf8Locale({ LANG: 'C', PATH: '/usr/bin' }, 'linux');
  assert.equal(out.LC_CTYPE, 'C.UTF-8', 'charset forced to a broadly-available UTF-8 locale');
  assert.equal(out.LANG, 'C', 'LANG (collation/messages) is left exactly as the user had it');
  assert.equal(out.PATH, '/usr/bin');
});

test('withUtf8Locale: no locale set -> C.UTF-8 on Linux, en_US.UTF-8 on macOS (which has no C.UTF-8)', async () => {
  const { withUtf8Locale } = await kit();
  assert.equal(withUtf8Locale({ HOME: '/h' }, 'linux').LC_CTYPE, 'C.UTF-8');
  assert.equal(withUtf8Locale({ HOME: '/h' }, 'darwin').LC_CTYPE, 'en_US.UTF-8');
});

test('withUtf8Locale: preserves an existing language (ko_KR -> ko_KR.UTF-8) via LC_CTYPE', async () => {
  const { withUtf8Locale } = await kit();
  const out = withUtf8Locale({ LANG: 'ko_KR' }, 'linux');
  assert.equal(out.LC_CTYPE, 'ko_KR.UTF-8', 'derives .UTF-8 from the language');
  assert.equal(out.LANG, 'ko_KR', 'the language locale is preserved');
});

test('withUtf8Locale: NO-OP when the GOVERNING category is already UTF-8', async () => {
  const { withUtf8Locale } = await kit();
  const a = { LANG: 'ko_KR.UTF-8' };
  assert.equal(withUtf8Locale(a, 'linux'), a, 'returns the SAME object untouched');
  const b = { LC_CTYPE: 'en_US.utf8' }; // utf8 (no dash) also counts
  assert.equal(withUtf8Locale(b, 'darwin'), b);
});

test('withUtf8Locale: respects LC_ALL precedence — a non-UTF-8 LC_ALL is what gets fixed', async () => {
  const { withUtf8Locale } = await kit();
  // LC_ALL=C outranks even a UTF-8 LANG, so a naive OR-check would wrongly no-op
  // and leave Korean mojibaked. The governing var (LC_ALL) must be the one fixed.
  const out = withUtf8Locale({ LC_ALL: 'C', LANG: 'ko_KR.UTF-8' }, 'linux');
  assert.equal(out.LC_ALL, 'C.UTF-8', 'LC_ALL (governing) switched to UTF-8');
  assert.equal(out.LC_CTYPE, undefined, 'LC_CTYPE is not used — it cannot override LC_ALL');
  // A non-UTF-8 LC_CTYPE likewise masks a UTF-8 LANG.
  const out2 = withUtf8Locale({ LC_CTYPE: 'C', LANG: 'ko_KR.UTF-8' }, 'linux');
  assert.equal(out2.LC_CTYPE, 'C.UTF-8');
});

test('withUtf8Locale: preserves an explicit non-UTF-8 LC_ALL language (de_DE.ISO-8859-1 -> de_DE.UTF-8)', async () => {
  const { withUtf8Locale } = await kit();
  const out = withUtf8Locale({ LC_ALL: 'de_DE.ISO-8859-1' }, 'linux');
  assert.equal(out.LC_ALL, 'de_DE.UTF-8', 'keep the language, only switch the charset');
});

test('withUtf8Locale: NO-OP on win32 (conpty drives Unicode via its code page)', async () => {
  const { withUtf8Locale } = await kit();
  const env = { LC_ALL: 'C' };
  assert.equal(withUtf8Locale(env, 'win32'), env, 'win32 returns env unchanged');
});

// ---------------------------------------------------------------------------
// 2. matchFile — NFC content search
// ---------------------------------------------------------------------------

test('matchFile: an NFC (IME) query matches NFD (macOS) Hangul content', async () => {
  const { matchFile } = await kit();
  const text = `line one\nvalue = "${HANGUL_NFD}"\n`; // haystack is DECOMPOSED
  const m = matchFile(text, HANGUL_NFC); // needle is COMPOSED
  assert.equal(m.length, 1, 'the composed query finds the decomposed content');
  assert.equal(m[0].line, 2, '1-based line is correct');
  assert.equal(
    m[0].lineText.slice(m[0].matchStart, m[0].matchEnd),
    HANGUL_NFC,
    'matchStart/matchEnd index the returned (NFC) lineText and wrap exactly the query',
  );
});

test('matchFile: symmetric — an NFD query matches NFC content too', async () => {
  const { matchFile } = await kit();
  const m = matchFile(`x ${HANGUL_NFC} y\n`, HANGUL_NFD);
  assert.equal(m.length, 1, 'normalization is applied to BOTH sides');
});

test('matchFile: col counts Hangul as its NFC code units (1 per syllable), not bytes', async () => {
  const { matchFile } = await kit();
  const m = matchFile(`${HAN_NFC}${HAN_NFC}TARGET\n`, 'TARGET');
  assert.equal(m.length, 1);
  assert.equal(m[0].col, 3, 'two single-unit Hangul precede TARGET -> col 3');
});

test('matchFile: case-insensitive matching still works alongside Korean (no fold damage)', async () => {
  const { matchFile } = await kit();
  const m = matchFile(`${HANGUL_NFC} Hello\n`, 'hello');
  assert.equal(m.length, 1, 'ASCII case-fold is unaffected by the NFC normalization');
});

// ---------------------------------------------------------------------------
// 3. createSearch — NFC query over a real (NFD) tree, and OPENABILITY
// ---------------------------------------------------------------------------

test('createSearch: an NFC query FINDS an NFD-named file AND the emitted path OPENS', async () => {
  const { createSandbox, createSearch } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-cjk-'));
  try {
    // Decomposed (NFD) Korean basename — this host keeps the bytes verbatim, so
    // without NFC normalization the composed query would not match, and (the
    // regression this guards) an NFC-emitted identifier would ENOENT on open.
    const nfdName = `${HANGUL_NFD}.md`;
    writeFileSync(path.join(dir, nfdName), '# 문서\n내용\n');
    const sandbox = createSandbox(dir);
    const res = createSearch(sandbox).run({ query: HANGUL_NFC });
    const named = res.fileMatches.find((f) => f.path.endsWith('.md'));
    assert.ok(named, 'the NFD-named file is found by the NFC query');
    // CRITICAL: the emitted path is the RAW on-disk (NFD) path so the byte-exact
    // sandbox can open it — an NFC identifier would throw ENOENT here.
    assert.equal(named.path, nfdName, 'emits the raw on-disk path, not NFC');
    const opened = sandbox.readFile(named.path);
    assert.ok(
      opened.text !== null && opened.text.includes('문서'),
      'the emitted path actually opens (no ENOENT)',
    );
    // For a decomposed name the highlight span falls back to the whole basename.
    assert.equal(named.matchStart, 0);
    assert.equal(named.matchEnd, named.path.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createSearch: an already-NFC on-disk name keeps a PRECISE highlight span', async () => {
  const { createSandbox, createSearch } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-cjk-'));
  try {
    const nfcName = `${HANGUL_NFC}.md`; // Linux/Windows names are already NFC
    writeFileSync(path.join(dir, nfcName), 'x\n');
    const res = createSearch(createSandbox(dir)).run({ query: HANGUL_NFC });
    const named = res.fileMatches.find((f) => f.path.endsWith('.md'));
    assert.ok(named);
    assert.equal(named.path, nfcName, 'raw path == NFC path here');
    assert.equal(
      named.path.slice(named.matchStart, named.matchEnd),
      HANGUL_NFC,
      'precise span wraps exactly the query',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createSearch: name + content results emit the SAME (raw) path key (de-dup intact)', async () => {
  const { createSandbox, createSearch } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-cjk-'));
  try {
    // NFD name whose CONTENT also contains the query -> both surfaces match.
    const nfdName = `${HANGUL_NFD}.md`;
    writeFileSync(path.join(dir, nfdName), `${HANGUL_NFD} 본문\n`);
    const res = createSearch(createSandbox(dir)).run({ query: HANGUL_NFC });
    const nameHit = res.fileMatches.find((f) => f.path.endsWith('.md'));
    const contentHit = res.results.find((r) => r.path.endsWith('.md'));
    assert.ok(nameHit && contentHit, 'both surfaces matched');
    assert.equal(nameHit.path, contentHit.path, 'identical path key so the UI de-dup fires');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createSearch: an NFD DIRECTORY-only match opens and emits no mislabeled highlight', async () => {
  const { createSandbox, createSearch } = await kit();
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-cjk-'));
  try {
    const sub = `${HANGUL_NFD}dir`; // decomposed directory name; query hits only here
    mkdirSync(path.join(dir, sub));
    writeFileSync(path.join(dir, sub, 'plain.md'), 'x\n');
    const sandbox = createSandbox(dir);
    const res = createSearch(sandbox).run({ query: HANGUL_NFC });
    const named = res.fileMatches.find((f) => f.path.endsWith('plain.md'));
    assert.ok(named, 'the file under the NFD dir is found by the NFC query');
    // The match is in the DIRECTORY portion, and the raw path is decomposed, so
    // the basename must NOT be mislabeled — emit an empty highlight instead.
    assert.equal(named.matchStart, named.matchEnd, 'empty highlight for a dir-only decomposed match');
    assert.ok(sandbox.readFile(named.path).text !== null, 'the emitted (raw) path still opens');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Bundled Korean fonts (Regular + Bold) actually ship in dist/
// ---------------------------------------------------------------------------

test('build: dist/renderer.css declares the Korean @font-face families and mono jamo fallback', async () => {
  const css = readFileSync(path.join(DIST, 'renderer.css'), 'utf8');
  assert.match(css, /@font-face/, 'renderer.css has @font-face blocks');
  assert.match(css, /D2Coding/, 'D2Coding family is declared');
  assert.match(css, /Noto Sans KR/, 'Noto Sans KR family is declared');
  // --font-mono must tail "Noto Sans KR" (D2Coding lacks conjoining jamo).
  const mono = /--font-mono:[^;]*;/.exec(css);
  assert.ok(mono && /D2Coding/.test(mono[0]) && /Noto Sans KR/.test(mono[0]),
    '--font-mono chains D2Coding then Noto Sans KR for jamo coverage');
});

test('build: every .woff2 referenced by dist/renderer.css exists beside it (same-origin, CSP-safe)', async () => {
  const css = readFileSync(path.join(DIST, 'renderer.css'), 'utf8');
  const refs = [...css.matchAll(/url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/g)].map((m) => m[1]);
  // Regular + Bold for both families = 4 faces.
  assert.ok(refs.length >= 4, `expected >=4 bundled woff2 refs (reg+bold x2), saw ${refs.length}`);
  for (const ref of refs) {
    assert.ok(!/^(https?:|data:)/i.test(ref), `font url must be same-origin, got ${ref}`);
    const abs = path.join(DIST, ref.replace(/^\.\//, ''));
    assert.ok(existsSync(abs), `referenced font missing on disk: ${ref}`);
    assert.equal(
      readFileSync(abs).subarray(0, 4).toString('latin1'),
      'wOF2',
      `${ref} is a valid woff2`,
    );
  }
});

test('build: the OFL license texts ship beside the fonts in dist/fonts/', async () => {
  for (const lic of ['D2Coding-LICENSE.txt', 'NotoSansKR-OFL.txt']) {
    const p = path.join(DIST, 'fonts', lic);
    assert.ok(existsSync(p), `${lic} shipped in dist/fonts/`);
    assert.match(readFileSync(p, 'utf8'), /SIL OPEN FONT LICENSE/i, `${lic} carries the OFL text`);
  }
});
