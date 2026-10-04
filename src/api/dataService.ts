// ─────────────────────────────────────────────────────────────
// 统一数据服务层（迁移中·兼容层）
//   全部域已抽至 src/api/<domain>.ts；本文件保留 re-export 与旧 import 路径
//   `../api/dataService`，待调用点全部改指 src/api 后删除。
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
