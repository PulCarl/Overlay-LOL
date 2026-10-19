'use strict';

/*
 * Transforme la réponse brute de la Live Client Data API
 * (https://127.0.0.1:2999/liveclientdata/allgamedata) en un état simple
 * que l'overlay sait afficher.
 *
 * ORDER = côté bleu, CHAOS = côté rouge.
 */

const POS_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

const DRAGONS = {
  Fire: { key: 'fire', label: 'le drake infernal' },
  Water: { key: 'water', label: 'le drake des océans' },
  Earth: { key: 'earth', label: 'le drake des montagnes' },
  Air: { key: 'air', label: 'le drake des nuages' },
  Hextech: { key: 'hextech', label: 'le drake hextech' },
  Chemtech: { key: 'chemtech', label: 'le drake chimtech' },
  Elder: { key: 'elder', label: 'le Dragon ancestral' },
};

const MULTIKILL = { 2: 'Double kill', 3: 'Triple kill', 4: 'Quadra kill', 5: 'Pentakill' };

const other = (team) => (team === 'ORDER' ? 'CHAOS' : 'ORDER');

function champKey(p) {
  const raw = p.rawChampionName || '';
  const m = raw.match(/displayname_(.+)$/i);
  if (m) return m[1];
  return (p.championName || '').replace(/[^A-Za-z]/g, '');
}

function playerName(p) {
  if (p.riotIdGameName) return p.riotIdGameName;
  if (p.riotId) return String(p.riotId).split('#')[0];
  return p.summonerName || p.championName || '?';
}

/*
 * Sorts d'invocateur et runes : le jeu les donne pour les dix joueurs (mais pas leurs temps de
 * recharge, ni leurs points de vie ou leur mana, qui ne sont connus que pour le joueur local).
 */

/* « GeneratedTip_SummonerSpell_SummonerFlash_DisplayName » → « SummonerFlash », le nom de l'image dans Data Dragon. */
function spellKey(s) {
  const m = String((s && s.rawDisplayName) || '').match(/SummonerSpell_(.+)_DisplayName$/);
  let key = m ? m[1] : '';
  key = key.replace(/^S\d+_/, '').replace(/Upgrade$/, ''); // téléportation améliorée
  if (/^SummonerSmite/.test(key)) key = 'SummonerSmite'; // châtiments bleu et rouge
  return /^[A-Za-z0-9_]+$/.test(key) ? key : '';
}

function normalizeSpells(p) {
  const ss = p.summonerSpells || {};
  return [ss.summonerSpellOne, ss.summonerSpellTwo]
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({ key: spellKey(s), name: String(s.displayName || '').slice(0, 40) }))
    .filter((s) => s.key || s.name);
}

function runeRef(r) {
  const id = r && Number(r.id);
  return Number.isInteger(id) && id > 0 ? { id, name: String(r.displayName || '').slice(0, 40) } : null;
}

/* La rune principale (keystone) et l'arbre secondaire suffisent pour reconnaître une page de runes. */
function normalizeRunes(p) {
  const r = p.runes || {};
  return { keystone: runeRef(r.keystone), secondary: runeRef(r.secondaryRuneTree) };
}

/*
 * Images des runes : runesReforged.json de Data Dragon → { id → { name, icon } }, arbres et runes mélangés
 * (leurs identifiants ne se recoupent pas). `icon` est un chemin à ajouter à /cdn/img/.
 */
function indexFromRunes(trees) {
  const idx = {};
  for (const t of Array.isArray(trees) ? trees : []) {
    if (Number.isInteger(t.id) && t.icon) idx[t.id] = { name: String(t.name || ''), icon: String(t.icon) };
    for (const slot of t.slots || []) {
      for (const r of slot.runes || []) {
        if (Number.isInteger(r.id) && r.icon) idx[r.id] = { name: String(r.name || ''), icon: String(r.icon) };
      }
    }
  }
  return idx;
}

/*
 * Recharge des sorts d'invocateur. Le jeu ne dit jamais quand un sort est lancé : le chrono se lance à la
 * main depuis le panneau, avec la durée calculée ici. Valeurs de base en secondes (elles changent avec les
 * saisons) ; la haste des sorts (bottes de lucidité : 12, Perspicacité cosmique : 18) raccourcit la recharge
 * de 100 / (100 + haste).
 */
const SPELL_COOLDOWN = {
  SummonerFlash: 300,
  SummonerDot: 180,
  SummonerTeleport: 360,
  SummonerHeal: 240,
  SummonerExhaust: 210,
  SummonerHaste: 210,
  SummonerBarrier: 180,
  SummonerBoost: 210,
  SummonerSmite: 90,
  SummonerMana: 240,
  SummonerSnowball: 80,
};
const DEFAULT_SPELL_COOLDOWN = 180;
const BOOTS_OF_LUCIDITY = 3158;
const HASTE_BOOTS = 12;
const HASTE_COSMIC = 18;

function spellHaste(player, cosmic) {
  const boots = (player.items || []).some((i) => i.id === BOOTS_OF_LUCIDITY);
  return (boots ? HASTE_BOOTS : 0) + (cosmic ? HASTE_COSMIC : 0);
}

/* Recharge, en secondes, du sort n° `slot` (0 ou 1) d'un joueur ; 0 s'il n'a pas ce sort. */
function spellCooldown(player, slot, cosmic) {
  const spell = (player.spells || [])[slot];
  if (!spell) return 0;
  const base = SPELL_COOLDOWN[spell.key] || DEFAULT_SPELL_COOLDOWN;
  return Math.round((base * 100) / (100 + spellHaste(player, cosmic)));
}

function normalizePlayer(p, index) {
  const items = Array.isArray(p.items) ? p.items : [];
  const main = items
    .filter((i) => i.slot !== 6)
    .sort((a, b) => a.slot - b.slot)
    .map((i) => ({ id: i.itemID, slot: i.slot, count: i.count || 1, name: i.displayName || '' }));
  const trinket = items.find((i) => i.slot === 6);
  const itemGold = items.reduce(
    (sum, i) => sum + (i.consumable ? 0 : (Number(i.price) || 0) * (i.count || 1)),
    0
  );
  const s = p.scores || {};
  return {
    index,
    name: playerName(p),
    riotId: p.riotId || '',
    summonerName: p.summonerName || '',
    champion: p.championName || '',
    champKey: champKey(p),
    team: p.team === 'CHAOS' ? 'CHAOS' : 'ORDER',
    position: p.position || '',
    level: p.level || 1,
    kills: s.kills || 0,
    deaths: s.deaths || 0,
    assists: s.assists || 0,
    cs: s.creepScore || 0,
    wardScore: Math.round(s.wardScore || 0),
    isDead: !!p.isDead,
    respawn: Math.max(0, Math.ceil(p.respawnTimer || 0)),
    items: main,
    trinket: trinket ? trinket.itemID : null,
    itemGold,
    spells: normalizeSpells(p),
    runes: normalizeRunes(p),
  };
}

function sortTeam(list) {
  const allHavePos = list.length && list.every((p) => POS_ORDER.includes(p.position));
  if (!allHavePos) return list;
  return [...list].sort((a, b) => POS_ORDER.indexOf(a.position) - POS_ORDER.indexOf(b.position));
}

/* Retrouve un joueur à partir des différentes formes de nom que le jeu peut renvoyer. */
function buildIndex(players) {
  const idx = new Map();
  const add = (k, p) => {
    if (k) idx.set(String(k).toLowerCase(), p);
  };
  for (const p of players) {
    add(p.name, p);
    add(p.riotId, p);
    add(p.summonerName, p);
    if (p.riotId) add(String(p.riotId).split('#')[0], p);
  }
  return idx;
}

/* Équipe d'un tueur qui n'est pas forcément un champion (sbire, tour…). */
function teamOfActor(name, idx) {
  if (!name) return null;
  const p = idx.get(String(name).toLowerCase());
  if (p) return p.team;
  if (/T100/.test(name) || /_T1_/.test(name)) return 'ORDER';
  if (/T200/.test(name) || /_T2_/.test(name)) return 'CHAOS';
  return null;
}

/* Équipe propriétaire d'une structure (Turret_T1_…, Barracks_T2_…). */
function ownerOfStructure(name) {
  if (/_T1_/.test(name || '')) return 'ORDER';
  if (/_T2_/.test(name || '')) return 'CHAOS';
  return null;
}

function emptyStats() {
  return { kills: 0, towers: 0, inhibs: 0, dragons: [], elders: 0, barons: 0, heralds: 0, grubs: 0, atakhan: 0, itemGold: 0 };
}

function actorRef(name, idx) {
  const p = idx.get(String(name || '').toLowerCase());
  if (p) return { name: p.name, champKey: p.champKey, champion: p.champion, team: p.team };
  return { name: null, champKey: null, champion: null, team: teamOfActor(name, idx) };
}

/*
 * Parcourt tous les événements de la partie et reconstruit les stats d'équipe
 * et le fil d'actions. Recalculé entièrement à chaque lecture : c'est simple
 * et ça ne peut pas se désynchroniser.
 */
function processEvents(events, idx, activeTeam) {
  const stats = { ORDER: emptyStats(), CHAOS: emptyStats() };
  const feed = [];
  let winner = null;
  let ended = false;

  for (const ev of events) {
    const id = ev.EventID;
    const t = ev.EventTime || 0;
    const stolen = String(ev.Stolen).toLowerCase() === 'true';
    switch (ev.EventName) {
      case 'ChampionKill': {
        const killer = actorRef(ev.KillerName, idx);
        const victim = actorRef(ev.VictimName, idx);
        const team = killer.team || (victim.team ? other(victim.team) : null);
        feed.push({ id, t, kind: 'kill', team, killer, victim, assists: (ev.Assisters || []).length });
        break;
      }
      case 'FirstBlood': {
        const p = actorRef(ev.Recipient, idx);
        feed.push({ id, t, kind: 'firstblood', team: p.team, actor: p, banner: true });
        break;
      }
      case 'Multikill': {
        const p = actorRef(ev.KillerName, idx);
        const n = Number(ev.KillStreak) || 2;
        feed.push({ id, t, kind: 'multikill', team: p.team, actor: p, label: MULTIKILL[Math.min(5, n)] || 'Multikill', count: n, banner: n >= 3 });
        break;
      }
      case 'Ace': {
        const team = ev.AcingTeam === 'CHAOS' ? 'CHAOS' : ev.AcingTeam === 'ORDER' ? 'ORDER' : teamOfActor(ev.Acer, idx);
        feed.push({ id, t, kind: 'ace', team, banner: true });
        break;
      }
      case 'DragonKill': {
        const team = teamOfActor(ev.KillerName, idx);
        const d = DRAGONS[ev.DragonType] || { key: 'unknown', label: 'un dragon' };
        if (team) {
          if (d.key === 'elder') stats[team].elders++;
          else stats[team].dragons.push(d.key);
        }
        feed.push({ id, t, kind: 'dragon', team, dragon: d.key, label: d.label, stolen, actor: actorRef(ev.KillerName, idx), banner: true });
        break;
      }
      case 'BaronKill': {
        const team = teamOfActor(ev.KillerName, idx);
        if (team) stats[team].barons++;
        feed.push({ id, t, kind: 'baron', team, stolen, actor: actorRef(ev.KillerName, idx), banner: true });
        break;
      }
      case 'HeraldKill': {
        const team = teamOfActor(ev.KillerName, idx);
        if (team) stats[team].heralds++;
        feed.push({ id, t, kind: 'herald', team, stolen, actor: actorRef(ev.KillerName, idx), banner: true });
        break;
      }
      case 'HordeKill': {
        const team = teamOfActor(ev.KillerName, idx);
        if (team) stats[team].grubs++;
        break;
      }
      case 'AtakhanKill': {
        const team = teamOfActor(ev.KillerName, idx);
        if (team) stats[team].atakhan++;
        feed.push({ id, t, kind: 'atakhan', team, stolen, actor: actorRef(ev.KillerName, idx), banner: true });
        break;
      }
      case 'TurretKilled': {
        const owner = ownerOfStructure(ev.TurretKilled);
        const team = owner ? other(owner) : teamOfActor(ev.KillerName, idx);
        if (team) stats[team].towers++;
        feed.push({ id, t, kind: 'tower', team });
        break;
      }
      case 'InhibKilled': {
        const owner = ownerOfStructure(ev.InhibKilled);
        const team = owner ? other(owner) : teamOfActor(ev.KillerName, idx);
        if (team) stats[team].inhibs++;
        feed.push({ id, t, kind: 'inhib', team, banner: true });
        break;
      }
      case 'GameEnd': {
        ended = true;
        if (activeTeam && (ev.Result === 'Win' || ev.Result === 'Lose')) {
          winner = ev.Result === 'Win' ? activeTeam : other(activeTeam);
        }
        break;
      }
      default:
        break;
    }
  }
  return { stats, feed, winner, ended };
}

/* Indicateur de MVP volontairement simple et lisible : il sert à animer le stream, pas à juger. */
function mvpScore(p, teamKills) {
  const kp = teamKills > 0 ? (p.kills + p.assists) / teamKills : 0;
  const kda = (p.kills + p.assists) / Math.max(1, p.deaths);
  return kda * 2 + p.kills * 0.6 + kp * 6 + p.cs * 0.01 + p.wardScore * 0.04;
}

function computeMvp(game) {
  if (!game) return null;
  const pool = game.winner ? game.teams[game.winner].players : [...game.teams.ORDER.players, ...game.teams.CHAOS.players];
  let best = null;
  for (const p of pool) {
    const score = mvpScore(p, game.teams[p.team].stats.kills);
    if (!best || score > best.score) best = { ...p, score };
  }
  if (!best) return null;
  const tk = game.teams[best.team].stats.kills;
  best.killParticipation = tk ? Math.round(((best.kills + best.assists) / tk) * 100) : 0;
  return best;
}

function computeGame(raw) {
  const all = (raw.allPlayers || []).map(normalizePlayer);
  const idx = buildIndex(all);

  const ap = raw.activePlayer;
  const spectator = !ap || !!ap.error || !(ap.riotId || ap.summonerName || ap.riotIdGameName);
  let activeTeam = null;
  let activeName = null;
  if (!spectator) {
    const me = idx.get(String(ap.riotId || '').toLowerCase()) || idx.get(String(ap.summonerName || '').toLowerCase()) || idx.get(String(ap.riotIdGameName || '').toLowerCase());
    if (me) {
      activeTeam = me.team;
      activeName = me.name;
    }
  }

  const events = (raw.events && raw.events.Events) || [];
  const { stats, feed, winner, ended } = processEvents(events, idx, activeTeam);

  const teams = {};
  for (const side of ['ORDER', 'CHAOS']) {
    const players = sortTeam(all.filter((p) => p.team === side));
    stats[side].kills = players.reduce((s, p) => s + p.kills, 0);
    stats[side].itemGold = players.reduce((s, p) => s + p.itemGold, 0);
    teams[side] = { players, stats: stats[side] };
  }

  const gd = raw.gameData || {};
  const signature = all
    .map((p) => p.name + ':' + p.champKey)
    .sort()
    .join('|');

  return {
    gameTime: Math.max(0, gd.gameTime || 0),
    gameMode: gd.gameMode || '',
    spectator,
    activeTeam,
    activeName,
    teams,
    feed: feed.slice(-14),
    lastEventId: events.length ? events[events.length - 1].EventID : -1,
    winner,
    ended,
    signature,
  };
}

module.exports = { computeGame, computeMvp, other, spellKey, indexFromRunes, spellCooldown, spellHaste };
