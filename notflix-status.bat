@echo off
title Notflix - Status
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\status-notflix.ps1"
pause
