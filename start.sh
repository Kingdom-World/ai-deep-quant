#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# AI深度量化 - 启动脚本（Mac/Linux）
#
#   与 Windows 的 `AI深度量化-打开网站.bat` 保持同一设计（2026-09-19 合并）：
#     ① 先探活：服务已在跑 → 直接打开浏览器，不重复拉起（避免端口占用/单实例锁冲突）
#     ② 依赖与构建只在缺失时执行
#     ③ 未跑才启动服务，并轮询等待就绪（最多 30 秒）
#
#   注意：Windows 原 start.bat 已被删除，其"装依赖+构建+启动"能力并入本流程。
# ─────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

PORT=3001
URL="http://127.0.0.1:${PORT}"
LOG="server.log"

echo ""
echo "  ================================================"
echo "    AI深度量化 - 独立量化平台  v2.0"
echo "  ================================================"
echo ""

# ── [1/3] 探活 ──
if curl -fsS --max-time 2 "${URL}/api/health" >/dev/null 2>&1; then
  echo "  [1/3] [OK] 服务已在运行"
else
  echo "  [1/3] 服务未启动，准备拉起"

  # [2/3] 依赖与构建（仅缺失时执行）
  if [ ! -d node_modules ]; then
    echo "  [2/3] 首次运行：正在安装依赖（约 1-3 分钟）..."
    npm install --no-audit --no-fund
  else
    echo "  [2/3] 依赖已就绪"
  fi

  if [ ! -d dist ]; then
    echo "  [2/3] 首次运行：正在构建前端..."
    npm run build
  else
    echo "  [2/3] 前端已构建（如需更新，请执行 npm run build）"
  fi

  # [3/3] 后台启动 + 等待就绪
  echo "  [3/3] 正在启动服务..."
  nohup node server/index.cjs >>"$LOG" 2>&1 &

  READY=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "${URL}/api/health" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 1
  done

  if [ "$READY" != "1" ]; then
    echo ""
    echo "  [提示] 服务启动较慢或启动失败。请查看 ${LOG}，"
    echo "         或手动前台运行： node server/index.cjs"
    echo ""
  fi
fi

echo ""
echo "  [OPEN] 正在打开网站：${URL}"
echo ""
# 按平台选择打开方式；无图形环境时仅打印地址
if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
else
  echo "  （未找到浏览器打开命令，请手动访问上述地址）"
fi
