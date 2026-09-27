// ─────────────────────────────────────────────────────────────
// 全局配置（集中管理环境变量与常量）
// ─────────────────────────────────────────────────────────────

/** 后端数据服务地址（同源 /api：生产模式由 server/index.cjs 或 Python 后端直接提供，开发模式经 vite proxy 转发） */
export const API_BASE_PATH: string = (import.meta.env.VITE_API_BASE_PATH as string) || '/api';

/**
 * 后端模式（数据源架构）：
 *   · node   —— 服务端一体化后端（自托管 / 公网演示版）
 *   · python —— Python+Flask 后端（历史=Baostock 主源，实时=Ashare 辅助源，
 *               SQLite 24h 缓存 + 单用户限流 + 定时更新；本地/服务器部署推荐）
 * 前端不感知具体数据源，仅按模式选择聚合接口。
 */
export const BACKEND_MODE: 'python' | 'node' =
  (import.meta.env.VITE_BACKEND as 'python' | 'node') === 'python' ? 'python' : 'node';

/** 运行时环境：本地（自己的机器，无配额约束，满配轮询）vs 公网（Vercel，流体主动 CPU 4h/月 配额）。
 *  同一份 dist 两处运行——按 hostname 运行时判断，而不是构建时变量。 */
export const IS_LOCAL_RUNTIME =
  typeof location !== 'undefined' &&
  /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);

/** 实时轮询间隔（毫秒）。
 *  本地与公网盘中均 10s（用户 2026-09-27 确认：朋友们基本不常用，实测月 CPU 仅 9分钟/4小时配额，
 *  无需降配——30s 会拖累盯盘体验）。仅休市（周末/夜间）自适应拉长到 60s：
 *  休市期间行情完全不变，轮询纯属浪费，拉长无任何体验损失。 */
export function pollInterval(): number {
  if (IS_LOCAL_RUNTIME) return Number(import.meta.env.VITE_POLL_INTERVAL) || 10_000;
  const d = new Date();
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const h = d.getHours();
  const tradingHours = !weekend && ((h >= 9 && h < 12) || (h >= 13 && h < 15));
  return tradingHours ? 10_000 : 60_000;
}

/** 大盘指数轮询间隔（毫秒）——与 pollInterval 同一口径 */
export function indexRefreshMs(): number {
  return pollInterval();
}

/** 实时小图窗口点数 */
export const REALTIME_MAX_POINTS: number = Number(import.meta.env.VITE_REALTIME_MAX_POINTS) || 120;

/** 数据缓存 TTL（毫秒）——按数据类型分级限流（合规：降低数据源请求压力） */
export const CACHE_TTL: number = Number(import.meta.env.VITE_CACHE_TTL) || 30_000;

/** 实时报价缓存 10 秒（10s 内重复请求同一股票直接返回缓存） */
export const CACHE_TTL_QUOTE: number = Number(import.meta.env.VITE_CACHE_TTL_QUOTE) || 10_000;

/** 大盘指数缓存 15 秒 */
export const CACHE_TTL_INDICES: number = Number(import.meta.env.VITE_CACHE_TTL_INDICES) || 15_000;

/** 历史 K 线缓存 5 分钟（切换股票或强制刷新时更新） */
export const CACHE_TTL_HISTORY: number = Number(import.meta.env.VITE_CACHE_TTL_HISTORY) || 300_000;

/** 分钟 K 线缓存 60 秒 */
export const CACHE_TTL_MKLINE: number = Number(import.meta.env.VITE_CACHE_TTL_MKLINE) || 60_000;

/** 搜索缓存 60 秒 */
export const CACHE_TTL_SEARCH: number = Number(import.meta.env.VITE_CACHE_TTL_SEARCH) || 60_000;

/** 请求超时（毫秒） */
export const REQUEST_TIMEOUT: number = Number(import.meta.env.VITE_REQUEST_TIMEOUT) || 30_000;

/** 默认股票 */
export const DEFAULT_SYMBOL: string = 'MSFT';
export const DEFAULT_MARKET: 'US' | 'CN' | 'HK' = 'US';

/** 今日观察数量 */
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
