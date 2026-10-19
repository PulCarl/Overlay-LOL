'use strict';

/*
 * Overlay OBS : reçoit l'état complet du serveur (Server-Sent Events) et met à jour
 * la page sans jamais la reconstruire en entier, pour éviter tout clignotement.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const PREVIEW = params.get('preview') === '1';
  if (PREVIEW) document.body.classList.add('preview');
  // ?view=draft : source OBS réservée aux picks et bans (scène de sélection des champions), sans le reste.
  const VIEW_DRAFT = params.get('view') === 'draft';

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

  /*
   * Pictogrammes des objectifs : tour, inhibiteur, dragon, héraut, Nashor, or et épées croisées.
   * Icônes de Lorc et Delapouite, https://game-icons.net, licence CC BY 3.0 (voir « Crédits » du README).
   */
  const SVG = {
    tower: '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M97.812 23.375v92.875l46.22 51.72V351h-25.845L94.594 491.906H414.53L390.938 351h-25.875V167.97l46.22-51.72V23.375h-53.938v43.97H324.5v-43.97h-53.938v43.97h-32.437v-43.97h-53.938v43.97H151.75v-43.97H97.812zm73.75 152.875h18.688v50.22h-18.688v-50.22zm73.594 0h18.688v50.22h-18.688v-50.22zm74.156 0H338v50.22h-18.688v-50.22z"/></svg>',
    inhib: '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M253.8 15.56l-79.9 84.11 2.3 58.83 50.6 36.2 31.9 182 10.8-26.9 11.8-235.4 18.7 1-9.1 181 28.3-70.8 8.2-108 .9-17.93zm139 50.57l-46.6 50.77-3.9 51.1 10.6-26.2 30.4-13.7c3.2-20.6 6.3-41.3 9.5-61.97zm60.3 51.17l-85.7 38.4-102.6 255.9 14.6 83.3h7.8l147.6-293.1 16.7 8.4-143.4 284.7h24.4l146.6-291.8zm-340.2 18.9l-54.11 99.1 69.11 259.6h93.6l-51.1-274.8 18.3-3.4 51.8 278.2h19.9l-50.7-289.4zm358.3 260.4l-65.8-5.2-49.8 99.2 69.8-36.7zm-435.96-28l42.47 126.7h30.99L80.6 389.9z"/></svg>',
    dragon: '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M200.947 18.686c-6.98.087-14.64.774-22.85 1.9 27.57 20.468 51.098 45.25 67.594 70.527 1.66 0 3.312.012 4.958.047 18.066.39 35.487 2.906 53.217 7.2-15.695-28.457-29.935-50.19-47.45-63.22-13.817-10.278-30.063-16.168-52.52-16.454-.967-.013-1.95-.013-2.948 0zm-91.66 22.96c-.73-.002-1.46.006-2.195.022-14.045.31-29.36 3.92-46.86 11.13 56.18 18.807 106.985 50.468 133.907 83.585 18.377-5.13 29.44-14.72 36.454-28.817C195.84 78.18 168.118 56.19 140.65 46.96c-10.168-3.418-20.433-5.306-31.363-5.315zm-.203 52.786c-39.42 6.758-74.73 31.854-87.822 74.19v322.345h212.73C100.352 442.58 61.19 206.49 187.115 230.104c5.838-14.164 9.92-28.027 11.018-41.465l18.627 1.522c-1.684 20.592-8.828 40.49-18.033 59.943-.732 2.035-1.472 4.12-2.186 6.063 32.842 85.24 113.77 160.69 169.495 168.197.915.033 1.905-.002 2.953-.09 17.016 1.035 35.86-4.222 52.21-22.304l7.984-8.83-10.473-5.658c-6.507-3.515-14.29-7.094-18.167-10.925-1.938-1.916-2.793-3.47-3.074-5.194-.282-1.725-.13-4.227 2.23-8.578l10.673-19.656-21.484 6.222c-6.304 1.825-17.305-3.032-23.224-10.71-2.96-3.84-4.408-7.907-4.387-10.843.02-2.938.72-5.125 4.747-8.05l19.453-14.125-23.884-2.72c-9.974-1.137-16.37-6.658-19.17-12.294-2.802-5.634-2.312-10.084 1.375-13.31l12.204-10.677-15.358-5.205c-6.717-2.276-10.296-7.555-10.357-10.633-.028-1.373.238-2.666 1.843-4.476 10.93-2.39 21.258-.45 28.088 6.374 6.154 6.146 8.35 15.128 6.977 24.832 8.55-2.254 16.985-1.616 24.112 2.494 9.34 5.387 14.647 15.692 15.67 27.965 15.212-10.132 32.152-12.725 45.262-5.164 15.467 8.92 21.36 29.513 16.805 51.75 23.992-33.355 34.588-75.717 5.617-120.43-46.726-4.442-81.693-30.676-93.293-67.64-5.026-16.016-21.284-28.67-42-37.904l-.08.217c-29.74-10.823-55.575-17.35-82.604-18.733l.08.155c-2.294-.093-4.56-.16-6.762-.172-9.537 22.874-28.662 39.9-57.436 46.054l-5.906 1.262-3.576-4.864c-14.216-19.33-41.23-40.452-74.002-58.074zm156.215 65.26c27.927-.073 44.874 11.617 42.09 44.45-35.844 3.39-51.933-16.683-63.074-42.632 7.507-1.155 14.538-1.8 20.983-1.817zm48.407 66.363c3.708.07 7.14.994 10.014 2.812-1.51 1.102-2.898 2.28-4.16 3.543-5.246 5.24-8.087 12.122-7.956 18.742.183 9.322 5.27 17.184 12.68 22.56-3.14 8.103-2.452 17.455 1.407 25.22 3.813 7.668 10.54 14.273 19.302 18.398-1.445 3.366-2.375 6.862-2.4 10.33-.062 8.407 3.38 16.042 8.273 22.39 6.792 8.81 16.862 15.936 28.026 17.91-.183 2.18-.204 4.333.133 6.407 1.05 6.444 4.515 11.66 8.38 15.48 3.41 3.37 7.19 5.892 10.798 7.993-6.345 4.792-12.414 7.056-18.618 7.79-6.515-7.937-9.71-19.084-9.41-31.454-11.767 6.177-24.21 7.156-34.12 1.44-14.668-8.46-19.393-29.036-13.187-50.33-11.336 2.77-22.13.92-29.187-6.132-8.875-8.865-9.535-23.626-3.094-37.95-3.676-.615-6.963-2.166-9.525-4.725-8.808-8.798-5.773-26.09 6.776-38.626 7.843-7.835 17.546-11.957 25.87-11.8z"/></svg>',
    herald: '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M230.844 47.688c-28.215.083-58.57 2.925-91 8.78C339.666 41.874 441.95 144.504 495.938 292.75c0-143.316-92.67-245.57-265.094-245.063zm-2.656 33.624c-56.703 22.374-97.407 81.194-97.407 150.844 0 49.006 20.153 92.64 51.845 122 22.64 8.588 46.563 10.904 71.406 9.563-26.212-96.096-8.522-185.37 32.5-271-18.534-6.51-37.96-10.382-58.342-11.407zm-41.844 1.782c-43.318 5.686-90.65 23.297-142.5 54.53 24.987 97.103 56.545 155.038 92.78 187.97-15.558-27.26-24.53-59.27-24.53-93.438 0-61.93 29.422-116.84 74.25-149.062zm134.156 25c1.552 6.27 2.92 12.552 4.156 18.844-1.776-.353-3.62-.532-5.5-.532-15.486 0-28.03 12.55-28.03 28.03 0 15.483 12.544 28.033 28.03 28.033 4.33 0 8.432-.967 12.094-2.72 3.26 62.225-9.635 123.823-41.03 179.844 32.597-5.38 66.42-14.65 100.78-22.406 22.463-28.085 36.094-64.734 36.094-105.032 0-8.02-.553-15.9-1.594-23.594-31.27-44.417-66.02-78.693-105-100.468zm-301.875 48.47C36.78 459.957 249.36 479.842 493.063 343.717 306.578 348.125 115.88 532.286 18.625 156.56zm427 82.75c-1.25 33.993-11.342 65.633-27.938 92.28 23.992-4.595 48.14-7.793 72.22-7.813-13.924-30.585-28.636-58.848-44.282-84.467zm41.53 129.81c-127.06 79.076-267.344 111.63-421.03 39.126 130.246 115.856 342.11 82.373 421.03-39.125z"/></svg>',
    baron: '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M162.406 17.094l-2.5 5.468c-1.764 3.854-3.21 7.755-4.406 11.688-57.697 7.858-100.454 43.757-120.938 91.938-24.72 58.145-17.926 133.66 28.313 199.968l18.75 26.875-1.875-32.717c-2.258-39.849 6.348-76.108 24.813-105.125 1.163 4.493 3.05 8.937 5.5 13.125 6.947 11.873 18.43 22.89 33.124 31.375 10.822 6.247 21.975 10.296 32.594 12.03l-16.655 153.594-.625 5.72 4.813 3.124 88.187 57.25 5.063 3.28 5.093-3.28 88.78-57.22 4.845-3.123-.624-5.75-16.625-153.438c10.954-1.626 22.518-5.72 33.72-12.188 14.695-8.484 26.177-19.5 33.125-31.375 2.217-3.788 3.975-7.79 5.156-11.843 17.908 28.798 26.226 64.58 24 103.843l-1.842 32.718 18.75-26.874c46.238-66.307 53-141.823 28.28-199.97-20.405-47.997-62.914-83.802-120.28-91.842-1.454-4.184-3.2-8.282-5.282-12.25l-2.625-5H162.406zm12.28 18.687h164.75c12.584 29.53 5.358 68.857-19.28 104.47l-7.437 10.78 12.592 3.564c18.38 5.154 33.995 12.365 45.407 20.53-12.85.732-26.853 5.117-40.345 12.907-14.695 8.486-26.208 19.502-33.156 31.376-.412.702-.81 1.41-1.19 2.125l-.03-.03c-23.524 44.524-31.757 128.354-22.656 218.156l17.812-11.5c-5.25-63.274-1.185-123.153 9.188-164.156 5.136 4.396 11.757 6.967 18.875 8.063l16.217 149.562-2.718 1.75.092.125-71.093 45.844-5.095 3.28-5.063-3.28-70.625-45.844.094-.125-2.718-1.75L194.5 272.22c7.398-.96 14.313-3.467 19.688-7.908 10.354 41.11 14.392 101.066 9.093 164.375l17.782 11.563c8.678-84.91 1.864-164.532-18.718-210.75-1.156-3.452-2.728-6.85-4.625-10.094-6.95-11.874-18.43-22.89-33.126-31.375-13.383-7.725-27.268-12.09-40.03-12.874 11.265-7.91 26.54-14.9 44.5-20L200.186 152l-5.438-10.22c-21.613-40.676-31.158-75.677-20.063-106zm-22.905 17.626c-2.428 27.328 6.36 56.236 20.876 85.938-31.03 11.238-56.185 29.474-74.562 52.875l14.312-45-38.437 32.03 7.843-49.125-31.344 50.53-4.845-30.374c1.69-5.79 3.72-11.403 6.03-16.843 17.48-41.113 51.72-71.697 100.126-80.03zm211.657.282c47.646 8.687 81.383 39.045 98.688 79.75 3.03 7.128 5.544 14.595 7.5 22.312l-37.906-31.53 25.967 57.155-60.5-42 33.47 46.28-31.688-11.56c-3.664-3.396-7.514-6.615-11.533-9.69-.028-.022-.065-.038-.093-.06-6.315-5.24-13.66-9.945-21.844-14.126-.128-.067-.247-.155-.375-.22-.326-.175-.672-.326-1-.5-6.875-3.64-14.113-6.9-21.72-9.72 16.575-27.99 24.514-58.36 21.033-86.093zm-222.718 140c9.668.056 22.326 3.454 34.53 10.5 12.204 7.045 21.46 16.31 26.344 24.656 4.883 8.345 5.113 14.647 2.906 18.47-2.207 3.82-7.77 6.742-17.438 6.686-2.976-.017-6.245-.34-9.687-1 2.584-3.356 4.125-7.53 4.125-12.094 0-10.982-8.893-19.906-19.875-19.906-9.475 0-17.41 6.63-19.406 15.5-7.13-5.62-12.642-11.83-16.032-17.625-2.257-3.856-3.513-7.278-4-10.22h.093c0-3.024.52-6.028 1.532-9.03 2.49-3.437 7.905-5.99 16.907-5.938zm233.5 0c9.046-.053 14.496 2.505 16.967 5.968.005.007-.004.025 0 .03.99 2.987 1.47 5.978 1.47 8.97h.093c-.488 2.94-1.744 6.363-4 10.22-3.583 6.122-9.553 12.697-17.28 18.56-1.64-9.33-9.762-16.436-19.564-16.436-10.982 0-19.875 8.924-19.875 19.906 0 4.653 1.606 8.894 4.283 12.28-2.986.512-5.822.8-8.438.814-9.67.056-15.23-2.866-17.438-6.688-2.206-3.82-1.976-10.123 2.907-18.468 4.883-8.346 14.17-17.61 26.375-24.656 12.203-7.046 24.83-10.444 34.5-10.5z"/></svg>',
    coin: '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M264.4 95.01c-35.6-.06-80.2 11.19-124.2 34.09C96.27 152 61.45 182 41.01 211.3c-20.45 29.2-25.98 56.4-15.92 75.8 10.07 19.3 35.53 30.4 71.22 30.4 35.69.1 80.29-11.2 124.19-34 44-22.9 78.8-53 99.2-82.2 20.5-29.2 25.9-56.4 15.9-75.8-10.1-19.3-35.5-30.49-71.2-30.49zm91.9 70.29c-3.5 15.3-11.1 31-21.8 46.3-22.6 32.3-59.5 63.8-105.7 87.8-46.2 24.1-93.1 36.2-132.5 36.2-18.6 0-35.84-2.8-50.37-8.7l10.59 20.4c10.08 19.4 35.47 30.5 71.18 30.5 35.7 0 80.3-11.2 124.2-34.1 44-22.8 78.8-52.9 99.2-82.2 20.4-29.2 26-56.4 15.9-75.7zm28.8 16.8c11.2 26.7 2.2 59.2-19.2 89.7-18.9 27.1-47.8 53.4-83.6 75.4 11.1 1.2 22.7 1.8 34.5 1.8 49.5 0 94.3-10.6 125.9-27.1 31.7-16.5 49.1-38.1 49.1-59.9 0-21.8-17.4-43.4-49.1-59.9-16.1-8.4-35.7-15.3-57.6-20zm106.7 124.8c-10.2 11.9-24.2 22.4-40.7 31-35 18.2-82.2 29.1-134.3 29.1-21.2 0-41.6-1.8-60.7-5.2-23.2 11.7-46.5 20.4-68.9 26.1 1.2.7 2.4 1.3 3.7 2 31.6 16.5 76.4 27.1 125.9 27.1s94.3-10.6 125.9-27.1c31.7-16.5 49.1-38.1 49.1-59.9z"/></svg>',
    swords: '<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M19.75 14.438c59.538 112.29 142.51 202.35 232.28 292.718l3.626 3.75.063-.062c21.827 21.93 44.04 43.923 66.405 66.25-18.856 14.813-38.974 28.2-59.938 40.312l28.532 28.53 68.717-68.717c42.337 27.636 76.286 63.646 104.094 105.81l28.064-28.06c-42.47-27.493-79.74-60.206-106.03-103.876l68.936-68.938-28.53-28.53c-11.115 21.853-24.413 42.015-39.47 60.593-43.852-43.8-86.462-85.842-130.125-125.47-.224-.203-.432-.422-.656-.625C183.624 122.75 108.515 63.91 19.75 14.437zm471.875 0c-83.038 46.28-154.122 100.78-221.97 161.156l22.814 21.562 56.81-56.812 13.22 13.187-56.438 56.44 24.594 23.186c61.802-66.92 117.6-136.92 160.97-218.72zm-329.53 125.906l200.56 200.53c-4.36 4.443-8.84 8.793-13.405 13.032L148.875 153.53l13.22-13.186zm-76.69 113.28l-28.5 28.532 68.907 68.906c-26.29 43.673-63.53 76.414-106 103.907l28.063 28.06c27.807-42.164 61.758-78.174 104.094-105.81l68.718 68.717 28.53-28.53c-20.962-12.113-41.08-25.5-59.937-40.313 17.865-17.83 35.61-35.433 53.157-52.97l-24.843-25.655-55.47 55.467c-4.565-4.238-9.014-8.62-13.374-13.062l55.844-55.844-24.53-25.374c-18.28 17.856-36.602 36.06-55.158 54.594-15.068-18.587-28.38-38.758-39.5-60.625z"/></svg>',
    arrow: '<svg viewBox="0 0 22 12" aria-hidden="true"><path d="M0 4h13V0l9 6-9 6V8H0z"/></svg>',
  };

  const IMG = {
    champion: (v, k) => `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${k}.png`,
    item: (v, k) => `https://ddragon.leagueoflegends.com/cdn/${v}/img/item/${k}.png`,
    spell: (v, k) => `https://ddragon.leagueoflegends.com/cdn/${v}/img/spell/${k}.png`,
    // k : chemin donné par /api/runes (perk-images/Styles/…), sans version.
    rune: (v, k) => `https://ddragon.leagueoflegends.com/cdn/img/${k}`,
  };
  /*
   * Icônes des objectifs : celles du tableau de fin de partie du client LoL, en bleu (-100) ou en rouge (-200),
   * servies par Community Dragon. Si elles ne chargent pas, le pictogramme dessiné (SVG) reste affiché.
   */
  const LOL_ICONS = 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-match-history/global/default/';
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
      img.src = (IMG[kind] || IMG.champion)(v, key);
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

  /* Pictogramme d'objectif : l'icône officielle (kind : dragon, baron, herald, inhibitor, tower) par-dessus le SVG de repli. */
  function objIcon(kind, side, svg, cls) {
    const box = html('span', cls, svg || '');
    if (!kind) return box;
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.onload = () => box.classList.add('lol');
    img.onerror = () => img.remove();
    img.src = `${LOL_ICONS}${kind}-${side === 'CHAOS' ? 200 : 100}.png`;
    box.append(img);
    if (img.complete && img.naturalWidth) box.classList.add('lol');
    return box;
  }

  function chip(cls, svg, title, kind, side) {
    const c = el('span', 'chip ' + cls);
    if (svg) c.append(objIcon(kind, side, svg, 'chip-ico'));
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
    const side = cls === 'red' ? 'CHAOS' : 'ORDER';
    const tw = chip('tw', SVG.tower, 'Tours détruites', 'tower', side);
    const ih = chip('ih', SVG.inhib, 'Inhibiteurs détruits', 'inhibitor', side);
    // Dragons : tête de dragon et nombre, suivis d'un losange coloré par dragon pris (la couleur donne le type).
    const dr = chip('drc', SVG.dragon, 'Dragons', 'dragon', side);
    const dragons = el('span', 'dr-list');
    dr.root.append(dragons);
    const hr = chip('hr', SVG.herald, 'Hérauts de la Faille', 'herald', side);
    const bn = chip('bn', SVG.baron, 'Barons Nashor', 'baron', side);
    const gd = chip('gd', SVG.coin, 'Valeur des objets');
    chips.append(tw.root, ih.root, dr.root, hr.root, bn.root, gd.root);

    root.append(top, chips);
    return { root, logo, tag, name, pips, twN: tw.n, ihN: ih.n, drN: dr.n, hrN: hr.n, bnN: bn.n, gdN: gd.n, dragons, pipKey: '', dragonKey: '' };
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
    for (const type of list) {
      const known = DRAGONS[type] || DRAGONS.unknown;
      const d = el('i', 'dr');
      d.style.setProperty('--d', known.color);
      d.title = known.name;
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
      setText(ref.drN, (st.dragons || []).length + (st.elders || 0));
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

  /* Heure de jeu à cet instant : la dernière lecture, prolongée du temps écoulé depuis (au plus 1,2 s). */
  function gameNow() {
    let t = S.game.gameTime;
    if (S.status === 'ingame') {
      const elapsed = Math.min((performance.now() - recvAt) / 1000, 1.2);
      t += elapsed * (S.clockRate || 1);
    }
    return t;
  }

  function updateClock() {
    if (!S || !S.game) return;
    setDigits(sb.timer, mmss(gameNow()));
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
      row.append(objIcon('tower', side, SVG.tower, 'tw-ico'));
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
        return { title: d.name, sub, accent: d.color, flag: ev.stolen ? 'Volé !' : '', glyph: SVG.dragon, kind: 'dragon' };
      }
      case 'baron':
        return { title: 'Nashor', sub, accent: teamAccent, flag: ev.stolen ? 'Volé !' : '', glyph: SVG.baron, kind: 'baron' };
      case 'herald':
        return { title: 'Héraut de la Faille', sub, accent: teamAccent, flag: ev.stolen ? 'Volé !' : '', glyph: SVG.herald, kind: 'herald' };
      case 'atakhan':
        return { title: 'Atakhan', sub, accent: teamAccent, flag: ev.stolen ? 'Volé !' : '', glyph: SVG.baron };
      case 'inhib':
        return { title: 'Inhibiteur détruit', sub: team, accent: teamAccent, glyph: SVG.inhib, kind: 'inhibitor' };
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
    else emblem.append(objIcon(info.kind, ev.team, info.glyph, 'b-glyph'));
    node.append(emblem);

    const body = el('div', 'b-body');
    body.append(el('div', 'b-kicker', teamNameOf(ev.team)));
    const title = el('div', 'b-title', info.title);
    if (info.flag) title.append(el('span', 'b-flag', info.flag));
    body.append(title, el('div', 'b-sub', info.sub));
    node.append(body);
    // Quand la pastille montre le champion, le pictogramme de l'objectif passe à droite : on voit tout de suite de quoi il s'agit.
    if (ev.actor && ev.actor.champKey) node.append(objIcon(info.kind, ev.team, info.glyph, 'b-mark'));

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

  /* ------------------------------------------------ champions sur les côtés */

  const sidesEl = $('sides');
  const mapFrameEl = $('mapframe');
  let sidesKey = '';
  let sideRows = [];

  /*
   * Images des runes : le serveur les tire de Data Dragon (identifiant → chemin). On les demande une fois ;
   * tant que la liste est vide (Data Dragon pas encore joignable), on réessaie de temps en temps.
   */
  const runePaths = new Map();
  let runesTry = -Infinity;
  function loadRunePaths() {
    if (runePaths.size || performance.now() - runesTry < 20000) return;
    runesTry = performance.now();
    fetch('/api/runes')
      .then((r) => r.json())
      .then((d) => {
        for (const [id, r] of Object.entries(d.runes || {})) runePaths.set(Number(id), r);
      })
      .catch(() => {});
  }

  /* Un sort d'invocateur : son icône, avec le compte à rebours de sa recharge par-dessus quand un chrono tourne. */
  function spellIcon(sp) {
    const ic = icon('spell', sp.key, sp.name, 'spell');
    const cd = el('span', 'cdtxt');
    ic.append(cd);
    return { ic, cd };
  }

  /* Sorts d'invocateur et runes d'un joueur : deux petites colonnes, à l'intérieur de l'écran. */
  function miniIcons(p, refs) {
    const box = el('div', 's-mini');
    const spells = (p.spells || []).slice(0, 2);
    if (spells.length) {
      const col = el('div', 's-col');
      spells.forEach((sp, slot) => {
        const si = spellIcon(sp);
        refs.push({ slot, ic: si.ic, cd: si.cd });
        col.append(si.ic);
      });
      box.append(col);
    }
    const r = p.runes || {};
    const runes = [r.keystone, r.secondary].filter(Boolean);
    if (runes.length) {
      const col = el('div', 's-col');
      runes.forEach((ref, i) => {
        const info = runePaths.get(ref.id);
        col.append(icon('rune', info && info.icon, ref.name, 'rune' + (i ? ' tree' : '')));
      });
      box.append(col);
    }
    return box;
  }

  /* Une ligne : portrait avec niveau (ou temps de réapparition), pseudo, sorts et runes. */
  function buildSideRow(p, side) {
    const root = el('div', 'srow ' + sideCls(side));
    const champ = icon('champ', p.champKey, p.champion || p.name, 'lg');
    const lvl = el('b', 'lvl', p.level);
    const resp = el('span', 'resp');
    champ.append(lvl, resp);
    const name = el('span', 'pn', p.name);
    const spellRefs = [];
    root.append(champ, name, miniIcons(p, spellRefs));
    return { root, name, lvl, resp, spellRefs };
  }

  function renderSides(g) {
    loadRunePaths();
    // Les lignes sont refaites quand la composition, les sorts, les runes ou leurs images changent.
    const rosters = ['ORDER', 'CHAOS'].map((s) => g.teams[s].players.map((p) => [p.champKey, JSON.stringify(p.spells), JSON.stringify(p.runes)].join(',')).join(';'));
    const key = [S.gameId, S.ddragon, runePaths.size, ...rosters].join('|');
    if (key !== sidesKey) {
      sidesKey = key;
      sidesEl.textContent = '';
      sideRows = [];
      const blue = el('div', 'scol blue');
      const red = el('div', 'scol red');
      for (const [side, col] of [['ORDER', blue], ['CHAOS', red]]) {
        g.teams[side].players.forEach((p) => {
          const r = buildSideRow(p, side);
          sideRows.push({ side, p: p.index, ...r });
          col.append(r.root);
        });
      }
      sidesEl.append(blue, red);
    }
    for (const c of sideRows) {
      const p = g.teams[c.side].players.find((x) => x.index === c.p);
      if (!p) continue;
      setText(c.name, p.name);
      setText(c.lvl, p.level);
      setText(c.resp, p.isDead && p.respawn > 0 ? p.respawn : '');
      c.root.classList.toggle('dead', !!p.isDead);
    }
    updateCooldowns();
  }

  /* Compte à rebours des sorts : chronos lancés à la main depuis le panneau, en heure de jeu. */
  const fmtCd = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : String(s));
  function updateCooldowns() {
    if (!S || !S.game || !sideRows.length) return;
    const now = gameNow();
    const all = S.cooldowns || {};
    for (const c of sideRows) {
      for (const sr of c.spellRefs) {
        const cd = all[`${c.side}:${c.p}:${sr.slot}`];
        const left = cd ? Math.ceil(cd.endAt - now) : 0;
        sr.ic.classList.toggle('cd', left > 0);
        setText(sr.cd, left > 0 ? fmtCd(left) : '');
      }
    }
  }
  setInterval(updateCooldowns, 250);

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

  /* ------------------------------------------------------ picks et bans (sélection des champions) */

  const draftEl = $('draft');
  const dv = { built: false, shape: '', sides: {}, cols: {}, cards: { ORDER: [], CHAOS: [] }, leftMs: 0, at: 0, infinite: false };

  const loadingImg = (key) => loadingArt(key);

  function buildDraftSide(side) {
    const root = el('div', 'dr-side ' + sideCls(side));
    const ident = el('div', 'dr-ident');
    const logo = el('div', 'logo-box dr-logo');
    const text = el('div', 'dr-text');
    const tag = el('span', 'dr-tag');
    const name = el('div', 'dr-name');
    text.append(tag, name);
    ident.append(logo, text);
    const bans = el('div', 'dr-bans');
    root.append(ident, bans);
    return { root, logo, tag, name, bans, banKey: '' };
  }

  function buildDraftCard(side) {
    const root = el('div', 'dr-card ' + sideCls(side));
    const art = el('div', 'dr-art');
    art.append(el('span', 'ini'));
    const info = el('div', 'dr-info');
    const pos = el('div', 'dr-pos');
    const champ = el('div', 'dr-champ');
    const who = el('div', 'dr-who');
    info.append(champ, who);
    const state = el('div', 'dr-state');
    root.append(art, pos, info, state);
    return { root, art, pos, champ, who, state, imgKey: '' };
  }

  function buildDraft(d) {
    draftEl.textContent = '';
    const top = el('div', 'dr-top');
    dv.sides = { ORDER: buildDraftSide('ORDER'), CHAOS: buildDraftSide('CHAOS') };
    const center = el('div', 'dr-center');
    const inner = el('div', 'dr-center-in');
    dv.score = el('div', 'dr-score');
    dv.scoreL = el('div', 'dr-pips blue');
    dv.scoreR = el('div', 'dr-pips red');
    dv.fmt = el('span', 'dr-fmt');
    dv.score.append(dv.scoreL, dv.fmt, dv.scoreR);
    dv.scoreKey = '';
    dv.step = el('div', 'dr-step');
    dv.timer = el('div', 'dr-timer');
    dv.turn = el('div', 'dr-turn');
    inner.append(dv.score, dv.step, dv.timer, dv.turn);
    center.append(inner);
    top.append(dv.sides.ORDER.root, center, dv.sides.CHAOS.root);
    draftEl.append(top);
    for (const side of ['ORDER', 'CHAOS']) {
      const col = el('div', 'dr-col ' + sideCls(side));
      dv.cards[side] = d.teams[side].picks.map(() => buildDraftCard(side));
      dv.cards[side].forEach((c) => col.append(c.root));
      draftEl.append(col);
    }
    dv.built = true;
  }

  function renderBans(ref, bans) {
    const key = bans.map((b) => `${b.id}:${b.state}:${b.championId}`).join('|') + '/' + (S && S.ddragon);
    if (ref.banKey === key) return;
    ref.banKey = key;
    ref.bans.textContent = '';
    for (const b of bans) {
      const slot = el('div', 'ban ' + b.state);
      if (b.state === 'done') slot.append(icon('champ', b.key, b.name, 'ban-ico'));
      slot.append(el('i', 'slash'));
      slot.title = b.name || '';
      ref.bans.append(slot);
    }
  }

  function renderCard(ref, p) {
    ref.root.className = `dr-card ${ref.root.classList.contains('red') ? 'red' : 'blue'} ${p.state}${p.local ? ' local' : ''}`;
    setText(ref.pos, p.position || '');
    setText(ref.champ, p.name || '—');
    // La police des titres est très large : on réduit le nom jusqu'à ce que son plus long mot tienne dans la colonne (140 px).
    const longest = Math.max(1, ...String(p.name || '').split(/\s+/).map((w) => w.length));
    const size = Math.max(11, Math.min(24, Math.floor(140 / (longest * 0.95))));
    if (ref.size !== size) {
      ref.size = size;
      ref.champ.style.fontSize = size + 'px';
    }
    setText(ref.who, p.player || '');
    setText(ref.state, p.state === 'active' ? 'Sélection…' : p.state === 'hover' ? 'Survol' : '');
    const key = p.key && S.ddragon ? p.key : '';
    if (ref.imgKey !== key) {
      ref.imgKey = key;
      ref.art.classList.remove('ok');
      const old = ref.art.querySelector('img');
      if (old) old.remove();
      if (key) {
        const img = new Image();
        img.alt = '';
        img.onload = () => ref.art.classList.add('ok');
        img.onerror = () => img.remove();
        img.src = loadingImg(key);
        ref.art.append(img);
      }
    }
    setText(ref.art.querySelector('.ini'), p.name ? initials(p.name) : '');
  }

  /* Score de la série : un rond par victoire nécessaire, plein quand elle est acquise (la gauche suit le côté bleu). */
  function renderDraftScore() {
    const need = cfg.series.format === 1 ? 0 : Math.ceil(cfg.series.format / 2);
    const key = `${need}:${cfg.series.blue}:${cfg.series.red}`;
    if (dv.scoreKey === key) return;
    dv.scoreKey = key;
    dv.scoreL.textContent = '';
    dv.scoreR.textContent = '';
    for (let i = 0; i < need; i++) {
      dv.scoreL.append(el('i', i < cfg.series.blue ? 'on' : ''));
      dv.scoreR.append(el('i', i < cfg.series.red ? 'on' : ''));
    }
    setText(dv.fmt, need ? `BO${cfg.series.format}` : '');
    dv.score.style.display = need ? '' : 'none';
  }

  function renderDraft(d) {
    const shape = d.teams.ORDER.picks.length + ':' + d.teams.CHAOS.picks.length;
    if (!dv.built || shape !== dv.shape) {
      dv.shape = shape;
      buildDraft(d);
    }
    renderDraftScore();
    for (const side of ['ORDER', 'CHAOS']) {
      const slot = side === 'ORDER' ? 'blue' : 'red';
      const t = cfg.teams[slot];
      const ref = dv.sides[side];
      setLogo(ref.logo, t.logo, t.tag);
      setText(ref.tag, t.tag || (slot === 'blue' ? 'BLU' : 'RED'));
      setText(ref.name, t.name);
      ref.root.classList.toggle('active', d.active.includes(side));
      renderBans(ref, d.teams[side].bans);
      d.teams[side].picks.forEach((p, i) => renderCard(dv.cards[side][i], p));
    }
    setText(dv.step, d.label);
    const names = d.active.map((side) => teamNameOf(side));
    const verb = d.activeType === 'ban' ? 'bannit' : 'choisit';
    setText(dv.turn, d.active.length === 1 ? `${names[0]} ${verb}` : d.active.length > 1 ? `Les deux équipes ${d.activeType === 'ban' ? 'bannissent' : 'choisissent'}` : '');
    dv.leftMs = d.timer.leftMs;
    dv.infinite = d.timer.infinite;
    dv.at = performance.now();
    updateDraftTimer();
  }

  function updateDraftTimer() {
    if (!dv.built || !S || !S.draft || !S.draft.data) return;
    const left = Math.max(0, dv.leftMs - (performance.now() - dv.at));
    setDigits(dv.timer, dv.infinite || !dv.leftMs ? '--' : String(Math.ceil(left / 1000)).padStart(2, '0'));
  }
  setInterval(updateDraftTimer, 200);

  /* -------------------------------------------------------------- orchestration */

  const hint = $('hint');
  hint.textContent = VIEW_DRAFT ? 'Aperçu · en attente de la sélection des champions' : 'Aperçu · en attente d\'une partie';

  function onState(s) {
    const first = !S;
    S = s;
    cfg = s.config;
    recvAt = performance.now();
    stage.style.setProperty('--ui', cfg.display.scale || 1);

    const draftOn = !!(s.draft && s.draft.visible && s.draft.data);
    const live = (s.status === 'ingame' || s.status === 'ended') && !!s.game && !VIEW_DRAFT;
    // Pendant une sélection des champions, l'écran de fin de la partie précédente s'efface.
    const endVisible = !!(s.endScreen && s.endScreen.visible && s.endGame) && !draftOn && !VIEW_DRAFT;

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
      if (cfg.display.sides) renderSides(s.game);
    }
    if (!cfg.display.banners) queue.length = 0;

    renderSponsors();

    const hud = live && !endVisible && !draftOn;
    bar.classList.toggle('off', !(hud && cfg.display.scoreboard));
    feedEl.classList.toggle('off', !(hud && cfg.display.feed));
    bannersEl.classList.toggle('off', !(hud && cfg.display.banners));
    sidesEl.classList.toggle('off', !(hud && cfg.display.sides));
    mapFrameEl.classList.toggle('off', !(hud && cfg.display.mapFrame));
    mapFrameEl.style.setProperty('--map', (cfg.display.mapSize || 280) + 'px');
    playersEl.classList.toggle('off', !(hud && showPlayers()));
    sponsorEl.classList.toggle('off', !(cfg.display.sponsors && sponsorItems().length && !endVisible && !draftOn && !VIEW_DRAFT));
    hint.classList.toggle('on', PREVIEW && (VIEW_DRAFT ? !draftOn : !live && !endVisible && !draftOn));

    if (endVisible) renderEnd(s.endGame);
    endEl.classList.toggle('show', endVisible);

    if (draftOn) renderDraft(s.draft.data);
    draftEl.classList.toggle('show', draftOn);
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
