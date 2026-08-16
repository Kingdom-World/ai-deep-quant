// ─────────────────────────────────────────────────────────────
// 统一内存缓存工具（数据请求限流用）
//   · 全局 Map 存储，按 key + TTL 管理
//   · 命中时输出 [Cache] 日志（便于验证限流生效）
//   · 与后端缓存互补：后端缓存防跨用户重复，本缓存防本端重复请求
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * 读取缓存；TTL 内命中返回数据（并打印日志），否则返回 null
 */
export function getCached<T>(key: string, ttlMs: number): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < ttlMs) {
    const age = Math.round((Date.now() - entry.timestamp) / 1000);
    // eslint-disable-next-line no-console
    console.log(`[Cache] 使用缓存数据: ${key}（${age}s 前写入，TTL ${Math.round(ttlMs / 1000)}s）`);
    return entry.data as T;
  }
  return null;
}

/** 写入缓存 */
export function setCached(key: string, data: unknown): void {
  cache.set(key, { data, timestamp: Date.now() });
}

/** 是否存在有效缓存（不写日志） */
export function hasCached(key: string, ttlMs: number): boolean {
  const entry = cache.get(key);
  return !!entry && Date.now() - entry.timestamp < ttlMs;
}

/** 强制失效指定 key */
export function invalidateCached(key: string): void {
  cache.delete(key);
}

/** 清空全部缓存（切换股票 / 强制刷新时调用） */
export function clearCache(): void {
  cache.clear();
}

/** 当前缓存条目数（数据源状态展示用） */
export function getCacheSize(): number {
  return cache.size;
}
