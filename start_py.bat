@echo off
chcp 65001 >nul
title AI深度量化 - Python版一键启动
echo.
echo   ================================================
echo     AI深度量化 - Python版 (Baostock + Ashare)
echo     历史K线: Baostock 主源 | 实时行情: Ashare 辅助源
echo     SQLite 24h缓存 | 单用户限流 10次/分钟 | 每日16:00自动更新
echo   ================================================
echo.

cd /d "%~dp0"

REM [1/3] Python 依赖检查与安装
echo   [1/3] 检查 Python 依赖...
pip show flask baostock >nul 2>nul
if errorlevel 1 (
    echo     首次运行：安装 Python 依赖...
    pip install -r python_backend\requirements.txt -q
)
python -c "import flask, baostock, requests, pandas" 2>nul
if errorlevel 1 (
    echo   [错误] Python 依赖安装失败，请检查 Python 环境。
    pause
    exit /b 1
)
echo       Python 依赖就绪

REM [2/3] 模式选择：dev = 前端热更新(5173)；prod = 构建后单端口(5000)
set MODE=%1
if "%MODE%"=="" set MODE=prod

if "%MODE%"=="dev" (
    echo   [2/3] 开发模式：Python后端(5000) + Vite前端(5173, 热更新)
    start "AI深度量化-Python后端" /min cmd /c "cd /d %~dp0python_backend && python app.py"
    echo   [3/3] 启动前端 http://127.0.0.1:5173
    set VITE_API_TARGET=http://127.0.0.1:5000
    set VITE_BACKEND=python
    npm run dev -- --host
) else (
    echo   [2/3] 生产模式：构建前端 + 单端口托管 (http://127.0.0.1:5000)
    set VITE_BACKEND=python
    call npm run build
    if errorlevel 1 (
        echo   [错误] 前端构建失败。
        pause
        exit /b 1
    )
    echo   [3/3] 启动服务 http://127.0.0.1:5000
    start "" "http://127.0.0.1:5000"
    cd /d %~dp0python_backend
    python app.py --serve-dist
)

pause
