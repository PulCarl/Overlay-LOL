'use strict';

/*
 * Lecture automatique des sorts d'invocateur : le jeu ne dit jamais quand un sort est lancé, mais le client
 * spectateur l'affiche à l'écran : dans les panneaux des joueurs (de chaque côté), l'icône d'un sort en recharge
 * est nettement assombrie. Le panneau de contrôle capture l'écran du jeu et envoie ici la luminance de chaque
 * icône ; ce fichier décide quels sorts sont en recharge et quand ils ont été lancés.
 *
 * Il ne touche ni au réseau ni à l'horloge : l'heure de jeu (`clock`, en secondes) est passée en argument,
 * pour pouvoir être testé seul.
 *
 * Une case est repérée par « ÉQUIPE:rang:sort » (rang 0 = panneau du haut, sort 0 = icône du haut).
 */

const SIDES = ['ORDER', 'CHAOS'];
const ROWS = 5;
const SLOTS = 2;

/*
 * Luminance moyenne (zone centrale, 0 à 1) de l'icône de chaque sort quand il est prêt. On ne s'en sert que pour savoir
 * ce que « normal » veut dire : les icônes ne sont pas toutes aussi claires. Saut éclair, Fantôme, Soins, Téléportation,
 * Barrière et Embrasement : mesurés sur une capture du client spectateur ; les autres : icônes de Data Dragon.
 */
const EXPECTED_LUM = {
  SummonerFlash: 0.63,
  SummonerDot: 0.516,
  SummonerTeleport: 0.455,
  SummonerHeal: 0.59,
  SummonerExhaust: 0.428,
  SummonerHaste: 0.4,
  SummonerBarrier: 0.585,
  SummonerBoost: 0.437,
  SummonerSmite: 0.579,
  SummonerMana: 0.439,
  SummonerSnowball: 0.726,
};
const DEFAULT_LUM = 0.5;

/*
 * Où sont les icônes, en fraction de l'image capturée : x et y = centre de l'icône du haut du premier panneau
 * (x en fraction de la largeur, y de la hauteur), pitch = distance verticale entre deux panneaux, gap = distance
 * entre les deux sorts d'un panneau (en fraction de la hauteur), size = côté d'une icône (en fraction de la largeur).
 * Valeurs de l'interface standard du client spectateur, mesurées sur une capture en 16:9.
 */
const DEFAULT_LAYOUT = {
  ORDER: { x: 0.00896, y: 0.14374, pitch: 0.09328, gap: 0.02256, size: 0.0113 },
  CHAOS: { x: 0.99157, y: 0.14374, pitch: 0.09328, gap: 0.02256, size: 0.0113 },
};

const RANGE = { x: [0, 1], y: [0, 1], pitch: [0.01, 0.3], gap: [0.004, 0.1], size: [0.003, 0.05] };
const DEFAULT_THRESHOLD = 0.6;
const THRESHOLD_RANGE = [0.3, 0.85];

const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/* Remet les réglages de position dans leurs bornes ; `input` peut ne contenir qu'un côté ou que certains champs. */
function cleanLayout(input, base = DEFAULT_LAYOUT) {
  const out = {};
  for (const side of SIDES) {
    const src = (input && input[side]) || {};
    out[side] = {};
    for (const k of Object.keys(RANGE)) out[side][k] = num(src[k], RANGE[k][0], RANGE[k][1], base[side][k]);
  }
  return out;
}

const cleanThreshold = (v, fallback = DEFAULT_THRESHOLD) => num(v, THRESHOLD_RANGE[0], THRESHOLD_RANGE[1], fallback);

/* Valeur qui a la part `q` des valeurs sous elle (0,5 : la médiane). */
const quantile = (list, q) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};
const median = (list) => quantile(list, 0.5);

const iconId = (team, row, slot) => `${team}:${row}:${slot}`;

class SpellWatch {
  /*
   * threshold : une icône est « en recharge » quand sa luminance tombe sous cette part de la normale ;
   * confirm : nombre de lectures de suite nécessaires pour changer d'état (une lecture isolée est un accident de vidéo).
   */
  constructor({ threshold = DEFAULT_THRESHOLD, confirm = 2 } = {}) {
    this.threshold = cleanThreshold(threshold);
    this.confirm = Math.max(1, confirm | 0);
    this.reset();
  }

  /* Nouvelle partie : on oublie tout. */
  reset() {
    this.icons = new Map();
    this.view = {};
    this.valid = false;
  }

  setThreshold(v) {
    this.threshold = cleanThreshold(v, this.threshold);
  }

  /*
   * icons  : { 'ORDER:0:0': { l } } luminance moyenne (0 à 1) de la zone centrale de chaque icône ;
   * spells : { 'ORDER:0:0': 'SummonerFlash' } le sort que le jeu annonce pour cette case (une case absente est ignorée) ;
   * dead   : ensemble des « ÉQUIPE:rang » des joueurs morts (leur panneau est grisé en entier, on n'en tire rien) ;
   * clock  : heure de jeu, en secondes.
   * Renvoie { valid, events, view } : view = { id: { state: 'ready' | 'cooldown' | 'unknown', ratio } } ;
   * events = [{ type: 'start', id, at } | { type: 'end', id, duration }] (duration : null si le lancement n'a pas été vu).
   */
  observe({ icons = {}, spells = {}, dead = new Set(), clock = 0 } = {}) {
    const ids = Object.keys(spells).filter((id) => icons[id] && Number.isFinite(icons[id].l));
    const alive = (id) => !dead.has(id.split(':').slice(0, 2).join(':'));

    // Le sort annoncé a changé (autre partie, autre joueur à cette place) : la case repart de zéro.
    for (const id of ids) {
      const icon = this.icons.get(id);
      if (icon && icon.spell !== spells[id]) this.icons.delete(id);
    }

    // « Normal » : ce que valent les icônes prêtes par rapport à ce qu'on attend de chaque sort (la vidéo est plus ou
    // moins lumineuse). On prend un rang haut plutôt que la médiane : en pleine bagarre, plus de la moitié des icônes
    // peuvent être sombres. Les joueurs morts ne comptent pas, leur panneau est assombri.
    const measured = ids.filter(alive);
    const raw = {};
    for (const id of measured) raw[id] = icons[id].l / (EXPECTED_LUM[spells[id]] || DEFAULT_LUM);
    const scale = quantile(measured.map((id) => raw[id]), 0.65);
    const blackScreen = median(measured.map((id) => icons[id].l)) < 0.04;
    if (measured.length < 6 || scale <= 0 || blackScreen) return this.finish(false, [], {});

    const ratio = {};
    for (const id of measured) {
      const icon = this.icons.get(id);
      ratio[id] = raw[id] / scale / (icon && icon.state === 'ready' ? icon.base : 1);
    }

    // L'interface n'est pas à l'écran (autre vue, pause, transition…) : beaucoup de sorts prêts s'assombrissent d'un
    // coup, ou presque tout est sombre. Une vraie bagarre, elle, assombrit les sorts un par un.
    const dark = measured.filter((id) => ratio[id] < this.threshold);
    const suddenly = dark.filter((id) => (this.icons.get(id) || {}).state === 'ready').length;
    if (suddenly >= 6 || dark.length >= Math.ceil(measured.length * 0.7)) return this.finish(false, [], {});

    const events = [];
    const view = {};
    for (const id of ids) {
      let icon = this.icons.get(id);
      if (!icon) {
        icon = { spell: spells[id], state: 'unknown', base: 1, hasBase: false, pending: 0, firstAt: 0, since: null, dirty: false };
        this.icons.set(id, icon);
      }
      if (!alive(id)) {
        icon.pending = 0;
        icon.dirty = true; // une mort pendant la recharge : la durée mesurée ne vaut plus rien
        view[id] = { state: icon.state, ratio: null };
        continue;
      }
      this.update(icon, id, ratio[id], clock, events);
      view[id] = { state: icon.state, ratio: Math.round(ratio[id] * 100) / 100 };
    }
    return this.finish(true, events, view);
  }

  update(icon, id, r, clock, events) {
    const cool = this.threshold;
    const ready = Math.min(0.95, cool + 0.1); // un peu au-dessus du seuil : une icône ne rebondit pas d'un état à l'autre
    if (icon.state === 'unknown') {
      // Première lecture : on ne sait pas depuis quand un sort sombre l'est, donc pas de chrono.
      if (r < cool) {
        icon.state = 'cooldown';
        icon.dirty = true;
      } else {
        icon.state = 'ready';
        icon.base = r;
        icon.hasBase = true;
      }
      return;
    }
    const want = icon.state === 'ready' ? (r < cool ? 'cooldown' : 'ready') : r > ready ? 'ready' : 'cooldown';
    if (want === icon.state) {
      icon.pending = 0;
      if (icon.state === 'ready') icon.base = icon.base * 0.9 + r * icon.base * 0.1; // r est déjà rapporté à base : on le remet à l'échelle
      return;
    }
    if (icon.pending === 0) icon.firstAt = clock;
    icon.pending++;
    if (icon.pending < this.confirm) return;
    icon.pending = 0;
    icon.state = want;
    if (want === 'cooldown') {
      icon.since = icon.firstAt;
      icon.dirty = false;
      events.push({ type: 'start', id, at: icon.firstAt });
    } else {
      const duration = icon.since != null && !icon.dirty ? Math.max(0, icon.firstAt - icon.since) : null;
      icon.since = null;
      icon.dirty = false;
      if (!icon.hasBase) {
        icon.base = Math.max(0.5, Math.min(1.6, r)); // r est ici rapporté à 1 : c'est le premier aspect « prêt » qu'on voit
        icon.hasBase = true;
      }
      events.push({ type: 'end', id, duration });
    }
  }

  finish(valid, events, view) {
    this.valid = valid;
    if (valid) this.view = view;
    return { valid, events, view: this.view };
  }

  /* Cases actuellement en recharge. */
  cooling() {
    return [...this.icons].filter(([, i]) => i.state === 'cooldown').map(([id]) => id);
  }
}

module.exports = { SpellWatch, DEFAULT_LAYOUT, DEFAULT_THRESHOLD, THRESHOLD_RANGE, EXPECTED_LUM, cleanLayout, cleanThreshold, iconId, SIDES, ROWS, SLOTS };
