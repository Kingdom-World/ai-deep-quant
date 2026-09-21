// ─────────────────────────────────────────────────────────────
// 统一数据服务层（直连独立后端 / Vercel Serverless）
//   前端 → /api/*（vite proxy 或同源）→ server/index.cjs（Express）
//   → 新浪/腾讯公开财经接口（无需 API Key，双源自动切换）
//   前端缓存: 分级 TTL（报价10s / 指数15s / 历史5min），命中输出 [Cache] 日志；
//   请求去重：相同 in-flight 请求合并
// ─────────────────────────────────────────────────────────────
import type { Market } from '../lib/stock';
import {
  BACKEND_MODE,
  CACHE_TTL_QUOTE,
  CACHE_TTL_INDICES,
  CACHE_TTL_HISTORY,
  CACHE_TTL_MKLINE,
  CACHE_TTL_SEARCH,
  REQUEST_TIMEOUT,
} from '../config';
import {
  clearCache as clearMemoryCache,
  getCacheSize,
  getCached,
  setCached,
} from '../utils/cache';

// ============ 配置 ============
const CONFIG = {
  /** 后端 API 基础路径（同源 /api：生产由 Vercel Function 提供，开发经 vite proxy） */
  basePath: '/api',
  /** 请求超时 */
  timeout: REQUEST_TIMEOUT,
  /** 是否启用缓存 */
  enableCache: true,
};

// ============ 缓存（统一内存缓存工具，分级 TTL） ============
const getCacheKey = (type: string, params: unknown): string => `${type}:${JSON.stringify(params)}`;

/**
 * 带 HTTP 状态与结构化响应体的错误。
 * 用于后端「因档位/运行时不可用而拒绝」的场景（403/503）：这类拒绝不是故障，
 * 而是**能力边界声明**，UI 必须能读到 tier / availableTiers 才能给出正确指引。
 */
export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
  /** 从任意异常里取出后端结构化体（非 ApiError 返回 null） */
  static bodyOf(e: unknown): any {
    return e instanceof ApiError ? e.body : null;
  }
}

// ============ 请求去重（相同 in-flight 请求合并） ============
const inFlight = new Map<string, Promise<unknown>>();

/** 基础请求（相对路径 /api，经 vite proxy 或同源到后端） */
export async function apiGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
  try {
    const res = await fetch(`${CONFIG.basePath}${path}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `后端接口 HTTP ${res.status}`);
    }
    markSourceOk();
    return (await res.json()) as T;
  } catch (e: any) {
    markSourceFail();
    if (e?.name === 'AbortError') {
      throw new Error('请求超时（请确认已启动数据服务）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带缓存 + 去重的请求（TTL 内命中直接返回缓存，不发起网络请求）
 */
async function apiGetCached<T>(key: string, path: string, ttlMs: number): Promise<T> {
  if (CONFIG.enableCache) {
    const cached = getCached<T>(key, ttlMs);
    if (cached !== null) return cached;
  }

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const p = apiGet<T>(path).then((data) => {
    if (CONFIG.enableCache) setCached(key, data);
    return data;
  });
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

// ============ 数据源健康（真实记录，替代此前"永远健康"的假状态） ============
const sourceHealth = { lastSuccessAt: 0, lastFailureAt: 0, failCount: 0 };
function markSourceOk() {
  sourceHealth.lastSuccessAt = Date.now();
  sourceHealth.failCount = 0;
}
function markSourceFail() {
  sourceHealth.lastFailureAt = Date.now();
  sourceHealth.failCount += 1;
}

// ============ 统一数据结构 ============

/** 统一报价 */
export interface UnifiedQuote {
  symbol: string;
  name?: string;
  price: number;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  prevClose: number | null;
  timestamp: number;
  _source: 'backend';
  /** A 股五档盘口（腾讯源提供；美股/港股为 null） */
  bids?: { price: number; qty: number }[] | null;
  asks?: { price: number; qty: number }[] | null;
  quoteTime?: string | null;
}

/** 统一 K 线 */
export interface UnifiedKline {
  time: number;
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  _source?: 'backend';
}

/** 后端报价响应 */
interface BackendQuote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  changePercent: number;
  bids?: { price: number; qty: number }[] | null;
  asks?: { price: number; qty: number }[] | null;
  quoteTime?: string | null;
}

/** 后端 K 线响应 */
interface BackendHistory {
  symbol: string;
  frequency: string;
  /** 实际复权口径：主源失败回退新浪（不复权）时后端标注 'none(备用源)'，前端必须透传展示 */
  adjust?: string;
  klines: { date: string; open: number | null; close: number | null; high: number | null; low: number | null; volume: number | null }[];
}

// ============ 统一对外接口 ============

/** 1. 获取单个股票实时报价 */
export const getQuote = async (
  symbol: string,
  market: Market = 'CN',
  forceRefresh = false,
): Promise<UnifiedQuote> => {
  const cacheKey = getCacheKey('quote', { symbol, market });
  if (!forceRefresh) {
    const cached = getCached<UnifiedQuote>(cacheKey, CACHE_TTL_QUOTE);
    if (cached !== null) return cached;
  }
  const raw = await apiGetCached<BackendQuote>(
    forceRefresh ? `${cacheKey}:fresh` : cacheKey,
    `/quote/${encodeURIComponent(symbol)}`,
    CACHE_TTL_QUOTE,
  );
  const result: UnifiedQuote = {
    symbol,
    name: raw.name ?? undefined,
    price: raw.price,
    changePercent: raw.changePercent ?? 0,
    open: raw.open,
    high: raw.high,
    low: raw.low,
    volume: raw.volume,
    prevClose: raw.prevClose,
    timestamp: Date.now(),
    _source: 'backend',
    bids: raw.bids ?? null,
    asks: raw.asks ?? null,
    quoteTime: raw.quoteTime ?? null,
  };
  setCached(cacheKey, result);
  return result;
};

/** Python+Flask 后端模式：推荐/批量报价走服务端聚合接口（限流友好） */
const PYTHON = BACKEND_MODE === 'python';

/** 最近一次评分快照时间（python 模式来自后端每日 16:00 定时任务） */
let lastComputedAt: string | null = null;
export const getLastComputedAt = (): string | null => lastComputedAt;

/** 2. 批量获取报价（python 模式：后端 /api/quotes 一次聚合；node 模式：逐个调用） */
export const getQuotesBatch = async (
  symbols: string[],
  market: Market = 'CN',
  forceRefresh = false,
): Promise<UnifiedQuote[]> => {
  if (symbols.length === 0) return [];
  if (PYTHON) {
    const key = getCacheKey('quotes', { symbols, forceRefresh });
    if (!forceRefresh) {
      const cached = getCached<UnifiedQuote[]>(key, CACHE_TTL_QUOTE);
      if (cached !== null) return cached;
    }
    const raw = await apiGetCached<BackendQuote[]>(
      forceRefresh ? `${key}:fresh` : key,
      `/quotes?symbols=${encodeURIComponent(symbols.join(','))}`,
      CACHE_TTL_QUOTE,
    );
    const items = (raw || []).map((it) => ({
      symbol: it.symbol,
      name: it.name ?? undefined,
      price: it.price,
      changePercent: it.changePercent ?? 0,
      open: it.open,
      high: it.high,
      low: it.low,
      volume: it.volume,
      prevClose: it.prevClose,
      timestamp: Date.now(),
      _source: 'backend' as const,
    }));
    setCached(key, items);
    return items;
  }
  return Promise.all(
    symbols.map((s) => getQuote(s, market, forceRefresh).catch(() => null)),
  ).then((list) => list.filter((q): q is UnifiedQuote => q !== null));
};

/** 可选：本地/Render Baostock 历史后端地址（.env 配置 VITE_HISTORY_API） */
const HISTORY_API = (import.meta.env.VITE_HISTORY_API as string) || '';

/** 3. 获取历史 K 线（优先 Baostock 后端；未配置或失败时回退轻量后端，缓存 5 分钟） */
export interface HistoryResult {
  klines: UnifiedKline[];
  /** 实际返回数据的复权口径：可能与请求不一致——主源失败回退新浪时为不复权（后端标注 'none(备用源)'）。
   *  除权除息日的假跳空会被当成真实价格，展示与计算前必须核对。 */
  adjust: string;
}

export const getHistoryWithMeta = async (
  symbol: string,
  market: Market = 'CN',
  period: string = 'day',
  count: number = 500,
  forceRefresh = false,
  adjust: 'qfq' | 'hfq' | 'none' = 'qfq',
): Promise<HistoryResult> => {
  // 周期映射：day/3day/quarter/year → 1d（本地聚合）；week → 1w；month → 1M
  const freqMap: Record<string, string> = {
    day: '1d',
    '3day': '1d',
    week: '1w',
    month: '1M',
    quarter: '1d',
    year: '1d',
  };
  const frequency = freqMap[period] || '1d';
  const cacheKey = getCacheKey('history', { symbol, market, period, count, adjust });
  if (!forceRefresh) {
    const cached = getCached<HistoryResult>(cacheKey, CACHE_TTL_HISTORY);
    if (cached !== null) return cached;
  }

  // ── Baostock 后端（VITE_HISTORY_API 配置时优先；失败自动回退轻量后端） ──
  if (HISTORY_API) {
    try {
      const url = `${HISTORY_API}/api/history?symbol=${encodeURIComponent(symbol)}&count=${count}&frequency=${frequency}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        const j = await res.json();
        const rows: { date: string; open: number; close: number; high: number; low: number; volume: number }[] =
          j?.klines || j?.data || [];
        if (rows.length > 0) {
          const klines: UnifiedKline[] = rows.map((k) => ({
            time: new Date(`${String(k.date).slice(0, 10)}T00:00:00`).getTime(),
            date: String(k.date).slice(0, 10),
            open: Number(k.open),
            close: Number(k.close),
            high: Number(k.high),
            low: Number(k.low),
            volume: Number(k.volume),
            _source: 'backend' as const,
          }));
          setCached(cacheKey, { klines, adjust: 'qfq' }); // Baostock 后端仅提供前复权口径
          return { klines, adjust: 'qfq' };
        }
      }
    } catch (e) {
      console.warn('[History] Baostock 后端不可用，回退轻量后端:', (e as Error)?.message);
    }
  }

  const raw = await apiGetCached<BackendHistory>(
    forceRefresh ? `${cacheKey}:fresh` : cacheKey,
    `/history/${encodeURIComponent(symbol)}?frequency=${frequency}&count=${count}&adjust=${adjust}`,
    CACHE_TTL_HISTORY,
  );
  // 透传后端标注的实际口径：主源失败回退新浪（不复权）时会带 'none(备用源)'，
  // 此前该字段被丢弃、图表仍按"前复权"展示——除权日假跳空被当成真实价格（评审致命缺陷 #3）
  const adjustActual = String(raw.adjust || adjust);
  const klines = (raw.klines || []).map((k) => ({
    time: new Date(`${String(k.date).slice(0, 10)}T00:00:00`).getTime(),
    date: String(k.date).slice(0, 10),
    open: k.open ?? 0,
    close: k.close ?? 0,
    high: k.high ?? 0,
    low: k.low ?? 0,
    volume: k.volume ?? 0,
    _source: 'backend' as const,
  }));
  setCached(cacheKey, { klines, adjust: adjustActual });
  return { klines, adjust: adjustActual };
};

/** 兼容封装：多数调用方只关心 K 线本体；需要核对复权口径时用 getHistoryWithMeta */
export const getHistory = async (
  symbol: string,
  market: Market = 'CN',
  period: string = 'day',
  count: number = 500,
  forceRefresh = false,
  adjust: 'qfq' | 'hfq' | 'none' = 'qfq',
): Promise<UnifiedKline[]> => (await getHistoryWithMeta(symbol, market, period, count, forceRefresh, adjust)).klines;

/** 周期可用性策略（后端按历史覆盖动态生成，新上市股票自动适配） */
export interface PeriodPolicy {
  symbol: string;
  source: string;
  dataStart: string;
  dataEnd: string;
  barCount: number;
  coverageDays: number;
  periods: {
    day: boolean;
    '3day': boolean;
    week: boolean;
    month: boolean;
    quarter: boolean;
    year: boolean;
  };
  recommended: string;
}

/** 3b. 获取周期可用性策略（失败返回 null，前端回退本地计算） */
export const getPeriodPolicy = async (symbol: string): Promise<PeriodPolicy | null> => {
  try {
    return await apiGet<PeriodPolicy>(`/period-policy/${encodeURIComponent(symbol)}`);
  } catch {
    return null;
  }
};

/** 4. 获取大盘指数 */
export const getIndices = async (forceRefresh = false): Promise<UnifiedQuote[]> => {
  const cacheKey = getCacheKey('indices', {});
  if (!forceRefresh) {
    const cached = getCached<UnifiedQuote[]>(cacheKey, CACHE_TTL_INDICES);
    if (cached !== null) return cached;
  }
  const raw = await apiGetCached<BackendQuote[]>(
    forceRefresh ? `${cacheKey}:fresh` : cacheKey,
    '/indices',
    CACHE_TTL_INDICES,
  );
  const items = (raw || []).map((it) => ({
    symbol: it.symbol,
    name: it.name,
    price: it.price,
    changePercent: it.changePercent ?? 0,
    open: null,
    high: null,
    low: null,
    volume: null,
    prevClose: it.prevClose,
    timestamp: Date.now(),
    _source: 'backend' as const,
  }));
  setCached(cacheKey, items);
  return items;
};

/** 5. 搜索股票 */
export const searchSymbol = async (
  keyword: string,
): Promise<{ name: string; code: string; market: string }[]> => {
  const cacheKey = getCacheKey('search', { keyword });
  const raw = await apiGetCached<{ name: string; code: string; market: string }[]>(
    cacheKey,
    `/search/${encodeURIComponent(keyword)}`,
    CACHE_TTL_SEARCH,
  );
  return raw || [];
};

/** 分钟 K 线点（真实 OHLCV，date 为 YYYY-MM-DD HH:mm） */
export interface MinuteKline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/** 将 N 根 K 线聚合为 1 根（120分 = 2 × 60分，OHLCV 标准聚合） */
const mergeKlines = (points: MinuteKline[], groupSize: number): MinuteKline[] => {
  if (groupSize <= 1) return points;
  const out: MinuteKline[] = [];
  for (let i = points.length; i > 0; i -= groupSize) {
    const grp = points.slice(Math.max(0, i - groupSize), i);
    if (grp.length === 0) continue;
    out.unshift({
      date: grp[grp.length - 1].date,
      open: grp[0].open,
      close: grp[grp.length - 1].close,
      high: Math.max(...grp.map((p) => p.high)),
      low: Math.min(...grp.map((p) => p.low)),
      volume: grp.reduce((a, p) => a + p.volume, 0),
    });
  }
  return out;
};

/**
 * 5b. 分钟 K 线（真实多日 OHLCV，直连后端 /api/mkline）：
 *   - A股：腾讯 mkline（m1/m5/m15/m30/m60）
 *   - 美股：新浪 US_MinKService（type=1/5/15/30/60）
 *   - 港股：腾讯当日分时聚合
 *   - 120分：2 × 60分本地聚合
 */
export const getMinuteKline = async (
  symbol: string,
  market: Market = 'CN',
  minutePeriod: '1' | '5' | '15' | '30' | '60' | '120' = '5',
): Promise<MinuteKline[]> => {
  const step = minutePeriod === '120' ? '60' : minutePeriod;
  // 缓存 key 必须包含 minutePeriod：120 分是 60 分数据本地聚合，
  // 若共用 key 会把聚合结果写回 60 分缓存，导致 60 分与 120 分图互相污染
  const cacheKey = getCacheKey('mkline', { symbol, market, step, minutePeriod });
  const cached = getCached<MinuteKline[]>(cacheKey, CACHE_TTL_MKLINE);
  if (cached !== null) return cached;
  // 120 分 = 2 根 60 分合并 → 需 640 根 60 分数据才能得到 320 根 120 分线
  const reqCount = minutePeriod === '120' ? 640 : 320;
  const raw = await apiGetCached<{
    symbol: string;
    period: string;
    source: string;
    klines: { date: string; open: number | null; close: number | null; high: number | null; low: number | null; volume: number | null }[];
  }>(cacheKey, `/mkline/${encodeURIComponent(symbol)}?period=m${step}&count=${reqCount}`, CACHE_TTL_MKLINE);
  const klines: MinuteKline[] = (raw.klines || []).map((k) => ({
    date: String(k.date),
    open: k.open ?? 0,
    close: k.close ?? 0,
    high: k.high ?? 0,
    low: k.low ?? 0,
    volume: k.volume ?? 0,
  }));
  const out = minutePeriod === '120' ? mergeKlines(klines, 2) : klines;
  setCached(cacheKey, out);
  return out;
};

/** 5c. 当日分时序列（后端真实分时；date 为交易日日期，供前端按时间窗口制图） */
export const getMinuteSeries = async (
  symbol: string,
  market: Market = 'CN',
): Promise<{ date?: string; time: string; price: number; volume: number }[]> => {
  const cacheKey = getCacheKey('minute', { symbol, market });
  const cached = getCached<{ date?: string; time: string; price: number; volume: number }[]>(
    cacheKey,
    CACHE_TTL_QUOTE,
  );
  if (cached !== null) return cached;
  const raw = await apiGetCached<{ symbol: string; points: { date?: string; time: string; price: number; volume: number }[] }>(
    cacheKey,
    `/minute/${encodeURIComponent(symbol)}`,
    CACHE_TTL_QUOTE,
  );
  const points = raw.points || [];
  setCached(cacheKey, points);
  return points;
};

/** 5d. 因子评分观察（python 模式：后端 Baostock 数据+评分一次聚合；node 模式：前端 lib 评分） */
export const getRecommendations = async (
  codes: { symbol: string; market: Market; name: string }[],
  count = 6,
): Promise<{ symbol: string; market: Market; name: string; price: number; changePercent: number; score: number; rating: string }[]> => {
  if (PYTHON) {
    const raw = await apiGet<
      {
        items: { symbol: string; market: Market; name: string; price: number; changePercent: number; score: number; rating: string }[];
        computedAt?: string;
      }
    >(`/recommend?count=${count}`);
    if (raw?.computedAt) lastComputedAt = raw.computedAt;
    return raw?.items || [];
  }
  const { analyzeStockPotential } = await import('../lib/stock');
  const results: { symbol: string; market: Market; name: string; price: number; changePercent: number; score: number; rating: string }[] = [];
  const queue = [...codes];
  const workers = Array.from({ length: Math.min(3, codes.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const [rows, quote] = await Promise.all([
          getHistory(item.symbol, item.market, 'day', 300, true),
          getQuote(item.symbol, item.market, true),
        ]);
        const points = rows.map((r) => ({
          date: r.date,
          open: r.open,
          close: r.close,
          high: r.high,
          low: r.low,
          volume: r.volume,
        }));
        const report = analyzeStockPotential(item.symbol, points, {
          price: quote.price,
          changePercent: quote.changePercent ?? 0,
        });
        results.push({
          symbol: item.symbol,
          market: item.market,
          name: item.name,
          price: quote.price,
          changePercent: quote.changePercent ?? 0,
          score: report?.total ?? 0,
          rating: report?.rating ?? '数据不足',
        });
      } catch (e) {
        console.error(`推荐评分失败 ${item.symbol}:`, e);
      }
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, count);
};

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  if (externalSignal) {
    if (externalSignal.aborted) { clearTimeout(timer); throw new DOMException('Aborted', 'AbortError'); }
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(`${CONFIG.basePath}/qa?${qs.toString()}`, { signal: controller.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error((err as { error?: string })?.error || `后端接口 HTTP ${res.status}`);
    }
    return (await res.json()) as {
      question: string;
      type: string;
      answer: string;
      engine?: string;
      reasoning?: string | null;
      degraded?: string;
    };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error('云端模型响应超时，请稍后重试');
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

/** DELETE 请求（告警删除等资源移除） */
async function apiDelete<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
  try {
    const res = await fetch(`${CONFIG.basePath}${path}`, { method: 'DELETE', signal: controller.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error((err as { error?: string })?.error || `后端接口 HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new Error('请求超时（请确认已启动数据服务）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────── 模拟交易（paper trading） ─────────────

/** POST 请求（模拟盘下单/撤单/重置/策略启停） */
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
  try {
    const res = await fetch(`${CONFIG.basePath}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      // 后端在 403/503 时会带回结构化信息（tier / availableTiers），
      // 前端据此给出「该用哪个档位」的可操作提示，而不是笼统一句失败。
      // 挂在 ApiError 上而非塞进 message 字符串，避免调用方反解析文案。
      throw new ApiError((err as { error?: string })?.error || `后端接口 HTTP ${res.status}`, res.status, err);
    }
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new Error('请求超时（请确认已启动数据服务）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

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
export const getDataSourceStatus = () => ({
  primary: 'AI深度量化数据服务',
  /** 60 秒内没有新失败即视为健康（真实探测，非硬编码） */
  primaryHealthy: Date.now() - sourceHealth.lastFailureAt > 60_000 || sourceHealth.failCount === 0,
  primaryConfigured: true,
  fallback: '本地 Baostock 归档（上游失败时自动兜底）',
  current: 'backend',
  cacheSize: getCacheSize(),
  lastFailureAt: sourceHealth.lastFailureAt,
  failCount: sourceHealth.failCount,
});

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
  /** serverless = Vercel（函数 30s 上限生效）；node = 本机自托管 */
  runtime: 'serverless' | 'node';
  tiers: TierDeclaration[];
  /** 各模式在当前 runtime + 档位下是否可跑 */
  modes: Record<string, { available: boolean; reason?: string }>;
  hints: { byok?: string; platform?: string };
}

/** 12. Agent 团队分析（主理人调度制五阶段流水线，程序化规则引擎） */
export const agentsApi = {
  analyze: (body: { symbol: string; mode?: string; agent?: string; entryPrice?: number; tier?: AgentTier }) =>
    apiPost<AgentTrace & { jobId?: string }>('/agents/analyze', body),
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

/** 14. AI 助手学习系统（知识库 / 反馈 / 教学 / 自训练状态） */
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
