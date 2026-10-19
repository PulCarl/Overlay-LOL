'use strict';

/*
 * Lance le vrai serveur LoL en mode démo (dans son propre processus, sur un port libre) et teste ses routes :
 * réglages d'affichage et chronos de recharge des sorts d'invocateur.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { EXPECTED_LUM, DEFAULT_LAYOUT } = require('../lib/spellwatch.js');

const ROOT = path.join(__dirname, '..');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/* Lance le serveur sur un port libre ; renvoie de quoi l'interroger et l'arrêter. */
async function startServer(args) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-test-'));
  const child = spawn(process.execPath, ['server.js', ...args], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), OVERLAY_DATA_DIR: dir, NO_LCU: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const state = () => fetch(base + '/api/state').then((r) => r.json());
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const stop = () => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, state, post, stop };
}

async function withServer(fn, args = ['--demo', '--speed=1', '--start=900']) {
  const srv = await startServer(args);
  try {
    // La partie de démonstration apparaît à la première lecture, au bout d'une seconde environ.
    let s = null;
    for (let i = 0; i < 80; i++) {
      try {
        s = await srv.state();
        if (s.game) break;
      } catch (_) {
        /* le serveur démarre */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(s && s.game, 'la partie de démonstration n\'est pas apparue');
    await fn({ base: srv.base, state: srv.state, post: srv.post });
  } finally {
    srv.stop();
  }
}

test('réglages d\'affichage : colonnes des côtés et cadre de la minimap', async () => {
  await withServer(async ({ state, post }) => {
    let d = (await state()).config.display;
    assert.equal(d.sides, true);
    assert.equal(d.mapFrame, true);
    assert.equal(d.mapSize, 280);
    assert.equal(d.loadscreen, true, 'la page de chargement est active par défaut');

    await post('/api/config', { display: { mapSize: 9999, sides: false } });
    d = (await state()).config.display;
    assert.equal(d.mapSize, 480, 'taille bornée à 480');
    assert.equal(d.sides, false);
    await post('/api/config', { display: { mapSize: 10, mapFrame: false } });
    d = (await state()).config.display;
    assert.equal(d.mapSize, 160, 'taille bornée à 160');
    assert.equal(d.mapFrame, false);
    await post('/api/config', { display: { mapSize: 'texte' } });
    assert.equal((await state()).config.display.mapSize, 160, 'une valeur absurde ne change rien');
  });
});

test('chronos des sorts : durées prévues, lancement, corrections, arrêt', async () => {
  await withServer(async ({ state, post }) => {
    const act = async (body) => {
      const r = await post('/api/cooldown', body);
      return { status: r.status, body: await r.json() };
    };

    let s = await state();
    assert.equal(Object.keys(s.spellTotals).length, 20, 'deux sorts pour chacun des dix joueurs');
    assert.equal(s.spellTotals['ORDER:0:0'], 300, 'Saut éclair');
    assert.equal(s.spellTotals['ORDER:0:1'], 360, 'Téléportation');
    assert.equal(s.spellTotals['ORDER:1:1'], 90, 'Châtiment');
    assert.deepEqual(s.cooldowns, {});

    let r = await act({ team: 'ORDER', index: 0, slot: 0, action: 'start' });
    assert.equal(r.status, 200);
    const c = r.body.cooldowns['ORDER:0:0'];
    assert.equal(c.total, 300);
    assert.ok(c.endAt > r.body.game.gameTime + 290 && c.endAt < r.body.game.gameTime + 310, 'fin = heure de jeu + 300 s');

    r = await act({ team: 'ORDER', index: 0, slot: 0, action: 'add', seconds: 10 });
    assert.ok(Math.abs(r.body.cooldowns['ORDER:0:0'].endAt - c.endAt - 10) < 0.001);
    r = await act({ team: 'ORDER', index: 0, slot: 0, action: 'add', seconds: -9999 });
    assert.ok(Math.abs(r.body.cooldowns['ORDER:0:0'].endAt - c.endAt + 110) < 0.001, 'correction bornée à 120 s');

    r = await act({ team: 'blue', index: 0, action: 'cosmic', on: true });
    assert.equal(r.body.cosmic['ORDER:0'], true);
    assert.equal(r.body.spellTotals['ORDER:0:0'], 254, '300 s avec 18 de haste');
    assert.equal(r.body.spellTotals['ORDER:1:0'], 300, 'les autres joueurs ne changent pas');
    r = await act({ team: 'red', index: 7, slot: 1, action: 'start' });
    assert.equal(r.body.cooldowns['CHAOS:7:1'].total, 360, 'index 7 : le 3e joueur de l\'équipe rouge (les rouges sont numérotés de 5 à 9)');
    r = await act({ team: 'ORDER', index: 0, slot: 0, action: 'start' });
    assert.equal(r.body.cooldowns['ORDER:0:0'].total, 254, 'le chrono suivant tient compte de la Perspicacité');
    r = await act({ team: 'ORDER', index: 0, action: 'cosmic', on: false });
    assert.deepEqual(r.body.cosmic, {});

    r = await act({ team: 'CHAOS', index: 7, slot: 1, action: 'clear' });
    assert.equal(r.body.cooldowns['CHAOS:7:1'], undefined);
    assert.ok(r.body.cooldowns['ORDER:0:0']);
    r = await act({ action: 'clearAll' });
    assert.deepEqual(r.body.cooldowns, {});
  });
});

test('chronos des sorts : demandes invalides et garde-fou', async () => {
  await withServer(async ({ base, post }) => {
    const status = async (body) => (await post('/api/cooldown', body)).status;
    assert.equal(await status({ team: 'ORDER', index: 99, slot: 0, action: 'start' }), 400, 'joueur inconnu');
    assert.equal(await status({ team: 'milieu', index: 0, slot: 0, action: 'start' }), 400, 'équipe inconnue');
    assert.equal(await status({ team: 'ORDER', index: 0, slot: 2, action: 'start' }), 400, 'il n\'y a que deux sorts');
    assert.equal(await status({ team: 'ORDER', index: 0, slot: 0, action: 'danser' }), 400, 'action inconnue');
    assert.equal(await status({ team: 'ORDER', index: 0, slot: 0, action: 'add', seconds: 10 }), 409, 'pas de chrono à corriger');
    const foreign = await post('/api/cooldown', { team: 'ORDER', index: 0, slot: 0, action: 'start' }, { Origin: 'https://site-quelconque.example' });
    assert.equal(foreign.status, 403, 'une page étrangère ne peut pas lancer de chrono');
    const plain = await fetch(base + '/api/cooldown', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(plain.status, 403);
  });
});

test('page de chargement : désactivable depuis les réglages d\'affichage', async () => {
  await withServer(async ({ state, post }) => {
    assert.deepEqual((await state()).loading, { visible: false }, 'rien à charger pendant une partie');
    await post('/api/config', { display: { loadscreen: false } });
    assert.equal((await state()).config.display.loadscreen, false);
    await post('/api/config', { display: { loadscreen: true } });
    assert.equal((await state()).config.display.loadscreen, true);
  });
});

test('démo complète : sélection → page de chargement avec les postes → partie, dans cet ordre', async () => {
  const srv = await startServer(['--demo', '--full', '--speed=600', '--loading=3']);
  try {
    const seen = [];
    let sample = null;
    let later = null;
    for (let i = 0; i < 400; i++) {
      let s;
      try {
        s = await srv.state();
      } catch (_) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const phase = s.game ? 'partie' : s.loading.visible ? 'chargement' : s.draft.live ? 'sélection' : 'autre';
      if (seen[seen.length - 1] !== phase) seen.push(phase);
      if (phase === 'chargement' && !sample) sample = s.loading;
      if (phase === 'chargement' && sample && !later && s.loading.elapsedMs > sample.elapsedMs + 600) later = s.loading;
      if (phase === 'partie') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(seen.filter((p) => p !== 'autre'), ['sélection', 'chargement', 'partie']);
    assert.equal(sample.data.step, 'finalization', 'le chargement prend la suite d\'une sélection menée à son terme');
    const roles = (side) => sample.data.teams[side].picks.map((p) => p.position);
    assert.deepEqual(roles('ORDER'), ['Top', 'Jungle', 'Mid', 'ADC', 'Support']);
    assert.deepEqual(roles('CHAOS'), ['Top', 'Jungle', 'Mid', 'ADC', 'Support']);
    assert.ok(sample.data.teams.ORDER.picks.every((p) => p.player && p.key), 'chaque joueur a son pseudo et son champion');
    assert.ok(later && later.elapsedMs > sample.elapsedMs, 'le temps de chargement avance');
    assert.equal((await srv.state()).loading.visible, false, 'plus de chargement une fois la partie là');
  } finally {
    srv.stop();
  }
});

/* Une image de l'écran du jeu telle que le panneau l'enverrait : luminance de chacune des 20 icônes. */
function spellFrame(game, order, dark = []) {
  const icons = {};
  for (const team of ['ORDER', 'CHAOS']) {
    const rows = order === 'role' ? game.teams[team].players : [...game.teams[team].players].sort((a, b) => a.index - b.index);
    rows.slice(0, 5).forEach((p, row) => p.spells.forEach((sp, slot) => {
      const id = `${team}:${row}:${slot}`;
      icons[id] = { l: (EXPECTED_LUM[sp.key] || 0.5) * 0.9 * (dark.includes(id) ? 0.35 : 1) };
    }));
  }
  return { icons };
}

test('lecture automatique des sorts : un sort sombre lance son chrono, son retour l\'arrête et en apprend la durée', async () => {
  await withServer(async ({ state, post }) => {
    const first = await state();
    const players = [...first.game.teams.ORDER.players].sort((a, b) => a.index - b.index);
    const smite = players.findIndex((p) => p.spells[1] && p.spells[1].key === 'SummonerSmite'); // le chasseur : rang du Châtiment
    assert.ok(smite >= 0, 'la démo a un Châtiment côté bleu');
    const id = `ORDER:${smite}:1`;
    const key = `ORDER:${players[smite].index}:1`;
    const send = async (dark) => (await post('/api/spells/frame', spellFrame((await state()).game, 'game', dark))).json();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    let r = await send([]);
    assert.equal(r.valid, true);
    assert.equal(r.view[id].state, 'ready');
    await send([]);
    assert.deepEqual((await state()).cooldowns, {}, 'aucun chrono tant que rien ne bouge');
    assert.equal((await state()).autoSpells.active, true);

    // Le Châtiment s'assombrit : chrono de 90 s, posé par la lecture.
    await send([id]);
    r = await send([id]);
    assert.equal(r.view[id].state, 'cooldown');
    let s = await state();
    assert.equal(s.cooldowns[key].total, 90);
    assert.equal(s.cooldowns[key].auto, true);
    assert.ok(s.cooldowns[key].endAt > s.game.gameTime + 60, 'la fin est à une heure de jeu future');

    // Il redevient clair après quelques secondes de jeu (démo ×30) : le chrono s'arrête, la durée vue est retenue.
    await wait(900);
    await send([]);
    r = await send([]);
    assert.equal(r.view[id].state, 'ready');
    s = await state();
    assert.equal(s.cooldowns[key], undefined, 'le chrono est arrêté');
    assert.ok(s.spellTotals[key] >= 5 && s.spellTotals[key] < 90, 'la durée prévue est maintenant celle qu\'on a vue : ' + s.spellTotals[key]);
    const seen = s.spellTotals[key];

    // La fois suivante, le chrono part avec cette durée.
    await send([id]);
    await send([id]);
    s = await state();
    assert.equal(s.cooldowns[key].total, seen);
  }, ['--demo', '--speed=30', '--start=900']);
});

test('lecture automatique des sorts : images refusées, pas de partie, réglages bornés', async () => {
  await withServer(async ({ state, post }) => {
    const game = (await state()).game;
    // L'interface disparaît de l'écran (six sorts sombres d'un coup) : rien n'est lancé.
    await post('/api/spells/frame', spellFrame(game, 'game'));
    await post('/api/spells/frame', spellFrame(game, 'game'));
    // (Les joueurs morts sont ignorés par la lecture : on prend six icônes de joueurs vivants.)
    const alive = [];
    for (const team of ['ORDER', 'CHAOS']) {
      [...game.teams[team].players].sort((a, b) => a.index - b.index).slice(0, 5).forEach((p, row) => {
        if (!p.isDead) p.spells.forEach((_, slot) => alive.push(`${team}:${row}:${slot}`));
      });
    }
    assert.ok(alive.length >= 8, 'la démo a assez de joueurs vivants');
    const dark = alive.slice(0, 6);
    let r = await (await post('/api/spells/frame', spellFrame(game, 'game', dark))).json();
    r = await (await post('/api/spells/frame', spellFrame(game, 'game', dark))).json();
    assert.equal(r.valid, false);
    assert.deepEqual((await state()).cooldowns, {});

    // Corps absurdes : pas de plantage.
    for (const body of [{}, { icons: 'x' }, { icons: { 'ORDER:0:0': { l: 'abc' } } }, { icons: { 'ORDER:0:0': null } }]) {
      const res = await post('/api/spells/frame', body);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).valid, false);
    }

    // Réglages : positions, ordre, sensibilité bornés.
    await post('/api/config', { spellsAuto: { layout: { ORDER: { x: 7, pitch: 'abc' } }, order: 'role', threshold: 5 } });
    const a = (await state()).config.spellsAuto;
    assert.equal(a.layout.ORDER.x, 1);
    assert.equal(a.layout.ORDER.pitch, DEFAULT_LAYOUT.ORDER.pitch);
    assert.deepEqual(a.layout.CHAOS, DEFAULT_LAYOUT.CHAOS);
    assert.equal(a.order, 'role');
    assert.equal(a.threshold, 0.85);
    await post('/api/config', { spellsAuto: { order: 'n\'importe quoi', threshold: 'x' } });
    const b = (await state()).config.spellsAuto;
    assert.equal(b.order, 'role');
    assert.equal(b.threshold, 0.85);
    await post('/api/config', { spellsAuto: { resetLayout: true } });
    assert.deepEqual((await state()).config.spellsAuto.layout, DEFAULT_LAYOUT, 'positions d\'origine');

    // Garde-fou : une page d'un autre site ne peut pas envoyer d'images.
    const bad = await post('/api/spells/frame', spellFrame(game, 'game'), { Origin: 'https://exemple.org' });
    assert.equal(bad.status, 403);
  });
});

test('lecture automatique des sorts : sans partie en cours, l\'image est ignorée', async () => {
  const srv = await startServer([]);
  try {
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      try {
        await srv.state();
        ok = true;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    assert.ok(ok, 'le serveur a démarré');
    const res = await srv.post('/api/spells/frame', { icons: { 'ORDER:0:0': { l: 0.5 } } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.valid, false);
    assert.match(body.reason, /partie/);
    assert.equal((await srv.state()).autoSpells.valid, false);
  } finally {
    srv.stop();
  }
});
