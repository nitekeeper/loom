#!/usr/bin/env node
/* ============================================================
 * Loom — pure-Node app icon generator (no system tools, no Wine).
 * ------------------------------------------------------------
 * Emits build/icon.ico: a single 256x256 image entry whose payload
 * is a PNG. The ICO container format permits a PNG-compressed image
 * for the 256px entry (used by Vista+ / modern Windows), which lets
 * us produce a valid, crisp .ico with nothing but zlib.
 *
 * The mark: a dark rounded square (Loom's "loom" frame) with a teal
 * accent glyph — two interleaved warp/weft bars suggesting woven
 * threads. Rendered procedurally into a 256x256 RGBA raster, encoded
 * as a true-color PNG (filter type 0 per scanline), then wrapped in a
 * minimal ICONDIR + ICONDIRENTRY header.
 *
 * VERIFY: `node scripts/make-icon.mjs` writes build/icon.ico and prints
 * its size. The PNG it embeds is independently decodable; electron-builder
 * accepts a >=256px .ico and downsizes the other resolutions itself.
 * ============================================================ */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SIZE = 256;

// --- Palette (Loom dark + teal accent) ---------------------------------
const BG = [13, 17, 23]; // near-black canvas (outside the rounded square)
const TILE = [22, 27, 34]; // dark rounded-square fill
const TILE_EDGE = [48, 54, 61]; // subtle 1px-ish inner edge
const TEAL = [45, 212, 191]; // accent glyph (teal)
const TEAL_DIM = [20, 120, 110]; // shadowed thread crossing

// --- Raster buffer (RGBA, row-major) -----------------------------------
const px = Buffer.alloc(SIZE * SIZE * 4);
function setPx(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
}

// Rounded-square test: is (x,y) inside a square of given inset with
// corner radius r?
function insideRoundedSquare(x, y, inset, radius) {
  const lo = inset;
  const hi = SIZE - 1 - inset;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  // Corner circles.
  const corners = [
    [lo + radius, lo + radius],
    [hi - radius, lo + radius],
    [lo + radius, hi - radius],
    [hi - radius, hi - radius],
  ];
  const nearLeft = x < lo + radius;
  const nearRight = x > hi - radius;
  const nearTop = y < lo + radius;
  const nearBottom = y > hi - radius;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    // In a corner zone — must be within radius of the corner centre.
    const cx = nearLeft ? lo + radius : hi - radius;
    const cy = nearTop ? lo + radius : hi - radius;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }
  void corners;
  return true;
}

// 1) Fill the whole canvas with the background.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) setPx(x, y, BG);
}

// 2) Dark rounded square tile (the "loom" frame).
const INSET = 14;
const RADIUS = 52;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (insideRoundedSquare(x, y, INSET, RADIUS)) {
      // Thin lighter edge ring for depth.
      const edge =
        !insideRoundedSquare(x, y, INSET + 3, RADIUS - 2) ? TILE_EDGE : TILE;
      setPx(x, y, edge);
    }
  }
}

// 3) Teal woven glyph: 3 vertical warp bars + 3 horizontal weft bars,
//    with the weft drawn dimmer where it crosses behind a warp bar so
//    the threads read as interleaved.
const BAR = 18; // bar thickness
const WARPS = [78, 119, 160]; // x-centres of vertical bars
const WEFTS = [78, 119, 160]; // y-centres of horizontal bars
const GMIN = 60;
const GMAX = 196; // glyph extent within the tile

function onBar(coord, centres) {
  for (const c of centres) {
    if (Math.abs(coord - c) <= BAR / 2) return true;
  }
  return false;
}

for (let y = GMIN; y <= GMAX; y++) {
  for (let x = GMIN; x <= GMAX; x++) {
    const isWarp = onBar(x, WARPS) && y >= GMIN && y <= GMAX;
    const isWeft = onBar(y, WEFTS) && x >= GMIN && x <= GMAX;
    if (!isWarp && !isWeft) continue;
    // Interleave: at a crossing, alternate which thread is "on top"
    // based on the parity of (warp index + weft index).
    if (isWarp && isWeft) {
      const wi = WARPS.findIndex((c) => Math.abs(x - c) <= BAR / 2);
      const fi = WEFTS.findIndex((c) => Math.abs(y - c) <= BAR / 2);
      const warpOnTop = (wi + fi) % 2 === 0;
      setPx(x, y, warpOnTop ? TEAL : TEAL_DIM);
    } else {
      setPx(x, y, TEAL);
    }
  }
}

// --- PNG encoding (true-color RGBA, 8-bit, filter 0 per scanline) -------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// Prepend filter byte (0) to each scanline.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

// --- ICO wrapper: ICONDIR + 1 ICONDIRENTRY + embedded PNG ---------------
// ICONDIR (6 bytes): reserved=0, type=1 (icon), count=1.
const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0, 0);
iconDir.writeUInt16LE(1, 2);
iconDir.writeUInt16LE(1, 4);

// ICONDIRENTRY (16 bytes). Width/height of 0 mean 256.
const entry = Buffer.alloc(16);
entry[0] = 0; // width  = 256
entry[1] = 0; // height = 256
entry[2] = 0; // palette count
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // size of PNG data
entry.writeUInt32LE(6 + 16, 12); // offset of PNG data (after dir+entry)

const ico = Buffer.concat([iconDir, entry, png]);

const outDir = path.join(PROJECT_ROOT, 'build');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.ico');
writeFileSync(outPath, ico);

process.stdout.write(
  `[make-icon] wrote ${path.relative(PROJECT_ROOT, outPath)} ` +
    `(${ico.length} bytes; embedded PNG ${png.length} bytes; ${SIZE}x${SIZE})\n`,
);
