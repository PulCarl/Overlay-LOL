'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const games = require('../app/games.js');

test('chaque jeu a un identifiant unique et un statut connu', () => {
  const ids = games.GAMES.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const g of games.GAMES) {
    assert.match(g.id, /^[a-z]+$/);
    assert.ok(g.name && g.short && g.tagline && g.title, `champs manquants pour ${g.id}`);
    assert.ok(['ready', 'soon'].includes(g.status), `statut inconnu pour ${g.id}`);
    assert.ok(['violet', 'rouge'].includes(g.accent), `accent inconnu pour ${g.id}`);
  }
});

test('un jeu prêt sait démarrer, un jeu à venir non', () => {
  for (const g of games.GAMES) {
    assert.equal(typeof g.start === 'function', g.status === 'ready', g.id);
  }
});

test('LoL et Valorant sont proposés, LoL est prêt', () => {
  assert.equal(games.find('lol').status, 'ready');
  assert.equal(games.find('valorant').status, 'soon');
  assert.equal(games.find('nimporte-quoi'), null);
});

test('la liste envoyée à la page ne contient pas de fonctions', () => {
  for (const g of games.publicList()) {
    for (const value of Object.values(g)) assert.notEqual(typeof value, 'function');
    assert.deepEqual(Object.keys(g).sort(), ['accent', 'id', 'name', 'short', 'status', 'tagline']);
  }
});

test('un jeu inconnu ou pas encore disponible ne démarre pas', async () => {
  await assert.rejects(games.launch('nimporte-quoi'), /inconnu/);
  await assert.rejects(games.launch('valorant'), /pas encore disponible/);
  assert.equal(games.anyRunning(), false);
});

test('le dernier jeu utilisé est retenu, et seulement s\'il est valide', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  try {
    assert.equal(games.loadLast(dir), null);
    games.saveLast(dir, 'lol');
    assert.equal(games.loadLast(dir), 'lol');
    games.saveLast(dir, 'valorant'); // pas encore disponible : on ne le propose pas comme « dernier utilisé »
    assert.equal(games.loadLast(dir), null);
    fs.writeFileSync(path.join(dir, 'launcher.json'), '{ pas du json');
    assert.equal(games.loadLast(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
