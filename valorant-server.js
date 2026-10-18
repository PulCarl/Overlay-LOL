'use strict';

/*
 * Serveur local de l'overlay VALORANT.
 *
 *  - garde le match (équipes, manches, maps, joueurs, chrono…) dans data/valorant/config.json ;
 *  - reçoit les actions du panneau de contrôle (API JSON) ;
 *  - redistribue l'état à l'overlay et au panneau (Server-Sent Events).
 *
 * Contrairement au serveur LoL, rien n'est lu dans le jeu : VALORANT n'a pas d'API locale
 * pour cela, c'est le régisseur qui pilote tout depuis le panneau (voir lib/valorant/match.js).
 *
 * Aucune dépendance : uniquement des modules natifs de Node.js.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const V = require('./lib/valorant/match');
const catalogData = require('./lib/valorant/catalog');
const kit = require('./lib/http-kit');

const { sendJson, fail } = kit;

/* ------------------------------------------------------------------ options */

// Avec « node valorant-server.js », argv = [programme, script, ...options].
// Dans l'application de bureau empaquetée (Electron), il n'y a pas de script : argv = [exe, ...options].
const IS_PACKAGED_ELECTRON = !!process.versions.electron && !process.defaultApp;
const args = process.argv.slice(IS_PACKAGED_ELECTRON ? 1 : 2);
const hasFlag = (name) => args.includes('--' + name);

const PUBLIC_DIR = path.join(__dirname, 'public');
const API_URL = 'https://valorant-api.com/v1';

const pad = (n) => String(n).padStart(2, '0');
function log(msg) {
  const d = new Date();
  console.log(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${msg}`);
}

/* ------------------------------------------------------------------ serveur */

/*
 * Crée un serveur. `dataDir` est le dossier de VALORANT (réglages et logos) ; `demo` charge le match
 * d'exemple sans jamais rien écrire sur le disque ; `refreshCatalog` complète la liste des agents et
 * des maps avec valorant-api.com (désactivé dans les tests).
 */
function createValorantServer({ dataDir, host = '127.0.0.1', port = 3001, demo = false, refreshCatalog = true } = {}) {
  const uploadDir = path.join(dataDir, 'uploads');
  const configFile = path.join(dataDir, 'config.json');
  const match = V.defaultMatch();
  const history = [];
  let agents = catalogData.AGENTS.slice();
  let maps = catalogData.MAPS.slice();

  /* ----------------------------------------------------------- réglages */

  function loadConfig() {
    let raw;
    try {
      raw = fs.readFileSync(configFile, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') log(`Lecture de data/valorant/config.json impossible : ${e.message}`);
      return;
    }
    try {
      const saved = JSON.parse(raw);
      V.applyPatch(match, saved, { trusted: true });
      if (Array.isArray(saved.presets)) match.presets = saved.presets.map(V.cleanPreset).filter(Boolean).slice(0, 30);
      V.normalize(match, Date.now());
    } catch (e) {
      log(`data/valorant/config.json illisible (${e.message}) : copie dans config.json.bak, réglages par défaut utilisés.`);
      try {
        fs.writeFileSync(configFile + '.bak', raw);
      } catch (_) {
        /* tant pis */
      }
      V.resetMatch(match);
    }
  }

  function saveConfig() {
    if (demo) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = configFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(match, null, 2));
      fs.renameSync(tmp, configFile);
    } catch (e) {
      log(`Sauvegarde de data/valorant/config.json impossible : ${e.message}`);
    }
  }

  /* ------------------------------------------------------------ catalogue */

  const getJson = (url) =>
    new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('délai dépassé')));
      req.on('error', reject);
    });

  /* Ajoute les agents et les maps sortis depuis la liste embarquée. Sans Internet, la liste embarquée suffit. */
  async function refresh() {
    try {
      const a = await getJson(`${API_URL}/agents?isPlayableCharacter=true&language=fr-FR`);
      const known = new Set(agents.map((x) => x.id));
      for (const x of a.data || []) {
        if (/^[0-9a-f-]{36}$/.test(x.uuid) && x.displayName && !known.has(x.uuid)) {
          agents.push({ id: x.uuid, name: String(x.displayName).slice(0, 24), role: x.role ? String(x.role.displayName).slice(0, 24) : '' });
          log(`Nouvel agent ajouté à la liste : ${x.displayName}.`);
        }
      }
      agents.sort((p, q) => p.name.localeCompare(q.name, 'fr'));
      const mp = await getJson(`${API_URL}/maps?language=fr-FR`);
      const knownMaps = new Set(maps.map((x) => x.id));
      for (const x of mp.data || []) {
        if (/^[0-9a-f-]{36}$/.test(x.uuid) && x.displayName && /Sites/.test(x.tacticalDescription || '') && !knownMaps.has(x.uuid)) {
          maps.push({ id: x.uuid, name: String(x.displayName).slice(0, 24) });
          log(`Nouvelle map ajoutée à la liste : ${x.displayName}.`);
        }
      }
      maps.sort((p, q) => p.name.localeCompare(q.name, 'fr'));
    } catch (e) {
      log(`Liste des agents et des maps : on garde celle du programme (${e.message}).`);
    }
  }

  /* ------------------------------------------------------------- diffusion */

  const hub = kit.createEventHub(() => V.publicState(match, Date.now()));
  const changed = () => {
    saveConfig();
    hub.broadcast();
  };

  /* ------------------------------------------------------------------- API */

  function runAction(body) {
    const now = Date.now();
    const type = String(body.type || '');
    const bad = (message) => Object.assign(new Error(message), { code: 400 });
    switch (type) {
      case 'roundWon':
        if (!V.SIDES.includes(body.side)) throw bad('Équipe invalide (left ou right).');
        V.remember(history, match);
        V.roundWon(match, body.side);
        break;
      case 'endMap':
        V.remember(history, match);
        try {
          V.endMap(match, body.winner);
        } catch (e) {
          history.pop();
          throw e;
        }
        break;
      case 'swap':
        V.remember(history, match);
        V.swapSides(match);
        break;
      case 'resetPlayers':
        V.remember(history, match);
        V.resetPlayers(match);
        break;
      case 'undo':
        if (!V.undo(history, match)) throw Object.assign(new Error('Rien à annuler.'), { code: 409 });
        break;
      case 'reset':
        V.remember(history, match);
        V.resetMatch(match);
        log('Tous les réglages ont été réinitialisés (les presets sont conservés).');
        break;
      case 'demo':
        V.remember(history, match);
        V.loadDemo(match, now);
        break;
      case 'phase':
        if (!V.PHASES.includes(body.phase)) throw bad('Phase invalide.');
        V.startPhase(match, body.phase, now);
        break;
      case 'timer':
        if (body.op === 'set') V.timerSet(match, body.seconds, !!body.run, now);
        else if (body.op === 'pause') V.timerPause(match, now);
        else if (body.op === 'resume') V.timerResume(match, now);
        else if (body.op === 'reset') V.timerReset(match);
        else throw bad('Opération de chrono invalide.');
        break;
      case 'endscreen':
        if (typeof body.visible !== 'boolean') throw bad('Paramètre invalide (visible).');
        V.showEndScreen(match, body.visible);
        break;
      default:
        throw bad('Action inconnue.');
    }
  }

  async function handleApi(req, res, pathname) {
    const method = req.method;

    if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, V.publicState(match, Date.now())), true;
    if (method === 'GET' && pathname === '/api/catalog') return sendJson(res, 200, catalogData.publicCatalog(agents, maps)), true;
    if (method !== 'POST' && method !== 'DELETE') return false;

    const denied = kit.writeGuard(req);
    if (denied) return fail(res, 403, denied), true;

    let body = {};
    if (method === 'POST') {
      try {
        body = await kit.readBody(req, pathname === '/api/upload' ? Math.ceil(kit.MAX_UPLOAD * 1.4) + 1024 : 64 * 1024);
      } catch (e) {
        return fail(res, e.code || 400, e.message), true;
      }
    }
    const done = () => {
      changed();
      sendJson(res, 200, V.publicState(match, Date.now()));
      return true;
    };

    if (method === 'POST') {
      switch (pathname) {
        case '/api/match':
          V.applyPatch(match, body);
          return done();

        case '/api/action':
          try {
            runAction(body);
          } catch (e) {
            return fail(res, e.code || 500, e.message), true;
          }
          return done();

        case '/api/upload':
          try {
            return sendJson(res, 200, { url: kit.saveUpload(uploadDir, body.dataUrl) }), true;
          } catch (e) {
            return fail(res, e.code || 500, e.message), true;
          }

        case '/api/presets': {
          if (match.presets.length >= 30) return fail(res, 409, 'Trop de presets (30 maximum).'), true;
          const name = V.str(body.name, 40);
          if (!name) return fail(res, 400, 'Le preset a besoin d\'un nom.'), true;
          match.presets.push({
            id: crypto.randomBytes(6).toString('hex'),
            name,
            tag: V.str(body.tag, 4).toUpperCase(),
            sub: V.str(body.sub, 24),
            logo: V.imageUrl(body.logo),
          });
          return done();
        }
        default:
          return false;
      }
    }

    const m = /^\/api\/presets\/([A-Za-z0-9_-]{1,32})$/.exec(pathname);
    if (method === 'DELETE' && m) {
      const before = match.presets.length;
      match.presets = match.presets.filter((p) => p.id !== m[1]);
      if (match.presets.length === before) return fail(res, 404, 'Preset introuvable.'), true;
      return done();
    }
    return false;
  }

  /* ------------------------------------------------------------------ HTTP */

  const mounts = {
    '/overlay': path.join(PUBLIC_DIR, 'valorant', 'overlay'),
    '/control': path.join(PUBLIC_DIR, 'valorant', 'control'),
    '/shared': path.join(PUBLIC_DIR, 'shared'),
    // Le panneau VALORANT reprend la feuille de style de base du panneau LoL.
    '/base': path.join(PUBLIC_DIR, 'control'),
    '/uploads': uploadDir,
  };

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      return fail(res, 400, 'Adresse invalide.');
    }
    try {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(302, { Location: '/control' });
        return res.end();
      }
      if (req.method === 'GET' && pathname === '/events') return hub.handle(req, res);
      if (pathname.startsWith('/api/') && (await handleApi(req, res, pathname))) return;
      if ((req.method === 'GET' || req.method === 'HEAD') && kit.serveStatic(mounts, req, res, pathname)) return;
      fail(res, 404, 'Introuvable.');
    } catch (e) {
      log(`Erreur serveur : ${e.stack || e.message}`);
      if (!res.headersSent) fail(res, 500, 'Erreur interne.');
      else res.end();
    }
  });

  /* -------------------------------------------------------------- démarrage */

  function lanAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
    return out;
  }

  /* Démarre le serveur. La promesse est rejetée si le port est pris (voir startErrorMessage). */
  function start() {
    return new Promise((resolve, reject) => {
      if (demo) V.loadDemo(match, Date.now());
      else loadConfig();

      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        server.on('error', (e) => log(`Erreur du serveur : ${e.message}`));
        const actual = server.address().port;
        const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
        console.log('');
        console.log('  Overlay VALORANT : serveur démarré');
        console.log(`  Panneau de contrôle : http://${shown}:${actual}/control`);
        console.log(`  Overlay pour OBS    : http://${shown}:${actual}/overlay   (source navigateur 1920×1080)`);
        if (host === '0.0.0.0') for (const ip of lanAddresses()) console.log(`  Sur le réseau       : http://${ip}:${actual}/overlay`);
        if (demo) console.log('  MODE DÉMO : match d\'exemple, rien n\'est enregistré');
        console.log('');
        if (refreshCatalog) refresh();
        resolve({ host, port: actual, demo });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      hub.close();
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return { start, stop, match };
}

/* Message en français pour une erreur de démarrage (port pris, etc.). */
function startErrorMessage(e, port) {
  if (e && e.code === 'EADDRINUSE') {
    return (
      `Le port ${port} est déjà utilisé (une autre instance tourne peut-être déjà).\n` +
      'Fermez le programme qui utilise ce port, ou choisissez un autre port : « set VALORANT_PORT=3002 » puis relancez.'
    );
  }
  return `Impossible de démarrer le serveur VALORANT : ${e && e.message ? e.message : e}`;
}

/* ----------------------------------------------------- lancement habituel */

const PORT = Number(process.env.VALORANT_PORT) || 3001;
const HOST = process.env.HOST || '127.0.0.1';

// Même dossier de réglages que l'application, dans un sous-dossier « valorant ».
const dataDir = () => path.join(process.env.OVERLAY_DATA_DIR || path.join(__dirname, 'data'), 'valorant');

/* Démarre le serveur avec les réglages habituels (variables d'environnement, option --demo). */
function start() {
  const instance = createValorantServer({ dataDir: dataDir(), host: HOST, port: PORT, demo: hasFlag('demo') });
  return instance.start().catch((e) => {
    throw Object.assign(new Error(startErrorMessage(e, PORT)), { code: e && e.code });
  });
}

/* Lancement en ligne de commande : node valorant-server.js [--demo] [--open]. */
function runCli() {
  process.on('SIGINT', () => {
    console.log('\nArrêt du serveur.');
    process.exit(0);
  });
  start()
    .then(() => {
      if (hasFlag('open')) {
        const url = `http://localhost:${PORT}/control`;
        const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
        spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      }
    })
    .catch((e) => {
      console.error('\n' + e.message + '\n');
      process.exit(1);
    });
}

// Dans l'application de bureau (Electron), games.js importe ce fichier et appelle start() lui-même.
if (require.main === module) runCli();

module.exports = { createValorantServer, start, startErrorMessage };
