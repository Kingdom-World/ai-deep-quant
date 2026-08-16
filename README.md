# 📊 AI深度量化 — 独立量化分析平台 v2.0

> 📚 **项目性质声明：本项目为个人学术研究项目，不构成投资建议，不涉及实盘交易。**
> 平台数据来自新浪/腾讯公开财经接口，所有分析、评分与回测结果仅用于学习研究演示，
> 请勿据此进行任何投资操作。

完全独立的量化分析 Web 平台：**单端口运行、无需任何 API Key、无需外部 AI 服务**。
数据直连新浪/腾讯公开财经接口，所有计算（技术指标、AI 评分、策略回测、AI 问答）本地完成。

## ✨ 功能一览

| 模块 | 说明 |
| --- | --- |
| 🏠 主页 | 6 大指数市场概况（10 秒自动刷新）、我的收藏（localStorage）、AI 今日推荐（五因子评分） |
| 📈 量化看板 | K线（日/3日/周/月/季/年）+ MA5/10/20/60/120/250 + 成交量 + MACD + 形态标注（突破/破位/双底/头肩顶）+ 实时走势 |
| ⚡ 短期副图 | 1/5/15/30/60/120 分钟真实 K 线（A股=腾讯 mkline，美股=新浪，港股=分时聚合），MA5/10/20 + 最新价标线 + 缩放 |
| 🤖 AI 潜力分析 | 五因子模型（趋势30/动量25/量能15/波动15/位置15）0-100 评分 + 雷达图 |
| 📈 策略回测 | MA 双均线 / RSI 超买超卖 / 买入持有，收益曲线、年化、最大回撤、胜率、交易明细（0.1% 手续费） |
| 💬 AI 智能助手 | 站内问答：个股解读（真实行情指标）、股票池推荐、使用指南（离线规则引擎，无需联网 AI） |
| 🔧 每日自检 | 每天 02:00–03:00 自动自检：代码语法扫描 + 前端产物检查 + 8 项接口冒烟测试，报告写入 `reports/` |

## 🚀 快速开始（Windows）

**这是一个网站，不是安装包**——启动后浏览器直接访问网址即可，无需任何解压/安装步骤。

| 方式 | 操作 |
| --- | --- |
| Python 版（推荐本地/服务器） | 双击 **`start_py.bat`**（默认生产模式：构建 + Baostock/Ashare 双源后端 + 单端口 5000）；`start_py.bat dev` 为热更新开发模式 |
| 双击图标（Node 版） | **`AI深度量化-打开网站.bat`** / **`AI深度量化-打开网站.url`**（服务 http://127.0.0.1:3001） |
| 手机/平板 | 同一 WiFi 下，浏览器输入 `http://本机IP:端口` |
| 开机自启（可选） | 双击 **`注册开机自启.bat`** |

> 一个命令、一个端口、一个网址。页面与全部 API 都由后端提供，
> 不依赖任何第三方服务、不依赖 MCP、不需要 API Key。

---

## 🐍 Python 版后端（Baostock 主源 + Ashare 辅助源）

```
python_backend/
├── app.py               # Flask 应用（--serve-dist 生产托管 / 默认 API 模式）
├── baostock_source.py   # Baostock 历史K线主源（日/周/月/分钟，会话复用）
├── ashare_compat.py     # Ashare 兼容层（实时行情辅助源，新浪/腾讯公开接口）
├── database.py          # SQLite 持久化缓存（历史 24h / 报价 8s / 指数 15s）
├── rate_limit.py        # 单用户限流（每分钟 10 次，超限 429）
├── scheduler.py         # 每日 16:00 定时刷新热门股票缓存（python -m scheduler --once 手动触发）
├── services.py          # 聚合服务（历史/报价/指数/搜索/分钟K线/回测/推荐/AI问答）
└── requirements.txt     # flask / flask-cors / baostock / pandas / requests
```

- **数据源架构**：历史K线/技术指标 → Baostock（主源）；实时行情/指数 → Ashare（辅助源）。前端只接收聚合数据，不感知数据来源，也不暴露原始行情接口。
- **合规特性**：SQLite 24h 缓存（再次访问不调数据源）、单用户 10 次/分钟限流（429 + Retry-After）、每日 16:00 自动更新、健康检查 `/api/health`、缓存状态 `/api/cache/status`。
- **前端路由**：环境变量 `VITE_BACKEND=python` 时自动使用服务端聚合接口（推荐 `/api/recommend`、批量报价 `/api/quotes`），其余接口路径与 Node 版完全一致。
- 部署到香港/自有服务器：`pip install -r python_backend/requirements.txt && python python_backend/app.py --serve-dist`。

### Mac / Linux

```bash
chmod +x start.sh && ./start.sh
```

### 手动方式（开发者）

```bash
npm install          # 安装依赖
npm run build        # 构建前端 → dist/
npm start            # 启动单端口服务 http://localhost:3001
# 或开发模式（热更新，前端 5173 + 代理后端 3001）:
# 终端1: node server/index.cjs
# 终端2: npm run dev
```

## 🔧 每日自检（02:00–03:00 维护窗口）

两种方式自动生效，**即使平台关闭也会自检**：

1. **服务内置调度**：`npm start` 启动后，每天 02:00–03:00 自动执行一次自检。
2. **Windows 计划任务**：双击 `register-maintenance.bat`（建议管理员运行）注册
   每天 02:05 的独立自检任务，平台不开机也会按时运行。

手动执行一次自检：

```bash
npm run maintain        # 或 node server/index.cjs --maintain-once
```

自检报告：`reports/maintenance-latest.json`（JSON）、`reports/maintenance.log`（历史摘要）。

## 🔌 REST API（同端口 3001）

| 接口 | 说明 |
| --- | --- |
| `GET /api/quote/:symbol` | 实时报价（如 `sh600519` / `AAPL` / `00700`） |
| `GET /api/history/:symbol?frequency=1d\|1w\|1M&count=500` | 历史日/周/月 K 线 |
| `GET /api/mkline/:symbol?period=m1\|m5\|m15\|m30\|m60&count=320` | 真实多日分钟 K 线 |
| `GET /api/minute/:symbol` | 当日分时 |
| `GET /api/indices` | 6 大指数（上证/沪深300/深证/标普/纳指/道指） |
| `GET /api/search/:keyword` | 股票搜索（中文名/代码） |
| `GET /api/backtest?symbol=AAPL&strategy=ma&fast=5&slow=20&capital=100000` | 策略回测 |
| `GET /api/qa?q=分析AAPL` | 网站 AI 问答 |
| `GET /api/health` | 健康检查 |

## 🧱 技术栈

- **前端**：Vite 8 + React 19 + TypeScript + ECharts 6 + React Router 7 + Zustand
- **后端**：Node.js + Express 5（`server/index.cjs`），iconv-lite 处理 GBK 编码
- **数据源**：新浪/腾讯公开财经接口（双源自动切换），内存缓存（报价 5s / 历史 5min）
- **零外部依赖**：无 MCP、无 Python、无 AKShare、无付费 API、无 AI 云服务

## 📦 目录结构

```
ai-deep-quant/
├── server/index.cjs         # 一体化服务：API + dist 静态托管 + 自检调度
├── src/                     # 前端源码
│   ├── api/dataService.ts   # 统一数据服务层（缓存+去重）
│   ├── lib/stock.ts         # 量化计算（纯函数，无 SDK 依赖）
│   ├── pages/               # 主页/看板/潜力分析/回测/AI助手
│   └── components/          # 数据源指示器等
├── dist/                    # 构建产物（npm run build 生成）
├── reports/                 # 自检报告（自动生成）
├── start.bat / start.sh     # 一键启动
└── register-maintenance.bat # 每日自检计划任务注册
```

## ⚠️ 免责声明

本平台为**学生学术研究演示项目**，数据来源于公开财经网站（新浪/腾讯），
**不构成任何投资建议**，亦不涉及荐股、预测及实盘交易。所有分析与回测仅供学习研究。

---

## 🌐 部署到公网（Vercel）

想让朋友通过浏览器直接访问（无需任何本地环境）？项目已适配 Vercel Serverless 部署：

- 部署入口：`api/index.js`（复用 `server/index.cjs` 后端）
- 配置：`vercel.json` + `"vercel-build"` 脚本 + Node 20 engines
- 完整图文步骤（GitHub 推送 + Vercel 导入 + 验证清单 + 常见问题）：**见 [`DEPLOY.md`](DEPLOY.md)**

预期 URL 格式：`https://ai-deep-quant.vercel.app`（免费版 100GB 流量/月，足够少量朋友使用）
