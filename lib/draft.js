'use strict';

/*
 * Transforme la session de sélection des champions du client League of Legends
 * (GET /lol-champ-select/v1/session) en un état simple que l'overlay sait afficher :
 * bans et picks de chaque équipe, étape en cours, chrono, équipe qui joue.
 *
 * ORDER = côté bleu (équipe n° 1 du client), CHAOS = côté rouge (équipe n° 2).
 * Le client ne donne que ce qu'il affiche lui-même : rien n'est lu en mémoire.
 */

const POSITIONS = { top: 'Top', jungle: 'Jungle', middle: 'Mid', mid: 'Mid', bottom: 'ADC', utility: 'Support', support: 'Support' };

const STEP_LABEL = {
  planning: 'Préparation',
  ban: 'Phase de bans',
  pick: 'Phase de picks',
  finalization: 'Finalisation',
  starting: 'La partie démarre',
  unknown: 'Sélection des champions',
};

/*
 * Index des champions : { id numérique → { key (nom de fichier de l'icône), name } }.
 * Construit depuis Data Dragon (champion.json) ou, hors ligne, depuis la liste du client.
 */
function indexFromDdragon(json) {
  const out = new Map();
  for (const c of Object.values((json && json.data) || {})) {
    const id = Number(c.key);
    if (id > 0) out.set(id, { key: c.id, name: c.name });
  }
  return out;
}

function indexFromClientSummary(list) {
  const out = new Map();
  for (const c of Array.isArray(list) ? list : []) {
    if (c && c.id > 0 && c.alias) out.set(c.id, { key: c.alias, name: c.name || c.alias });
  }
  return out;
}

function champion(champs, id) {
  if (!id || id < 0) return null;
  const c = champs && champs.get(id);
  return { championId: id, key: c ? c.key : null, name: c ? c.name : `Champion ${id}` };
}

function normalizeDraft(raw, champs) {
  if (!raw || (!Array.isArray(raw.myTeam) && !Array.isArray(raw.theirTeam))) return null;
  const mine = raw.myTeam || [];
  const theirs = raw.theirTeam || [];

  // Dans le client, « mon équipe » n'est pas toujours la bleue : on lit le numéro d'équipe de chaque joueur.
  const mineIsBlue = !(mine[0] && mine[0].team === 2) && !(theirs[0] && theirs[0].team === 1);
  const sideOfTeamNumber = (n, fallbackMine) => (n === 1 ? 'ORDER' : n === 2 ? 'CHAOS' : fallbackMine === mineIsBlue ? 'ORDER' : 'CHAOS');
  const cells = new Map();
  for (const c of mine) cells.set(c.cellId, { ...c, side: sideOfTeamNumber(c.team, true) });
  for (const c of theirs) cells.set(c.cellId, { ...c, side: sideOfTeamNumber(c.team, false) });

  const actions = (raw.actions || []).flat().filter((a) => a && typeof a === 'object');
  const sideOfAction = (a) => (cells.has(a.actorCellId) ? cells.get(a.actorCellId).side : a.isAllyAction === (mineIsBlue) ? 'ORDER' : 'CHAOS');

  const teams = { ORDER: { bans: [], picks: [] }, CHAOS: { bans: [], picks: [] } };

  // Bans : un emplacement par action de ban, dans l'ordre du client.
  for (const a of actions.filter((x) => x.type === 'ban').sort((x, y) => x.id - y.id)) {
    const done = a.completed;
    const c = champion(champs, a.championId);
    teams[sideOfAction(a)].bans.push({
      id: a.id,
      ...(done && c ? c : { championId: 0, key: null, name: '' }),
      state: done ? (c ? 'done' : 'none') : a.isInProgress ? 'active' : 'pending',
    });
  }
  // Pas d'actions de ban (client en cours de bascule, spectateur…) : on retombe sur les listes de bans.
  const bansInfo = raw.bans || {};
  const listed = { ORDER: mineIsBlue ? bansInfo.myTeamBans : bansInfo.theirTeamBans, CHAOS: mineIsBlue ? bansInfo.theirTeamBans : bansInfo.myTeamBans };
  for (const side of ['ORDER', 'CHAOS']) {
    const ids = (listed[side] || []).filter((n) => n > 0);
    if (!teams[side].bans.length) ids.forEach((n, i) => teams[side].bans.push({ id: i, ...champion(champs, n), state: 'done' }));
  }
  // Emplacements encore vides : on complète jusqu'au nombre de bans annoncé par équipe.
  const perSide = Math.round((bansInfo.numBans || 0) / 2);
  for (const side of ['ORDER', 'CHAOS']) {
    while (teams[side].bans.length < perSide) teams[side].bans.push({ id: 1000 + teams[side].bans.length, championId: 0, key: null, name: '', state: 'pending' });
  }

  // Picks : une carte par joueur.
  const pickAction = new Map(actions.filter((a) => a.type === 'pick').map((a) => [a.actorCellId, a]));
  for (const cell of [...cells.values()].sort((a, b) => a.cellId - b.cellId)) {
    const act = pickAction.get(cell.cellId);
    // Avec une action de pick, le champion n'est verrouillé que si elle est terminée ; sans action, on prend le champion du joueur.
    const lockedId = act ? (act.completed ? act.championId || cell.championId : 0) : cell.championId;
    const hoverId = lockedId ? 0 : cell.championPickIntent || (act && act.championId) || cell.championId || 0;
    const shown = champion(champs, lockedId) || champion(champs, hoverId);
    const hidden = cell.nameVisibilityType === 'HIDDEN';
    teams[cell.side].picks.push({
      cell: cell.cellId,
      position: POSITIONS[String(cell.assignedPosition || '').toLowerCase()] || null,
      player: hidden || !cell.gameName ? null : cell.gameName,
      championId: shown ? shown.championId : 0,
      key: shown ? shown.key : null,
      name: shown ? shown.name : '',
      state: lockedId ? 'locked' : act && act.isInProgress ? 'active' : hoverId ? 'hover' : 'empty',
      active: !!(act && act.isInProgress),
      local: cell.cellId === raw.localPlayerCellId,
    });
  }

  // Étape en cours : d'abord ce que le client fait jouer, sinon la phase du chrono.
  const inProgress = actions.filter((a) => a.isInProgress);
  const timer = raw.timer || {};
  const phase = String(timer.phase || '').toUpperCase();
  let step = 'unknown';
  if (inProgress.some((a) => a.type === 'ban')) step = 'ban';
  else if (inProgress.some((a) => a.type === 'pick')) step = 'pick';
  else if (phase === 'PLANNING') step = 'planning';
  else if (phase === 'FINALIZATION') step = 'finalization';
  else if (phase === 'GAME_STARTING') step = 'starting';

  const active = [...new Set(inProgress.map(sideOfAction))];
  return {
    gameId: raw.gameId || 0,
    step,
    label: STEP_LABEL[step],
    timer: { phase, leftMs: Math.max(0, Number(timer.adjustedTimeLeftInPhase) || 0), totalMs: Math.max(0, Number(timer.totalTimeInPhase) || 0), infinite: !!timer.isInfinite },
    active, // équipes qui jouent maintenant ('ORDER', 'CHAOS', ou les deux en bans simultanés)
    activeType: inProgress.length ? inProgress[0].type : null,
    spectating: !!raw.isSpectating,
    custom: !!raw.isCustomGame,
    teams,
  };
}

module.exports = { normalizeDraft, indexFromDdragon, indexFromClientSummary, STEP_LABEL };
