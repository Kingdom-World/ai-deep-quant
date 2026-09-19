// ─────────────────────────────────────────────────────────────
// 自选股池（融合自 tick-stock-panel/TSP 自选模块思路）
//   · 每用户独立池（uid 隔离），持久化 data/watchlist.json（原子写）
//   · 上限 50 只，存 symbol/name/行业备注/添加时间
//   · 行情由前端复用统一报价接口逐只刷新（首页卡片）
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.cjs');

const FILE = path.join(__dirname, '..', 'data', 'watchlist.json');
const MAX = 50;

let store = {}; // { [uid]: [{symbol, name, note, addedAt}] }

function load() {
  try {
    if (fs.existsSync(FILE)) store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error('[Watchlist] 加载失败:', e.message);
    store = {};
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    writeJsonAtomic(FILE, store, true);
  } catch (e) {
    console.error('[Watchlist] 持久化失败:', e.message);
  }
}

function list(uid) {
  return store[uid] ?? [];
}

/** 添加（存在即幂等返回 ok）；symbol 自动归一为小写带前缀由前端保证 */
function add(uid, { symbol, name, note }) {
  symbol = String(symbol || '').trim().toLowerCase();
  if (!symbol) return { ok: false, error: '缺少股票代码' };
  const pool = (store[uid] ??= []);
  if (pool.some((w) => w.symbol === symbol)) return { ok: true, symbol, existed: true };
  if (pool.length >= MAX) return { ok: false, error: `自选池已满（上限 ${MAX} 只）` };
  const item = { symbol, name: name || symbol, note: note || '', addedAt: new Date().toISOString() };
  pool.unshift(item);
  save();
  return { ok: true, item };
}

function remove(uid, symbol) {
  symbol = String(symbol || '').trim().toLowerCase();
  const pool = store[uid] ?? [];
  const i = pool.findIndex((w) => w.symbol === symbol);
  if (i < 0) return { ok: false, error: '不在自选池中' };
  pool.splice(i, 1);
  save();
  return { ok: true };
}

function has(uid, symbol) {
  return (store[uid] ?? []).some((w) => w.symbol === String(symbol || '').trim().toLowerCase());
}

module.exports = { load, save, list, add, remove, has };
