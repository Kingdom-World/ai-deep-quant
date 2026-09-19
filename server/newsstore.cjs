// ─────────────────────────────────────────────────────────────
// 本地资讯快照：只保留近三天的有限字段，避免历史文件无限增长
//   · 支撑上游全部不可用时回看本地快照
//   · 记录 source / symbols，供个股关联检索与来源标注
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.cjs');

const DATA_DIR = path.join(__dirname, '..', 'data', 'news');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const WINDOW_MS = 3 * 24 * 3600 * 1000;
const MAX_ITEMS = 900; // 多源扩容后上调，保证市场要闻覆盖度
const MAX_TITLE = 180;
const MAX_SNIPPET = 240;

let items = [];
let loaded = false;

function parseTime(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : 0;
}

/** 标题指纹：跨源同题去重（同一事件多家媒体报道） */
function titleKey(title) {
  return String(title || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 40);
}

function normalize(item) {
  const publishedAt = String(item?.publishedAt || item?.date || '');
  const publishedMs = parseTime(publishedAt);
  const url = String(item?.url || '').trim();
  const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
  const media = String(item?.media || item?.source || '').trim();
  if (!title || !media || !url || !publishedMs) return null;
  const symbols = Array.isArray(item?.symbols) ? item.symbols.map((s) => String(s).toLowerCase()).filter(Boolean).slice(0, 20) : [];
  const own = String(item?.symbol || '').toLowerCase();
  return {
    id: `${media}:${url}`.slice(0, 500),
    title: title.slice(0, MAX_TITLE),
    snippet: String(item?.snippet || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET),
    media: media.slice(0, 80),
    url: url.slice(0, 1000),
    publishedAt: new Date(publishedMs).toISOString(),
    date: new Date(publishedMs).toISOString().slice(0, 10),
    category: String(item?.category || 'market').slice(0, 30),
    sourceType: item?.sourceType === 'official' ? 'official' : 'public-media',
    symbol: own.slice(0, 30),
    symbols: symbols.length ? symbols : own ? [own] : [],
    source: String(item?.source || '').slice(0, 40),
    fetchedAt: String(item?.fetchedAt || new Date().toISOString()),
  };
}

function prune(input, now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  const byId = new Map();
  for (const raw of input || []) {
    const item = normalize(raw);
    if (!item || parseTime(item.publishedAt) < cutoff) continue;
    byId.set(item.id, item);
  }
  // 标题指纹二次去重：同一事件只留一条（保留有摘要的）
  const byTitle = new Map();
  for (const item of byId.values()) {
    const key = titleKey(item.title) || item.id;
    const prev = byTitle.get(key);
    if (!prev || (item.snippet && !prev.snippet)) byTitle.set(key, item);
  }
  return [...byTitle.values()]
    .sort((a, b) => parseTime(b.publishedAt) - parseTime(a.publishedAt))
    .slice(0, MAX_ITEMS);
}

function init() {
  if (loaded) return;
  loaded = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      items = prune(saved?.items);
    }
  } catch {
    items = [];
  }
}

function save(next) {
  items = prune(next);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeJsonAtomic(SNAPSHOT_FILE, { updatedAt: new Date().toISOString(), items }, false);
  } catch {
    // 本地只读文件系统时仍保留内存快照
  }
  return items;
}

function merge(next) {
  init();
  return save([...next, ...items]);
}

function list({ category, symbol, limit = 60 } = {}) {
  init();
  items = prune(items);
  const sym = String(symbol || '').toLowerCase();
  const rows = items.filter(
    (item) => (!category || item.category === category) && (!sym || item.symbol === sym || (item.symbols || []).includes(sym)),
  );
  return rows.slice(0, Math.min(Math.max(Number(limit) || 60, 1), 300));
}

function snapshotInfo() {
  init();
  const byCategory = {};
  for (const it of items) byCategory[it.category] = (byCategory[it.category] || 0) + 1;
  return {
    updatedAt: items.length ? items.reduce((max, x) => (x.fetchedAt > max ? x.fetchedAt : max), '') : null,
    count: items.length,
    byCategory,
  };
}

module.exports = { init, merge, list, prune, snapshotInfo, titleKey, WINDOW_MS };
