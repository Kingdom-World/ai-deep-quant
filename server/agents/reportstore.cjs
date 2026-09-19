// ─────────────────────────────────────────────────────────────
// Agent 团队报告持久化：每次运行保存完整 trace，支持详情查询与历史列表
//   · data/agents/reports/{id}.json —— 完整 trace
//   · data/agents/index.json —— 轻量索引（列表页用，原子写入，上限 200 条）
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../atomic-write.cjs');

const DIR = path.join(__dirname, '..', '..', 'data', 'agents', 'reports');
const INDEX = path.join(__dirname, '..', '..', 'data', 'agents', 'index.json');
const INDEX_MAX = 200;

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

// ── 索引内存缓存 ──
// 原实现每次保存报告、每次列表查询都要 readFileSync + JSON.parse 整个 index.json，
// 并 writeJsonAtomic 全量回写；报告累积后成为一条 O(n) 同步 IO 热路径。
// 索引只有本进程会写，因此加载一次常驻内存即可，写时同步更新缓存。
let indexCache = null;

/** 读取索引（首次从磁盘加载，之后走内存缓存） */
function readIndex() {
  if (indexCache) return indexCache;
  try {
    if (fs.existsSync(INDEX)) {
      const parsed = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
      indexCache = Array.isArray(parsed) ? parsed : [];
    } else {
      indexCache = [];
    }
  } catch {
    indexCache = []; // 索引损坏：以空索引继续，正文报告文件仍在，可重建
  }
  return indexCache;
}

/** 写入索引（原子落盘 + 同步内存缓存） */
function writeIndex(next) {
  indexCache = next;
  writeJsonAtomic(INDEX, next, true);
}

function saveReport(trace, uid) {
  try {
    ensure();
    trace.uid = uid || 'default';
    const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 8);
    const file = path.join(DIR, `${id}.json`);
    writeJsonAtomic(file, trace);
    // 索引
    const index = readIndex().slice();
    index.unshift({
      id,
      uid: trace.uid,
      symbol: trace.symbol,
      name: trace.name ?? '',
      mode: trace.mode,
      decision: trace.final?.decision ?? '',
      ranAt: trace.ranAt,
    });
    if (index.length > INDEX_MAX) index.length = INDEX_MAX;
    writeIndex(index);
    return id;
  } catch (e) {
    console.error('[AgentReportStore] 保存失败:', e.message);
    return null;
  }
}

function getReport(id) {
  try {
    const file = path.join(DIR, `${String(id).replace(/[^a-z0-9-]/gi, '')}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listReports({ symbol, limit = 20, uid } = {}) {
  try {
    ensure();
    let index = readIndex();
    if (uid) index = index.filter((x) => (x.uid || 'admin') === uid); // 历史无主报告归属 admin
    if (symbol) index = index.filter((x) => x.symbol === symbol || x.name === symbol);
    return index.slice(0, Math.min(Math.max(limit, 1), 100));
  } catch {
    return [];
  }
}

/** 删除报告（仅归属人可删；同步清理索引）。返回 { ok } 或 { ok:false, error } */
function deleteReport(id, uid) {
  try {
    ensure();
    const clean = String(id).replace(/[^a-z0-9-]/gi, '');
    if (!clean) return { ok: false, error: '无效的报告编号' };
    const report = getReport(clean);
    if (!report) return { ok: false, error: '报告不存在或已删除' };
    const owner = report.uid || 'admin'; // 历史无主报告归属 admin
    if (owner !== uid) return { ok: false, error: '无权删除他人的报告' };
    // 删正文文件
    const file = path.join(DIR, `${clean}.json`);
    try { fs.unlinkSync(file); } catch { /* 文件可能已不存在 */ }
    // 同步索引（原子写 + 更新内存缓存）
    writeIndex(readIndex().filter((x) => x.id !== clean));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '删除失败: ' + String(e?.message || e).slice(0, 60) };
  }
}

module.exports = { saveReport, getReport, listReports, deleteReport };
