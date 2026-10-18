'use strict';

/*
 * Overlay OBS : reçoit l'état complet du serveur (Server-Sent Events) et met à jour
 * la page sans jamais la reconstruire en entier, pour éviter tout clignotement.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const PREVIEW = params.get('preview') === '1';
  if (PREVIEW) document.body.classList.add('preview');

  const FEED_MAX = 5;
  const FEED_TTL = 8000;
  const BANNER_TTL = 4000;
  const BANNER_QUEUE_MAX = 6;

  const DRAGONS = {
    fire: { name: 'Drake infernal', color: 'var(--fire)' },
    water: { name: 'Drake des océans', color: 'var(--water)' },
    earth: { name: 'Drake des montagnes', color: 'var(--earth)' },
    air: { name: 'Drake des nuages', color: 'var(--air)' },
    hextech: { name: 'Drake hextech', color: 'var(--hextech)' },
    chemtech: { name: 'Drake chimtech', color: 'var(--chemtech)' },
    elder: { name: 'Dragon ancestral', color: 'var(--elder)' },
    unknown: { name: 'Dragon', color: 'var(--air)' },
  };

  // Pictogrammes anguleux dessinés pour l'overlay (aucun élément graphique de Riot).
  const SVG = {
    tower: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 15V6.500h2V3.500h2.200V6h1.600V3.500H11v3h2V15z"/></svg>',
    inhib: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 1l5.500 3v8L8 15l-5.500-3V4zM8 4.600L5.400 6v4L8 11.400 10.600 10V6z"/></svg>',
    herald: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M1 8c2-3.500 4.200-5 7-5s5 1.500 7 5c-2 3.500-4.200 5-7 5S3 11.500 1 8zM8 5.400a2.600 2.600 0 100 5.200 2.600 2.600 0 000-5.200z"/></svg>',
    baron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 3.500L4.800 7 8 2l3.200 5L15 3.500 13.500 13h-11z"/></svg>',
    coin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 1.500a6.500 6.500 0 100 13 6.500 6.500 0 000-13zM8 4l2.600 4L8 12 5.400 8z"/></svg>',
    swords: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.500 3l5 .4L19.600 14.500l-1.700 1.700L3.800 8z"/><path d="M20.500 3l-5 .4L4.400 14.500l1.700 1.700L20.200 8z"/><path d="M15 18l2.500-2.500 3 3-2.500 2.500zM3.500 18.500L6.500 15.500l2.500 2.500-3 3z"/></svg>',
    arrow: '<svg viewBox="0 0 22 12" aria-hidden="true"><path d="M0 4h13V0l9 6-9 6V8H0z"/></svg>',
  };

  const IMG = {
    champion: (v, k) => `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${k}.png`,
    item: (v, k) => `https://ddragon.leagueoflegends.com/cdn/${v}/img/item/${k}.png`,
  };
  const loadingArt = (k) => `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${k}_0.jpg`;

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
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const mmss = (s) => {
    const t = Math.max(0, Math.floor(s));
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  };
  const fmtK = (n) => (Math.abs(n) >= 1000 ? (Math.abs(n) / 1000).toFixed(1).replace('.', ',') + 'k' : String(Math.round(Math.abs(n))));
  const sideColor = (side) => (side === 'ORDER' ? 'var(--blue)' : 'var(--red)');
  const sideCls = (side) => (side === 'ORDER' ? 'blue' : 'red');

  function initials(name) {
    const clean = String(name || '').replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').trim();
    if (!clean) return '?';
    const parts = clean.split(/[\s'’-]+/).filter(Boolean);
    if (parts.length === 1) return parts[0][0].toUpperCase() + (parts[0][1] || '').toLowerCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  /*
   * Icône Data Dragon avec repli : une pastille d'initiales est toujours dessous,
   * l'image la recouvre seulement une fois chargée. Pas d'image cassée possible.
   */
  function icon(kind, key, label, extraCls) {
    const box = el('span', 'ico ' + kind + (extraCls ? ' ' + extraCls : ''));
    const text = kind === 'item' ? (/^\d*$/.test(label || '') ? '' : initials(label)) : initials(label);
    box.append(el('span', 'ini', text));
    const v = S && S.ddragon;
    if (v && key) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.onload = () => box.classList.add('ok');
      img.onerror = () => img.remove();
      img.src = kind === 'item' ? IMG.item(v, key) : IMG.champion(v, key);
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
    // Sans logo : l'initiale du tag (le tag complet est déjà écrit à côté).
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

  /*
   * Chiffres à largeur fixe : la police des titres n'a pas de chiffres tabulaires,
   * le chrono bougerait à chaque seconde. Chaque caractère a donc sa propre case.
   */
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
  let cfg = null;
  let recvAt = 0;
  let seen = new Set();
  let gameKey = null;

  const teamOf = (side) => (side === 'ORDER' ? cfg.teams.blue : cfg.teams.red);
  const teamNameOf = (side) => teamOf(side).name || (side === 'ORDER' ? 'Équipe bleue' : 'Équipe rouge');
  const showPlayers = () => (cfg.display.players === null ? cfg.display.mode === 'spectator' : !!cfg.display.players);

  /* -------------------------------------------------------------- barre de score */

  const bar = $('scorebar');
  const sb = {};

  function chip(cls, svg, title) {
    const c = el('span', 'chip ' + cls);
    if (svg) c.append(html('span', 'chip-ico', svg));
    const n = el('b', '', '0');
    c.append(n);
    c.title = title;
    return { root: c, n };
  }

  function buildSide(cls) {
    const root = el('div', 'sb-side ' + cls);

    const top = el('div', 'sb-top');
    const logo = el('div', 'logo-box sb-logo');
    const ident = el('div', 'sb-ident');
    const row = el('div', 'sb-tagrow');
    const tag = el('span', 'sb-tag');
    const pips = el('div', 'sb-pips');
    row.append(tag, pips);
    const name = el('div', 'sb-name');
    ident.append(row, name);
    top.append(logo, ident);

    const chips = el('div', 'sb-chips');
    const tw = chip('tw', SVG.tower, 'Tours détruites');
    const ih = chip('ih', SVG.inhib, 'Inhibiteurs détruits');
    const dr = el('span', 'chip drc');
    dr.title = 'Dragons';
    const dragons = el('span', 'dr-list');
    dr.append(dragons);
    const hr = chip('hr', SVG.herald, 'Hérauts de la Faille');
    const bn = chip('bn', SVG.baron, 'Barons Nashor');
    const gd = chip('gd', SVG.coin, 'Valeur des objets');
    chips.append(tw.root, ih.root, dr, hr.root, bn.root, gd.root);

    root.append(top, chips);
    return { root, logo, tag, name, pips, twN: tw.n, ihN: ih.n, hrN: hr.n, bnN: bn.n, gdN: gd.n, dragons, pipKey: '', dragonKey: '' };
  }

  function buildScorebar() {
    sb.blue = buildSide('blue');
    sb.red = buildSide('red');

    const center = el('div', 'sb-center');
    const inner = el('div', 'sb-center-in');
    const fight = el('div', 'sb-fight');
    sb.killsL = el('b', 'sb-kills blue', '0');
    sb.killsR = el('b', 'sb-kills red', '0');
    fight.append(sb.killsL, html('span', 'sb-swords', SVG.swords), sb.killsR);
    sb.timer = el('div', 'sb-timer');
    setDigits(sb.timer, '00:00');
    const gauge = el('div', 'sb-gauge');
    sb.fill = el('div', 'sb-fill');
    sb.mark = el('div', 'sb-mark');
    gauge.append(el('div', 'sb-notch'), sb.fill, sb.mark);
    const goldrow = el('div', 'sb-goldrow');
    sb.diff = el('span', 'sb-diff', '=');
    sb.lbl = el('span', 'sb-lbl', 'Valeur objets');
    goldrow.append(sb.diff, sb.lbl);
    sb.goldrow = goldrow;
    inner.append(fight, sb.timer, gauge, goldrow);
    center.append(inner);
    center.title = 'Valeur des objets : or réellement dépensé en objets (l\'or non dépensé des adversaires n\'est pas disponible).';
    bar.append(sb.blue.root, center, sb.red.root);
  }

  function renderPips(ref, slot) {
    const need = cfg.series.format === 1 ? 0 : Math.ceil(cfg.series.format / 2);
    const score = cfg.series[slot];
    const key = need + ':' + score;
    if (ref.pipKey === key) return;
    ref.pipKey = key;
    ref.pips.textContent = '';
    for (let i = 0; i < need; i++) ref.pips.append(el('i', 'pip' + (i < score ? ' on' : '')));
    ref.pips.style.display = need ? '' : 'none';
  }

  function renderDragons(ref, stats) {
    const list = stats.dragons || [];
    const key = list.join(',') + '/' + (stats.elders || 0);
    if (ref.dragonKey === key) return;
    ref.dragonKey = key;
    ref.dragons.textContent = '';
    const slots = Math.max(4, list.length);
    for (let i = 0; i < slots; i++) {
      const d = el('i', 'dr');
      if (list[i]) {
        d.classList.add('on');
        d.style.setProperty('--d', (DRAGONS[list[i]] || DRAGONS.unknown).color);
        d.title = (DRAGONS[list[i]] || DRAGONS.unknown).name;
      }
      ref.dragons.append(d);
    }
    for (let i = 0; i < (stats.elders || 0); i++) {
      const d = el('i', 'dr on elder');
      d.style.setProperty('--d', 'var(--elder)');
      d.title = DRAGONS.elder.name;
      ref.dragons.append(d);
    }
    if (list.length >= 4) ref.dragons.append(el('span', 'soul', 'Âme'));
  }

  function renderScorebar(g) {
    for (const [side, ref, slot] of [['ORDER', sb.blue, 'blue'], ['CHAOS', sb.red, 'red']]) {
      const t = cfg.teams[slot];
      const st = g.teams[side].stats;
      setLogo(ref.logo, t.logo, t.tag);
      setText(ref.tag, t.tag || (slot === 'blue' ? 'BLU' : 'RED'));
      setText(ref.name, t.name);
      setText(ref.twN, st.towers);
      setText(ref.ihN, st.inhibs);
      setText(ref.hrN, st.heralds);
      setText(ref.bnN, st.barons);
      setText(ref.gdN, fmtK(st.itemGold));
      renderPips(ref, slot);
      renderDragons(ref, st);
    }
    setText(sb.killsL, g.teams.ORDER.stats.kills);
    setText(sb.killsR, g.teams.CHAOS.stats.kills);

    const diff = g.teams.ORDER.stats.itemGold - g.teams.CHAOS.stats.itemGold;
    const p = clamp(diff / 6000, -1, 1);
    const half = Math.abs(p) * 50;
    sb.fill.style.left = (p > 0 ? 50 - half : 50) + '%';
    sb.fill.style.width = half + '%';
    sb.mark.style.left = 50 + p * 50 + '%';
    const lead = Math.abs(diff) < 100 ? 'even' : diff > 0 ? 'blue' : 'red';
    sb.goldrow.className = 'sb-goldrow lead-' + lead;
    setText(sb.diff, lead === 'even' ? '=' : '+' + fmtK(diff));
    updateClock();
  }

  function updateClock() {
    if (!S || !S.game) return;
    let t = S.game.gameTime;
    if (S.status === 'ingame') {
      const elapsed = Math.min((performance.now() - recvAt) / 1000, 1.2);
      t += elapsed * (S.clockRate || 1);
    }
    setDigits(sb.timer, mmss(t));
  }
  setInterval(updateClock, 200);

  /* ------------------------------------------------------------ fil d'actions */

  const feedEl = $('feed');

  function removeRow(row) {
    if (!row || row.dataset.gone) return;
    row.dataset.gone = '1';
    row.classList.remove('in');
    row.classList.add('out');
    setTimeout(() => row.remove(), 320);
  }

  function actorIcon(a, side) {
    if (a && a.champKey) return icon('champ', a.champKey, a.champion || a.name, 'sm ring-' + sideCls(side));
    const box = el('span', 'ico champ sm npc ring-' + sideCls(side));
    box.append(el('span', 'ini', '×'));
    return box;
  }

  function buildFeedRow(ev) {
    const side = ev.team || 'ORDER';
    const row = el('div', 'frow ' + ev.kind + ' ' + sideCls(side));
    if (ev.kind === 'kill') {
      const k = ev.killer || {};
      const v = ev.victim || {};
      const victimSide = side === 'ORDER' ? 'CHAOS' : 'ORDER';
      row.append(actorIcon(k, side), el('span', 'fn killer', k.name || 'Exécution'));
      row.append(html('span', 'arrow', SVG.arrow));
      row.append(el('span', 'fn victim', v.name || '?'), actorIcon(v, v.team || victimSide));
      if (ev.assists > 0) row.append(el('span', 'assist', '+' + ev.assists));
    } else {
      row.append(html('span', 'tw-ico', SVG.tower));
      const t = teamOf(side);
      row.append(el('span', 'fn', 'Tour détruite'), el('span', 'ftag', t.tag || teamNameOf(side)));
    }
    return row;
  }

  function pushFeed(ev) {
    const row = buildFeedRow(ev);
    feedEl.append(row);
    requestAnimationFrame(() => requestAnimationFrame(() => row.classList.add('in')));
    setTimeout(() => removeRow(row), FEED_TTL);
    const live = [...feedEl.children].filter((r) => !r.dataset.gone);
    while (live.length > FEED_MAX) removeRow(live.shift());
  }

  /* ------------------------------------------------------------------ bandeaux */

  const bannersEl = $('banners');
  const queue = [];
  let bannerBusy = false;

  function bannerInfo(ev) {
    const team = teamNameOf(ev.team);
    const who = ev.actor && ev.actor.name ? ev.actor.name : '';
    const sub = who ? `${who} · ${team}` : team;
    const teamAccent = sideColor(ev.team);
    switch (ev.kind) {
      case 'dragon': {
        const d = DRAGONS[ev.dragon] || DRAGONS.unknown;
        return { title: d.name, sub, accent: d.color, flag: ev.stolen ? 'Volé !' : '', glyph: 'dragon' };
      }
      case 'baron':
        return { title: 'Nashor', sub, accent: teamAccent, flag: ev.stolen ? 'Volé !' : '', glyph: SVG.baron };
      case 'herald':
        return { title: 'Héraut de la Faille', sub, accent: teamAccent, flag: ev.stolen ? 'Volé !' : '', glyph: SVG.herald };
      case 'atakhan':
        return { title: 'Atakhan', sub, accent: teamAccent, flag: ev.stolen ? 'Volé !' : '', glyph: SVG.baron };
      case 'inhib':
        return { title: 'Inhibiteur détruit', sub: team, accent: teamAccent, glyph: SVG.inhib };
      case 'firstblood':
        return { title: 'Premier sang', sub, accent: teamAccent, glyph: SVG.swords };
      case 'multikill':
        return { title: ev.label || 'Multikill', sub, accent: teamAccent, glyph: SVG.swords };
      case 'ace':
        return { title: 'Ace', sub: `${team} élimine toute l'équipe adverse`, accent: teamAccent, glyph: SVG.swords };
      default:
        return { title: ev.kind, sub, accent: teamAccent, glyph: SVG.swords };
    }
  }

  function enqueueBanner(ev) {
    queue.push(ev);
    if (queue.length > BANNER_QUEUE_MAX) queue.splice(0, queue.length - BANNER_QUEUE_MAX);
    pumpBanners();
  }

  function pumpBanners() {
    if (bannerBusy || !queue.length) return;
    bannerBusy = true;
    const ev = queue.shift();
    const info = bannerInfo(ev);
    const node = el('div', 'banner');
    node.style.setProperty('--accent', info.accent);

    // Pastille de gauche : le champion s'il est connu, sinon un pictogramme de l'objectif.
    const emblem = el('div', 'b-emblem');
    if (ev.actor && ev.actor.champKey) emblem.append(icon('champ', ev.actor.champKey, ev.actor.champion || ev.actor.name, 'md'));
    else if (info.glyph === 'dragon') emblem.append(el('i', 'b-diamond'));
    else emblem.append(html('span', 'b-glyph', info.glyph));
    node.append(emblem);

    const body = el('div', 'b-body');
    body.append(el('div', 'b-kicker', teamNameOf(ev.team)));
    const title = el('div', 'b-title', info.title);
    if (info.flag) title.append(el('span', 'b-flag', info.flag));
    body.append(title, el('div', 'b-sub', info.sub));
    node.append(body);

    bannersEl.append(node);
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('in')));
    setTimeout(() => {
      node.classList.remove('in');
      node.classList.add('out');
      setTimeout(() => {
        node.remove();
        bannerBusy = false;
        pumpBanners();
      }, 360);
    }, BANNER_TTL);
  }

  function clearTransient() {
    feedEl.textContent = '';
    queue.length = 0;
  }

  /* ------------------------------------------------ tableau des joueurs (échelle) */

  const playersEl = $('players');
  let playersKey = '';
  let rows = [];

  function buildRow(p, side) {
    const root = el('div', 'prow ' + sideCls(side));
    const champ = icon('champ', p.champKey, p.champion || p.name, 'lg');
    const lvl = el('b', 'lvl', p.level);
    const resp = el('span', 'resp');
    champ.append(lvl, resp);
    const id = el('div', 'pr-id');
    const name = el('span', 'pn', p.name);
    const kda = el('span', 'kda');
    const k = el('b', 'k', '0');
    const d = el('b', 'd', '0');
    const a = el('b', 'a', '0');
    kda.append(k, el('s', '', '/'), d, el('s', '', '/'), a);
    id.append(name, kda);
    const items = el('div', 'pr-items');
    const cs = el('div', 'pr-cs');
    root.append(champ, id, items, cs);
    return { root, name, k, d, a, lvl, resp, items, cs, itemKey: null };
  }

  function renderItems(ref, p) {
    const key = p.items.map((i) => `${i.slot}:${i.id}x${i.count}`).join(',');
    if (ref.itemKey === key) return;
    ref.itemKey = key;
    ref.items.textContent = '';
    const bySlot = new Map(p.items.map((i) => [i.slot, i]));
    for (let slot = 0; slot < 6; slot++) {
      const it = bySlot.get(slot);
      if (!it) {
        ref.items.append(el('span', 'ico item empty'));
        continue;
      }
      const ic = icon('item', it.id, it.name);
      if (it.count > 1) ic.append(el('b', 'cnt', it.count));
      ref.items.append(ic);
    }
  }

  function renderPlayers(g) {
    const rosters = ['ORDER', 'CHAOS'].map((s) => g.teams[s].players.map((p) => p.champKey).join(','));
    const key = [S.gameId, S.ddragon, ...rosters].join('|');
    if (key !== playersKey) {
      playersKey = key;
      playersEl.textContent = '';
      rows = [];
      const blue = el('div', 'pcol blue');
      const red = el('div', 'pcol red');
      for (const [side, col] of [['ORDER', blue], ['CHAOS', red]]) {
        g.teams[side].players.forEach((p) => {
          const r = buildRow(p, side);
          rows.push({ side, p: p.index, ...r });
          col.append(r.root);
        });
      }
      playersEl.append(blue, red);
    }
    for (const c of rows) {
      const p = g.teams[c.side].players.find((x) => x.index === c.p);
      if (!p) continue;
      setText(c.name, p.name);
      setText(c.k, p.kills);
      setText(c.d, p.deaths);
      setText(c.a, p.assists);
      setText(c.lvl, p.level);
      setText(c.cs, p.cs);
      setText(c.resp, p.isDead && p.respawn > 0 ? p.respawn : '');
      c.root.classList.toggle('dead', !!p.isDead);
      renderItems(c, p);
    }
  }

  /* ------------------------------------------------------------------ sponsors */

  const sponsorEl = $('sponsor');
  let sponsorKey = '';
  let sponsorIdx = 0;
  let sponsorTimer = null;

  function sponsorItems() {
    return (cfg.sponsors || []).filter((s) => s.text || s.image);
  }

  function showSponsor() {
    const list = sponsorItems();
    sponsorEl.textContent = '';
    if (!list.length) return;
    const s = list[sponsorIdx % list.length];
    const inner = el('div', 'sp-inner');
    if (s.image) {
      const img = new Image();
      img.alt = '';
      img.onerror = () => img.remove();
      img.src = s.image;
      inner.append(img);
    }
    if (s.text) inner.append(el('span', '', s.text));
    sponsorEl.append(inner);
    requestAnimationFrame(() => inner.classList.add('in'));
  }

  function renderSponsors() {
    const list = sponsorItems();
    const key = JSON.stringify(list) + '|' + cfg.sponsorInterval;
    if (key !== sponsorKey) {
      sponsorKey = key;
      sponsorIdx = 0;
      clearInterval(sponsorTimer);
      showSponsor();
      if (list.length > 1) {
        sponsorTimer = setInterval(() => {
          sponsorIdx += 1;
          const inner = sponsorEl.firstElementChild;
          if (inner) inner.classList.remove('in');
          setTimeout(showSponsor, 350);
        }, Math.max(3, cfg.sponsorInterval) * 1000);
      }
    }
  }

  /* -------------------------------------------------------------- écran de fin */

  const endEl = $('endscreen');
  let endKey = '';

  const slotOfSide = (side, flipped) => ((side === 'ORDER') !== !!flipped ? 'blue' : 'red');

  function teamNameOf2(eg, side) {
    const t = cfg.teams[slotOfSide(side, eg.flipped)];
    return t.name || (side === 'ORDER' ? 'Équipe bleue' : 'Équipe rouge');
  }

  function buildTeamBlock(eg, side) {
    const slot = slotOfSide(side, eg.flipped);
    const t = cfg.teams[slot];
    const data = eg.teams[side];
    const won = eg.winner === side;
    const block = el('div', 'tb ' + sideCls(side) + (won ? ' won' : ''));

    const head = el('div', 'tb-head');
    const logo = el('div', 'logo-box tb-logo');
    setLogo(logo, t.logo, t.tag);
    head.append(logo, el('span', 'tb-name', t.name || teamNameOf(side)));
    if (won) head.append(el('span', 'tb-win', 'Victoire'));
    const tot = el('span', 'tb-tot');
    tot.append(el('b', '', data.stats.kills), el('i', '', 'kills'));
    const gold = el('span', 'tb-gold', fmtK(data.stats.itemGold));
    gold.title = 'Valeur des objets';
    head.append(tot, gold);
    block.append(head);

    for (const p of data.players) {
      const row = el('div', 'tr' + (eg.mvp && eg.mvp.index === p.index && eg.mvp.team === side ? ' is-mvp' : ''));
      row.append(icon('champ', p.champKey, p.champion || p.name, 'md'));
      const who = el('div', 'tr-who');
      who.append(el('span', 'tr-name', p.name), el('span', 'tr-champ', p.champion));
      row.append(who);
      const kda = el('span', 'tr-kda');
      kda.append(el('b', '', p.kills), el('s', '', '/'), el('b', 'd', p.deaths), el('s', '', '/'), el('b', '', p.assists));
      row.append(kda, el('span', 'tr-cs', p.cs));
      const items = el('div', 'tr-items');
      const bySlot = new Map(p.items.map((i) => [i.slot, i]));
      for (let slot = 0; slot < 6; slot++) {
        const it = bySlot.get(slot);
        if (!it) items.append(el('span', 'ico item empty'));
        else {
          const ic = icon('item', it.id, it.name);
          if (it.count > 1) ic.append(el('b', 'cnt', it.count));
          items.append(ic);
        }
      }
      row.append(items, el('span', 'tr-gold', fmtK(p.itemGold)));
      block.append(row);
    }
    return block;
  }

  function buildMvp(eg) {
    const m = eg.mvp;
    const card = el('aside', 'mvp ' + (m ? sideCls(m.team) : ''));
    if (!m) return card;
    const art = el('div', 'mvp-art');
    art.append(el('span', 'ini', initials(m.champion || m.name)));
    if (S.ddragon && m.champKey) {
      const img = new Image();
      img.alt = '';
      img.onload = () => art.classList.add('ok');
      img.onerror = () => img.remove();
      img.src = loadingArt(m.champKey);
      art.append(img);
    }
    art.append(el('span', 'mvp-badge', 'MVP'));
    const info = el('div', 'mvp-info');
    info.append(el('div', 'mvp-name', m.name), el('div', 'mvp-champ', m.champion));
    const stats = el('div', 'mvp-stats');
    const add = (label, value) => {
      const c = el('div', 'mvp-stat');
      c.append(el('b', '', value), el('i', '', label));
      stats.append(c);
    };
    add('K / D / A', `${m.kills} / ${m.deaths} / ${m.assists}`);
    add('Participation', `${m.killParticipation}%`);
    add('CS', m.cs);
    info.append(stats);
    card.append(art, info);
    return card;
  }

  function buildCompare(eg) {
    const box = el('section', 'compare');
    box.append(el('h3', '', 'Objectifs'));
    const A = eg.teams.ORDER.stats;
    const B = eg.teams.CHAOS.stats;
    const list = [
      ['Kills', A.kills, B.kills],
      ['Tours', A.towers, B.towers],
      ['Inhibiteurs', A.inhibs, B.inhibs],
      ['Dragons', A.dragons.length + A.elders, B.dragons.length + B.elders],
      ['Barons', A.barons, B.barons],
      ['Hérauts', A.heralds, B.heralds],
      ['Larves', A.grubs, B.grubs],
      ['Valeur des objets', A.itemGold, B.itemGold, true],
    ];
    for (const [label, a, b, isGold] of list) {
      const max = Math.max(a, b, 1);
      const row = el('div', 'cmp');
      const fmt = isGold ? fmtK : String;
      const left = el('span', 'cv l' + (isGold ? ' gold' : '') + (a > b ? ' lead' : ''), fmt(a));
      const right = el('span', 'cv r' + (isGold ? ' gold' : '') + (b > a ? ' lead' : ''), fmt(b));
      const lb = el('div', 'bar l');
      const lf = el('i', a > b ? 'lead' : '');
      lf.style.width = (a / max) * 100 + '%';
      lb.append(lf);
      const rb = el('div', 'bar r');
      const rf = el('i', b > a ? 'lead' : '');
      rf.style.width = (b / max) * 100 + '%';
      rb.append(rf);
      row.append(left, lb, el('span', 'cl', label), rb, right);
      box.append(row);
    }
    return box;
  }

  function renderEnd(eg) {
    const slots = { blue: cfg.teams.blue, red: cfg.teams.red };
    const key = JSON.stringify([eg.gameId, eg.winner, eg.flipped, !!eg.preview, S.ddragon, slots, cfg.series, eg.mvp && eg.mvp.name]);
    if (key === endKey) return;
    endKey = key;
    endEl.textContent = '';

    const inner = el('div', 'end-inner');
    const head = el('header', 'end-head');
    const win = eg.winner;
    const kicker = el('div', 'end-kicker ' + (win ? sideCls(win) : ''), win ? 'Victoire' : eg.preview ? 'Aperçu · partie en cours' : 'Fin de partie');
    const title = el('div', 'end-title', win ? teamNameOf2(eg, win) : `${teamNameOf2(eg, 'ORDER')} · ${teamNameOf2(eg, 'CHAOS')}`);
    head.append(kicker, title);

    const score = el('div', 'end-score');
    for (const side of ['ORDER', 'CHAOS']) {
      const slot = slotOfSide(side, eg.flipped);
      const t = cfg.teams[slot];
      const part = el('div', 'es-team ' + sideCls(side) + (win === side ? ' won' : ''));
      const logo = el('div', 'logo-box es-logo');
      setLogo(logo, t.logo, t.tag);
      part.append(logo, el('span', 'es-tag', t.tag || (slot === 'blue' ? 'BLU' : 'RED')), el('b', 'es-n', cfg.series[slot]));
      if (side === 'CHAOS') score.append(el('span', 'es-dash', '–'));
      score.append(part);
    }
    const fmtLabel = cfg.series.format === 1 ? 'Partie unique' : `BO${cfg.series.format}`;
    head.append(score, el('div', 'end-fmt', `${fmtLabel} · ${mmss(eg.gameTime)}`));
    inner.append(head);

    const body = el('div', 'end-body');
    const board = el('section', 'board');
    board.append(buildTeamBlock(eg, 'ORDER'), buildTeamBlock(eg, 'CHAOS'));
    body.append(buildMvp(eg), board, buildCompare(eg));
    inner.append(body);
    endEl.append(inner);
  }

  /* -------------------------------------------------------------- orchestration */

  const hint = $('hint');
  hint.textContent = 'Aperçu · en attente d\'une partie';

  function onState(s) {
    const first = !S;
    S = s;
    cfg = s.config;
    recvAt = performance.now();
    stage.style.setProperty('--ui', cfg.display.scale || 1);

    const live = (s.status === 'ingame' || s.status === 'ended') && !!s.game;
    const endVisible = !!(s.endScreen && s.endScreen.visible && s.endGame);

    // Nouvelle partie : on repart de zéro et on ne rejoue pas les événements déjà présents.
    const key = s.gameId + ':' + (s.demo ? 'd' : '');
    if (key !== gameKey) {
      gameKey = key;
      seen = new Set();
      clearTransient();
      if (s.game) s.game.feed.forEach((ev) => seen.add(ev.id));
    }
    if (first && s.game) s.game.feed.forEach((ev) => seen.add(ev.id));

    if (live) {
      for (const ev of s.game.feed) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        if (endVisible) continue;
        if ((ev.kind === 'kill' || ev.kind === 'tower') && cfg.display.feed) pushFeed(ev);
        if (ev.banner && cfg.display.banners) enqueueBanner(ev);
      }
      renderScorebar(s.game);
      if (showPlayers()) renderPlayers(s.game);
    }
    if (!cfg.display.banners) queue.length = 0;

    renderSponsors();

    const hud = live && !endVisible;
    bar.classList.toggle('off', !(hud && cfg.display.scoreboard));
    feedEl.classList.toggle('off', !(hud && cfg.display.feed));
    bannersEl.classList.toggle('off', !(hud && cfg.display.banners));
    playersEl.classList.toggle('off', !(hud && showPlayers()));
    sponsorEl.classList.toggle('off', !(cfg.display.sponsors && sponsorItems().length && !endVisible));
    hint.classList.toggle('on', PREVIEW && !live && !endVisible);

    if (endVisible) renderEnd(s.endGame);
    endEl.classList.toggle('show', endVisible);
  }

  buildScorebar();
  bar.classList.add('off');

  const es = new EventSource('/events');
  es.onmessage = (e) => {
    try {
      onState(JSON.parse(e.data));
    } catch (err) {
      console.error('État illisible', err);
    }
  };
})();
