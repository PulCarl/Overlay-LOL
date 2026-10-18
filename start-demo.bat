@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Overlay League of Legends - démo

where node >nul 2>nul
if errorlevel 1 goto nonode

if "%PORT%"=="" set PORT=3000

rem Ouvre le panneau de contrôle quelques secondes après le démarrage du serveur.
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%/control"

rem Démo complète : sélection des champions, partie, écran de fin, puis on recommence.
rem Options possibles : --speed=12  --start=900  --spectator
node server.js --demo --full %*
echo.
echo  Le serveur s'est arrêté.
pause
exit /b 0

:nonode
echo.
echo  Node.js n'est pas installé sur cet ordinateur.
echo  Téléchargez la version LTS sur https://nodejs.org puis relancez ce fichier.
echo.
pause
exit /b 1
