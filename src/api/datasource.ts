// ─────────────────────────────────────────────────────────────
// 数据源域（Data Source）—— 源健康状态 / 缓存清理 / 后端健康检查
//   · 行为零变化：自 src/api/dataService.ts 原样迁出
// ─────────────────────────────────────────────────────────────
import { clearCache as clearMemoryCache } from '../utils/cache';
import { apiGet, getSourceHealth } from './client';

/** 数据源状态 */
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

/** 强制切换（占位） */
export const forceSwitchDataSource = () => {
  /* 单一后端数据源，无需切换 */
};

/** 清理缓存（切换股票时调用，强制更新） */
export const clearCache = () => clearMemoryCache();

/** 后端健康检查 */
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
