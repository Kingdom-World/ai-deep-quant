# 🌐 AI深度量化 · Vercel 公网部署指南

> 目标：把「AI深度量化」部署到 Vercel，获得一个公网永久 URL（如 `https://ai-deep-quant.vercel.app`），
> 任何人点击链接即可在浏览器使用，无需安装任何软件。
>
> **成本**：Vercel 免费版（Hobby 计划）100GB 流量/月，少量朋友日常使用完全免费。

---

## ✅ 部署状态（2026-08-16 已完成）

| 项目 | 状态 |
| --- | --- |
| GitHub 仓库 | ✅ 已创建并推送：`https://github.com/Kingdom-World/ai-deep-quant` |
| Vercel 项目 | ✅ 已部署，状态 READY，域名已绑定 |
| **公网地址** | **🔗 https://ai-deep-quant.vercel.app** |

> ⚠️ **国内网络访问提示**：`*.vercel.app` 域名在国内部分网络环境存在 DNS 污染，
> 直接访问可能超时（部署本身正常，海外网络/可访问外网的网络下完全可用）。
> 解决办法见下方「国内访问优化」。

---

## 🏗️ 部署架构（已适配完成）

```
浏览器 → https://xxx.vercel.app
          ├── 静态页面（dist/，Vite 构建产物，已含 gzip 预压缩）
          └── /api/* → Serverless Function（api/index.js → server/index.cjs）
                        └── 新浪/腾讯公开行情接口（无需 API Key）
```

本次已完成的适配工作：

| 文件 | 说明 |
| --- | --- |
| `api/index.js` | Vercel Serverless 入口（ESM 包装，复用 `server/index.cjs`，避免代码重复） |
| `server/index.cjs` | 增加 Vercel 模式：不监听端口（`require.main === module` 判断）、收紧超时 5s、禁用本地自检调度、分钟线按北京时间 |
| `vercel.json` | `maxDuration: 30`（防免费版 10s 掐断）+ SPA 路由回退 |
| `package.json` | 新增 `"vercel-build": "npm run build"`、`"engines": { "node": "20.x" }` |
| `.gitignore` | 排除 `node_modules/ dist/ .env reports/ .vercel/ *.log` |
| 前端 | API 已使用同源相对路径 `/api`（无需改任何代码，无需环境变量） |

---

## 📋 步骤 A：推送代码到 GitHub

### A1. 创建 GitHub 仓库（网站操作，约 1 分钟）

1. 打开 https://github.com/new
2. **Repository name** 填：`ai-deep-quant`
3. 选 **Private**（私有）或 **Public** 均可（Vercel 都能部署；私有更稳妥）
4. 不要勾选 "Add a README" / ".gitignore" / "License"（避免冲突）
5. 点击 **Create repository**

### A2. 本地推送（在项目目录执行）

打开 PowerShell 或 Git Bash，进入项目目录：

```powershell
cd D:\AI工具\dsh-workspace\my-react-app
```

```powershell
# 关联远程仓库（把 YOUR_NAME 换成你的 GitHub 用户名）
git remote add origin https://github.com/YOUR_NAME/ai-deep-quant.git

# 推送（首次需输入 GitHub 用户名 + Token/密码）
git branch -M main
git push -u origin main
```

> 本地仓库已由 AI 初始化并提交（`968997f Initial commit: AI深度量化平台`，44 个文件）。
>
> 💡 **GitHub 推送密码说明**：2021 年起 GitHub 不再接受账号密码推送，
> 需要 Personal Access Token：GitHub 头像 → Settings → Developer settings →
> Personal access tokens → Generate new token（勾选 `repo` 权限）→ 复制 token 作为密码粘贴。

---

## 📋 步骤 B：部署到 Vercel（约 3 分钟）

1. 打开 https://vercel.com ，用 **GitHub 账号** 登录（Sign Up → Continue with GitHub）
   - 首次登录需授权 Vercel 访问你的 GitHub（Import Third-Party Git Repository）
2. 点击 **Add New… → Project**
3. 在列表中找到 **ai-deep-quant** 仓库，点击 **Import**
4. 构建设置（保持默认即可，Vercel 自动识别 Vite）：
   - Framework Preset：`Vite`
   - Build Command：`npm run build`（或 `vercel-build`，已配置）
   - Output Directory：`dist`
   - **Environment Variables：无需添加**（前端 API 使用同源 `/api`，行情数据源无需 Key）
5. 点击 **Deploy**，等待约 1-2 分钟
6. 部署完成自动生成公网地址：**`https://ai-deep-quant-xxxx.vercel.app`**
   - 可在 Project → Settings → Domains 中改名为 `https://ai-deep-quant.vercel.app`
   - 也可以绑定自己的域名

---

## 🚀 备选方案：不经过 GitHub，直接用 Vercel CLI 部署

如果不想用 GitHub，本机安装 Node.js 后可直接上传部署（同样免费）：

```powershell
cd D:\AI工具\dsh-workspace\my-react-app
npx vercel login          # 浏览器登录 Vercel 账号
npx vercel --prod         # 上传本地文件并生产部署，完成后输出公网 URL
```

后续更新代码后重新执行 `npx vercel --prod` 即可。

---

## ✅ 部署后验证清单

| # | 验证项 | 预期结果 |
|---|--------|----------|
| 1 | 访问公网 URL | 主页正常加载，标题显示「AI深度量化」 |
| 2 | 大盘指数 | 6 个指数（上证/沪深300/深证/标普/纳指/道指）价格与涨跌幅正常 |
| 3 | 今日推荐 | 卡片显示股票名称、价格、AI 评分 |
| 4 | 点击股票卡片 | 跳转至对应详情页（URL 形如 /stock/MSFT） |
| 5 | 详情页 | 价格、涨跌幅、K线图正常渲染 |
| 6 | 切换周期 | 日/3日/周/月/季/年主图 + 1~120 分钟副图正常更新 |
| 7 | 搜索 | 输入代码（AAPL/600519）或中文名（茅台）跳转正确 |
| 8 | 收藏 | 添加/删除收藏正常（保存在浏览器本地） |
| 9 | 数据自动更新 | 价格每 10 秒自动刷新 |
| 10 | 手机浏览器 | 自适应布局正常显示 |

---

## 🔧 常见问题（FAQ）

### Q1: 部署后指数或行情显示「暂无数据」/加载失败
Vercel 函数运行在海外节点，访问腾讯/新浪接口偶有波动。已实现：
- **双数据源自动切换**（新浪 ↔ 腾讯）；
- 行情接口 5 秒超时保护（防免费版 10 秒上限掐断）。
请稍等 10 秒自动重试，或刷新页面。若持续失败，多为腾讯/新浪对海外 IP 的临时风控，可稍后再试。

### Q2: 国内访问 vercel.app 慢或打不开
`*.vercel.app` 域名在国内部分网络环境存在 **DNS 污染**（解析到伪造 IP，TCP 连接超时）。
部署本身不受影响，海外网络与可访问外网的网络下访问正常。国内访问优化方案：

1. **绑定自定义域名（推荐）**：Vercel 支持绑定自有域名（`.com`/`.top`/`.xyz` 等，阿里云/腾讯云约 10-100 元/年）。
   绑定后 Vercel 会给出 `cname.vercel-dns.com` 目标，该域名在国内未被污染，可正常访问。
   Vercel → Project → Settings → Domains → Add，然后到域名服务商加一条 CNAME 记录即可。
2. **使用可访问外网的网络**：朋友通过海外网络/代理访问 `https://ai-deep-quant.vercel.app`。
3. **本地/局域网版**：使用「AI深度量化平台-v2.0」文件夹（见 README），适合同网络环境使用。

### Q3: 修改代码后如何更新线上版本？
推送到 GitHub 的 `main` 分支后，Vercel 自动重新构建部署（约 1 分钟），无需手动操作。

### Q4: 免费额度够用吗？
Hobby 计划：**100GB 流量/月 + 10 万次函数调用/天**，几个朋友日常看行情绰绰有余。

### Q5: 环境变量需要配置吗？
不需要。前端 API 已用同源相对路径 `/api`，行情数据源无需任何 API Key。
如需自定义（例如改轮询间隔），Vercel Project → Settings → Environment Variables
添加 `VITE_POLL_INTERVAL=10000` 等（以 `VITE_` 开头才会注入前端）。

### Q6: 部署后 /stock/xxx 等子路径直接刷新 404？
已处理：`vercel.json` 配置了 SPA 回退，任意非 /api 路径都会返回 index.html。

---

## 🗂️ 部署相关文件清单

```
my-react-app/
├── api/index.js          # Vercel Serverless Function 入口（ESM 包装）
├── server/index.cjs      # 后端（本地/Serverless 双模式）
├── vercel.json           # Vercel 配置（函数时长 + SPA 回退）
├── package.json          # vercel-build 脚本 + Node 20 engines
├── .gitignore            # 排除 node_modules/dist/.env 等
└── dist/                 # 构建产物（部署时云端自动生成）
```
