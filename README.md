# Overlay Twitch pour League of Legends

Un overlay de diffusion pour OBS, sur le même principe que JotaOverlay pour Rocket League :

- un petit programme local lit les données de la partie en cours ;
- un serveur les redistribue ;
- une page « overlay » s'ajoute dans OBS comme **source navigateur** ;
- un **panneau de contrôle**, dans sa propre fenêtre, règle les noms d'équipes, les logos, le score de la série et ce qui s'affiche.

La source de données est l'API officielle et locale du jeu, la *Live Client Data API* (`https://127.0.0.1:2999`). Elle répond dès qu'une partie est chargée, que vous jouiez ou que vous regardiez en spectateur. Il n'y a **aucune lecture de la mémoire du jeu** (donc aucun souci avec Vanguard) et **aucune clé API Riot** à demander.

> Ce projet n'est ni approuvé ni affilié à Riot Games. League of Legends est une marque de Riot Games, Inc. Les icônes de champions et d'objets viennent de Data Dragon, le service public de Riot pour les développeurs.

## Ce qui s'affiche

- **Barre de score** en haut au centre. Plaque centrale : kills de chaque équipe, chrono et jauge de valeur des objets. De chaque côté : logo, tag, nom et pastilles de série (BO3, BO5 ou BO7 : une pastille par victoire nécessaire), puis un bandeau avec les tours, inhibiteurs, dragons (losanges colorés selon l'élément, mention « Âme » à 4), hérauts, barons et valeur des objets.
- **Fil d'actions** à gauche : kills (tueur → victime, assistances) et tours détruites.
- **Bandeaux d'objectifs** sous la barre : dragons (volés ou non), Nashor, Héraut, Atakhan, inhibiteurs, premier sang, triple, quadra et pentakill, ace.
- **Tableau des joueurs** en bas au centre : deux colonnes de 5 lignes alignées par poste, avec champion, niveau, nom, K/D/A, objets et CS, et le temps de réapparition des joueurs morts. Affiché par défaut en mode spectateur.
- **Sponsors** en rotation en haut à gauche.
- **Écran de fin** plein écran : équipe gagnante, score de la série, MVP, tableau des 10 joueurs et comparatif des objectifs.

### Design

L'overlay et le panneau suivent la charte graphique Genesis : couleurs `#D9D9D9`, `#000103`, `#151724`, `#9E42ED` et `#4802DE`, dégradés `#4802DE → #9E42ED` et `#9E42ED → #151724`, polices **Bruno Ace SC** (titres, chiffres) et **Chakra Petch** (textes), formes anguleuses inspirées des ailes du logo. Seuls le bleu et le rouge des deux côtés de la partie, l'or et les couleurs des dragons s'ajoutent à la palette, parce que le spectateur en a besoin pour lire la partie. Pour le logo, envoyez le fichier du logo Genesis comme logo d'équipe dans l'onglet Principal du panneau : il apparaît partout (barre, écran de fin).

## Installation

Trois façons de lancer le programme, au choix. Dans tous les cas, le panneau de contrôle est le même.

Le dossier `dist/` (l'application et le serveur en .exe) n'est pas dans le dépôt : il se fabrique en deux commandes, voir « Fabriquer les programmes soi-même » plus bas. Pour essayer tout de suite, utilisez « Avec Node.js ».

### L'application (rien à installer pour l'utiliser)

Une fois fabriquée, ouvrez le dossier **`dist/Overlay-LoL/`** et double-cliquez sur **`Overlay-LoL.exe`**. Une fenêtre s'ouvre avec le panneau de contrôle : barre d'état en haut (connexion, partie en cours, adresse de l'overlay), puis les onglets **Principal**, **Affichage**, **Équipes** et **OBS**. Le serveur de l'overlay tourne dans cette fenêtre : **la fermer arrête l'overlay dans OBS** (le programme demande confirmation).

- Le dossier est autonome (Electron et toutes les pages sont dedans, environ 300 Mo). Copiez-le où vous voulez : Bureau, autre disque, clé USB.
- Vos réglages et vos logos sont gardés dans un dossier `data/` **à côté du .exe**, avec un journal (`data/overlay.log`). Si le dossier de l'application n'est pas modifiable, par exemple dans `Program Files`, ils vont dans `%APPDATA%\Overlay LoL\data`.
- Une seule fenêtre à la fois : relancer le .exe ramène la fenêtre déjà ouverte au premier plan.
- Options (lancez-le depuis un terminal) : `Overlay-LoL.exe --demo` pour la partie simulée (voir « Mode démo »). `PORT` et `HOST` se règlent comme pour `node server.js`.
- Le programme n'est pas signé numériquement : Windows peut afficher « Windows a protégé votre ordinateur ». Cliquez sur **Informations complémentaires**, puis **Exécuter quand même**.

### Le serveur seul, en .exe

`dist/Overlay-LoL-serveur.exe` est le serveur sans fenêtre de panneau : une console s'ouvre, et le panneau s'ouvre dans votre navigateur (`http://localhost:3000/control`). Fermez la console pour arrêter le programme. Les réglages sont dans un dossier `data/` à côté du fichier. Option `--no-open` pour ne pas ouvrir le navigateur.

### Avec Node.js

1. Installez [Node.js](https://nodejs.org) (version 18 ou plus récente, la version LTS convient).
2. Clonez le dépôt, ou téléchargez-le en .zip et décompressez-le où vous voulez.
3. Double-cliquez sur **`start.bat`**. Le panneau de contrôle s'ouvre dans votre navigateur (`http://localhost:3000/control`).

Il n'y a rien d'autre à installer : le serveur n'utilise aucune dépendance (pas de `npm install`).

### Tester sans lancer le jeu

Double-cliquez sur **`start-demo.bat`**, ou lancez `Overlay-LoL.exe --demo` : une partie simulée tourne en boucle (voir « Mode démo »).

### Fabriquer les programmes soi-même

À faire sous Windows, avec Node.js 20 ou plus récent (testé avec Node.js 24), depuis le dossier du projet :

```bat
npm install
npm run build:app
npm run build:exe
```

- `npm run build:app` recrée l'application `dist/Overlay-LoL/` (Electron, environ 300 Mo). Le premier lancement télécharge Electron (environ 120 Mo). Les réglages d'un dossier `data/` déjà présent dans `dist/Overlay-LoL/` sont conservés.
- `npm run build:exe` recrée `dist/Overlay-LoL-serveur.exe` (environ 88 Mo).
- `npm run app` lance l'application directement depuis les sources, sans l'empaqueter.

Les outils de fabrication (`electron`, `@electron/packager`, `esbuild`, `postject`, `rcedit`) ne servent qu'à cette étape, jamais au fonctionnement du serveur. Les scripts travaillent dans un dossier temporaire au chemin court, car les outils natifs échouent au-delà de 260 caractères.

### Données locales

Les réglages, les logos envoyés, les presets et le journal sont dans un dossier `data/`, jamais dans le code : `git` l'ignore (comme `dist/`, `node_modules/` et les journaux), donc rien de personnel ne part sur GitHub.

## Ajouter l'overlay dans OBS

1. Dans OBS, dans la scène de jeu : **Sources → + → Navigateur**.
2. **URL** : `http://localhost:3000/overlay`
3. **Largeur** : `1920`, **Hauteur** : `1080`.
4. Validez. Le fond est transparent : l'overlay se superpose à la capture du jeu.

Gardez la source par-dessus la capture de League of Legends. Si vous diffusez en 1280×720, laissez la source en 1920×1080 : OBS la réduit avec le reste de la scène.

Le panneau de contrôle affiche ces adresses avec un bouton « Copier ».

### Picks et bans

Les picks et les bans passent par [drafter.lol](https://drafter.lol/), pas par cet overlay. Ajoutez le lien d'overlay fourni par drafter.lol comme **source navigateur séparée**, par exemple sur votre scène de sélection des champions. La Live Client Data API n'existe pas avant le début de la partie : les deux overlays ne se gênent donc pas.

## Utilisation

### En joueur

1. Lancez `Overlay-LoL.exe` (ou `start.bat`), puis une partie.
2. Dès que la partie est chargée, le statut du panneau passe à « En partie » et l'overlay apparaît.
3. À la fin de la partie, le vainqueur est connu : l'écran de fin s'affiche tout seul et la victoire s'ajoute à la série (si la case « Compter les victoires automatiquement » est cochée).

Laissez le mode **Joueur** : le bas de l'écran reste libre pour la barre des sorts.

### En spectateur

1. Passez le panneau de contrôle en mode **Spectateur** : le panneau des joueurs s'affiche en bas.
2. En spectateur, l'API ne donne **pas** le vainqueur. À la fin de la partie, cliquez sur **« Victoire bleue »** ou **« Victoire rouge »** : cela fixe le vainqueur, met la série à jour et affiche l'écran de fin.

**Spectateur sur un autre PC que celui du stream** : lancez le serveur sur le PC spectateur en l'ouvrant au réseau local.

```bat
set HOST=0.0.0.0
Overlay-LoL.exe
```

(ou `node server.js` à la place de `Overlay-LoL.exe`.) Dans OBS, utilisez ensuite l'adresse de ce PC : `http://ADRESSE-IP-DU-PC-SPECTATEUR:3000/overlay`. Windows peut demander d'autoriser le programme dans le pare-feu : acceptez pour les réseaux privés.

Avec `HOST=0.0.0.0`, le panneau de contrôle est accessible à tout le réseau local, sans mot de passe. Par défaut, le serveur n'écoute que sur `127.0.0.1`.

### Entre deux games d'une série

- **« Échanger les côtés »** échange les équipes bleue et rouge avec leurs scores, quand les équipes changent de côté pour la game suivante.
- Les boutons **+** et **−** corrigent le score à la main, et **« Remettre à 0 »** le remet à zéro.
- Les **presets d'équipes** enregistrent un nom, un tag et un logo (bouton 💾 de chaque carte d'équipe) pour les recharger en un clic avec la liste « Équipe enregistrée », côté bleu ou rouge.

### Panneau de contrôle

- **Barre d'état** : connexion au serveur, état de la partie (en attente, chargement, en partie avec le chrono, terminée), adresse de l'overlay (un clic la copie) et **« Tout réinitialiser »** (équipes, série, affichage et sponsors reviennent aux réglages d'origine ; les presets sont conservés).
- **Principal** : équipes, série et écran de fin.
- **Affichage** : mode joueur ou spectateur, éléments affichés, échelle, sponsors.
- **Équipes** : liste des presets.
- **OBS** : adresses à copier et aperçu en direct de l'overlay tel qu'OBS le verra.

Chaque changement est enregistré tout de suite, il n'y a pas de bouton « Enregistrer ». Les réglages sont conservés dans `data/config.json`, les logos envoyés dans `data/uploads/`.

## Mode démo

```bat
node server.js --demo
node server.js --demo --speed=12 --start=900 --spectator
```

- `--speed=12` : vitesse de la partie simulée (12 fois le temps réel).
- `--start=900` : démarre à 900 secondes de jeu (15:00).
- `--spectator` : simule une partie vue en spectateur (pas de vainqueur automatique).

La partie simulée se termine, reste en ligne quelques secondes, puis une nouvelle partie démarre.

## Limites

- **L'or affiché est la valeur des objets**, pas l'or réel : l'API ne donne pas l'or des adversaires. La jauge est libellée « Valeur objets » pour cette raison.
- Pas de points de vie, pas de positions, pas de données de la carte : l'API locale ne les fournit pas.
- **Pas de vainqueur automatique en spectateur** : utilisez les boutons « Victoire bleue » et « Victoire rouge ».
- Les kills, objectifs et tours sont lus dans la liste d'événements de la partie : si vous lancez le serveur en cours de partie, l'historique n'est pas rejoué à l'écran, seuls les nouveaux événements s'affichent.
- Les icônes viennent de Data Dragon : sans connexion Internet, l'overlay affiche des pastilles avec les initiales à la place.

## Dépannage

**Le panneau reste sur « En attente d'une partie »**
L'API du jeu ne répond qu'une fois la partie chargée (pas dans le client, ni pendant la sélection des champions). Pour vérifier, ouvrez `https://127.0.0.1:2999/liveclientdata/allgamedata` dans un navigateur pendant une partie : une page d'avertissement de certificat apparaît (le certificat du jeu est auto-signé), acceptez-la, et vous devez voir du JSON. Si rien ne répond, le port 2999 est bloqué : vérifiez le pare-feu et les logiciels de sécurité. Si le jeu tourne sur un autre PC, lancez le serveur sur ce PC (voir « En spectateur »).

**Le statut reste sur « Chargement »**
L'API répond mais la partie n'a pas encore de joueurs : patientez, cela passe tout seul au début de la partie.

**« Le port 3000 est déjà utilisé »**
Une autre copie du programme tourne déjà, ou un autre programme utilise ce port. Fermez-la, ou changez de port : `set PORT=3001` puis `Overlay-LoL.exe` ou `node server.js` (pensez à changer l'adresse dans OBS).

**L'overlay est vide dans OBS**
Vérifiez l'adresse (`/overlay`, sans `?preview=1`), la taille 1920×1080, et que le serveur tourne. L'overlay n'affiche rien tant qu'aucune partie n'est en cours : testez avec `start-demo.bat`. Dans les propriétés de la source, le bouton d'actualisation du cache du navigateur recharge la page.

**Un logo ne s'affiche pas**
Formats acceptés : png, jpg, webp, gif, 5 Mo maximum. Si l'image ne charge pas, l'overlay affiche le tag de l'équipe à la place.

**L'application ne démarre pas ou se ferme tout de suite**
Regardez `data/overlay.log` (à côté de `Overlay-LoL.exe`) : le programme y écrit tout ce qu'il fait et les erreurs qu'il rencontre.

**Remettre les réglages à zéro**
Dans le panneau, cliquez sur « Tout réinitialiser ». Pour tout effacer, y compris les presets et les logos, arrêtez le programme et supprimez le dossier `data/`.

## Fichiers

```
server.js              serveur (HTTP, Server-Sent Events, API du panneau)
lib/game.js            transforme la réponse de l'API en état d'overlay
lib/demo.js            simulateur de partie pour le mode démo
public/overlay/        l'overlay pour OBS
public/control/        le panneau de contrôle
public/shared/         polices de la charte (Bruno Ace SC et Chakra Petch, licence OFL)
app/main.js            fenêtre de bureau (Electron) : lance le serveur et affiche le panneau
build/build-app.js     fabrication de l'application (npm run build:app)
build/build-exe.js     fabrication du serveur seul en .exe (npm run build:exe)
build/icon.js          icône de l'application, dessinée en code
dist/Overlay-LoL/      l'application autonome (créée par la fabrication)
dist/Overlay-LoL-serveur.exe   le serveur seul en .exe (créé par la fabrication)
data/                  configuration et logos (créé au premier lancement ; à côté du .exe pour les versions .exe)
```

Pour les développeurs : `GET /api/state` renvoie l'état complet, `GET /events` le diffuse en Server-Sent Events. Les routes qui modifient quelque chose n'acceptent que du JSON envoyé par une page servie par le serveur lui-même.

## Crédits

- **Icônes des objectifs** (tour, inhibiteur, dragon, héraut, Nashor, or, épées croisées) : [game-icons.net](https://game-icons.net), licence [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Icons made by **Lorc** (`white-tower`, `crystal-growth`, `dragon-head`, `beast-eye`, `horned-skull`, `crossed-swords`) and **Delapouite** (`two-coins`). Les tracés sont repris tels quels et seulement recolorés par la feuille de style.
- **Polices** : Bruno Ace SC et Chakra Petch (SIL Open Font License 1.1).
- **Icônes de champions et d'objets**, et illustrations des champions : Data Dragon, le service public de Riot Games pour les développeurs.

## Licence

Le code est publié sous licence [MIT](LICENSE). Les polices Bruno Ace SC et Chakra Petch sont sous licence SIL Open Font License 1.1 (voir `public/shared/fonts/LICENSE-*.txt`), et les icônes de game-icons.net sous licence CC BY 3.0 (voir « Crédits »). Les noms, logos et marques cités (League of Legends, Riot Games, Genesis, OBS…) appartiennent à leurs propriétaires respectifs.
