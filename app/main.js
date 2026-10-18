'use strict';

/*
 * Application de bureau : démarre le serveur de l'overlay dans ce processus et affiche
 * le panneau de contrôle dans sa propre fenêtre, au lieu d'un onglet de navigateur.
 */

const { app, BrowserWindow, Menu, dialog, nativeTheme, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const TITLE = 'Overlay LoL · Panneau de contrôle';
const DEFAULT_SIZE = { width: 780, height: 1154 };
const MIN_SIZE = { width: 560, height: 600 };

let win = null;
let quitting = false;
let dataDir = '';
let origin = '';

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/* ------------------------------------------------------------ dossier des réglages */

/* « data » à côté du .exe (application portable) ; à défaut, le dossier utilisateur de Windows. */
function pickDataDir() {
  if (process.env.OVERLAY_DATA_DIR) return process.env.OVERLAY_DATA_DIR;
  if (!app.isPackaged) return path.join(__dirname, '..', 'data');
  const beside = path.join(path.dirname(process.execPath), 'data');
  try {
    fs.mkdirSync(beside, { recursive: true });
    const probe = path.join(beside, '.write-test');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return beside;
  } catch (_) {
    return path.join(app.getPath('userData'), 'data');
  }
}

/* Il n'y a pas de console : tout ce que le serveur écrit va dans data/overlay.log. */
function setupLog() {
  const file = path.join(dataDir, 'overlay.log');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1000000) fs.renameSync(file, file + '.old');
  } catch (_) {
    /* le journal n'est qu'un confort */
  }
  const write = (parts) => {
    try {
      fs.appendFileSync(file, parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(' ') + '\n');
    } catch (_) {
      /* idem */
    }
  };
  for (const name of ['log', 'error', 'warn']) {
    const original = console[name].bind(console);
    console[name] = (...parts) => {
      write(parts);
      try {
        original(...parts);
      } catch (_) {
        /* pas de console : normal */
      }
    };
  }
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  process.on('uncaughtException', (e) => write(['Erreur inattendue :', e]));
}

/* ------------------------------------------------------------ position de la fenêtre */

const boundsFile = () => path.join(dataDir, 'window.json');

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y < a.y + a.height - 50 && b.y + 100 > a.y;
    });
    return visible ? b : { width: b.width, height: b.height };
  } catch (_) {
    return {};
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch (_) {
    /* idem */
  }
}

/* ------------------------------------------------------------ fenêtre */

function createWindow(port) {
  origin = `http://127.0.0.1:${port}`;
  const area = screen.getPrimaryDisplay().workArea;
  const saved = loadBounds();

  win = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: clamp(saved.width || DEFAULT_SIZE.width, MIN_SIZE.width, area.width),
    height: clamp(saved.height || Math.min(DEFAULT_SIZE.height, area.height), MIN_SIZE.height, area.height),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: TITLE,
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#07080f',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });

  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize();
    win.show();
  });
  win.on('page-title-updated', (e) => e.preventDefault());

  // Fermer la fenêtre arrête aussi l'overlay dans OBS : on demande confirmation.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Quitter', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      title: 'Overlay LoL',
      message: 'Quitter Overlay LoL ?',
      detail: 'L\'overlay disparaîtra d\'OBS tant que le programme est fermé.',
    });
    if (choice === 0) {
      quitting = true;
      saveBounds();
      app.quit();
    }
  });
  win.on('closed', () => {
    win = null;
  });

  // Les liens externes (drafter.lol…) s'ouvrent dans le navigateur, jamais dans cette fenêtre.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin + '/')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      win.webContents.reload();
      e.preventDefault();
    } else if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  win.loadURL(origin + '/control');
}

/* ------------------------------------------------------------ démarrage */

if (!app.requestSingleInstanceLock()) {
  // Le programme tourne déjà : l'autre fenêtre prend la main.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.on('before-quit', () => {
    quitting = true;
    saveBounds();
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    app.setAppUserModelId('fr.overlay-lol');
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);

    dataDir = pickDataDir();
    process.env.OVERLAY_DATA_DIR = dataDir; // à définir avant de charger le serveur
    setupLog();

    let info;
    try {
      const server = require('../server.js');
      try {
        info = await server.start();
      } catch (e) {
        dialog.showErrorBox('Overlay LoL', server.startErrorMessage(e));
        app.exit(1);
        return;
      }
    } catch (e) {
      console.error(e);
      dialog.showErrorBox('Overlay LoL', `Impossible de démarrer : ${e.message}`);
      app.exit(1);
      return;
    }
    createWindow(info.port);
  });
}
