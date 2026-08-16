#!/usr/bin/env bash
# AI深度量化 - 一键启动脚本 (Mac/Linux)
set -e
cd "$(dirname "$0")"

echo ""
echo "  ================================================"
echo "    AI深度量化 - 独立量化平台  v2.0"
echo "  ================================================"
echo ""

# [1/3] 依赖检查
if [ ! -d node_modules ]; then
  echo "  [1/3] 首次运行：正在安装依赖..."
  npm install --no-audit --no-fund
else
  echo "  [1/3] 依赖已就绪"
fi

# [2/3] 构建前端
echo "  [2/3] 正在构建前端..."
npm run build

# [3/3] 启动单端口服务
echo "  [3/3] 正在启动服务：http://localhost:3001"
echo ""
node server/index.cjs
