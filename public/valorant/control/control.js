'use strict';

/*
 * Panneau de contrôle VALORANT : chaque changement est envoyé tout de suite au serveur,
 * qui le sauvegarde et le redistribue à l'overlay. Pas de bouton « Enregistrer ».
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const SIDES = ['left', 'right'];
  const PHASE_LABEL = { buy: 'Achat', live: 'Manche en cours', planted: 'Spike posé', over: 'Fin de manche' };
  const PHASE_SHORT = { buy: 'Achat', live: 'En cours', planted: 'Spike posé', over: 'Terminée' };

  let S = null; // dernier état affiché
  let latest = null; // dernier état reçu
  let inflight = 0;
  let offset = 0; // décalage entre l'horloge du serveur et celle de cette page
  const catalog = { agents: [], maps: [] };

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
  const setIfIdle = (input, value, key) => {
    if (key && pending.has(key)) return;
    if (document.activeElement !== input && input.value !== String(value)) input.value = value;
  };
  const teamLabel = (side) => {
    const t = S.teams[side];
    return t.name || t.tag || (side === 'left' ? 'Gauche' : 'Droite');
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
      if (json.teams) latest = json;
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
  const patch = (obj) => api('POST', '/api/match', obj).catch(() => {});
  const act = (type, extra) => api('POST', '/api/action', { type, ...extra }).catch(() => {});

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

  /* Chrono saisi comme « 1:40 », « 100 » ou « 0:45 » : renvoie des secondes, ou null. */
  function parseTime(text) {
    const t = String(text).trim();
    let m = /^(\d{1,2}):(\d{1,2})$/.exec(t);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = /^\d{1,4}$/.exec(t);
    return m ? Number(t) : null;
  }
  const fmtTime = (ms) => {
    const sec = Math.ceil(Math.max(0, ms) / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };

  /* ---------------------------------------------------------- listes déroulantes */

  /* Remplit une liste d'agents ou de maps ; une valeur absente du catalogue (saisie ancienne) reste choisissable. */
  function fillSelect(sel, items, value, placeholder) {
    const key = items.map((i) => i.name).join('|') + '|' + value;
    if (sel.dataset.k === key) return;
    sel.dataset.k = key;
    sel.textContent = '';
    sel.append(new Option(placeholder, ''));
    for (const it of items) sel.append(new Option(it.role ? `${it.name} · ${it.role}` : it.name, it.name));
    if (value && !items.some((i) => i.name === value)) sel.append(new Option(value, value));
    sel.value = value || '';
  }

  /* ------------------------------------------------------------------ rendu */

  function renderStatus(s) {
    const map = s.maps[s.mapIndex];
    $('status-text').textContent = `Manche ${s.round.number} · ${PHASE_SHORT[s.round.phase]}${map && map.name ? ' · ' + map.name : ''}`;
    $('demo-badge').hidden = !s.demo;
  }

  function renderTeams() {
    for (const box of qsa('.team')) {
      const slot = box.dataset.slot;
      const t = S.teams[slot];
      setIfIdle(box.querySelector('[data-f=name]'), t.name, `${slot}-name`);
      setIfIdle(box.querySelector('[data-f=tag]'), t.tag, `${slot}-tag`);
      setIfIdle(box.querySelector('[data-f=sub]'), t.sub, `${slot}-sub`);
      setPreview(box.querySelector('[data-f=logo-prev]'), t.logo, t.tag || '·');
    }
    for (const box of qsa('.score')) {
      const slot = box.dataset.slot;
      box.querySelector('[data-f=label]').textContent = teamLabel(slot);
      const round = box.querySelector('[data-f=value]');
      if (round) round.textContent = S.round[slot];
      const series = box.querySelector('[data-s=value]');
      if (series) series.textContent = S.series[slot];
    }
    $('round-number').textContent = S.round.number;
    $('won-left').textContent = `Manche gagnée · ${teamLabel('left')}`;
    $('won-right').textContent = `Manche gagnée · ${teamLabel('right')}`;
    $('end-left').textContent = `Map gagnée · ${teamLabel('left')}`;
    $('end-right').textContent = `Map gagnée · ${teamLabel('right')}`;
    $('pl-title-left').textContent = teamLabel('left');
    $('pl-title-right').textContent = teamLabel('right');
  }

  function renderSeries() {
    for (const r of qsa('input[name=format]')) r.checked = Number(r.value) === S.format;
    const map = S.maps[S.mapIndex];
    let info = `Map ${S.mapIndex + 1}${map && map.name ? ` (${map.name})` : ''} · manches ${S.round.left}–${S.round.right}.`;
    if (S.derived.mapHint) info += ` ${teamLabel(S.derived.mapHint)} a gagné la map : cliquez sur « Terminer la map ».`;
    if (S.derived.matchWinner) info += ` Série gagnée par ${teamLabel(S.derived.matchWinner)}.`;
    if (S.endScreen.visible) info += ' L\'écran de fin est affiché.';
    $('end-info').textContent = info;
    $('end-hide').disabled = !S.endScreen.visible;
  }

  function renderEvent() {
    setIfIdle($('event-name'), S.event.name, 'event-name');
    setIfIdle($('event-stage'), S.event.stage, 'event-stage');
  }

  function renderDisplay() {
    for (const c of qsa('[data-disp]')) c.checked = !!S.display[c.dataset.disp];
    const pct = Math.round(S.display.scale * 100);
    if (document.activeElement !== $('scale') && !pending.has('scale')) {
      $('scale').value = pct;
      $('scale-out').textContent = `${pct} %`;
    }
  }

  /* ------------------------------------------------------------- joueurs */

  const prow = { left: [], right: [] };

  function playersPatch(side, index, fields) {
    const list = [null, null, null, null, null];
    list[index] = fields;
    return patch({ players: { [side]: list } });
  }

  function miniStepper(label, onChange) {
    const box = el('span', 'mini');
    const dec = el('button', '', '−');
    const inc = el('button', '', '+');
    dec.type = inc.type = 'button';
    dec.setAttribute('aria-label', `Retirer un ${label}`);
    inc.setAttribute('aria-label', `Ajouter un ${label}`);
    const out = el('output', '', '0');
    dec.addEventListener('click', () => onChange(-1));
    inc.addEventListener('click', () => onChange(1));
    box.append(el('b', '', label), dec, out, inc);
    return { box, out };
  }

  function buildPlayers() {
    for (const side of SIDES) {
      const list = $('plist-' + side);
      for (let i = 0; i < 5; i++) {
        const r = {};
        const root = el('div', 'pc');
        const top = el('div', 'pc-top');
        r.agent = el('select');
        r.agent.setAttribute('aria-label', `Agent du joueur ${i + 1}`);
        r.name = el('input');
        r.name.type = 'text';
        r.name.maxLength = 24;
        r.name.placeholder = `Joueur ${i + 1}`;
        r.name.autocomplete = 'off';
        r.alive = el('button', 'btn toggle', '☠');
        r.alive.type = 'button';
        r.alive.title = 'Joueur mort';
        r.ult = el('button', 'btn toggle ult', '⚡');
        r.ult.type = 'button';
        r.ult.title = 'Ultime prêt';
        top.append(r.agent, r.name, r.alive, r.ult);

        const bot = el('div', 'pc-bot');
        r.stat = {};
        for (const [field, label] of [['kills', 'K'], ['deaths', 'D'], ['assists', 'A']]) {
          const m = miniStepper(label, (d) => {
            const cur = S.players[side][i][field];
            playersPatch(side, i, { [field]: Math.max(0, cur + d) });
          });
          r.stat[field] = m.out;
          bot.append(m.box);
        }
        const cred = el('label', 'cred', 'Crédits');
        r.cred = el('input');
        r.cred.type = 'number';
        r.cred.min = '0';
        r.cred.max = '9000';
        r.cred.step = '50';
        cred.append(r.cred);
        bot.append(cred);
        root.append(top, bot);
        list.append(root);

        r.agent.addEventListener('change', () => playersPatch(side, i, { agent: r.agent.value }));
        r.name.addEventListener('input', () => debounce(`${side}${i}-name`, () => playersPatch(side, i, { name: r.name.value })));
        r.alive.addEventListener('click', () => playersPatch(side, i, { alive: !S.players[side][i].alive }));
        r.ult.addEventListener('click', () => playersPatch(side, i, { ult: !S.players[side][i].ult }));
        r.cred.addEventListener('input', () => {
          const n = Number(r.cred.value);
          if (Number.isFinite(n)) debounce(`${side}${i}-cred`, () => playersPatch(side, i, { credits: n }));
        });
        prow[side].push(r);
      }
    }
  }

  function renderPlayers() {
    for (const side of SIDES) {
      S.players[side].forEach((p, i) => {
        const r = prow[side][i];
        fillSelect(r.agent, catalog.agents, p.agent, '— Agent —');
        if (document.activeElement !== r.agent && r.agent.value !== p.agent) r.agent.value = p.agent;
        setIfIdle(r.name, p.name, `${side}${i}-name`);
        r.alive.classList.toggle('on', !p.alive);
        r.alive.setAttribute('aria-pressed', String(!p.alive));
        r.ult.classList.toggle('on', p.ult);
        r.ult.setAttribute('aria-pressed', String(p.ult));
        for (const f of ['kills', 'deaths', 'assists']) r.stat[f].textContent = p[f];
        setIfIdle(r.cred, p.credits, `${side}${i}-cred`);
      });
    }
  }

  /* ---------------------------------------------------------------- maps */

  function readMaps() {
    return qsa('.maprow').map((row) => ({ name: row.querySelector('.mname').value, pick: row.querySelector('.mpick').value }));
  }
  const saveMaps = () => patch({ maps: readMaps() });

  function renderMaps() {
    const list = $('maplist');
    // L'utilisateur choisit dans une liste : on ne reconstruit rien sous ses doigts.
    if (list.contains(document.activeElement)) return;
    const key = JSON.stringify([S.maps, S.mapIndex, S.teams.left.tag, S.teams.right.tag, catalog.maps.length]);
    if (list.dataset.k === key) return;
    list.dataset.k = key;
    list.textContent = '';
    if (!S.maps.length) list.append(el('div', 'empty', 'Aucune map. Ajoutez-en une : elles s\'affichent en haut à gauche de l\'overlay.'));
    S.maps.forEach((m, i) => {
      const row = el('div', 'maprow');
      row.append(el('span', 'num', String(i + 1)));

      const name = el('select', 'mname');
      name.setAttribute('aria-label', `Map ${i + 1}`);
      fillSelect(name, catalog.maps, m.name, '— Map —');
      name.addEventListener('change', saveMaps);

      const pick = el('select', 'mpick');
      pick.setAttribute('aria-label', `Choix de la map ${i + 1}`);
      pick.append(new Option('Choix : —', ''), new Option(`Choix : ${S.teams.left.tag || 'gauche'}`, 'left'), new Option(`Choix : ${S.teams.right.tag || 'droite'}`, 'right'), new Option('Décideur', 'decider'));
      pick.value = m.pick;
      pick.addEventListener('change', saveMaps);

      const cur = el('label', 'cur');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'map-current';
      radio.checked = i === S.mapIndex;
      radio.addEventListener('change', () => patch({ mapIndex: i }));
      cur.append(radio, document.createTextNode('En cours'));

      const res = el('span', 'res');
      if (m.result) {
        res.textContent = `${m.result.left}–${m.result.right}`;
        if (m.result.winner) res.classList.add(m.result.winner);
      }

      // Une map déjà jouée garde son résultat : on ne la supprime pas.
      const del = el('button', 'btn small ghost', '✕');
      del.type = 'button';
      del.title = m.result ? 'Cette map est déjà jouée' : 'Supprimer cette map';
      del.disabled = !!m.result;
      del.addEventListener('click', () => {
        row.remove();
        saveMaps();
      });

      row.append(name, pick, cur, res, del);
      list.append(row);
    });
    $('map-add').disabled = S.maps.length >= 5;
  }

  /* ------------------------------------------------------------- presets */

  function renderPresets() {
    const presetKey = JSON.stringify(S.presets.map((p) => [p.id, p.name, p.tag]));
    for (const box of qsa('.team')) {
      const sel = box.querySelector('[data-f=preset]');
      if (sel.dataset.k !== presetKey) {
        sel.dataset.k = presetKey;
        sel.textContent = '';
        sel.append(new Option('— Manuel —', ''));
        for (const p of S.presets) sel.append(new Option(p.tag ? `${p.name} (${p.tag})` : p.name, p.id));
      }
      if (document.activeElement !== sel) {
        const t = S.teams[box.dataset.slot];
        const match = S.presets.find((p) => p.name === t.name && p.tag === t.tag && p.logo === t.logo && p.sub === t.sub);
        sel.value = match ? match.id : '';
      }
    }

    const box = $('preset-list');
    const key = JSON.stringify(S.presets);
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    box.textContent = '';
    if (!S.presets.length) box.append(el('div', 'empty', 'Aucun preset enregistré.'));
    for (const p of S.presets) {
      const row = el('div', 'preset-row');
      const logo = el('div', 'logo-prev');
      setPreview(logo, p.logo, p.tag || '·');
      const name = el('b', '', p.name);
      name.append(el('small', '', p.tag));
      const load = (slot) => {
        const b = el('button', 'btn small ' + (slot === 'left' ? 'left' : 'red'), slot === 'left' ? '→ Gauche' : '→ Droite');
        b.type = 'button';
        b.title = `Charger ${p.name} ${slot === 'left' ? 'à gauche' : 'à droite'}`;
        b.addEventListener('click', () => patch({ teams: { [slot]: { name: p.name, tag: p.tag, sub: p.sub, logo: p.logo } } }));
        return b;
      };
      const del = el('button', 'btn small ghost', '✕');
      del.type = 'button';
      del.title = 'Supprimer ce preset';
      del.addEventListener('click', () => api('DELETE', '/api/presets/' + p.id).catch(() => {}));
      row.append(logo, name, load('left'), load('right'), del);
      box.append(row);
    }
  }

  function render(s) {
    S = s;
    offset = s.now - Date.now();
    renderStatus(s);
    renderTeams();
    renderSeries();
    renderEvent();
    renderDisplay();
    renderPlayers();
    renderMaps();
    renderPresets();
    tickTimer();
  }

  /* -------------------------------------------------------------- chrono */

  function tickTimer() {
    if (!S) return;
    const t = S.timer;
    const remaining = t.running ? Math.max(0, t.endsAt - (Date.now() + offset)) : t.remaining;
    $('timer-out').textContent = fmtTime(remaining);
    $('timer-phase').textContent = PHASE_LABEL[S.round.phase] + (t.running ? '' : ' · en pause');
    $('timer-toggle').textContent = t.running ? '⏸ Pause' : '▶ Reprendre';
    $('timer-toggle').disabled = !t.running && t.remaining <= 0;
  }
  setInterval(tickTimer, 200);

  /* ------------------------------------------------------------ onglets */

  const TABS = ['match', 'players', 'maps', 'teams', 'display', 'obs'];
  function showTab(name) {
    if (!TABS.includes(name)) name = 'match';
    for (const b of qsa('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const t of TABS) $('tab-' + t).hidden = t !== name;
    if (name === 'obs') fit();
    try {
      localStorage.setItem('valorant-tab', name);
    } catch (_) {
      /* pas de stockage : tant pis */
    }
  }
  for (const b of qsa('[role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

  /* ------------------------------------------------------------ interactions */

  for (const box of qsa('.team')) {
    const slot = box.dataset.slot;
    for (const f of ['name', 'tag', 'sub']) {
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
      const p = S.presets.find((x) => x.id === sel.value);
      if (p) patch({ teams: { [slot]: { name: p.name, tag: p.tag, sub: p.sub, logo: p.logo } } });
    });
  }

  $('swap').addEventListener('click', () => act('swap'));
  $('undo').addEventListener('click', () => act('undo'));
  $('reset-all').addEventListener('click', () => {
    if (!window.confirm('Tout remettre à zéro ?\n\nÉquipes, score, joueurs, maps et affichage reviennent aux réglages d\'origine. Les presets sont conservés.')) return;
    api('POST', '/api/action', { type: 'reset' }).then(() => toast('Réglages réinitialisés.', 'ok')).catch(() => {});
  });

  // Dans l'application de bureau seulement : retour à l'écran de choix du jeu.
  if (window.overlayApp && window.overlayApp.backToGames) {
    $('back-games').hidden = false;
    $('back-games').addEventListener('click', () => window.overlayApp.backToGames());
  }

  // Score des manches
  for (const box of qsa('.score')) {
    const slot = box.dataset.slot;
    for (const b of qsa('[data-act]', box)) {
      b.addEventListener('click', () => patch({ round: { [slot]: Math.max(0, S.round[slot] + (b.dataset.act === 'inc' ? 1 : -1)) } }));
    }
    for (const b of qsa('[data-sact]', box)) {
      b.addEventListener('click', () => patch({ series: { [slot]: Math.max(0, S.series[slot] + (b.dataset.sact === 'inc' ? 1 : -1)) } }));
    }
  }
  $('round-dec').addEventListener('click', () => patch({ round: { number: Math.max(1, S.round.number - 1) } }));
  $('round-inc').addEventListener('click', () => patch({ round: { number: S.round.number + 1 } }));
  $('won-left').addEventListener('click', () => act('roundWon', { side: 'left' }));
  $('won-right').addEventListener('click', () => act('roundWon', { side: 'right' }));

  // Chrono
  for (const b of qsa('[data-phase]')) b.addEventListener('click', () => act('phase', { phase: b.dataset.phase }));
  $('timer-toggle').addEventListener('click', () => act('timer', { op: S.timer.running ? 'pause' : 'resume' }));
  $('timer-reset').addEventListener('click', () => act('timer', { op: 'reset' }));
  const applyTime = () => {
    const sec = parseTime($('timer-set').value);
    if (sec == null || sec > 3599) return toast('Durée invalide : écrivez par exemple 1:40 ou 45.');
    act('timer', { op: 'set', seconds: sec, run: false });
  };
  $('timer-apply').addEventListener('click', applyTime);
  $('timer-set').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTime();
  });

  // Série et fin de map
  for (const r of qsa('input[name=format]')) r.addEventListener('change', () => patch({ format: Number(r.value) }));
  $('end-map').addEventListener('click', () => act('endMap'));
  $('end-left').addEventListener('click', () => act('endMap', { winner: 'left' }));
  $('end-right').addEventListener('click', () => act('endMap', { winner: 'right' }));
  $('end-hide').addEventListener('click', () => act('endscreen', { visible: false }));
  $('end-preview').addEventListener('click', () => act('endscreen', { visible: true }));

  $('players-reset').addEventListener('click', () => act('resetPlayers'));

  // Maps et événement
  $('map-add').addEventListener('click', () => patch({ maps: [...readMaps(), { name: '', pick: '' }] }));
  for (const [id, field] of [['event-name', 'name'], ['event-stage', 'stage']]) {
    $(id).addEventListener('input', () => debounce(id, () => patch({ event: { [field]: $(id).value } })));
  }

  // Affichage
  for (const c of qsa('[data-disp]')) c.addEventListener('change', () => patch({ display: { [c.dataset.disp]: c.checked } }));
  $('scale').addEventListener('input', (e) => {
    $('scale-out').textContent = `${e.target.value} %`;
    debounce('scale', () => patch({ display: { scale: Number(e.target.value) / 100 } }), 200);
  });
  $('load-demo').addEventListener('click', () => {
    if (!window.confirm('Remplacer le match actuel par le match d\'exemple ?\n\nLe bouton « Annuler » en haut le ramène.')) return;
    act('demo');
  });

  // Presets
  for (const b of qsa('[data-save-preset]')) {
    b.addEventListener('click', () => {
      const t = S.teams[b.dataset.savePreset];
      if (!t.name.trim()) return toast('Donnez d\'abord un nom à cette équipe.');
      api('POST', '/api/presets', { name: t.name, tag: t.tag, sub: t.sub, logo: t.logo })
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

  /* --------------------------------------------------------------- démarrage */

  buildPlayers();
  try {
    showTab(localStorage.getItem('valorant-tab') || 'match');
  } catch (_) {
    showTab('match');
  }

  // Les listes d'agents et de maps (avec leurs images) viennent du serveur.
  fetch('/api/catalog')
    .then((r) => r.json())
    .then((c) => {
      catalog.agents = c.agents;
      catalog.maps = c.maps;
      if (S) {
        $('maplist').dataset.k = '';
        renderPlayers();
        renderMaps();
      }
    })
    .catch(() => {});

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
