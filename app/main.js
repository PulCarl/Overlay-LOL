'use strict';

/*
 * Application de bureau : au lancement, on choisit le jeu (voir games.js). Le serveur du jeu
 * choisi démarre dans ce processus et son panneau de contrôle s'affiche dans la même fenêtre,
 * au lieu d'un onglet de navigateur.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const games = require('./games.js');

const LAUNCHER_FILE = path.join(__dirname, 'launcher', 'index.html');
const LAUNCHER_URL = pathToFileURL(LAUNCHER_FILE).href;
const LAUNCHER_TITLE = 'Overlay · Choisir un jeu';
const LAUNCHER_SIZE = { width: 940, height: 640 };
const DEFAULT_SIZE = { width: 780, height: 1154 };
const MIN_SIZE = { width: 560, height: 600 };

let win = null;
let quitting = false;
let dataDir = '';
let origin = ''; // adresse du panneau de contrôle affiché ; vide sur l'écran de choix

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

/* On ne retient que la fenêtre du panneau de contrôle, jamais celle de l'écran de choix. */
function saveBounds() {
  if (!win || win.isDestroyed() || !origin) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch (_) {
    /* idem */
  }
}

/* ------------------------------------------------------------ fenêtre */

/* L'écran de choix a une taille fixe ; le panneau de contrôle retrouve la taille et la place de la dernière fois. */
function sizeForLauncher() {
  if (win.isMaximized()) win.unmaximize();
  // Windows ignore la nouvelle taille d'une fenêtre déjà verrouillée : on change la taille d'abord, on verrouille ensuite.
  win.setResizable(true);
  win.setMinimumSize(LAUNCHER_SIZE.width, LAUNCHER_SIZE.height);
  win.setSize(LAUNCHER_SIZE.width, LAUNCHER_SIZE.height);
  win.setResizable(false);
  win.setMaximizable(false);
  win.center();
}

function sizeForGame() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = loadBounds();
  const width = clamp(saved.width || DEFAULT_SIZE.width, MIN_SIZE.width, area.width);
  const height = clamp(saved.height || Math.min(DEFAULT_SIZE.height, area.height), MIN_SIZE.height, area.height);
  win.setResizable(true);
  win.setMaximizable(true);
  win.setMinimumSize(MIN_SIZE.width, MIN_SIZE.height);
  win.setSize(width, height);
  if (saved.x !== undefined) win.setPosition(saved.x, saved.y);
  else win.center();
  if (saved.maximized) win.maximize();
}

function showLauncher() {
  if (!win) return;
  saveBounds();
  origin = '';
  sizeForLauncher();
  win.setTitle(LAUNCHER_TITLE);
  win.loadFile(LAUNCHER_FILE);
}

function showGame(info) {
  if (!win) return;
  origin = new URL(info.url).origin;
  sizeForGame();
  win.setTitle(info.title);
  win.loadURL(info.url);
}

function createWindow() {
  win = new BrowserWindow({
    width: LAUNCHER_SIZE.width,
    height: LAUNCHER_SIZE.height,
    show: false,
    title: LAUNCHER_TITLE,
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#07080f',
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setMinimumSize(LAUNCHER_SIZE.width, LAUNCHER_SIZE.height);
  win.center();

  win.once('ready-to-show', () => win.show());
  win.on('page-title-updated', (e) => e.preventDefault());

  // Fermer la fenêtre arrête aussi les overlays dans OBS : on demande confirmation s'il y en a un de lancé.
  win.on('close', (e) => {
    if (quitting) return;
    if (!games.anyRunning()) {
      quitting = true;
      return;
    }
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Quitter', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      title: 'Overlay',
      message: 'Quitter l\'application ?',
      detail: 'Les overlays disparaîtront d\'OBS tant que le programme est fermé.',
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
    if (url === LAUNCHER_URL || (origin && url.startsWith(origin + '/'))) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
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

  win.loadFile(LAUNCHER_FILE);
}

/* ------------------------------------------------------------ messages des pages */

/* Chaque demande n'est acceptée que de la page qui a le droit de la faire. */
const fromLauncher = (e) => !!e.senderFrame && e.senderFrame.url.split(/[?#]/)[0] === LAUNCHER_URL;
const fromGame = (e) => !!origin && !!e.senderFrame && e.senderFrame.url.startsWith(origin + '/');

function setupIpc() {
  ipcMain.handle('games:list', (e) => {
    if (!fromLauncher(e)) return { games: [], last: null };
    return { games: games.publicList(), last: games.loadLast(dataDir) };
  });

  ipcMain.handle('games:choose', async (e, id) => {
    if (!fromLauncher(e)) return { ok: false, error: 'Demande refusée.' };
    try {
      const info = await games.launch(String(id));
      games.saveLast(dataDir, info.game.id);
      showGame(info);
      return { ok: true };
    } catch (err) {
      console.error(`Démarrage de « ${id} » impossible :`, err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('games:back', (e) => {
    if (!fromGame(e)) return { ok: false };
    showLauncher();
    return { ok: true };
  });
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

  app.whenReady().then(() => {
    app.setAppUserModelId('fr.overlay-lol');
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);

    dataDir = pickDataDir();
    process.env.OVERLAY_DATA_DIR = dataDir; // à définir avant de charger un serveur de jeu
    setupLog();

    setupIpc();
    createWindow();
  });
}
