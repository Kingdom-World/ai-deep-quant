// ─────────────────────────────────────────────────────────────
// 统一数据服务层（stockDataService）
//   页面级数据入口，屏蔽后端实现细节（轻量后端 /api 或可选 Render-Baostock）。
//   市场代码规则：cn=600519 / hk=00700 / us=AAPL
//   前端缓存策略（Map + 时间戳，见 src/utils/cache.ts）：
//     历史K线 5 分钟 · 实时报价 10 秒 · 大盘指数 15 秒 · 搜索 60 秒
//   注意：本层不直连第三方行情库（stock-sdk 等）——
//         浏览器端 CORS 限制与东财源不可达问题导致直连不可行，
//         统一经轻量后端（Vercel Serverless / Node）获取，保证可靠性与限流合规。
// ─────────────────────────────────────────────────────────────
import {
  getHistory as apiGetHistory,
  getIndices as apiGetIndices,
  getQuote as apiGetQuote,
  searchSymbol as apiSearchSymbol,
  type UnifiedKline,
} from '../api/dataService';
import {
  CACHE_TTL_HISTORY,
  CACHE_TTL_INDICES,
  CACHE_TTL_QUOTE,
  CACHE_TTL_SEARCH,
} from '../config';
import { getCached, setCached } from '../utils/cache';

/** 市场代码：cn（A股）/ hk（港股）/ us（美股） */
export type MarketCode = 'cn' | 'hk' | 'us';

/** 内部市场枚举 */
type InternalMarket = 'CN' | 'HK' | 'US';

const toInternalMarket = (m: MarketCode): InternalMarket =>
  m.toUpperCase() as InternalMarket;

// ── 统一数据结构 ──
export interface StockKline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  prevClose: number | null;
  timestamp: number;
}

export interface IndexQuote {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
}

export interface SearchResult {
  name: string;
  code: string;
  market: string;
}

// ── 可选：Render-Baostock 后端地址（环境变量 VITE_HISTORY_API） ──
// 如 https://xxx.onrender.com，历史K线将优先从 Baostock 获取；
// 未设置时使用轻量后端（Vercel Serverless / Node，腾讯+新浪双源）。
const HISTORY_API = (import.meta.env.VITE_HISTORY_API as string) || '';

/**
 * 实时报价（缓存 10 秒；forceRefresh=true 穿透缓存）
 */
export const getQuote = async (
  symbol: string,
  market: MarketCode = 'cn',
  forceRefresh = false,
): Promise<StockQuote> => {
  const cacheKey = `svc:quote:${market}:${symbol}`;
  if (!forceRefresh) {
    const cached = getCached<StockQuote>(cacheKey, CACHE_TTL_QUOTE);
    if (cached !== null) return cached;
  }
  const q = await apiGetQuote(symbol, toInternalMarket(market), forceRefresh);
  const out: StockQuote = {
    symbol: q.symbol,
    name: q.name ?? symbol,
    price: q.price,
    changePercent: q.changePercent,
    open: q.open,
    high: q.high,
    low: q.low,
    volume: q.volume,
    prevClose: q.prevClose,
    timestamp: q.timestamp,
  };
  setCached(cacheKey, out);
  return out;
};

/**
 * 历史K线（缓存 5 分钟；同一股票+同一周期共享缓存）
 * period: 'day' | 'week' | 'month'
 */
export const getHistory = async (
  symbol: string,
  period: 'day' | 'week' | 'month' = 'day',
  count = 500,
  market: MarketCode = 'cn',
): Promise<StockKline[]> => {
  const cacheKey = `svc:history:${market}:${symbol}:${period}:${count}`;
  const cached = getCached<StockKline[]>(cacheKey, CACHE_TTL_HISTORY);
  if (cached !== null) return cached;

  let klines: StockKline[];
  if (HISTORY_API) {
    // 可选：Render-Baostock 后端
    const freqMap: Record<string, string> = { day: '1d', week: '1w', month: '1M' };
    const url = `${HISTORY_API}/api/history?symbol=${encodeURIComponent(symbol)}&count=${count}&frequency=${freqMap[period]}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`历史数据接口异常 (HTTP ${res.status})`);
    const j = await res.json();
    const rows: { date: string; open: number; close: number; high: number; low: number; volume: number }[] =
      j?.klines || j?.data || [];
    klines = rows.map((r) => ({
      date: String(r.date).slice(0, 10),
      open: Number(r.open),
      close: Number(r.close),
      high: Number(r.high),
      low: Number(r.low),
      volume: Number(r.volume),
    }));
  } else {
    // 轻量后端（Vercel Serverless / Node）：day/3day/quarter/year 由前端聚合日线
    const rows: UnifiedKline[] = await apiGetHistory(
      symbol,
      toInternalMarket(market),
      period,
      count,
    );
    klines = rows.map((r) => ({
      date: r.date,
      open: r.open,
      close: r.close,
      high: r.high,
      low: r.low,
      volume: r.volume,
    }));
  }
  setCached(cacheKey, klines);
  return klines;
};

/**
 * 大盘指数（缓存 15 秒）
 */
export const getIndices = async (forceRefresh = false): Promise<IndexQuote[]> => {
  const cacheKey = 'svc:indices';
  if (!forceRefresh) {
    const cached = getCached<IndexQuote[]>(cacheKey, CACHE_TTL_INDICES);
    if (cached !== null) return cached;
  }
  const items = await apiGetIndices(forceRefresh);
  const out: IndexQuote[] = items.map((it) => ({
    symbol: it.symbol,
    name: it.name ?? it.symbol,
    price: it.price,
    changePercent: it.changePercent ?? 0,
  }));
  setCached(cacheKey, out);
  return out;
};

/**
 * 股票搜索（缓存 60 秒）
 */
export const searchSymbol = async (keyword: string): Promise<SearchResult[]> => {
  const cacheKey = `svc:search:${keyword}`;
  const cached = getCached<SearchResult[]>(cacheKey, CACHE_TTL_SEARCH);
  if (cached !== null) return cached;
  const items = await apiSearchSymbol(keyword);
  setCached(cacheKey, items);
  return items;
};

export default { getQuote, getHistory, getIndices, searchSymbol };
