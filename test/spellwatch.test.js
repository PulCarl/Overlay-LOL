'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SpellWatch, EXPECTED_LUM, DEFAULT_LAYOUT, cleanLayout, cleanThreshold } = require('../lib/spellwatch.js');

// Les dix joueurs : deux sorts chacun, de quoi couvrir des icônes claires, moyennes et sombres.
const LINEUP = {
  ORDER: [['SummonerFlash', 'SummonerTeleport'], ['SummonerFlash', 'SummonerSmite'], ['SummonerFlash', 'SummonerDot'], ['SummonerFlash', 'SummonerHeal'], ['SummonerFlash', 'SummonerExhaust']],
  CHAOS: [['SummonerFlash', 'SummonerTeleport'], ['SummonerHaste', 'SummonerSmite'], ['SummonerFlash', 'SummonerBarrier'], ['SummonerFlash', 'SummonerBoost'], ['SummonerFlash', 'SummonerMana']],
};
const ids = [];
const spells = {};
for (const team of ['ORDER', 'CHAOS']) {
  LINEUP[team].forEach((pair, row) => pair.forEach((spell, slot) => {
    ids.push(`${team}:${row}:${slot}`);
    spells[`${team}:${row}:${slot}`] = spell;
  }));
}
const DARK = 0.35; // une icône en recharge garde environ un tiers de sa luminance (mesuré sur une capture du client)

/* Une image : chaque icône à sa luminance normale (× gain), sauf celles de `dark` (ids) assombries. */
function frame(dark = [], { gain = 0.9, clock = 0, dead } = {}) {
  const icons = {};
  for (const id of ids) icons[id] = { l: EXPECTED_LUM[spells[id]] * gain * (dark.includes(id) ? DARK : 1) };
  return { icons, spells, clock, dead: dead || new Set() };
}
const run = (w, dark, clock, extra) => w.observe(frame(dark, { clock, ...extra }));

test('une première lecture ne lance aucun chrono, même sur un sort sombre', () => {
  const w = new SpellWatch();
  const r = run(w, ['ORDER:1:1'], 100);
  assert.equal(r.valid, true);
  assert.deepEqual(r.events, []);
  assert.equal(r.view['ORDER:1:1'].state, 'cooldown');
  assert.equal(r.view['ORDER:0:0'].state, 'ready');
  assert.deepEqual(w.cooling(), ['ORDER:1:1']);
});

test('les icônes naturellement plus sombres ou plus claires ne sont pas prises pour des recharges', () => {
  const w = new SpellWatch();
  for (let t = 0; t < 10; t++) {
    const r = run(w, [], t, { gain: 0.8 + (t % 3) * 0.2 }); // l'éclairage de la vidéo varie
    assert.equal(r.valid, true);
    assert.deepEqual(r.events, []);
  }
  assert.deepEqual(w.cooling(), []);
});

test('un sort qui s\'assombrit lance un chrono, daté de la première image sombre', () => {
  const w = new SpellWatch();
  run(w, [], 60);
  run(w, [], 61);
  assert.deepEqual(run(w, ['ORDER:0:0'], 62).events, [], 'une seule image sombre ne suffit pas');
  const r = run(w, ['ORDER:0:0'], 62.5);
  assert.deepEqual(r.events, [{ type: 'start', id: 'ORDER:0:0', at: 62 }]);
  assert.equal(r.view['ORDER:0:0'].state, 'cooldown');
  assert.deepEqual(run(w, ['ORDER:0:0'], 63).events, [], 'pas de second départ');
});

test('une image sombre isolée (accident de vidéo) est ignorée', () => {
  const w = new SpellWatch();
  run(w, [], 10);
  run(w, ['CHAOS:2:1'], 11);
  const r = run(w, [], 11.5);
  assert.deepEqual(r.events, []);
  assert.equal(r.view['CHAOS:2:1'].state, 'ready');
});

test('le retour de l\'icône termine le chrono et donne la durée vue', () => {
  const w = new SpellWatch();
  run(w, [], 100);
  run(w, ['CHAOS:0:0'], 101);
  run(w, ['CHAOS:0:0'], 101.5);
  for (let t = 102; t < 400; t += 1) run(w, ['CHAOS:0:0'], t);
  run(w, [], 401);
  const r = run(w, [], 401.5);
  assert.deepEqual(r.events, [{ type: 'end', id: 'CHAOS:0:0', duration: 300 }]);
  assert.deepEqual(w.cooling(), []);
});

test('un sort déjà en recharge au départ finit sans durée connue', () => {
  const w = new SpellWatch();
  run(w, ['ORDER:3:1'], 500);
  run(w, ['ORDER:3:1'], 501);
  run(w, [], 502);
  const r = run(w, [], 502.5);
  assert.deepEqual(r.events, [{ type: 'end', id: 'ORDER:3:1', duration: null }]);
});

test('une interface absente (beaucoup d\'icônes sombres d\'un coup) ne déclenche rien', () => {
  const w = new SpellWatch();
  run(w, [], 10);
  const six = ids.slice(0, 6);
  const r = run(w, six, 11);
  assert.equal(r.valid, false);
  assert.deepEqual(r.events, []);
  const again = run(w, six, 11.5);
  assert.equal(again.valid, false);
  assert.deepEqual(w.cooling(), [], 'rien n\'a été retenu');
  assert.equal(run(w, [], 12).valid, true, 'l\'interface revient : on reprend');
});

test('un écran noir ou trop peu de cases lues sont refusés', () => {
  const w = new SpellWatch();
  const black = frame([], { gain: 0.01 });
  assert.equal(w.observe(black).valid, false);
  const few = frame();
  for (const id of ids.slice(4)) delete few.icons[id];
  assert.equal(w.observe(few).valid, false);
});

test('une bagarre assombrit les sorts un par un sans que l\'image soit refusée', () => {
  const w = new SpellWatch();
  run(w, [], 1);
  const used = [];
  const started = [];
  for (let i = 0; i < 12; i++) { // jusqu'à 12 sorts sur 20 en recharge
    used.push(ids[i]);
    const a = run(w, used, 10 + i * 2);
    const b = run(w, used, 10 + i * 2 + 0.5);
    assert.equal(a.valid && b.valid, true, `image valide avec ${used.length} sorts en recharge`);
    started.push(...b.events.map((e) => e.id));
  }
  assert.deepEqual(started, used, 'chaque sort a lancé son chrono, dans l\'ordre');
});

test('un joueur mort est ignoré, et sa recharge ne donne pas de durée', () => {
  const w = new SpellWatch();
  run(w, [], 100);
  run(w, ['ORDER:2:0'], 101);
  run(w, ['ORDER:2:0'], 101.5); // chrono lancé
  const dead = new Set(['ORDER:2']);
  // Mort : tout son panneau est sombre, y compris l'autre sort ; on ne retient rien.
  for (let t = 102; t < 130; t += 2) assert.deepEqual(run(w, ['ORDER:2:0', 'ORDER:2:1'], t, { dead }).events, []);
  // Il revient, son panneau est clair, le chrono du premier sort court toujours.
  for (let t = 130; t < 140; t += 2) run(w, ['ORDER:2:0'], t);
  run(w, [], 140);
  const r = run(w, [], 140.5);
  assert.deepEqual(r.events, [{ type: 'end', id: 'ORDER:2:0', duration: null }]);
  assert.equal(r.view['ORDER:2:1'].state, 'ready', 'l\'autre sort n\'a pas été pris pour une recharge');
});

test('si le jeu annonce un autre sort à cette place, la case repart de zéro', () => {
  const w = new SpellWatch();
  run(w, ['ORDER:0:1'], 10);
  assert.equal(w.view['ORDER:0:1'].state, 'cooldown');
  const f = frame([], { clock: 11 });
  f.spells = { ...spells, 'ORDER:0:1': 'SummonerHeal' };
  f.icons['ORDER:0:1'] = { l: EXPECTED_LUM.SummonerHeal * 0.9 };
  const r = w.observe(f);
  assert.equal(r.view['ORDER:0:1'].state, 'ready');
  assert.deepEqual(r.events, []);
});

test('reset oublie tout', () => {
  const w = new SpellWatch();
  run(w, ['ORDER:0:0'], 10);
  assert.deepEqual(w.cooling(), ['ORDER:0:0']);
  w.reset();
  assert.deepEqual(w.cooling(), []);
  assert.deepEqual(w.view, {});
});

test('la sensibilité décide à partir de quand une icône est en recharge', () => {
  const half = (threshold) => {
    const w = new SpellWatch({ threshold });
    const f = (clock) => {
      const x = frame([], { clock });
      x.icons['ORDER:0:0'] = { l: EXPECTED_LUM.SummonerFlash * 0.9 * 0.5 }; // moitié moins lumineuse
      return x;
    };
    w.observe(f(1));
    w.observe(f(2));
    return w.observe(f(3));
  };
  // Une icône à moitié de la normale, vue dès le départ : sombre si le seuil est à 0,7, claire s'il est à 0,4.
  assert.equal(half(0.7).view['ORDER:0:0'].state, 'cooldown');
  assert.equal(half(0.4).view['ORDER:0:0'].state, 'ready');
});

test('les réglages de position sont bornés et complétés', () => {
  assert.deepEqual(cleanLayout(null), DEFAULT_LAYOUT);
  const l = cleanLayout({ ORDER: { x: 5, y: -2, pitch: 'abc', size: 0.02 } });
  assert.equal(l.ORDER.x, 1);
  assert.equal(l.ORDER.y, 0);
  assert.equal(l.ORDER.pitch, DEFAULT_LAYOUT.ORDER.pitch, 'une valeur illisible garde l\'ancienne');
  assert.equal(l.ORDER.size, 0.02);
  assert.deepEqual(l.CHAOS, DEFAULT_LAYOUT.CHAOS);
  assert.equal(cleanThreshold(5), 0.85);
  assert.equal(cleanThreshold(0), 0.3);
  assert.equal(cleanThreshold('x'), 0.6);
});
