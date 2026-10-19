'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { Drafter } = require('../lib/drafter.js');
const { createShare } = require('../lib/drafter-share.js');

const NAMES = ['Aatrox', 'Ahri', 'Akali', 'Alistar', 'Ashe', 'Bard', 'Blitzcrank', 'Braum', 'Caitlyn', 'Camille', 'Darius', 'Draven', 'Ezreal', 'Fiora', 'Gragas', 'Graves', 'Jhin', 'Jinx', 'Kalista', 'Karma', 'Leona', 'Lulu', 'Lux', 'Nautilus', 'Orianna', 'Renekton', 'Thresh', 'Viego', 'Yone', 'Zed'];
const CHAMPIONS = NAMES.map((name, i) => ({ id: i + 1, key: name, name }));
const ROSTER = { ORDER: ['Kestrel', 'Brumelot', 'Oriane', 'Vexis', 'Tidou'], CHAOS: ['Morrow', 'Sable', 'Nyx Arden', 'Pilou', 'Garance'] };

/* Un partage sur un port libre, avec un faux fournisseur de fichiers (la vraie page est servie par server.js). */
async function withShare(fn, options = {}) {
  let drafter = new Drafter({ champions: CHAMPIONS, roster: ROSTER });
  const changes = [];
  const share = createShare({
    getDrafter: () => drafter,
    getVersion: () => '16.1.1',
    staticFile: (req, res, p) => {
      if (p !== '/drafter' && !p.startsWith('/drafter/') && !p.startsWith('/shared/')) return false;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('fichier:' + p);
      return true;
    },
    onChange: () => changes.push(Date.now()),
    host: '127.0.0.1',
    port: 0,
    ...options,
  });
  const tokens = share.newTokens();
  const { port } = await share.start();
  const base = `http://127.0.0.1:${port}`;
  const get = (p) => fetch(base + p);
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    await fn({ share, tokens, base, get, post, changes, drafter: () => drafter, drop: () => (drafter = null) });
  } finally {
    await share.stop();
  }
}

test('chaque lien porte un jeton secret : un jeton inconnu ne donne rien', async () => {
  await withShare(async ({ tokens, get }) => {
    assert.equal(new Set(Object.values(tokens)).size, 4, 'quatre jetons différents');
    assert.ok(Object.values(tokens).every((t) => /^[A-Za-z0-9_-]{12}$/.test(t)));
    assert.equal((await get('/d/' + tokens.ORDER)).status, 200);
    assert.equal(await (await get('/d/' + tokens.CHAOS)).text(), 'fichier:/drafter');
    assert.equal((await get('/d/pas-un-vrai-jeton')).status, 404);
    assert.equal((await get('/d/')).status, 404);
    assert.equal((await get('/')).status, 404);
    assert.equal((await get('/d/' + tokens.ORDER + '/inconnu')).status, 404);
    assert.equal((await get('/d/' + tokens.ORDER + '/a/b')).status, 404);
  });
});

test('seuls les scripts du drafter et les polices sont servis, rien d\'autre', async () => {
  await withShare(async ({ get }) => {
    assert.equal(await (await get('/drafter/drafter.js')).text(), 'fichier:/drafter/drafter.js');
    assert.equal((await get('/shared/fonts.css')).status, 200);
    for (const p of ['/control', '/control/index.html', '/overlay', '/uploads/x.png', '/api/state', '/events', '/server.js']) {
      assert.equal((await get(p)).status, 404, p);
    }
  });
});

test('l\'état dépend du rôle : équipe, spectateur ou régie', async () => {
  await withShare(async ({ tokens, get }) => {
    const blue = await (await get(`/d/${tokens.ORDER}/state`)).json();
    assert.equal(blue.role, 'ORDER');
    assert.equal(blue.side, 'ORDER');
    assert.equal(blue.version, '16.1.1');
    assert.equal(blue.view.status, 'lobby');
    assert.equal(blue.view.actions.length, 20);
    const red = await (await get(`/d/${tokens.CHAOS}/state`)).json();
    assert.equal(red.side, 'CHAOS');
    assert.equal((await (await get(`/d/${tokens.spec}/state`)).json()).side, null);
    assert.equal((await (await get(`/d/${tokens.admin}/state`)).json()).role, 'admin');
    const champs = await (await get(`/d/${tokens.spec}/champions`)).json();
    assert.equal(champs.version, '16.1.1');
    assert.equal(champs.champions.length, 30);
    assert.deepEqual(Object.keys(champs.champions[0]).sort(), ['id', 'key', 'name']);
  });
});

test('une équipe ne joue que son tour ; le spectateur ne joue jamais ; la régie joue pour l\'équipe dont c\'est le tour', async () => {
  await withShare(async ({ tokens, post, changes, drafter }) => {
    drafter().start(Date.now());
    const hover = (token, body) => post(`/d/${token}/hover`, body);
    let r = await hover(tokens.CHAOS, { championId: 5 });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'Ce n\'est pas à votre équipe de jouer.');
    assert.equal(changes.length, 0, 'une action refusée ne change rien');

    r = await hover(tokens.ORDER, { championId: 5 });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).view.hover.championId, 5);
    assert.equal(changes.length, 1);

    r = await hover(tokens.spec, { championId: 6 });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'Ce lien est en lecture seule.');

    r = await post(`/d/${tokens.ORDER}/lock`, {});
    assert.equal(r.status, 200, 'verrouiller sans champion reprend le survol');
    assert.equal(drafter().turn, 1);
    assert.equal(drafter().isAvailable(5), false);

    // Au tour de l'équipe rouge, la régie joue à sa place.
    r = await post(`/d/${tokens.admin}/lock`, { championId: 7 });
    assert.equal(r.status, 200);
    assert.equal(drafter().actions[1].championId, 7);
    assert.equal(drafter().actions[1].side, 'CHAOS');
    assert.equal((await post(`/d/${tokens.CHAOS}/lock`, { championId: 5 })).status, 409, 'champion déjà banni');
  });
});

test('choisir un poste pour un pick', async () => {
  await withShare(async ({ tokens, post, drafter }) => {
    const d = drafter();
    d.start(0);
    for (let i = 0; i < 6; i++) d.lock(d.active().side, i + 1, undefined, 0);
    const r = await post(`/d/${tokens.ORDER}/lock`, { championId: 20, slot: 3 });
    assert.equal(r.status, 200);
    assert.equal(d.actions[6].slot, 3);
    const again = await post(`/d/${tokens.CHAOS}/lock`, { championId: 21, slot: 0 });
    assert.equal(again.status, 200);
    const taken = await post(`/d/${tokens.CHAOS}/lock`, { championId: 22, slot: 0 });
    assert.equal(taken.status, 409);
    assert.equal((await taken.json()).error, 'Ce poste a déjà son champion.');
  });
});

test('garde-fous : JSON seulement, pas d\'autre origine, corps limité, pas de draft', async () => {
  await withShare(async ({ tokens, base, post, drafter, drop }) => {
    drafter().start(Date.now());
    const url = `${base}/d/${tokens.ORDER}/hover`;
    const plain = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"championId":5}' });
    assert.equal(plain.status, 403);
    assert.equal((await post(`/d/${tokens.ORDER}/hover`, { championId: 5 }, { Origin: 'https://site-quelconque.example' })).status, 403);
    assert.equal((await post(`/d/${tokens.ORDER}/hover`, { championId: 5 }, { Origin: base })).status, 200, 'la page elle-même est acceptée');
    const big = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ championId: 5, x: 'y'.repeat(5000) }) });
    assert.equal(big.status, 413);
    const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{pas du json' });
    assert.equal(bad.status, 400);
    assert.equal(drafter().hover.championId, 5, 'rien n\'a changé par les demandes refusées');
    drop();
    const none = await post(`/d/${tokens.ORDER}/hover`, { championId: 5 });
    assert.equal(none.status, 409);
    assert.equal((await none.json()).error, 'Aucun draft en cours.');
  });
});

/* Ouvre le flux en direct d'un lien ; renvoie les messages reçus et de quoi fermer. */
function listen(url) {
  const messages = [];
  const req = http.get(url, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith('data: ')) messages.push(JSON.parse(block.slice(6)));
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  const waitFor = async (n) => {
    for (let i = 0; i < 100 && messages.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(messages.length >= n, `message ${n} non reçu`);
  };
  return { messages, waitFor, close: () => req.destroy() };
}

test('le flux en direct : l\'état à la connexion, puis à chaque action, et le nombre de pages ouvertes', async () => {
  await withShare(async ({ share, tokens, base, post, drafter }) => {
    drafter().start(Date.now());
    const blue = listen(`${base}/d/${tokens.ORDER}/events`);
    const spec = listen(`${base}/d/${tokens.spec}/events`);
    await blue.waitFor(1);
    await spec.waitFor(1);
    assert.equal(blue.messages[0].role, 'ORDER');
    assert.equal(spec.messages[0].side, null);
    assert.deepEqual(share.clientCounts(), { ORDER: 1, CHAOS: 0, spec: 1, admin: 0 });

    await post(`/d/${tokens.ORDER}/hover`, { championId: 9 });
    await post(`/d/${tokens.ORDER}/lock`, {});
    await spec.waitFor(3);
    const last = spec.messages[spec.messages.length - 1];
    assert.equal(last.view.turn, 1);
    assert.deepEqual(last.view.used, [9]);

    blue.close();
    spec.close();
    for (let i = 0; i < 50 && share.clientCounts().ORDER; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(share.clientCounts(), { ORDER: 0, CHAOS: 0, spec: 0, admin: 0 });
  });
});

test('trop de pages ouvertes : les suivantes sont refusées', async () => {
  await withShare(
    async ({ tokens, base }) => {
      const a = listen(`${base}/d/${tokens.spec}/events`);
      const b = listen(`${base}/d/${tokens.spec}/events`);
      await a.waitFor(1);
      await b.waitFor(1);
      const refused = await fetch(`${base}/d/${tokens.spec}/events`);
      assert.equal(refused.status, 503);
      a.close();
      b.close();
    },
    { maxClients: 2 }
  );
});

test('recréer les liens invalide les anciens et ferme leurs pages', async () => {
  await withShare(async ({ share, tokens, base, get }) => {
    const spec = listen(`${base}/d/${tokens.spec}/events`);
    await spec.waitFor(1);
    const fresh = share.newTokens();
    assert.notEqual(fresh.ORDER, tokens.ORDER);
    assert.equal((await get('/d/' + tokens.ORDER)).status, 404, 'l\'ancien lien ne marche plus');
    assert.equal((await get('/d/' + fresh.ORDER)).status, 200);
    assert.deepEqual(share.clientCounts(), { ORDER: 0, CHAOS: 0, spec: 0, admin: 0 });
    spec.close();
  });
});
