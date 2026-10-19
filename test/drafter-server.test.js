'use strict';

/*
 * Le drafter dans le vrai serveur LoL (lancé en démo, dans son propre processus) : création depuis le panneau,
 * liens partagés, joueurs qui jouent les 20 tours, lien avec l'overlay, fermeture.
 * Le partage est limité à 127.0.0.1 et sur des ports libres pour ne rien ouvrir sur le réseau pendant les tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const sharePort = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drafter-test-'));
  const child = spawn(process.execPath, ['server.js', '--demo', '--speed=1', '--start=900'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DRAFTER_PORT: String(sharePort), DRAFTER_HOST: '127.0.0.1', OVERLAY_DATA_DIR: dir, NO_LCU: '1', ...extraEnv },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const shareBase = `http://127.0.0.1:${sharePort}`;
  const state = () => fetch(base + '/api/state').then((r) => r.json());
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const cmd = (action, extra) => post('/api/drafter', { action, ...extra });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await state()).game) break;
    } catch (_) {
      /* le serveur démarre */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const stop = () => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, shareBase, sharePort, state, post, cmd, stop };
}

const ROSTER = { blue: ['Kestrel', 'Brumelot', 'Oriane', 'Vexis', 'Tidou'], red: ['Morrow', 'Sable', 'Nyx Arden', 'Pilou', 'Garance'] };

/* Les liens vus de la machine du test (127.0.0.1). */
const local = (srv, link) => srv.shareBase + link.slice(link.indexOf('/d/'));

test('créer le draft depuis le panneau, jouer avec les liens, voir l\'overlay suivre, fermer', async () => {
  const srv = await startServer();
  try {
    // Avant de créer : rien.
    assert.deepEqual((await srv.state()).drafter, { active: false });
    assert.deepEqual(await (await fetch(srv.base + '/api/drafter')).json(), { active: false });
    assert.equal((await srv.cmd('start')).status, 409, 'rien à démarrer');

    // Création : durée bornée, pseudos enregistrés.
    let r = await srv.cmd('create', { roster: ROSTER, turnSeconds: 1 });
    assert.equal(r.status, 200);
    let s = await r.json();
    assert.equal(s.drafter.active, true);
    assert.equal(s.drafter.status, 'lobby');
    assert.deepEqual(s.config.drafter.roster, ROSTER);
    assert.equal(s.config.drafter.turnSeconds, 5, 'durée minimale de 5 s');
    assert.equal((await srv.cmd('create', {})).status, 409, 'un seul draft à la fois');

    // Les liens : jamais dans l'état diffusé, seulement dans /api/drafter.
    const info = await (await fetch(srv.base + '/api/drafter')).json();
    assert.deepEqual(Object.keys(info.links).sort(), ['admin', 'blue', 'red', 'spec']);
    assert.ok(Object.values(info.links).every((l) => /\/d\/[A-Za-z0-9_-]{12}$/.test(l)));
    const token = (l) => l.split('/d/')[1];
    assert.equal(JSON.stringify(s).includes(token(info.links.blue)), false);
    assert.equal(JSON.stringify(await srv.state()).includes(token(info.links.red)), false);
    assert.ok(info.suggestions.some((u) => u.endsWith(':' + srv.sharePort)));
    assert.equal(info.port, srv.sharePort, 'le port local du partage, même quand l\'adresse affichée est celle d\'un tunnel');

    // La page des joueurs est servie, l'état est celui du draft.
    const page = await fetch(local(srv, info.links.blue));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Drafter/);
    for (const f of ['/drafter/drafter.js', '/drafter/drafter.css', '/shared/fonts.css']) assert.equal((await fetch(srv.shareBase + f)).status, 200, f);
    assert.equal((await fetch(srv.shareBase + '/control')).status, 404, 'le panneau n\'est pas sur le port partagé');
    assert.equal((await fetch(srv.shareBase + '/api/state')).status, 404);
    const view = (role) => fetch(local(srv, info.links[role]) + '/state').then((x) => x.json());
    assert.equal((await view('blue')).side, 'ORDER');
    assert.equal((await view('red')).teams.ORDER.name.length > 0, true);

    // Avant le démarrage : rien dans l'overlay, personne ne peut jouer.
    assert.equal((await srv.state()).draft.visible, false);
    const act = (role, kind, body) =>
      fetch(local(srv, info.links[role]) + '/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await act('blue', 'hover', { championId: 1 })).status, 409);

    // Démarrage : l'overlay montre la page des picks et bans, avec les pseudos saisis.
    assert.equal((await srv.cmd('start')).status, 200);
    s = await srv.state();
    assert.equal(s.draft.visible, true);
    assert.equal(s.draft.data.step, 'ban');
    assert.deepEqual(s.draft.data.active, ['ORDER']);
    assert.deepEqual(s.draft.data.teams.ORDER.picks.map((p) => p.player), ROSTER.blue);
    assert.equal((await srv.cmd('start')).status, 409, 'déjà démarré');

    // Les 20 tours, chacun joué par l'équipe dont c'est le tour (la mauvaise est refusée).
    const champs = (await (await fetch(local(srv, info.links.spec) + '/champions')).json()).champions;
    assert.ok(champs.length >= 30);
    let next = 0;
    for (let turn = 0; turn < 20; turn++) {
      const v = (await view('spec')).view;
      assert.equal(v.turn, turn);
      const side = v.active.side;
      const wrong = side === 'ORDER' ? 'red' : 'blue';
      const right = side === 'ORDER' ? 'blue' : 'red';
      assert.equal((await act(wrong, 'lock', { championId: champs[next].id })).status, 409, `tour ${turn} : mauvaise équipe`);
      assert.equal((await act(right, 'hover', { championId: champs[next].id })).status, 200);
      assert.equal((await act(right, 'lock', {})).status, 200, `tour ${turn} : verrouillage`);
      next += 1;
    }
    s = await srv.state();
    assert.equal(s.drafter.status, 'finished');
    assert.equal(s.draft.data.step, 'finalization');
    assert.ok(s.draft.data.teams.ORDER.picks.every((p) => p.state === 'locked' && p.name));
    assert.ok(s.draft.data.teams.CHAOS.picks.every((p) => p.state === 'locked' && p.name));
    assert.equal(s.draft.data.teams.ORDER.bans.filter((b) => b.state === 'done').length, 5);
    assert.equal((await act('blue', 'lock', { championId: champs[next].id })).status, 409, 'plus rien à jouer');

    // Fermeture : l'overlay n'a plus de sélection, le partage est coupé, les liens sont morts.
    assert.equal((await srv.cmd('close')).status, 200);
    s = await srv.state();
    assert.deepEqual(s.drafter, { active: false });
    assert.equal(s.draft.live, false);
    const dead = await fetch(local(srv, info.links.blue)).then((x) => x.status).catch(() => 'port fermé');
    assert.equal(dead, 'port fermé');
    assert.deepEqual(await (await fetch(srv.base + '/api/drafter')).json(), { active: false });

    // On peut en recréer un : de nouveaux liens, un nouveau partage.
    r = await srv.cmd('create', { roster: ROSTER, turnSeconds: 30 });
    assert.equal(r.status, 200);
    const again = await (await fetch(srv.base + '/api/drafter')).json();
    assert.notEqual(token(again.links.blue), token(info.links.blue));
    assert.equal((await fetch(local(srv, again.links.blue))).status, 200);
  } finally {
    srv.stop();
  }
});

test('régie, pause, annulation et recommencer depuis le panneau', async () => {
  const srv = await startServer();
  try {
    await srv.cmd('create', { roster: ROSTER, turnSeconds: 30 });
    const info = await (await fetch(srv.base + '/api/drafter')).json();
    const admin = local(srv, info.links.admin);
    const post = (kind, body) => fetch(admin + '/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // La liste des champions dépend de ce que Data Dragon a déjà donné : on prend ceux que le draft connaît.
    const champs = (await (await fetch(admin + '/champions')).json()).champions;
    assert.ok(champs.length >= 20);
    assert.equal((await srv.cmd('pause')).status, 409, 'pas de pause avant le début');
    await srv.cmd('start');
    // La régie joue pour l'équipe dont c'est le tour.
    assert.equal((await post('lock', { championId: champs[0].id })).status, 200);
    assert.equal((await post('lock', { championId: champs[1].id })).status, 200);
    let s = await srv.state();
    assert.equal(s.drafter.turn, 2);
    assert.deepEqual(s.draft.data.teams.ORDER.bans.filter((b) => b.state === 'done').map((b) => b.championId), [champs[0].id]);

    // Pause : plus rien ne se joue, l'overlay n'affiche plus de décompte.
    assert.equal((await srv.cmd('pause')).status, 200);
    s = await srv.state();
    assert.equal(s.drafter.status, 'paused');
    assert.equal(s.draft.data.timer.infinite, true);
    assert.equal((await post('lock', { championId: champs[2].id })).status, 409);
    assert.equal((await srv.cmd('resume')).status, 200);

    // Annuler le dernier ban, puis passer un ban.
    assert.equal((await srv.cmd('undo')).status, 200);
    s = await srv.state();
    assert.equal(s.drafter.turn, 1);
    assert.equal(s.draft.data.teams.CHAOS.bans.filter((b) => b.state === 'done').length, 0);
    assert.equal((await srv.cmd('skip')).status, 200);
    assert.equal((await srv.state()).drafter.turn, 2);

    // Recommencer : retour au salon, et plus rien dans l'overlay.
    assert.equal((await srv.cmd('reset')).status, 200);
    s = await srv.state();
    assert.equal(s.drafter.status, 'lobby');
    assert.equal(s.draft.visible, false);
    assert.equal((await srv.cmd('inconnue')).status, 400);
  } finally {
    srv.stop();
  }
});

test('le port de partage déjà pris : un message clair, et aucun draft à moitié ouvert', async () => {
  const taken = net.createServer();
  await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  const srv = await startServer({ DRAFTER_PORT: String(taken.address().port) });
  try {
    const r = await srv.cmd('create', { roster: ROSTER, turnSeconds: 30 });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /port \d+ est déjà utilisé/);
    assert.deepEqual((await srv.state()).drafter, { active: false });
  } finally {
    srv.stop();
    taken.close();
  }
});

test('l\'adresse à partager saisie dans le panneau sert de base aux liens', async () => {
  const srv = await startServer();
  try {
    await srv.cmd('create', { roster: ROSTER, turnSeconds: 30 });
    let r = await srv.post('/api/config', { drafter: { base: 'https://mon-tunnel.example.org/' } });
    assert.equal((await r.json()).config.drafter.base, 'https://mon-tunnel.example.org', 'le « / » final est retiré');
    const info = await (await fetch(srv.base + '/api/drafter')).json();
    assert.ok(Object.values(info.links).every((l) => l.startsWith('https://mon-tunnel.example.org/d/')));
    r = await srv.post('/api/config', { drafter: { base: 'pas une adresse' } });
    assert.equal((await r.json()).config.drafter.base, '', 'une adresse invalide est refusée');
    r = await srv.post('/api/config', { drafter: { base: 'javascript:alert(1)' } });
    assert.equal((await r.json()).config.drafter.base, '');
  } finally {
    srv.stop();
  }
});
