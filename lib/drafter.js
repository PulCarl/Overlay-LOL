'use strict';

/*
 * Drafter : un draft de tournoi (bans et picks, tour par tour) mené par les joueurs sur des pages partagées.
 *
 * Ce fichier est le moteur : il connaît l'ordre des tours, ce qui reste disponible, le chrono, et refuse tout
 * ce qui n'est pas permis. Il ne touche ni au réseau ni à l'horloge (l'heure est toujours passée en argument,
 * `now`, en millisecondes) pour pouvoir être testé seul. Il sait aussi se présenter comme une session du client
 * LoL (snapshot) : l'overlay des picks et bans affiche alors ce draft comme un vrai.
 *
 * ORDER = équipe bleue (numéro 1 du client), CHAOS = équipe rouge (numéro 2).
 */

const SIDES = ['ORDER', 'CHAOS'];
const POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility']; // noms du client, un par emplacement de joueur
const POSITION_LABEL = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];
const TEAM_SIZE = 5;

// Ordre d'un draft de tournoi : 6 bans, 6 picks, 4 bans, 4 picks.
const STANDARD_PLAN = [
  ['ban', 'ORDER'], ['ban', 'CHAOS'], ['ban', 'ORDER'], ['ban', 'CHAOS'], ['ban', 'ORDER'], ['ban', 'CHAOS'],
  ['pick', 'ORDER'], ['pick', 'CHAOS'], ['pick', 'CHAOS'], ['pick', 'ORDER'], ['pick', 'ORDER'], ['pick', 'CHAOS'],
  ['ban', 'CHAOS'], ['ban', 'ORDER'], ['ban', 'CHAOS'], ['ban', 'ORDER'],
  ['pick', 'CHAOS'], ['pick', 'ORDER'], ['pick', 'ORDER'], ['pick', 'CHAOS'],
];

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

/* Les cinq pseudos d'une équipe, dans l'ordre des postes (Top, Jungle, Mid, ADC, Support). */
function cleanRoster(list) {
  return Array.from({ length: TEAM_SIZE }, (_, i) => String((Array.isArray(list) && list[i]) || '').trim().slice(0, 24));
}

let counter = 0;

class Drafter {
  /*
   * champions : [{ id, key, name }] ; roster : { ORDER: [5 pseudos], CHAOS: [5 pseudos] } ;
   * turnSeconds : durée d'un tour ; rand : source de hasard (pour un pick tiré au sort quand le chrono tombe à zéro).
   */
  constructor({ champions, roster, turnSeconds = 30, plan = STANDARD_PLAN, rand = Math.random } = {}) {
    this.champions = new Map();
    for (const c of champions || []) {
      if (Number.isInteger(c.id) && c.id > 0 && c.key) this.champions.set(c.id, { id: c.id, key: String(c.key), name: String(c.name || c.key) });
    }
    this.roster = { ORDER: cleanRoster(roster && roster.ORDER), CHAOS: cleanRoster(roster && roster.CHAOS) };
    this.turnMs = clamp(Math.round(Number(turnSeconds) || 30), 5, 300) * 1000;
    this.plan = plan;
    this.rand = rand;
    this.gameId = 4200000000 + ++counter;
    this.reset();
  }

  /* Revient au salon d'attente : aucun tour joué, chrono arrêté. */
  reset() {
    this.status = 'lobby'; // lobby | running | paused | finished
    this.turn = 0;
    this.actions = this.plan.map(([type, side], id) => ({ id, type, side, championId: 0, slot: -1, done: false, skipped: false }));
    this.hover = { championId: 0, slot: -1 };
    this.timer = { running: false, endsAt: 0, remainingMs: this.turnMs };
  }

  /* ----------------------------------------------------------------- état */

  /* Le tour en cours (même en pause), ou null avant le début et après la fin. */
  active() {
    return this.status === 'running' || this.status === 'paused' ? this.actions[this.turn] : null;
  }

  timeLeft(now) {
    return this.timer.running ? Math.max(0, this.timer.endsAt - now) : this.timer.remainingMs;
  }

  /* Champions déjà bannis ou choisis. */
  usedIds() {
    return new Set(this.actions.filter((a) => a.done && a.championId).map((a) => a.championId));
  }

  isAvailable(id) {
    return this.champions.has(id) && !this.usedIds().has(id);
  }

  /* Postes de l'équipe qui n'ont pas encore de champion. */
  freeSlots(side) {
    const taken = new Set(this.actions.filter((a) => a.type === 'pick' && a.done && !a.skipped && a.side === side).map((a) => a.slot));
    return [0, 1, 2, 3, 4].filter((s) => !taken.has(s));
  }

  /* Un poste valide pour ce pick (le poste demandé s'il est libre, sinon -1). */
  validSlot(side, slot) {
    return Number.isInteger(slot) && this.freeSlots(side).includes(slot) ? slot : -1;
  }

  /* ----------------------------------------------------------- déroulement */

  start(now) {
    if (this.status !== 'lobby') return fail('Le draft est déjà lancé.');
    this.status = 'running';
    this.startTurn(now);
    return OK;
  }

  startTurn(now) {
    this.timer = { running: true, endsAt: now + this.turnMs, remainingMs: this.turnMs };
    this.hover = { championId: 0, slot: -1 };
  }

  pause(now) {
    if (this.status !== 'running') return fail('Le draft n\'est pas en cours.');
    this.timer = { running: false, endsAt: 0, remainingMs: this.timeLeft(now) };
    this.status = 'paused';
    return OK;
  }

  resume(now) {
    if (this.status !== 'paused') return fail('Le draft n\'est pas en pause.');
    this.status = 'running';
    this.timer = { running: true, endsAt: now + this.timer.remainingMs, remainingMs: this.timer.remainingMs };
    return OK;
  }

  /* Vérifie qu'une équipe a le droit d'agir maintenant ; renvoie le tour ou une erreur. */
  turnFor(side) {
    if (this.status === 'lobby') return fail('Le draft n\'a pas commencé.');
    if (this.status === 'paused') return fail('Le draft est en pause.');
    if (this.status !== 'running') return fail('Le draft est terminé.');
    const a = this.actions[this.turn];
    if (a.side !== side) return fail('Ce n\'est pas à votre équipe de jouer.');
    return { ok: true, action: a };
  }

  /* Survol : le champion regardé par l'équipe qui joue (visible des autres, et dans l'overlay). 0 = plus de survol. */
  hoverChampion(side, championId, slot) {
    const t = this.turnFor(side);
    if (!t.ok) return t;
    if (!championId) {
      this.hover = { championId: 0, slot: -1 };
      return OK;
    }
    if (!this.isAvailable(championId)) return fail('Ce champion n\'est pas disponible.');
    this.hover = { championId, slot: t.action.type === 'pick' ? this.validSlot(side, slot) : -1 };
    return OK;
  }

  /* Verrouille le ban ou le pick (le champion survolé si aucun n'est donné). */
  lock(side, championId, slot, now) {
    const t = this.turnFor(side);
    if (!t.ok) return t;
    const id = championId || this.hover.championId;
    if (!id) return fail('Choisissez d\'abord un champion.');
    if (!this.isAvailable(id)) return fail('Ce champion n\'est pas disponible.');
    const wanted = Number.isInteger(slot) ? slot : this.hover.slot;
    if (t.action.type === 'pick' && Number.isInteger(slot) && this.validSlot(side, slot) < 0) return fail('Ce poste a déjà son champion.');
    this.complete(id, wanted, now);
    return OK;
  }

  /* Un ban peut être passé (personne n'est banni) : par le régisseur, ou quand le chrono tombe à zéro. */
  skip(now) {
    const a = this.active();
    if (!a || this.status !== 'running') return fail('Le draft n\'est pas en cours.');
    if (a.type !== 'ban') return fail('Seul un ban peut être passé.');
    this.complete(0, -1, now);
    return OK;
  }

  complete(id, slot, now) {
    const a = this.actions[this.turn];
    a.championId = id;
    a.skipped = !id;
    if (a.type === 'pick') {
      const free = this.freeSlots(a.side);
      a.slot = free.includes(slot) ? slot : free[0];
    }
    a.done = true;
    this.turn += 1;
    if (this.turn >= this.actions.length) {
      this.status = 'finished';
      this.timer = { running: false, endsAt: 0, remainingMs: 0 };
      this.hover = { championId: 0, slot: -1 };
    } else {
      this.startTurn(now);
    }
  }

  /* Annule la dernière action jouée (ban, pick ou ban passé) ; le tour recommence avec un chrono plein. */
  undo(now) {
    if (this.status === 'lobby') return fail('Rien à annuler.');
    const last = this.status === 'finished' ? this.actions.length - 1 : this.turn - 1;
    if (last < 0) return fail('Rien à annuler.');
    const a = this.actions[last];
    a.championId = 0;
    a.slot = -1;
    a.done = false;
    a.skipped = false;
    this.turn = last;
    if (this.status === 'finished') this.status = 'running';
    if (this.status === 'paused') {
      this.timer = { running: false, endsAt: 0, remainingMs: this.turnMs };
      this.hover = { championId: 0, slot: -1 };
    } else {
      this.startTurn(now);
    }
    return OK;
  }

  /*
   * Chrono tombé à zéro : le champion survolé est verrouillé ; sans survol, un ban est passé et un pick est tiré au sort
   * (comme dans le client). À appeler régulièrement ; renvoie true si quelque chose a changé.
   */
  tick(now) {
    if (this.status !== 'running' || this.timeLeft(now) > 0) return false;
    const a = this.actions[this.turn];
    const hovered = this.hover.championId && this.isAvailable(this.hover.championId) ? this.hover.championId : 0;
    if (hovered) {
      this.complete(hovered, this.hover.slot, now);
    } else if (a.type === 'ban') {
      this.complete(0, -1, now);
    } else {
      const pool = [...this.champions.keys()].filter((id) => this.isAvailable(id));
      this.complete(pool.length ? pool[Math.floor(this.rand() * pool.length)] : 0, -1, now);
    }
    return true;
  }

  /* ----------------------------------------------------- présentations */

  /*
   * Poste (cellule) de chaque pick : celui qui a été choisi une fois le pick fait ; pour les picks à venir, les postes
   * encore libres dans l'ordre, le pick en cours prenant le poste survolé s'il y en a un.
   */
  pickCells() {
    const cells = new Map();
    for (const side of SIDES) {
      const offset = side === 'ORDER' ? 0 : 5;
      const picks = this.actions.filter((a) => a.type === 'pick' && a.side === side);
      for (const a of picks) if (a.done) cells.set(a.id, offset + (a.skipped ? 0 : a.slot));
      const free = this.freeSlots(side);
      const pending = picks.filter((a) => !a.done);
      const current = this.active();
      const wanted = current && current.type === 'pick' && current.side === side && free.includes(this.hover.slot) ? this.hover.slot : -1;
      const rest = free.filter((s) => s !== wanted);
      for (const a of pending) {
        if (a === current && wanted >= 0) cells.set(a.id, offset + wanted);
        else cells.set(a.id, offset + rest.shift());
      }
    }
    return cells;
  }

  /* Le draft comme une session du client LoL (GET /lol-champ-select/v1/session), pour l'overlay. */
  snapshot(now) {
    const current = this.active();
    const cells = this.pickCells();
    const hoverCell = current && current.type === 'pick' && this.hover.championId ? cells.get(current.id) : -1;
    const cell = (side, slot) => {
      const cellId = (side === 'ORDER' ? 0 : 5) + slot;
      const locked = this.actions.find((a) => a.type === 'pick' && a.done && !a.skipped && a.side === side && a.slot === slot);
      return {
        cellId,
        team: side === 'ORDER' ? 1 : 2,
        assignedPosition: POSITIONS[slot],
        gameName: this.roster[side][slot],
        tagLine: '',
        nameVisibilityType: 'VISIBLE',
        championId: locked ? locked.championId : 0,
        championPickIntent: hoverCell === cellId ? this.hover.championId : 0,
        selectedSkinId: 0,
        summonerId: 1000 + cellId,
        spell1Id: 4,
        spell2Id: 14,
      };
    };
    const doneBans = (side) => this.actions.filter((a) => a.type === 'ban' && a.side === side && a.done && a.championId).map((a) => a.championId);
    const lobby = this.status === 'lobby';
    const finished = this.status === 'finished';
    return {
      gameId: this.gameId,
      isSpectating: false,
      isCustomGame: true,
      localPlayerCellId: -1,
      hasSimultaneousBans: false,
      hasSimultaneousPicks: false,
      myTeam: [0, 1, 2, 3, 4].map((k) => cell('ORDER', k)),
      theirTeam: [0, 1, 2, 3, 4].map((k) => cell('CHAOS', k)),
      actions: this.actions.map((a, i) => [
        {
          id: a.id,
          actorCellId: a.type === 'pick' ? cells.get(a.id) : a.side === 'ORDER' ? 0 : 5,
          type: a.type,
          completed: a.done,
          isInProgress: !!current && i === this.turn,
          isAllyAction: a.side === 'ORDER',
          pickTurn: 1,
          championId: a.done ? a.championId : current && i === this.turn && a.type === 'pick' ? this.hover.championId : 0,
        },
      ]),
      bans: { myTeamBans: doneBans('ORDER'), theirTeamBans: doneBans('CHAOS'), numBans: this.actions.filter((a) => a.type === 'ban').length },
      timer: {
        phase: lobby ? 'PLANNING' : finished ? 'FINALIZATION' : 'BAN_PICK',
        adjustedTimeLeftInPhase: Math.round(this.timeLeft(now)),
        totalTimeInPhase: this.turnMs,
        // Pas de décompte avant le début, en pause et une fois fini : l'overlay affiche « -- ».
        isInfinite: lobby || finished || this.status === 'paused',
        internalNowInEpochMs: now,
      },
    };
  }

  /* Ce que les pages des joueurs et du panneau ont besoin de connaître (aucun secret). */
  view(now) {
    const a = this.active();
    const cells = this.pickCells();
    return {
      status: this.status,
      turn: this.turn,
      total: this.actions.length,
      now,
      turnSeconds: this.turnMs / 1000,
      active: a ? { id: a.id, type: a.type, side: a.side } : null,
      timer: { leftMs: Math.round(this.timeLeft(now)), totalMs: this.turnMs, running: this.timer.running },
      hover: { championId: this.hover.championId, slot: a && a.type === 'pick' && this.hover.championId ? cells.get(a.id) % 5 : -1 },
      roster: this.roster,
      positions: POSITION_LABEL,
      actions: this.actions.map((x) => ({ id: x.id, type: x.type, side: x.side, championId: x.championId, slot: x.slot, done: x.done, skipped: x.skipped })),
      used: [...this.usedIds()],
    };
  }

  /* La liste des champions pour les pages (triée par nom). */
  championList() {
    return [...this.champions.values()].sort((x, y) => x.name.localeCompare(y.name, 'fr'));
  }
}

module.exports = { Drafter, STANDARD_PLAN, SIDES, POSITIONS, POSITION_LABEL, TEAM_SIZE, cleanRoster };
