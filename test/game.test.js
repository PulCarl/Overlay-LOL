'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeGame, spellKey, indexFromRunes, spellCooldown, spellHaste } = require('../lib/game.js');
const { DemoGame } = require('../lib/demo.js');

const demoPlayers = () => {
  const g = computeGame(new DemoGame({ speed: 12 }).snapshot());
  return [...g.teams.ORDER.players, ...g.teams.CHAOS.players];
};

test('chaque joueur de la démo a deux sorts d\'invocateur et des runes', () => {
  const players = demoPlayers();
  assert.equal(players.length, 10);
  for (const p of players) {
    assert.equal(p.spells.length, 2, p.name);
    assert.ok(p.spells.every((s) => /^Summoner[A-Za-z]+$/.test(s.key) && s.name), p.name);
    assert.ok(p.spells.some((s) => s.key === 'SummonerFlash'), `${p.name} a Saut éclair`);
    assert.ok(p.runes.keystone && Number.isInteger(p.runes.keystone.id) && p.runes.keystone.name, p.name);
    assert.ok(p.runes.secondary && Number.isInteger(p.runes.secondary.id) && p.runes.secondary.name, p.name);
  }
  assert.deepEqual(players[0].spells.map((s) => s.key), ['SummonerFlash', 'SummonerTeleport']);
  assert.equal(players[0].runes.keystone.id, 8010);
  assert.equal(players[0].runes.secondary.id, 8400);
});

test('le nom de l\'image d\'un sort se déduit du nom renvoyé par le jeu', () => {
  const key = (name) => spellKey({ rawDisplayName: `GeneratedTip_SummonerSpell_${name}_DisplayName` });
  assert.equal(key('SummonerFlash'), 'SummonerFlash');
  assert.equal(key('SummonerDot'), 'SummonerDot');
  assert.equal(key('S12_SummonerTeleportUpgrade'), 'SummonerTeleport', 'téléportation améliorée');
  assert.equal(key('SummonerSmiteAvatarUtility'), 'SummonerSmite', 'châtiments bleu et rouge');
  assert.equal(key('SummonerSmiteAvatarOffensive'), 'SummonerSmite');
  assert.equal(key('../../x'), '', 'un nom étrange est refusé');
  assert.equal(spellKey({}), '');
  assert.equal(spellKey(null), '');
  assert.equal(spellKey({ rawDisplayName: 'autre chose' }), '');
});

test('des sorts ou des runes absents (ancienne version, rediffusion) ne font rien planter', () => {
  const raw = new DemoGame({ speed: 12 }).snapshot();
  delete raw.allPlayers[0].summonerSpells;
  delete raw.allPlayers[0].runes;
  raw.allPlayers[1].summonerSpells = { summonerSpellOne: { displayName: 'Saut éclair' } }; // sans nom brut : on garde le nom
  raw.allPlayers[2].runes = { keystone: { id: 'pas un nombre' }, secondaryRuneTree: { id: -4 } };
  raw.allPlayers[3].summonerSpells = 'n\'importe quoi';
  const g = computeGame(raw);
  const byName = Object.fromEntries([...g.teams.ORDER.players, ...g.teams.CHAOS.players].map((p) => [p.name, p]));
  assert.deepEqual(byName.Kestrel.spells, []);
  assert.deepEqual(byName.Kestrel.runes, { keystone: null, secondary: null });
  assert.deepEqual(byName.Brumelot.spells, [{ key: '', name: 'Saut éclair' }]);
  assert.deepEqual(byName.Oriane.runes, { keystone: null, secondary: null });
  assert.deepEqual(byName.Vexis.spells, []);
});

test('la recharge d\'un sort dépend du sort, des bottes de lucidité et de la Perspicacité cosmique', () => {
  const player = (spellKeys, itemIds = []) => ({
    spells: spellKeys.map((key) => ({ key, name: key })),
    items: itemIds.map((id) => ({ id })),
  });
  const p = player(['SummonerFlash', 'SummonerTeleport']);
  assert.equal(spellCooldown(p, 0, false), 300);
  assert.equal(spellCooldown(p, 1, false), 360);
  assert.equal(spellCooldown(p, 0, true), 254, '18 de haste : 300 × 100 / 118');
  const boots = player(['SummonerFlash'], [3158, 1001]);
  assert.equal(spellHaste(boots, false), 12);
  assert.equal(spellCooldown(boots, 0, false), 268, '12 de haste : 300 × 100 / 112');
  assert.equal(spellHaste(boots, true), 30);
  assert.equal(spellCooldown(boots, 0, true), 231, '30 de haste : 300 × 100 / 130');
  assert.equal(spellCooldown(player(['SummonerSmite']), 0, false), 90);
  assert.equal(spellCooldown(player(['SortInconnu']), 0, false), 180, 'sort inconnu : durée par défaut');
  assert.equal(spellCooldown(player(['SummonerFlash']), 1, false), 0, 'pas de second sort');
  assert.equal(spellCooldown({}, 0, false), 0, 'joueur sans sorts');
});

test('les images des runes viennent de runesReforged.json de Data Dragon', () => {
  const idx = indexFromRunes([
    {
      id: 8100,
      key: 'Domination',
      icon: 'perk-images/Styles/7200_Domination.png',
      name: 'Domination',
      slots: [
        { runes: [{ id: 8112, key: 'Electrocute', icon: 'perk-images/Styles/Domination/Electrocute/Electrocute.png', name: 'Électrocution' }] },
        { runes: [{ id: 8126, icon: 'perk-images/Styles/Domination/CheapShot/CheapShot.png', name: 'Coup bas' }, { id: 1, name: 'sans icône' }] },
      ],
    },
    { id: 'texte', icon: 'x.png' },
    null,
  ].filter(Boolean));
  assert.deepEqual(Object.keys(idx).sort(), ['8100', '8112', '8126']);
  assert.equal(idx[8112].name, 'Électrocution');
  assert.equal(idx[8100].icon, 'perk-images/Styles/7200_Domination.png');
  assert.deepEqual(indexFromRunes(null), {});
  assert.deepEqual(indexFromRunes('rien'), {});
});
