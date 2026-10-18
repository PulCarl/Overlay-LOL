'use strict';

/*
 * Pont entre les pages (choix du jeu, panneau de contrôle) et l'application de bureau.
 * Il n'expose que trois actions ; main.js vérifie de quelle page chaque demande vient.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApp', {
  listGames: () => ipcRenderer.invoke('games:list'),
  chooseGame: (id) => ipcRenderer.invoke('games:choose', String(id)),
  backToGames: () => ipcRenderer.invoke('games:back'),
});
