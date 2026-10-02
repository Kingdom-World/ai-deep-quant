# API 契约清单 v1（FF0 契约冻结）

> **目的**：后续所有服务端重构（数据源 Provider 网关、index.cjs 拆分、Python 退役清理、Model 工坊接入）均以本清单为**对外兼容基线**。
> **盘点方式**：2026-10-02 从 `server/index.cjs` 与 `server/auth.cjs` 静态盘点（55 + 8 = 63 端点），与前端 `src/api/dataService.ts` 消费点交叉核对。
> **冻结规则**：
> 1. 既有路由的**响应形状 = 契约**：新增字段允许（追加式演进）；改名/删除/类型变更 = 破坏性变更，必须前后端同批修改并回归测试。
> 2. 改任何接口前先抓**真实 JSON** 比对（编码约定 9：先打真实 JSON 再写类型，禁止臆造字段）。
> 3. 本文件随路由变更同步更新；数量对不上即为漂移信号。

---

## 一、鉴权模型（全 API 前置）

- 鉴权 = 会话 Cookie（HttpOnly，7 天）；`AUTH_ENABLED = Boolean(SITE_PASSWORD)`，未配置密码则全放行且无管理员。
- 鉴权中间件在**所有路由之前**：保护全部 `/api/*`，放行 `/api/auth/*` 与 `/api/health`。
- ⚠️ 未登录时**不存在的路径也返回 401** —— 不能用 401/404 判断路由是否存在，测试必须带登录态。
- 管理员端点（仅 `username === SITE_USERNAME`）：`GET/POST /api/auth/invites`、`POST /api/auth/invites/revoke`。
- 前端公共行情路径（`isPublicPath`：/indices、/mood、/quote/、/quotes?、/minute/、/sectors/、/news?）自动 `credentials: 'omit'`。

## 二、路由清单 · `server/index.cjs`（55 条）

### 行情 / K线 / 搜索（8）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/quote/:symbol | 实时报价（腾讯源） |
| GET | /api/period-policy/:symbol | 周期复权策略判定 |
| GET | /api/history/:symbol | 历史 K 线（归档优先，降级快照） |
| GET | /api/mkline/:symbol | 分钟 K 线 |
| GET | /api/minute/:symbol | 当日分时 |
| GET | /api/indices | 大盘指数快照 |
| GET | /api/search/:keyword | 证券搜索 |
| GET | /api/ticks/:symbol | 逐笔/分笔 |

### 回测与因子研究（7）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/backtest | 单标的策略回测（MA/RSI/买入持有） |
| GET | /api/param-scan | 参数扫描 |
| POST | /api/agent/research | Agent 单标的深度研究 |
| GET | /api/experiments | 实验列表（对比用） |
| GET | /api/crossbacktest | 横截面因子回测（M1） |
| GET | /api/factor-layers | 分层回测 layerAnalysis（M2） |
| GET | /api/factor-eval | 因子评估 IC/IR/显著性（M2） |

### AI 助手与问答（4）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/qa | AI 问答（T1 规则 / T2 自带 Key / 云端） |
| POST | /api/ai/feedback | 回答反馈（👍/👎） |
| POST | /api/ai/teach | 教学式纠正（写入知识） |
| GET | /api/ai/stats | AI 使用统计 |

### Agent 团队（7）
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /api/agents/analyze | 发起多角色协作分析（限流 2/min） |
| GET | /api/agents/job/:id | 任务状态轮询 |
| GET | /api/agents/report/:id | 报告详情 |
| GET | /api/agents/reports | 报告列表 |
| DELETE | /api/agents/reports/:id | 删除报告 |
| GET | /api/agents/capabilities | 能力档位声明（不计费） |
| GET | /api/agents/daily-review | 每日复盘 |

### 板块 / 新闻 / 舆情（5）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/sectors/flow | 板块资金流（东财，Vercel 降级） |
| GET | /api/sectors/cards | 板块卡片 |
| GET | /api/feed/:symbol | 个股要闻（新浪滚动） |
| GET | /api/news | 资讯中心（三源，全败显式 502→200 降级） |
| GET | /api/news/health | 新闻源健康探针 |

### 模拟盘 paper（15）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/paper/account | 账户总览（门禁：无 DB 时 503 显式拒绝） |
| POST | /api/paper/order | 下单（persisted 语义：响应前落库） |
| POST | /api/paper/order/:id/cancel | 撤单 |
| POST | /api/paper/reset | 重置账户（同步删 DB 镜像） |
| POST | /api/paper/unlock | 解锁（熔断后） |
| GET | /api/paper/reconcile | 账实对账 |
| GET | /api/paper/consistency | 一致性报告 |
| GET | /api/paper/strategies | 自动策略列表 |
| POST | /api/paper/strategies | 新建自动策略 |
| POST | /api/paper/strategies/:id/stop | 停止策略 |
| GET | /api/paper/logs | 交易日志 |
| GET | /api/paper/alerts | 预警列表 |
| POST | /api/paper/alerts | 新建预警 |
| DELETE | /api/paper/alerts/:id | 删除预警 |
| POST | /api/paper/alerts/clear-triggered | 清除已触发标记 |

### 知识库 / 选股 / 自选与情绪 / 系统（8）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/knowledge/search | 知识检索（Agent 工具同源） |
| GET | /api/knowledge/entries | 知识条目列表 |
| GET | /api/screener/strategies | 选股策略定义 |
| GET | /api/screener | 全市场选股快照 |
| GET | /api/mood | 市场温度计 |
| GET | /api/watchlist | 自选股列表 |
| POST | /api/watchlist | 添加自选 |
| DELETE | /api/watchlist/:symbol | 移除自选 |

**系统**：`GET /api/health`（免鉴权自检：版本/内存/归档状态）。

## 三、路由清单 · `server/auth.cjs` 挂载于 `/api/auth`（8 条，免鉴权段）

| 方法 | 路径 | 用途 | 守卫 |
|---|---|---|---|
| POST | /api/auth/register | 邀请码注册（`invites.claim()` 单条原子占码） | loginGate 限流 |
| POST | /api/auth/login | 登录 | loginGate 限流 |
| POST | /api/auth/logout | 登出 | — |
| GET | /api/auth/me | 会话身份回显（username/isAdmin） | 需登录 |
| GET | /api/auth/invites | 邀请码全量列表（四态标签） | 🔴 仅管理员 |
| POST | /api/auth/invites | 生成邀请码 | 🔴 仅管理员 |
| POST | /api/auth/invites/revoke | 吊销邀请码 | 🔴 仅管理员 |
| POST | /api/auth/change-password | 修改密码 | 自行校验登录态 |

## 四、响应约定（跨路由通用）

1. **降级必须显式**：上游不可用/快照替代等场景，响应体带 `degraded` / `degradedBy` 标注，禁止静默降级。
2. **写路径 persisted 语义**（paper）：落库失败返回 `{ok:false, persisted:false}` + 60s 重试，**不抛 500**（Vercel 响应后冻结，响应前必须写完）。
3. **能力边界即状态码**：403/503 属「能力边界声明」而非故障，响应体为结构化指引（前端按此渲染提示）。
4. **限流**：API 全局每 IP 120 次/分钟（`API_RATE_LIMIT`）；Agent 分析 2 次/分钟（`AI_AGENT_LIMIT`）。
5. **标的归一化**：以 `server/symbolnorm.cjs` 为唯一源；`index.cjs` 的 `toTencentCode` 不许动。

## 五、与后续阶段的衔接

- **Provider 网关（Phase 0 下一项）**：两步走——先在 `index.cjs` 数据源调用点外加间接层（路由签名零变化），再逐源切流；本清单即切流回归的核对底稿。
- **index.cjs 拆分**：按上方分组切模块（行情/回测/Agent/paper/…），路由路径与响应形状不变。
- **Model 工坊（Phase 1）**：新增 `/api/models*` 路由走追加式演进，不触碰既有 63 端点。
