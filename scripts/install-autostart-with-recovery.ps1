# Sets Notflix to start automatically, hidden, whenever you log into Windows -
# via a Task Scheduler task rather than a plain Startup-folder shortcut. The
# advantage over the simple method (install-autostart.bat) is resilience: if
# Notflix ever crashes, Task Scheduler notices and restarts it within a
# minute, up to 3 times. The tradeoff is that Task Scheduler is a Windows
# service with its own permissions model, which occasionally refuses task
# creation with "Access is denied" in some environments (locked-down
# corporate machines, certain remote-session setups) for reasons unrelated to
# your own account's rights. If that happens here, use install-autostart.bat
# instead - the plain Startup-folder shortcut needs no special access at all
# and covers the same "starts automatically" goal, just without auto-restart
# on a crash.
#
# Run this once (install-autostart-with-recovery.bat, at the project root,
# does that with a plain double-click). Safe to run again later - re-running
# just replaces the existing task with a fresh copy of these settings.

$ErrorActionPreference = "Stop"
$taskName = "Notflix"
$root = Split-Path -Parent $PSScriptRoot
$vbsPath = Join-Path $root "scripts\run-hidden.vbs"

Write-Host ""
Write-Host "  Setting up Notflix to start automatically..."
Write-Host ""

if (-not (Test-Path $vbsPath)) {
  Write-Host "  Couldn't find $vbsPath - is this script still inside the notflix folder?" -ForegroundColor Red
  exit 1
}

try {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "  Found an existing '$taskName' task - replacing it with a fresh copy."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }

  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`""

  # A short delay after login, so Notflix isn't fighting the rest of your
  # startup programs for disk and CPU in that first noisy minute.
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $trigger.Delay = "PT20S"

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
    # ExecutionTimeLimit Zero = no limit. Task Scheduler kills a task after 3
    # days by default, which would otherwise silently take Notflix down mid-
    # week for no reason anyone watching would understand.

  # -RunLevel Limited (not Highest): Notflix does not need administrator
  # rights to run, and asking for them would mean a UAC prompt - or a silent
  # failure to start - every single time you log in.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description "Starts Notflix (personal streaming server) in the background at login. Installed from $root." `
    | Out-Null

  Write-Host "  Done. Notflix will start automatically next time you log in." -ForegroundColor Green
  Write-Host ""

  $answer = Read-Host "  Start it right now too, instead of waiting for next login? (Y/n)"
  if ($answer -notmatch "^n") {
    Start-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 3
    Write-Host ""
    Write-Host "  Started. Give it a few seconds, then check:"
    Write-Host "    - http://localhost:7777 in a browser on this PC"
    Write-Host "    - data\notflix.log for the address/PIN banner it would normally print"
    Write-Host ""
  }

  Write-Host "  To stop it:            double-click stop-notflix.bat"
  Write-Host "  To remove autostart:   double-click uninstall-autostart.bat"
  Write-Host ""
}
catch {
  Write-Host ""
  Write-Host "  Couldn't set this up: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
  Write-Host "  If this says 'Access is denied', Task Scheduler is refusing task" -ForegroundColor Yellow
  Write-Host "  creation in this environment. Two things to try:" -ForegroundColor Yellow
  Write-Host "    1. Right-click install-autostart-with-recovery.bat and choose" -ForegroundColor Yellow
  Write-Host "       'Run as administrator'." -ForegroundColor Yellow
  Write-Host "    2. If that still fails, use install-autostart.bat instead - it" -ForegroundColor Yellow
  Write-Host "       sets up the same automatic start via a plain Startup-folder" -ForegroundColor Yellow
  Write-Host "       shortcut, which doesn't touch Task Scheduler at all." -ForegroundColor Yellow
  Write-Host ""
  exit 1
}
