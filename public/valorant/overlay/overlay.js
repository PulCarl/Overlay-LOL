'use strict';

/*
 * Overlay OBS VALORANT : reçoit l'état complet du serveur (Server-Sent Events) et met à jour
 * la page sans jamais la reconstruire en entier, pour éviter tout clignotement.
 */
(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('preview') === '1') document.body.classList.add('preview');

  const PHASE_LABEL = { buy: 'Achat', live: 'Manche en cours', planted: 'Spike posé', over: 'Fin de manche' };
  const SIDES = ['left', 'right'];

  // Pièce (crédits) et éclair (ultime), dessinés pour cet overlay.
  const COIN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0l8 8-8 8-8-8z"/></svg>';
  const BOLT = '<svg class="pult" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 1.5 4 13.5h6.5L9.5 22.5 20 9.5h-6.8z"/></svg>';

  /* ------------------------------------------------------------ utilitaires */

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function html(tag, cls, markup) {
    const e = el(tag, cls);
    e.innerHTML = markup; // uniquement les constantes SVG ci-dessus
    return e;
  }
  const setText = (node, v) => {
    const s = String(v);
    if (node.textContent !== s) node.textContent = s;
  };
  const other = (side) => (side === 'left' ? 'right' : 'left');
  const nice = (n) => new Intl.NumberFormat('fr-FR').format(n);

  function initials(name) {
    const clean = String(name || '').replace(/[^\p{L}\p{N}\s'’/-]/gu, ' ').trim();
    if (!clean) return '?';
    const parts = clean.split(/[\s'’/-]+/).filter(Boolean);
    if (parts.length === 1) return parts[0][0].toUpperCase() + (parts[0][1] || '').toLowerCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  /* Image avec repli : des initiales sont toujours dessous, l'image les recouvre une fois chargée. */
  function picture(cls, url, label) {
    const box = el('span', cls);
    box.append(el('span', 'ini', initials(label)));
    if (url) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.onload = () => box.classList.add('ok');
      img.onerror = () => img.remove();
      img.src = url;
      box.append(img);
      if (img.complete && img.naturalWidth) box.classList.add('ok');
    }
    return box;
  }

  function setLogo(box, url, tag) {
    const k = url + '|' + tag;
    if (box.dataset.k === k) return;
    box.dataset.k = k;
    box.textContent = '';
    box.classList.remove('ok');
    box.append(el('span', 'logo-fb', (tag || '·').slice(0, 1)));
    if (url) {
      const img = new Image();
      img.alt = '';
      img.onload = () => box.classList.add('ok');
      img.onerror = () => img.remove();
      img.src = url;
      box.append(img);
      if (img.complete && img.naturalWidth) box.classList.add('ok');
    }
  }

  /* La police des titres n'a pas de chiffres tabulaires : chaque caractère du chrono a sa propre case. */
  function setDigits(node, text) {
    if (node.dataset.t === text) return;
    node.dataset.t = text;
    if (node.children.length !== text.length) {
      node.textContent = '';
      for (const ch of text) node.append(el('i', ch === ':' ? 'sep' : 'dg'));
    }
    [...text].forEach((ch, i) => {
      if (node.children[i].textContent !== ch) node.children[i].textContent = ch;
    });
  }

  /* ----------------------------------------------------------- mise à l'échelle */

  function fit() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const s = Math.min(w / 1920, h / 1080);
    stage.style.transform = `translate(${(w - 1920 * s) / 2}px, ${(h - 1080 * s) / 2}px) scale(${s})`;
  }
  window.addEventListener('resize', fit);
  fit();

  /* ------------------------------------------------------------------- état */

  let S = null; // dernier état reçu
  let offset = 0; // décalage entre l'horloge du serveur et celle de cette page
  const cat = { agents: new Map(), maps: new Map() };

  const key = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const agentOf = (name) => cat.agents.get(key(name)) || null;
  const mapOf = (name) => cat.maps.get(key(name)) || null;
  const teamName = (t, side) => t.name || (side === 'left' ? 'Équipe A' : 'Équipe B');

  /* ----------------------------------------------------------- barre de score */

  const bar = $('scorebar');
  const sb = { left: {}, right: {} };
  let timerNode = null;

  function buildTeam(side) {
    const root = el('div', `v-team side-${side}`);
    const r = sb[side];
    r.logo = el('div', 'v-logo');
    r.tag = el('span', 'v-tag');
    r.title = el('span', 'v-title');
    r.sub = el('div', 'v-sub');
    r.pips = el('div', 'v-pips');
    r.score = el('div', 'v-score', '0');
    const id = el('div', 'v-id');
    const name = el('div', 'v-name');
    name.append(r.tag, r.title);
    id.append(name, r.sub);
    // Pour l'équipe de droite, la ligne est inversée par le CSS : même ordre dans le DOM.
    root.append(r.logo, id, r.pips, r.score);
    return root;
  }

  function buildScorebar() {
    const center = el('div', 'v-center');
    sb.round = el('div', 'v-round');
    timerNode = el('div', 'v-timer');
    sb.phase = el('div', 'v-phase');
    center.append(sb.round, timerNode, sb.phase);
    bar.append(buildTeam('left'), center, buildTeam('right'));
  }

  function renderScorebar() {
    for (const side of SIDES) {
      const t = S.teams[side];
      const r = sb[side];
      setLogo(r.logo, t.logo, t.tag);
      setText(r.tag, t.tag || '···');
      r.tag.hidden = !t.tag;
      setText(r.title, teamName(t, side));
      setText(r.sub, t.sub);
      setText(r.score, S.round[side]);

      const need = S.derived.need;
      if (r.pips.children.length !== need) {
        r.pips.textContent = '';
        for (let i = 0; i < need; i++) r.pips.append(el('i', 'pip'));
      }
      [...r.pips.children].forEach((p, i) => p.classList.toggle('on', i < S.series[side]));
    }
    const n = S.round.number;
    setText(sb.round, n > 24 ? `Prolongations · ${n}` : `Manche ${n}`);
    setText(sb.phase, PHASE_LABEL[S.round.phase] || '');
    sb.phase.classList.toggle('planted', S.round.phase === 'planted');
  }

  /* Le chrono se redessine cinq fois par seconde à partir de l'heure de fin donnée par le serveur. */
  function tick() {
    if (!S) return;
    const t = S.timer;
    const remaining = t.running ? Math.max(0, t.endsAt - (Date.now() + offset)) : t.remaining;
    const sec = Math.ceil(remaining / 1000);
    setDigits(timerNode, `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
    timerNode.classList.toggle('planted', t.running && S.round.phase === 'planted');
    timerNode.classList.toggle('low', t.running && sec <= 10 && S.round.phase !== 'planted');
    timerNode.classList.toggle('idle', !t.running);
  }
  setInterval(tick, 200);

  /* ------------------------------------------------------------ bandeau des maps */

  const mapsEl = $('maps');
  let mapsKey = '';

  function renderMaps() {
    const list = S.maps;
    const k = JSON.stringify([list, S.mapIndex, S.teams.left.tag, S.teams.right.tag, cat.maps.size]);
    if (k === mapsKey) return;
    mapsKey = k;
    mapsEl.textContent = '';
    mapsEl.className = list.length >= 4 ? 'n' + Math.min(5, list.length) : '';
    list.forEach((m, i) => {
      const state = i < S.mapIndex ? 'done' : i === S.mapIndex ? 'current' : 'next';
      const chip = el('div', `v-map ${state}`);
      const info = mapOf(m.name);
      if (info) {
        const img = new Image();
        img.alt = '';
        img.onload = () => chip.classList.add('ok');
        img.onerror = () => img.remove();
        img.src = info.thumb;
        chip.append(img);
      }
      let status = 'À venir';
      if (state === 'done' && m.result) {
        status = `${m.result.left} – ${m.result.right}`;
        if (m.result.winner) chip.classList.add('side-' + m.result.winner);
      } else if (state === 'current') {
        status = 'En cours';
      } else if (m.pick === 'decider') {
        status = 'Décideur';
      } else if (m.pick === 'left' || m.pick === 'right') {
        status = 'Pick ' + (S.teams[m.pick].tag || (m.pick === 'left' ? 'A' : 'B'));
      }
      chip.append(el('span', 'st', status), el('span', 'nm', m.name || 'Map ' + (i + 1)));
      mapsEl.append(chip);
    });
  }

  /* ------------------------------------------------------------ événement */

  const eventEl = $('event');
  function renderEvent() {
    const { name, stage: st } = S.event;
    const k = name + '|' + st;
    if (eventEl.dataset.k === k) return;
    eventEl.dataset.k = k;
    eventEl.textContent = '';
    if (name) eventEl.append(el('span', 'ev-name', name));
    if (st) eventEl.append(el('span', 'ev-stage', st));
  }

  /* ------------------------------------------------------ panneaux des joueurs */

  const playersEl = $('players');
  const rows = { left: [], right: [] };

  function buildPlayers() {
    for (const side of SIDES) {
      const col = el('div', `pcol side-${side}`);
      for (let i = 0; i < 5; i++) {
        const row = el('div', 'prow');
        const r = { row, ico: null, key: '' };
        r.slot = el('span');
        r.name = el('div', 'pname');
        r.agent = el('div', 'pagent');
        r.kda = el('div', 'pkda');
        r.cred = el('span');
        const info = el('div', 'pinfo');
        info.append(r.name, r.agent, r.kda);
        const credBox = el('div', 'pcred');
        credBox.append(html('span', '', COIN).firstChild, r.cred);
        const right = el('div', 'pright');
        right.append(credBox, html('span', '', BOLT).firstChild);
        row.append(r.slot, info, right);
        rows[side].push(r);
        col.append(row);
      }
      playersEl.append(col);
    }
  }

  function renderPlayers() {
    for (const side of SIDES) {
      S.players[side].forEach((p, i) => {
        const r = rows[side][i];
        const empty = !p.name && !p.agent;
        r.row.classList.toggle('empty', empty);
        r.row.classList.toggle('dead', !p.alive);
        r.row.classList.toggle('ult', p.ult && p.alive);
        // L'icône n'est refaite que si l'agent ou le joueur change.
        const info = agentOf(p.agent);
        const ik = `${p.agent}|${p.name}|${info ? 1 : 0}`;
        if (r.key !== ik) {
          r.key = ik;
          const ico = picture('v-ico', info && info.icon, p.agent || p.name);
          r.slot.replaceWith(ico);
          r.slot = ico;
        }
        setText(r.name, p.name || p.agent);
        setText(r.agent, p.name ? p.agent : '');
        r.agent.hidden = !p.name || !p.agent;
        const kda = `${p.kills}/${p.deaths}/${p.assists}`;
        if (r.kda.dataset.k !== kda) {
          r.kda.dataset.k = kda;
          r.kda.textContent = '';
          r.kda.append(el('b', '', p.kills), el('span', 'sl', '/'), document.createTextNode(p.deaths), el('span', 'sl', '/'), document.createTextNode(p.assists));
        }
        setText(r.cred, nice(p.credits));
      });
    }
  }

  /* ------------------------------------------------------------- écran de fin */

  const endEl = $('endscreen');
  let endKey = '';

  const ratio = (p) => (p.kills / Math.max(1, p.deaths)).toFixed(2).replace('.', ',');

  function playerRow(p, side, isMvp) {
    const info = agentOf(p.agent);
    const row = el('div', 'trow' + (isMvp ? ' mvp-row' : ''));
    const name = el('div', 'pn', p.name || p.agent);
    if (p.name && p.agent) name.append(el('small', '', p.agent));
    const kda = el('div', 'kda');
    kda.append(el('b', '', p.kills), el('span', 'sl', '/'), document.createTextNode(p.deaths), el('span', 'sl', '/'), document.createTextNode(p.assists));
    const rt = el('div', 'ratio');
    rt.append(el('b', '', ratio(p)));
    row.append(picture('v-ico', info && info.icon, p.agent || p.name), name, kda, rt);
    return row;
  }

  function teamTable(d, side) {
    const t = d.teams[side];
    const box = el('div', `tbl side-${side}`);
    const head = el('div', 'tbl-head');
    head.append(el('span', 'nm', teamName(t, side)));
    if (d.winner === side) head.append(el('span', 'win', 'Victoire'));
    head.append(el('span', 'sc', d.score[side]));
    const cols = el('div', 'tbl-cols');
    cols.append(el('span'), el('span', '', 'Joueur'), el('span', '', 'K / D / A'), el('span', '', 'K/D'));
    box.append(head, cols);
    d.players[side].forEach((p, i) => {
      if (!p.name && !p.agent) return;
      const isMvp = d.mvp && d.mvp.side === side && d.mvp.index === i;
      const row = playerRow(p, side, isMvp);
      box.append(row);
    });
    return box;
  }

  function mvpCard(d) {
    const p = d.players[d.mvp.side][d.mvp.index];
    const info = agentOf(p.agent);
    const card = el('div', `mvp side-${d.mvp.side}`);
    const art = el('div', 'art');
    if (info) {
      const img = new Image();
      img.alt = '';
      img.onload = () => art.classList.add('ok');
      img.onerror = () => img.remove();
      img.src = info.portrait;
      art.append(img);
    }
    const cap = el('div', 'cap');
    cap.append(el('div', 'who', p.name || p.agent), el('div', 'ag', p.agent));
    const stats = el('div', 'stats');
    for (const [label, value] of [['K / D / A', `${p.kills} / ${p.deaths} / ${p.assists}`], ['K/D', ratio(p)]]) {
      const b = el('div');
      b.append(el('b', '', value), el('span', '', label));
      stats.append(b);
    }
    cap.append(stats);
    card.append(art, el('div', 'tag', 'MVP'), cap);
    return card;
  }

  function mapRecap(d) {
    const box = el('div', 'recap');
    box.append(el('h3', '', 'Maps'));
    d.maps.forEach((m, i) => {
      const row = el('div', 'rmap' + (m.score ? ' done' : ' pending') + (m.winner ? ' side-' + m.winner : ''));
      const info = mapOf(m.name);
      if (info) {
        const img = new Image();
        img.alt = '';
        img.onload = () => row.classList.add('ok');
        img.onerror = () => img.remove();
        img.src = info.thumb;
        row.append(img);
      }
      const nm = el('div', 'nm');
      nm.append(el('small', '', 'Map ' + (i + 1)), document.createTextNode(m.name || '—'));
      const res = el('div', 'res');
      if (m.score) {
        res.append(el('span', 'l', m.score.left), el('span', 'd', '–'), el('span', 'r', m.score.right));
      } else {
        res.textContent = 'À venir';
      }
      row.append(nm, res);
      box.append(row);
    });
    return box;
  }

  function renderEnd(d) {
    const k = JSON.stringify([d, cat.agents.size, cat.maps.size]);
    if (k === endKey) return;
    endKey = k;
    endEl.textContent = '';

    const head = el('div', 'end-head');
    const kicker = el('div', 'end-kicker' + (d.winner ? ' side-' + d.winner : ''));
    kicker.textContent = d.kind === 'match' ? 'Match terminé' : d.kind === 'map' ? `Victoire · Map ${d.mapNumber}` : 'Aperçu · map en cours';
    head.append(kicker);
    head.append(el('div', 'end-winner', d.winner ? teamName(d.teams[d.winner], d.winner) : 'Égalité'));
    const score = el('div', 'end-score');
    score.append(el('span', 'n left', d.score.left), el('span', 'dash', '–'), el('span', 'n right', d.score.right));
    head.append(score);

    const series = el('div', 'end-series');
    series.append(document.createTextNode('Série · BO' + d.format), el('b', '', `${d.series.left} – ${d.series.right}`));
    const map = el('div', 'end-map');
    map.append(document.createTextNode('Map ' + d.mapNumber), el('b', '', d.mapName || '—'));

    const body = el('div', 'end-body');
    const tables = el('div', 'tables');
    tables.append(teamTable(d, 'left'), teamTable(d, 'right'));
    if (d.mvp) body.append(mvpCard(d));
    else body.style.gridTemplateColumns = '1fr 360px';
    body.append(tables, mapRecap(d));

    endEl.append(head, series, map, body);
  }

  /* ------------------------------------------------------------ état reçu */

  function onState(s) {
    S = s;
    offset = s.now - Date.now();
    const d = s.display;
    stage.style.setProperty('--ui', d.scale);

    const endVisible = !!(s.endScreen && s.endScreen.visible && s.endScreen.data);

    renderScorebar();
    renderMaps();
    renderEvent();
    renderPlayers();
    tick();

    bar.classList.toggle('off', !(d.scorebar && !endVisible));
    mapsEl.classList.toggle('off', !(d.maps && !endVisible && s.maps.length));
    eventEl.classList.toggle('off', !(d.event && !endVisible && (s.event.name || s.event.stage)));
    playersEl.classList.toggle('off', !(d.players && !endVisible));

    if (endVisible) renderEnd(s.endScreen.data);
    endEl.classList.toggle('show', endVisible);
  }

  /* ------------------------------------------------------------ catalogue */

  // Les images des agents et des maps ; sans elles (hors connexion), des initiales prennent leur place.
  fetch('/api/catalog')
    .then((r) => r.json())
    .then((c) => {
      for (const a of c.agents) cat.agents.set(key(a.name), a);
      for (const m of c.maps) cat.maps.set(key(m.name), m);
      if (S) {
        mapsKey = '';
        endKey = '';
        rows.left.concat(rows.right).forEach((r) => (r.key = ''));
        onState(S);
      }
    })
    .catch(() => {});

  buildScorebar();
  buildPlayers();
  for (const node of [bar, mapsEl, eventEl, playersEl]) node.classList.add('off');

  const es = new EventSource('/events');
  es.onmessage = (e) => {
    try {
      onState(JSON.parse(e.data));
    } catch (err) {
      console.error('État illisible', err);
    }
  };
})();
