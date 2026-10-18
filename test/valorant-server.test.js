'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createValorantServer } = require('../valorant-server.js');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function withServer(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valorant-test-'));
  const srv = createValorantServer({ dataDir: dir, port: 0, refreshCatalog: false, ...options });
  const info = await srv.start();
  const base = `http://127.0.0.1:${info.port}`;
  const post = (url, body, headers = {}) =>
    fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    await fn({ base, post, dir, srv });
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('l\'état et le catalogue sont servis', async () => {
  await withServer({}, async ({ base }) => {
    const s = await (await fetch(base + '/api/state')).json();
    assert.equal(s.players.left.length, 5);
    assert.equal(typeof s.now, 'number');
    assert.equal(s.derived.need, 2);
    const c = await (await fetch(base + '/api/catalog')).json();
    assert.ok(c.agents.some((a) => a.name === 'Jett' && a.icon.startsWith('https://media.valorant-api.com/')));
    assert.ok(c.maps.some((m) => m.name === 'Split'));
  });
});

test('les pages sont servies', async () => {
  await withServer({}, async ({ base }) => {
    const home = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/control');
    for (const url of ['/shared/fonts.css', '/base/control.css']) {
      const r = await fetch(base + url);
      assert.equal(r.status, 200, url);
    }
    assert.equal((await fetch(base + '/shared/../../server.js')).status, 404);
    assert.equal((await fetch(base + '/inconnu')).status, 404);
  });
});

test('le panneau modifie le match, et seules les pages du serveur peuvent le faire', async () => {
  await withServer({}, async ({ base, post }) => {
    let r = await post('/api/match', { teams: { left: { name: 'Alpha', tag: 'alp' } }, round: { left: 3 } });
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.equal(s.teams.left.tag, 'ALP');
    assert.equal(s.round.left, 3);

    r = await fetch(base + '/api/match', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 403);
    r = await post('/api/match', {}, { Origin: 'https://site-quelconque.example' });
    assert.equal(r.status, 403);
    // fetch() ne laisse pas changer l'en-tête Host : on passe par http.request.
    const status = await new Promise((resolve, reject) => {
      const u = new URL(base);
      const req = http.request({ host: u.hostname, port: u.port, path: '/api/match', method: 'POST', headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(status, 403);
    r = await fetch(base + '/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{pas du json' });
    assert.equal(r.status, 400);
  });
});

test('les actions : manche gagnée, fin de map, annuler, côtés, chrono, écran de fin', async () => {
  await withServer({}, async ({ post }) => {
    const act = async (body) => {
      const r = await post('/api/action', body);
      return { status: r.status, body: await r.json() };
    };

    await post('/api/match', { maps: [{ name: 'Split' }, { name: 'Lotus' }], players: { left: [{ name: 'Nova', kills: 12 }] } });
    let r = await act({ type: 'roundWon', side: 'left' });
    assert.equal(r.body.round.left, 1);
    assert.equal(r.body.round.number, 2);
    assert.equal((await act({ type: 'roundWon', side: 'dessous' })).status, 400);

    r = await act({ type: 'undo' });
    assert.equal(r.body.round.left, 0);
    assert.equal((await act({ type: 'undo' })).status, 409);

    assert.equal((await act({ type: 'endMap' })).status, 409, 'égalité 0-0 : il faut indiquer le gagnant');
    r = await act({ type: 'endMap', winner: 'right' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.series, { left: 0, right: 1 });
    assert.equal(r.body.endScreen.visible, true);
    assert.equal(r.body.endScreen.data.kind, 'map');
    assert.equal(r.body.mapIndex, 1);
    r = await act({ type: 'undo' });
    assert.deepEqual(r.body.series, { left: 0, right: 0 });
    assert.equal(r.body.endScreen.visible, false);

    r = await act({ type: 'swap' });
    assert.equal(r.body.players.right[0].name, 'Nova');

    r = await act({ type: 'phase', phase: 'live' });
    assert.equal(r.body.round.phase, 'live');
    assert.equal(r.body.timer.running, true);
    assert.equal(r.body.timer.total, 100000);
    r = await act({ type: 'timer', op: 'pause' });
    assert.equal(r.body.timer.running, false);
    r = await act({ type: 'timer', op: 'set', seconds: 45, run: false });
    assert.equal(r.body.timer.remaining, 45000);
    assert.equal((await act({ type: 'timer', op: 'danser' })).status, 400);
    assert.equal((await act({ type: 'phase', phase: 'danser' })).status, 400);

    r = await act({ type: 'endscreen', visible: true });
    assert.equal(r.body.endScreen.visible, true);
    assert.equal(r.body.endScreen.data.kind, 'preview');
    assert.equal((await act({ type: 'endscreen' })).status, 400);
    assert.equal((await act({ type: 'inconnue' })).status, 400);

    r = await act({ type: 'reset' });
    assert.equal(r.body.teams.left.name, 'Équipe A');
  });
});

test('les logos et les presets', async () => {
  await withServer({}, async ({ base, post, dir }) => {
    let r = await post('/api/upload', { dataUrl: PNG });
    assert.equal(r.status, 200);
    const { url } = await r.json();
    assert.match(url, /^\/uploads\/[a-f0-9]{32}\.png$/);
    assert.ok(fs.existsSync(path.join(dir, 'uploads', path.basename(url))));
    assert.equal((await fetch(base + url)).status, 200);
    r = await post('/api/upload', { dataUrl: 'data:image/png;base64,AAAA' });
    assert.equal(r.status, 400, 'pas une vraie image');
    r = await post('/api/upload', { dataUrl: 'data:text/html;base64,PGI+' });
    assert.equal(r.status, 400);

    await post('/api/match', { teams: { left: { logo: url } } });
    r = await post('/api/presets', { name: 'Alpha', tag: 'alp', sub: 'AMER #1', logo: url });
    const s = await r.json();
    assert.equal(s.presets.length, 1);
    assert.equal(s.presets[0].tag, 'ALP');
    assert.equal((await post('/api/presets', { name: '' })).status, 400);
    const del = await fetch(base + '/api/presets/' + s.presets[0].id, { method: 'DELETE' });
    assert.equal((await del.json()).presets.length, 0);
    assert.equal((await fetch(base + '/api/presets/inconnu', { method: 'DELETE' })).status, 404);
  });
});

test('le match est gardé d\'un lancement à l\'autre, chrono arrêté', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valorant-test-'));
  try {
    const a = createValorantServer({ dataDir: dir, port: 0, refreshCatalog: false });
    const ia = await a.start();
    const post = (url, body) => fetch(`http://127.0.0.1:${ia.port}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post('/api/match', { teams: { right: { name: 'Omega' } }, round: { left: 6, right: 4 }, event: { name: 'Mon tournoi' } });
    await post('/api/action', { type: 'phase', phase: 'live' });
    await a.stop();

    const b = createValorantServer({ dataDir: dir, port: 0, refreshCatalog: false });
    const ib = await b.start();
    const s = await (await fetch(`http://127.0.0.1:${ib.port}/api/state`)).json();
    assert.equal(s.teams.right.name, 'Omega');
    assert.deepEqual([s.round.left, s.round.right], [6, 4]);
    assert.equal(s.event.name, 'Mon tournoi');
    assert.equal(s.round.phase, 'live');
    assert.equal(s.timer.running, false, 'un chrono en marche est arrêté au redémarrage');
    assert.ok(s.timer.remaining <= 100000);
    await b.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('un fichier de réglages abîmé est mis de côté et remplacé par les valeurs d\'origine', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valorant-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ ceci n\'est pas du json');
    const srv = createValorantServer({ dataDir: dir, port: 0, refreshCatalog: false });
    const info = await srv.start();
    const s = await (await fetch(`http://127.0.0.1:${info.port}/api/state`)).json();
    assert.equal(s.teams.left.name, 'Équipe A');
    assert.ok(fs.existsSync(path.join(dir, 'config.json.bak')));
    await srv.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('le mode démo charge un exemple et n\'écrit rien sur le disque', async () => {
  await withServer({ demo: true }, async ({ base, post, dir }) => {
    const s = await (await fetch(base + '/api/state')).json();
    assert.equal(s.teams.left.name, 'Alpha');
    assert.equal(s.timer.running, true);
    await post('/api/match', { round: { left: 10 } });
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
  });
});

test('le flux en direct envoie l\'état, puis chaque changement', async () => {
  await withServer({}, async ({ base, post }) => {
    const messages = [];
    const req = http.get(base + '/events', (res) => {
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
    });
    const waitFor = async (n) => {
      for (let i = 0; i < 50 && messages.length < n; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(messages.length >= n, `message ${n} non reçu`);
    };
    await waitFor(1);
    assert.equal(messages[0].round.left, 0);
    await post('/api/match', { round: { left: 4 } });
    await waitFor(2);
    assert.equal(messages[1].round.left, 4);
    req.destroy();
  });
});
