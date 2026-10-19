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
    const reading = state.autoSpells && state.autoSpells.active;
    $('cd-info').textContent = !g
      ? 'Les chronos sont disponibles pendant une partie.'
      : reading
        ? 'Partie en cours : la lecture automatique lance les chronos. Ces boutons servent à corriger.'
        : 'Partie en cours : cliquez sur un sort pour lancer son chrono.';
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

  /* ------------------------------------------------------------ lecture automatique des sorts */

  // On capture la fenêtre du jeu, on mesure la luminance des vingt icônes de sorts (spellvision.js) et on l'envoie au
  // serveur toutes les demi-secondes ; c'est lui qui décide quels sorts sont en recharge (lib/spellwatch.js).
  const AUTO_MS = 500;
  const CAL_HELP = [
    'Calage 1 sur 3 : cliquez au centre du premier sort (celui du haut) du joueur du haut.',
    'Calage 2 sur 3 : cliquez au centre du second sort du même joueur.',
    'Calage 3 sur 3 : cliquez au centre du premier sort du joueur du bas (le cinquième).',
  ];
  const auto = { stream: null, timer: 0, busy: false, view: {}, valid: null, counts: null, cal: null, grab: null, ctx: null, w: 0, h: 0 };

  function autoStatusText() {
    if (!auto.stream) {
      return state && state.autoSpells && state.autoSpells.active
        ? "Une autre page du panneau lit déjà l'écran."
        : "Lecture arrêtée. Cliquez sur « Lire l'écran du jeu » et choisissez la fenêtre de League of Legends.";
    }
    if (auto.cal) return CAL_HELP[auto.cal.pts.length];
    if (!state || state.status !== 'ingame') return "Lecture prête : elle démarre avec la partie. En attendant, vérifiez le cadrage sur l'aperçu.";
    if (auto.valid === false) return 'Les panneaux des joueurs ne sont pas lus : partagez bien toute la fenêtre du jeu, avec les panneaux affichés, ou calez les positions.';
    if (!auto.counts) return 'Lecture en cours…';
    const c = auto.counts;
    return `Lecture en cours : ${c.ready} sorts prêts, ${c.cooldown} en recharge${c.unknown ? `, ${c.unknown} pas encore lus` : ''}.`;
  }

  function drawAutoPreview() {
    if (!auto.grab || !cfg || !cfg.spellsAuto) return;
    const canvas = $('auto-canvas');
    const cw = 720;
    const ch = Math.round((cw * auto.h) / auto.w);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const g = canvas.getContext('2d');
    g.drawImage(auto.grab, 0, 0, cw, ch);
    SpellVision.draw(g, cw, ch, cfg.spellsAuto.layout, {
      view: auto.view,
      valid: auto.valid,
      rows: SpellVision.panelRows(state && state.game, cfg.spellsAuto.order),
      values: $('auto-values').checked,
      points: auto.cal ? auto.cal.pts : [],
    });
  }

  function renderAuto() {
    const running = !!auto.stream;
    $('auto-start').hidden = running;
    $('auto-stop').hidden = !running;
    $('auto-badge').hidden = !running;
    $('auto-view').hidden = !running;
    if (cfg && cfg.spellsAuto) {
      const a = cfg.spellsAuto;
      if (document.activeElement !== $('auto-order')) $('auto-order').value = a.order;
      const pct = Math.round(a.threshold * 100);
      if (!pending.has('auto-threshold') && document.activeElement !== $('auto-threshold')) $('auto-threshold').value = pct;
      $('auto-threshold-out').textContent = (pending.has('auto-threshold') ? Number($('auto-threshold').value) : pct) + ' %';
    }
    $('auto-status').textContent = autoStatusText();
  }

  async function autoTick() {
    const video = $('auto-video');
    if (!auto.stream || auto.busy || !video.videoWidth || !cfg || !cfg.spellsAuto) return;
    auto.busy = true;
    try {
      const k = Math.min(1, 1920 / video.videoWidth); // pas la peine de lire une image de 4K : les positions sont des fractions
      const w = Math.round(video.videoWidth * k);
      const h = Math.round(video.videoHeight * k);
      if (!auto.grab) auto.grab = document.createElement('canvas');
      if (auto.grab.width !== w || auto.grab.height !== h) {
        auto.grab.width = w;
        auto.grab.height = h;
        auto.ctx = auto.grab.getContext('2d', { willReadFrequently: true });
      }
      auto.w = w;
      auto.h = h;
      auto.ctx.drawImage(video, 0, 0, w, h);
      // Pendant le calage, on n'envoie rien : les positions changent sous les pieds du serveur.
      if (state && state.status === 'ingame' && !auto.cal) {
        const icons = SpellVision.sample(auto.ctx, cfg.spellsAuto.layout, w, h);
        const res = await fetch('/api/spells/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ icons }) });
        const json = res.ok ? await res.json().catch(() => null) : null;
        if (json) {
          auto.view = json.view || {};
          auto.valid = json.valid;
          const states = Object.values(auto.view).map((v) => v.state);
          auto.counts = { ready: states.filter((x) => x === 'ready').length, cooldown: states.filter((x) => x === 'cooldown').length, unknown: states.filter((x) => x === 'unknown').length };
        }
      }
      drawAutoPreview();
      $('auto-status').textContent = autoStatusText();
    } catch (_) {
      /* une image ratée n'a pas d'importance : la suivante arrive dans une demi-seconde */
    } finally {
      auto.busy = false;
    }
  }

  async function autoStart() {
    if (auto.stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return toast("Ce navigateur ne sait pas capturer l'écran.");
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 15 } }, audio: false });
    } catch (e) {
      return toast(e && e.name === 'NotAllowedError' ? 'Capture annulée ou refusée.' : "Capture de l'écran impossible.");
    }
    const video = $('auto-video');
    video.srcObject = stream;
    try {
      await video.play();
    } catch (_) {
      /* la lecture démarre dès que des images arrivent */
    }
    stream.getVideoTracks()[0].addEventListener('ended', autoStop);
    Object.assign(auto, { stream, view: {}, valid: null, counts: null, cal: null });
    auto.timer = setInterval(autoTick, AUTO_MS);
    renderAuto();
    autoTick();
  }

  function autoStop() {
    clearInterval(auto.timer);
    auto.timer = 0;
    if (auto.stream) for (const t of auto.stream.getTracks()) t.stop();
    auto.stream = null;
    auto.cal = null;
    $('auto-video').srcObject = null;
    $('auto-canvas').classList.remove('calibrating');
    renderAuto();
  }

  function autoCalibrate(team) {
    auto.cal = { team, pts: [] };
    $('auto-canvas').classList.add('calibrating');
    drawAutoPreview();
    $('auto-status').textContent = autoStatusText();
  }

  $('auto-start').addEventListener('click', autoStart);
  $('auto-stop').addEventListener('click', autoStop);
  $('auto-cal-ORDER').addEventListener('click', () => autoCalibrate('ORDER'));
  $('auto-cal-CHAOS').addEventListener('click', () => autoCalibrate('CHAOS'));
  $('auto-cal-reset').addEventListener('click', () => patch({ spellsAuto: { resetLayout: true } }));
  $('auto-order').addEventListener('change', (e) => patch({ spellsAuto: { order: e.target.value } }));
  $('auto-threshold').addEventListener('input', (e) => {
    $('auto-threshold-out').textContent = e.target.value + ' %';
    debounce('auto-threshold', () => patch({ spellsAuto: { threshold: Number(e.target.value) / 100 } }));
  });
  $('auto-values').addEventListener('change', drawAutoPreview);
  $('auto-canvas').addEventListener('click', (e) => {
    if (!auto.cal) return;
    const b = e.currentTarget.getBoundingClientRect();
    auto.cal.pts.push({ x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height });
    if (auto.cal.pts.length < 3) {
      drawAutoPreview();
      $('auto-status').textContent = autoStatusText();
      return;
    }
    const { team, pts } = auto.cal;
    const side = SpellVision.layoutFromClicks(pts, auto.w, auto.h);
    auto.cal = null;
    $('auto-canvas').classList.remove('calibrating');
    if (side) patch({ spellsAuto: { layout: { [team]: side } } });
    else toast('Ces trois clics ne sont pas dans le bon ordre : recommencez.');
    drawAutoPreview();
    $('auto-status').textContent = autoStatusText();
  });
  window.addEventListener('pagehide', autoStop);

  /* ------------------------------------------------------------ drafter */

  const POSITIONS = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];
  const LINKS = [['blue', 'Équipe bleue', 'ORDER'], ['red', 'Équipe rouge', 'CHAOS'], ['spec', 'Spectateur (lecture seule)', 'spec'], ['admin', 'Régie (joue pour l\'équipe dont c\'est le tour)', 'admin']];
  let linkKey = null; // adresse pour laquelle les liens affichés ont été demandés (null : pas encore demandés)
  const rosterInputs = { blue: [], red: [] };

  function buildDrafterSetup() {
    for (const side of ['blue', 'red']) {
      const box = $('dr-roster-' + side);
      POSITIONS.forEach((pos, i) => {
        const label = el('label', 'fld', pos);
        const input = el('input');
        input.type = 'text';
        input.maxLength = 24;
        input.placeholder = `Joueur ${i + 1}`;
        input.autocomplete = 'off';
        input.addEventListener('input', () => debounce('dr-roster', saveDrafterSetup));
        label.append(input);
        box.append(label);
        rosterInputs[side].push(input);
      });
    }
    $('dr-seconds').addEventListener('input', () => debounce('dr-roster', saveDrafterSetup));
    for (const [slot] of LINKS) {
      const row = el('div', 'dr-link');
      const name = el('span', 'dr-link-name');
      const input = el('input');
      input.type = 'text';
      input.readOnly = true;
      input.id = 'dr-link-' + slot;
      const copy = el('button', 'btn small', 'Copier');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        await copyText(input.value);
        copy.textContent = 'Copié ✓';
        setTimeout(() => (copy.textContent = 'Copier'), 1500);
      });
      const count = el('span', 'dr-count');
      count.id = 'dr-n-' + slot;
      row.append(name, input, copy, count);
      row.dataset.slot = slot;
      $('dr-links').append(row);
    }
    LINKS.forEach(([slot, label]) => (document.querySelector(`.dr-link[data-slot=${slot}] .dr-link-name`).textContent = label));
  }

  const rosterOf = () => ({ blue: rosterInputs.blue.map((i) => i.value), red: rosterInputs.red.map((i) => i.value) });
  const saveDrafterSetup = () => patch({ drafter: { roster: rosterOf(), turnSeconds: Number($('dr-seconds').value) || 30 } });
  const drafterCmd = (action, extra) => api('POST', '/api/drafter', { action, ...extra });

  /* Les liens ne sont jamais dans l'état diffusé : on les demande au serveur quand le draft s'ouvre ou que l'adresse change. */
  async function refreshLinks() {
    try {
      const res = await api('GET', '/api/drafter');
      if (!res.active) return;
      for (const [slot] of LINKS) $('dr-link-' + slot).value = res.links[slot];
      if (document.activeElement !== $('dr-base')) $('dr-base').value = cfg.drafter.base || '';
      $('dr-base').placeholder = res.base;
      $('dr-port').textContent = res.port;
      const sugg = $('dr-sugg');
      sugg.textContent = '';
      for (const url of res.suggestions) {
        const b = el('button', 'btn small ghost', url);
        b.type = 'button';
        b.title = 'Utiliser cette adresse';
        b.addEventListener('click', () => patch({ drafter: { base: url } }));
        sugg.append(b);
      }
    } catch (_) {
      /* l'erreur est déjà affichée */
    }
  }

  const clockText = (ms) => {
    const sec = Math.ceil(Math.max(0, ms) / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };

  function renderDrafter() {
    const d = state.drafter || { active: false };
    const t = cfg.teams;
    $('dr-blue-title').textContent = t.blue.name || 'Équipe bleue';
    $('dr-red-title').textContent = t.red.name || 'Équipe rouge';
    $('dr-setup').hidden = d.active;
    $('dr-live').hidden = !d.active;
    $('dr-badge').hidden = !d.active;
    if (!d.active) {
      linkKey = null;
      for (const side of ['blue', 'red']) cfg.drafter.roster[side].forEach((name, i) => setIfIdle(rosterInputs[side][i], name, 'dr-roster'));
      setIfIdle($('dr-seconds'), cfg.drafter.turnSeconds, 'dr-roster');
      return;
    }
    const key = String(cfg.drafter.base);
    if (key !== linkKey) {
      linkKey = key;
      refreshLinks();
    }
    const cur = d.current;
    const who = cur ? (cur.side === 'ORDER' ? t.blue.name || 'L\'équipe bleue' : t.red.name || 'L\'équipe rouge') : '';
    const left = d.running ? Math.max(0, d.leftMs - (performance.now() - recvAt)) : d.leftMs;
    let text = '';
    let hint = '';
    if (d.status === 'lobby') {
      text = 'Draft créé : envoyez les liens, puis démarrez quand tout le monde est prêt.';
      hint = 'Tant que le draft n\'est pas démarré, rien ne s\'affiche dans l\'overlay.';
    } else if (d.status === 'running') text = `Tour ${d.turn + 1} sur ${d.total} · ${who} ${cur.type === 'ban' ? 'bannit' : 'choisit'} · ${clockText(left)}`;
    else if (d.status === 'paused') text = `En pause · tour ${d.turn + 1} sur ${d.total} · ${clockText(d.leftMs)}`;
    else {
      text = 'Draft terminé.';
      hint = 'L\'overlay garde le draft à l\'écran. « Fermer le draft » le retire et lance la page de chargement de la partie.';
    }
    $('dr-status').textContent = text;
    $('dr-hint').textContent = hint;
    $('dr-start').hidden = d.status !== 'lobby';
    $('dr-pause').hidden = d.status !== 'running';
    $('dr-resume').hidden = d.status !== 'paused';
    $('dr-undo').disabled = d.status === 'lobby' || (d.turn === 0 && d.status !== 'finished');
    $('dr-skip').disabled = !(d.status === 'running' && cur && cur.type === 'ban');
    $('dr-reset').disabled = d.status === 'lobby';
    for (const [slot, , role] of LINKS) {
      const n = d.clients[role];
      $('dr-n-' + slot).textContent = n ? `${n} connecté${n > 1 ? 's' : ''}` : 'personne';
      $('dr-n-' + slot).classList.toggle('on', n > 0);
    }
  }
  setInterval(() => {
    if (state && state.drafter && state.drafter.active && state.drafter.running) renderDrafter();
  }, 500);

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
    renderAuto();
    renderDrafter();
  }

  /* ------------------------------------------------------------ onglets */

  const TABS = ['main', 'spells', 'drafter', 'display', 'teams', 'obs'];
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

  buildDrafterSetup();
  $('dr-create').addEventListener('click', async () => {
    $('dr-error').textContent = '';
    try {
      await drafterCmd('create', { roster: rosterOf(), turnSeconds: Number($('dr-seconds').value) || 30 });
    } catch (e) {
      $('dr-error').textContent = e.message;
    }
  });
  for (const [id, action] of [['dr-start', 'start'], ['dr-pause', 'pause'], ['dr-resume', 'resume'], ['dr-undo', 'undo'], ['dr-skip', 'skip'], ['dr-reset', 'reset']]) {
    $(id).addEventListener('click', () => drafterCmd(action).catch(() => {}));
  }
  $('dr-close').addEventListener('click', () => {
    if (!window.confirm('Fermer le draft ?\n\nLes liens cessent de marcher. S\'il est terminé, l\'overlay passe à la page de chargement de la partie.')) return;
    drafterCmd('close').catch(() => {});
  });
  $('dr-base').addEventListener('input', (e) => debounce('dr-base', () => patch({ drafter: { base: e.target.value.trim() } })));

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
