// ─────────────────────────────────────────────────────────────
// 资讯域（News）—— 多源聚合资讯 / 源健康度 / 看板数据面板
//   · 数据源：后端 /api/news、/api/news/health、/api/feed/:symbol
//   · 行为零变化：自 src/api/dataService.ts 原样迁出
// ─────────────────────────────────────────────────────────────
import { apiGet } from './client';

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

/** 看板数据面板（资金流 / 财务 / 估值 / 新闻，东方财富公开接口，缺失自动为 null） */
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
