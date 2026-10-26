// Draws every icon the app needs from one picture, with no dependencies, so
// the sizes cannot drift apart. Run: node tools/make-icons.mjs
//
// The picture is `ink(x, y)`: a colour at a
// point in a 0..1 square. Write it as shapes (circles, rounded rects, lines)
// in that square; everything else here is plumbing.
//
// Why PNG: iOS takes `apple-touch-icon` for "Add to Home Screen", Apple
// documents it as PNG, and it wins over the manifest's icons, so an SVG there
// leaves iOS with a screenshot. The manifest gets the same PNGs.
//
// Why full-bleed and opaque: iOS rounds the corners itself; corners drawn
// here would show inside its mask, and transparent pixels are not a
// background anybody chose.
//
// Why a separate maskable icon: Android crops a maskable icon to a circle or
// squircle, keeping the middle 80 %; the picture is shrunk into that zone.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = 'icons'; // listed in sw.js SHELL; index.html and the manifest point here

// The old icon.png, reproduced: a glass ring on a deep-teal ground that glows
// faintly at the middle (the phone on the belly), with a foam dot at the
// centre. Colours are the app's :root tokens (--abyss, --glass, --foam).
const GLASS = [0x7f, 0xbf, 0xae], FOAM = [0xe3, 0xed, 0xe9];
const GROUND = [ // radius from the middle (0..0.707) -> colour
  [0, [48, 84, 87]], [0.2, [33, 62, 67]], [0.3, [19, 43, 52]],
  [0.38, [11, 31, 39]], [0.5, [10, 28, 36]], [0.71, [8, 23, 30]],
];
function ground(r) {
  for (let i = 1; i < GROUND.length; i++) {
    if (r <= GROUND[i][0]) {
      const [r0, c0] = GROUND[i - 1], [r1, c1] = GROUND[i];
      const f = (r - r0) / (r1 - r0);
      return c0.map((v, k) => v + (c1[k] - v) * f);
    }
  }
  return GROUND[GROUND.length - 1][1];
}
function ink(x, y) {
  const r = Math.hypot(x - 0.5, y - 0.5);
  if (r < 0.022) return FOAM;
  if (r > 0.309 && r < 0.371) return GLASS;
  return ground(r);
}

const SS = 4; // supersampling: draw 4×4 points per pixel, average them

function render(size, inset) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // PNG filter byte: none
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          // Shrink the picture into the safe zone; the background stays full.
          const c = ink((u - inset) / (1 - 2 * inset), (v - inset) / (1 - 2 * inset));
          for (let k = 0; k < 3; k++) acc[k] += c[k];
        }
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(acc[k] / (SS * SS));
    }
  }
  return raw;
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, inset) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB, opaque on purpose
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size, inset), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size, inset] of [
  ['apple-touch-icon.png', 180, 0],
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-maskable-512.png', 512, 0.1],
  ['favicon-32.png', 32, 0],
]) {
  writeFileSync(`${OUT}/${name}`, png(size, inset));
  console.log(`${OUT}/${name} ${size}x${size}`);
}
