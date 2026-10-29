@echo off
rem Daily Baostock sync (calendar + kline archive + PIT finance snapshot).
rem Scheduled by schtasks "AIQuant-BaostockSync" daily 06:00. Log appended to logs\baostock-sync.log
setlocal
set ROOT=%~dp0..
cd /d "%ROOT%"
if not exist logs mkdir logs
echo ===== %date% %time% ===== >> logs\baostock-sync.log
rem -u：禁用缓冲。否则重定向到文件时 Python 会攒够 4KB 才落盘，
rem     长跑期间日志看起来像"什么都没发生"，误导排障（2026-10-29 实际踩过）。
python -u scripts\sync_baostock.py %* >> logs\baostock-sync.log 2>&1
if errorlevel 1 (
  echo [sync] FAILED with code %errorlevel% >> logs\baostock-sync.log
  exit /b 1
)
rem keep log under ~2MB
powershell -NoProfile -Command "$f='logs\baostock-sync.log'; if ((Get-Item $f -ErrorAction SilentlyContinue).Length -gt 2MB) { Get-Content $f -Tail 2000 | Set-Content $f }"
endlocal
