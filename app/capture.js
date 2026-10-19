'use strict';

/*
 * Lecture automatique des sorts : le panneau demande à capturer l'écran. Dans le navigateur, c'est lui qui affiche
 * son sélecteur ; dans l'application, il n'y en a pas, alors on choisit nous-mêmes quoi partager (voir main.js).
 */

/*
 * Source à capturer parmi celles de desktopCapturer ({ id, name }) : la fenêtre de la partie, à défaut celle du client
 * (le salon, avant la partie), à défaut le premier écran. Une fenêtre ne dépend pas de l'écran où elle se trouve.
 */
function pickCaptureSource(sources) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => s && typeof s.id === 'string');
  const windowNamed = (re) => list.find((s) => s.id.startsWith('window:') && re.test(String(s.name || '')));
  return windowNamed(/^League of Legends \(TM\) Client$/i) || windowNamed(/^League of Legends$/i) || list.find((s) => s.id.startsWith('screen:')) || null;
}

module.exports = { pickCaptureSource };
