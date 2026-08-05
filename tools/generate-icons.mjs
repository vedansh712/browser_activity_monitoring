#!/usr/bin/env node
/**
 * Static icon generator.
 *
 * Renders the Track Daily mark to PNG at every size the manifest declares.
 *
 * Why this exists
 * ───────────────
 * chrome.action.setIcon only controls the toolbar button. The tab favicon on
 * extension pages, the chrome://extensions listing and the Web Store all read
 * the manifest's `icons` entries, which must be real files on disk. Those
 * cannot be generated at runtime, so they are generated at build time here
 * from the same design.
 *
 * Why it has no dependencies
 * ──────────────────────────
 * Adding a canvas library to draw four small images would pull a native
 * dependency into a project that currently installs nothing at all. Signed
 * distance fields plus supersampling produce clean anti-aliased shapes in a
 * few dozen lines, and Node already ships the zlib needed to write a PNG.
 *
 *   node tools/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');

const SIZES = [16, 32, 48, 128];

/** Samples per axis. 4 gives 16 samples per pixel — ample at these sizes. */
const SUPERSAMPLE = 4;

/** Ring fill for the static mark. Enough arc to read as progress, not a full circle. */
const BRAND_PROGRESS = 0.72;

/** Brand gradient along the arc, matching the app's identity. */
const ARC_FROM = [0x3d, 0xe0, 0xff]; // cyan
const ARC_TO   = [0x9c, 0x4d, 0xff]; // violet

const TILE_TOP    = [0x16, 0x1b, 0x28];
const TILE_BOTTOM = [0x08, 0x0a, 0x11];
const INK         = [0xf2, 0xf6, 0xff];

const DETAIL_THRESHOLD = 28; // below this, ticks and hands become noise
const TICK_COUNT = 12;

// ─── Signed distance helpers ───────────────────────────────────────

function sdRoundedBox(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - halfW + radius;
  const qy = Math.abs(py - cy) - halfH + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const lenSq = bax * bax + bay * bay;
  const h = lenSq === 0 ? 0 : Math.min(1, Math.max(0, (pax * bax + pay * bay) / lenSq));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/**
 * Distance to a circular arc, with round caps falling out of the endpoint case.
 *
 * Also returns the position along the arc, 0 at the start and 1 at the end, so
 * a gradient can be applied. The caps report the position of the endpoint they
 * belong to rather than their raw angle — without that, the pixels forming the
 * start cap sit just *before* the start angle, wrap round to a position beyond
 * the end, and get painted the end colour.
 *
 * @returns {{dist: number, t: number}}
 */
function sdArc(px, py, cx, cy, radius, startAngle, sweep) {
  const dx = px - cx;
  const dy = py - cy;
  const rel = mod2pi(Math.atan2(dy, dx) - startAngle);

  if (rel <= sweep) {
    return { dist: Math.abs(Math.hypot(dx, dy) - radius), t: sweep === 0 ? 0 : rel / sweep };
  }

  const ax = cx + Math.cos(startAngle) * radius;
  const ay = cy + Math.sin(startAngle) * radius;
  const bx = cx + Math.cos(startAngle + sweep) * radius;
  const by = cy + Math.sin(startAngle + sweep) * radius;

  const toStart = Math.hypot(px - ax, py - ay);
  const toEnd = Math.hypot(px - bx, py - by);
  return toStart <= toEnd ? { dist: toStart, t: 0 } : { dist: toEnd, t: 1 };
}

const mod2pi = (a) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

const lerp = (a, b, t) => a + (b - a) * t;
const mixColor = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Source-over compositing onto a [r,g,b,a] accumulator, all 0..255 except a in 0..1. */
function over(dst, rgb, alpha) {
  if (alpha <= 0) return;
  const out = alpha + dst[3] * (1 - alpha);
  if (out <= 0) return;
  dst[0] = (rgb[0] * alpha + dst[0] * dst[3] * (1 - alpha)) / out;
  dst[1] = (rgb[1] * alpha + dst[1] * dst[3] * (1 - alpha)) / out;
  dst[2] = (rgb[2] * alpha + dst[2] * dst[3] * (1 - alpha)) / out;
  dst[3] = out;
}

// ─── The mark ──────────────────────────────────────────────────────

/**
 * Colour and coverage at one sample point.
 * @returns {[number, number, number, number]} r, g, b, alpha(0..1)
 */
function sampleIcon(px, py, s) {
  const c = s / 2;
  const detailed = s >= DETAIL_THRESHOLD;
  const px1 = 1 / SUPERSAMPLE; // one subsample step, used to soften edges

  const dst = [0, 0, 0, 0];

  // Tile
  const tileDist = sdRoundedBox(px, py, c, c, s / 2 - 0.5, s / 2 - 0.5, s * 0.24);
  const tileCoverage = clamp01(0.5 - tileDist / px1);
  if (tileCoverage > 0) {
    over(dst, mixColor(TILE_TOP, TILE_BOTTOM, clamp01(py / s)), tileCoverage);

    // Hairline border, just inside the edge
    const border = s * 0.03;
    if (tileDist > -border) {
      over(dst, [255, 255, 255], 0.10 * tileCoverage);
    }
  }

  const radius = s * 0.315;
  const ringWidth = Math.max(1.6, s * 0.105);
  const half = ringWidth / 2;
  const start = -Math.PI / 2;
  const sweep = BRAND_PROGRESS * Math.PI * 2;

  // Unfilled track
  const trackDist = Math.abs(Math.hypot(px - c, py - c) - radius);
  over(dst, [255, 255, 255], 0.09 * clamp01((half - trackDist) / px1 + 0.5));

  // Ticks in the remaining arc
  if (detailed) {
    const inner = radius - ringWidth * 0.62;
    const outer = radius + ringWidth * 0.1;
    const tickHalf = Math.max(0.5, s * 0.014);

    for (let i = 0; i < TICK_COUNT; i++) {
      if (i / TICK_COUNT < BRAND_PROGRESS) continue;
      const a = start + (i / TICK_COUNT) * Math.PI * 2;
      const d = sdSegment(
        px, py,
        c + Math.cos(a) * inner, c + Math.sin(a) * inner,
        c + Math.cos(a) * outer, c + Math.sin(a) * outer
      );
      over(dst, [255, 255, 255], 0.24 * clamp01((tickHalf - d) / px1 + 0.5));
    }
  }

  // Arc glow — two soft passes under the arc itself, so the colour reads
  // even at 16px where the stroke is barely two pixels wide.
  const arc = sdArc(px, py, c, c, radius, start, sweep);
  const arcColor = mixColor(ARC_FROM, ARC_TO, arc.t);

  over(dst, arcColor, 0.10 * clamp01((half * 2.4 - arc.dist) / (px1 * 4) + 0.5));
  over(dst, arcColor, 0.16 * clamp01((half * 1.6 - arc.dist) / (px1 * 3) + 0.5));
  over(dst, arcColor, clamp01((half - arc.dist) / px1 + 0.5));

  // Centre
  if (detailed) {
    const handWidth = Math.max(0.6, s * 0.025);
    const hour = sdSegment(px, py, c, c, c, c - s * 0.145);
    const minute = sdSegment(px, py, c, c, c + s * 0.125, c + s * 0.075);
    const hub = Math.hypot(px - c, py - c) - s * 0.045;

    const handCoverage = Math.max(
      clamp01((handWidth - hour) / px1 + 0.5),
      clamp01((handWidth - minute) / px1 + 0.5),
      clamp01(-hub / px1 + 0.5)
    );
    over(dst, INK, handCoverage);
  } else {
    const dot = Math.hypot(px - c, py - c) - Math.max(1, s * 0.075);
    over(dst, INK, clamp01(-dot / px1 + 0.5));
  }

  return dst;
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Render one size to an RGBA buffer. */
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  const offset = step / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = sampleIcon(x + offset + sx * step, y + offset + sy * step, size);
          // Premultiply before averaging so partially covered edges do not
          // pull in colour from fully transparent samples.
          r += px[0] * px[3];
          g += px[1] * px[3];
          b += px[2] * px[3];
          a += px[3];
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const idx = (y * size + x) * 4;
      const alpha = a / samples;

      rgba[idx] = a > 0 ? Math.round(r / a) : 0;
      rgba[idx + 1] = a > 0 ? Math.round(g / a) : 0;
      rgba[idx + 2] = a > 0 ? Math.round(b / a) : 0;
      rgba[idx + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// ─── Minimal PNG writer ────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline. These images are tiny; the
  // compression win from per-line filter selection is not worth the code.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const src = y * size * 4;
    const dst = y * (size * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Main ──────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const png = encodePng(render(size), size);
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`  icon-${size}.png  ${String(png.length).padStart(6)} bytes`);
}

console.log(`\nWrote ${SIZES.length} icons to ${OUT_DIR}`);
