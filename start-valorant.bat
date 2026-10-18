@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Overlay VALORANT

where node >nul 2>nul
if errorlevel 1 goto nonode

if "%VALORANT_PORT%"=="" set VALORANT_PORT=3001

rem Ouvre le panneau de contrôle quelques secondes après le démarrage du serveur.
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%VALORANT_PORT%/control"

rem Option possible : --demo (match d'exemple, rien n'est enregistré).
node valorant-server.js %*
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
