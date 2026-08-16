@echo off
chcp 65001 >nul
title AI深度量化 - 一键启动
echo.
echo   ================================================
echo     AI深度量化 - 独立量化平台  v2.0
echo   ================================================
echo.

cd /d "%~dp0"

REM [1/3] 依赖检查
if not exist node_modules (
  echo   [1/3] 首次运行：正在安装依赖（约 1-3 分钟，需联网）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
) else (
  echo   [1/3] 依赖已就绪
)

REM [2/3] 构建前端
echo   [2/3] 正在构建前端（首次约 30-60 秒）...
call npm run build
if errorlevel 1 (
  echo.
  echo   [错误] 构建失败，请检查上方错误信息。
  pause
  exit /b 1
)

REM [3/3] 启动单端口服务（页面 + API + 自检调度）
echo   [3/3] 正在启动服务：http://localhost:3001
echo.
start "" http://localhost:3001
node server\index.cjs

pause
