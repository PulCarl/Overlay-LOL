'use strict';

/*
 * Fabrique l'application de bureau : dist/Overlay-LoL/Overlay-LoL.exe (Electron).
 * Lancer avec « npm run build:app », sous Windows.
 *
 * Le dossier produit est autonome (rien à installer) : on peut le copier où on veut,
 * ou le compresser en .zip pour le partager.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIcon } = require('./icon');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TARGET = path.join(DIST, 'Overlay-LoL');
// Langues gardées dans Chromium : le reste pèse une quarantaine de Mo pour rien.
const KEEP_LOCALES = new Set(['fr.pak', 'en-US.pak']);

const step = (msg) => console.log(`\n▸ ${msg}`);

const CLOSE_MSG = 'Fermez Overlay LoL (la fenêtre et le programme) avant de reconstruire, puis relancez la commande.';

/* Un .exe en cours d'exécution ne peut pas être ouvert en écriture : on le vérifie AVANT de supprimer quoi que ce soit. */
function assertNotRunning() {
  const exe = path.join(TARGET, 'Overlay-LoL.exe');
  if (!fs.existsSync(exe)) return;
  try {
    fs.closeSync(fs.openSync(exe, 'r+'));
  } catch (e) {
    throw new Error(`Overlay-LoL.exe est en cours d'utilisation (${e.code}). ${CLOSE_MSG}`);
  }
}

/* Antivirus et explorateur verrouillent parfois un fichier une fraction de seconde : on réessaie. */
function removeWithRetry(target) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= 6) throw new Error(`Impossible de supprimer ${path.relative(ROOT, target)} (${e.code}). ${CLOSE_MSG}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

async function main() {
  assertNotRunning();
  const pkg = require(path.join(ROOT, 'package.json'));
  const electronVersion = require('electron/package.json').version;

  // Tout se prépare dans un dossier temporaire au chemin court (voir build-exe.js).
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lolapp-'));
  const stage = path.join(WORK, 'app');
  fs.mkdirSync(path.join(stage, 'app'), { recursive: true });

  step('Préparation des fichiers');
  for (const item of ['server.js', 'lib', 'public']) fs.cpSync(path.join(ROOT, item), path.join(stage, item), { recursive: true });
  for (const item of ['main.js', 'games.js', 'preload.js', 'launcher']) {
    fs.cpSync(path.join(ROOT, 'app', item), path.join(stage, 'app', item), { recursive: true });
  }
  const icon = makeIcon();
  fs.writeFileSync(path.join(stage, 'app', 'icon.png'), icon.png);
  const icoPath = path.join(WORK, 'icon.ico');
  fs.writeFileSync(icoPath, icon.ico);
  fs.writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify({ name: 'overlay-lol', productName: 'Overlay LoL', version: pkg.version, description: pkg.description, author: 'Overlay LoL', main: 'app/main.js', license: pkg.license }, null, 2)
  );

  step(`Empaquetage avec Electron ${electronVersion} (le premier lancement télécharge Electron, environ 120 Mo)`);
  const { packager } = await import('@electron/packager');
  const out = path.join(WORK, 'out');
  const [built] = await packager({
    dir: stage,
    out,
    name: 'Overlay-LoL',
    platform: 'win32',
    arch: 'x64',
    electronVersion,
    icon: icoPath,
    asar: true,
    overwrite: true,
    quiet: true,
    appVersion: pkg.version,
    appCopyright: 'Non affilié à Riot Games',
    win32metadata: {
      ProductName: 'Overlay League of Legends',
      FileDescription: 'Overlay OBS pour League of Legends',
      OriginalFilename: 'Overlay-LoL.exe',
      InternalName: 'Overlay-LoL',
    },
    afterExtract: [
      async ({ buildPath }) => {
        const locales = path.join(buildPath, 'locales');
        for (const f of fs.readdirSync(locales)) if (!KEEP_LOCALES.has(f)) fs.rmSync(path.join(locales, f));
        fs.rmSync(path.join(buildPath, 'LICENSES.chromium.html'), { force: true });
      },
    ],
  });

  step('Copie dans dist/');
  fs.mkdirSync(TARGET, { recursive: true });
  // Le dossier « data » (réglages, logos, presets) n'est jamais touché : on ne remplace que les fichiers du programme.
  for (const entry of fs.readdirSync(TARGET)) {
    if (entry !== 'data') removeWithRetry(path.join(TARGET, entry));
  }
  fs.cpSync(built, TARGET, { recursive: true });
  fs.rmSync(WORK, { recursive: true, force: true });

  const exe = path.join(TARGET, 'Overlay-LoL.exe');
  const total = (function size(dir) {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size;
    return n;
  })(TARGET);
  console.log(`\n✔ ${path.relative(ROOT, exe)} (dossier complet : ${(total / 1024 / 1024).toFixed(0)} Mo)`);
}

main().catch((e) => {
  console.error('\n✘ Échec de la fabrication de l\'application :', e && e.stack ? e.stack : e);
  process.exit(1);
});
