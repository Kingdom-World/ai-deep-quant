// ─────────────────────────────────────────────────────────────
// 报价域（Quote）—— 实时报价 / 批量报价
//   · 数据源：后端 /api/quote/:symbol、/api/quotes（python 模式）
//   · 缓存：CACHE_TTL_QUOTE（10s）；请求去重由 client.apiGetCached 统一承担
//   · 行为零变化：自 src/api/dataService.ts 原样迁出
// ─────────────────────────────────────────────────────────────
import type { Market } from '../lib/stock';
import { CACHE_TTL_QUOTE } from '../config';
import { getCached, setCached } from '../utils/cache';
import { getCacheKey, apiGetCached } from './client';
import { PYTHON } from './runtime';
import type { UnifiedQuote, BackendQuote } from './types';

export type { UnifiedQuote, UnifiedKline } from './types';

/** 获取单个股票实时报价 */
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

/** 批量获取报价（python 模式：后端 /api/quotes 一次聚合；node 模式：逐个调用） */
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
