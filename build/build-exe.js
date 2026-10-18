'use strict';

/*
 * Fabrique dist/Overlay-LoL-serveur.exe : le serveur seul, en un exécutable Windows autonome
 * (Node.js inclus), avec une fenêtre de console et le panneau ouvert dans le navigateur.
 * Pour l'application avec sa propre fenêtre, voir build-app.js. Lancer avec « npm run build:exe ».
 *
 *  1. esbuild regroupe server.js et lib/ dans un seul fichier ;
 *  2. Node.js prépare un « blob » avec ce fichier et les pages de public/ (SEA) ;
 *  3. le blob est injecté dans une copie de node.exe (postject), avec icône et nom (rcedit).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeIcon } = require('./icon');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const EXE = path.join(DIST, 'Overlay-LoL-serveur.exe');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (msg) => console.log(`\n▸ ${msg}`);

function walk(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

async function main() {
  if (process.platform !== 'win32') console.warn('Attention : ce script fabrique un .exe, à lancer sous Windows.');
  fs.mkdirSync(DIST, { recursive: true });

  // Tout se fabrique dans un dossier temporaire au chemin court : les outils natifs (SEA, rcedit)
  // échouent sur les chemins de plus de 260 caractères, fréquents dans les dossiers profonds.
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lolov-'));
  const exe = path.join(WORK, 'Overlay-LoL-serveur.exe');

  step('Regroupement du code (esbuild)');
  const bundle = path.join(WORK, 'server.cjs');
  require('esbuild').buildSync({
    entryPoints: [path.join(ROOT, 'server.js')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['node:sea'],
    legalComments: 'none',
    logLevel: 'warning',
  });

  step('Préparation du paquet (pages embarquées)');
  const assets = {};
  const stagedPublic = path.join(WORK, 'public');
  fs.cpSync(path.join(ROOT, 'public'), stagedPublic, { recursive: true });
  for (const file of walk(stagedPublic)) {
    assets[path.relative(WORK, file).split(path.sep).join('/')] = file;
  }
  console.log(`  ${Object.keys(assets).length} fichiers de public/`);
  const blob = path.join(WORK, 'sea-prep.blob');
  const config = path.join(WORK, 'sea-config.json');
  fs.writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, assets }, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

  step('Copie de Node.js et personnalisation');
  fs.copyFileSync(process.execPath, exe);
  const icoPath = path.join(WORK, 'icon.ico');
  fs.writeFileSync(icoPath, makeIcon().ico);
  const pkg = require(path.join(ROOT, 'package.json'));
  const { rcedit } = require('rcedit');
  await rcedit(exe, {
    icon: icoPath,
    'file-version': pkg.version,
    'product-version': pkg.version,
    'version-string': {
      ProductName: 'Overlay League of Legends (serveur)',
      FileDescription: 'Serveur de l\'overlay OBS pour League of Legends',
      OriginalFilename: 'Overlay-LoL-serveur.exe',
      InternalName: 'Overlay-LoL-serveur',
      LegalCopyright: 'Non affilié à Riot Games',
    },
  });

  step('Injection du programme dans l\'exécutable (postject)');
  await require('postject').inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: SENTINEL });

  fs.copyFileSync(exe, EXE);
  fs.rmSync(WORK, { recursive: true, force: true });
  const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
  console.log(`\n✔ ${path.relative(ROOT, EXE)} (${mb} Mo)`);
}

main().catch((e) => {
  console.error('\n✘ Échec de la fabrication de l\'exécutable :', e && e.stack ? e.stack : e);
  process.exit(1);
});
