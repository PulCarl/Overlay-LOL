'use strict';

/*
 * Les jeux proposés au lancement de l'application.
 *
 * Pour ajouter un jeu : une entrée dans GAMES avec `status: 'ready'` et une fonction `start()`
 * qui démarre son serveur et renvoie l'adresse de son panneau de contrôle ({ url }).
 * Tant qu'un jeu est en `status: 'soon'`, il est affiché grisé et on ne peut pas le choisir.
 * Ce fichier ne dépend pas d'Electron : il est testé avec « npm test ».
 */

const fs = require('fs');
const path = require('path');

const GAMES = [
  {
    id: 'lol',
    name: 'League of Legends',
    short: 'LoL',
    tagline: 'Scores, objectifs, picks et bans, écran de fin de partie',
    status: 'ready',
    title: 'Overlay LoL · Panneau de contrôle',
    accent: 'violet',
    async start() {
      const server = require('../server.js');
      try {
        const info = await server.start();
        return { url: `http://127.0.0.1:${info.port}/control` };
      } catch (e) {
        throw new Error(server.startErrorMessage(e));
      }
    },
  },
  {
    id: 'valorant',
    name: 'VALORANT',
    short: 'VAL',
    tagline: 'L\'overlay arrive bientôt',
    status: 'soon',
    title: 'Overlay VALORANT · Panneau de contrôle',
    accent: 'rouge',
  },
];

const find = (id) => GAMES.find((g) => g.id === id) || null;

/* Ce que la page de choix a le droit de connaître (pas de fonctions). */
function publicList() {
  return GAMES.map(({ id, name, short, tagline, status, accent }) => ({ id, name, short, tagline, status, accent }));
}

/* ------------------------------------------------------------ démarrage des jeux */

const running = new Map();

/* Démarre le jeu s'il ne l'est pas déjà ; un jeu démarré reste actif jusqu'à la fermeture de l'application. */
function launch(id) {
  const game = find(id);
  if (!game) return Promise.reject(new Error('Jeu inconnu.'));
  if (game.status !== 'ready' || typeof game.start !== 'function') {
    return Promise.reject(new Error(`${game.name} n'est pas encore disponible.`));
  }
  if (!running.has(id)) {
    const started = Promise.resolve()
      .then(() => game.start())
      .catch((e) => {
        running.delete(id); // on pourra réessayer (port libéré, etc.)
        throw e;
      });
    running.set(id, started);
  }
  return running.get(id).then((info) => ({ ...info, game: publicList().find((g) => g.id === id), title: game.title }));
}

const anyRunning = () => running.size > 0;

/* ------------------------------------------------------------ dernier jeu utilisé */

const lastFile = (dir) => path.join(dir, 'launcher.json');

function loadLast(dir) {
  try {
    const id = JSON.parse(fs.readFileSync(lastFile(dir), 'utf8')).last;
    const game = find(id);
    return game && game.status === 'ready' ? game.id : null;
  } catch (_) {
    return null;
  }
}

function saveLast(dir, id) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lastFile(dir), JSON.stringify({ last: id }));
  } catch (_) {
    /* la mémoire du dernier jeu n'est qu'un confort */
  }
}

module.exports = { GAMES, find, publicList, launch, anyRunning, loadLast, saveLast };
