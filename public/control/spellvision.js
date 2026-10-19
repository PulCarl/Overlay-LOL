'use strict';

/*
 * Lecture de l'écran du jeu pour les chronos de sorts : où sont les vingt icônes de sorts dans l'image capturée,
 * comment mesurer leur luminance, et comment les dessiner sur l'aperçu. La décision « en recharge ou non » se prend
 * côté serveur (lib/spellwatch.js) ; ici on ne fait que mesurer.
 *
 * Les positions sont des fractions de l'image capturée (x : de la largeur, y : de la hauteur), donc elles ne dépendent
 * ni de la résolution ni de la taille de la fenêtre, seulement du cadrage. Voir DEFAULT_LAYOUT dans lib/spellwatch.js.
 */
(() => {
  const SIDES = ['ORDER', 'CHAOS'];
  const ROWS = 5;
  const SLOTS = 2;
  const COLORS = { ready: '#2fd27a', cooldown: '#ff4d70', unknown: '#9aa0b5' };

  /* Centre et côté (en pixels d'une image W×H) de l'icône « sort n° slot » du panneau n° row. */
  function rect(side, row, slot, W, H) {
    return { cx: side.x * W, cy: (side.y + row * side.pitch + slot * side.gap) * H, size: side.size * W };
  }

  /* Luminance moyenne (0 à 1) de la zone centrale de chaque icône (60 % de son côté : les bords et le cadre ne comptent pas). */
  function sample(ctx, layout, W, H) {
    const icons = {};
    for (const team of SIDES) {
      for (let row = 0; row < ROWS; row++) {
        for (let slot = 0; slot < SLOTS; slot++) {
          const r = rect(layout[team], row, slot, W, H);
          const half = Math.max(1.5, r.size * 0.3);
          const x0 = Math.max(0, Math.round(r.cx - half));
          const y0 = Math.max(0, Math.round(r.cy - half));
          const w = Math.min(W - x0, Math.round(half * 2));
          const h = Math.min(H - y0, Math.round(half * 2));
          if (w < 1 || h < 1) continue;
          const d = ctx.getImageData(x0, y0, w, h).data;
          let l = 0;
          for (let i = 0; i < d.length; i += 4) l += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          icons[`${team}:${row}:${slot}`] = { l: Math.round((l / (d.length / 4) / 255) * 10000) / 10000 };
        }
      }
    }
    return icons;
  }

  /*
   * Trois clics sur l'aperçu (fractions de l'image) : le premier sort du premier panneau, le second sort de ce même
   * panneau, le premier sort du dernier panneau. Renvoie les réglages d'un côté, ou null si les clics n'ont pas de sens.
   */
  function layoutFromClicks(pts, W, H) {
    if (!pts || pts.length < 3) return null;
    const gap = pts[1].y - pts[0].y;
    const pitch = (pts[2].y - pts[0].y) / (ROWS - 1);
    if (!(gap > 0.004) || !(pitch > gap * 1.8) || pitch > 0.3) return null;
    return { x: pts[0].x, y: pts[0].y, pitch, gap, size: (gap * 0.88 * H) / W };
  }

  /* Les joueurs dans l'ordre des panneaux du jeu, comme le serveur (voir panelRows dans server.js). */
  function panelRows(game, order) {
    const out = { ORDER: [], CHAOS: [] };
    if (!game) return out;
    for (const team of SIDES) {
      const list = game.teams[team].players;
      out[team] = (order === 'role' ? list : [...list].sort((a, b) => a.index - b.index)).slice(0, ROWS);
    }
    return out;
  }

  /*
   * Dessine, sur un canvas qui montre l'image capturée, la case de chaque icône (verte : prêt, rouge : en recharge,
   * grise : inconnu), le nom du champion de chaque panneau et, si on le demande, la mesure de chaque icône.
   * opts : { view, valid, rows, values, points } ; points = clics du calage en cours.
   */
  function draw(g, cw, ch, layout, opts) {
    const view = opts.view || {};
    g.save();
    g.lineWidth = Math.max(1, cw / 640);
    g.font = `600 ${Math.max(9, Math.round(cw / 70))}px sans-serif`;
    g.textBaseline = 'middle';
    for (const team of SIDES) {
      const left = layout[team].x < 0.5;
      for (let row = 0; row < ROWS; row++) {
        const player = opts.rows && opts.rows[team] && opts.rows[team][row];
        for (let slot = 0; slot < SLOTS; slot++) {
          const id = `${team}:${row}:${slot}`;
          const r = rect(layout[team], row, slot, cw, ch);
          const v = view[id];
          g.globalAlpha = opts.valid === false ? 0.45 : 1;
          g.strokeStyle = v ? COLORS[v.state] || COLORS.unknown : COLORS.unknown;
          g.setLineDash(opts.valid === false || !v ? [3, 2] : []);
          g.strokeRect(r.cx - r.size / 2, r.cy - r.size / 2, r.size, r.size);
          if (opts.values && v && v.ratio != null) {
            g.globalAlpha = 1;
            g.fillStyle = '#fff';
            g.strokeStyle = '#000';
            const text = v.ratio.toFixed(2);
            const x = left ? r.cx + r.size * 0.75 : r.cx - r.size * 0.75 - g.measureText(text).width;
            g.lineWidth = 3;
            g.strokeText(text, x, r.cy);
            g.lineWidth = Math.max(1, cw / 640);
            g.fillText(text, x, r.cy);
          }
        }
        if (player) {
          const r0 = rect(layout[team], row, 0, cw, ch);
          const r1 = rect(layout[team], row, 1, cw, ch);
          g.globalAlpha = 1;
          g.setLineDash([]);
          g.fillStyle = '#fff';
          g.strokeStyle = '#000';
          g.lineWidth = 3;
          const w = g.measureText(player.champion).width;
          const x = left ? r0.cx - r0.size / 2 : r0.cx + r0.size / 2 - w;
          const y = (r0.cy + r1.cy) / 2 - r0.size * 2.1;
          g.strokeText(player.champion, x, y);
          g.fillText(player.champion, x, y);
          g.lineWidth = Math.max(1, cw / 640);
        }
      }
    }
    // Calage en cours : un repère à chaque clic.
    g.setLineDash([]);
    g.globalAlpha = 1;
    g.strokeStyle = '#ffd24a';
    for (const p of opts.points || []) {
      const x = p.x * cw;
      const y = p.y * ch;
      g.beginPath();
      g.moveTo(x - 8, y);
      g.lineTo(x + 8, y);
      g.moveTo(x, y - 8);
      g.lineTo(x, y + 8);
      g.stroke();
    }
    g.restore();
  }

  window.SpellVision = { rect, sample, layoutFromClicks, panelRows, draw, COLORS };
})();
