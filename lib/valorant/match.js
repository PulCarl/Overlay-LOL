'use strict';

/*
 * Un match VALORANT piloté à la main depuis le panneau de contrôle.
 *
 * VALORANT n'a pas d'API locale qui donne le score, les crédits ou les K/D/A de tous les joueurs :
 * l'overlay affiche donc ce que le régisseur saisit. Ce fichier est le modèle de ce match
 * (équipes, manches, maps, joueurs, chrono, écran de fin) et les opérations qui le font évoluer.
 * Il ne touche ni au disque ni au réseau, pour pouvoir être testé seul.
 *
 * Les deux équipes s'appellent « left » (à gauche, en vert-bleu) et « right » (à droite, en rouge).
 */

const FORMATS = [1, 3, 5];
const SIDES = ['left', 'right'];
const PHASES = ['buy', 'live', 'planted', 'over'];
const PICKS = ['', 'left', 'right', 'decider'];
const TEAM_SIZE = 5;
const MAX_MAPS = 5;
const START_CREDITS = 800;
const ROUNDS_TO_WIN = 13;
// Durées du chrono, en secondes : achat, manche, spike posé.
const PHASE_SECONDS = { buy: 30, live: 100, planted: 45 };

/* ------------------------------------------------------------------ outils */

const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const other = (side) => (side === 'left' ? 'right' : 'left');

/* Une image est soit un fichier envoyé au serveur, soit une adresse http(s). */
function imageUrl(v) {
  const s = str(v, 500);
  if (!s) return '';
  if (/^\/uploads\/[a-f0-9]{8,64}\.(png|jpg|webp|gif)$/.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

/* ------------------------------------------------------------ valeurs d'origine */

const emptyPlayer = () => ({ name: '', agent: '', alive: true, kills: 0, deaths: 0, assists: 0, credits: START_CREDITS, ult: false });
const emptyPlayers = () => Array.from({ length: TEAM_SIZE }, emptyPlayer);

function defaultMatch() {
  return {
    display: { scorebar: true, maps: true, players: true, event: true, scale: 1 },
    event: { name: '', stage: '' },
    format: 3,
    teams: {
      left: { name: 'Équipe A', tag: 'EQA', sub: '', logo: '' },
      right: { name: 'Équipe B', tag: 'EQB', sub: '', logo: '' },
    },
    // Cartes gagnées dans la série.
    series: { left: 0, right: 0 },
    round: { number: 1, left: 0, right: 0, phase: 'buy' },
    // En marche : endsAt est l'heure de fin ; à l'arrêt : remaining est le temps restant, en millisecondes.
    timer: { total: PHASE_SECONDS.buy * 1000, remaining: PHASE_SECONDS.buy * 1000, endsAt: 0, running: false },
    maps: [],
    mapIndex: 0,
    players: { left: emptyPlayers(), right: emptyPlayers() },
    endScreen: { visible: false, data: null },
    presets: [],
  };
}

/* ----------------------------------------------------------------- réglages */

function cleanResult(r) {
  if (!isObj(r)) return null;
  const winner = SIDES.includes(r.winner) ? r.winner : null;
  return { left: int(r.left, 0, 99, 0), right: int(r.right, 0, 99, 0), winner };
}

function patchPlayer(pl, p) {
  if (!isObj(p)) return;
  if ('name' in p) pl.name = str(p.name, 24);
  if ('agent' in p) pl.agent = str(p.agent, 24);
  if ('alive' in p) pl.alive = !!p.alive;
  if ('ult' in p) pl.ult = !!p.ult;
  for (const k of ['kills', 'deaths', 'assists']) if (k in p) pl[k] = int(p[k], 0, 99, pl[k]);
  if ('credits' in p) pl.credits = int(p.credits, 0, 9000, pl.credits);
}

/*
 * Applique une modification partielle venue du panneau (ou du fichier de réglages).
 * Tout est vérifié et borné. `trusted` est réservé à la lecture du fichier de réglages :
 * le chrono, l'écran de fin et les résultats des maps ne se modifient jamais depuis le panneau.
 */
function applyPatch(m, p, { trusted = false } = {}) {
  if (!isObj(p)) return;

  if ('format' in p && FORMATS.includes(Number(p.format))) m.format = Number(p.format);

  if (isObj(p.teams)) {
    for (const k of SIDES) {
      const t = p.teams[k];
      if (!isObj(t)) continue;
      if ('name' in t) m.teams[k].name = str(t.name, 40);
      if ('tag' in t) m.teams[k].tag = str(t.tag, 4).toUpperCase();
      if ('sub' in t) m.teams[k].sub = str(t.sub, 24);
      if ('logo' in t) m.teams[k].logo = imageUrl(t.logo);
    }
  }

  if (isObj(p.series)) {
    for (const k of SIDES) if (k in p.series) m.series[k] = int(p.series[k], 0, 5, m.series[k]);
  }

  if (isObj(p.round)) {
    const r = p.round;
    if ('number' in r) m.round.number = int(r.number, 1, 99, m.round.number);
    for (const k of SIDES) if (k in r) m.round[k] = int(r[k], 0, 99, m.round[k]);
    if ('phase' in r && PHASES.includes(r.phase)) m.round.phase = r.phase;
  }

  if (isObj(p.event)) {
    if ('name' in p.event) m.event.name = str(p.event.name, 60);
    if ('stage' in p.event) m.event.stage = str(p.event.stage, 60);
  }

  if (isObj(p.display)) {
    const d = p.display;
    for (const k of ['scorebar', 'maps', 'players', 'event']) if (k in d) m.display[k] = !!d[k];
    if ('scale' in d) {
      const n = Number(d.scale);
      if (Number.isFinite(n)) m.display.scale = Math.round(Math.min(1.5, Math.max(0.5, n)) * 100) / 100;
    }
  }

  // La liste des maps se remplace d'un bloc ; le résultat d'une map déjà jouée est gardé.
  if (Array.isArray(p.maps)) {
    const old = m.maps;
    m.maps = p.maps
      .filter(isObj)
      .slice(0, MAX_MAPS)
      .map((x, i) => {
        const base = old[i] || { name: '', pick: '', result: null };
        const next = {
          name: 'name' in x ? str(x.name, 24) : base.name,
          pick: 'pick' in x ? (PICKS.includes(x.pick) ? x.pick : '') : base.pick,
          result: base.result,
        };
        if (trusted && 'result' in x) next.result = cleanResult(x.result);
        return next;
      });
    m.mapIndex = Math.min(m.mapIndex, m.maps.length);
  }
  if ('mapIndex' in p) m.mapIndex = int(p.mapIndex, 0, m.maps.length, m.mapIndex);

  // players : { left: [ { … }, null, { … } ], right: [ … ] } ; null laisse le joueur tel quel.
  if (isObj(p.players)) {
    for (const k of SIDES) {
      if (!Array.isArray(p.players[k])) continue;
      p.players[k].slice(0, TEAM_SIZE).forEach((pp, i) => patchPlayer(m.players[k][i], pp));
    }
  }

  if (trusted) {
    if (isObj(p.timer)) {
      const t = p.timer;
      m.timer = {
        total: int(t.total, 0, 3599000, m.timer.total),
        remaining: int(t.remaining, 0, 3599000, m.timer.remaining),
        endsAt: int(t.endsAt, 0, Number.MAX_SAFE_INTEGER, 0),
        running: !!t.running,
      };
    }
    if (isObj(p.endScreen)) {
      const data = isObj(p.endScreen.data) && JSON.stringify(p.endScreen.data).length < 60000 ? p.endScreen.data : null;
      m.endScreen = { visible: !!p.endScreen.visible && !!data, data };
    }
  }
}

/* Remet d'aplomb un état lu sur le disque : un chrono resté « en marche » est arrêté. */
function normalize(m, now) {
  if (m.timer.running) timerPause(m, now);
}

/* ------------------------------------------------------------------- chrono */

const timerRemaining = (m, now) => (m.timer.running ? Math.max(0, m.timer.endsAt - now) : m.timer.remaining);

function timerSet(m, seconds, run, now) {
  const total = int(seconds, 0, 3599, 0) * 1000;
  m.timer = { total, remaining: total, endsAt: run ? now + total : 0, running: !!run && total > 0 };
}

function timerPause(m, now) {
  if (!m.timer.running) return;
  m.timer.remaining = Math.max(0, m.timer.endsAt - now);
  m.timer.endsAt = 0;
  m.timer.running = false;
}

function timerResume(m, now) {
  if (m.timer.running || m.timer.remaining <= 0) return;
  m.timer.endsAt = now + m.timer.remaining;
  m.timer.running = true;
}

function timerReset(m) {
  m.timer.remaining = m.timer.total;
  m.timer.endsAt = 0;
  m.timer.running = false;
}

/* Change la phase de la manche et lance le chrono qui va avec : achat, manche ou spike posé. */
function startPhase(m, phase, now) {
  if (!PHASES.includes(phase)) return;
  m.round.phase = phase;
  if (phase === 'over') timerPause(m, now);
  else timerSet(m, PHASE_SECONDS[phase], true, now);
}

/* -------------------------------------------------------------- manches et maps */

/* Une map se gagne à 13 manches avec 2 d'avance (prolongations comprises). */
function mapWinnerOf(score) {
  for (const k of SIDES) {
    if (score[k] >= ROUNDS_TO_WIN && score[k] - score[other(k)] >= 2) return k;
  }
  return null;
}

const seriesNeeded = (m) => Math.ceil(m.format / 2);
const matchWinner = (m) => SIDES.find((k) => m.series[k] >= seriesNeeded(m)) || null;

function resetPlayers(m) {
  for (const k of SIDES) {
    for (const pl of m.players[k]) Object.assign(pl, { alive: true, kills: 0, deaths: 0, assists: 0, credits: START_CREDITS, ult: false });
  }
}

/* Manche gagnée : le score monte, la manche suivante commence (tout le monde revient en vie). */
function roundWon(m, side) {
  if (!SIDES.includes(side)) return;
  m.round[side] = Math.min(99, m.round[side] + 1);
  m.round.number = Math.min(99, m.round.number + 1);
  m.round.phase = 'buy';
  for (const k of SIDES) for (const pl of m.players[k]) pl.alive = true;
  timerSet(m, PHASE_SECONDS.buy, false, 0);
}

/* Les deux équipes changent de côté de l'écran, avec leur score, leur série et leurs joueurs. */
function swapSides(m) {
  for (const key of ['teams', 'series', 'players']) [m[key].left, m[key].right] = [m[key].right, m[key].left];
  [m.round.left, m.round.right] = [m.round.right, m.round.left];
  for (const mp of m.maps) {
    const r = mp.result;
    if (r) {
      [r.left, r.right] = [r.right, r.left];
      if (r.winner) r.winner = other(r.winner);
    }
    if (mp.pick === 'left' || mp.pick === 'right') mp.pick = other(mp.pick);
  }
  if (m.endScreen.data) m.endScreen.data = swapSnapshot(m.endScreen.data);
}

function swapSnapshot(d) {
  const s = clone(d);
  for (const key of ['teams', 'series', 'players', 'score']) if (s[key]) [s[key].left, s[key].right] = [s[key].right, s[key].left];
  if (s.winner) s.winner = other(s.winner);
  if (s.mvp) s.mvp.side = other(s.mvp.side);
  for (const mp of s.maps || []) {
    if (mp.score) [mp.score.left, mp.score.right] = [mp.score.right, mp.score.left];
    if (mp.winner) mp.winner = other(mp.winner);
  }
  return s;
}

/* Meilleur joueur : le plus de kills, puis d'assists, puis le moins de morts (dans l'équipe gagnante si elle est connue). */
function computeMvp(players, winner) {
  let best = null;
  for (const side of SIDES) {
    if (winner && side !== winner) continue;
    players[side].forEach((p, index) => {
      if (!p.name && !p.agent) return;
      if (p.kills + p.assists === 0) return;
      const score = p.kills * 1000 + p.assists * 10 - p.deaths;
      if (!best || score > best.score) best = { side, index, score };
    });
  }
  return best ? { side: best.side, index: best.index } : null;
}

/* Ce que l'écran de fin affiche : une copie figée, qui ne bouge plus quand la map suivante commence. */
function snapshotEnd(m, kind, winner) {
  const mapIndex = Math.min(m.mapIndex, Math.max(0, m.maps.length - 1));
  const current = m.maps[mapIndex];
  return {
    kind, // map | match | preview
    mapName: current ? current.name : '',
    mapNumber: mapIndex + 1,
    winner,
    score: { left: m.round.left, right: m.round.right },
    series: clone(m.series),
    format: m.format,
    event: clone(m.event),
    teams: clone(m.teams),
    players: clone(m.players),
    mvp: computeMvp(m.players, winner),
    maps: m.maps.map((mp) => ({
      name: mp.name,
      score: mp.result ? { left: mp.result.left, right: mp.result.right } : null,
      winner: mp.result ? mp.result.winner : null,
    })),
  };
}

/*
 * Fin de la map : on enregistre le résultat, la série monte, l'écran de fin s'affiche,
 * puis la map suivante démarre à zéro (équipes et joueurs gardés, statistiques remises à zéro).
 */
function endMap(m, winner) {
  const score = { left: m.round.left, right: m.round.right };
  const w = SIDES.includes(winner) ? winner : mapWinnerOf(score) || (score.left > score.right ? 'left' : score.right > score.left ? 'right' : null);
  if (!w) throw Object.assign(new Error('Égalité : indiquez quelle équipe a gagné la map.'), { code: 409 });

  if (m.mapIndex >= m.maps.length) {
    if (m.maps.length >= MAX_MAPS) throw Object.assign(new Error('Toutes les maps de la série sont jouées.'), { code: 409 });
    m.maps.push({ name: '', pick: '', result: null });
  }
  const slot = m.maps[Math.min(m.mapIndex, m.maps.length - 1)];
  slot.result = { left: score.left, right: score.right, winner: w };
  m.series[w] = Math.min(5, m.series[w] + 1);

  const kind = matchWinner(m) ? 'match' : 'map';
  m.endScreen = { visible: true, data: snapshotEnd(m, kind, w) };

  m.mapIndex = Math.min(m.maps.length, m.mapIndex + 1);
  m.round = { number: 1, left: 0, right: 0, phase: 'buy' };
  resetPlayers(m);
  timerSet(m, PHASE_SECONDS.buy, false, 0);
}

/* Affiche ou masque l'écran de fin. Sans résultat à montrer, on en fabrique un aperçu avec la map en cours. */
function showEndScreen(m, visible) {
  if (!visible) {
    m.endScreen.visible = false;
    return;
  }
  const d = m.endScreen.data;
  if (!d || d.kind === 'preview') {
    const lead = m.round.left > m.round.right ? 'left' : m.round.right > m.round.left ? 'right' : null;
    m.endScreen.data = snapshotEnd(m, 'preview', lead);
  }
  m.endScreen.visible = true;
}

/* ------------------------------------------------------------------ annuler */

/* Avant chaque action importante, on garde une copie de l'état : « Annuler » revient en arrière (20 pas). */
function remember(history, m) {
  history.push(JSON.stringify(m));
  if (history.length > 20) history.shift();
}

/* Remplace tout le contenu de `m` par `next`, en gardant les presets de `m` (ils ne font pas partie du match). */
function replaceMatch(m, next) {
  const presets = m.presets;
  for (const k of Object.keys(m)) delete m[k];
  Object.assign(m, next, { presets });
}

function undo(history, m) {
  const prev = history.pop();
  if (!prev) return false;
  replaceMatch(m, JSON.parse(prev));
  return true;
}

/* Remet les réglages d'origine ; les presets sont conservés. */
function resetMatch(m) {
  replaceMatch(m, defaultMatch());
}

/* Remplace le match par l'exemple (voir demoMatch). */
function loadDemo(m, now) {
  replaceMatch(m, demoMatch(now));
}

/* ------------------------------------------------------------------ presets */

function cleanPreset(p) {
  if (!isObj(p)) return null;
  const id = str(p.id, 32).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return null;
  return { id, name: str(p.name, 40), tag: str(p.tag, 4).toUpperCase(), sub: str(p.sub, 24), logo: imageUrl(p.logo) };
}

/* ------------------------------------------------------------ état pour les pages */

/* `now` sert à synchroniser le chrono : la page calcule le temps restant à partir de l'heure du serveur. */
function publicState(m, now) {
  return {
    ...clone(m),
    now,
    derived: {
      need: seriesNeeded(m),
      mapHint: mapWinnerOf({ left: m.round.left, right: m.round.right }),
      matchWinner: matchWinner(m),
    },
  };
}

/* ------------------------------------------------------------------ exemple */

/* Un match d'exemple (équipes et joueurs fictifs) pour essayer l'overlay sans rien saisir. */
function demoMatch(now) {
  const m = defaultMatch();
  const P = (name, agent, kills, deaths, assists, credits, extra = {}) => ({ name, agent, alive: true, kills, deaths, assists, credits, ult: false, ...extra });
  applyPatch(m, {
    event: { name: 'Champions de démonstration', stage: 'Finale' },
    format: 3,
    teams: {
      left: { name: 'Alpha', tag: 'ALP', sub: 'AMER #1' },
      right: { name: 'Omega', tag: 'OME', sub: 'EMEA #4' },
    },
    series: { left: 1, right: 0 },
    round: { number: 17, left: 9, right: 7, phase: 'live' },
    maps: [
      { name: 'Split', pick: 'left' },
      { name: 'Lotus', pick: 'right' },
      { name: 'Haven', pick: 'decider' },
    ],
    mapIndex: 1,
    players: {
      left: [
        P('Nova', 'Jett', 14, 9, 3, 4700, { ult: true }),
        P('Pixel', 'Sova', 9, 8, 7, 3200),
        P('Rift', 'Omen', 8, 10, 6, 2650, { alive: false }),
        P('Echo', 'Killjoy', 11, 7, 4, 3900),
        P('Zen', 'Sage', 6, 9, 11, 1800, { alive: false }),
      ],
      right: [
        P('Blaze', 'Reyna', 15, 12, 2, 5400, { ult: true }),
        P('Ghost', 'Fade', 8, 11, 8, 2950),
        P('Hawk', 'Astra', 7, 11, 9, 2300, { alive: false }),
        P('Lynx', 'Cypher', 9, 10, 5, 3600),
        P('Onyx', 'Clove', 10, 9, 6, 4150),
      ],
    },
  });
  m.maps[0].result = { left: 13, right: 9, winner: 'left' };
  timerSet(m, 93, true, now);
  return m;
}

module.exports = {
  FORMATS,
  SIDES,
  PHASES,
  TEAM_SIZE,
  MAX_MAPS,
  START_CREDITS,
  ROUNDS_TO_WIN,
  PHASE_SECONDS,
  defaultMatch,
  applyPatch,
  normalize,
  timerRemaining,
  timerSet,
  timerPause,
  timerResume,
  timerReset,
  startPhase,
  mapWinnerOf,
  seriesNeeded,
  matchWinner,
  resetPlayers,
  roundWon,
  swapSides,
  computeMvp,
  snapshotEnd,
  endMap,
  showEndScreen,
  remember,
  undo,
  replaceMatch,
  resetMatch,
  loadDemo,
  cleanPreset,
  publicState,
  demoMatch,
  imageUrl,
  str,
};
