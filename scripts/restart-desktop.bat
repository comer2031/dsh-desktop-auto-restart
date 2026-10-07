@echo off
rem Safe restart of the DSH desktop app (see scripts\restart-desktop.ps1).
rem Dry run (show the plan, change nothing): restart-desktop.bat -DryRun
rem Single-line if only: cmd.exe parses parenthesised blocks unreliably with LF endings.
set "PS=powershell"
where pwsh >nul 2>nul
if %errorlevel%==0 set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-desktop.ps1" %*
echo.
pause
