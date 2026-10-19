'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickCaptureSource } = require('../app/capture.js');

const src = (id, name) => ({ id, name });

test('la fenêtre de la partie passe avant tout le reste', () => {
  const picked = pickCaptureSource([
    src('screen:0:0', 'Écran 1'),
    src('window:11:0', 'League of Legends'),
    src('window:22:0', 'League of Legends (TM) Client'),
    src('window:33:0', 'OBS 30.2'),
  ]);
  assert.equal(picked.id, 'window:22:0');
});

test('sans partie, on prend la fenêtre du client', () => {
  const picked = pickCaptureSource([src('screen:0:0', 'Écran 1'), src('window:11:0', 'League of Legends'), src('window:33:0', 'Bloc-notes')]);
  assert.equal(picked.id, 'window:11:0');
});

test('sans le jeu, on prend le premier écran, jamais une fenêtre au hasard', () => {
  const picked = pickCaptureSource([src('window:33:0', 'Bloc-notes'), src('window:44:0', 'Overlay · LoL'), src('screen:1:0', 'Écran 2'), src('screen:0:0', 'Écran 1')]);
  assert.equal(picked.id, 'screen:1:0');
});

test('un titre qui ne fait que contenir le nom du jeu n\'est pas pris pour le jeu', () => {
  const picked = pickCaptureSource([src('window:1:0', 'Guide League of Legends - Navigateur'), src('screen:0:0', 'Écran 1')]);
  assert.equal(picked.id, 'screen:0:0');
});

test('rien à partager : null', () => {
  assert.equal(pickCaptureSource([]), null);
  assert.equal(pickCaptureSource(null), null);
  assert.equal(pickCaptureSource([null, { name: 'sans id' }]), null);
});
