// ─────────────────────────────────────────────────────────────
// 全局配置（集中管理环境变量与常量）
// ─────────────────────────────────────────────────────────────

/** 后端数据服务地址（同源 /api：生产模式由 server/index.cjs 直接提供，开发模式经 vite proxy 转发） */
export const API_BASE_PATH: string = (import.meta.env.VITE_API_BASE_PATH as string) || '/api';

/** 实时轮询间隔（毫秒） */
export const POLL_INTERVAL: number = Number(import.meta.env.VITE_POLL_INTERVAL) || 10_000;

/** 大盘指数轮询间隔（毫秒） */
export const INDEX_REFRESH_MS: number = Number(import.meta.env.VITE_INDEX_REFRESH_MS) || 10_000;

/** 实时小图窗口点数 */
export const REALTIME_MAX_POINTS: number = Number(import.meta.env.VITE_REALTIME_MAX_POINTS) || 120;

/** 数据缓存 TTL（毫秒） */
export const CACHE_TTL: number = Number(import.meta.env.VITE_CACHE_TTL) || 30_000;

/** 请求超时（毫秒） */
export const REQUEST_TIMEOUT: number = Number(import.meta.env.VITE_REQUEST_TIMEOUT) || 30_000;

/** 默认股票 */
export const DEFAULT_SYMBOL: string = 'MSFT';
export const DEFAULT_MARKET: 'US' | 'CN' | 'HK' = 'US';

/** 今日推荐数量 */
export const RECOMMEND_COUNT: number = 6;

/** 功能配置标记 */
export const FEATURES = {
  enablePolling: true,
  enableCache: true,
} as const;

/** 环境变量校验：启动时检查必要配置，缺失时给出警告 */
export function validateEnv(): void {
  const missing: string[] = [];
  if (!API_BASE_PATH) missing.push('VITE_API_BASE_PATH');
  if (import.meta.env.DEV && missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[config] 缺少环境变量: ${missing.join(', ')}，将使用默认值`);
  }
}
