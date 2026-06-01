#!/usr/bin/env node
/* ============================================================
 * Loom — pure-Node app icon generator (no system tools, no Wine).
 * ------------------------------------------------------------
 * Emits TWO tracked icon assets from ONE procedurally-rendered mark:
 *
 *   build/icon.ico  — Windows: a single 256x256 image entry whose payload
 *                     is a PNG. The ICO container format permits a
 *                     PNG-compressed image for the 256px entry (used by
 *                     Vista+ / modern Windows), which lets us produce a
 *                     valid, crisp .ico with nothing but zlib.
 *   build/icon.png  — macOS: a 1024x1024 true-color PNG. electron-builder
 *                     derives the macOS .icns (every required resolution)
 *                     from this single 1024px PNG at package time.
 *
 * The mark: a dark rounded square (Loom's "loom" frame) with a teal
 * accent glyph — two interleaved warp/weft bars suggesting woven
 * threads. Rendered procedurally into an NxN RGBA raster (size-parametric,
 * so the SAME mark renders crisply at any resolution), encoded as a
 * true-color PNG (filter type 0 per scanline). The Windows path then wraps
 * the 256px PNG in a minimal ICONDIR + ICONDIRENTRY header.
 *
 * VERIFY: `node scripts/make-icon.mjs` writes build/icon.ico AND
 * build/icon.png and prints their sizes. Each embedded/standalone PNG is
 * independently decodable; electron-builder accepts a >=256px .ico
 * (downsizing the other Windows resolutions itself) and a 1024px .png
 * (from which it generates the macOS .icns).
 * ============================================================ */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// --- Palette (Loom dark + teal accent) ---------------------------------
const BG = [13, 17, 23]; // near-black canvas (outside the rounded square)
const TILE = [22, 27, 34]; // dark rounded-square fill
const TILE_EDGE = [48, 54, 61]; // subtle 1px-ish inner edge
const TEAL = [45, 212, 191]; // accent glyph (teal)
const TEAL_DIM = [20, 120, 110]; // shadowed thread crossing

/* ------------------------------------------------------------------
 * Render the Loom mark into an `size`x`size` RGBA raster.
 *
 * All geometry is expressed as fractions of `size` (derived from the
 * original 256px layout) so the identical mark renders crisply at any
 * resolution — 256 for the Windows .ico entry, 1024 for the macOS .png.
 * ------------------------------------------------------------------ */
function renderMark(size) {
  const px = Buffer.alloc(size * size * 4);
  const setPx = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  // Scale the original 256px constants to `size`.
  const s = size / 256;
  const INSET = 14 * s;
  const RADIUS = 52 * s;
  const EDGE_W = 3 * s; // inner-edge ring width
  const EDGE_R = 2 * s; // inner-edge radius delta
  const BAR = 18 * s; // bar thickness
  const WARPS = [78, 119, 160].map((c) => c * s); // x-centres of vertical bars
  const WEFTS = [78, 119, 160].map((c) => c * s); // y-centres of horizontal bars
  const GMIN = 60 * s;
  const GMAX = 196 * s; // glyph extent within the tile

  // Rounded-square test: is (x,y) inside a square of given inset with
  // corner radius r?
  const insideRoundedSquare = (x, y, inset, radius) => {
    const lo = inset;
    const hi = size - 1 - inset;
    if (x < lo || x > hi || y < lo || y > hi) return false;
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
    return true;
  };

  const onBar = (coord, centres) => {
    for (const c of centres) {
      if (Math.abs(coord - c) <= BAR / 2) return true;
    }
    return false;
  };

  // 1) Fill the whole canvas with the background.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) setPx(x, y, BG);
  }

  // 2) Dark rounded square tile (the "loom" frame).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insideRoundedSquare(x, y, INSET, RADIUS)) {
        // Thin lighter edge ring for depth.
        const edge = !insideRoundedSquare(x, y, INSET + EDGE_W, RADIUS - EDGE_R)
          ? TILE_EDGE
          : TILE;
        setPx(x, y, edge);
      }
    }
  }

  // 3) Teal woven glyph: 3 vertical warp bars + 3 horizontal weft bars,
  //    with the weft drawn dimmer where it crosses behind a warp bar so
  //    the threads read as interleaved.
  for (let y = Math.floor(GMIN); y <= Math.ceil(GMAX); y++) {
    for (let x = Math.floor(GMIN); x <= Math.ceil(GMAX); x++) {
      if (x < GMIN || x > GMAX || y < GMIN || y > GMAX) continue;
      const isWarp = onBar(x, WARPS);
      const isWeft = onBar(y, WEFTS);
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

  return px;
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

/** Encode an NxN RGBA raster as a true-color (RGBA, 8-bit) PNG buffer. */
function encodePng(px, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Prepend filter byte (0) to each scanline.
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Output ------------------------------------------------------------
const outDir = path.join(PROJECT_ROOT, 'build');
mkdirSync(outDir, { recursive: true });

// 1) Windows .ico — wrap a 256px PNG in ICONDIR + 1 ICONDIRENTRY.
const ICO_SIZE = 256;
const icoPng = encodePng(renderMark(ICO_SIZE), ICO_SIZE);

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
entry.writeUInt32LE(icoPng.length, 8); // size of PNG data
entry.writeUInt32LE(6 + 16, 12); // offset of PNG data (after dir+entry)

const ico = Buffer.concat([iconDir, entry, icoPng]);
const icoPath = path.join(outDir, 'icon.ico');
writeFileSync(icoPath, ico);

process.stdout.write(
  `[make-icon] wrote ${path.relative(PROJECT_ROOT, icoPath)} ` +
    `(${ico.length} bytes; embedded PNG ${icoPng.length} bytes; ${ICO_SIZE}x${ICO_SIZE})\n`,
);

// 2) macOS .png — a standalone 1024px PNG; electron-builder derives the .icns.
const PNG_SIZE = 1024;
const macPng = encodePng(renderMark(PNG_SIZE), PNG_SIZE);
const pngPath = path.join(outDir, 'icon.png');
writeFileSync(pngPath, macPng);

process.stdout.write(
  `[make-icon] wrote ${path.relative(PROJECT_ROOT, pngPath)} ` +
    `(${macPng.length} bytes; ${PNG_SIZE}x${PNG_SIZE})\n`,
);
