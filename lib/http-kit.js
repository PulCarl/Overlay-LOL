'use strict';

/*
 * Petites aides HTTP sans dépendance : réponses JSON, lecture du corps, garde-fou des routes qui
 * modifient quelque chose, envoi d'images (logos), fichiers statiques et Server-Sent Events.
 * Utilisées par le serveur VALORANT ; le serveur LoL a ses propres copies (même comportement).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
const fail = (res, code, message) => sendJson(res, code, { error: message });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Requête trop volumineuse.'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(Object.assign(new Error('JSON invalide.'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/*
 * Les routes qui modifient quelque chose n'acceptent que du JSON venant d'une page servie
 * par ce serveur : une page web quelconque ouverte dans votre navigateur ne peut pas piloter l'overlay.
 */
function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(':') ||
    host === os.hostname().toLowerCase() ||
    host.endsWith('.local')
  );
}

function writeGuard(req) {
  if (!hostAllowed(req.headers.host)) return 'Hôte non autorisé.';
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return 'Origine non autorisée.';
    } catch (_) {
      return 'Origine invalide.';
    }
  }
  if (req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return 'Content-Type application/json requis.';
  }
  return null;
}

/* ----------------------------------------------------------------- images */

const IMAGE_TYPES = {
  png: { ext: 'png', magic: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  jpeg: { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpg: { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { ext: 'webp', magic: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  gif: { ext: 'gif', magic: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
};
const MAX_UPLOAD = 5 * 1024 * 1024;

/* Enregistre une image envoyée (data URL) dans `dir` et renvoie son adresse « /uploads/… ». */
function saveUpload(dir, dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('Format d\'image non pris en charge (png, jpg, webp ou gif).'), { code: 400 });
  const kind = IMAGE_TYPES[m[1]];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_UPLOAD) throw Object.assign(new Error('Image trop lourde (5 Mo maximum).'), { code: 413 });
  if (!kind.magic(buf)) throw Object.assign(new Error('Le fichier n\'est pas une image valide.'), { code: 400 });
  const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '.' + kind.ext;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return '/uploads/' + name;
}

/* ------------------------------------------------------- fichiers statiques */

/* `mounts` associe un préfixe d'adresse à un dossier : { '/overlay': '/…/public/overlay', … }. */
function serveStatic(mounts, req, res, pathname) {
  const mount = Object.keys(mounts).find((m) => pathname === m || pathname.startsWith(m + '/'));
  if (!mount) return false;
  const root = mounts[mount];
  let rel = pathname.slice(mount.length);
  if (rel === '' || rel === '/') rel = '/index.html';
  try {
    rel = decodeURIComponent(rel);
  } catch (_) {
    fail(res, 400, 'Adresse invalide.');
    return true;
  }
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) {
    fail(res, 403, 'Accès refusé.');
    return true;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Fichier introuvable.');
    const ext = path.extname(file).toLowerCase();
    const cache = mount === '/uploads' ? 'public, max-age=31536000, immutable' : ext === '.woff2' ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return true;
}

/* ------------------------------------------------------ Server-Sent Events */

/* Diffuse l'état à toutes les pages ouvertes ; `snapshot()` renvoie l'état à envoyer. */
function createEventHub(snapshot) {
  const clients = new Set();
  const ping = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 15000);
  ping.unref();
  return {
    handle(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    broadcast() {
      if (!clients.size) return;
      const data = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const res of clients) res.write(data);
    },
    close() {
      clearInterval(ping);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

module.exports = { MIME, MAX_UPLOAD, sendJson, fail, readBody, hostAllowed, writeGuard, saveUpload, serveStatic, createEventHub };
