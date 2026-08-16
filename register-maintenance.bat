@echo off
chcp 65001 >nul
title AI深度量化 - 注册每日自检计划任务
echo.
echo   ================================================
echo     AI深度量化 - 每日自检计划任务注册
echo   ================================================
echo.
echo   注册后，Windows 将每天 02:05 自动执行一次平台自检：
echo     - 服务端代码语法扫描（node --check）
echo     - 前端产物完整性检查
echo     - 8 项接口冒烟测试（行情/指数/回测/AI问答等）
echo     - 报告写入 reports\maintenance-*.json + maintenance.log
echo   即使平台关闭（服务未启动），自检也会按时运行。
echo.

for /f "delims=" %%i in ('where node') do set NODE_EXE=%%i
if "%NODE_EXE%"=="" (
  echo   [错误] 未找到 node，请先安装 Node.js 并重启命令行。
  pause
  exit /b 1
)

schtasks /create /f /tn "AIDeepQuant-Maintenance" /sc daily /st 02:05 ^
  /tr "\"%NODE_EXE%\" \"%~dp0server\index.cjs\" --maintain-once"

if errorlevel 1 (
  echo.
  echo   [错误] 注册失败。可以右键「以管理员身份运行」本脚本后重试。
) else (
  echo.
  echo   [完成] 每日 02:05 自检任务已注册。可用命令查看:
  echo     schtasks /query /tn AIDeepQuant-Maintenance
  echo   立即手动执行一次自检:
  echo     npm run maintain
)
echo.
pause
