'use strict';

/*
 * Icône de l'application, dessinée en code (aucune image à fournir) :
 * la barre de score de l'overlay (bleu, or au centre, rouge) sur fond bleu nuit.
 * makeIcon() renvoie le fichier .ico et l'image .png de 256 × 256.
 */

const zlib = require('zlib');

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/* Distance signée à un rectangle aux coins arrondis (négative à l'intérieur). */
function roundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(px - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/* Dégradé de la charte (#4802DE → #9E42ED) selon la position horizontale. */
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.min(1, Math.max(0, t)));
const VIOLET = [72, 2, 222];
const PURPLE = [158, 66, 237];

function makeIcon() {
  const N = 256;
  // Couleurs de la charte Genesis : #151724 (fond), #D9D9D9 (argent), #9E42ED, #4802DE.
  const layers = [
    { d: (x, y) => roundRect(x, y, 8, 8, 248, 248, 54), c: (x, y) => mix(VIOLET, PURPLE, (x + y) / 480) },
    { d: (x, y) => roundRect(x, y, 14, 14, 242, 242, 49), c: [21, 23, 36] },
    { d: (x, y) => roundRect(x, y, 36, 88, 118, 168, 14), c: (x) => mix(VIOLET, PURPLE, (x - 36) / 82) },
    { d: (x, y) => roundRect(x, y, 138, 88, 220, 168, 14), c: (x) => mix([217, 217, 217], [150, 150, 168], (x - 138) / 82) },
    { d: (x, y) => roundRect(x, y, 108, 76, 148, 180, 8), c: [0, 1, 3] },
    { d: (x, y) => roundRect(x, y, 119, 94, 137, 110, 4), c: [246, 244, 251] },
    { d: (x, y) => roundRect(x, y, 44, 196, 212, 206, 5), c: [42, 33, 80] },
    { d: (x, y) => roundRect(x, y, 128, 196, 176, 206, 5), c: PURPLE },
    { d: (x, y) => roundRect(x, y, 170, 190, 182, 212, 5), c: [217, 217, 217] },
  ];
  const raw = Buffer.alloc((N * 4 + 1) * N);
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    for (let x = 0; x < N; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const L of layers) {
        const cov = Math.min(1, Math.max(0, 0.5 - L.d(x + 0.5, y + 0.5)));
        if (cov <= 0) continue;
        const c = typeof L.c === 'function' ? L.c(x, y) : L.c;
        const outA = cov + a * (1 - cov);
        r = (c[0] * cov + r * a * (1 - cov)) / outA;
        g = (c[1] * cov + g * a * (1 - cov)) / outA;
        b = (c[2] * cov + b * a * (1 - cov)) / outA;
        a = outA;
      }
      const o = y * (N * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(r);
      raw[o + 1] = Math.round(g);
      raw[o + 2] = Math.round(b);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  // Fichier .ico contenant une seule image PNG de 256 × 256.
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return { ico: Buffer.concat([head, png]), png };
}

module.exports = { makeIcon };
