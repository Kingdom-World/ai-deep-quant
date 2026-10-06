// ─────────────────────────────────────────────────────────────
// API Client —— 唯一 fetch 封装（M1 API 分层 · 第一刀）
//   · 职责：basePath / 超时 / credentials 策略 / ApiError 规范化 / 请求去重 /
//     数据源健康标记。**本层之上所有域模块禁止直接 fetch**。
//   · 行为零变化：全部逻辑自 src/api/dataService.ts 原样抽出（含 PUBLIC 路径规则、
//     缓存 TTL 语义、错误文案）。调用方零改动（dataService 保留 re-export shim）。
// ─────────────────────────────────────────────────────────────
import {
  CACHE_TTL_QUOTE,
  CACHE_TTL_INDICES,
  CACHE_TTL_HISTORY,
  CACHE_TTL_MKLINE,
  CACHE_TTL_SEARCH,
  REQUEST_TIMEOUT,
} from '../config';
import { getCacheSize, getCached, setCached } from '../utils/cache';

// ============ 配置 ============
export const CONFIG = {
  /** 后端 API 基础路径（同源 /api：生产由服务端提供，开发经 vite proxy） */
  basePath: '/api',
  /** 请求超时 */
  timeout: REQUEST_TIMEOUT,
  /** 是否启用缓存 */
  enableCache: true,
};

/** 缓存 key 规范化（类型 + 参数序列化） */
export const getCacheKey = (type: string, params: unknown): string => `${type}:${JSON.stringify(params)}`;

/** 缓存 TTL 汇总（域模块从此处取，不各自复制常量） */
export const TTL = {
  quote: CACHE_TTL_QUOTE,
  indices: CACHE_TTL_INDICES,
  history: CACHE_TTL_HISTORY,
  mkline: CACHE_TTL_MKLINE,
  search: CACHE_TTL_SEARCH,
};

// ============ 错误 ============
/**
 * 带 HTTP 状态与结构化响应体的错误。
 * 用于后端「因档位/运行时不可用而拒绝」的场景（403/503）：这类拒绝不是故障，
 * 而是**能力边界声明**，UI 必须能读到 tier / availableTiers 才能给出正确指引。
 */
export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
  /** 从任意异常里取出后端结构化体（非 ApiError 返回 null） */
  static bodyOf(e: unknown): any {
    return e instanceof ApiError ? e.body : null;
  }
}

// ============ 请求去重（相同 in-flight 请求合并） ============
const inFlight = new Map<string, Promise<unknown>>();

/** 公共行情端点前缀（与后端 PUBLIC_API_PREFIXES 白名单一致）：不带 Cookie 发送，
 *  无 Cookie 请求才能吃到 Vercel CDN 边缘缓存（s-maxage），20 人轮询在边缘合并、不烧函数 CPU。
 *  这些端点返回公开市场数据、无个体差异，omit 凭证无任何功能影响。
 *  🔴 纪律：能进这个列表的端点，其响应必须**与访问者身份无关** —— 否则边缘缓存会把
 *     有权限者的响应喂给无权限者（模型分享的 /shared/ 就因此绝不能进白名单）。 */
export const PUBLIC_PATH_PREFIXES = [
  '/indices', '/mood', '/quote/', '/quotes?', '/minute/', '/sectors/', '/news?',
  // 模型公开广场（只列已过审的公开示例；内容与身份无关）
  '/models/public',
];
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) => path.startsWith(p));
}

// ============ 数据源健康（真实记录，替代此前"永远健康"的假状态） ============
const sourceHealth = { lastSuccessAt: 0, lastFailureAt: 0, failCount: 0 };
export function markSourceOk() {
  sourceHealth.lastSuccessAt = Date.now();
  sourceHealth.failCount = 0;
}
export function markSourceFail() {
  sourceHealth.lastFailureAt = Date.now();
  sourceHealth.failCount += 1;
}
/** 数据源健康快照（数据源状态面板用；cacheSize 一并从缓存工具取） */
export function getSourceHealth() {
  return {
    lastSuccessAt: sourceHealth.lastSuccessAt,
    lastFailureAt: sourceHealth.lastFailureAt,
    failCount: sourceHealth.failCount,
    cacheSize: getCacheSize(),
  };
}

// ============ 基础请求 ============
/** 基础 GET（相对路径 /api，经 vite proxy 或同源到后端）
 *  opts.omitCredentials：强制不带凭证；公共行情路径（isPublicPath）自动 omit。 */
export async function apiGet<T>(path: string, opts?: { omitCredentials?: boolean }): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
  try {
    const res = await fetch(`${CONFIG.basePath}${path}`, {
      signal: controller.signal,
      credentials: opts?.omitCredentials || isPublicPath(path) ? 'omit' : 'same-origin',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `后端接口 HTTP ${res.status}`);
    }
    markSourceOk();
    return (await res.json()) as T;
  } catch (e: any) {
    markSourceFail();
    if (e?.name === 'AbortError') {
      throw new Error('请求超时（请确认已启动数据服务）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 公共行情请求：不带凭证（吃边缘缓存），仅用于后端公开行情白名单内的只读端点 */
export const apiGetPublic = <T>(path: string): Promise<T> => apiGet<T>(path, { omitCredentials: true });

/**
 * 带超时/外部取消信号的 GET（如 AI 问答长请求 75s、Agent 流水线）。
 * 与 apiGet 的区别：可自定义 timeoutMs 与 timeoutMessage，并支持外部 AbortSignal 联动。
 */
export async function apiGetTimed<T>(
  path: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; timeoutMessage?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CONFIG.timeout);
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Aborted', 'AbortError');
    }
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(`${CONFIG.basePath}${path}`, { signal: controller.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error((err as { error?: string })?.error || `后端接口 HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new Error(opts.timeoutMessage || '请求超时（请确认已启动数据服务）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** POST 请求（模拟盘下单/撤单/重置/策略启停）
 *  opts.timeoutMs：个别慢端点（如 Agent 流水线）单独放宽——全局 30s 预算对它们是假性故障
 *  （GUI 检查 Bug2：Agent 完整模式公网耗时 >30s，前端先断，报"请求超时（请确认已启动数据服务）"） */
export async function apiPost<T>(
  path: string,
  body: unknown,
  opts?: { timeoutMs?: number; timeoutMessage?: string },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? CONFIG.timeout);
  try {
    const res = await fetch(`${CONFIG.basePath}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      // 后端在 403/503 时会带回结构化信息（tier / availableTiers），
      // 前端据此给出「该用哪个档位」的可操作提示，而不是笼统一句失败。
      // 挂在 ApiError 上而非塞进 message 字符串，避免调用方反解析文案。
      throw new ApiError((err as { error?: string })?.error || `后端接口 HTTP ${res.status}`, res.status, err);
    }
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new Error(opts?.timeoutMessage || '请求超时（请确认已启动数据服务）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 绝对 URL GET（可选外部后端，如 VITE_HISTORY_API 指向的 Baostock 服务）。
 *  返回原始 Response，由调用方决定非 2xx 的处理——与 /api 主链路的抛错语义不同：
 *  该路径失败时是"静默回退轻量后端"，不是请求失败。 */
export async function fetchAbsolute(url: string, opts: { timeoutMs?: number } = {}): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? CONFIG.timeout) });
}

/** DELETE 请求（告警删除等资源移除） */
export async function apiDelete<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
  try {
    const res = await fetch(`${CONFIG.basePath}${path}`, { method: 'DELETE', signal: controller.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error((err as { error?: string })?.error || `后端接口 HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new Error('请求超时（请确认已启动数据服务）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带缓存 + 去重的 GET（TTL 内命中直接返回缓存，不发起网络请求）
 */
export async function apiGetCached<T>(key: string, path: string, ttlMs: number): Promise<T> {
  if (CONFIG.enableCache) {
    const cached = getCached<T>(key, ttlMs);
    if (cached !== null) return cached;
  }

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const p = apiGet<T>(path).then((data) => {
    if (CONFIG.enableCache) setCached(key, data);
    return data;
  });
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}
