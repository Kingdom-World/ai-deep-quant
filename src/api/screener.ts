// ─────────────────────────────────────────────────────────────
// 选股 / 市场温度计 / 自选池 域（Screener · Mood · Watchlist · Ticks）
//   · 数据源：后端 /api/screener、/api/mood、/api/watchlist、/api/ticks
//   · 行为零变化：自 src/api/dataService.ts 原样迁出
// ─────────────────────────────────────────────────────────────
import { apiGet, apiPost, apiDelete } from './client';

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

/** 选股器 / 市场温度计 / 自选池 */
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

/** 分笔成交（东财逐笔，仅 A 股） */
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
