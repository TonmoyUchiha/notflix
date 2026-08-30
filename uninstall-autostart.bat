@echo off
title Notflix - Remove autostart
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\uninstall-autostart.ps1"
pause
