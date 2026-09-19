@echo off
chcp 65001 >nul
REM 启用延迟展开：下面的等待轮询在 for 循环内读取变量，需 !VAR! 语法
setlocal enabledelayedexpansion
title AI深度量化 - 打开网站
cd /d "%~dp0"
echo.
echo   ================================================
echo     AI深度量化 - 打开网站
echo   ================================================
echo.

REM ─────────────────────────────────────────────────────────────
REM  唯一的启动入口（2026-09-19 合并）。
REM  原有两个脚本：
REM    · 本脚本（打开网站）：先探活，已在跑就直接开浏览器，未跑才拉起；
REM    · start.bat（一键启动）：装依赖+构建+启动，但看门狗无条件重启。
REM  合并原因：start.bat 在「服务已在运行」时会撞端口 3001 + 模拟盘单实例锁，
REM  进程随即退出；而它的 :runloop 不区分"正常退出"与"启动失败"，每 5 秒
REM  无条件重启 —— 表现为"启动不了服务"且窗口无法关闭的死循环。
REM  本脚本的探活前置天然避免了这个问题，故保留它、并入首次安装/构建能力。
REM ─────────────────────────────────────────────────────────────

REM [1/3] 探活：服务是否已在运行
set SVC_STATUS=0
powershell -NoProfile -Command "try { (Invoke-WebRequest 'http://127.0.0.1:3001/api/health' -UseBasicParsing -TimeoutSec 2).StatusCode } catch { 0 }" > "%TEMP%\aiqz_check.txt" 2>nul
if exist "%TEMP%\aiqz_check.txt" set /p SVC_STATUS=<"%TEMP%\aiqz_check.txt"
del "%TEMP%\aiqz_check.txt" >nul 2>nul

if "%SVC_STATUS%"=="200" (
    echo   [1/3] [OK] 服务已在运行
    goto :open
)

echo   [1/3] 服务未启动，准备拉起

REM [2/3] 依赖与构建（仅缺失时执行，避免每次打开都等构建）
if not exist node_modules (
    echo   [2/3] 首次运行：安装依赖（约 1-3 分钟，需联网）...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
) else (
    echo   [2/3] 依赖已就绪
)

if not exist dist (
    echo   [2/3] 首次运行：构建前端（约 30-60 秒）...
    call npm run build
    if errorlevel 1 (
        echo.
        echo   [错误] 构建失败，请检查上方错误信息。
        pause
        exit /b 1
    )
) else (
    echo   [2/3] 前端已构建（如需更新，请在项目根目录执行 npm run build）
)

REM [3/3] 后台拉起服务（独立窗口，最小化）
echo   [3/3] 正在启动服务...
start "AI深度量化服务" /min cmd /c "node server\index.cjs"

REM 轮询等待就绪（最多 30 秒），避免固定 sleep 过短导致开太早
echo   正在等待服务就绪...
set READY=0
for /l %%i in (1,1,30) do (
    if "!READY!"=="0" (
        powershell -NoProfile -Command "try { (Invoke-WebRequest 'http://127.0.0.1:3001/api/health' -UseBasicParsing -TimeoutSec 2).StatusCode } catch { 0 }" > "%TEMP%\aiqz_wait.txt" 2>nul
        set W=0
        if exist "%TEMP%\aiqz_wait.txt" set /p W=<"%TEMP%\aiqz_wait.txt"
        if "!W!"=="200" (
            set READY=1
        ) else (
            timeout /t 1 /nobreak >nul
        )
    )
)
del "%TEMP%\aiqz_wait.txt" >nul 2>nul

if "%READY%"=="0" (
    echo.
    echo   [提示] 服务启动较慢或启动失败。若浏览器打不开，请查看
    echo          项目目录下的 server.log，或手动运行： node server\index.cjs
    echo.
)

:open
echo.
echo   [OPEN] 正在打开网站：http://127.0.0.1:3001
echo.
start "" "http://127.0.0.1:3001"
exit
