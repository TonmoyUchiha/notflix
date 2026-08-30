# Starts Notflix as a background process with no console window, and waits
# for it - which is what lets the Scheduled Task notice if it ever crashes
# and bring it back up automatically.
#
# This is the "engine" - what the Scheduled Task registered by
# install-autostart.ps1 actually runs. Not meant to be run directly; use
# start.bat for a normal foreground start where you can watch the console.
#
# There is no window here to read output from, so everything server.js would
# normally print goes to data\notflix.log instead (errors separately, to
# data\notflix-error.log, since Start-Process can't merge both into one file).
# The launched node.exe's own process id is written to data\notflix.pid so
# it's easy to check whether Notflix is actually running - stopping goes
# through Task Scheduler instead (see stop-notflix.ps1), not this file.
#
# Why this script WAITS on node rather than launching and exiting: Task
# Scheduler can only tell a task "failed" - and trigger the restart-on-crash
# recovery configured by install-autostart.ps1 - if the process it is
# tracking is still the one that failed. If this script fired node off and
# exited immediately, Task Scheduler would see success within a second and
# have no idea node crashed three hours later. Waiting keeps this script (and
# therefore the task) "running" for as long as Notflix is, so a crash here
# really does mean the task failed, and gets noticed.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$dataDir = Join-Path $root "data"
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

$log = Join-Path $dataDir "notflix.log"
$errLog = Join-Path $dataDir "notflix-error.log"
$pidFile = Join-Path $dataDir "notflix.pid"

"`n==== Starting $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====" |
  Out-File -FilePath $log -Append -Encoding utf8

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  "Could not find node.exe on PATH. Is Node.js installed?" |
    Out-File -FilePath $errLog -Append -Encoding utf8
  exit 1
}

# -PassThru gives back node.exe's own process object directly - nothing else
# sits between this script and node, so the PID it reports is the real one,
# not a wrapping shell's.
$proc = Start-Process -FilePath $nodeCmd.Source -ArgumentList "server.js" `
  -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError $errLog `
  -PassThru

$proc.Id | Out-File -FilePath $pidFile -Encoding ascii -NoNewline

try {
  $proc.WaitForExit()
} finally {
  # The pid file having a stale number in it while nothing is running would
  # be misleading to anyone checking it, so clear it the moment node stops -
  # whether that was a crash, or a deliberate stop via Task Scheduler.
  Remove-Item -Path $pidFile -ErrorAction SilentlyContinue
}

exit $proc.ExitCode
