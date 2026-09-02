// tools/make-icons.mjs - generate PWA icons (PNG) with node built-ins only.
// Run: node tools/make-icons.mjs   -> icons/icon-192.png, icons/icon-512.png, icons/apple-touch-icon.png
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Scene: dark green rounded square, brown football rotated 45deg, white lace.
function render(size) {
  const ss = 3; // supersampling
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [11, 61, 46];
  const ball = [150, 84, 44];
  const lace = [255, 255, 255];
  const radius = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          // rounded square mask
          const dx = Math.max(Math.abs(px - size / 2) - (size / 2 - radius), 0);
          const dy = Math.max(Math.abs(py - size / 2) - (size / 2 - radius), 0);
          const inside = Math.hypot(dx, dy) <= radius;
          if (!inside) continue;
          let c = bg;
          // football: ellipse rotated 45deg
          const cx = px - size / 2;
          const cy = py - size / 2;
          const u = (cx + cy) / Math.SQRT2;
          const v = (cy - cx) / Math.SQRT2;
          const A = size * 0.36;
          const B = size * 0.2;
          if ((u * u) / (A * A) + (v * v) / (B * B) <= 1) {
            c = ball;
            // lace: short line along the major axis at the center + 4 ticks
            if (Math.abs(v) < size * 0.012 && Math.abs(u) < size * 0.14) c = lace;
            for (let k = -2; k <= 2; k++) {
              const tu = k * size * 0.055;
              if (Math.abs(u - tu) < size * 0.011 && Math.abs(v) < size * 0.045) c = lace;
            }
          }
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      if (a > 0) {
        const cov = a / (255 * n);
        rgba[i] = Math.round(r / (a / 255));
        rgba[i + 1] = Math.round(g / (a / 255));
        rgba[i + 2] = Math.round(b / (a / 255));
        rgba[i + 3] = Math.round(cov * 255);
      }
    }
  }
  return png(size, size, rgba);
}

const outDir = path.join(root, 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  fs.writeFileSync(path.join(outDir, name), render(size));
  console.log(`wrote icons/${name}`);
}
