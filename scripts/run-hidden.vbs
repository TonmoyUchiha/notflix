' Launches run-notflix.ps1 completely hidden - no console window, not even a
' flash of one at login. This is what the "Notflix" Scheduled Task actually
' runs; it exists only because Task Scheduler running powershell.exe directly
' can still flash a console window briefly on some versions of Windows even
' with -WindowStyle Hidden. WScript.Shell.Run's own hidden mode (0 below)
' does not have that problem - it is the standard, reliable fix for it.
'
' Waits for the PowerShell script to finish (True, below) rather than firing
' it and exiting - see the comment in run-notflix.ps1 for why that matters:
' it is what lets Task Scheduler notice a crash and restart Notflix.

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = scriptDir & "\run-notflix.ps1"

Set shell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & psScript & """"

exitCode = shell.Run(cmd, 0, True)
WScript.Quit(exitCode)
