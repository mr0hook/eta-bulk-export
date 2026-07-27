// Generates our OWN icons: amber rounded tile + dark "download into a tray" export mark.
// No image libs — hand-rolled PNG (RGBA) via zlib. Bold proportions so the glyph survives 16px.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const AMBER = [227, 165, 82], INK = [26, 18, 6];

function inRoundRect(x, y, s, r) {
  const cx = Math.min(Math.max(x, r), s - r), cy = Math.min(Math.max(y, r), s - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x <= s - r) || (y >= r && y <= s - r);
}
// Export glyph = downward arrow dropping into an open tray. Normalized (0..1), thick enough for 16px.
function inMark(x, y, s) {
  const nx = x / s, ny = y / s;
  const shaft = nx >= 0.42 && nx <= 0.58 && ny >= 0.20 && ny <= 0.50;
  const head = ny >= 0.47 && ny <= 0.67 && Math.abs(nx - 0.5) <= 0.20 * (1 - (ny - 0.47) / 0.20); // arrowhead → apex at bottom
  const trayBottom = ny >= 0.72 && ny <= 0.84 && nx >= 0.26 && nx <= 0.74;
  const trayLeft = nx >= 0.26 && nx <= 0.36 && ny >= 0.60 && ny <= 0.84;
  const trayRight = nx >= 0.64 && nx <= 0.74 && ny >= 0.60 && ny <= 0.84;
  return shaft || head || trayBottom || trayLeft || trayRight;
}
function draw(s) {
  const r = Math.round(s * 0.22);
  const buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = (y * s + x) * 4;
    if (!inRoundRect(x + 0.5, y + 0.5, s, r)) { buf[i + 3] = 0; continue; }
    const [R, G, B] = inMark(x + 0.5, y + 0.5, s) ? INK : AMBER;
    buf[i] = R; buf[i + 1] = G; buf[i + 2] = B; buf[i + 3] = 255;
  }
  return buf;
}

// ---- minimal PNG encoder ----
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png(s, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(s * (s * 4 + 1));
  for (let y = 0; y < s; y++) { raw[y * (s * 4 + 1)] = 0; rgba.copy(raw, y * (s * 4 + 1) + 1, y * s * 4, (y + 1) * s * 4); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [16, 48, 128]) {
  const out = new URL(`./icon${s}.png`, import.meta.url);
  writeFileSync(out, png(s, draw(s)));
  console.log(`✓ icon${s}.png`);
}
