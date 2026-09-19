// ─────────────────────────────────────────────────────────────
// 本地 K 线归档读取层（Baostock 同步脚本产出 data/history/kline/{code}.json）
//   · 用途：上游行情全挂时 /api/history 的本地兜底（显式标注 source/stale）
//   · 口径：归档为不复权价 + 复权因子（sync_baostock.py），此处透传不复权
//   · mtime 感知缓存：同步脚本写入后自动失效，无需重启
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DIR = process.env.LOCAL_HISTORY_DIR || path.join(__dirname, '..', 'data', 'history', 'kline');
const cache = new Map(); // file -> { mtime, doc }（LRU：超上限丢最旧）

function loadDoc(file) {
  const st = fs.statSync(file);
  let entry = cache.get(file);
  if (!entry || entry.mtime !== st.mtimeMs) {
    entry = { mtime: st.mtimeMs, doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
    cache.set(file, entry);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return entry.doc;
}

/**
 * 读本地归档日线（不复权）
 * @returns rows | null（无归档/读失败一律 null，调用方继续走上游）
 */
function getLocalKline(code, count = 500) {
  try {
    const doc = loadDoc(path.join(DIR, `${code}.json`));
    const rows = (doc.rows || [])
      .filter((r) => r.date && Number.isFinite(r.close))
      .map((r) => ({ date: r.date, open: r.open, close: r.close, high: r.high, low: r.low, volume: r.volume }));
    return rows.slice(-count);
  } catch {
    return null;
  }
}

/** 归档覆盖情况（自检/数据质量报告用） */
function localArchiveInfo() {
  try {
    return { count: fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).length };
  } catch {
    return { count: 0 };
  }
}

module.exports = { getLocalKline, localArchiveInfo };
