'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Drafter, STANDARD_PLAN, cleanRoster } = require('../lib/drafter.js');
const { normalizeDraft, endedIntoGame } = require('../lib/draft.js');

const NAMES = ['Aatrox', 'Ahri', 'Akali', 'Alistar', 'Ashe', 'Bard', 'Blitzcrank', 'Braum', 'Caitlyn', 'Camille', 'Darius', 'Draven', 'Ezreal', 'Fiora', 'Gragas', 'Graves', 'Jhin', 'Jinx', 'Kalista', 'Karma', 'Leona', 'Lulu', 'Lux', 'Nautilus', 'Orianna', 'Renekton', 'Thresh', 'Viego', 'Yone', 'Zed'];
const CHAMPIONS = NAMES.map((name, i) => ({ id: i + 1, key: name, name }));
const CHAMPS_INDEX = new Map(CHAMPIONS.map((c) => [c.id, { key: c.key, name: c.name }]));
const ROSTER = { ORDER: ['Kestrel', 'Brumelot', 'Oriane', 'Vexis', 'Tidou'], CHAOS: ['Morrow', 'Sable', 'Nyx Arden', 'Pilou', 'Garance'] };

const make = (extra = {}) => new Drafter({ champions: CHAMPIONS, roster: ROSTER, turnSeconds: 30, ...extra });
const shown = (d, now) => normalizeDraft(d.snapshot(now), CHAMPS_INDEX);

/* Joue tout le draft : chaque tour verrouille le champion suivant de la liste. */
function playAll(d, now = 0) {
  d.start(now);
  let next = 1;
  while (d.status === 'running') {
    const r = d.lock(d.active().side, next++, undefined, now);
    assert.ok(r.ok, r.error);
  }
}

test('avant le début : salon d\'attente, sans décompte', () => {
  const d = make();
  assert.equal(d.status, 'lobby');
  assert.equal(d.active(), null);
  const s = shown(d, 1000);
  assert.equal(s.step, 'planning');
  assert.equal(s.timer.infinite, true);
  assert.equal(s.teams.ORDER.picks.length, 5);
  assert.deepEqual(s.teams.ORDER.picks.map((p) => p.player), ROSTER.ORDER);
  assert.deepEqual(s.teams.CHAOS.picks.map((p) => p.position), ['Top', 'Jungle', 'Mid', 'ADC', 'Support']);
  assert.equal(d.hoverChampion('ORDER', 1, undefined).ok, false, 'rien ne se joue avant le début');
  assert.equal(d.lock('ORDER', 1, undefined, 0).ok, false);
});

test('le draft démarre une fois, le chrono se lance, c\'est à l\'équipe bleue de bannir', () => {
  const d = make();
  assert.equal(d.start(5000).ok, true);
  assert.equal(d.start(5000).ok, false, 'déjà lancé');
  assert.equal(d.status, 'running');
  assert.deepEqual({ type: d.active().type, side: d.active().side }, { type: 'ban', side: 'ORDER' });
  assert.equal(d.timeLeft(5000), 30000);
  assert.equal(d.timeLeft(12000), 23000);
  const s = shown(d, 12000);
  assert.equal(s.step, 'ban');
  assert.deepEqual(s.active, ['ORDER']);
  assert.equal(s.timer.leftMs, 23000);
  assert.equal(s.timer.infinite, false);
});

test('seule l\'équipe qui joue peut survoler et verrouiller, et seulement un champion libre', () => {
  const d = make();
  d.start(0);
  assert.equal(d.hoverChampion('CHAOS', 5, undefined).error, 'Ce n\'est pas à votre équipe de jouer.');
  assert.equal(d.lock('CHAOS', 5, undefined, 0).ok, false);
  assert.equal(d.hoverChampion('ORDER', 999, undefined).ok, false, 'champion inconnu');
  assert.equal(d.lock('ORDER', 0, undefined, 0).error, 'Choisissez d\'abord un champion.');
  assert.equal(d.hoverChampion('ORDER', 5, undefined).ok, true);
  assert.equal(d.lock('ORDER', 0, undefined, 1000).ok, true, 'sans champion donné, le survolé est verrouillé');
  assert.equal(d.isAvailable(5), false);
  assert.equal(d.turn, 1);
  assert.equal(d.timeLeft(1000), 30000, 'le chrono repart à zéro à chaque tour');
  assert.equal(d.hover.championId, 0, 'le survol est effacé');
  // Le champion banni n'est plus disponible pour personne.
  assert.equal(d.hoverChampion('CHAOS', 5, undefined).ok, false);
  assert.equal(d.lock('CHAOS', 5, undefined, 1000).error, 'Ce champion n\'est pas disponible.');
});

test('un draft complet : 20 tours, picks aux postes dans l\'ordre, vu comme une vraie sélection', () => {
  const d = make();
  playAll(d, 0);
  assert.equal(d.status, 'finished');
  assert.equal(d.actions.filter((a) => a.done).length, 20);
  assert.equal(d.usedIds().size, 20);
  const s = shown(d, 0);
  assert.equal(s.step, 'finalization');
  assert.equal(endedIntoGame(s), true, 'une fois fini, la page de chargement peut prendre la suite');
  assert.equal(s.teams.ORDER.bans.filter((b) => b.state === 'done').length, 5);
  assert.equal(s.teams.CHAOS.bans.filter((b) => b.state === 'done').length, 5);
  for (const side of ['ORDER', 'CHAOS']) {
    assert.ok(s.teams[side].picks.every((p) => p.state === 'locked' && p.name), side);
    assert.deepEqual(s.teams[side].picks.map((p) => p.player), ROSTER[side]);
  }
  // L'ordre des tours est celui d'un draft de tournoi : les picks 7 à 12 sont le bleu, rouge, rouge, bleu, bleu, rouge.
  assert.deepEqual(d.actions.slice(6, 12).map((a) => a.side), ['ORDER', 'CHAOS', 'CHAOS', 'ORDER', 'ORDER', 'CHAOS']);
  assert.equal(d.active(), null);
  assert.equal(d.lock('ORDER', 29, undefined, 0).ok, false, 'plus rien à jouer');
});

test('chaque pick peut viser un poste ; un poste déjà pris est refusé', () => {
  const d = make();
  d.start(0);
  for (let i = 0; i < 6; i++) assert.ok(d.lock(d.active().side, i + 1, undefined, 0).ok); // les 6 premiers bans
  assert.equal(d.active().type, 'pick');
  assert.equal(d.active().side, 'ORDER');
  assert.ok(d.lock('ORDER', 10, 3, 0).ok, 'le premier pick bleu va à l\'ADC');
  assert.equal(d.freeSlots('ORDER').join(), '0,1,2,4');
  assert.ok(d.lock('CHAOS', 11, undefined, 0).ok, 'sans poste : le premier poste libre');
  const slotOf = (id) => d.actions.find((a) => a.championId === id).slot;
  assert.equal(slotOf(10), 3);
  assert.equal(slotOf(11), 0);
  // Au pick suivant de l'équipe rouge, le poste 0 est pris.
  const refused = d.lock('CHAOS', 13, 0, 0);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Ce poste a déjà son champion.');
  const s = shown(d, 0);
  assert.equal(s.teams.ORDER.picks[3].name, NAMES[9], 'le champion est dans la colonne de l\'ADC');
  assert.equal(s.teams.ORDER.picks[3].position, 'ADC');
  assert.equal(s.teams.CHAOS.picks[0].name, NAMES[10]);
});

test('le survol d\'un pick apparaît sur le poste visé dans l\'overlay', () => {
  const d = make();
  d.start(0);
  for (let i = 0; i < 6; i++) d.lock(d.active().side, i + 1, undefined, 0);
  assert.equal(d.hoverChampion('ORDER', 20, 2).ok, true);
  const s = shown(d, 0);
  const pick = s.teams.ORDER.picks[2];
  assert.equal(pick.name, NAMES[19], 'le champion survolé s\'affiche');
  assert.equal(pick.state, 'active');
  assert.equal(pick.position, 'Mid');
  assert.equal(s.teams.ORDER.picks.filter((p) => p.name).length, 1, 'un seul poste est concerné');
  assert.equal(d.view(0).hover.slot, 2);
  assert.equal(d.hoverChampion('ORDER', 0, undefined).ok, true);
  assert.equal(shown(d, 0).teams.ORDER.picks.filter((p) => p.name).length, 0, 'plus de survol');
  // Verrouiller sans poste donné reprend le poste survolé.
  d.hoverChampion('ORDER', 21, 4);
  d.lock('ORDER', 0, undefined, 0);
  assert.equal(shown(d, 0).teams.ORDER.picks[4].name, NAMES[20]);
});

test('pause et reprise : le chrono se fige, rien ne se joue, l\'overlay n\'affiche plus de décompte', () => {
  const d = make();
  d.start(0);
  assert.equal(d.pause(10000).ok, true);
  assert.equal(d.timeLeft(10000), 20000);
  assert.equal(d.timeLeft(500000), 20000, 'en pause, le temps ne bouge plus');
  assert.equal(d.hoverChampion('ORDER', 1, undefined).error, 'Le draft est en pause.');
  assert.equal(d.lock('ORDER', 1, undefined, 0).ok, false);
  assert.equal(d.tick(900000), false, 'pas de fin de tour en pause');
  assert.equal(shown(d, 500000).timer.infinite, true);
  assert.equal(d.resume(100000).ok, true);
  assert.equal(d.timeLeft(100000), 20000);
  assert.equal(d.timeLeft(105000), 15000);
  assert.equal(d.pause(1).ok, true);
  assert.equal(d.pause(1).ok, false);
});

test('chrono à zéro : le survol est verrouillé, un ban est passé, un pick est tiré au sort', () => {
  const d = make({ rand: () => 0 });
  d.start(0);
  assert.equal(d.tick(29999), false);
  // Ban sans survol : passé, personne n'est banni.
  assert.equal(d.tick(30000), true);
  assert.equal(d.actions[0].done && d.actions[0].skipped, true);
  assert.equal(d.usedIds().size, 0);
  assert.equal(shown(d, 30000).teams.ORDER.bans[0].state, 'none');
  // Ban avec survol : le champion survolé est banni.
  d.hoverChampion('CHAOS', 7, undefined);
  assert.equal(d.tick(60000), true);
  assert.equal(d.actions[1].championId, 7);
  // Jusqu'aux picks.
  let now = 60000;
  while (d.active().type === 'ban') {
    now += 30000;
    d.tick(now);
  }
  // Pick sans survol : tiré au sort parmi les champions libres (rand = 0 → le premier libre).
  now += 30000;
  assert.equal(d.tick(now), true);
  const pick = d.actions.find((a) => a.type === 'pick' && a.done);
  assert.equal(pick.championId, 1, 'Aatrox, le premier champion encore libre');
  assert.equal(pick.slot, 0);
  // Pick avec survol et poste : verrouillé tel quel.
  d.hoverChampion(d.active().side, 9, 2);
  now += 30000;
  d.tick(now);
  const second = d.actions.find((a) => a.championId === 9);
  assert.equal(second.slot, 2);
});

test('passer un ban : seulement un ban', () => {
  const d = make();
  d.start(0);
  assert.equal(d.skip(0).ok, true);
  assert.equal(d.turn, 1);
  for (let i = 0; i < 5; i++) d.lock(d.active().side, i + 1, undefined, 0);
  assert.equal(d.active().type, 'pick');
  assert.equal(d.skip(0).error, 'Seul un ban peut être passé.');
});

test('annuler : le dernier champion redevient libre et le tour recommence', () => {
  const d = make();
  assert.equal(d.undo(0).ok, false, 'rien à annuler dans le salon');
  d.start(0);
  assert.equal(d.undo(0).ok, false, 'ni au premier tour');
  d.lock('ORDER', 4, undefined, 1000);
  d.lock('CHAOS', 5, undefined, 2000);
  assert.equal(d.turn, 2);
  assert.equal(d.undo(9000).ok, true);
  assert.equal(d.turn, 1);
  assert.equal(d.isAvailable(5), true);
  assert.equal(d.isAvailable(4), false, 'le tour d\'avant n\'est pas touché');
  assert.equal(d.timeLeft(9000), 30000);
  assert.equal(d.active().side, 'CHAOS');

  // Après la fin : on revient au dernier tour, et le draft reprend.
  const done = make();
  playAll(done, 0);
  assert.equal(done.status, 'finished');
  const last = done.actions[19].championId;
  assert.equal(done.undo(1000).ok, true);
  assert.equal(done.status, 'running');
  assert.equal(done.turn, 19);
  assert.equal(done.isAvailable(last), true);
  assert.equal(shown(done, 1000).step, 'pick');
});

test('la vue des joueurs : tout ce qu\'il faut, rien de secret', () => {
  const d = make({ turnSeconds: 45 });
  d.start(0);
  d.lock('ORDER', 3, undefined, 0);
  const v = d.view(10000);
  assert.equal(v.status, 'running');
  assert.equal(v.turnSeconds, 45);
  assert.deepEqual(v.active, { id: 1, type: 'ban', side: 'CHAOS' });
  assert.deepEqual(v.used, [3]);
  assert.equal(v.timer.leftMs, 35000);
  assert.equal(v.actions.length, 20);
  assert.deepEqual(v.roster.CHAOS, ROSTER.CHAOS);
  assert.deepEqual(v.positions, ['Top', 'Jungle', 'Mid', 'ADC', 'Support']);
  assert.deepEqual(d.championList().map((c) => c.name).slice(0, 3), ['Aatrox', 'Ahri', 'Akali']);
  assert.equal(JSON.stringify(v).includes('rand'), false);
});

test('réglages : pseudos nettoyés, durée de tour bornée, champions invalides ignorés', () => {
  assert.deepEqual(cleanRoster([' Kestrel ', 'x'.repeat(40), null]), ['Kestrel', 'x'.repeat(24), '', '', '']);
  assert.deepEqual(cleanRoster(undefined), ['', '', '', '', '']);
  assert.equal(make({ turnSeconds: 1 }).turnMs, 5000);
  assert.equal(make({ turnSeconds: 9999 }).turnMs, 300000);
  assert.equal(make({ turnSeconds: 'texte' }).turnMs, 30000);
  const d = new Drafter({ champions: [{ id: 1, key: 'A', name: 'A' }, { id: 'x', key: 'B' }, { id: 0, key: 'C' }, { id: 2 }, null].filter(Boolean), roster: {} });
  assert.deepEqual([...d.champions.keys()], [1]);
  assert.equal(STANDARD_PLAN.length, 20);
  assert.equal(STANDARD_PLAN.filter(([type]) => type === 'ban').length, 10);
});
