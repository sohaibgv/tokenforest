#!/usr/bin/env node
// App icon, authored as a pixel map rather than drawn in an image editor.
//
// Everything else in this project is hand-authored pixel data (sprites.ts's
// PixelMap arrays, icons.rs's 16x16 tray maps) and the repo carries no
// hand-made binary art. The app icon was the one exception — and it was still
// Tauri's stock logo, because replacing it meant opening an image editor.
// Authoring it here keeps the icon in the same language as the rest of the
// art: edit the map below, re-run, and every platform size regenerates.
//
//   node scripts/make-icon.mjs           # writes scripts/icon-source.png
//   npx tauri icon scripts/icon-source.png   # fans out to every platform size
//
// The PNG encoder is inline (zlib is in Node's stdlib) so this pulls in no
// dependency for a file that runs about twice a year.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Palette shared with the in-game art: the sky blue the world renders under,
// the canopy greens from icons.rs's tray tree, and the axe grey/handle brown
// from the woodcutter sprite. The icon reads as a frame of the actual game
// rather than as separate branding.
const PALETTE = {
  ".": null, // transparent
  B: "#7ec0e4", // sky blue backdrop
  b: "#6aa8cc", // backdrop shade (lower right)
  D: "#1f5c33", // canopy outline / deep shadow
  G: "#2e8642", // canopy green
  g: "#48a85a", // canopy highlight
  T: "#6e4c30", // trunk
  t: "#4a3220", // trunk shadow
  A: "#c8ccd4", // axe head
  a: "#8f949c", // axe head shade
  H: "#8c603a", // axe handle
  E: "#4f9b4a", // grass
  e: "#3d7d3a", // grass shade
  S: "#785434", // soil
};

// 32x32. Big enough for a readable axe at large sizes, small enough that the
// silhouette still holds together when macOS renders it at 16px in a list.
const ICON = [
  "..BBBBBBBBBBBBBBBBBBBBBBBBBBBB..",
  ".BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB.",
  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBDDDDBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBDDGGGGDDBBBBBBBBBBBBB",
  "BBBBBBBBBBDGGGgGGGGDBBBBBBBBBBBB",
  "BBBBBBBBBDGGGGGGgGGGDBBBBBBBBBBB",
  "BBBBBBBBDGGgGGGGGGGGGDBBBBBBBBBB",
  "BBBBBBBDGGGGGGgGGGGgGGDBBBBBBBBB",
  "BBBBBBDGGgGGGGGGGGGGGGGDBBBBBBBB",
  "BBBBBDGGGGGGgGGGgGGGGgGGDBBBBBBB",
  "BBBBDGGgGGGGGGGGGGGgGGGGGDBBBBBB",
  "BBBBDGGGGGgGGGGgGGGGGGGgGDBBBBBB",
  "BBBBBDGGGGGGGGGGGgGGGGGGDBBBBBBB",
  "BBBBBBDGGgGGGGgGGGGGGGGDBBBBBBBB",
  "BBBBBBBDDGGGGGGGGgGGGGDDBBBBBBBB",
  "BBBBBBBBBDDGGGgGGGGGDDBBBBBBBBBB",
  "BBBBBBBBBBBDDGGGGGDDBBBBBBBBBBBB",
  "BBBBBBBBAABBBTTttBBBBBBBBBBBBBBB",
  "BBBBBBBBAAAaBTTttBBBBBBBBBBBBBBB",
  "BBBBBBBBAAAAATTttBBBBBBBBBBBBBBB",
  "BBBBBBBBAaaABTTttBBBBBBBBBBBBBBB",
  "BBBBBBBBAaBBBTTttBBBBBBBBBBBBBBB",
  "BBBBBBBHHBBBBTTttBBBBBBBBBBBBBBB",
  "BBBBBBHHBBBBBTTttBBBBBBBBBBBBBBB",
  "BBBBBHHBBBBBBTTttBBBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBTTTTTBBBBBBBBBBBBBB",
  "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
  "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
  ".SSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.",
  "..SSSSSSSSSSSSSSSSSSSSSSSSSSSS..",
];

const SCALE = 32; // 32 x 32px map -> 1024x1024 source PNG
const SIZE = ICON.length * SCALE;

function hexToRgba(hex) {
  if (hex === null) return [0, 0, 0, 0];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    255,
  ];
}

/** Raw RGBA, nearest-neighbour upscaled — no smoothing, same as the tray. */
function rasterize() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < ICON.length; y++) {
    const row = ICON[y];
    for (let x = 0; x < row.length; x++) {
      const key = row[x];
      if (!(key in PALETTE)) throw new Error(`row ${y}: unknown palette char ${JSON.stringify(key)}`);
      const [r, g, b, a] = hexToRgba(PALETTE[key]);
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const i = ((y * SCALE + dy) * SIZE + x * SCALE + dx) * 4;
          px[i] = r;
          px[i + 1] = g;
          px[i + 2] = b;
          px[i + 3] = a;
        }
      }
    }
  }
  return px;
}

// --- minimal PNG encoder ---------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  // Each scanline is prefixed with filter byte 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Every row the same width, or the art is silently misaligned.
const widths = new Set(ICON.map((r) => r.length));
if (widths.size !== 1) throw new Error(`ragged icon map: row widths ${[...widths].join(", ")}`);
if (ICON.length !== ICON[0].length) throw new Error(`icon must be square: ${ICON[0].length}x${ICON.length}`);

const out = join(dirname(fileURLToPath(import.meta.url)), "icon-source.png");
writeFileSync(out, encodePng(rasterize(), SIZE));
console.log(`wrote ${out} (${SIZE}x${SIZE}, from a ${ICON[0].length}x${ICON.length} map)`);
