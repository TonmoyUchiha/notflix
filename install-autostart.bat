@echo off
title Notflix - Set up autostart
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-startup-shortcut.ps1"
pause
