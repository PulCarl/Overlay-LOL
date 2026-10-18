'use strict';

// Tests de l'analyse de la sélection des champions : « npm test » (lanceur intégré à Node.js, aucune dépendance).
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDraft, indexFromDdragon, indexFromClientSummary } = require('../lib/draft');
const { DemoDraft, DEMO_CHAMPS } = require('../lib/demo-draft');
const { parseLockfile, parseCommandLine } = require('../lib/lcu');

const CHAMPS = new Map([
  [266, { key: 'Aatrox', name: 'Aatrox' }],
  [103, { key: 'Ahri', name: 'Ahri' }],
  [64, { key: 'LeeSin', name: 'Lee Sin' }],
  [222, { key: 'Jinx', name: 'Jinx' }],
  [412, { key: 'Thresh', name: 'Thresh' }],
]);

const cell = (cellId, team, extra = {}) => ({ cellId, team, championId: 0, championPickIntent: 0, assignedPosition: '', gameName: `J${cellId}`, nameVisibilityType: 'VISIBLE', ...extra });

/* Session au format du client : bans en cours côté rouge, Aatrox verrouillé par le joueur 0, Ahri survolée par le joueur 1. */
function session(extra = {}) {
  return {
    gameId: 7,
    isSpectating: false,
    isCustomGame: false,
    localPlayerCellId: 0,
    myTeam: [cell(0, 1, { assignedPosition: 'top', championId: 266 }), cell(1, 1, { assignedPosition: 'jungle', championPickIntent: 103 })],
    theirTeam: [cell(5, 2, { assignedPosition: 'top' }), cell(6, 2, { assignedPosition: 'jungle', nameVisibilityType: 'HIDDEN' })],
    actions: [
      [{ id: 0, actorCellId: 0, type: 'ban', championId: 64, completed: true, isInProgress: false, isAllyAction: true }],
      [{ id: 1, actorCellId: 5, type: 'ban', championId: 0, completed: false, isInProgress: true, isAllyAction: false }],
      [{ id: 2, actorCellId: 0, type: 'pick', championId: 266, completed: true, isInProgress: false, isAllyAction: true }],
      [{ id: 3, actorCellId: 1, type: 'pick', championId: 0, completed: false, isInProgress: false, isAllyAction: true }],
    ],
    bans: { myTeamBans: [64], theirTeamBans: [], numBans: 4 },
    timer: { phase: 'BAN_PICK', adjustedTimeLeftInPhase: 17500, totalTimeInPhase: 30000, isInfinite: false },
    ...extra,
  };
}

test('une réponse vide ou inattendue donne null', () => {
  assert.equal(normalizeDraft(null, CHAMPS), null);
  assert.equal(normalizeDraft({ errorCode: 'RPC_ERROR', httpStatus: 404 }, CHAMPS), null);
});

test('bans : champion banni, ban en cours et emplacements vides complétés', () => {
  const d = normalizeDraft(session(), CHAMPS);
  assert.deepEqual(d.teams.ORDER.bans.map((b) => [b.state, b.name]), [['done', 'Lee Sin'], ['pending', '']]);
  assert.deepEqual(d.teams.CHAOS.bans.map((b) => b.state), ['active', 'pending']);
  assert.equal(d.teams.ORDER.bans[0].key, 'LeeSin');
});

test('picks : verrouillé, survolé, vide, et noms masqués', () => {
  const d = normalizeDraft(session(), CHAMPS);
  const [p0, p1] = d.teams.ORDER.picks;
  assert.deepEqual([p0.state, p0.name, p0.position, p0.player, p0.local], ['locked', 'Aatrox', 'Top', 'J0', true]);
  assert.deepEqual([p1.state, p1.name], ['hover', 'Ahri']);
  const [r0, r1] = d.teams.CHAOS.picks;
  assert.equal(r0.state, 'empty');
  assert.equal(r1.player, null, 'un nom masqué par le client ne doit pas apparaître');
});

test('étape, équipe qui joue et chrono', () => {
  const d = normalizeDraft(session(), CHAMPS);
  assert.equal(d.step, 'ban');
  assert.equal(d.label, 'Phase de bans');
  assert.deepEqual(d.active, ['CHAOS']);
  assert.deepEqual(d.timer, { phase: 'BAN_PICK', leftMs: 17500, totalMs: 30000, infinite: false });
});

test('sans action en cours, la phase du chrono donne l\'étape', () => {
  const quiet = session({ actions: [], timer: { phase: 'PLANNING', adjustedTimeLeftInPhase: 9000, totalTimeInPhase: 10000 } });
  assert.equal(normalizeDraft(quiet, CHAMPS).step, 'planning');
  assert.equal(normalizeDraft({ ...quiet, timer: { phase: 'FINALIZATION' } }, CHAMPS).step, 'finalization');
  assert.equal(normalizeDraft({ ...quiet, timer: { phase: 'GAME_STARTING' } }, CHAMPS).step, 'starting');
});

test('mon équipe peut être la rouge : les côtés suivent le numéro d\'équipe du client', () => {
  const s = session();
  s.myTeam.forEach((c) => (c.team = 2));
  s.theirTeam.forEach((c) => (c.team = 1));
  const d = normalizeDraft(s, CHAMPS);
  assert.equal(d.teams.CHAOS.picks[0].name, 'Aatrox');
  assert.equal(d.teams.CHAOS.bans[0].name, 'Lee Sin');
  assert.deepEqual(d.active, ['ORDER']);
});

test('sans index de champions, le numéro sert de nom', () => {
  const d = normalizeDraft(session(), new Map());
  assert.equal(d.teams.ORDER.picks[0].name, 'Champion 266');
  assert.equal(d.teams.ORDER.picks[0].key, null);
});

test('sans actions de ban, on retombe sur les listes de bans du client', () => {
  const s = session({ actions: [], bans: { myTeamBans: [64, 222], theirTeamBans: [412], numBans: 0 } });
  const d = normalizeDraft(s, CHAMPS);
  assert.deepEqual(d.teams.ORDER.bans.map((b) => b.name), ['Lee Sin', 'Jinx']);
  assert.deepEqual(d.teams.CHAOS.bans.map((b) => b.name), ['Thresh']);
});

test('index des champions : Data Dragon et liste du client', () => {
  const dd = indexFromDdragon({ data: { Aatrox: { id: 'Aatrox', key: '266', name: 'Aatrox' }, MonkeyKing: { id: 'MonkeyKing', key: '62', name: 'Wukong' } } });
  assert.deepEqual(dd.get(62), { key: 'MonkeyKing', name: 'Wukong' });
  const lcu = indexFromClientSummary([{ id: 266, name: 'Aatrox', alias: 'Aatrox' }, { id: -1, name: 'None', alias: 'None' }]);
  assert.equal(lcu.size, 1);
  assert.equal(lcu.get(266).key, 'Aatrox');
});

test('lockfile et ligne de commande du client', () => {
  assert.deepEqual(parseLockfile('LeagueClient:1234:52000:s3cr3t:https\n'), { port: 52000, password: 's3cr3t', protocol: 'https' });
  assert.equal(parseLockfile('n\'importe quoi'), null);
  const cmd = '"C:\\Riot Games\\League of Legends\\LeagueClientUx.exe" --app-port=51234 --remoting-auth-token=abc_DEF-123 --riotclient-app-port=1';
  assert.deepEqual(parseCommandLine(cmd), { port: 51234, password: 'abc_DEF-123', protocol: 'https' });
  assert.equal(parseCommandLine('rien d\'utile'), null);
});

test('simulateur : une sélection complète, du premier ban au dernier pick', () => {
  const demo = new DemoDraft({ speed: 1000 });
  const seen = new Set();
  let last = null;
  const real = Date.now;
  let clock = real();
  Date.now = () => clock;
  try {
    demo.t0 = clock;
    for (let i = 0; i < 700; i++) {
      clock += 1000; // une seconde réelle × 1000 = bien plus que la durée du draft : on avance par pas de 1 s
      demo.speed = 1; // on repasse à la vitesse réelle et on avance seconde par seconde
      const raw = demo.snapshot();
      if (!raw) break;
      const d = normalizeDraft(raw, DEMO_CHAMPS);
      seen.add(d.step);
      last = d;
    }
  } finally {
    Date.now = real;
  }
  assert.ok(seen.has('planning') && seen.has('ban') && seen.has('pick') && seen.has('finalization'), [...seen].join(','));
  const all = [...last.teams.ORDER.picks, ...last.teams.CHAOS.picks];
  assert.equal(all.length, 10);
  assert.ok(all.every((p) => p.state === 'locked' && p.key), 'les 10 picks sont verrouillés');
  const names = [...last.teams.ORDER.bans, ...last.teams.CHAOS.bans, ...all].map((x) => x.name);
  assert.equal(new Set(names).size, 20, 'aucun champion en double');
});
