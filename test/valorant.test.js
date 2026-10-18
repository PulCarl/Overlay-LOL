'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../lib/valorant/match.js');
const catalog = require('../lib/valorant/catalog.js');

const fresh = () => V.defaultMatch();

test('un match neuf est complet : 2 équipes de 5 joueurs, aucune map, chrono à l\'arrêt', () => {
  const m = fresh();
  assert.equal(m.players.left.length, 5);
  assert.equal(m.players.right.length, 5);
  assert.deepEqual(m.round, { number: 1, left: 0, right: 0, phase: 'buy' });
  assert.equal(m.timer.running, false);
  assert.deepEqual(m.maps, []);
  assert.equal(m.endScreen.visible, false);
});

test('les modifications du panneau sont vérifiées et bornées', () => {
  const m = fresh();
  V.applyPatch(m, {
    format: 4, // refusé : ni BO1, ni BO3, ni BO5
    teams: { left: { name: '  Les Vipères  ', tag: 'viper-long', logo: 'javascript:alert(1)', sub: 'x'.repeat(80) } },
    round: { number: 500, left: -3, right: 7.6, phase: 'nimporte' },
    series: { left: 9 },
    display: { scale: 9, scorebar: 0 },
    players: { left: [{ name: 'Nova', agent: 'Jett', kills: 150, credits: 99999 }, null, { alive: false }] },
  });
  assert.equal(m.format, 3);
  assert.equal(m.teams.left.name, 'Les Vipères');
  assert.equal(m.teams.left.tag, 'VIPE');
  assert.equal(m.teams.left.logo, '');
  assert.equal(m.teams.left.sub.length, 24);
  assert.deepEqual(m.round, { number: 99, left: 0, right: 8, phase: 'buy' });
  assert.equal(m.series.left, 5);
  assert.equal(m.display.scale, 1.5);
  assert.equal(m.display.scorebar, false);
  assert.equal(m.players.left[0].kills, 99);
  assert.equal(m.players.left[0].credits, 9000);
  assert.equal(m.players.left[1].name, '');
  assert.equal(m.players.left[2].alive, false);
});

test('le panneau ne peut pas toucher au chrono, à l\'écran de fin ni aux résultats des maps', () => {
  const m = fresh();
  V.applyPatch(m, {
    timer: { total: 5000, remaining: 5000, running: true, endsAt: 1 },
    endScreen: { visible: true, data: { kind: 'map' } },
    maps: [{ name: 'Split', result: { left: 13, right: 0, winner: 'left' } }],
  });
  assert.equal(m.timer.running, false);
  assert.equal(m.endScreen.visible, false);
  assert.equal(m.maps[0].name, 'Split');
  assert.equal(m.maps[0].result, null);
  // Le fichier de réglages, lui, est relu tel quel.
  V.applyPatch(m, { maps: [{ name: 'Split', result: { left: 13, right: 0, winner: 'left' } }], endScreen: { visible: true, data: { kind: 'map' } } }, { trusted: true });
  assert.deepEqual(m.maps[0].result, { left: 13, right: 0, winner: 'left' });
  assert.equal(m.endScreen.visible, true);
});

test('la liste des maps garde les résultats déjà enregistrés et borne l\'index', () => {
  const m = fresh();
  V.applyPatch(m, { maps: [{ name: 'Split' }, { name: 'Lotus' }, { name: 'Haven' }] });
  m.maps[0].result = { left: 13, right: 9, winner: 'left' };
  V.applyPatch(m, { maps: [{ name: 'Bind', pick: 'left' }, { name: 'Lotus', pick: 'décideur' }] });
  assert.equal(m.maps.length, 2);
  assert.equal(m.maps[0].name, 'Bind');
  assert.equal(m.maps[0].pick, 'left');
  assert.equal(m.maps[1].pick, '');
  assert.deepEqual(m.maps[0].result, { left: 13, right: 9, winner: 'left' });
  V.applyPatch(m, { mapIndex: 9 });
  assert.equal(m.mapIndex, 2);
  V.applyPatch(m, { maps: Array.from({ length: 9 }, (_, i) => ({ name: 'M' + i })) });
  assert.equal(m.maps.length, 5);
});

test('une manche gagnée fait monter le score et le numéro, et remet tout le monde en vie', () => {
  const m = fresh();
  m.players.left[1].alive = false;
  m.players.right[3].alive = false;
  V.startPhase(m, 'live', 1000);
  V.roundWon(m, 'right');
  assert.equal(m.round.right, 1);
  assert.equal(m.round.left, 0);
  assert.equal(m.round.number, 2);
  assert.equal(m.round.phase, 'buy');
  assert.ok(m.players.left.concat(m.players.right).every((p) => p.alive));
  assert.equal(m.timer.running, false);
  assert.equal(m.timer.remaining, V.PHASE_SECONDS.buy * 1000);
  V.roundWon(m, 'dessous');
  assert.equal(m.round.number, 2);
});

test('une map se gagne à 13 manches avec 2 d\'avance, prolongations comprises', () => {
  const w = (left, right) => V.mapWinnerOf({ left, right });
  assert.equal(w(13, 0), 'left');
  assert.equal(w(13, 11), 'left');
  assert.equal(w(13, 12), null);
  assert.equal(w(12, 12), null);
  assert.equal(w(13, 13), null);
  assert.equal(w(14, 12), 'left');
  assert.equal(w(13, 15), 'right');
  assert.equal(w(12, 13), null);
});

test('la fin d\'une map enregistre le résultat, fait monter la série et prépare la suivante', () => {
  const m = fresh();
  V.applyPatch(m, {
    maps: [{ name: 'Split' }, { name: 'Lotus' }, { name: 'Haven' }],
    round: { number: 23, left: 13, right: 9 },
    players: { left: [{ name: 'Nova', agent: 'Jett', kills: 20, deaths: 8, assists: 2, credits: 4000, alive: false }] },
  });
  V.endMap(m);

  assert.deepEqual(m.maps[0].result, { left: 13, right: 9, winner: 'left' });
  assert.deepEqual(m.series, { left: 1, right: 0 });
  assert.equal(m.mapIndex, 1);
  assert.deepEqual(m.round, { number: 1, left: 0, right: 0, phase: 'buy' });
  assert.equal(m.players.left[0].name, 'Nova', 'les joueurs restent');
  assert.equal(m.players.left[0].kills, 0, 'les statistiques repartent à zéro');
  assert.equal(m.players.left[0].credits, V.START_CREDITS);
  assert.equal(m.players.left[0].alive, true);

  const end = m.endScreen;
  assert.equal(end.visible, true);
  assert.equal(end.data.kind, 'map');
  assert.equal(end.data.winner, 'left');
  assert.equal(end.data.mapName, 'Split');
  assert.deepEqual(end.data.score, { left: 13, right: 9 });
  assert.equal(end.data.players.left[0].kills, 20, 'l\'écran de fin garde les statistiques de la map');
  assert.deepEqual(end.data.mvp, { side: 'left', index: 0 });
  assert.deepEqual(end.data.maps.map((x) => x.name), ['Split', 'Lotus', 'Haven']);
});

test('gagner la dernière map nécessaire termine le match', () => {
  const m = fresh();
  V.applyPatch(m, { maps: [{ name: 'Split' }, { name: 'Lotus' }, { name: 'Haven' }], round: { left: 4, right: 13 } });
  V.endMap(m);
  assert.equal(m.endScreen.data.kind, 'map');
  assert.deepEqual(m.series, { left: 0, right: 1 });
  assert.equal(V.matchWinner(m), null);
  V.applyPatch(m, { round: { left: 13, right: 3 } });
  V.endMap(m, 'right'); // le gagnant peut aussi être indiqué à la main
  assert.equal(m.endScreen.data.kind, 'match');
  assert.equal(m.endScreen.data.winner, 'right');
  assert.deepEqual(m.series, { left: 0, right: 2 });
  assert.equal(V.matchWinner(m), 'right');
});

test('une égalité sans gagnant indiqué est refusée, de même qu\'une série déjà terminée', () => {
  const m = fresh();
  V.applyPatch(m, { round: { left: 6, right: 6 } });
  assert.throws(() => V.endMap(m), /Égalité/);
  assert.deepEqual(m.series, { left: 0, right: 0 });
  V.endMap(m, 'left');
  assert.equal(m.maps.length, 1, 'une map est créée si la liste était vide');
  assert.equal(m.maps[0].result.winner, 'left');

  const full = fresh();
  V.applyPatch(full, { maps: Array.from({ length: 5 }, (_, i) => ({ name: 'M' + i })), mapIndex: 5, round: { left: 13, right: 0 } });
  assert.throws(() => V.endMap(full), /Toutes les maps/);
});

test('échanger les côtés échange équipes, scores, série, joueurs et résultats', () => {
  const m = fresh();
  V.applyPatch(m, {
    teams: { left: { name: 'Alpha', tag: 'ALP' }, right: { name: 'Omega', tag: 'OME' } },
    series: { left: 1 },
    round: { left: 9, right: 7 },
    maps: [{ name: 'Split', pick: 'left' }],
    players: { left: [{ name: 'Nova' }], right: [{ name: 'Blaze' }] },
  });
  m.maps[0].result = { left: 13, right: 9, winner: 'left' };
  V.swapSides(m);
  assert.equal(m.teams.left.name, 'Omega');
  assert.equal(m.teams.right.tag, 'ALP');
  assert.deepEqual(m.series, { left: 0, right: 1 });
  assert.deepEqual([m.round.left, m.round.right], [7, 9]);
  assert.equal(m.players.left[0].name, 'Blaze');
  assert.equal(m.maps[0].pick, 'right');
  assert.deepEqual(m.maps[0].result, { left: 9, right: 13, winner: 'right' });
  V.swapSides(m);
  assert.equal(m.teams.left.name, 'Alpha');
  assert.deepEqual(m.maps[0].result, { left: 13, right: 9, winner: 'left' });
});

test('le chrono : lancement, pause, reprise et phases', () => {
  const m = fresh();
  V.timerSet(m, 100, true, 10000);
  assert.equal(V.timerRemaining(m, 10000), 100000);
  assert.equal(V.timerRemaining(m, 40000), 70000);
  assert.equal(V.timerRemaining(m, 999999), 0);
  V.timerPause(m, 40000);
  assert.equal(m.timer.running, false);
  assert.equal(V.timerRemaining(m, 500000), 70000, 'à l\'arrêt, le temps ne bouge plus');
  V.timerResume(m, 100000);
  assert.equal(V.timerRemaining(m, 110000), 60000);
  V.timerReset(m);
  assert.equal(V.timerRemaining(m, 1), 100000);

  V.startPhase(m, 'planted', 5000);
  assert.equal(m.round.phase, 'planted');
  assert.equal(V.timerRemaining(m, 5000), 45000);
  V.startPhase(m, 'over', 15000);
  assert.equal(m.round.phase, 'over');
  assert.equal(m.timer.running, false);
  assert.equal(V.timerRemaining(m, 99999), 35000);
  V.startPhase(m, 'nimporte', 0);
  assert.equal(m.round.phase, 'over');
});

test('un chrono resté en marche dans le fichier de réglages est arrêté au chargement', () => {
  const m = fresh();
  V.applyPatch(m, { timer: { total: 100000, remaining: 100000, endsAt: 50000, running: true } }, { trusted: true });
  V.normalize(m, 20000);
  assert.equal(m.timer.running, false);
  assert.equal(m.timer.remaining, 30000);
  V.applyPatch(m, { timer: { total: 100000, remaining: 100000, endsAt: 10000, running: true } }, { trusted: true });
  V.normalize(m, 20000);
  assert.equal(m.timer.remaining, 0);
});

test('annuler revient à l\'état d\'avant l\'action, sans toucher aux presets', () => {
  const m = fresh();
  const history = [];
  V.remember(history, m);
  V.roundWon(m, 'left');
  m.presets.push({ id: 'abc', name: 'Alpha', tag: 'ALP', sub: '', logo: '' });
  assert.equal(m.round.left, 1);
  assert.equal(V.undo(history, m), true);
  assert.equal(m.round.left, 0);
  assert.equal(m.round.number, 1);
  assert.equal(m.presets.length, 1);
  assert.equal(V.undo(history, m), false);
  for (let i = 0; i < 30; i++) V.remember(history, m);
  assert.equal(history.length, 20);
});

test('le meilleur joueur : kills, puis assists, puis moins de morts, dans l\'équipe gagnante', () => {
  const m = fresh();
  V.applyPatch(m, {
    players: {
      left: [{ name: 'A', kills: 10, deaths: 5, assists: 1 }, { name: 'B', kills: 10, deaths: 3, assists: 1 }, { name: 'C', kills: 10, deaths: 9, assists: 4 }],
      right: [{ name: 'D', kills: 25, deaths: 5, assists: 0 }],
    },
  });
  assert.deepEqual(V.computeMvp(m.players, 'left'), { side: 'left', index: 2 });
  assert.deepEqual(V.computeMvp(m.players, 'right'), { side: 'right', index: 0 });
  assert.deepEqual(V.computeMvp(m.players, null), { side: 'right', index: 0 });
  assert.equal(V.computeMvp(fresh().players, 'left'), null, 'sans statistiques, pas de MVP');
});

test('l\'écran de fin sans résultat montre un aperçu de la map en cours', () => {
  const m = fresh();
  V.applyPatch(m, { maps: [{ name: 'Split' }], round: { left: 5, right: 3 } });
  V.showEndScreen(m, true);
  assert.equal(m.endScreen.visible, true);
  assert.equal(m.endScreen.data.kind, 'preview');
  assert.equal(m.endScreen.data.winner, 'left');
  V.showEndScreen(m, false);
  assert.equal(m.endScreen.visible, false);
  V.applyPatch(m, { round: { left: 5, right: 8 } });
  V.showEndScreen(m, true);
  assert.equal(m.endScreen.data.winner, 'right', 'l\'aperçu est refait avec le score actuel');
});

test('l\'état envoyé aux pages porte l\'heure du serveur et les valeurs calculées', () => {
  const m = fresh();
  V.applyPatch(m, { format: 5, round: { left: 13, right: 4 } });
  const s = V.publicState(m, 123456);
  assert.equal(s.now, 123456);
  assert.deepEqual(s.derived, { need: 3, mapHint: 'left', matchWinner: null });
  s.teams.left.name = 'modifié';
  assert.notEqual(m.teams.left.name, 'modifié', 'l\'état envoyé est une copie');
});

test('l\'exemple est cohérent : deux équipes complètes, série en cours, chrono en marche', () => {
  const m = V.demoMatch(1000);
  assert.equal(m.players.left.length, 5);
  assert.ok(m.players.left.concat(m.players.right).every((p) => p.name && p.agent));
  assert.equal(m.maps[0].result.winner, 'left');
  assert.equal(m.mapIndex, 1);
  assert.equal(m.timer.running, true);
  assert.equal(V.timerRemaining(m, 1000), 93000);
  const names = new Set(catalog.AGENTS.map((a) => a.name));
  assert.ok(m.players.left.concat(m.players.right).every((p) => names.has(p.agent)), 'chaque agent de l\'exemple existe dans le catalogue');
  const maps = new Set(catalog.MAPS.map((x) => x.name));
  assert.ok(m.maps.every((x) => maps.has(x.name)));
});

test('le catalogue embarqué : agents et maps uniques, avec leurs adresses d\'images', () => {
  const ids = catalog.AGENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(catalog.AGENTS.length >= 25);
  assert.ok(catalog.MAPS.length >= 10);
  const pub = catalog.publicCatalog();
  assert.match(pub.agents[0].icon, /^https:\/\/media\.valorant-api\.com\/agents\/[0-9a-f-]{36}\/killfeedportrait\.png$/);
  assert.match(pub.maps[0].thumb, /^https:\/\/media\.valorant-api\.com\/maps\/[0-9a-f-]{36}\/listviewicon\.png$/);
});

test('un preset est nettoyé', () => {
  assert.deepEqual(V.cleanPreset({ id: 'a b/c', name: ' Alpha ', tag: 'alp', sub: 'AMER', logo: 'https://exemple.fr/l.png' }), { id: 'abc', name: 'Alpha', tag: 'ALP', sub: 'AMER', logo: 'https://exemple.fr/l.png' });
  assert.equal(V.cleanPreset({ name: 'sans id' }), null);
  assert.equal(V.cleanPreset('x'), null);
});
