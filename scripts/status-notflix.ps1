# Answers "is it actually running?" - the question a silent background
# process can't answer for itself the way a visible console window could.

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$taskName = "Notflix"
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "Notflix.lnk"

Write-Host ""

$task = Get-ScheduledTask -TaskName $taskName
$hasShortcut = Test-Path $shortcutPath

if (-not $task -and -not $hasShortcut) {
  Write-Host "  Autostart is not set up." -ForegroundColor Yellow
  Write-Host "  (Run install-autostart.bat to set it up, or start.bat to run it manually.)"
} elseif ($task) {
  $info = $task | Get-ScheduledTaskInfo
  if ($info.LastTaskResult -eq 267009) {
    Write-Host "  Notflix is running (started automatically at login, via Task Scheduler)." -ForegroundColor Green
  } else {
    Write-Host "  Autostart (Task Scheduler) is set up, but Notflix isn't running right now." -ForegroundColor Yellow
    Write-Host "  It starts at your next login, or run: powershell -File scripts\run-notflix.ps1"
  }
  Write-Host "  Last start attempt: $($info.LastRunTime)"
} else {
  # Startup-folder shortcut method - no service to ask, so the pid file is
  # the only source of truth for whether it's currently running.
  Write-Host "  Autostart (Startup-folder shortcut) is set up."
}

$pidFile = Join-Path $root "data\notflix.pid"
if (Test-Path $pidFile) {
  $procId = Get-Content $pidFile -Raw
  $proc = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq "node") {
    Write-Host "  Process id: $procId"
  }
} elseif ($hasShortcut -and -not $task) {
  Write-Host "  Not currently running. It starts at your next login," -ForegroundColor Yellow
  Write-Host "  or run: powershell -File scripts\run-notflix.ps1"
}

Write-Host ""
Write-Host "  Check it's actually reachable at: http://localhost:7777"
Write-Host ""

$log = Join-Path $root "data\notflix.log"
if (Test-Path $log) {
  Write-Host "  --- last lines of data\notflix.log ---"
  Get-Content $log -Tail 12
  Write-Host ""
}
