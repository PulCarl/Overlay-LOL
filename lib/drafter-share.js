'use strict';

/*
 * Serveur de partage du drafter : les pages que les joueurs ouvrent pour faire leurs bans et leurs picks.
 *
 * C'est un serveur à part, ouvert au réseau (le panneau de contrôle, lui, reste sur l'ordinateur du régisseur) :
 * il ne sert que la page du drafter et ses réponses, et chaque lien porte un jeton secret.
 *   /d/<jeton>         la page (équipe bleue, équipe rouge, spectateur ou régie, selon le jeton)
 *   /d/<jeton>/events  l'état du draft en direct (Server-Sent Events)
 *   /d/<jeton>/hover   survoler un champion       /d/<jeton>/lock   verrouiller le ban ou le pick
 * Aucune dépendance : modules natifs de Node.js.
 */

const http = require('http');
const crypto = require('crypto');
const kit = require('./http-kit');

const ROLES = ['ORDER', 'CHAOS', 'spec', 'admin'];
const newToken = () => crypto.randomBytes(9).toString('base64url');

/*
 * getDrafter()  : le draft en cours (ou null) ;           getVersion() : version de Data Dragon (pour les icônes) ;
 * getTeams()    : noms et tags des équipes { ORDER, CHAOS } ;
 * staticFile(req, res, pathname) : sert un fichier de public/ (renvoie true s'il l'a servi) ;
 * onChange()    : appelé après chaque action d'un joueur (pour mettre à jour l'overlay).
 */
function createShare({ getDrafter, getVersion = () => null, getTeams = () => null, staticFile, onChange = () => {}, host = '0.0.0.0', port = 3002, maxClients = 80, now = Date.now } = {}) {
  let tokens = null;
  const clients = new Map(); // réponse SSE → rôle
  let ping = null;

  const roleOf = (t) => (tokens && ROLES.find((r) => tokens[r] === t)) || null;
  const sideOf = (role) => (role === 'ORDER' || role === 'CHAOS' ? role : null);
  const payload = (role) => {
    const d = getDrafter();
    return { role, side: sideOf(role), version: getVersion(), teams: getTeams(), view: d ? d.view(now()) : null };
  };

  /* Un jeton par rôle ; les anciens liens cessent de marcher et leurs pages ouvertes sont fermées. */
  function newTokens() {
    for (const res of clients.keys()) res.end();
    clients.clear();
    tokens = Object.fromEntries(ROLES.map((r) => [r, newToken()]));
    return { ...tokens };
  }

  function broadcast() {
    if (!clients.size) return;
    const cache = {};
    for (const [res, role] of clients) {
      cache[role] = cache[role] || `data: ${JSON.stringify(payload(role))}\n\n`;
      res.write(cache[role]);
    }
  }

  const clientCounts = () => {
    const out = { ORDER: 0, CHAOS: 0, spec: 0, admin: 0 };
    for (const role of clients.values()) out[role] += 1;
    return out;
  };

  /* Les routes qui modifient quelque chose n'acceptent que du JSON envoyé par une page de ce serveur. */
  function postGuard(req) {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return 'Content-Type application/json requis.';
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return 'Origine non autorisée.';
      } catch (_) {
        return 'Origine invalide.';
      }
    }
    return null;
  }

  function handleEvents(req, res, role) {
    if (clients.size >= maxClients) return kit.fail(res, 503, 'Trop de pages ouvertes.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(payload(role))}\n\n`);
    clients.set(res, role);
    req.on('close', () => clients.delete(res));
  }

  async function handleAction(req, res, role, kind) {
    const denied = postGuard(req);
    if (denied) return kit.fail(res, 403, denied);
    if (role === 'spec') return kit.fail(res, 403, 'Ce lien est en lecture seule.');
    const drafter = getDrafter();
    if (!drafter) return kit.fail(res, 409, 'Aucun draft en cours.');
    // Une demande de jeu tient en quelques dizaines d'octets : on refuse les gros corps sans les lire.
    if (Number(req.headers['content-length']) > 2048) {
      res.setHeader('Connection', 'close');
      return kit.fail(res, 413, 'Requête trop volumineuse.');
    }
    let body;
    try {
      body = await kit.readBody(req, 2048);
    } catch (e) {
      return kit.fail(res, e.code || 400, e.message);
    }
    // La régie joue à la place de l'équipe dont c'est le tour.
    const side = role === 'admin' ? (drafter.active() && drafter.active().side) || null : role;
    if (!side) return kit.fail(res, 409, 'Rien à jouer pour l\'instant.');
    const championId = Number(body.championId) || 0;
    const slot = body.slot != null && Number.isInteger(Number(body.slot)) ? Number(body.slot) : undefined;
    const result = kind === 'hover' ? drafter.hoverChampion(side, championId, slot) : drafter.lock(side, championId, slot, now());
    if (!result.ok) return kit.fail(res, 409, result.error);
    broadcast();
    onChange();
    return kit.sendJson(res, 200, { ok: true, ...payload(role) });
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      return kit.fail(res, 400, 'Adresse invalide.');
    }
    const path = url.pathname;
    const read = req.method === 'GET' || req.method === 'HEAD';
    try {
      // Fichiers de la page : uniquement les scripts du drafter et les polices.
      if (read && (path.startsWith('/drafter/') || path.startsWith('/shared/')) && staticFile(req, res, path)) return;

      const parts = path.split('/').filter(Boolean);
      if (parts[0] !== 'd' || parts.length < 2 || parts.length > 3) return kit.fail(res, 404, 'Introuvable.');
      const role = roleOf(parts[1]);
      if (!role) return kit.fail(res, 404, 'Ce lien n\'est pas valide : le draft a peut-être été recréé. Demandez un nouveau lien.');
      const sub = parts[2];

      if (read && !sub) {
        if (staticFile(req, res, '/drafter')) return;
        return kit.fail(res, 404, 'Page introuvable.');
      }
      if (req.method === 'GET' && sub === 'state') return kit.sendJson(res, 200, payload(role));
      if (req.method === 'GET' && sub === 'champions') {
        const d = getDrafter();
        return kit.sendJson(res, 200, { version: getVersion(), champions: d ? d.championList() : [] });
      }
      if (req.method === 'GET' && sub === 'events') return handleEvents(req, res, role);
      if (req.method === 'POST' && (sub === 'hover' || sub === 'lock')) return await handleAction(req, res, role, sub);
      return kit.fail(res, 404, 'Introuvable.');
    } catch (e) {
      if (!res.headersSent) kit.fail(res, 500, 'Erreur interne.');
      else res.end();
    }
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        ping = setInterval(() => {
          for (const res of clients.keys()) res.write(': ping\n\n');
        }, 15000);
        ping.unref();
        resolve({ host, port: server.address().port });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      clearInterval(ping);
      for (const res of clients.keys()) res.end();
      clients.clear();
      tokens = null;
      if (!server.listening) return resolve();
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return { start, stop, newTokens, broadcast, clientCounts, get tokens() { return tokens && { ...tokens }; }, get listening() { return server.listening; } };
}

module.exports = { createShare, ROLES };
