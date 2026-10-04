// ─────────────────────────────────────────────────────────────
// 历史域（History）—— 日/周/月 K 线 · 周期策略 · 分钟 K 线 · 当日分时
//   · 数据源：后端 /api/history、/api/period-policy、/api/mkline、/api/minute；
//     可选外部 Baostock 后端（VITE_HISTORY_API，失败静默回退轻量后端）
//   · 复权口径透传：后端回退新浪时会标注 'none(备用源)'，必须原样透传（除权日假跳空风险）
//   · 行为零变化：自 src/api/dataService.ts 原样迁出
// ─────────────────────────────────────────────────────────────
import type { Market } from '../lib/stock';
import { CACHE_TTL_QUOTE, CACHE_TTL_HISTORY, CACHE_TTL_MKLINE } from '../config';
import { getCached, setCached } from '../utils/cache';
import { getCacheKey, apiGet, apiGetCached, fetchAbsolute } from './client';
import type { UnifiedKline, BackendHistory } from './types';

/** 可选：本地/Render Baostock 历史后端地址（.env 配置 VITE_HISTORY_API） */
const HISTORY_API = (import.meta.env.VITE_HISTORY_API as string) || '';

/** 获取历史 K 线（优先 Baostock 后端；未配置或失败时回退轻量后端，缓存 5 分钟） */
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
      const res = await fetchAbsolute(url, { timeoutMs: 12000 });
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

/** 获取周期可用性策略（失败返回 null，前端回退本地计算） */
export const getPeriodPolicy = async (symbol: string): Promise<PeriodPolicy | null> => {
  try {
    return await apiGet<PeriodPolicy>(`/period-policy/${encodeURIComponent(symbol)}`);
  } catch {
    return null;
  }
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
 * 分钟 K 线（真实多日 OHLCV，直连后端 /api/mkline）：
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

/** 当日分时序列（后端真实分时；date 为交易日日期，供前端按时间窗口制图） */
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
