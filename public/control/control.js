'use strict';

/*
 * Panneau de contrôle : chaque changement est envoyé tout de suite au serveur,
 * qui le sauvegarde et le redistribue à l'overlay. Pas de bouton « Enregistrer ».
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

  let cfg = null;
  let state = null;
  let latest = null;
  let inflight = 0;

  /* ------------------------------------------------------------------ outils */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Une saisie en attente d'envoi ne doit jamais être écrasée par l'état reçu du serveur.
  const timers = {};
  const pending = new Set();
  function debounce(key, fn, ms = 350) {
    pending.add(key);
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => {
      pending.delete(key);
      fn();
    }, ms);
  }
  const mmss = (s) => {
    const t = Math.max(0, Math.floor(s));
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  };
  const setIfIdle = (input, value, key) => {
    if (key && pending.has(key)) return;
    if (document.activeElement !== input && input.value !== String(value)) input.value = value;
  };

  let toastTimer;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast on' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), kind === 'ok' ? 2200 : 4500);
  }
  let savedTimer;
  function flashSaved() {
    const s = $('saved');
    s.classList.add('on');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => s.classList.remove('on'), 1400);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const t = el('textarea');
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
  }

  async function api(method, path, body) {
    inflight += 1;
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Erreur ${res.status}`);
      if (json.config) latest = json;
      flashSaved();
      return json;
    } catch (e) {
      toast(e.message === 'Failed to fetch' ? 'Le serveur ne répond pas.' : e.message);
      throw e;
    } finally {
      inflight -= 1;
      if (inflight === 0 && latest) render(latest);
    }
  }
  const patch = (obj) => api('POST', '/api/config', obj).catch(() => {});

  function readFile(file) {
    return new Promise((resolve, reject) => {
      if (file.size > 5 * 1024 * 1024) return reject(new Error('Image trop lourde (5 Mo maximum).'));
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Lecture de l\'image impossible.'));
      r.readAsDataURL(file);
    });
  }
  async function uploadImage(file) {
    try {
      const dataUrl = await readFile(file);
      const { url } = await api('POST', '/api/upload', { dataUrl });
      return url;
    } catch (e) {
      if (!$('toast').classList.contains('on')) toast(e.message);
      return null;
    }
  }

  function setPreview(box, url, fallback) {
    const key = url + '|' + fallback;
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    box.textContent = '';
    box.append(el('span', '', fallback));
    if (url) {
      const img = new Image();
      img.alt = '';
      img.onload = () => box.firstChild && box.firstChild.remove();
      img.onerror = () => img.remove();
      img.src = url;
      box.append(img);
    }
  }

  /* ------------------------------------------------------------------ rendu */

  const STATUS = { waiting: 'En attente d\'une partie', loading: 'Chargement', ingame: 'En partie', ended: 'Partie terminée' };

  function renderStatus(s) {
    let text = STATUS[s.status] || s.status;
    if (s.status === 'ingame' && s.game) text += `, ${mmss(s.game.gameTime)}`;
    if (s.game && (s.status === 'ingame' || s.status === 'ended')) text += s.game.spectator ? ' · spectateur' : ' · joueur';
    $('status-text').textContent = text;
    $('demo-badge').hidden = !s.demo;
  }

  function renderTeams() {
    for (const box of qsa('.team')) {
      const slot = box.dataset.slot;
      const t = cfg.teams[slot];
      setIfIdle(box.querySelector('[data-f=name]'), t.name, `${slot}-name`);
      setIfIdle(box.querySelector('[data-f=tag]'), t.tag, `${slot}-tag`);
      setPreview(box.querySelector('[data-f=logo-prev]'), t.logo, t.tag || '·');
    }
    for (const box of qsa('.score')) {
      const slot = box.dataset.slot;
      const t = cfg.teams[slot];
      box.querySelector('[data-f=label]').textContent = t.name || t.tag || (slot === 'blue' ? 'Bleu' : 'Rouge');
      box.querySelector('[data-f=value]').textContent = cfg.series[slot];
    }
  }

  function renderSettings() {
    for (const r of qsa('input[name=format]')) r.checked = Number(r.value) === cfg.series.format;
    $('autocount').checked = cfg.series.autoCount;
    for (const r of qsa('input[name=mode]')) r.checked = r.value === cfg.display.mode;
    const d = cfg.display;
    const playersOn = d.players === null ? d.mode === 'spectator' : d.players;
    for (const c of qsa('[data-disp]')) c.checked = c.dataset.disp === 'players' ? playersOn : !!d[c.dataset.disp];
    $('players-auto').textContent = d.players === null ? '(auto : visible en mode spectateur)' : '';
    $('players-reset').hidden = d.players === null;
    const pct = Math.round(d.scale * 100);
    if (document.activeElement !== $('scale') && !pending.has('scale')) {
      $('scale').value = pct;
      $('scale-out').textContent = `${pct} %`;
    }
    setIfIdle($('sponsor-interval'), cfg.sponsorInterval, 'interval');
    if (document.activeElement !== $('map-size') && !pending.has('mapsize')) {
      $('map-size').value = d.mapSize;
      $('map-out').textContent = `${d.mapSize} px`;
    }

    const g = state.game;
    let hint = '';
    if (g && g.spectator && d.mode !== 'spectator') hint = 'La partie en cours est suivie en spectateur : passez en mode Spectateur pour afficher le panneau des joueurs.';
    else if (g && !g.spectator && d.mode === 'spectator') hint = 'Vous jouez cette partie : le mode Joueur laisse le bas de l\'écran libre pour la barre des sorts.';
    $('mode-hint').textContent = hint;
  }

  function renderEnd() {
    const s = state;
    const can = s.hasGame || !!s.last;
    $('win-blue').textContent = `Victoire bleue${cfg.teams.blue.name ? ' · ' + cfg.teams.blue.name : ''}`;
    $('win-red').textContent = `Victoire rouge${cfg.teams.red.name ? ' · ' + cfg.teams.red.name : ''}`;
    for (const id of ['win-blue', 'win-red', 'end-show']) $(id).disabled = !can;
    $('end-hide').disabled = !s.endScreen.visible;
    let info = 'Aucune partie terminée pour l\'instant.';
    if (s.last) {
      if (!s.last.winner) info = 'Dernière partie terminée : vainqueur inconnu, choisissez-le ci-dessus.';
      else {
        const slot = (s.last.winner === 'ORDER') !== s.last.flipped ? 'blue' : 'red';
        info = `Dernière partie : victoire de ${cfg.teams[slot].name || (slot === 'blue' ? 'l\'équipe bleue' : 'l\'équipe rouge')}.`;
      }
    } else if (s.hasGame) info = 'Partie en cours : « Afficher » montre un aperçu de l\'écran de fin.';
    if (s.endScreen.visible) info += ' L\'écran de fin est affiché.';
    $('end-info').textContent = info;
  }

  /* Picks et bans : mode d'affichage et état de la lecture du client LoL. */
  function renderDraft() {
    const d = state.draft;
    if (!d) return;
    for (const r of qsa('input[name=draft-mode]')) r.checked = r.value === d.mode;
    let info;
    if (!d.lcu.enabled) info = 'La lecture du client LoL est désactivée (mode démo ou option --no-lcu).';
    else if (!d.lcu.connected) info = 'Client LoL non détecté : lancez le client League of Legends (pas seulement le Riot Client).';
    else if (!d.live) info = 'Client LoL détecté. En attente d\'une sélection des champions.';
    else {
      const t = d.data && d.data.label ? d.data.label : 'en cours';
      info = `Sélection des champions en cours : ${t.charAt(0).toLowerCase() + t.slice(1)}.`;
    }
    if (d.mode === 'show' && !d.live) info += d.visible ? ' La dernière sélection vue est affichée.' : ' Rien à afficher : aucune sélection vue pour l\'instant.';
    $('draft-info').textContent = info;
  }

  /* Sponsors : la liste est reconstruite seulement si elle diffère de ce qui est affiché. */
  function readSponsors() {
    return qsa('.sponsor-row').map((row) => ({ text: row.querySelector('input').value, image: row.dataset.image || '' }));
  }
  const saveSponsors = () => patch({ sponsors: readSponsors() });

  function sponsorRow(item) {
    const row = el('div', 'sponsor-row');
    row.dataset.image = item.image || '';
    const img = el('div', 'sp-img');
    setPreview(img, item.image, '＋');
    const text = el('input');
    text.type = 'text';
    text.maxLength = 80;
    text.placeholder = 'Texte du sponsor';
    text.value = item.text || '';
    text.addEventListener('input', () => debounce('sponsors', saveSponsors));
    const file = el('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp,image/gif';
    file.hidden = true;
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      const url = await uploadImage(file.files[0]);
      file.value = '';
      if (url) {
        row.dataset.image = url;
        setPreview(img, url, '＋');
        saveSponsors();
      }
    });
    const pick = el('label', 'btn small', 'Image');
    pick.append(file);
    const clear = el('button', 'btn small ghost', 'Retirer l\'image');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      row.dataset.image = '';
      setPreview(img, '', '＋');
      saveSponsors();
    });
    const del = el('button', 'btn small ghost', '✕');
    del.type = 'button';
    del.title = 'Supprimer ce sponsor';
    del.addEventListener('click', () => {
      row.remove();
      updateAddButton();
      saveSponsors();
    });
    row.append(img, text, pick, clear, del);
    return row;
  }
  function updateAddButton() {
    $('sponsor-add').disabled = qsa('.sponsor-row').length >= 8;
  }
  function renderSponsors() {
    const list = $('sponsor-list');
    if (list.contains(document.activeElement) || pending.has('sponsors')) return;
    if (JSON.stringify(cfg.sponsors) !== JSON.stringify(readSponsors())) {
      list.textContent = '';
      for (const s of cfg.sponsors) list.append(sponsorRow(s));
      if (!cfg.sponsors.length) list.append(el('div', 'empty', 'Aucun sponsor. Ajoutez un texte et/ou une image : ils défilent en haut à gauche.'));
    } else if (cfg.sponsors.length) {
      list.querySelector('.empty')?.remove();
    }
    updateAddButton();
  }

  function renderPresets() {
    // Listes déroulantes « Équipe enregistrée » de l'onglet Principal.
    const presetKey = JSON.stringify(cfg.presets.map((p) => [p.id, p.name, p.tag]));
    for (const box of qsa('.team')) {
      const sel = box.querySelector('[data-f=preset]');
      if (sel.dataset.k !== presetKey) {
        sel.dataset.k = presetKey;
        sel.textContent = '';
        sel.append(new Option('— Manuel —', ''));
        for (const p of cfg.presets) sel.append(new Option(p.tag ? `${p.name} (${p.tag})` : p.name, p.id));
      }
      if (document.activeElement !== sel) {
        const t = cfg.teams[box.dataset.slot];
        const match = cfg.presets.find((p) => p.name === t.name && p.tag === t.tag && p.logo === t.logo);
        sel.value = match ? match.id : '';
      }
    }

    // Liste de l'onglet Équipes.
    const box = $('preset-list');
    const key = JSON.stringify(cfg.presets);
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    box.textContent = '';
    if (!cfg.presets.length) box.append(el('div', 'empty', 'Aucun preset enregistré.'));
    for (const p of cfg.presets) {
      const row = el('div', 'preset-row');
      const logo = el('div', 'logo-prev');
      setPreview(logo, p.logo, p.tag || '·');
      const name = el('b', '', p.name);
      name.append(el('small', '', p.tag));
      const load = (slot) => {
        const b = el('button', 'btn small ' + (slot === 'blue' ? 'blue' : 'red'), slot === 'blue' ? '→ Bleu' : '→ Rouge');
        b.type = 'button';
        b.title = `Charger ${p.name} côté ${slot === 'blue' ? 'bleu' : 'rouge'}`;
        b.addEventListener('click', () => patch({ teams: { [slot]: { name: p.name, tag: p.tag, logo: p.logo } } }));
        return b;
      };
      const del = el('button', 'btn small ghost', '✕');
      del.type = 'button';
      del.title = 'Supprimer ce preset';
      del.addEventListener('click', () => api('DELETE', '/api/presets/' + p.id).catch(() => {}));
      row.append(logo, name, load('blue'), load('red'), del);
      box.append(row);
    }
  }

  /* ------------------------------------------------------------ sorts (chronos de recharge) */

  const SPELL_IMG = (v, k) => `https://ddragon.leagueoflegends.com/cdn/${v}/img/spell/${k}.png`;
  let recvAt = 0;
  let spellKey = '';
  let spellRows = [];

  const fmtCd = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec} s`);

  /* Heure de jeu à cet instant : la dernière lecture, prolongée du temps écoulé depuis (au plus 1,2 s). */
  function gameNow() {
    let t = state.game.gameTime;
    if (state.status === 'ingame') t += Math.min((performance.now() - recvAt) / 1000, 1.2) * (state.clockRate || 1);
    return t;
  }

  const cooldown = (body) => api('POST', '/api/cooldown', body).catch(() => {});

  function buildSpellRow(team, p) {
    const row = el('div', 'cdrow ' + (team === 'ORDER' ? 'blue' : 'red'));
    const name = el('span', 'cdname');
    name.append(el('b', '', p.name), el('small', '', p.champion));
    row.append(name);
    const cells = [];
    for (const slot of [0, 1]) {
      const sp = p.spells[slot];
      const cell = el('div', 'cdcell');
      if (!sp) {
        cell.append(el('span', 'muted', '—'));
        row.append(cell);
        continue;
      }
      const main = el('button', 'btn small cdmain');
      main.type = 'button';
      main.title = `Lancer le chrono de ${sp.name || 'ce sort'} pour ${p.name}`;
      if (state.ddragon && sp.key) {
        const img = new Image();
        img.alt = '';
        img.onerror = () => img.remove();
        img.src = SPELL_IMG(state.ddragon, sp.key);
        main.append(img);
      }
      const label = el('span', 'cdlabel', sp.name || sp.key);
      const out = el('output', '', '');
      main.append(label, out);
      main.addEventListener('click', () => cooldown({ team, index: p.index, slot, action: 'start' }));
      const mk = (text, title, body) => {
        const b = el('button', 'btn small ghost cdsmall', text);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', () => cooldown({ team, index: p.index, slot, ...body }));
        return b;
      };
      const minus = mk('−10', 'Retirer 10 secondes', { action: 'add', seconds: -10 });
      const plus = mk('+10', 'Ajouter 10 secondes', { action: 'add', seconds: 10 });
      const stop = mk('✕', 'Arrêter ce chrono', { action: 'clear' });
      cell.append(main, minus, plus, stop);
      cells.push({ slot, key: `${team}:${p.index}:${slot}`, main, out, extras: [minus, plus, stop] });
      row.append(cell);
    }
    const cosmic = el('label', 'cosmic');
    const box = el('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => cooldown({ team, index: p.index, action: 'cosmic', on: box.checked }));
    cosmic.append(box, document.createTextNode(' Perspicacité'));
    cosmic.title = 'Perspicacité cosmique : −18 % de recharge des sorts';
    row.append(cosmic);
    spellRows.push({ team, index: p.index, cells, box });
    return row;
  }

  function renderSpells() {
    const g = state.game;
    $('cd-info').textContent = g ? 'Partie en cours : cliquez sur un sort pour lancer son chrono.' : 'Les chronos sont disponibles pendant une partie.';
    $('cd-clear-all').disabled = !g;
    const lists = { ORDER: $('cd-blue'), CHAOS: $('cd-red') };
    $('cd-title-blue').textContent = cfg.teams.blue.name || 'Équipe bleue';
    $('cd-title-red').textContent = cfg.teams.red.name || 'Équipe rouge';
    const key = g ? JSON.stringify([state.gameId, state.ddragon, ...['ORDER', 'CHAOS'].map((t) => g.teams[t].players.map((p) => [p.index, p.name, p.champion, (p.spells || []).map((x) => x.key)]))]) : '';
    if (key !== spellKey) {
      spellKey = key;
      spellRows = [];
      for (const team of ['ORDER', 'CHAOS']) {
        lists[team].textContent = '';
        if (!g) lists[team].append(el('div', 'empty', 'En attente d\'une partie.'));
        else for (const p of g.teams[team].players) lists[team].append(buildSpellRow(team, p));
      }
    }
    if (g) tickSpells();
  }

  /* Compte à rebours de chaque sort (ou durée prévue s'il n'est pas lancé), redessiné cinq fois par seconde. */
  function tickSpells() {
    if (!state || !state.game) return;
    const now = gameNow();
    const cds = state.cooldowns || {};
    const totals = state.spellTotals || {};
    for (const r of spellRows) {
      const who = `${r.team}:${r.index}`;
      const cosmic = !!(state.cosmic && state.cosmic[who]);
      if (document.activeElement !== r.box) r.box.checked = cosmic;
      for (const c of r.cells) {
        const cd = cds[c.key];
        const left = cd ? Math.ceil(cd.endAt - now) : 0;
        const running = left > 0;
        c.main.classList.toggle('running', running);
        c.out.textContent = running ? fmtCd(left) : totals[c.key] ? fmtCd(totals[c.key]) : '';
        for (const b of c.extras) b.hidden = !running;
      }
    }
  }
  setInterval(tickSpells, 250);

  function render(s) {
    state = s;
    recvAt = performance.now();
    cfg = s.config;
    renderStatus(s);
    renderTeams();
    renderSettings();
    renderEnd();
    renderDraft();
    renderSponsors();
    renderPresets();
    renderSpells();
  }

  /* ------------------------------------------------------------ onglets */

  const TABS = ['main', 'spells', 'display', 'teams', 'obs'];
  function showTab(name) {
    if (!TABS.includes(name)) name = 'main';
    for (const b of qsa('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const t of TABS) $('tab-' + t).hidden = t !== name;
    if (name === 'obs') fit();
    try {
      localStorage.setItem('overlay-tab', name);
    } catch (_) {
      /* pas de stockage : tant pis */
    }
  }
  for (const b of qsa('[role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

  /* ------------------------------------------------------------ interactions */

  for (const box of qsa('.team')) {
    const slot = box.dataset.slot;
    for (const f of ['name', 'tag']) {
      const input = box.querySelector(`[data-f=${f}]`);
      input.addEventListener('input', () => debounce(`${slot}-${f}`, () => patch({ teams: { [slot]: { [f]: input.value } } })));
    }
    box.querySelector('[data-f=logo-file]').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const url = await uploadImage(file);
      e.target.value = '';
      if (url) patch({ teams: { [slot]: { logo: url } } });
    });
    box.querySelector('[data-act=logo-clear]').addEventListener('click', () => patch({ teams: { [slot]: { logo: '' } } }));
    const sel = box.querySelector('[data-f=preset]');
    sel.addEventListener('change', () => {
      const p = cfg.presets.find((x) => x.id === sel.value);
      if (p) patch({ teams: { [slot]: { name: p.name, tag: p.tag, logo: p.logo } } });
    });
  }

  $('swap').addEventListener('click', () => api('POST', '/api/swap').catch(() => {}));
  $('reset-all').addEventListener('click', () => {
    if (!window.confirm('Tout remettre à zéro ?\n\nÉquipes, série, affichage et sponsors reviennent aux réglages d\'origine. Les presets sont conservés.')) return;
    api('POST', '/api/reset').then(() => toast('Réglages réinitialisés.', 'ok')).catch(() => {});
  });

  // Dans l'application de bureau seulement : retour à l'écran de choix du jeu.
  if (window.overlayApp && window.overlayApp.backToGames) {
    $('back-games').hidden = false;
    $('back-games').addEventListener('click', () => window.overlayApp.backToGames());
  }

  for (const r of qsa('input[name=format]')) r.addEventListener('change', () => patch({ series: { format: Number(r.value) } }));
  $('autocount').addEventListener('change', (e) => patch({ series: { autoCount: e.target.checked } }));
  $('series-reset').addEventListener('click', () => api('POST', '/api/series/reset').catch(() => {}));
  for (const box of qsa('.score')) {
    const slot = box.dataset.slot;
    box.querySelector('[data-act=inc]').addEventListener('click', () => api('POST', '/api/series', { side: slot, delta: 1 }).catch(() => {}));
    box.querySelector('[data-act=dec]').addEventListener('click', () => api('POST', '/api/series', { side: slot, delta: -1 }).catch(() => {}));
  }

  for (const r of qsa('input[name=mode]')) r.addEventListener('change', () => patch({ display: { mode: r.value } }));
  for (const c of qsa('[data-disp]')) c.addEventListener('change', () => patch({ display: { [c.dataset.disp]: c.checked } }));
  $('players-reset').addEventListener('click', () => patch({ display: { players: null } }));
  $('scale').addEventListener('input', (e) => {
    $('scale-out').textContent = `${e.target.value} %`;
    debounce('scale', () => patch({ display: { scale: Number(e.target.value) / 100 } }), 200);
  });
  $('map-size').addEventListener('input', (e) => {
    $('map-out').textContent = `${e.target.value} px`;
    debounce('mapsize', () => patch({ display: { mapSize: Number(e.target.value) } }), 200);
  });
  $('cd-clear-all').addEventListener('click', () => cooldown({ action: 'clearAll' }));

  for (const r of qsa('input[name=draft-mode]')) r.addEventListener('change', () => api('POST', '/api/draft', { mode: r.value }).catch(() => {}));

  $('end-show').addEventListener('click', () => api('POST', '/api/endscreen', { visible: true }).catch(() => {}));
  $('end-hide').addEventListener('click', () => api('POST', '/api/endscreen', { visible: false }).catch(() => {}));
  $('win-blue').addEventListener('click', () => api('POST', '/api/endscreen', { visible: true, winner: 'blue' }).catch(() => {}));
  $('win-red').addEventListener('click', () => api('POST', '/api/endscreen', { visible: true, winner: 'red' }).catch(() => {}));

  $('sponsor-add').addEventListener('click', () => {
    const list = $('sponsor-list');
    list.querySelector('.empty')?.remove();
    const row = sponsorRow({ text: '', image: '' });
    list.append(row);
    updateAddButton();
    saveSponsors();
    row.querySelector('input').focus();
  });
  $('sponsor-interval').addEventListener('input', (e) => {
    const n = Number(e.target.value);
    if (n >= 3 && n <= 120) debounce('interval', () => patch({ sponsorInterval: n }));
  });

  for (const b of qsa('[data-save-preset]')) {
    b.addEventListener('click', () => {
      const t = cfg.teams[b.dataset.savePreset];
      if (!t.name.trim()) return toast('Donnez d\'abord un nom à cette équipe.');
      api('POST', '/api/presets', { name: t.name, tag: t.tag, logo: t.logo })
        .then(() => toast(`« ${t.name} » enregistrée dans les presets.`, 'ok'))
        .catch(() => {});
    });
  }

  /* ------------------------------------------------- adresses, aperçu, copie */

  // On affiche « localhost » plutôt que 127.0.0.1 : plus lisible, et OBS accepte les deux.
  const origin = location.origin.replace('//127.0.0.1', '//localhost');
  $('addr-text').textContent = origin.replace(/^https?:\/\//, '');
  $('addr').addEventListener('click', async () => {
    await copyText(origin + '/overlay');
    toast('Adresse de l\'overlay copiée : collez-la dans OBS.', 'ok');
  });
  $('url-overlay').value = origin + '/overlay';
  $('url-draft').value = origin + '/overlay?view=draft';
  $('url-control').value = origin + '/control';
  for (const b of qsa('[data-copy]')) {
    b.addEventListener('click', async () => {
      await copyText($(b.dataset.copy).value);
      const old = b.textContent;
      b.textContent = 'Copié ✓';
      setTimeout(() => (b.textContent = old), 1500);
    });
  }

  const preview = $('preview');
  const frame = $('preview-frame');
  function fit() {
    if (preview.clientWidth) frame.style.transform = `scale(${preview.clientWidth / 1920})`;
  }
  new ResizeObserver(fit).observe(preview);
  try {
    showTab(localStorage.getItem('overlay-tab') || 'main');
  } catch (_) {
    showTab('main');
  }

  /* --------------------------------------------------------------- connexion */

  function setConn(on) {
    $('conn-dot').className = 'dot ' + (on ? 'on' : 'off');
    $('conn-text').textContent = on ? 'Connecté' : 'Serveur injoignable…';
  }
  const es = new EventSource('/events');
  es.onopen = () => setConn(true);
  es.onmessage = (e) => {
    try {
      setConn(true);
      latest = JSON.parse(e.data);
      if (!inflight) render(latest);
    } catch (err) {
      console.error('État illisible', err);
    }
  };
  es.onerror = () => {
    setConn(false);
    $('status-text').textContent = 'inconnu';
  };
})();
