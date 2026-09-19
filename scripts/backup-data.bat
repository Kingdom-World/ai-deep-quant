@echo off
rem Daily backup of data/ state directory (paper ledger, auth, AI knowledge, news snapshot).
rem Scheduled by schtasks "AIQuant-DataBackup" daily 03:30. Keeps the latest 14 copies.
rem Path note: use %~dp0 so this file works regardless of non-ASCII characters in the project path.
setlocal
set ROOT=%~dp0..
cd /d "%ROOT%"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i
set DEST=backups\data-%TODAY%
if exist "%DEST%" powershell -NoProfile -Command "Remove-Item -LiteralPath '%DEST%' -Recurse -Force -ErrorAction SilentlyContinue"
robocopy data "%DEST%" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
  echo [backup] robocopy failed with code %errorlevel%
  exit /b 1
)
rem Cleanup: drop backups older than 14 days (forfiles nested /c quoting is unreliable in .bat)
powershell -NoProfile -Command "Get-ChildItem backups -Directory | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"
echo [backup] OK: %DEST%
endlocal
