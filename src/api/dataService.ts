// ─────────────────────────────────────────────────────────────
// 统一数据服务层（直连服务端 API）
//   前端 → /api/*（vite proxy 或同源）→ server/index.cjs（Express）
//   → 新浪/腾讯公开财经接口（无需 API Key，双源自动切换）
//   前端缓存: 分级 TTL（报价10s / 指数15s / 历史5min），命中输出 [Cache] 日志；
//   请求去重：相同 in-flight 请求合并
// ─────────────────────────────────────────────────────────────
// ============ Client 层（已抽出至 src/api/client.ts，此处 re-export 保持调用方零改动） ============
import { ApiError, apiGet, apiGetPublic, apiGetTimed, apiPost, apiDelete, getSourceHealth } from './client';
import { clearCache as clearMemoryCache } from '../utils/cache';
export { ApiError, apiGet, apiGetPublic };

// ============ 已抽出域（client/types/quote/history/recommend）：import 供本文件复用 + re-export 保兼容 ============
import { getQuote, getQuotesBatch, getIndices, searchSymbol } from './quote';
import { getHistoryWithMeta, getHistory, getPeriodPolicy, getMinuteKline, getMinuteSeries } from './history';
import { getRecommendations } from './recommend';
export type { UnifiedQuote, UnifiedKline, BackendQuote, BackendHistory } from './types';
export type { HistoryResult, PeriodPolicy, MinuteKline } from './history';
export { getQuote, getQuotesBatch, getIndices, searchSymbol };
export { getHistoryWithMeta, getHistory, getPeriodPolicy, getMinuteKline, getMinuteSeries };
export { getRecommendations };
export { getLastComputedAt } from './runtime';

/** 回测交易明细 */
export interface BacktestTrade {
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  pnlPct: number;
  holdDays: number;
  forced?: boolean;
}

/** 回测结果 */
export interface BacktestResult {
  symbol: string;
  strategy: string;
  params: { fast: number; slow: number; capital: number };
  range: { start: string; end: string; bars: number };
  finalValue: number;
  totalReturn: number;
  annualized: number;
  maxDrawdownPct: number;
  maxDrawdown: number;
  tradeCount: number;
  winRate: number;
  annualVol?: number;
  sharpe?: number | null;
  sortino?: number | null;
  calmar?: number | null;
  profitFactor?: number | null;
  avgWinPct: number;
  avgLossPct: number;
  benchmarkReturn: number;
  /** 沪深300 指数基准（仅 A 股标的返回） */
  benchmark300?: { date: string; value: number }[];
  benchmark300Return?: number;
  trades: BacktestTrade[];
  equity: { date: string; value: number }[];
  benchmark: { date: string; value: number }[];
  error?: string;
}

/** 5e. 策略回测（后端回测引擎） */
export const runBacktest = async (params: {
  symbol: string;
  strategy?: 'ma' | 'rsi' | 'buyhold';
  fast?: number;
  slow?: number;
  capital?: number;
  count?: number;
  slippage?: number;
}): Promise<BacktestResult> => {
  const qs = new URLSearchParams();
  qs.set('symbol', params.symbol);
  qs.set('strategy', params.strategy || 'ma');
  if (params.fast) qs.set('fast', String(params.fast));
  if (params.slow) qs.set('slow', String(params.slow));
  if (params.capital) qs.set('capital', String(params.capital));
  if (params.count) qs.set('count', String(params.count));
  if (typeof params.slippage === 'number') qs.set('slippage', String(params.slippage));
  return apiGet<BacktestResult>(`/backtest?${qs.toString()}`);
};

/** 5f. 网站 AI 问答（云端模型生成较慢，专用 75s 超时；思考链独立返回） */
export const askAssistant = async (
  question: string,
  externalSignal?: AbortSignal,
): Promise<{ question: string; type: string; answer: string; symbol?: string; engine?: string; reasoning?: string | null; degraded?: string }> => {
  const qs = new URLSearchParams();
  qs.set('q', question);
  return apiGetTimed<{
    question: string;
    type: string;
    answer: string;
    engine?: string;
    reasoning?: string | null;
    degraded?: string;
  }>(`/qa?${qs.toString()}`, {
    timeoutMs: 75000,
    signal: externalSignal,
    timeoutMessage: '云端模型响应超时，请稍后重试',
  });
};

// ───────────── 模拟交易（paper trading） ─────────────

export interface PaperPosition {
  symbol: string;
  name?: string;
  market: string;
  qty: number;
  avgCost: number;
  lastPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  /** A股 T+1：当前可卖出数量（= qty - 当日买入锁定数） */
  sellableQty?: number;
  /** A股 T+1：今日买入、当日不可卖的数量 */
  t1Locked?: number;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  name?: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  qty: number;
  limitPrice: number | null;
  status: 'pending' | 'resting' | 'filled' | 'canceled' | 'rejected';
  /** GFD 当日有效：YYYY-MM-DD（限价挂单挂出时设置，到期由撮合自动撤销） */
  validUntil?: string;
  /** 委托估算价（下单瞬间的行情价） */
  estimatePrice?: number | null;
  /** 策略归因标记（策略引擎下单时传入，人工下单为空串） */
  src?: string;
  filledAt?: string;
  reason?: string;
  avgFillPrice?: number;
  fees?: { total: number };
  createdAt: string;
}

export interface PaperAccount {
  uid: string;
  cash: number;
  /** 可用现金 = 现金 − 挂单冻结（评审 P1-4） */
  availableCash?: number;
  reservedCash?: number;
  initialCapital: number;
  marketValue: number;
  totalAssets: number;
  totalPnl: number;
  totalPnlPct: number;
  todayPnl: number;
  /** 回撤熔断状态（评审 P2-2） */
  peakAssets?: number;
  drawdownPct?: number;
  riskLocked?: boolean;
  ddLevel?: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  equity: { t: string; total: number; cash: number; marketValue: number }[];
}

export interface PaperStrategy {
  id: string;
  type: string;
  symbol: string;
  name?: string;
  params: Record<string, number>;
  status: 'running' | 'stopped';
  lastSignal: string;
  startedAt: string;
  lastRunAt: string;
  error: string;
}

export interface PaperLogEntry {
  t: string;
  msg: string;
}

export interface PaperAlert {
  id: string;
  symbol: string;
  name: string;
  condition: 'above' | 'below';
  price: number;
  createdAt: string;
  triggeredAt?: string;
  triggeredPrice?: number;
}

export interface PaperTriggeredAlert {
  id: string;
  alertId: string;
  symbol: string;
  name: string;
  condition: 'above' | 'below';
  price: number;
  triggeredPrice: number;
  at: string;
}

/** 10. 模拟交易 API（后端 server/paper/*） */
export const paperApi = {
  getAccount: () => apiGet<PaperAccount>('/paper/account'),
  placeOrder: (body: {
    symbol: string;
    name?: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    qty: number;
    limitPrice?: number;
  }) => apiPost<{ ok: boolean; order?: PaperOrder; error?: string }>('/paper/order', body),
  cancelOrder: (id: string) =>
    apiPost<{ ok: boolean; error?: string }>(`/paper/order/${encodeURIComponent(id)}/cancel`, {}),
  reset: () => apiPost<{ ok: boolean; message?: string }>('/paper/reset', {}),
  listStrategies: () => apiGet<PaperStrategy[]>('/paper/strategies'),
  startStrategy: (body: {
    type: string;
    symbol: string;
    name?: string;
    params: Record<string, number>;
  }) => apiPost<{ ok: boolean; error?: string }>('/paper/strategies', body),
  stopStrategy: (id: string) =>
    apiPost<{ ok: boolean; error?: string }>(`/paper/strategies/${encodeURIComponent(id)}/stop`, {}),
  getLogs: () => apiGet<PaperLogEntry[]>('/paper/logs'),
  listAlerts: () =>
    apiGet<{ ok: boolean; alerts: PaperAlert[]; triggered: PaperTriggeredAlert[] }>('/paper/alerts'),
  addAlert: (body: { symbol: string; name?: string; condition: 'above' | 'below'; price: number }) =>
    apiPost<{ ok: boolean; alert?: PaperAlert; error?: string }>('/paper/alerts', body),
  removeAlert: (id: string) =>
    apiDelete<{ ok: boolean; error?: string }>(`/paper/alerts/${encodeURIComponent(id)}`),
  clearTriggeredAlerts: () => apiPost<{ ok: boolean }>('/paper/alerts/clear-triggered', {}),
};

// ───────────── 选股器 + 市场温度计 + 自选池（融合 TSP） ─────────────

export interface ScreenerRow {
  code: string;
  name: string;
  price: number;
  pct: number;
  volume: number;
  amount: number;
  turnover: number;
  volRatio: number;
  high: number;
  low: number;
  open: number;
  mktCap: number;
  industry: string;
}

export interface ScreenerResult {
  ok: boolean;
  ts: number;
  stale: boolean;
  strategy: string;
  strategyName: string;
  desc: string;
  scanned: number;
  matched: number;
  rows: ScreenerRow[];
  error?: string;
}

export interface ScreenerStrategy {
  key: string;
  name: string;
  desc: string;
}

export interface MarketMood {
  ok: boolean;
  ts: number;
  stale: boolean;
  total: number;
  up: number;
  down: number;
  flat: number;
  limitUp: number;
  limitDown: number;
  totalAmount: number;
  score: number;
  industries: { name: string; avgPct: number; upRatio: number; count: number }[];
  coldest: { name: string; avgPct: number; upRatio: number; count: number }[];
  error?: string;
}

export interface WatchItem {
  symbol: string;
  name: string;
  note: string;
  addedAt: string;
}

/** 11. 选股器 / 市场温度计 / 自选池 */
export const screenerApi = {
  strategies: () => apiGet<{ ok: boolean; strategies: ScreenerStrategy[] }>('/screener/strategies'),
  run: (strategy: string, sort = 'pct', limit = 50) =>
    apiGet<ScreenerResult>(`/screener?strategy=${encodeURIComponent(strategy)}&sort=${sort}&limit=${limit}`),
};

export const moodApi = {
  get: () => apiGet<MarketMood>('/mood'),
};

export interface TickData {
  time: string;
  price: number;
  chg: number;
  vol: number;
  type: 'B' | 'S' | 'M';
}

/** 12. 分笔成交（东财逐笔，仅 A 股） */
export const getTicks = (symbol: string) =>
  apiGet<{ ok: boolean; code: string; ticks: TickData[]; ts: number; error?: string }>(
    `/ticks/${encodeURIComponent(symbol)}`,
  );

export const watchlistApi = {
  list: () => apiGet<{ ok: boolean; items: WatchItem[] }>('/watchlist'),
  add: (body: { symbol: string; name?: string; note?: string }) =>
    apiPost<{ ok: boolean; existed?: boolean; error?: string }>('/watchlist', body),
  remove: (symbol: string) =>
    apiDelete<{ ok: boolean; error?: string }>(`/watchlist/${encodeURIComponent(symbol)}`),
};

/** 6. 数据源状态 */
export const getDataSourceStatus = () => {
  const h = getSourceHealth();
  return {
    primary: 'AI深度量化数据服务',
    /** 60 秒内没有新失败即视为健康（真实探测，非硬编码） */
    primaryHealthy: Date.now() - h.lastFailureAt > 60_000 || h.failCount === 0,
    primaryConfigured: true,
    fallback: '本地 Baostock 归档（上游失败时自动兜底）',
    current: 'backend',
    cacheSize: h.cacheSize,
    lastFailureAt: h.lastFailureAt,
    failCount: h.failCount,
  };
};

/** 7. 强制切换（占位） */
export const forceSwitchDataSource = () => {
  /* 单一后端数据源，无需切换 */
};

/** 8. 清理缓存（切换股票时调用，强制更新） */
export const clearCache = () => clearMemoryCache();

/** 9. 后端健康检查 */
export const checkBridgeHealth = async (): Promise<{ ok: boolean; mcpReady: boolean; tools: string[] }> => {
  try {
    const res = await apiGet<{ ok: boolean }>('/health');
    return {
      ok: res.ok === true,
      mcpReady: res.ok === true,
      tools: ['quote', 'history', 'mkline', 'minute', 'indices', 'search', 'backtest', 'qa'],
    };
  } catch {
    return { ok: false, mcpReady: false, tools: [] };
  }
};

/** 11. 认证 API（/api/auth/*，Cookie 会话由后端 Set-Cookie 维护） */
export const authApi = {
  me: () =>
    apiGet<{ ok: boolean; username: string | null; isAdmin?: boolean; authEnabled?: boolean }>('/auth/me'),
  login: (username: string, password: string) =>
    apiPost<{ ok: boolean; username?: string; error?: string }>('/auth/login', { username, password }),
  register: (username: string, password: string, invite?: string) =>
    apiPost<{ ok: boolean; username?: string; error?: string }>('/auth/register', { username, password, invite }),
  changePassword: (oldPassword: string, newPassword: string) =>
    apiPost<{ ok: boolean; username?: string; error?: string }>('/auth/change-password', { oldPassword, newPassword }),
  logout: () => apiPost<{ ok: boolean }>('/auth/logout', {}),

  // ── 邀请码管理（一码一人）──────────────────────────────────
  //   后端挂在 /api/auth/* 下（该路由段在鉴权中间件之前，故**自行校验管理员身份**，
  //   非管理员一律 403）。管理员判定 = 用户名等于后端 SITE_USERNAME。
  listInvites: () =>
    apiGet<{
      ok: boolean;
      enabled: boolean;
      codes: InviteEntry[];
      summary?: { total: number; unused: number; used: number; revoked: number };
    }>('/auth/invites'),
  createInvite: (note: string, ttlDays?: number) =>
    apiPost<{ ok: boolean; entry?: InviteEntry; error?: string }>('/auth/invites', { note, ttlDays }),
  revokeInvite: (code: string) =>
    apiPost<{ ok: boolean; entry?: InviteEntry; error?: string }>('/auth/invites/revoke', { code }),
};

/** 邀请码条目 —— 字段与 server/invites.cjs 的 rowToEntry 一一对应（勿臆造字段名） */
export type InviteEntry = {
  code: string;
  note: string;
  createdAt: string | null;
  usedBy: string | null;
  usedAt: string | null;
  revoked: boolean;
  expiresAt: string | null;
};

// ───────────── Agent 团队分析 ─────────────

export interface AgentReport {
  name: string;
  role: string;
  findings: string[];
  bias?: 'bullish' | 'bearish' | 'neutral';
  confidence?: number;
  metrics?: Record<string, number | null>;
  limitations?: string[];
}

export interface AgentRosterEntry {
  seat: string;
  /** 实际产出该角色内容的模型 */
  model: string;
  /** llm = 真调用了云端大模型；rule = 降级到本地规则引擎 */
  engine: 'llm' | 'rule';
  ms: number | null;
}

/** 降级汇总：哪些角色由本地规则引擎兜底（后端 trace.degraded） */
export interface AgentDegraded {
  degraded: boolean;
  /** 真正由大模型产出的角色数 */
  llm: number;
  /** 降级到规则引擎的角色数 */
  rule: number;
  total: number;
  /** 降级角色名 */
  seats: string[];
  reason?: string;
}

export interface AgentTrace {
  ok: boolean;
  symbol: string;
  name?: string;
  mode: string;
  ranAt: string;
  price: number | null;
  stages: Record<string, any>;
  final: { decision: string; note?: string; teamScore?: number; disclaimer?: string };
  disclaimer: string;
  reportId?: string;
  error?: string;
  /** 每个角色的实际执行引擎与模型（用于判断 AI 是否真的参与了分析） */
  llmRoster?: AgentRosterEntry[];
  llmEnabled?: boolean;
  /** 本次运行的降级情况（显式可观测，避免把规则产出误读为大模型分析） */
  degraded?: AgentDegraded;
  /**
   * 本次实际使用的 LLM 能力档位（L1.5）。
   * 后端在三条路径上分别打标：rule（规则引擎同步返回）/ platform（T3 异步流水线）/
   * 以及 403 拒绝时的 tier:'platform'（表示「你请求的档位」而非「实际使用的档位」）。
   * 前端必须据此回显，避免用户把规则产出误认为大模型产出。
   */
  tier?: AgentTier;
}

/** LLM 能力档位（与 server/index.cjs 的 tiers 声明同口径） */
export type AgentTier = 'rule' | 'byok' | 'platform';

export interface TierDeclaration {
  key: AgentTier;
  available: boolean;
  /** 该档位是否消耗平台侧 LLM 配额 */
  platformLLM: boolean;
  label: string;
  adminOnly?: boolean;
}

export interface AgentCapabilities {
  ok: boolean;
  /** public = 公网演示版（长任务受限）；full = 完整版（无时限）。取值不带任何平台含义 */
  runtime: 'public' | 'full';
  tiers: TierDeclaration[];
  /** 各模式在当前 runtime + 档位下是否可跑 */
  modes: Record<string, { available: boolean; reason?: string }>;
  hints: { byok?: string; platform?: string };
}

/** 12. Agent 团队分析（主理人调度制五阶段流水线，程序化规则引擎） */
export const agentsApi = {
  analyze: (body: { symbol: string; mode?: string; agent?: string; entryPrice?: number; tier?: AgentTier }) =>
    apiPost<AgentTrace & { jobId?: string }>('/agents/analyze', body, {
      // Agent 流水线公网耗时 30-60s（13 角色多次数据调用），全局 30s 预算必现假性超时——
      // 单独放宽到 58s（贴服务端 maxDuration=60 留余量）；超时文案引导查历史报告（后端会存档）
      timeoutMs: 58_000,
      timeoutMessage: '分析耗时超过公网处理上限（约 55 秒）。流水线可能已在后台完成——请稍后到「Agent 团队」页查看历史报告；或改用「快速分析」模式。',
    }),
  /**
   * 能力档位声明（L1.3/L1.5）。纯声明接口：不消耗 LLM 配额、不触发外部请求。
   * 前端据此决定档位 Tab 的可见性与模式置灰，而不是等用户点了才撞 503/403。
   */
  capabilities: () => apiGet<AgentCapabilities>('/agents/capabilities'),
  job: (id: string) =>
    apiGet<{ ok: boolean; status: 'running' | 'done' | 'error'; stage: string; step: number; total: number; reportId?: string; error?: string; trace?: AgentTrace }>(
      `/agents/job/${encodeURIComponent(id)}`,
    ),
  report: (id: string) =>
    apiGet<{ ok: boolean; report: AgentTrace }>(`/agents/report/${encodeURIComponent(id)}`),
  list: (symbol?: string) =>
    apiGet<{ ok: boolean; list: { id: string; symbol: string; name?: string; mode: string; decision: string; ranAt: string }[] }>(
      `/agents/reports${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`,
    ),
  remove: (id: string) =>
    apiDelete<{ ok: boolean; error?: string }>(`/agents/reports/${encodeURIComponent(id)}`),
};

export interface NewsItem {
  id: string;
  title: string;
  snippet?: string;
  media: string;
  url: string;
  date: string;
  publishedAt: string;
  fetchedAt: string;
  category: 'market' | 'stock' | 'official';
  sourceType: 'official' | 'public-media';
  symbol?: string;
  symbols?: string[];
  source?: string;
  /** 个股相关度置信度 0~1，仅个股资讯返回 */
  matchScore?: number;
  /** 命中原因，例如「个股官方资讯 · 标题点名」 */
  matchReason?: string;
  matchLevel?: 'high' | 'medium' | 'low';
}

export interface NewsResponse {
  ok: boolean;
  type: 'market' | 'stock' | 'official';
  symbol: string | null;
  /** 个股资讯返回的证券简称 */
  stockName?: string | null;
  items: NewsItem[];
  fetchedAt: string;
  stale?: boolean;
  retentionHours: 72;
  sourceNote?: string;
  error?: string;
}

export const newsApi = {
  get: (type: NewsResponse['type'] = 'market', symbol?: string, limit = 60) => {
    const qs = new URLSearchParams({ type, limit: String(limit) });
    if (symbol) qs.set('symbol', symbol);
    return apiGet<NewsResponse>(`/news?${qs.toString()}`);
  },
};

export interface NewsHealth {
  ok: boolean;
  sources: Record<string, { ok: number; fails: number; lastOk: number | null; lastErr: string | null; degraded: boolean }>;
  tdxChannel?: { reachable: number; total: number; available: boolean; checkedAt: string | null };
  snapshot?: { updatedAt: string | null; count: number; byCategory: Record<string, number> };
}

export const newsHealthApi = {
  get: () => apiGet<NewsHealth>('/news/health'),
};

/** 13. 看板数据面板（资金流 / 财务 / 估值 / 新闻，东方财富公开接口，缺失自动为 null） */
export const feedApi = {
  get: (symbol: string) =>
    apiGet<{
      ok: boolean;
      moneyFlow: any;
      fundamentals: any;
      valuation: any;
      announcements: NewsItem[] | null;
      stockNews: NewsItem[] | null;
      marketNews: NewsItem[] | null;
      error?: string;
    }>(`/feed/${encodeURIComponent(symbol)}`),
};

/** 14. AI 助手学习系统（知识库 / 反馈 / 教学 / 训练状态） */
export const aiApi = {
  stats: () => apiGet<{ ok: boolean; knowledge: number; trainCount: number; lastNightly: any; pendingQuestions: number }>('/ai/stats'),
  feedback: (body: { question: string; answer: string; rating: 'up' | 'down'; comment?: string }) =>
    apiPost<{ ok: boolean }>('/ai/feedback', body),
  teach: (body: { q: string; a: string }) => apiPost<{ ok: boolean; updated?: boolean; error?: string }>('/ai/teach', body),
};

/** 15. 研究工作台（横截面回测 / 实验历史 / 一致性报告 / 对账 / 熔断解锁） */
export interface CrossBacktestResult {
  engine: string;
  factor: string;
  /** 'preset' = 预置因子；'expr' = 自定义表达式（M3）。历史响应可能无此字段 */
  factorKind?: 'preset' | 'expr';
  /** 表达式元数据（仅 factorKind==='expr' 时有值）：算子列表、最长窗口、推断方向 */
  factorExprMeta?: { ops: string[]; maxWindow: number; direction: string | null } | null;
  factorWindow: number;
  topN: number;
  rebalanceEvery: number;
  universeSize: number;
  capital: number;
  slippage: number;
  range: { start: string; end: string; bars: number };
  rebalances: number;
  fills: number;
  totalFees: number;
  turnover: number;
  feeRatePct: number;
  finalValue: number;
  totalReturn: number;
  annualized: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  equity: { date: string; value: number }[];
  benchmarkReturn?: number | null;
  benchmarkUniverse?: string | null;
  benchmark?: { date: string; value: number }[] | null;
  /**
   * IC（Rank IC / Spearman）序列与显著性摘要（M2.2）。
   * ⚠️ `degraded: true` 表示「**不可检验**」而非「不显著」——常见于 IC 序列方差为 0
   *    （t 统计量分母为 0，无定义）或期数不足。此时 t/p 为 null，UI **必须显式说明原因**，
   *    不能让用户把「算不出来」误读成「因子无效」。
   * ⚠️ `se` 为 Newey-West (HAC) 标准误、`seIid` 为独立同分布假设下的标准误。
   *    两者差异即自相关对显著性的影响幅度，同屏展示更有信息量。
   */
  ic?: {
    series: { date: string; ic: number; n: number }[];
    n: number;
    icMean: number | null;
    icStd: number | null;
    icir: number | null;
    icPositiveRate: number | null;
    t: number | null;
    p: number | null;
    se: number | null;
    seIid: number | null;
    neweyWestLag: number;
    significant2: boolean;
    significant3: boolean;
    degraded?: boolean;
    degradeReason?: string;
    factor?: string;
    factorWindow?: number;
    basis?: string;
  };
  error?: string;
}

export interface ExperimentRecord {
  ts: string;
  symbol: string;
  strategy: string;
  params: Record<string, number | string | null>;
  range: { start: string; end: string; bars: number } | null;
  metrics: {
    sortino?: number | null;
    calmar?: number | null;
    benchmarkReturn?: number | null;
    blockedLimitUp?: number | null;
    blockedLimitDown?: number | null;
    [k: string]: number | null | undefined;
  };
  note: string;
  rawSymbol?: string;
  equityThumb?: { d: string; v: number }[];
}

export interface ConsistencyEntry {
  strategyId: string;
  uid: string;
  type: string;
  symbol: string;
  status: string;
  paper: { closedTrades: number; openBuys: number; realized: number; pricePnl: number; costs: number; feeSum: number; turnover: number; feeRatePct: number; winRate: number | null };
  paperReturnPct: number | null;
  backtest: { strategy?: string; totalReturn?: number; tradeCount?: number; feeRatePct?: number; totalFees?: number; skipped?: string; error?: string };
  deltas: { returnDiffPct: number; tradeCountDiff: number; feeRateDiffPct: number } | null;
  decay: string | null;
  costAttribution: { grossPricePnl: number; costs: number; netRealized: number; note: string };
  prior90: { closedTrades: number; realized: number; winRate: number | null };
}

// ── 因子稳健性评估（S3）──
//   用途：判定因子是否稳健。单看全区间收益会被**路径依赖**放大
//   （实测 rev60 全区间超额 +253pp，逐年 6 正 5 负、平均仅 -0.82pp）。
export type FactorVerdict = '稳健' | '边缘' | '不稳定';

export interface FactorEvalYearRow {
  year: number;
  strategy?: number;
  benchmark?: number;
  excess?: number;
  rebalances?: number;
  error?: string;
}

export interface FactorEvalStability {
  posYears: number;
  totalYears: number;
  posRatio: number;
  avgExcess: number;
  stdExcess: number;
  verdict: FactorVerdict;
}

export interface FactorEvalItem {
  factor: string;
  full:
    | { error: string }
    | {
        range: { start: string; end: string; bars: number };
        totalReturn: number;
        benchmarkReturn: number;
        excess: number;
        maxDrawdownPct: number;
        sharpe: number | null;
        rebalances: number;
      };
  byYear: FactorEvalYearRow[];
  stability: FactorEvalStability;
}

export interface FactorEvalResult {
  ok: boolean;
  params: { topN: number; rebalanceEvery: number; capital: number; yearFrom: number; yearTo: number };
  years: number[];
  availableFactors: string[];
  invalidFactors: string[];
  factors: FactorEvalItem[];
  disclaimer: string;
}

/**
 * 分层回测结果（M2.1 / 服务端 `crosssect.cjs: layerAnalysis`）。
 *
 * ⚠️ **口径：不计手续费与滑点**——本接口度量因子的原始预测力，成本影响体现在
 *    crossBacktest 的净值里。两者口径有意分离，**不是可直接比较的收益**。
 * ⚠️ **层号语义固定「layer 1 = 因子值最高」**（与因子方向无关）。因此 mom* 期望
 *    `spearman < 0`（强层跑赢），rev* 期望 `spearman > 0`。**判定有效性请看
 *    `mono.strategyAligned`（已按 mom/rev 分判），不要只看 ρ 的符号。**
 */
export interface LayerAnalysisResult {
  engine?: string;
  factor?: string;
  factorWindow?: number;
  /** 'preset' | 'expr'（M3） */
  factorKind?: 'preset' | 'expr';
  /**
   * 表达式**方向是否不定**（M3）。true 时 `mono.strategyAligned` 为 null——
   *   如 `mom60 - mom20` 混合了动量语义，无法判定"是否与策略方向一致"。
   * ⚠️ UI **必须**区分「null = 不可判」与「false = 判定为相反」，不可都显示成"不一致"。
   */
  directionUncertain?: boolean;
  /** 表达式元数据（仅 expr 时有值） */
  exprMeta?: { ops: string[]; maxWindow: number; direction: string | null } | null;
  /** 该因子是否属反转族（决定 mono.strategyAligned 的判定方向） */
  isReversal?: boolean;
  /**
   * ⚠️ 后端在响应里**同时**用 `layers` 承载两个不同语义的字段：
   *    `layers: number`（请求的层数）与 `layers: [...]`（逐层结果）——
   *    JS 对象字面量后写的键会覆盖前者，实测响应中 `layers` **是数组**。
   * 为消除歧义，此处对数组用 `layers`，对层数用 `layerCount`；
   * 读取层数请用 `layers?.length`，**不要**读 `layerCount`（后端不返回此键）。
   * 之所以保留 `layerCount` 仅为文档说明，实际值恒为 undefined。
   */
  layers?: Array<{
    layer: number;
    label: string;
    totalReturnPct: number;
    annualizedPct: number;
    meanPeriodRetPct: number;
    stdPeriodRetPct: number;
    periods: number;
  }>;
  layerCount?: number;
  rebalanceEvery?: number;
  range?: { start: string; end: string; bars: number; periods: number };
  universeSize?: number;
  /** 口径声明原样透传，供 UI 展示（防止前端自行编造口径） */
  layerBasis?: string;
  note?: string;
  mono?: {
    /** 层号 × 层期均收益 的 Spearman。完全单调时 |ρ| = 1。不可计算时为 null */
    spearman: number | null;
    monotonic: boolean;
    threshold: number;
    /** 纯因子层面的描述（与策略无关），如「因子值越高、下期收益越低」 */
    factorDirection: string | null;
    /**
     * 因子方向与**当前策略方向**是否一致（已按 mom/rev 分判）。
     * true = 一致（有利）；false = 相反（按此选股会系统性亏损）；
     * **null = 方向不定不可判**（如 mom60 - mom20），此时不得显示成"相反"。
     */
    strategyAligned: boolean | null;
    strategyNote: string | null;
    /** 第 1 层 − 第 N 层 的期均收益差（pp）。注意这是**期均**而非累计收益差 */
    longShortSpreadPct: number;
    interpretation: string;
  };
  error?: string;
}

export const researchApi = {
  crossBacktest: (p: {
    factor: string;
    topN: number;
    rebalanceEvery: number;
    capital: number;
    slippage?: number;
    /** 区间裁剪（样本外验证用；仅截断交易日轴，因子窗口仍读前置历史） */
    startDate?: string;
    endDate?: string;
  }) => {
    const q = new URLSearchParams({
      factor: p.factor,
      topN: String(p.topN),
      rebalanceEvery: String(p.rebalanceEvery),
      capital: String(p.capital),
      slippage: String(p.slippage ?? 0.001),
    });
    if (p.startDate) q.set('startDate', p.startDate);
    if (p.endDate) q.set('endDate', p.endDate);
    return apiGet<CrossBacktestResult>(`/crossbacktest?${q.toString()}`);
  },
  /**
   * 分层回测（M2.1）：判定因子有效性是否贯穿全截面。
   * ⚠️ 口径：**不计手续费与滑点**（度量因子原始预测力），勿与本接口的净值直接比较。
   */
  factorLayers: (p: { factor: string; layers?: number; rebalanceEvery?: number; startDate?: string; endDate?: string }) => {
    const q = new URLSearchParams({
      factor: p.factor,
      layers: String(p.layers ?? 5),
      rebalanceEvery: String(p.rebalanceEvery ?? 20),
    });
    if (p.startDate) q.set('startDate', p.startDate);
    if (p.endDate) q.set('endDate', p.endDate);
    return apiGet<LayerAnalysisResult>(`/factor-layers?${q.toString()}`);
  },
  /** 因子稳健性评估（全区间 + 逐年）。⚠️ 服务端计算约 8s，调用方必须有 loading 态 */
  factorEval: (
    p: { factors?: string[]; topN?: number; rebalanceEvery?: number; capital?: number; yearFrom?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (p.factors?.length) q.set('factors', p.factors.join(','));
    if (p.topN) q.set('topN', String(p.topN));
    if (p.rebalanceEvery) q.set('rebalanceEvery', String(p.rebalanceEvery));
    if (p.capital) q.set('capital', String(p.capital));
    if (p.yearFrom) q.set('yearFrom', String(p.yearFrom));
    const qs = q.toString();
    return apiGet<FactorEvalResult>(`/factor-eval${qs ? `?${qs}` : ''}`);
  },
  experiments: (limit = 50, symbol?: string, strategy?: string) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (symbol) q.set('symbol', symbol);
    if (strategy) q.set('strategy', strategy);
    return apiGet<{ ok: boolean; experiments: ExperimentRecord[] }>(`/experiments?${q.toString()}`);
  },
  consistency: (windowDays = 30) =>
    apiGet<{ generatedAt: string; windowDays: number; strategyCount: number; decayCount: number; strategies: ConsistencyEntry[] }>(
      `/paper/consistency?windowDays=${windowDays}`,
    ),
  reconcile: () => apiGet<{ ok: boolean; checkedAt: string; uid: string; issues: string[] }>('/paper/reconcile'),
  unlock: () => apiPost<{ ok: boolean; message?: string; peakAssets?: number; error?: string }>('/paper/unlock', {}),
  /** 熔断状态复用账户快照 */
  paperAccount: () => apiGet<PaperAccount>('/paper/account'),
};

// ── Agent 研究（P3-P4：Alpha 角色 + 工具循环）──
export interface AgentTraceEntry {
  ts?: string;
  step?: number;
  tool?: string;
  args?: Record<string, unknown>;
  /** 工具原始数据（数值保真通道：与模型结论并列核对） */
  data?: unknown;
  fingerprint?: { rowsHash?: string } | null;
  ok?: boolean;
  summary?: string;
  elapsedMs?: number;
  model?: string | null;
  event?: string;
  preview?: string;
  errors?: string[];
}

export interface AgentToolData {
  tool: string;
  args: Record<string, unknown>;
  data: Record<string, unknown> | null;
  fingerprint: { rowsHash?: string } | null;
  /** 该 (工具,参数) 被调用的次数（同参重复已合并展示，>1 时 UI 应标注） */
  calls?: number;
}

export interface AgentResearchResult {
  ok: boolean;
  /** 模型最终结论（解读）。⚠️ 数字请以 toolData 为准——模型复述数值不可靠（P3 实测） */
  answer: string | null;
  draft: string | null;
  reason: string;
  rounds: number;
  /** true = 发生模型回退或研究不充分，结论可靠性下降 */
  degraded: boolean;
  actualModel: string | null;
  toolData: AgentToolData[];
  trace: AgentTraceEntry[];
  error?: string;
}

export const agentApi = {
  /** 真调云端模型（Alpha + 工具循环），实测约 5-10s，调用方必须有 loading 态 */
  research: (question: string) => apiPost<AgentResearchResult>('/agent/research', { question }),
};

// ── 知识库（M1）：结构化条目 + 可核查出处 ──
export interface KnowledgeEntry {
  id: string;
  category: 'term' | 'basis' | 'method' | 'paper';
  categoryLabel: string;
  title: string;
  body: string;
  /** 可核查出处（教材章节 / 交易所规则 / 论文题目与链接）——非空是内容硬约束 */
  source: string;
  tags: string[];
  /** 关联条目 id，用于口径互跳 */
  related: string[];
  /** 检索得分（浏览模式为 0） */
  score: number;
  /** 命中的查询词项，供 UI 说明"为何命中" */
  matched: string[];
}

export interface KnowledgeSearchResult {
  ok: boolean;
  query: string;
  category: string | null;
  /** 命中总数（不受 limit 影响） */
  total: number;
  items: KnowledgeEntry[];
  /** 检索路径：browse=浏览 / and=严格多词 / keyword=整句提问已自动放宽为关键词 */
  mode: KnowledgeSearchMode;
  stats: { total: number; byCategory: Record<string, number>; withSource: number };
  categories: { key: string; label: string; count: number }[];
}

export type KnowledgeSearchMode = 'browse' | 'and' | 'keyword';

export const knowledgeApi = {
  /** 检索知识条目；q 为空 = 浏览模式（返回该分类全部） */
  search: (q: string, category?: string, limit?: number) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (category) p.set('category', category);
    if (limit) p.set('limit', String(limit));
    const qs = p.toString();
    return apiGet<KnowledgeSearchResult>(`/knowledge/search${qs ? `?${qs}` : ''}`);
  },
  /** 按 id 批量取条目（关联口径跳转） */
  entries: (ids: string[]) => apiGet<{ ok: boolean; items: KnowledgeEntry[] }>(`/knowledge/entries?ids=${encodeURIComponent(ids.join(','))}`),
};


export default {
  getQuote,
  getQuotesBatch,
  getHistory,
  getIndices,
  searchSymbol,
  getMinuteKline,
  getMinuteSeries,
  getPeriodPolicy,
  getRecommendations,
  runBacktest,
  askAssistant,
  getDataSourceStatus,
  forceSwitchDataSource,
  clearCache,
  checkBridgeHealth,
};
