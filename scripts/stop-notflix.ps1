# Stops Notflix, however it was started automatically.
#
# If it's running under the Task Scheduler method (install-autostart-with-
# recovery.bat), this goes through Stop-ScheduledTask rather than killing the
# process directly. That distinction matters: Task Scheduler tracks a manual
# stop separately from a crash, so stopping this way does NOT trigger the
# "restart if it fails" recovery that installer set up - killing the process
# by hand would, bringing Notflix right back a minute later, which is exactly
# what you don't want when you meant to stop it.
#
# If it's running under the plain Startup-folder shortcut method instead
# (install-autostart.bat), there's no Task Scheduler entry to stop - it's
# just stopped directly via its process id.

$ErrorActionPreference = "Stop"
$taskName = "Notflix"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "data\notflix.pid"

Write-Host ""

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  $info = $task | Get-ScheduledTaskInfo
  if ($info.LastTaskResult -eq 267009) {
    # 267009 = SCHED_S_TASK_RUNNING
    Stop-ScheduledTask -TaskName $taskName
    Write-Host "  Notflix stopped."
  } else {
    Write-Host "  Notflix's startup task isn't currently running."
  }
  Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
  Write-Host ""
  exit 0
}

if (Test-Path $pidFile) {
  $procId = Get-Content $pidFile -Raw
  $proc = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq "node") {
    Stop-Process -Id $proc.Id -Force
    Write-Host "  Notflix stopped."
  } else {
    Write-Host "  Notflix doesn't appear to be running."
  }
  Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
} else {
  Write-Host "  Notflix doesn't appear to be running."
  Write-Host "  (If you started it via start.bat instead, just close that window.)"
}

Write-Host ""
