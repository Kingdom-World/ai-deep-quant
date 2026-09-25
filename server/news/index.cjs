'use strict';
// ─────────────────────────────────────────────────────────────
// 资讯编排层：多源拉取 → 去重 → 个股精准匹配 → 缓存
//   对外暴露 getMarketNews / getStockNews / getSymbolName / getHealth
// ─────────────────────────────────────────────────────────────
const sources = require('./sources.cjs');
const matcher = require('./matcher.cjs');

const nameCache = new Map(); // symbol -> { name, ts }
const NAME_TTL = 7 * 24 * 3600 * 1000;
const stockCache = new Map(); // symbol -> { ts, items }
const STOCK_TTL = 3 * 60_000;
const marketCache = { ts: 0, items: [] };
const MARKET_TTL = 2 * 60_000;

// 容量上限：这两个 Map 按 symbol 累积，TTL 只决定"是否新鲜"、并不负责回收，
// 长期运行（尤其公网被爬）会无界增长。超限时先清过期项，再按插入序淘汰最早的。
const MAX_NAME_CACHE = 5000;
const MAX_STOCK_CACHE = 500;
function pruneMap(map, max, ttl) {
  if (map.size < max) return;
  const now = Date.now();
  for (const [k, v] of map) {
    if (now - (v?.ts || 0) > ttl) map.delete(k);
  }
  let over = map.size - max;
  if (over <= 0) return;
  for (const k of map.keys()) {
    map.delete(k);
    if (--over <= 0) break;
  }
}

/** 解析证券简称（缓存 7 天，失败时返回空串由匹配层降级为纯代码匹配） */
async function getSymbolName(symbol) {
  const key = String(symbol || '').toLowerCase();
  const hit = nameCache.get(key);
  if (hit && Date.now() - hit.ts < NAME_TTL) return hit.name;
  const name = (await sources.resolveName(key)) || '';
  if (name) {
    pruneMap(nameCache, MAX_NAME_CACHE, NAME_TTL);
    nameCache.set(key, { name, ts: Date.now() });
  }
  return name;
}

function dedupe(items) {
  const seen = new Map();
  for (const it of items || []) {
    const key = matcher.titleKey(it.title) || it.url;
    const prev = seen.get(key);
    // 同一事件保留信息更完整的那条（有摘要优先）
    if (!prev || (it.snippet && !prev.snippet)) seen.set(key, it);
  }
  return [...seen.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** 市场要闻：东财 7x24 分页快讯（主力，单页 100 条）+ 新浪财经滚动 + 新浪 7x24 直播（备用集群，互为兜底） */
async function getMarketNews({ pages = 3, force = false } = {}) {
  if (!force && marketCache.items.length && Date.now() - marketCache.ts < MARKET_TTL) {
    return marketCache.items;
  }
  const [flash, sina, zhibo] = await Promise.all([
    sources.fetchMarketFlash(pages, 100),
    sources.fetchSinaRoll(50),
    sources.fetchSinaZhiboRoll(50),
  ]);
  const merged = dedupe([...flash, ...sina, ...zhibo]);
  if (merged.length) {
    marketCache.ts = Date.now();
    marketCache.items = merged;
  }
  return merged.length ? merged : marketCache.items;
}

/**
 * 个股资讯：官方挂载接口 + 名称/代码双路召回 + 市场要闻上游标注，统一交由匹配引擎打分
 * @returns {{ profile:Object, items:Array }}
 */
async function getStockNews(symbol, { limit = 60, force = false } = {}) {
  const key = String(symbol || '').toLowerCase();
  if (!key) return { profile: null, items: [] };
  const cached = stockCache.get(key);
  if (!force && cached && Date.now() - cached.ts < STOCK_TTL) {
    return { profile: cached.profile, items: cached.items.slice(0, limit) };
  }

  const name = await getSymbolName(key);
  const profile = matcher.buildProfile(key, name);
  const digits = profile.digits;

  const [official, byName, byCode, flash] = await Promise.all([
    sources.fetchEmStockNews(key, 2, 20),
    name ? sources.fetchEmSearch(name, 20) : Promise.resolve([]),
    sources.fetchEmSearch(digits, 20),
    getMarketNews({ pages: 2 }),
  ]);

  const pool = [...official, ...byName, ...byCode, ...(flash || [])];
  const items = matcher.matchForSymbol(pool, profile, { minScore: 0.45, limit });
  pruneMap(stockCache, MAX_STOCK_CACHE, STOCK_TTL);
  stockCache.set(key, { ts: Date.now(), profile, items });
  return { profile, items };
}

/** 数据源健康度：用于运维观测与降级提示 */
function getHealth() {
  return {
    sources: sources.healthSnapshot(),
    marketCacheAge: marketCache.ts ? Date.now() - marketCache.ts : null,
    marketCached: marketCache.items.length,
    stockCacheKeys: stockCache.size,
  };
}

module.exports = { getMarketNews, getStockNews, getSymbolName, getHealth, dedupe, sources, matcher };
