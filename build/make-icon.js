// One-off icon generator: blue -> ocean-cyan gradient with wave mark, no text.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);
const mix = (a, b, t) => a + (b - a) * t;

// Deep blue -> ocean cyan-green
const C1 = [10, 48, 132];
const C2 = [26, 190, 214];
const C3 = [31, 226, 190];

function render(size) {
  const body = Buffer.alloc(size * size * 4);
  const radius = Math.max(1, size * 0.225);
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      // rounded-square coverage (anti-aliased)
      const qx = Math.abs(cx - half) - (half - radius);
      const qy = Math.abs(cy - half) - (half - radius);
      const dist =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
        Math.min(Math.max(qx, qy), 0) -
        radius;
      const cov = clamp(0.5 - dist, 0, 1);
      if (cov <= 0) continue;

      // diagonal gradient
      let t = clamp((cx / size) * 0.4 + (cy / size) * 0.6, 0, 1);
      t = smooth(t);
      let r, g, b;
      if (t < 0.55) {
        const u = t / 0.55;
        r = mix(C1[0], C2[0], u);
        g = mix(C1[1], C2[1], u);
        b = mix(C1[2], C2[2], u);
      } else {
        const u = (t - 0.55) / 0.45;
        r = mix(C2[0], C3[0], u);
        g = mix(C2[1], C3[1], u);
        b = mix(C2[2], C3[2], u);
      }

      // soft top-left sheen
      const gd = Math.hypot(cx - size * 0.28, cy - size * 0.22) / (size * 0.75);
      const sheen = Math.max(0, 1 - gd) ** 2 * 0.22;
      r = r + (255 - r) * sheen;
      g = g + (255 - g) * sheen;
      b = b + (255 - b) * sheen;

      // bottom-right depth
      const vd = Math.hypot(cx - size * 0.92, cy - size * 0.95) / (size * 0.9);
      const dark = Math.max(0, 1 - vd) ** 2 * 0.18;
      r *= 1 - dark;
      g *= 1 - dark;
      b *= 1 - dark;

      // three ocean waves, no lettering
      let wave = 0;
      for (let i = 0; i < 3; i++) {
        const base = size * (0.585 + i * 0.115);
        const amp = size * (0.036 - i * 0.004);
        const yc = base + amp * Math.sin((cx / size) * Math.PI * 2.2 + i * 1.15);
        const th = size * (0.032 - i * 0.004);
        const d = Math.abs(cy - yc) - th;
        const a = clamp(0.5 - d * 2, 0, 1) * (0.95 - i * 0.17);
        if (a > 0) wave = Math.max(wave, a);
      }
      if (wave > 0) {
        r = mix(r, 255, wave);
        g = mix(g, 255, wave);
        b = mix(b, 255, wave);
      }

      const o = (y * size + x) * 4;
      body[o] = Math.round(r);
      body[o + 1] = Math.round(g);
      body[o + 2] = Math.round(b);
      body[o + 3] = Math.round(cov * 255);
    }
  }

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    body.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const dir = [];
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...pngs.map((p) => p.png)]);
}

function makeIcns(entries) {
  const blocks = entries.map(({ type, png }) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(png.length + 8, 0);
    return Buffer.concat([Buffer.from(type, 'ascii'), len, png]);
  });
  const total = Buffer.alloc(4);
  total.writeUInt32BE(8 + blocks.reduce((n, b) => n + b.length, 0), 0);
  return Buffer.concat([Buffer.from('icns', 'ascii'), total, ...blocks]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pngs = new Map(sizes.map((s) => [s, render(s)]));

const out = path.join(__dirname);
fs.writeFileSync(path.join(out, 'icon.png'), pngs.get(1024));
fs.writeFileSync(
  path.join(out, 'icon.ico'),
  makeIco([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, png: pngs.get(s) })))
);
fs.writeFileSync(
  path.join(out, 'icon.icns'),
  makeIcns([
    { type: 'icp4', png: pngs.get(16) },
    { type: 'icp5', png: pngs.get(32) },
    { type: 'icp6', png: pngs.get(64) },
    { type: 'ic07', png: pngs.get(128) },
    { type: 'ic08', png: pngs.get(256) },
    { type: 'ic09', png: pngs.get(512) },
    { type: 'ic10', png: pngs.get(1024) },
  ])
);

// The renderer window / UI mark uses a smaller copy.
const srcDir = path.join(__dirname, '..', 'src');
if (fs.existsSync(path.join(srcDir, 'app-icon.png'))) {
  fs.writeFileSync(path.join(srcDir, 'app-icon.png'), pngs.get(512));
}

console.log('icon.png/ico/icns written (png @1024, ico+icns multi-res)');
