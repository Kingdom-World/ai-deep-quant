@echo off
chcp 65001 >nul
title AI深度量化 - 打开网站
cd /d "%~dp0"
echo.
echo   ================================================
echo     AI深度量化 - 打开网站
echo   ================================================
echo.

REM 检测网站服务是否已在运行（未启动则自动拉起）
set SVC_STATUS=0
powershell -NoProfile -Command "try { (Invoke-WebRequest 'http://127.0.0.1:3001/api/health' -UseBasicParsing -TimeoutSec 2).StatusCode } catch { 0 }" > "%TEMP%\aiqz_check.txt" 2>nul
if exist "%TEMP%\aiqz_check.txt" set /p SVC_STATUS=<"%TEMP%\aiqz_check.txt"
del "%TEMP%\aiqz_check.txt" >nul 2>nul

if "%SVC_STATUS%"=="200" (
    echo   [OK] 网站服务正在运行，正在打开浏览器...
) else (
    echo   [WAIT] 网站服务未启动，正在为您启动（首次启动约 1 分钟）...
    if not exist node_modules (
        echo   首次运行：安装依赖...
        call npm install --no-audit --no-fund
    )
    if not exist dist (
        echo   首次运行：构建前端...
        call npm run build
    )
    start "AI深度量化服务" /min cmd /c "node server\index.cjs"
    echo   正在等待服务就绪...
    timeout /t 6 /nobreak >nul
)

echo.
echo   [OPEN] 正在打开网站：http://127.0.0.1:3001
echo.
start "" "http://127.0.0.1:3001"
exit
