# Sets Notflix to start automatically, hidden, whenever you log into Windows -
# the classic, simplest way: a shortcut in your Startup folder, the same
# mechanism countless ordinary apps use for "start with Windows". No
# administrator rights, no Windows service, nothing to fail in an unusual way.
#
# Run this once (install-autostart.bat, at the project root, does that with a
# plain double-click). Safe to run again later - it just replaces the
# shortcut with a fresh copy pointing at this same folder.
#
# Prefer resilience over simplicity - want Notflix to come back on its own if
# it ever crashes? See install-autostart-with-recovery.bat instead, which
# does the same thing through Task Scheduler, with automatic restart-on-crash
# built in. This script is the one to reach for first; that one is the
# optional upgrade.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$vbsPath = Join-Path $root "scripts\run-hidden.vbs"
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "Notflix.lnk"

Write-Host ""
Write-Host "  Setting up Notflix to start automatically..."
Write-Host ""

if (-not (Test-Path $vbsPath)) {
  Write-Host "  Couldn't find $vbsPath - is this script still inside the notflix folder?" -ForegroundColor Red
  exit 1
}

try {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  # wscript.exe running the .vbs, not the .vbs directly - a shortcut whose
  # target is a .vbs file sometimes launches under cscript instead (which
  # would print to a console window), depending on how Windows has file
  # associations configured. Naming wscript.exe explicitly is the reliable way.
  $shortcut.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $shortcut.Arguments = "`"$vbsPath`""
  $shortcut.WorkingDirectory = $root
  $shortcut.Description = "Starts Notflix in the background at login"
  $shortcut.Save()

  Write-Host "  Done. Notflix will start automatically next time you log in." -ForegroundColor Green
  Write-Host ""

  $answer = Read-Host "  Start it right now too, instead of waiting for next login? (Y/n)"
  if ($answer -notmatch "^n") {
    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbsPath`""
    Start-Sleep -Seconds 3
    Write-Host ""
    Write-Host "  Started. Give it a few seconds, then check:"
    Write-Host "    - http://localhost:7777 in a browser on this PC"
    Write-Host "    - data\notflix.log for the address/PIN banner it would normally print"
    Write-Host ""
  }

  Write-Host "  To check it's running:  double-click notflix-status.bat"
  Write-Host "  To stop it:             double-click stop-notflix.bat"
  Write-Host "  To remove autostart:    double-click uninstall-autostart.bat"
  Write-Host ""
}
catch {
  Write-Host ""
  Write-Host "  Couldn't set this up: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
  exit 1
}
