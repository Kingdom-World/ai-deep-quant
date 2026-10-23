# AI 深度量化平台 v2.0 · 交接文档（CodeBuddy）

> 本文写给**接手的工程/研究同学**，不依赖任何前序对话记忆即可独立工作。
> 写作时间：2026-10-23｜对应提交：`7d1b3a7`
> ⚠️ 本文**可入库**（不含真实域名 / 凭据 / 内网拓扑）；涉及部署与账号的部分只写"见本地私有文件"。

---

## 0. 一分钟读懂

| 项 | 内容 |
|---|---|
| **是什么** | 个人学术研究性质的 A 股量化研究平台（非商业、非荐股），含「模型工坊 + 因子库 + 横截面回测 + 模拟盘 + AI 研究助手」 |
| **技术栈** | Node 22 / Express 5（单端口 `server/index.cjs`）+ React + Vite；无 TypeScript 编译产物依赖（`tsc --noEmit` 仅作类型门） |
| **部署** | Vercel（公网）+ 本地节点（可跑完整归档回测）；**Vercel 无本地归档**，涉及 `data/history` 的能力会自动降级 |
| **规模** | server 29 个 `.cjs` + 6 个路由模块 + 7 个 Agent 模块 + 11 个 paper 模块；shared 13 个；前端 80 个 `.ts/.tsx`；**89 个测试文件 / 1051 条断言** |
| **数据** | 本地归档 **209 只 × 2015-01-05 ~ 2026-09-11**（gitignore，CI 上不存在） |
| **当前进度** | Phase 0 / 1 / 2 / 2.5 / 3 / 4 已收官；**Phase 5 进行中**（逐根回放引擎已完成并修完两处口径缺陷） |
| **下一步候选** | Phase 5 剩余三项（中性化 / 模型广场评论 / 扩池）+ 两个待查项（见 §6） |

**一句话概括当前质量水位**：口径纪律极严（单一源 + 金标准 + 破坏验证），但**历史遗留的口径缺陷仍有**（近期一次排查连续发现 2 个：卖出滑点、期末价源），说明"审计比新功能更值钱"。

---

## 1. 🔴 不可违反的铁律

按「违反后的代价」排序。**这些不是建议，是门禁与测试会直接拦下的东西。**

### 1.1 交付流程（违反 → 线上事故）
1. **本地验证通过再推**：`全量测试` + `tsc --noEmit` + `vite build` 三绿才允许提交。
2. **推送后必须独立验证远端**：查 `api.github.com/.../git/ref/heads/main` 确认真实 sha，**据实** `git update-ref`。
   ⚠️ 历史事故：曾用 `git rev-parse HEAD` 无条件设置远端引用 ⇒ 推送失败时伪造"已同步"假象，且推送脚本因此判定"待推 0 个提交"而**静默不推**，排查了一整夜。
3. **推送成功 ≠ CI 通过**：必须查 `actions/runs/<id>/jobs` 的**step 级**结论。测试红会让 TS/Build 变 `skipped`——**skipped 不是通过**。

### 1.2 口径单一源（违反 → 结论不可比且极难发现）
4. **同一个数值口径只许有一份实现**：
   - 费用：`server/paper/fees.cjs`
   - 涨跌停价：`server/paper/matcher.cjs` 的 `limitPrices`
   - 复权价：`server/crosssect.cjs` 的 `withAdjustedPrices`
   - 绩效指标：`server/quant.cjs` 的 `equityMetrics`
   - 交易日历：`data/calendar.json` → 兜底 `shared/cn-holidays.json`
   - RSI：`shared/rsi.cjs`（Wilder 标准，前后端共用）
   - **改口径必须全仓搜文字表述**（喂 LLM 的上下文 / UI / README / 测试夹具都会分叉）。
5. **`shared/single-source.cjs` 是可执行的门，不是文档**：符号必须存在 + 关键数值不得在白名单外重新定义。
   ⚠️ 只放**高辨识度**数值——误报会让门被习惯性忽略，比没门更糟。

### 1.3 计算与统计（违反 → 得出"看不出错误"的错结论）
6. **LLM 只解读，不计算**：一切确定性算数走规则引擎。禁止让 LLM 做算术、禁止用向量检索替换规则检索链。
7. **缺失值绝不按 0 计**：算不出的标的**从分母剔除**并报告覆盖率。
   ⚠️ 实证：某组合正确暴露 `0.0545`，按 0 计得 `0.0409`（差 25%）——**两者看起来都像正常值**。
8. **降级必须显式**：`degraded` 标注 + `/api/health` 外露 `subsystems.<name>`；禁止静默降级、禁止吞错。
9. **验证门永不读 LLM 输出**（LLM 评 LLM = 没有门）。

### 1.4 工程纪律（违反 → 事故会潜伏很久）
10. **Serverless 禁止 `require('*.mjs')`**：线上禁用 `require(ESM)`，本地 Node 默认开启 ⇒ **本地永不复现**，线上直接整站 500。
    复现方式：`node --no-experimental-require-module`。已上锁 `test/no-require-esm.test.cjs`。
11. **新子系统装载必须隔离**：可选功能 require 失败只能降级该子系统，**不得拖垮整站**（范例：`server/index.cjs` 的 8d/8e 段）。
12. **补了测试要验它会红**（故意破坏实现看对应用例是否失败）——没验过的门等于没加。
    ⚠️ 更高一级：**"破坏验证"本身也要验证**——曾有注入脚本把 `BAD` 替换成 `BAD`，破坏根本没落地却打印"已注入"。
13. **前端接后端先打真实 JSON 再写 TS 类型**：项目曾臆造 6 处字段名，TS 不报错但 UI 全是 `undefined`。
14. **测试假数据的维度必须覆盖要测的差异轴**：曾因假数据 `open === close`，导致"期末强平用开盘价还是收盘价"差 4.39% 的 bug 在测试里**完全隐形**。
15. **测试禁硬编码绝对数量**（如 `term === 15`）——合法扩容必红，逼人删断言。改为"锚点存在性 + 下界不设上界 + 唯一性"。
16. **被中断的命令可能已部分落盘**：续做前先核对文件实际状态（曾因 heredoc 已写入一半导致重复声明）。
17. **任务切小块，每块完成即收尾汇报**：禁止"一口气连做十步"的长链（长链是执行退化的温床）。

---

## 2. 改代码必须走的五步

```bash
# ① 全量测试（必须 1051/1051；新增测试会让数字变大）
node --test --test-concurrency=1 test/*.test.cjs

# ② 类型门（0 错误才算过）
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit

# ③ 构建（改了前端才必须；后端改动建议也跑一次）
node node_modules/vite/bin/vite.js build

# ④ 提交（多行提交信息用 heredoc，不要用 -m 拼长串）
git add <files> && git commit -F- <<'EOF'
feat|fix|test(scope): 一句话结论

## 为什么 / 怎么做 / 证据
EOF

# ⑤ 推送并**独立**验证远端 + 查 CI step 级
bash scripts/git-api-push.sh origin main
# 然后必须：查 api.github.com 的 ref sha 与本地一致，再 update-ref
# 再必须：查 actions/runs/<id>/jobs，看 "Unit tests / tsc / Build" 每步的 conclusion
```

**提交信息规范**：必须写清「为什么这么做 / 有什么证据 / 反面信息」（例如"实测差异 4.39%→0.03%"）。这个仓库的历史提交信息本身是重要的知识载体。

**CI 五步**：`Unit tests` → `Knowledge source integrity` → `Public docs guard` → `TypeScript check` → `Build (vite)`。前一步失败，后续变 `skipped`。

---

## 3. 架构地图

### 3.1 后端（`server/`，29 个顶层模块）

| 分组 | 模块 | 职责 |
|---|---|---|
| **入口** | `index.cjs` | 单端口：API + dist 静态 + 自检。**已 ~2500 行，改动需谨慎** |
| **路由** | `routes/*.cjs`（6 个） | quote / paper / agent / research 等分域路由 |
| **回测引擎** | `crosssect.cjs` | **横截面多标的引擎**（主力）：排名 → T+1 开盘调仓，整手/涨跌停/费用/滑点 |
| | `quant.cjs` | 单标的引擎 + `equityMetrics`（**绩效口径单一源**） |
| | `replay.cjs` | **逐根回放引擎**（Phase 5）：截面引擎的精确对照组，四开关 |
| **因子** | `factorexpr.cjs` | 因子表达式：白名单 AST、`parseExpression` / `evalOnStock` |
| | `factoreval.cjs` | 因子评估：分层、IC、稳定性 |
| | `modelxform.cjs` / `modelrun.cjs` | 模型预处理链 / 模型执行入口（含 `ENGINE_VERSION`） |
| **模拟盘** | `paper/broker.cjs` | 账户与撮合（`accountSnapshot`） |
| | `paper/matcher.cjs` | 撮合与 `limitPrices`（涨跌停单一源） |
| | `paper/fees.cjs` | 分项费率（**费用单一源**） |
| | `paper/exposure.cjs` | 组合因子暴露 + 基准（Phase 4） |
| | `paper/risk.cjs` / `strategies.cjs` / `alerts.cjs` | 风控 / 自动策略 / 提醒 |
| **Agent** | `agents/alpha.cjs` | 编排循环 + `ENABLED_TOOLS` 白名单 |
| | `agents/toolbox.cjs` | 14 个工具（见 §3.3） |
| | `agents/*.cjs` | 13 角色团队、协议、记忆 |
| **知识** | `knowledge.cjs` | 三级降级检索（AND → OR → substring），**纯规则零依赖** |
| **质量** | `statstest.cjs` | Spearman / IC / Newey-West |
| | `archiveindex.cjs` | 归档体检 |

### 3.2 前端（`src/`，80 个文件）

- **唯一 fetch 出口**：`src/api/client.ts`；按域拆模块（`paper.ts` / `quote.ts` / `research.ts`…），统一从 `src/api/index.ts` 出口。
  **组件层禁止裸 fetch**；新域必须建 `<domain>.ts` 并在 `index.ts` re-export。
- 页面：`src/pages/*`（含 700+ 行的 `PaperTradingPage.tsx`、`StockDetailPage.tsx` 两个待拆的巨型文件）。
- 可视化走金融专业路线；中国习惯：**涨红跌绿**、货币 `¥`。

### 3.3 Agent 工具箱（14 个，启用 12 个）

| 工具 | 用途 |
|---|---|
| `get_klines` | 取日线 |
| `run_backtest` | 单标的回测 |
| `run_param_scan` | 参数扫描（含孤峰/平原判定） |
| `eval_factors` | 因子稳健性评估 |
| `factor_ic` | 因子 IC |
| `knowledge_search` | 知识库检索（三级降级） |
| `list_experiments` | 读历史实验记录 |
| `read_report` | 读历史团队分析报告（含降级状态） |
| `get_portfolio` | 读组合（敞口/集中度/回撤） |
| `list_factors` | 因子目录 |
| `check_factor_expr` | 表达式语法校验（**声明不计算**） |
| `get_factor_exposure` | 组合因子暴露 + 基准对比（Phase 4） |
| ~~`get_quote`~~ / ~~`get_news`~~ | 已定义未启用（P3 试点未注入实时依赖） |

**黄金工具调用集**（`test/agent-tool-golden.test.cjs`）守三条可机器判定的前提：
① 注册表一致（`ENABLED_TOOLS` 每项真实存在）；② 描述自洽（desc 承诺的能力真的实现了）；③ 能力可用。
**新增工具必须补黄金用例**，否则覆盖检查会红。

---

## 4. 口径单一源清单（最易踩，逐条都出过事）

| 概念 | 单一源 | 必须遵守 |
|---|---|---|
| 复权价 | `crosssect.withAdjustedPrices(rows, factors)` | 传 `factors` 会用复权因子重算；**不传则 `adjClose = close` + `adjFallback`**。若数据源已是前复权，**绝不能传**（双重复权） |
| 因子值 | `factorexpr.evalOnStock(ast, rows, i)` | 量子是**小数**（0.1439 = 14.39%）、`rev` 自动取负、窗口不足返回 **null** |
| 涨跌停 | `matcher.limitPrices(code, null, prevClose)` | 判定用**不复权真实价**（交易所规则）；成交价用复权价 |
| 费用 | `fees.calcFees(market, side, value).total` | 分项费率，禁止平坦双边 0.1% |
| 绩效指标 | `quant.equityMetrics(equity, capital, bars?)` | 年化 = 几何复利、年限 `max(bars/252, 0.25)`、无风险 2% |
| 滑点方向 | `slippageModel: 'both'`（默认） | **`'buyOnly'` 是历史兼容**（旧实现卖出不计滑点，收益被高估 0.6~1.0pp） |
| 期末强平 | 截面 `finalSlippage:false`（计价惯例）/ 回放可在 `true` | 两引擎必须**同价源（close）**；曾误用 open ⇒ 终值差 4.39% |
| 交易日历 | `data/calendar.json` → `shared/cn-holidays.json` | 兜底不可省 |
| 模型版本 | `modelrun.ENGINE_VERSION` | **口径变更必须升版 + 重冻 `GOLDEN`**；并保留 `GOLDEN_LEGACY` 锚 |
| 指纹 | `modelrun` 的 `fingerprint` | 影响数值的参数**必须进指纹**（如 `slippageModel`），否则"同指纹不同结果" |

---

## 5. 已完成里程碑

| 阶段 | 交付 | 状态 |
|---|---|---|
| **Phase 0** | 契约地基；新闻 4 源断路器化；Provider 网关（腾讯主 + 东财备用） | ✅ |
| **M1** | 横截面因子回测（`crosssect`） | ✅ |
| **M2** | 因子表达式沙箱（白名单 AST、上限在解析期拒绝） | ✅ |
| **M3** | Agent `factor_ic`；因子评估与分层 | ✅ |
| **Phase 1** | 模型工坊 MVP：建模 → 回测 → 存档 → **同指纹重跑结果一致**（`test/phase1-acceptance.test.cjs` 金标准） | ✅ |
| **Phase 2** | 数据治理、验证套件、研究级导出、模型分享 v1、可编辑 DAG | ✅ |
| **Phase 2.5** | Learn 学习平台 + 知识库 2.0（106 条知识，出处 239 条，verified 101、0 缺陷） | ✅ |
| **Phase 3** | QuantGPT 工具层：14 个工具（启用 12）+ 黄金工具调用集 + 三级降级知识检索 | ✅ |
| **Phase 4** | PortfolioPilot：敞口/集中度/回撤、因子暴露 + 基准对比、组合级年化/波动/Sharpe、前端暴露面板 | ✅（6/7，"暴露回归"因样本不足暂缓） |
| **Phase 5（部分）** | 逐根回放引擎 + 四开关对照；**修**:卖出滑点缺失、期末强平误用 open | 🔄 |

---

## 6. 未完成任务与欠账

### 6.1 Phase 5 剩余（按建议优先级）
| 项 | 说明 | 备注 |
|---|---|---|
| **中性化预处理（行业）** | Phase 2 已引入市值中性化，行业分类按需接入 | **依赖外部行业数据**，需先确认数据源 |
| 模型广场评论/讨论 | 社交功能 | 个人研究平台价值低，建议缓做 |
| 扩池再评估 | 800-1000 → 全市场 | 数据成本高 |

### 6.2 🔴 两个待查项（建议优先于新功能）
1. **`rawEquity` 疑似未透传**：`runCrossBacktest({rawEquity:true})` 返回的 `equityFull` 只有 ~566 条（≈2822/5），怀疑没把 `rawEquity` 传给 `simulateWithCrossSection`。
   影响：依赖"完整净值序列"的**因果性检验会拿到抽稀数据**（抽稀网格随截断点错位，产生"看起来缺了点"的假象）。
2. **历史口径缺陷的系统性审计**：近一轮连续发现 2 个（卖出滑点、期末价源）。建议把"成本/价源/时点"三类口径做一次全量交叉核对，而不是等下次撞见。

### 6.3 其他已知遗留
- 巨型文件：`server/index.cjs`（~2500 行）、`StockDetailPage.tsx`。
- 撮合零滑点（模拟盘内部撮合）、退市无处理。
- 归档仅核心池 **209 只 / 2015-01-05 ~ 2026-09-11**（扩容见上）。
- `bhFdr` 尚未接进真实"批量扫因子"。
- 知识库扩容缺口：term 层约 48 条、method 层约 45 条（目标 term 80-120 / method 80-100）。
- L2（Vercel 适配）/ L3（辩论提速）未开工；L3 须保**语义等价**，否则如实报告放弃。
- Phase 4 的"暴露回归（归因）"需模拟盘积累足够交易记录后再做——**样本不足时回归系数无统计意义**。

---

## 7. 环境与工具约束（Windows 本地）

| 约束 | 说明 |
|---|---|
| **Bash PATH 是坏的** | 每条命令开头必须 `export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH";` |
| **PowerShell 不返回 stdout** | 有退出码无输出 ⇒ 别依赖它读结果 |
| **curl 被沙箱拦** | 报 `upstream connect failed`；改用 `node -e "await fetch(...)"` |
| **后台进程会被回收** | `node server/index.cjs &` 启动后端口不监听 ⇒ 需要真服务时用任务托管方式；**多数验证可直调模块避免起服务** |
| **文件锁 EBUSY 常见** | 写文件用「重试 + 自旋」封装，或改用 Bash heredoc |
| **bash 会吃掉反引号** | 含模板字符串的 JS 不要塞进 `node -e "..."`；写成 `.tmp-*.cjs` 脚本再执行 |
| **`reg.exe` 被安全策略拦** | 不可绕过 |
| **沙箱剥离环境变量** | 排查"有没有配凭据"**不能**据此下结论（曾误判） |
| 临时目录 | 诊断用 `.tmp-*` 已 gitignore；用完即删 |

---

## 8. 踩坑档案（都是真事故，建议先读）

1. **Serverless `require(ESM)`** → 整站 500，本地永不复现。已上锁。
2. **推送假象**：`tail -3` 截掉成功行 + 无条件 `update-ref` + 脚本据本地 ref 判断待推数 ⇒ 静默不推，代价一整夜。**铁律 §1.1-2**。
3. **本地绿 CI 红**：`/api/agents/analyze` 用例依赖外网行情 + 8s 超时 ⇒ 环境问题伪装成回归。已改为 404 显式 skip + 20s。
4. **破坏验证造假**：注入脚本替换成自己，报告"已注入" ⇒ 得出"测试很稳"的假象。
5. **反例没有判别力**：断言写成 `exposure ≠ exposure×coverage`，对"归一化"与"按 0 计"两种实现都成立 ⇒ 破坏后仍全绿。改用"两只同值标的，正确值应精确等于单只基准值"。
6. **假数据维度缺失**：`open === close` ⇒ 价源错误测不出（4.39% 的 bug 隐形）。
7. **`coverage.min` 语义错**：只统计"能算出来的因子"，导致完全算不出的因子**不被计入最低值** ⇒ 把最严重的问题藏起来。
8. **口径与注释矛盾**：注释写"卖出 ×(1−滑点)"，代码从未实现 ⇒ 历史收益高估 0.6~1.0pp。
9. **期末价源错**：期末强平复用"开盘价"的卖出函数 vs 截面用 `close` ⇒ 终值差 4.39%，但换手只差 0.0019%（**只断言换手会漏掉**）。
10. **单一源被绕过**：README 里抄一份代码数值 = 口径第二副本，代码改了文档不会跟着变。
11. **知识库造伪证**：凭记忆写 DOI/卷期 = 伪造（已四次）；"检索为空" ≠ "文献不存在"（已两次翻案）。
12. **降级不可观测**：公网部署但忘开鉴权，只出现在不常看的启动日志里 ⇒ `/api/health` 必须外露。

---

## 9. 安全与保密

- **公开仓库**（`dsh-workspace/AI深度量化平台-v2.0`）：拓扑 / 真实域名 / 内网 IP / 鉴权变量名 / 管理员名 / 部署路径 **一律不入库**。
- **推公开 = 已泄露**，唯一根治 = **轮换凭据**（止血 ≠ 根治）。
- gitignore 对**已追踪**文件无效，必须 `git rm --cached`；查漏：
  ```bash
  for f in $(git ls-files); do git check-ignore -q "$f" && echo "⚠️ $f"; done
  ```
- `.gitignore` 里的敏感**文件名**本身公开可见 ⇒ 用 `.git/info/exclude` 承载。
- **文档分级**：对外 `README.public.md`；完整版 `README.md` / `DEPLOY.md` 留本地。守门 `tools/check-public-docs.cjs`（CI 第 3 步）。
- 提交前扫密钥（diff 高危模式 + 长随机串，排除测试夹具）。
- 账号密码等见本地私有文件（**不入库**，不要写进任何 `.md`）。

---

## 10. 关键文件索引

| 想知道什么 | 看哪里 |
|---|---|
| 现行计划 | `plans/master-plan.md`（演进计划书 v3.0，`plans/` 已 gitignore） |
| 口径纪律总纲 | `server/crosssect.cjs` 文件头（价格口径 6 节） |
| 绩效指标定义 | `server/quant.cjs` 的 `equityMetrics` 注释 |
| 因子语义 | `server/factorexpr.cjs` 的 `OPS` |
| 金标准与验收 | `test/phase1-acceptance.test.cjs`（含 `GOLDEN` / `GOLDEN_LEGACY`） |
| Agent 工具契约 | `server/agents/toolbox.cjs` + `test/agent-tool-golden.test.cjs` |
| 知识检索链 | `server/knowledge.cjs`（AND → OR → substring） |
| 公开文档守门 | `tools/check-public-docs.cjs` |
| 单一源守门 | `shared/single-source.cjs` + `test/*single-source*` |
| 健康自检 | `GET /api/health`、`GET /api/__ping?probe=files` |

---

## 11. 接手第一周建议

1. **先跑通验证链**（§2 五步），确认本地 1051/1051 与 CI 五步全绿 —— 这是后续一切判断的基线。
2. **读 §1 铁律 + §4 口径清单**，再看 `crosssect.cjs` 文件头。**不要急着写新功能。**
3. **优先做 §6.2 的两个待查项**：它们影响的是"已有结论的可靠性"，比新功能价值高。
4. 动手改任何口径前，先问三个问题：
   - 这个数值现在有几份实现？
   - 改完历史结果还能复现吗（有没有兼容开关）？
   - 我加的断言，故意破坏实现时会红吗？
5. 提交信息请沿用本仓库风格：**写"为什么"和"证据"，不写"改了哪几行"**。

---

## 附：一句话交接

> 这个平台的代码质量取决于**口径纪律**，而不是功能数量。
> 最近一轮排查在一个"已经跑通、测试全绿"的引擎里连续挖出两个真实缺陷（收益高估 0.6~1.0pp、终值偏差 4.39%）——
> **说明"审计旧代码"的收益，通常高于"再加一个功能"。**
