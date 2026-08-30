@echo off
title Notflix - Stop
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\stop-notflix.ps1"
pause
