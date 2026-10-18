'use strict';

/*
 * Simulateur de partie : produit des données au même format que
 * https://127.0.0.1:2999/liveclientdata/allgamedata, pour régler l'overlay
 * sans lancer League of Legends.
 */

// spells : sorts d'invocateur ; runes : [rune principale, arbre secondaire] (identifiants de Data Dragon).
const ROSTER = {
  ORDER: [
    { name: 'Kestrel', champ: 'Aatrox', raw: 'Aatrox', pos: 'TOP', build: [1054, 3047, 3071, 6333, 3053, 3065], spells: ['SummonerFlash', 'SummonerTeleport'], runes: [8010, 8400] },
    { name: 'Brumelot', champ: 'Lee Sin', raw: 'LeeSin', pos: 'JUNGLE', build: [1036, 3111, 6692, 3071, 3053, 6333], spells: ['SummonerFlash', 'SummonerSmite'], runes: [8112, 8000] },
    { name: 'Oriane', champ: 'Ahri', raw: 'Ahri', pos: 'MIDDLE', build: [1056, 3020, 6655, 3157, 3089, 3135], spells: ['SummonerFlash', 'SummonerDot'], runes: [8229, 8300] },
    { name: 'Vexis', champ: 'Jinx', raw: 'Jinx', pos: 'BOTTOM', build: [1055, 3006, 6672, 3031, 3046, 3036], spells: ['SummonerFlash', 'SummonerHeal'], runes: [8008, 8100] },
    { name: 'Tidou', champ: 'Thresh', raw: 'Thresh', pos: 'UTILITY', build: [3858, 3117, 3190, 3109, 3107, 3050], spells: ['SummonerFlash', 'SummonerExhaust'], runes: [8439, 8300] },
  ],
  CHAOS: [
    { name: 'Morrow', champ: 'Renekton', raw: 'Renekton', pos: 'TOP', build: [1055, 3047, 6692, 3071, 3053, 6333], spells: ['SummonerFlash', 'SummonerDot'], runes: [8010, 8400] },
    { name: 'Sable', champ: 'Viego', raw: 'Viego', pos: 'JUNGLE', build: [1036, 3111, 3153, 3071, 6333, 3053], spells: ['SummonerFlash', 'SummonerSmite'], runes: [8010, 8100] },
    { name: 'Nyx Arden', champ: 'Orianna', raw: 'Orianna', pos: 'MIDDLE', build: [1056, 3020, 6653, 3157, 3089, 3135], spells: ['SummonerFlash', 'SummonerTeleport'], runes: [8229, 8000] },
    { name: 'Pilou', champ: "Kai'Sa", raw: 'Kaisa', pos: 'BOTTOM', build: [1055, 3006, 3124, 3115, 3089, 3153], spells: ['SummonerFlash', 'SummonerHeal'], runes: [9923, 8200] },
    { name: 'Garance', champ: 'Nautilus', raw: 'Nautilus', pos: 'UTILITY', build: [3858, 3047, 3190, 3109, 3050, 3075], spells: ['SummonerFlash', 'SummonerExhaust'], runes: [8465, 8300] },
  ],
};

// Noms (en français) des sorts et des runes de la démo, comme le jeu les renvoie.
const SPELL_NAMES = {
  SummonerFlash: 'Saut éclair',
  SummonerDot: 'Embrasement',
  SummonerTeleport: 'Téléportation',
  SummonerSmite: 'Châtiment',
  SummonerHeal: 'Soins',
  SummonerExhaust: 'Fatigue',
};
const RUNE_NAMES = {
  8010: 'Conquérant',
  8112: 'Électrocution',
  8229: 'Comète arcanique',
  8008: 'Tempo mortel',
  8439: 'Séisme',
  9923: 'Rafale de lames',
  8465: 'Gardien',
  8000: 'Précision',
  8100: 'Domination',
  8200: 'Sorcellerie',
  8300: 'Inspiration',
  8400: 'Volonté',
};
const demoSpell = (key) => ({
  displayName: SPELL_NAMES[key],
  rawDescription: `GeneratedTip_SummonerSpell_${key}_Description`,
  rawDisplayName: `GeneratedTip_SummonerSpell_${key}_DisplayName`,
});
const demoRune = (id) => ({ displayName: RUNE_NAMES[id], id, rawDescription: `perk_tooltip_${id}`, rawDisplayName: `perk_displayname_${id}` });

const PRICES = {
  1054: 450, 1055: 450, 1056: 400, 1036: 350, 3858: 400, 3047: 1200, 3111: 1250, 3020: 1100, 3006: 1100, 3117: 1000,
  3071: 3000, 6333: 3000, 3053: 3200, 3065: 2900, 6692: 3100, 6655: 2900, 3157: 3250, 3089: 3600, 3135: 3000,
  6672: 3100, 3031: 3450, 3046: 2650, 3036: 3000, 3190: 2200, 3109: 2300, 3107: 2300, 3050: 2200, 3153: 3200,
  6653: 3000, 3124: 3000, 3115: 3000, 3075: 2700,
};

// Générateur pseudo-aléatoire reproductible.
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

const DRAGON_TYPES = ['Fire', 'Water', 'Earth', 'Air', 'Hextech', 'Chemtech'];

class DemoGame {
  constructor({ speed = 12, start = 0, spectator = false, seed = 7 } = {}) {
    this.speed = speed;
    this.startAt = start;
    this.spectator = spectator;
    this.seed = seed;
    this.reset();
  }

  reset() {
    this.rand = rng(this.seed++);
    this.realStart = Date.now();
    this.t = 0;
    this.events = [];
    this.nextId = 0;
    this.endAt = 1900 + Math.floor(this.rand() * 400);
    this.endedRealAt = null;
    this.offlineUntil = null;
    this.nextDragon = 300;
    this.nextBaron = 1200;
    this.heraldDone = false;
    this.grubsDone = false;
    this.towers = { ORDER: 0, CHAOS: 0 };
    this.inhibs = { ORDER: 0, CHAOS: 0 };
    this.lastKill = {};
    this.firstBlood = false;
    this.players = {};
    for (const team of ['ORDER', 'CHAOS']) {
      this.players[team] = ROSTER[team].map((r) => ({ ...r, team, k: 0, d: 0, a: 0, dead: 0 }));
    }
    this.push('GameStart', {});
    // Avance jusqu'au point de départ demandé.
    this.advanceTo(this.startAt);
    this.realStart = Date.now() - (this.startAt / this.speed) * 1000;
  }

  push(name, data) {
    this.events.push({ EventID: this.nextId++, EventName: name, EventTime: this.t, ...data });
  }

  alive(team) {
    return this.players[team].filter((p) => p.dead <= 0);
  }

  pick(list, weights) {
    const total = list.reduce((s, _, i) => s + (weights ? weights[i] : 1), 0);
    let r = this.rand() * total;
    for (let i = 0; i < list.length; i++) {
      r -= weights ? weights[i] : 1;
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  level(t) {
    return Math.min(18, 1 + Math.floor(Math.sqrt(t / 60) * 3.0));
  }

  winnerTeam() {
    return this.towers.ORDER >= this.towers.CHAOS ? 'ORDER' : 'CHAOS';
  }

  step() {
    this.t += 1;
    const t = this.t;
    for (const team of ['ORDER', 'CHAOS']) for (const p of this.players[team]) if (p.dead > 0) p.dead -= 1;

    if (t === 65) this.push('MinionsSpawning', {});

    // Escarmouches : un peu plus fréquentes en milieu de partie.
    const killRate = t < 180 ? 0 : t < 840 ? 1 / 45 : 1 / 28;
    if (this.rand() < killRate) this.skirmish();

    // Larves du Néant et Héraut.
    if (!this.grubsDone && t > 380 && this.rand() < 0.02) {
      this.grubsDone = true;
      const team = this.rand() < 0.6 ? 'ORDER' : 'CHAOS';
      const jg = this.players[team][1];
      for (let i = 0; i < 3; i++) this.push('HordeKill', { KillerName: jg.name, Assisters: [], Stolen: 'False' });
    }
    if (!this.heraldDone && t > 900 && this.rand() < 0.02) {
      this.heraldDone = true;
      const team = this.rand() < 0.5 ? 'ORDER' : 'CHAOS';
      this.push('HeraldKill', { KillerName: this.players[team][1].name, Assisters: [], Stolen: 'False' });
    }

    // Dragons.
    if (t >= this.nextDragon && this.rand() < 0.04) {
      const team = this.rand() < 0.58 ? 'ORDER' : 'CHAOS';
      const killer = this.pick(this.players[team], [1, 4, 1, 1, 1]);
      const counts = this.events.filter((e) => e.EventName === 'DragonKill' && e.DragonType !== 'Elder');
      const own = counts.filter((e) => this.teamOf(e.KillerName) === team).length;
      const type = own >= 4 ? 'Elder' : DRAGON_TYPES[Math.floor(this.rand() * DRAGON_TYPES.length)];
      const stolen = this.rand() < 0.08 ? 'True' : 'False';
      this.push('DragonKill', { DragonType: type, Stolen: stolen, KillerName: killer.name, Assisters: [] });
      this.nextDragon = t + 300;
    }

    // Baron.
    if (t >= this.nextBaron && this.rand() < 0.02) {
      const team = this.rand() < 0.6 ? 'ORDER' : 'CHAOS';
      this.push('BaronKill', { Stolen: 'False', KillerName: this.players[team][1].name, Assisters: [] });
      this.nextBaron = t + 360;
    }

    // Tours puis inhibiteurs.
    if (t > 780 && this.rand() < (t > 1500 ? 1 / 70 : 1 / 130)) {
      const team = this.rand() < 0.57 ? 'ORDER' : 'CHAOS';
      if (this.towers[team] < 11) {
        this.towers[team]++;
        const enemyT = team === 'ORDER' ? 'T2' : 'T1';
        const lanes = ['L', 'C', 'R'];
        const turret = `Turret_${enemyT}_${lanes[Math.floor(this.rand() * 3)]}_0${this.towers[team]}_A`;
        if (!this.events.some((e) => e.EventName === 'FirstBrick')) this.push('FirstBrick', { KillerName: this.players[team][0].name });
        this.push('TurretKilled', { TurretKilled: turret, KillerName: this.players[team][0].name, Assisters: [] });
        if (this.towers[team] >= 6 && this.inhibs[team] < 3 && this.rand() < 0.4) {
          this.inhibs[team]++;
          this.push('InhibKilled', { InhibKilled: `Barracks_${enemyT}_L${this.inhibs[team]}`, KillerName: this.players[team][0].name, Assisters: [] });
        }
      }
    }

    if (t >= this.endAt && !this.endedRealAt) {
      const w = this.winnerTeam();
      const meTeam = 'ORDER';
      this.push('GameEnd', { Result: w === meTeam ? 'Win' : 'Lose' });
      this.endedRealAt = Date.now();
    }
  }

  teamOf(name) {
    for (const team of ['ORDER', 'CHAOS']) if (this.players[team].some((p) => p.name === name)) return team;
    return null;
  }

  skirmish() {
    const team = this.rand() < 0.55 ? 'ORDER' : 'CHAOS';
    const enemy = team === 'ORDER' ? 'CHAOS' : 'ORDER';
    const attackers = this.alive(team);
    if (!attackers.length) return;
    const fights = 1 + (this.rand() < 0.3 ? 1 : 0) + (this.rand() < 0.12 ? 1 : 0) + (this.rand() < 0.04 ? 2 : 0);
    for (let i = 0; i < fights; i++) {
      const victims = this.alive(enemy);
      if (!victims.length) break;
      const killer = this.pick(attackers, attackers.map((p) => (p.pos === 'UTILITY' ? 0.4 : p.pos === 'BOTTOM' || p.pos === 'MIDDLE' ? 2 : 1)));
      const victim = this.pick(victims);
      const assisters = attackers.filter((p) => p !== killer && this.rand() < 0.45);
      killer.k++;
      victim.d++;
      assisters.forEach((p) => p.a++);
      victim.dead = Math.round(6 + this.level(this.t) * 2.2 + this.t / 120);
      if (!this.firstBlood) {
        this.firstBlood = true;
        this.push('FirstBlood', { Recipient: killer.name });
      }
      this.push('ChampionKill', { KillerName: killer.name, VictimName: victim.name, Assisters: assisters.map((p) => p.name) });
      const last = this.lastKill[killer.name];
      if (last && this.t - last.t <= 10) {
        last.n++;
        if (last.n >= 2) this.push('Multikill', { KillerName: killer.name, KillStreak: last.n });
      } else {
        this.lastKill[killer.name] = { t: this.t, n: 1 };
      }
      this.lastKill[killer.name].t = this.t;
      if (!this.alive(enemy).length) this.push('Ace', { Acer: killer.name, AcingTeam: team });
    }
  }

  advanceTo(target) {
    while (this.t < target && !this.endedRealAt) this.step();
  }

  itemsFor(p) {
    const t = this.t;
    const done = Math.min(6, Math.floor(t / 330));
    const items = [];
    if (t < 1100) items.push({ id: p.build[0], slot: 0 });
    let slot = items.length;
    for (let i = 1; i <= done && slot < 6; i++) items.push({ id: p.build[i], slot: slot++ });
    if (slot < 6 && t > 200) items.push({ id: 1036, slot: slot++ });
    const list = items.map((i) => ({
      itemID: i.id,
      slot: i.slot,
      count: 1,
      price: PRICES[i.id] || 300,
      consumable: false,
      canUse: false,
      displayName: String(i.id),
    }));
    list.push({ itemID: p.pos === 'UTILITY' ? 3364 : 3340, slot: 6, count: 1, price: 0, consumable: false, displayName: 'Trinket' });
    if (t > 120) list.push({ itemID: 2055, slot: Math.min(5, slot), count: 1, price: 75, consumable: true, displayName: 'Balise de contrôle' });
    return list;
  }

  csFor(p) {
    const m = this.t / 60;
    const rate = { TOP: 7.4, JUNGLE: 6.1, MIDDLE: 8, BOTTOM: 8.6, UTILITY: 1.1 }[p.pos];
    return Math.max(0, Math.round((m - 1.5) * rate));
  }

  snapshot() {
    const now = Date.now();
    if (this.offlineUntil) {
      if (now < this.offlineUntil) return null;
      this.offlineUntil = null;
      this.startAt = 0;
      this.reset();
    }
    if (this.endedRealAt) {
      if (now - this.endedRealAt > 9000) {
        this.offlineUntil = now + 15000;
        this.endedRealAt = null;
        return null;
      }
    } else {
      const target = Math.floor(((now - this.realStart) / 1000) * this.speed);
      this.advanceTo(target);
    }

    const allPlayers = [];
    for (const team of ['ORDER', 'CHAOS']) {
      for (const p of this.players[team]) {
        allPlayers.push({
          championName: p.champ,
          rawChampionName: 'game_character_displayname_' + p.raw,
          isBot: false,
          isDead: p.dead > 0,
          respawnTimer: Math.max(0, p.dead),
          items: this.itemsFor(p),
          level: this.level(this.t),
          position: p.pos,
          riotId: p.name + '#EUW',
          riotIdGameName: p.name,
          riotIdTagLine: 'EUW',
          summonerName: p.name + '#EUW',
          scores: { kills: p.k, deaths: p.d, assists: p.a, creepScore: this.csFor(p), wardScore: Math.round((this.t / 60) * (p.pos === 'UTILITY' ? 2.4 : 0.7)) },
          summonerSpells: { summonerSpellOne: demoSpell(p.spells[0]), summonerSpellTwo: demoSpell(p.spells[1]) },
          runes: { keystone: demoRune(p.runes[0]), secondaryRuneTree: demoRune(p.runes[1]) },
          team,
        });
      }
    }
    const me = this.players.ORDER[3];
    return {
      activePlayer: this.spectator
        ? { error: 'Spectator mode does not support this feature' }
        : { riotId: me.name + '#EUW', riotIdGameName: me.name, summonerName: me.name + '#EUW', level: this.level(this.t), currentGold: 820 },
      allPlayers,
      events: { Events: this.events },
      gameData: { gameMode: 'CLASSIC', gameTime: this.t + 0.4, mapName: 'Map11', mapNumber: 11, mapTerrain: 'Default' },
    };
  }
}

module.exports = { DemoGame };
