# Removes whichever "start Notflix at login" mechanism is set up - the plain
# Startup-folder shortcut (install-autostart.bat), the Task Scheduler task
# (install-autostart-with-recovery.bat), or both if you tried each at
# different times. Notflix itself, your library, and all your data are
# untouched - this only undoes the autostart setup.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$taskName = "Notflix"
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "Notflix.lnk"

Write-Host ""
$foundAnything = $false

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  $foundAnything = $true
  $info = $task | Get-ScheduledTaskInfo
  if ($info.LastTaskResult -eq 267009) {
    # 267009 = SCHED_S_TASK_RUNNING - stop it first so removing the task
    # doesn't leave an orphaned Notflix quietly running with nothing managing it.
    Write-Host "  Stopping the currently running instance..."
    Stop-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 1
  }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "  Removed the Task Scheduler autostart entry."
}

if (Test-Path $shortcutPath) {
  $foundAnything = $true
  Remove-Item -Path $shortcutPath -Force
  Write-Host "  Removed the Startup-folder shortcut."
}

if (-not $foundAnything) {
  Write-Host "  No autostart is set up - nothing to remove."
  Write-Host ""
  exit 0
}

# A shortcut-based start has no supervisor to stop, so if that's what was
# running, stop it directly rather than leaving it running unmanaged.
$pidFile = Join-Path $root "data\notflix.pid"
if (Test-Path $pidFile) {
  $procId = Get-Content $pidFile -Raw
  $proc = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq "node") {
    Write-Host "  Stopping the currently running instance..."
    Stop-Process -Id $proc.Id -Force
  }
  Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  Autostart removed. Use start.bat to run Notflix from now on." -ForegroundColor Green
Write-Host ""
