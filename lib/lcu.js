'use strict';

/*
 * Accès au client League of Legends (« LCU ») pour lire la sélection des champions.
 *
 * Le client ouvre une petite API HTTPS sur 127.0.0.1, avec un port et un mot de passe
 * aléatoires écrits dans son fichier « lockfile » (et passés à son processus). On les lit
 * puis on interroge l'API, comme le font Porofessor, Blitz et les autres outils. Il n'y a
 * aucune lecture de la mémoire du jeu. Cette API n'est pas documentée officiellement par
 * Riot : elle peut changer d'une mise à jour à l'autre. Le certificat est auto-signé, on ne
 * l'ignore que pour 127.0.0.1.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const DEFAULT_LOCKFILES =
  process.platform === 'win32'
    ? ['C:\\Riot Games\\League of Legends\\lockfile']
    : process.platform === 'darwin'
      ? ['/Applications/League of Legends.app/Contents/LoL/lockfile']
      : [];

/* Contenu du lockfile : « LeagueClient:pid:port:mot-de-passe:https ». */
function parseLockfile(text) {
  const [, , port, password, protocol] = String(text).trim().split(':');
  if (!port || !password) return null;
  return { port: Number(port), password, protocol: protocol || 'https' };
}

/* Ligne de commande du client : « --app-port=… --remoting-auth-token=… ». */
function parseCommandLine(line) {
  const port = /--app-port=(\d+)/.exec(line || '');
  const token = /--remoting-auth-token=([\w-]+)/.exec(line || '');
  return port && token ? { port: Number(port[1]), password: token[1], protocol: 'https' } : null;
}

/* Retrouve le client même s'il n'est pas installé dans le dossier par défaut. */
function readFromProcess() {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? null : parseCommandLine(String(out)));
    if (process.platform === 'win32') {
      const script = "(Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -First 1).CommandLine";
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true }, done);
    } else {
      execFile('ps', ['-A', '-o', 'args'], { timeout: 5000 }, (err, out) => {
        if (err) return done(err);
        done(null, String(out).split('\n').find((l) => l.includes('LeagueClientUx')) || '');
      });
    }
  });
}

class LcuClient {
  constructor({ lockfile } = {}) {
    this.paths = [lockfile, process.env.LOL_LOCKFILE, ...DEFAULT_LOCKFILES].filter(Boolean);
    this.creds = null;
    this.lastDiscovery = 0;
    this.misses = 0;
  }

  /* Identifiants du client, ou null s'il n'est pas lancé. La recherche par processus n'est tentée que toutes les 5 s. */
  async connect() {
    if (this.creds) return this.creds;
    for (const p of this.paths) {
      try {
        const c = parseLockfile(fs.readFileSync(p, 'utf8'));
        if (c) return (this.creds = c);
      } catch (_) {
        /* pas de lockfile à cet endroit */
      }
    }
    // Chercher le processus lance PowerShell : on le fait rarement, et très rarement si l'installation par défaut
    // existe (le client est alors simplement fermé, son lockfile n'existe que pendant qu'il tourne).
    const knownInstall = this.paths.some((p) => {
      try {
        return fs.existsSync(path.dirname(p));
      } catch (_) {
        return false;
      }
    });
    const every = knownInstall ? 60000 : this.misses < 3 ? 5000 : 20000;
    const now = Date.now();
    if (now - this.lastDiscovery < every) return null;
    this.lastDiscovery = now;
    this.creds = await readFromProcess();
    this.misses = this.creds ? 0 : this.misses + 1;
    return this.creds;
  }

  reset() {
    this.creds = null;
  }

  get(path, timeoutMs = 1500) {
    const c = this.creds;
    if (!c) return Promise.reject(new Error('client non trouvé'));
    return new Promise((resolve, reject) => {
      const req = https.get(
        { host: '127.0.0.1', port: c.port, path, auth: `riot:${c.password}`, rejectUnauthorized: false, agent: false, headers: { Accept: 'application/json' } },
        (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('error', reject);
          res.on('end', () => {
            clearTimeout(timer);
            let data = null;
            try {
              data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (_) {
              /* corps vide ou non JSON */
            }
            resolve({ status: res.statusCode, data });
          });
        }
      );
      const timer = setTimeout(() => req.destroy(new Error('délai dépassé')), timeoutMs);
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

module.exports = { LcuClient, parseLockfile, parseCommandLine };
