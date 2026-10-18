'use strict';

/*
 * Simulateur de sélection des champions : produit des sessions au même format que
 * GET /lol-champ-select/v1/session du client LoL, pour régler l'overlay des picks et bans
 * sans lancer le jeu. Draft de tournoi : bans, picks, bans, picks, puis finalisation.
 */

const CHAMPIONS = [
  [266, 'Aatrox', 'Aatrox'], [103, 'Ahri', 'Ahri'], [84, 'Akali', 'Akali'], [12, 'Alistar', 'Alistar'], [22, 'Ashe', 'Ashe'],
  [136, 'AurelionSol', 'Aurelion Sol'], [432, 'Bard', 'Bard'], [53, 'Blitzcrank', 'Blitzcrank'], [201, 'Braum', 'Braum'],
  [51, 'Caitlyn', 'Caitlyn'], [164, 'Camille', 'Camille'], [122, 'Darius', 'Darius'], [119, 'Draven', 'Draven'],
  [81, 'Ezreal', 'Ezreal'], [114, 'Fiora', 'Fiora'], [79, 'Gragas', 'Gragas'], [104, 'Graves', 'Graves'], [202, 'Jhin', 'Jhin'],
  [222, 'Jinx', 'Jinx'], [145, 'Kaisa', "Kai'Sa"], [429, 'Kalista', 'Kalista'], [43, 'Karma', 'Karma'], [64, 'LeeSin', 'Lee Sin'],
  [89, 'Leona', 'Leona'], [117, 'Lulu', 'Lulu'], [99, 'Lux', 'Lux'], [111, 'Nautilus', 'Nautilus'], [61, 'Orianna', 'Orianna'],
  [80, 'Pantheon', 'Pantheon'], [58, 'Renekton', 'Renekton'], [113, 'Sejuani', 'Sejuani'], [412, 'Thresh', 'Thresh'],
  [234, 'Viego', 'Viego'], [254, 'Vi', 'Vi'], [5, 'XinZhao', 'Xin Zhao'], [777, 'Yone', 'Yone'], [238, 'Zed', 'Zed'],
  [142, 'Zoe', 'Zoe'], [497, 'Rakan', 'Rakan'], [498, 'Xayah', 'Xayah'], [134, 'Syndra', 'Syndra'], [268, 'Azir', 'Azir'],
];

// Index { id → { key, name } } à fournir à normalizeDraft quand on n'a pas Data Dragon.
const DEMO_CHAMPS = new Map(CHAMPIONS.map(([id, key, name]) => [id, { key, name }]));

const ROSTER = {
  B: ['Kestrel', 'Brumelot', 'Oriane', 'Vexis', 'Tidou'],
  R: ['Morrow', 'Sable', 'Nyx Arden', 'Pilou', 'Garance'],
};
const POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility'];

// Ordre d'un draft de tournoi : B = bleu, R = rouge.
const PLAN = [
  ['ban', 'B'], ['ban', 'R'], ['ban', 'B'], ['ban', 'R'], ['ban', 'B'], ['ban', 'R'],
  ['pick', 'B'], ['pick', 'R'], ['pick', 'R'], ['pick', 'B'], ['pick', 'B'], ['pick', 'R'],
  ['ban', 'R'], ['ban', 'B'], ['ban', 'R'], ['ban', 'B'],
  ['pick', 'R'], ['pick', 'B'], ['pick', 'B'], ['pick', 'R'],
];

const PLANNING_S = 20; // secondes de draft (accélérées par « speed »)
const TURN_S = 30;
const FINAL_S = 20;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Les champions piochés sont ceux de la partie simulée (lib/demo.js) : la démo complète enchaîne le draft puis la partie.
// Par poste, du haut vers le bas : top, jungle, mid, bot, support.
const ROSTER_PICKS = {
  B: [266, 64, 103, 222, 412], // Aatrox, Lee Sin, Ahri, Jinx, Thresh
  R: [58, 234, 61, 145, 111], // Renekton, Viego, Orianna, Kai'Sa, Nautilus
};

class DemoDraft {
  /*
   * loop : recommence tout seul après la fin (par défaut). Avec loop: false, snapshot() renvoie null une fois la
   * sélection terminée (propriété « finished ») jusqu'à ce qu'on appelle reset().
   */
  constructor({ speed = 12, spectator = false, seed = 11, loop = true } = {}) {
    this.speed = speed;
    this.spectator = spectator;
    this.seed = seed;
    this.loop = loop;
    this.reset();
  }

  reset() {
    const rand = rng(this.seed++);
    const taken = new Set([...ROSTER_PICKS.B, ...ROSTER_PICKS.R]);
    const banPool = CHAMPIONS.map(([id]) => id).filter((id) => !taken.has(id));
    for (let i = banPool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [banPool[i], banPool[j]] = [banPool[j], banPool[i]];
    }
    // Les bans sont tirés au hasard (jamais un champion de la partie) ; chaque joueur pioche à son tour, dans l'ordre des postes.
    const counters = { B: { ban: 0, pick: 0 }, R: { ban: 0, pick: 0 } };
    let bans = 0;
    this.actions = PLAN.map(([type, side], i) => {
      const n = counters[side][type]++;
      const championId = type === 'pick' ? ROSTER_PICKS[side][n % 5] : banPool[bans++];
      return { id: i, actorCellId: (side === 'B' ? 0 : 5) + (n % 5), type, side, championId };
    });
    this.t0 = Date.now();
    this.doneAt = null;
    this.restartAt = null;
    this.finished = false;
  }

  snapshot() {
    const now = Date.now();
    if (this.finished) return null;
    if (this.restartAt) {
      if (now < this.restartAt) return null;
      this.reset();
    }
    const e = ((now - this.t0) / 1000) * this.speed; // secondes de draft écoulées
    const total = PLANNING_S + PLAN.length * TURN_S;
    if (e >= total + FINAL_S && !this.doneAt) this.doneAt = now;
    // Une fois fini, la sélection reste affichée 8 s puis disparaît (5 s de pause avant de recommencer si loop).
    if (this.doneAt && now - this.doneAt > 8000) {
      if (this.loop) this.restartAt = now + 5000;
      else this.finished = true;
      return null;
    }

    const idx = e < PLANNING_S ? -1 : Math.floor((e - PLANNING_S) / TURN_S);
    const within = e < PLANNING_S ? 0 : (e - PLANNING_S) % TURN_S;
    const finished = idx >= PLAN.length;

    const actions = this.actions.map((a, i) => {
      const completed = finished || i < idx;
      const inProgress = !finished && i === idx;
      const intent = inProgress && a.type === 'pick' && within > TURN_S * 0.35;
      return {
        id: a.id,
        actorCellId: a.actorCellId,
        type: a.type,
        completed,
        isInProgress: inProgress,
        isAllyAction: a.side === 'B',
        pickTurn: 1,
        championId: completed ? a.championId : intent ? a.championId : 0,
      };
    });

    const cell = (side, k) => {
      const cellId = (side === 'B' ? 0 : 5) + k;
      const pick = this.actions.find((a) => a.type === 'pick' && a.actorCellId === cellId);
      const ai = pick ? pick.id : -1;
      const locked = pick && (finished || ai < idx);
      const hovering = pick && !locked && ai === idx && within > TURN_S * 0.35;
      return {
        cellId,
        team: side === 'B' ? 1 : 2,
        assignedPosition: POSITIONS[k],
        gameName: ROSTER[side][k],
        tagLine: 'EUW',
        nameVisibilityType: 'VISIBLE',
        championId: locked ? pick.championId : 0,
        championPickIntent: hovering ? pick.championId : 0,
        selectedSkinId: 0,
        summonerId: 1000 + cellId,
        spell1Id: 4,
        spell2Id: 14,
      };
    };

    const doneBans = (side) => this.actions.filter((a) => a.type === 'ban' && a.side === side && (finished || a.id < idx)).map((a) => a.championId);
    const phase = e < PLANNING_S ? 'PLANNING' : finished ? 'FINALIZATION' : 'BAN_PICK';
    const left = (phase === 'PLANNING' ? PLANNING_S - e : phase === 'FINALIZATION' ? Math.max(0, total + FINAL_S - e) : TURN_S - within) * 1000;
    return {
      gameId: 4242424242,
      isSpectating: this.spectator,
      isCustomGame: true,
      localPlayerCellId: this.spectator ? -1 : 0,
      hasSimultaneousBans: false,
      hasSimultaneousPicks: false,
      myTeam: [0, 1, 2, 3, 4].map((k) => cell('B', k)),
      theirTeam: [0, 1, 2, 3, 4].map((k) => cell('R', k)),
      actions: actions.map((a) => [a]),
      bans: { myTeamBans: doneBans('B'), theirTeamBans: doneBans('R'), numBans: 10 },
      timer: { phase, adjustedTimeLeftInPhase: Math.round(left), totalTimeInPhase: (phase === 'BAN_PICK' ? TURN_S : phase === 'PLANNING' ? PLANNING_S : FINAL_S) * 1000, isInfinite: false, internalNowInEpochMs: now },
    };
  }
}

module.exports = { DemoDraft, DEMO_CHAMPS };
