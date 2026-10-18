(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = window.overlayApp;
  const listEl = $('games');
  const errorEl = $('error');

  function showError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function card(game, last) {
    const ready = game.status === 'ready';
    const button = el('button', 'game' + (game.accent === 'rouge' ? ' rouge' : ''));
    button.type = 'button';
    button.dataset.game = game.id;
    button.disabled = !ready;
    button.setAttribute('aria-label', ready ? `Ouvrir l'overlay ${game.name}` : `${game.name} : bientôt disponible`);

    const inner = el('div', 'game-in');
    const art = el('div', 'art');
    art.setAttribute('aria-hidden', 'true');
    art.append(el('span', 'mono', game.short));

    const info = el('div', 'info');
    info.append(el('span', 'name', game.name), el('span', 'tag', game.tagline));

    const cta = el('div', 'cta');
    const label = el('span', '', ready ? 'Ouvrir' : 'Bientôt');
    cta.append(label);
    if (ready) {
      if (game.id === last) cta.append(el('span', 'last', 'Dernier utilisé'));
      cta.append(el('span', 'arrow', '→'));
    } else {
      cta.append(el('span', 'soon', 'En préparation'));
    }
    info.append(cta);

    inner.append(art, info);
    button.append(inner);
    if (ready) button.addEventListener('click', () => choose(game, button, label));
    const item = el('li');
    item.append(button);
    return item;
  }

  async function choose(game, button, label) {
    showError('');
    document.body.classList.add('busy');
    button.classList.add('loading');
    label.textContent = 'Démarrage…';
    try {
      const res = await api.chooseGame(game.id);
      if (!res || !res.ok) throw new Error((res && res.error) || 'Le démarrage a échoué.');
      // La fenêtre bascule d'elle-même sur le panneau de contrôle.
    } catch (e) {
      showError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      document.body.classList.remove('busy');
      button.classList.remove('loading');
      label.textContent = 'Ouvrir';
    }
  }

  async function init() {
    if (!api) {
      showError('Cette page fait partie de l\'application de bureau : lance Overlay-LoL.exe (ou « npm run app »).');
      return;
    }
    try {
      const { games, last } = await api.listGames();
      const nodes = games.map((g) => card(g, last));
      listEl.replaceChildren(...nodes);
      const first = listEl.querySelector('.game:not(:disabled)');
      if (first) first.focus();
    } catch (e) {
      showError('Impossible de lire la liste des jeux : ' + e.message);
    }
  }

  init();
})();
