// ─────────────────────────────────────────────────────────────
// Agent 团队报告持久化：每次运行保存完整 trace，支持详情查询与历史列表
//   双后端（P3，2026-09-25）：
//   · 有 DATABASE_URL（Vercel/Neon）→ app_reports 表 —— Vercel 只读 FS
//     上 data/agents/*.json 写不进去，报告保存曾静默失败（遗留 L2.1）
//   · 无 DB（本地默认）→ data/agents/reports/{id}.json 完整 trace
//     + data/agents/index.json 轻量索引（原子写入，上限 200 条）
//   · 列表查询双源合并（按 id 去重、ranAt 降序）：本地配 DB 后历史
//     file 报告仍可见（评审建议 4）；DB 失败回落文件，不静默丢数据
//   ⚠️ 全部函数 async：调用方必须 await —— Serverless 响应返回后函数
//     冻结，未 await 的 DB 写入会静默丢失（与 paper 持久化同款教训）。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../atomic-write.cjs');
const db = require('../db.cjs');

const DIR = path.join(__dirname, '..', '..', 'data', 'agents', 'reports');
const INDEX = path.join(__dirname, '..', '..', 'data', 'agents', 'index.json');
const INDEX_MAX = 200;

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

// ── 索引内存缓存（仅文件后端使用）──
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

/** 生成报告 id：日期前缀 + 随机后缀（与文件名/主键同形） */
function newId() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 8);
}

/** 从 trace 抽取索引行（DB 行与文件索引行共用形状） */
function indexRowOf(id, trace) {
  return {
    id,
    uid: trace.uid || 'default',
    symbol: trace.symbol,
    name: trace.name ?? '',
    mode: trace.mode,
    decision: trace.final?.decision ?? '',
    ranAt: trace.ranAt,
  };
}

/** 文件后端：写正文 + 索引（同步 IO，仅本地路径使用） */
function saveToFile(id, trace) {
  ensure();
  writeJsonAtomic(path.join(DIR, `${id}.json`), trace);
  const index = readIndex().slice();
  index.unshift(indexRowOf(id, trace));
  if (index.length > INDEX_MAX) index.length = INDEX_MAX;
  writeIndex(index);
}

/**
 * 保存报告。有 DB → app_reports 表；DB 失败或无 DB → 文件（本地可写，
 * Vercel 只读 FS 上文件路径会失败 → 显式返回 null，不假装成功）。
 * @returns {Promise<string|null>} 报告 id；null = 保存失败（调用方按降级展示）
 */
async function saveReport(trace, uid) {
  const t = trace || {};
  t.uid = uid || 'default';
  const id = newId();
  if (db.hasDb()) {
    try {
      await db.query(
        `INSERT INTO app_reports (id, uid, symbol, name, mode, decision, ran_at, trace)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET trace = EXCLUDED.trace, decision = EXCLUDED.decision`,
        [id, t.uid, String(t.symbol ?? ''), String(t.name ?? ''), String(t.mode ?? ''),
          String(t.final?.decision ?? ''), t.ranAt ? new Date(t.ranAt) : new Date(), JSON.stringify(t)],
      );
      return id;
    } catch (e) {
      console.error('[AgentReportStore] DB 保存失败，回落文件:', e.message?.slice(0, 120));
      // 落到文件路径：本地可写时保住数据；Vercel 只读 FS 会再失败 → 显式 null
    }
  }
  try {
    saveToFile(id, t);
    return id;
  } catch (e) {
    console.error('[AgentReportStore] 保存失败:', e.message);
    return null;
  }
}

/** 读取完整报告：DB 优先，miss/失败回落文件（本地历史报告仍可读） */
async function getReport(id) {
  const clean = String(id || '').replace(/[^a-z0-9-]/gi, '');
  if (!clean) return null;
  if (db.hasDb()) {
    try {
      const r = await db.query('SELECT trace FROM app_reports WHERE id = $1', [clean]);
      if (r.rows[0]?.trace) return r.rows[0].trace;
    } catch (e) {
      console.error('[AgentReportStore] DB 读取失败，尝试文件:', e.message?.slice(0, 120));
    }
  }
  try {
    const file = path.join(DIR, `${clean}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 历史列表：DB 行 + 文件索引双源合并（按 id 去重、ranAt 降序） */
async function listReports({ symbol, limit = 20, uid } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const merged = [];
  const seen = new Set();
  const push = (row) => {
    if (!row || !row.id || seen.has(row.id)) return;
    seen.add(row.id);
    merged.push(row);
  };
  if (db.hasDb()) {
    try {
      const params = [];
      const conds = [];
      if (uid) { params.push(uid); conds.push(`uid = $${params.length}`); }
      if (symbol) { params.push(symbol); conds.push(`(symbol = $${params.length} OR name = $${params.length})`); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const r = await db.query(
        `SELECT id, uid, symbol, name, mode, decision, ran_at FROM app_reports ${where} ORDER BY created_at DESC LIMIT ${lim}`,
        params,
      );
      for (const row of r.rows) {
        push({
          id: row.id, uid: row.uid, symbol: row.symbol, name: row.name,
          mode: row.mode, decision: row.decision, ranAt: row.ran_at,
        });
      }
    } catch (e) {
      console.error('[AgentReportStore] DB 列表失败，用文件索引兜底:', e.message?.slice(0, 120));
    }
  }
  // 文件索引兜底/合并（本地历史报告在配 DB 后仍可见）
  try {
    ensure();
    let index = readIndex();
    if (uid) index = index.filter((x) => (x.uid || 'admin') === uid); // 历史无主报告归属 admin
    if (symbol) index = index.filter((x) => x.symbol === symbol || x.name === symbol);
    for (const x of index) push(x);
  } catch { /* 文件索引不可用时仅返回 DB 结果 */ }
  merged.sort((a, b) => String(b.ranAt || '').localeCompare(String(a.ranAt || '')));
  return merged.slice(0, lim);
}

/** 删除报告（仅归属人可删；DB 行与遗留文件同步清理）。返回 { ok } 或 { ok:false, error } */
async function deleteReport(id, uid) {
  try {
    const clean = String(id || '').replace(/[^a-z0-9-]/gi, '');
    if (!clean) return { ok: false, error: '无效的报告编号' };
    const report = await getReport(clean);
    if (!report) return { ok: false, error: '报告不存在或已删除' };
    const owner = report.uid || 'admin'; // 历史无主报告归属 admin
    if (owner !== uid) return { ok: false, error: '无权删除他人的报告' };
    let deleted = false;
    if (db.hasDb()) {
      try {
        const r = await db.query('DELETE FROM app_reports WHERE id = $1', [clean]);
        deleted = (r.rowCount || 0) > 0;
      } catch (e) {
        console.error('[AgentReportStore] DB 删除失败:', e.message?.slice(0, 120));
      }
    }
    try {
      const file = path.join(DIR, `${clean}.json`);
      if (fs.existsSync(file)) { fs.unlinkSync(file); deleted = true; }
    } catch { /* 文件可能已不存在 */ }
    writeIndex(readIndex().filter((x) => x.id !== clean));
    if (!deleted) return { ok: false, error: '报告不存在或已删除' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '删除失败: ' + String(e?.message || e).slice(0, 60) };
  }
}

module.exports = { saveReport, getReport, listReports, deleteReport };
