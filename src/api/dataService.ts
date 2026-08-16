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

// ============ 请求去重（相同 in-flight 请求合并） ============
const inFlight = new Map<string, Promise<unknown>>();

/** 基础请求（相对路径 /api，经 vite proxy 或同源到后端） */
async function apiGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
  try {
    const res = await fetch(`${CONFIG.basePath}${path}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `后端接口 HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (e: any) {
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
}

/** 后端 K 线响应 */
interface BackendHistory {
  symbol: string;
  frequency: string;
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
export const getHistory = async (
  symbol: string,
  market: Market = 'CN',
  period: string = 'day',
  count: number = 500,
  forceRefresh = false,
): Promise<UnifiedKline[]> => {
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
  const cacheKey = getCacheKey('history', { symbol, market, period, count });
  if (!forceRefresh) {
    const cached = getCached<UnifiedKline[]>(cacheKey, CACHE_TTL_HISTORY);
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
          setCached(cacheKey, klines);
          return klines;
        }
      }
    } catch (e) {
      console.warn('[History] Baostock 后端不可用，回退轻量后端:', (e as Error)?.message);
    }
  }

  const raw = await apiGetCached<BackendHistory>(
    forceRefresh ? `${cacheKey}:fresh` : cacheKey,
    `/history/${encodeURIComponent(symbol)}?frequency=${frequency}&count=${count}`,
    CACHE_TTL_HISTORY,
  );
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
  setCached(cacheKey, klines);
  return klines;
};

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
  avgWinPct: number;
  avgLossPct: number;
  benchmarkReturn: number;
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
}): Promise<BacktestResult> => {
  const qs = new URLSearchParams();
  qs.set('symbol', params.symbol);
  qs.set('strategy', params.strategy || 'ma');
  if (params.fast) qs.set('fast', String(params.fast));
  if (params.slow) qs.set('slow', String(params.slow));
  if (params.capital) qs.set('capital', String(params.capital));
  if (params.count) qs.set('count', String(params.count));
  return apiGet<BacktestResult>(`/backtest?${qs.toString()}`);
};

/** 5f. 网站 AI 问答（后端离线规则引擎） */
export const askAssistant = async (
  question: string,
): Promise<{ question: string; type: string; answer: string; symbol?: string }> => {
  const qs = new URLSearchParams();
  qs.set('q', question);
  return apiGet(`/qa?${qs.toString()}`);
};

/** 6. 数据源状态 */
export const getDataSourceStatus = () => ({
  primary: 'AI深度量化数据服务',
  primaryHealthy: true,
  primaryConfigured: true,
  fallback: 'none',
  current: 'backend',
  cacheSize: getCacheSize(),
  lastFailureAt: 0,
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
