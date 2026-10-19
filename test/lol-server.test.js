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

const ROOT = path.join(__dirname, '..');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function withServer(fn) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-test-'));
  const child = spawn(process.execPath, ['server.js', '--demo', '--speed=1', '--start=900'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), OVERLAY_DATA_DIR: dir, NO_LCU: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const state = () => fetch(base + '/api/state').then((r) => r.json());
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    // La partie de démonstration apparaît à la première lecture, au bout d'une seconde environ.
    let s = null;
    for (let i = 0; i < 80; i++) {
      try {
        s = await state();
        if (s.game) break;
      } catch (_) {
        /* le serveur démarre */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(s && s.game, 'la partie de démonstration n\'est pas apparue');
    await fn({ base, state, post });
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('réglages d\'affichage : colonnes des côtés et cadre de la minimap', async () => {
  await withServer(async ({ state, post }) => {
    let d = (await state()).config.display;
    assert.equal(d.sides, true);
    assert.equal(d.mapFrame, true);
    assert.equal(d.mapSize, 280);

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
