@echo off
title Notflix - Set up autostart (with crash auto-restart)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-autostart-with-recovery.ps1"
pause
