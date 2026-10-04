// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// API 统一出口（src/api/index.ts）
//   全站唯一 import 入口：`import { getQuote, paperApi } from '../api'`
//   分层：组件层 → src/api/<domain> → src/api/client（唯一 fetch）
//   ⚠️ 组件层禁止裸 fetch；新域请新增 <domain>.ts 并在此 re-export。
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// ============ Client 层（已抽出至 src/api/client.ts） ============
import { ApiError, apiGet, apiGetPublic } from './client';
import { askAssistant } from './assistant';
import { runBacktest } from './backtest';
export { ApiError, apiGet, apiGetPublic };

// ============ 已抽出域：import 供本文件复用 + re-export 保调用方零改动 ============
import { getQuote, getQuotesBatch, getIndices, searchSymbol } from './quote';
import { getHistoryWithMeta, getHistory, getPeriodPolicy, getMinuteKline, getMinuteSeries } from './history';
import { getRecommendations } from './recommend';
import { getDataSourceStatus, forceSwitchDataSource, clearCache, checkBridgeHealth } from './datasource';
export type { UnifiedQuote, UnifiedKline, BackendQuote, BackendHistory } from './types';
export type { HistoryResult, PeriodPolicy, MinuteKline } from './history';
export { getQuote, getQuotesBatch, getIndices, searchSymbol };
export { getHistoryWithMeta, getHistory, getPeriodPolicy, getMinuteKline, getMinuteSeries };
export { getRecommendations };
export { getLastComputedAt } from './runtime';
export type { PaperPosition, PaperOrder, PaperAccount, PaperStrategy, PaperLogEntry, PaperAlert, PaperTriggeredAlert } from './paper';
export { paperApi } from './paper';
export { authApi } from './auth';
export type { InviteEntry } from './auth';
export { getDataSourceStatus, forceSwitchDataSource, clearCache, checkBridgeHealth } from './datasource';
export type { ScreenerRow, ScreenerResult, ScreenerStrategy, MarketMood, WatchItem, TickData } from './screener';
export { screenerApi, moodApi, getTicks, watchlistApi } from './screener';
export type { NewsItem, NewsResponse, NewsHealth } from './news';
export { newsApi, newsHealthApi, feedApi } from './news';
export { askAssistant, aiApi } from './assistant';
export * from './backtest';
export * from './agent';
export * from './research';
export * from './knowledge';

/** 默认导出（兼容旧的 `import dataService from ...` 用法） */
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
