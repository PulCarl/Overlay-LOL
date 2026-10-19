'use strict';

/*
 * Page des joueurs du drafter : reçoit l'état du draft en direct, laisse l'équipe dont c'est le tour
 * survoler et verrouiller un champion, et montre le draft aux autres.
 */
(() => {
  const token = location.pathname.split('/')[2];
  const api = `/d/${token}`;
  const $ = (id) => document.getElementById(id);
  const SIDES = ['ORDER', 'CHAOS'];
  const SLOT_NAMES = ['Top', 'Jungle', 'Mid', 'ADC', 'Support'];

  let st = null; // dernier état reçu : { role, side, version, teams, view }
  let champs = []; // [{ id, key, name }]
  let version = null;
  let recvAt = 0;
  let selected = 0; // champion choisi, pas encore verrouillé
  let slot = -1; // poste choisi pour un pick
  let lastTurn = -1;
  let query = '';
  const tiles = new Map(); // id → bouton de la grille

  /* ------------------------------------------------------------ utilitaires */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const setText = (node, v) => {
    const s = String(v);
    if (node.textContent !== s) node.textContent = s;
  };
  const plain = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const champOf = (id) => champs.find((c) => c.id === id) || null;
  const iconUrl = (c) => (version ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${c.key}.png` : '');

  function image(c, cls) {
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    if (cls) img.className = cls;
    img.onerror = () => img.remove();
    if (c && version) img.src = iconUrl(c);
    return img;
  }

  let msgTimer;
  function message(text) {
    const m = $('msg');
    m.textContent = text;
    m.hidden = !text;
    clearTimeout(msgTimer);
    if (text) msgTimer = setTimeout(() => (m.hidden = true), 4500);
  }

  async function send(kind, body) {
    try {
      const res = await fetch(`${api}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Erreur ${res.status}`);
      message('');
      if (json.view) onState(json);
      return true;
    } catch (e) {
      message(e.message === 'Failed to fetch' ? 'Le serveur ne répond pas.' : e.message);
      return false;
    }
  }

  /* ------------------------------------------------------------ règles de la page */

  const view = () => st && st.view;
  const active = () => (view() && view().status === 'running' ? view().active : null);
  /* Ce lien a-t-il le droit de jouer maintenant ? La régie joue pour l'équipe dont c'est le tour. */
  const canAct = () => !!active() && (st.role === 'admin' || st.side === active().side);
  const isPick = () => !!active() && active().type === 'pick';
  const used = () => new Set(view() ? view().used : []);
  const freeSlots = (side) => {
    const taken = new Set(view().actions.filter((a) => a.type === 'pick' && a.done && !a.skipped && a.side === side).map((a) => a.slot));
    return [0, 1, 2, 3, 4].filter((s) => !taken.has(s));
  };

  /* ------------------------------------------------------------ rendu */

  function buildGrid() {
    const grid = $('grid');
    grid.textContent = '';
    tiles.clear();
    for (const c of champs) {
      const b = el('button', 'champ-btn');
      b.type = 'button';
      b.dataset.id = c.id;
      b.title = c.name;
      b.setAttribute('role', 'option');
      b.append(image(c), el('span', '', c.name));
      b.addEventListener('click', () => choose(c.id));
      grid.append(b);
      tiles.set(c.id, b);
    }
    renderGrid();
  }

  function renderGrid() {
    if (!view()) return;
    const u = used();
    const hv = view().hover.championId;
    const turnSide = active() ? active().side : null;
    const acting = canAct();
    let shown = 0;
    for (const c of champs) {
      const b = tiles.get(c.id);
      if (!b) continue;
      const match = !query || plain(c.name).includes(query);
      b.hidden = !match;
      if (match) shown += 1;
      const taken = u.has(c.id);
      b.classList.toggle('used', taken);
      b.classList.toggle('sel', acting && selected === c.id);
      b.classList.toggle('theirs', !acting && hv === c.id && !!turnSide);
      b.classList.toggle('dim', !acting);
      b.style.setProperty('--c', turnSide === 'CHAOS' ? 'var(--red)' : 'var(--blue)');
      b.disabled = taken;
      b.setAttribute('aria-selected', String(acting && selected === c.id));
    }
    setText($('count'), `${shown} champion${shown > 1 ? 's' : ''}`);
  }

  function renderBans() {
    const v = view();
    for (const side of SIDES) {
      const box = $(side === 'ORDER' ? 'bans-blue' : 'bans-red');
      const bans = v.actions.filter((a) => a.type === 'ban' && a.side === side);
      const key = JSON.stringify(bans.map((b) => [b.championId, b.done, b.skipped, v.active && v.active.id === b.id])) + version;
      if (box.dataset.k === key) continue;
      box.dataset.k = key;
      box.textContent = '';
      for (const b of bans) {
        const cls = ['ban'];
        if (b.done && b.championId) cls.push('done');
        else if (b.done) cls.push('none');
        else if (v.active && v.active.id === b.id) cls.push('active');
        const slotEl = el('div', cls.join(' '));
        const c = b.championId ? champOf(b.championId) : null;
        if (c) {
          slotEl.append(image(c));
          slotEl.title = c.name;
        }
        box.append(slotEl);
      }
    }
  }

  function renderPicks() {
    const v = view();
    for (const side of SIDES) {
      const box = $(side === 'ORDER' ? 'picks-blue' : 'picks-red');
      const cards = [];
      for (let k = 0; k < 5; k++) {
        const done = v.actions.find((a) => a.type === 'pick' && a.done && !a.skipped && a.side === side && a.slot === k);
        const hovering = !done && v.active && v.active.type === 'pick' && v.active.side === side && v.hover.championId && v.hover.slot === k;
        const id = done ? done.championId : hovering ? v.hover.championId : 0;
        cards.push({ k, id, state: done ? 'locked' : hovering ? 'hover' : 'empty', target: !done && v.active && v.active.type === 'pick' && v.active.side === side && (slot === k && canAct() && st.role !== 'spec') });
      }
      const key = JSON.stringify(cards) + v.roster[side].join('|') + version + champs.length;
      if (box.dataset.k === key) continue;
      box.dataset.k = key;
      box.textContent = '';
      for (const c of cards) {
        const card = el('div', `pick ${c.state}${c.target ? ' active' : ''}`);
        const face = el('div', 'face');
        const champ = c.id ? champOf(c.id) : null;
        if (champ) face.append(image(champ));
        const info = el('div', 'info');
        info.append(el('div', 'pos', SLOT_NAMES[c.k]), el('div', 'player', v.roster[side][c.k] || `Joueur ${c.k + 1}`), el('div', 'champ', champ ? champ.name : '—'));
        card.append(face, info);
        box.append(card);
      }
    }
  }

  function renderSlots() {
    const box = $('slots');
    const show = canAct() && isPick();
    box.hidden = !show;
    if (!show) return;
    const side = active().side;
    const free = freeSlots(side);
    if (!free.includes(slot)) slot = free[0];
    const list = $('slots-list');
    const key = free.join() + ':' + slot;
    if (list.dataset.k === key) return;
    list.dataset.k = key;
    list.textContent = '';
    for (let k = 0; k < 5; k++) {
      const b = el('button', '', SLOT_NAMES[k]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(k === slot));
      b.disabled = !free.includes(k);
      b.addEventListener('click', () => {
        slot = k;
        if (selected) send('hover', { championId: selected, slot });
        list.dataset.k = '';
        renderSlots();
      });
      list.append(b);
    }
  }

  function phaseText(v) {
    if (v.status === 'lobby') return 'En attente du début du draft';
    if (v.status === 'finished') return 'Draft terminé';
    if (v.status === 'paused') return 'Draft en pause';
    return `${v.active.type === 'ban' ? 'Phase de bans' : 'Phase de picks'} · tour ${v.turn + 1} sur ${v.total}`;
  }

  function renderHeader() {
    const v = view();
    const teams = st.teams || {};
    setText($('tag-blue'), (teams.ORDER && teams.ORDER.tag) || 'BLU');
    setText($('name-blue'), (teams.ORDER && teams.ORDER.name) || 'Équipe bleue');
    setText($('tag-red'), (teams.CHAOS && teams.CHAOS.tag) || 'RED');
    setText($('name-red'), (teams.CHAOS && teams.CHAOS.name) || 'Équipe rouge');
    document.querySelector('.side.blue').classList.toggle('active', !!active() && active().side === 'ORDER');
    document.querySelector('.side.red').classList.toggle('active', !!active() && active().side === 'CHAOS');
    setText($('phase'), phaseText(v));
    const a = active();
    const name = (side) => (teams[side] && teams[side].name) || (side === 'ORDER' ? 'L\'équipe bleue' : 'L\'équipe rouge');
    setText($('turn'), a ? `${name(a.side)} ${a.type === 'ban' ? 'bannit' : 'choisit'}` : '');

    const you = $('you');
    const roleText = { ORDER: 'Vous êtes l\'équipe bleue', CHAOS: 'Vous êtes l\'équipe rouge', admin: 'Vous êtes la régie : vous jouez pour l\'équipe dont c\'est le tour', spec: 'Vous regardez le draft (lecture seule)' }[st.role];
    const mine = canAct();
    you.classList.toggle('mine', mine);
    if (mine) setText(you, a.type === 'ban' ? 'À vous de bannir !' : 'À vous de choisir !');
    else setText(you, v.status === 'paused' ? 'Draft en pause : patientez' : roleText);
  }

  function updateTimer() {
    if (!view()) return;
    const v = view();
    const t = $('timer');
    if (!v.timer.running) {
      setText(t, '--');
      t.classList.remove('low');
      return;
    }
    const left = Math.max(0, v.timer.leftMs - (performance.now() - recvAt));
    const s = Math.ceil(left / 1000);
    setText(t, String(s).padStart(2, '0'));
    t.classList.toggle('low', s <= 10);
  }
  setInterval(updateTimer, 200);

  function renderControls() {
    const acting = canAct();
    const lock = $('lock');
    const has = !!selected || (view().hover.championId && acting);
    lock.disabled = !(acting && has);
    setText(lock, acting ? (isPick() ? 'Choisir' : 'Bannir') : 'Verrouiller');
    $('search').disabled = false;
  }

  function render() {
    const v = view();
    if (!v) {
      setText($('phase'), 'Aucun draft ouvert');
      setText($('you'), 'Le régisseur n\'a pas encore créé de draft : cette page se mettra à jour toute seule.');
      return;
    }
    if (v.turn !== lastTurn) {
      lastTurn = v.turn;
      selected = 0;
      slot = -1;
    }
    // Page rechargée en plein tour : on retrouve le champion déjà survolé.
    if (canAct() && !selected && v.hover.championId) {
      selected = v.hover.championId;
      if (isPick() && v.hover.slot >= 0) slot = v.hover.slot;
    }
    renderHeader();
    renderBans();
    renderSlots();
    renderPicks();
    renderGrid();
    renderControls();
    updateTimer();
  }

  /* ------------------------------------------------------------ actions */

  function choose(id) {
    if (!canAct() || used().has(id)) return;
    selected = id;
    renderGrid();
    renderControls();
    send('hover', { championId: id, slot: isPick() ? slot : undefined });
  }

  $('lock').addEventListener('click', () => {
    if (!canAct()) return;
    $('lock').disabled = true;
    send('lock', { championId: selected, slot: isPick() ? slot : undefined }).then((ok) => {
      if (ok) selected = 0;
      renderControls();
    });
  });

  $('search').addEventListener('input', (e) => {
    query = plain(e.target.value.trim());
    renderGrid();
  });
  // Entrée verrouille, comme le bouton.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && canAct() && selected && document.activeElement !== $('lock')) $('lock').click();
  });

  /* ------------------------------------------------------------ connexion */

  async function loadChampions() {
    if (champs.length) return;
    try {
      const res = await fetch(`${api}/champions`);
      const json = await res.json();
      champs = json.champions || [];
      if (champs.length) buildGrid();
    } catch (_) {
      /* on réessaiera au prochain état reçu */
    }
  }

  function onState(s) {
    st = s;
    recvAt = performance.now();
    if (s.version && s.version !== version) {
      version = s.version;
      for (const id of ['bans-blue', 'bans-red', 'picks-blue', 'picks-red']) $(id).dataset.k = '';
      if (champs.length) buildGrid();
    }
    loadChampions();
    render();
  }

  const es = new EventSource(`${api}/events`);
  es.onmessage = (e) => {
    try {
      onState(JSON.parse(e.data));
    } catch (err) {
      console.error('État illisible', err);
    }
  };
  es.onerror = () => {
    setText($('phase'), 'Connexion perdue…');
  };
})();
