'use strict';

/*
 * Serveur local de l'overlay League of Legends.
 *
 *  - lit la Live Client Data API du jeu (https://127.0.0.1:2999) chaque seconde ;
 *  - redistribue l'état à l'overlay et au panneau de contrôle (Server-Sent Events) ;
 *  - garde la configuration (équipes, série, affichage…) dans data/config.json.
 *
 * Aucune dépendance : uniquement des modules natifs de Node.js.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const { computeGame, computeMvp, indexFromRunes, spellCooldown } = require('./lib/game');
const { DemoGame } = require('./lib/demo');
const { normalizeDraft, indexFromDdragon, indexFromClientSummary } = require('./lib/draft');
const { LcuClient } = require('./lib/lcu');
const { DemoDraft, DEMO_CHAMPS } = require('./lib/demo-draft');

/*
 * Version .exe : le programme est un « exécutable unique » Node.js (SEA). Les pages de
 * public/ sont alors embarquées dans l'exécutable et data/ vit à côté du fichier .exe.
 */
let sea = null;
try {
  sea = require('node:sea');
} catch (_) {
  /* Node.js plus ancien que 20.12 : pas d'exécutable unique possible, rien à gérer. */
}
const IS_SEA = !!(sea && sea.isSea());

/* ------------------------------------------------------------------ options */

// Avec « node server.js » ou le .exe serveur, argv = [programme, script, ...options].
// Dans l'application de bureau empaquetée (Electron), il n'y a pas de script : argv = [exe, ...options].
const IS_PACKAGED_ELECTRON = !!process.versions.electron && !process.defaultApp;
const args = process.argv.slice(IS_PACKAGED_ELECTRON ? 1 : 2);
const hasFlag = (name) => args.includes('--' + name);
const numOpt = (name, def) => {
  const a = args.find((x) => x.startsWith('--' + name + '='));
  const n = a ? Number(a.split('=')[1]) : NaN;
  return Number.isFinite(n) ? n : def;
};

const DEMO = hasFlag('demo');
const DEMO_SPEED = Math.max(1, numOpt('speed', 12));
const DEMO_START = Math.max(0, numOpt('start', 0));
const DEMO_SPECTATOR = hasFlag('spectator');
// --draft : la démo ne simule que la sélection des champions (picks et bans), en boucle, sans partie.
// --full : démo complète : sélection des champions, puis partie, puis écran de fin, puis on recommence.
const DEMO_FULL = DEMO && hasFlag('full');
const DEMO_DRAFT = DEMO && (hasFlag('draft') || DEMO_FULL);
// Lecture des picks et bans dans le client LoL ; --no-lcu (ou NO_LCU=1) la désactive.
const LCU_ENABLED = !DEMO && !hasFlag('no-lcu') && !process.env.NO_LCU;

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

const GAME_API = { host: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata' };
const VERSIONS_URL = 'https://ddragon.leagueoflegends.com/api/versions.json';

// Réglages : dossier OVERLAY_DATA_DIR s'il est défini (application de bureau), sinon « data »
// à côté du .exe serveur, ou à côté de server.js.
const ROOT = IS_SEA ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.OVERLAY_DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/* ---------------------------------------------------------------------- log */

const pad = (n) => String(n).padStart(2, '0');
function log(msg) {
  const d = new Date();
  console.log(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${msg}`);
}
const clock = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
const sideName = (side) => (side === 'ORDER' ? 'bleue' : 'rouge');

/* ------------------------------------------------------------ configuration */

const DEFAULT_CONFIG = {
  teams: {
    blue: { name: 'Équipe bleue', tag: 'BLU', logo: '' },
    red: { name: 'Équipe rouge', tag: 'RED', logo: '' },
  },
  series: { format: 3, blue: 0, red: 0, autoCount: true },
  // players: null = automatique (affiché seulement en mode spectateur).
  // draft : affiche les picks et bans pendant la sélection des champions.
  // sides : les champions de chaque équipe sur les côtés de l'écran.
  // mapFrame : un cadre autour de la minimap du jeu (en bas à droite) ; mapSize : son côté, en pixels (écran de 1920×1080).
  display: { mode: 'player', scoreboard: true, feed: true, banners: true, players: null, sides: true, mapFrame: true, mapSize: 280, sponsors: true, draft: true, scale: 1 },
  sponsors: [],
  sponsorInterval: 12,
  presets: [],
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
/* Une image est soit un fichier envoyé au serveur, soit une adresse http(s). */
function imageUrl(v) {
  const s = str(v, 500);
  if (!s) return '';
  if (/^\/uploads\/[a-f0-9]{8,64}\.(png|jpg|webp|gif)$/.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

function applyConfigPatch(cfg, p) {
  if (!isObj(p)) return;

  if (isObj(p.teams)) {
    for (const k of ['blue', 'red']) {
      const t = p.teams[k];
      if (!isObj(t)) continue;
      if ('name' in t) cfg.teams[k].name = str(t.name, 40);
      if ('tag' in t) cfg.teams[k].tag = str(t.tag, 4).toUpperCase();
      if ('logo' in t) cfg.teams[k].logo = imageUrl(t.logo);
    }
  }

  if (isObj(p.series)) {
    const s = p.series;
    if ('format' in s && [1, 3, 5, 7].includes(Number(s.format))) cfg.series.format = Number(s.format);
    if ('blue' in s) cfg.series.blue = int(s.blue, 0, 9, cfg.series.blue);
    if ('red' in s) cfg.series.red = int(s.red, 0, 9, cfg.series.red);
    if ('autoCount' in s) cfg.series.autoCount = !!s.autoCount;
  }

  if (isObj(p.display)) {
    const d = p.display;
    if ('mode' in d && ['player', 'spectator'].includes(d.mode)) cfg.display.mode = d.mode;
    for (const k of ['scoreboard', 'feed', 'banners', 'sides', 'mapFrame', 'sponsors', 'draft']) if (k in d) cfg.display[k] = !!d[k];
    if ('mapSize' in d) cfg.display.mapSize = int(d.mapSize, 160, 480, cfg.display.mapSize);
    if ('players' in d) cfg.display.players = d.players === null ? null : !!d.players;
    if ('scale' in d) {
      const n = Number(d.scale);
      if (Number.isFinite(n)) cfg.display.scale = Math.round(Math.min(1.5, Math.max(0.5, n)) * 100) / 100;
    }
  }

  if (Array.isArray(p.sponsors)) {
    cfg.sponsors = p.sponsors
      .filter(isObj)
      .slice(0, 8)
      .map((s) => ({ text: str(s.text, 80), image: imageUrl(s.image) }));
  }
  if ('sponsorInterval' in p) cfg.sponsorInterval = int(p.sponsorInterval, 3, 120, cfg.sponsorInterval);
}

function cleanPreset(p) {
  if (!isObj(p)) return null;
  const id = str(p.id, 32).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return null;
  return { id, name: str(p.name, 40), tag: str(p.tag, 4).toUpperCase(), logo: imageUrl(p.logo) };
}

function loadConfig() {
  const cfg = clone(DEFAULT_CONFIG);
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') log(`Lecture de data/config.json impossible : ${e.message}`);
    return { cfg, created: e.code === 'ENOENT' };
  }
  try {
    const saved = JSON.parse(raw);
    applyConfigPatch(cfg, saved);
    if (Array.isArray(saved.presets)) cfg.presets = saved.presets.map(cleanPreset).filter(Boolean).slice(0, 30);
  } catch (e) {
    log(`data/config.json illisible (${e.message}) : copie dans config.json.bak, configuration par défaut utilisée.`);
    try {
      fs.writeFileSync(CONFIG_FILE + '.bak', raw);
    } catch (_) {
      /* tant pis */
    }
  }
  return { cfg, created: false };
}

let config;
function saveConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    log(`Sauvegarde de data/config.json impossible : ${e.message}`);
  }
}

/* -------------------------------------------------------------------- état */

const S = {
  status: 'waiting', // waiting | loading | ingame | ended
  apiUp: false,
  ddragon: null,
  gameId: 0,
  signature: '',
  lastGameTime: -1,
  game: null, // dernière partie lue (gardée quand l'API disparaît)
  lastGame: null, // instantané de la dernière partie terminée
  endScreenVisible: false,
  gameAt: 0, // heure (Date.now) de la dernière lecture du jeu
  // Chronos de recharge des sorts, lancés à la main : « équipe:joueur:sort » → { endAt (heure de jeu), total }.
  cooldowns: {},
  cosmic: {}, // « équipe:joueur » → Perspicacité cosmique (-18 % de recharge)
  // Sélection des champions (picks et bans)
  draft: null, // sélection en cours, déjà mise en forme
  lastDraft: null, // dernière sélection vue (affichable à la demande)
  lastRawDraft: null, // dernière réponse brute du client, pour le diagnostic
  draftMode: 'auto', // auto | show | hide
  lcuConnected: false,
};

// Champions : { id → { key, name } }, rempli par Data Dragon puis, à défaut, par le client.
let champs = new Map();

const slotOf = (g, side) => ((side === 'ORDER') !== g.flipped ? 'blue' : 'red');
const sideOfSlot = (g, slot) => ((slot === 'blue') !== g.flipped ? 'ORDER' : 'CHAOS');

function recordGame(game) {
  S.lastGame = {
    gameId: S.gameId,
    at: Date.now(),
    gameTime: game.gameTime,
    spectator: game.spectator,
    winner: null,
    mvp: computeMvp({ winner: null, teams: game.teams }),
    teams: game.teams,
    flipped: false, // devient vrai quand on échange les côtés après la partie
    counted: null, // case de la série qui a reçu la victoire
  };
  return S.lastGame;
}

function uncount(g) {
  if (g.counted) {
    config.series[g.counted] = Math.max(0, config.series[g.counted] - 1);
    g.counted = null;
  }
}

/* Fixe le vainqueur d'une partie terminée et met la série à jour si l'option est active. */
function setWinner(g, side, { count = true } = {}) {
  if (g.winner === side && (g.counted || !count || !config.series.autoCount)) return;
  uncount(g);
  g.winner = side;
  g.mvp = computeMvp({ winner: side, teams: g.teams });
  if (count && config.series.autoCount) {
    const slot = slotOf(g, side);
    config.series[slot] = Math.min(9, config.series[slot] + 1);
    g.counted = slot;
  }
  saveConfig();
}

function applyManualWinner(w) {
  let target = null;
  if (S.lastGame && S.lastGame.gameId === S.gameId) target = S.lastGame;
  else if (S.game && (S.game.ended || S.status !== 'ingame')) target = recordGame(S.game);
  else if (S.lastGame) target = S.lastGame;
  else if (S.game) target = recordGame(S.game);
  if (!target) return null;
  const side = w === 'ORDER' || w === 'CHAOS' ? w : sideOfSlot(target, w);
  setWinner(target, side);
  log(`Vainqueur fixé à la main : victoire ${sideName(side)}.`);
  return target;
}

function previewOf(game) {
  return {
    gameId: S.gameId,
    gameTime: game.gameTime,
    spectator: game.spectator,
    winner: null,
    mvp: computeMvp({ winner: null, teams: game.teams }),
    teams: game.teams,
    flipped: false,
    preview: true,
  };
}

/* Picks et bans : « auto » les montre pendant la sélection (si l'option d'affichage est cochée), « show » force l'affichage (la dernière sélection au besoin), « hide » les cache. */
function draftState() {
  const shown = S.draftMode === 'show' ? S.draft || S.lastDraft : S.draftMode === 'auto' && config.display.draft ? S.draft : null;
  return {
    mode: S.draftMode,
    live: !!S.draft,
    lcu: { enabled: LCU_ENABLED || DEMO_DRAFT, connected: DEMO_DRAFT || S.lcuConnected },
    visible: !!shown,
    data: shown,
  };
}

/* Heure de jeu estimée à cet instant (la dernière lecture du jeu date d'une seconde au plus). */
function gameClock() {
  if (!S.game) return 0;
  const running = S.status === 'ingame';
  return S.game.gameTime + (running ? Math.min((Date.now() - S.gameAt) / 1000, 1.2) * (DEMO ? DEMO_SPEED : 1) : 0);
}

/* Durée (en secondes) que prendrait chaque sort s'il était lancé maintenant : le panneau l'affiche avant le clic. */
function spellTotals() {
  const out = {};
  if (!S.game) return out;
  for (const team of ['ORDER', 'CHAOS']) {
    for (const p of S.game.teams[team].players) {
      for (const slot of [0, 1]) {
        if (p.spells[slot]) out[`${team}:${p.index}:${slot}`] = spellCooldown(p, slot, !!S.cosmic[`${team}:${p.index}`]);
      }
    }
  }
  return out;
}

function publicState() {
  const live = S.status === 'ingame' || S.status === 'ended';
  const last = S.lastGame;
  let endGame = null;
  if (S.endScreenVisible) endGame = last || (S.game ? previewOf(S.game) : null);
  return {
    draft: draftState(),
    status: S.status,
    demo: DEMO,
    clockRate: DEMO ? DEMO_SPEED : 1,
    ddragon: S.ddragon,
    gameId: S.gameId,
    game: live ? S.game : null,
    cooldowns: S.cooldowns,
    cosmic: S.cosmic,
    spellTotals: live ? spellTotals() : {},
    hasGame: !!S.game,
    last: last ? { gameId: last.gameId, winner: last.winner, flipped: last.flipped, counted: last.counted } : null,
    endScreen: { visible: S.endScreenVisible },
    endGame,
    config,
  };
}

/* ------------------------------------------------------------ lecture du jeu */

function fetchLive() {
  return new Promise((resolve) => {
    const req = https.get(
      { ...GAME_API, rejectUnauthorized: false, agent: false, headers: { Accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', () => resolve({ error: 'read' }));
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode !== 200) return resolve({ status: res.statusCode });
          try {
            resolve({ status: 200, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (_) {
            resolve({ status: 500 });
          }
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ error: 'timeout' });
    }, 800);
    req.on('error', () => {
      clearTimeout(timer);
      resolve({ error: 'unreachable' });
    });
  });
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
  });
}

async function loadDdragonVersion(first) {
  try {
    const list = await fetchJson(VERSIONS_URL, 5000);
    S.ddragon = Array.isArray(list) && typeof list[0] === 'string' ? list[0] : null;
  } catch (_) {
    S.ddragon = null;
  }
  if (S.ddragon) {
    log(`Data Dragon : version ${S.ddragon} (icônes des champions, des objets et des runes).`);
    loadChampions();
    loadRunes();
  } else {
    if (first) log('Data Dragon injoignable : l\'overlay affichera des initiales à la place des icônes. Nouvel essai dans 1 minute.');
    setTimeout(() => loadDdragonVersion(false), 60000).unref();
  }
  broadcast();
}

/* Noms (en français) et icônes des champions, pour les picks et bans. */
async function loadChampions() {
  try {
    const idx = indexFromDdragon(await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${S.ddragon}/data/fr_FR/champion.json`, 8000));
    if (!idx.size) throw new Error('liste vide');
    champs = DEMO ? new Map([...idx, ...DEMO_CHAMPS]) : idx; // en démo, la table de démonstration reste la référence
    log(`Champions : ${idx.size} chargés depuis Data Dragon.`);
  } catch (_) {
    setTimeout(loadChampions, 60000).unref();
  }
}

/* Images des runes : { identifiant → { name, icon } }, remplies par Data Dragon (l'overlay les demande à /api/runes). */
let runeIndex = {};
async function loadRunes() {
  try {
    const idx = indexFromRunes(await fetchJson(`https://ddragon.leagueoflegends.com/cdn/${S.ddragon}/data/fr_FR/runesReforged.json`, 8000));
    const n = Object.keys(idx).length;
    if (!n) throw new Error('liste vide');
    runeIndex = idx;
    log(`Runes : ${n} chargées depuis Data Dragon.`);
  } catch (_) {
    setTimeout(loadRunes, 60000).unref();
  }
}

/* ----------------------------------------------- sélection des champions (picks et bans) */

const lcu = LCU_ENABLED ? new LcuClient() : null;
let demoDraft = null;
let championSummaryTry = 0;

function setLcuConnected(on) {
  if (S.lcuConnected === on) return;
  S.lcuConnected = on;
  log(on ? 'Client LoL détecté : lecture des picks et bans activée.' : 'Client LoL introuvable ou fermé : picks et bans en pause.');
}

/* Réponse brute du client (ou de la démo) pour la sélection en cours, null s'il n'y en a pas. */
async function readDraftRaw() {
  if (DEMO_DRAFT) return demoDraft.snapshot();
  if (!lcu) return null;
  if (!(await lcu.connect())) {
    setLcuConnected(false);
    return null;
  }
  try {
    // Hors ligne, Data Dragon manque : la liste des champions du client sert de secours.
    if (!champs.size && Date.now() - championSummaryTry > 30000) {
      championSummaryTry = Date.now();
      const sum = await lcu.get('/lol-game-data/assets/v1/champion-summary.json', 5000).catch(() => null);
      if (sum && sum.status === 200) champs = indexFromClientSummary(sum.data);
    }
    const r = await lcu.get('/lol-champ-select/v1/session');
    if (r.status === 401) throw new Error('identifiants refusés');
    setLcuConnected(true);
    return r.status === 200 ? r.data : null; // 404 : pas de sélection en cours
  } catch (_) {
    lcu.reset();
    setLcuConnected(false);
    return null;
  }
}

function handleDraft(raw) {
  const d = raw ? normalizeDraft(raw, champs) : null;
  if (d && !S.draft) {
    S.endScreenVisible = false; // une nouvelle sélection commence : l'écran de fin de la partie précédente s'efface
    log(`Sélection des champions détectée${d.spectating ? ' (en spectateur)' : ''}.`);
  }
  if (!d && S.draft) log('Sélection des champions terminée.');
  S.draft = d;
  if (d) {
    S.lastDraft = d;
    S.lastRawDraft = raw;
  }
}

async function tickDraft() {
  try {
    handleDraft(await readDraftRaw());
    broadcast();
  } catch (e) {
    log(`Erreur de lecture de la sélection des champions : ${e.stack || e.message}`);
  }
  setTimeout(tickDraft, 1000);
}

function setStatus(status) {
  if (S.status === status) return;
  const prev = S.status;
  S.status = status;
  if (status === 'loading' && prev !== 'loading') log('Partie en cours de chargement…');
}

function onApiDown() {
  if (S.apiUp) log('API du jeu injoignable : en attente d\'une partie.');
  S.apiUp = false;
  setStatus('waiting');
}

function onGame(raw) {
  const game = computeGame(raw);
  const first = S.gameId === 0;
  const isNew = first || game.signature !== S.signature || game.gameTime < S.lastGameTime - 5;

  if (isNew) {
    S.gameId += 1;
    S.signature = game.signature;
    S.endScreenVisible = false;
    S.cooldowns = {};
    S.cosmic = {};
    log(`Partie détectée : ${game.spectator ? 'mode spectateur' : `mode joueur (${game.activeName || '?'})`}, ${clock(game.gameTime)}.`);
  }
  S.lastGameTime = game.gameTime;
  S.game = game;
  S.gameAt = Date.now();
  for (const [k, c] of Object.entries(S.cooldowns)) if (c.endAt < game.gameTime - 3) delete S.cooldowns[k];
  setStatus(game.ended ? 'ended' : 'ingame');

  const recorded = S.lastGame && S.lastGame.gameId === S.gameId;
  if (game.ended && !recorded) {
    const g = recordGame(game);
    if (game.winner) {
      if (first) {
        // Serveur lancé après la fin de la partie : on ne recompte pas et on n'affiche rien.
        setWinner(g, game.winner, { count: false });
        log(`Partie déjà terminée au lancement (victoire ${sideName(game.winner)}), série inchangée.`);
      } else {
        setWinner(g, game.winner);
        S.endScreenVisible = true;
        log(`Fin de partie à ${clock(game.gameTime)} : victoire ${sideName(game.winner)}.`);
      }
    } else {
      log(`Fin de partie à ${clock(game.gameTime)}. Vainqueur inconnu en mode spectateur : utilisez « Victoire bleue » ou « Victoire rouge » dans le panneau.`);
    }
  }
}

let demo = null;

/*
 * Partie simulée. Avec --full, elle ne démarre qu'une fois la sélection des champions terminée, et
 * quand la partie s'éteint (fin de partie, écran de fin), on enchaîne sur une nouvelle sélection.
 */
let demoPhase = 'draft';
let demoGameUp = false;
let demoOfflineSince = 0;
function demoGameRaw() {
  if (!DEMO_FULL) return demo ? demo.snapshot() : null; // --draft : pas de partie ; démo seule : la partie
  if (demoPhase === 'draft') {
    if (!demoDraft.finished) return null;
    demoPhase = 'game';
    demo = new DemoGame({ speed: DEMO_SPEED, start: DEMO_START, spectator: DEMO_SPECTATOR });
    demoGameUp = false;
    demoOfflineSince = 0;
  }
  const raw = demo.snapshot();
  if (raw) {
    demoGameUp = true;
    demoOfflineSince = 0;
    return raw;
  }
  if (demoGameUp) {
    demoGameUp = false;
    demoOfflineSince = Date.now();
  }
  if (demoOfflineSince && Date.now() - demoOfflineSince > 12000) {
    demoPhase = 'draft';
    demo = null;
    demoDraft.reset();
    demoOfflineSince = 0;
  }
  return null;
}

function handle(res) {
  if (res.error) return onApiDown();
  if (!S.apiUp) {
    S.apiUp = true;
    log(DEMO ? 'Mode démo : données simulées.' : 'API du jeu détectée sur https://127.0.0.1:2999.');
  }
  const raw = res.data;
  if (res.status !== 200 || !raw || !Array.isArray(raw.allPlayers) || raw.allPlayers.length === 0) {
    return setStatus('loading');
  }
  onGame(raw);
}

async function tick() {
  try {
    if (DEMO) {
      const raw = demoGameRaw();
      handle(raw ? { status: 200, data: raw } : { error: 'demo' });
    } else {
      handle(await fetchLive());
    }
    broadcast();
  } catch (e) {
    log(`Erreur de lecture de la partie : ${e.stack || e.message}`);
  }
  setTimeout(tick, 1000);
}

/* ---------------------------------------------------------------------- SSE */

const clients = new Set();
let lastJson = '';

function broadcast(force) {
  const json = JSON.stringify(publicState());
  if (!force && json === lastJson) return;
  lastJson = json;
  for (const res of clients) res.write(`data: ${json}\n\n`);
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15000).unref();

/* --------------------------------------------------------------------- HTTP */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const MOUNTS = {
  '/overlay': path.join(PUBLIC_DIR, 'overlay'),
  '/control': path.join(PUBLIC_DIR, 'control'),
  '/shared': path.join(PUBLIC_DIR, 'shared'),
  '/uploads': UPLOAD_DIR,
};

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
const fail = (res, code, message) => sendJson(res, code, { error: message });

/* Sert une page embarquée dans l'exécutable (clés « public/overlay/index.html », etc.). */
function serveAsset(req, res, mount, rel) {
  const clean = path.posix.normalize(rel);
  if (clean.includes('..')) {
    fail(res, 403, 'Accès refusé.');
    return true;
  }
  let data;
  try {
    data = Buffer.from(sea.getAsset('public' + mount + clean));
  } catch (_) {
    fail(res, 404, 'Fichier introuvable.');
    return true;
  }
  const ext = path.extname(clean).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': ext === '.woff2' ? 'public, max-age=86400' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}

function serveStatic(req, res, pathname) {
  const mount = Object.keys(MOUNTS).find((m) => pathname === m || pathname.startsWith(m + '/'));
  if (!mount) return false;
  const root = MOUNTS[mount];
  let rel = pathname.slice(mount.length);
  if (rel === '' || rel === '/') rel = '/index.html';
  try {
    rel = decodeURIComponent(rel);
  } catch (_) {
    fail(res, 400, 'Adresse invalide.');
    return true;
  }
  if (IS_SEA && mount !== '/uploads') return serveAsset(req, res, mount, rel);
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) {
    fail(res, 403, 'Accès refusé.');
    return true;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Fichier introuvable.');
    const ext = path.extname(file).toLowerCase();
    const cache =
      mount === '/uploads' ? 'public, max-age=31536000, immutable' : ext === '.woff2' ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Requête trop volumineuse.'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(Object.assign(new Error('JSON invalide.'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/*
 * Les routes qui modifient quelque chose n'acceptent que du JSON venant d'une page servie
 * par ce serveur : une page web quelconque ouverte dans votre navigateur ne peut pas piloter l'overlay.
 */
function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(':') ||
    host === os.hostname().toLowerCase() ||
    host.endsWith('.local')
  );
}

function writeGuard(req) {
  if (!hostAllowed(req.headers.host)) return 'Hôte non autorisé.';
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return 'Origine non autorisée.';
    } catch (_) {
      return 'Origine invalide.';
    }
  }
  if (req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return 'Content-Type application/json requis.';
  }
  return null;
}

const IMAGE_TYPES = {
  png: { ext: 'png', magic: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  jpeg: { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpg: { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { ext: 'webp', magic: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  gif: { ext: 'gif', magic: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
};
const MAX_UPLOAD = 5 * 1024 * 1024;

function saveUpload(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('Format d\'image non pris en charge (png, jpg, webp ou gif).'), { code: 400 });
  const kind = IMAGE_TYPES[m[1]];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_UPLOAD) throw Object.assign(new Error('Image trop lourde (5 Mo maximum).'), { code: 413 });
  if (!kind.magic(buf)) throw Object.assign(new Error('Le fichier n\'est pas une image valide.'), { code: 400 });
  const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '.' + kind.ext;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return '/uploads/' + name;
}

async function handleApi(req, res, pathname) {
  const method = req.method;

  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, publicState()), true;
  // Images des runes (vide tant que Data Dragon n'a pas répondu) : l'overlay les demande une fois, pas à chaque mise à jour.
  if (method === 'GET' && pathname === '/api/runes') return sendJson(res, 200, { runes: runeIndex }), true;
  // Dernière réponse brute du client pour la sélection des champions : sert à diagnostiquer (aucun identifiant dedans).
  if (method === 'GET' && pathname === '/api/draft/raw') {
    if (!S.lastRawDraft) return fail(res, 404, 'Aucune sélection des champions vue pour l\'instant.'), true;
    return sendJson(res, 200, S.lastRawDraft), true;
  }
  if (method !== 'POST' && method !== 'DELETE') return false;

  const denied = writeGuard(req);
  if (denied) return fail(res, 403, denied), true;

  const limit = pathname === '/api/upload' ? Math.ceil(MAX_UPLOAD * 1.4) + 1024 : 64 * 1024;
  let body = {};
  if (method === 'POST') {
    try {
      body = await readBody(req, limit);
    } catch (e) {
      return fail(res, e.code || 400, e.message), true;
    }
  }
  const done = () => {
    broadcast();
    sendJson(res, 200, publicState());
    return true;
  };

  if (method === 'POST') {
    switch (pathname) {
      case '/api/config':
        applyConfigPatch(config, body);
        saveConfig();
        return done();

      case '/api/series': {
        const side = body.side === 'red' ? 'red' : body.side === 'blue' ? 'blue' : null;
        const delta = Math.round(Number(body.delta));
        if (!side || !Number.isFinite(delta)) return fail(res, 400, 'Paramètres invalides (side, delta).'), true;
        config.series[side] = Math.min(9, Math.max(0, config.series[side] + delta));
        saveConfig();
        return done();
      }

      case '/api/series/reset':
        config.series.blue = 0;
        config.series.red = 0;
        if (S.lastGame) S.lastGame.counted = null;
        saveConfig();
        return done();

      // Remet les réglages d'origine (équipes, série, affichage, sponsors) ; les presets sont conservés.
      case '/api/reset': {
        const presets = config.presets;
        config = clone(DEFAULT_CONFIG);
        config.presets = presets;
        S.endScreenVisible = false;
        S.draftMode = 'auto';
        if (S.lastGame) S.lastGame.counted = null;
        saveConfig();
        log('Tous les réglages ont été réinitialisés (les presets sont conservés).');
        return done();
      }

      case '/api/swap': {
        const { blue, red } = config.teams;
        config.teams.blue = red;
        config.teams.red = blue;
        [config.series.blue, config.series.red] = [config.series.red, config.series.blue];
        if (S.lastGame) {
          S.lastGame.flipped = !S.lastGame.flipped;
          if (S.lastGame.counted) S.lastGame.counted = S.lastGame.counted === 'blue' ? 'red' : 'blue';
        }
        saveConfig();
        log('Côtés échangés : les équipes et leurs scores ont changé de couleur.');
        return done();
      }

      // Chrono de recharge d'un sort d'invocateur : start | clear | add (±secondes) | cosmic (on) | clearAll.
      case '/api/cooldown': {
        if (body.action === 'clearAll') {
          S.cooldowns = {};
          return done();
        }
        if (!S.game) return fail(res, 409, 'Aucune partie en cours.'), true;
        const team = body.team === 'CHAOS' || body.team === 'red' ? 'CHAOS' : body.team === 'ORDER' || body.team === 'blue' ? 'ORDER' : null;
        const index = Number(body.index);
        const slot = Number(body.slot);
        const p = team && Number.isInteger(index) ? S.game.teams[team].players.find((x) => x.index === index) : null;
        if (!p) return fail(res, 400, 'Joueur inconnu.'), true;
        const who = `${team}:${index}`;
        const key = `${who}:${slot}`;
        switch (body.action) {
          case 'cosmic':
            if (body.on) S.cosmic[who] = true;
            else delete S.cosmic[who];
            break;
          case 'start': {
            if (![0, 1].includes(slot) || !p.spells[slot]) return fail(res, 400, 'Ce joueur n\'a pas ce sort.'), true;
            const total = spellCooldown(p, slot, !!S.cosmic[who]);
            S.cooldowns[key] = { endAt: gameClock() + total, total };
            break;
          }
          case 'clear':
            delete S.cooldowns[key];
            break;
          case 'add': {
            if (!S.cooldowns[key]) return fail(res, 409, 'Aucun chrono en cours pour ce sort.'), true;
            S.cooldowns[key].endAt += int(body.seconds, -120, 120, 0);
            break;
          }
          default:
            return fail(res, 400, 'Action invalide (start, clear, add, cosmic ou clearAll).'), true;
        }
        return done();
      }

      case '/api/draft': {
        if (!['auto', 'show', 'hide'].includes(body.mode)) return fail(res, 400, 'Mode invalide (auto, show ou hide).'), true;
        S.draftMode = body.mode;
        return done();
      }

      case '/api/endscreen': {
        const w = body.winner;
        if (w != null) {
          if (!['ORDER', 'CHAOS', 'blue', 'red'].includes(w)) return fail(res, 400, 'Vainqueur invalide.'), true;
          if (!applyManualWinner(w)) return fail(res, 409, 'Aucune partie à terminer pour l\'instant.'), true;
          S.endScreenVisible = body.visible !== false;
        } else if (typeof body.visible === 'boolean') {
          if (body.visible && !S.lastGame && !S.game) return fail(res, 409, 'Aucune partie à afficher pour l\'instant.'), true;
          S.endScreenVisible = body.visible;
        } else {
          return fail(res, 400, 'Paramètres invalides (visible, winner).'), true;
        }
        return done();
      }

      case '/api/upload': {
        try {
          return sendJson(res, 200, { url: saveUpload(body.dataUrl) }), true;
        } catch (e) {
          return fail(res, e.code || 500, e.message), true;
        }
      }

      case '/api/presets': {
        if (config.presets.length >= 30) return fail(res, 409, 'Trop de presets (30 maximum).'), true;
        const name = str(body.name, 40);
        if (!name) return fail(res, 400, 'Le preset a besoin d\'un nom.'), true;
        config.presets.push({
          id: crypto.randomBytes(6).toString('hex'),
          name,
          tag: str(body.tag, 4).toUpperCase(),
          logo: imageUrl(body.logo),
        });
        saveConfig();
        return done();
      }
      default:
        return false;
    }
  }

  const m = /^\/api\/presets\/([A-Za-z0-9_-]{1,32})$/.exec(pathname);
  if (method === 'DELETE' && m) {
    const before = config.presets.length;
    config.presets = config.presets.filter((p) => p.id !== m[1]);
    if (config.presets.length === before) return fail(res, 404, 'Preset introuvable.'), true;
    saveConfig();
    return done();
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (_) {
    return fail(res, 400, 'Adresse invalide.');
  }
  try {
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(302, { Location: '/control' });
      return res.end();
    }
    if (req.method === 'GET' && pathname === '/events') return handleEvents(req, res);
    if (pathname.startsWith('/api/') && (await handleApi(req, res, pathname))) return;
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, pathname)) return;
    fail(res, 404, 'Introuvable.');
  } catch (e) {
    log(`Erreur serveur : ${e.stack || e.message}`);
    if (!res.headersSent) fail(res, 500, 'Erreur interne.');
    else res.end();
  }
});

/* ---------------------------------------------------------------- démarrage */

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

/* Dans l'exécutable, la fenêtre se ferme toute seule en cas d'erreur : on attend donc une touche pour laisser lire. */
function exitAfterError() {
  if (!IS_SEA) process.exit(1);
  console.error('Appuyez sur Entrée pour fermer cette fenêtre.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch (_) {
    /* ouvrir le navigateur n'est qu'un confort */
  }
}

/* Démarre le serveur. La promesse est rejetée si le port est pris (voir startErrorMessage). */
function start() {
  return new Promise((resolve, reject) => {
    if (IS_SEA && process.platform === 'win32') {
      // La console Windows n'est pas en UTF-8 par défaut : sans ça, les accents s'affichent de travers.
      try {
        spawnSync('cmd', ['/c', 'chcp 65001 >nul'], { stdio: 'inherit' });
      } catch (_) {
        /* tant pis pour les accents */
      }
    }
    if (IS_SEA) process.title = 'Overlay League of Legends';

    const loaded = loadConfig();
    config = loaded.cfg;
    if (loaded.created) {
      saveConfig();
      log('Première utilisation : data/config.json créé.');
    }

    if (DEMO) champs = new Map(DEMO_CHAMPS); // la démo connaît ses champions, même sans Internet
    if (DEMO_DRAFT) demoDraft = new DemoDraft({ speed: DEMO_SPEED, spectator: DEMO_SPECTATOR, loop: !DEMO_FULL });
    else if (DEMO) demo = new DemoGame({ speed: DEMO_SPEED, start: DEMO_START, spectator: DEMO_SPECTATOR });

    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      server.off('error', reject);
      server.on('error', (e) => log(`Erreur du serveur : ${e.message}`));
      const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
      console.log('');
      console.log('  Overlay League of Legends : serveur démarré');
      console.log(`  Panneau de contrôle : http://${shown}:${PORT}/control`);
      console.log(`  Overlay pour OBS    : http://${shown}:${PORT}/overlay   (source navigateur 1920×1080)`);
      if (HOST === '0.0.0.0') {
        for (const ip of lanAddresses()) console.log(`  Sur le réseau       : http://${ip}:${PORT}/overlay`);
      }
      if (DEMO_FULL) {
        console.log(`  MODE DÉMO COMPLET : sélection des champions, partie, écran de fin, puis on recommence (vitesse ×${DEMO_SPEED}${DEMO_SPECTATOR ? ', spectateur' : ''})`);
      } else if (DEMO_DRAFT) {
        console.log(`  MODE DÉMO : sélection des champions en boucle, vitesse ×${DEMO_SPEED}${DEMO_SPECTATOR ? ', spectateur' : ''}`);
      } else if (DEMO) {
        console.log(`  MODE DÉMO : vitesse ×${DEMO_SPEED}, départ à ${clock(DEMO_START)}${DEMO_SPECTATOR ? ', spectateur' : ''}`);
      } else if (LCU_ENABLED) {
        console.log('  Picks et bans     : lus dans le client LoL pendant la sélection des champions');
      }
      if (IS_SEA) console.log('  Fermez cette fenêtre pour arrêter le programme.');
      console.log('');
      loadDdragonVersion(true);
      tick();
      if (DEMO_DRAFT || LCU_ENABLED) tickDraft();
      resolve({ host: HOST, port: PORT, demo: DEMO });
    });
  });
}

/* Message en français pour une erreur de démarrage (port pris, etc.). */
function startErrorMessage(e) {
  if (e && e.code === 'EADDRINUSE') {
    return (
      `Le port ${PORT} est déjà utilisé (une autre instance tourne peut-être déjà).\n` +
      `Si le programme est déjà ouvert dans une autre fenêtre, utilisez celui-là : http://localhost:${PORT}/control\n` +
      'Sinon, fermez le programme qui utilise ce port, ou choisissez un autre port : « set PORT=3001 » puis relancez.'
    );
  }
  return `Impossible de démarrer le serveur : ${e && e.message ? e.message : e}`;
}

/* Lancement en ligne de commande (node server.js, start.bat, .exe serveur). */
function runCli() {
  process.on('SIGINT', () => {
    console.log('\nArrêt du serveur.');
    process.exit(0);
  });
  start()
    .then(() => {
      // Le .exe serveur ouvre le panneau dans le navigateur (option --no-open pour l'éviter) ; avec node, option --open.
      if (IS_SEA ? !hasFlag('no-open') : hasFlag('open')) openBrowser(`http://localhost:${PORT}/control`);
    })
    .catch((e) => {
      console.error('\n' + startErrorMessage(e) + '\n');
      exitAfterError();
    });
}

// Dans l'application de bureau (Electron), main.js importe ce fichier et appelle start() lui-même.
if (require.main === module || IS_SEA) runCli();

module.exports = { start, startErrorMessage };
