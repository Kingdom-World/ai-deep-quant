'use strict';
// ─────────────────────────────────────────────────────────────
// 模型实验记录（Phase 1 模型工坊）
//
//   与 model_store 的分工：
//     · model_store = **可变的模型定义**（用户随时改）
//     · 本模块     = **不可变的实验留痕**（复现承诺的载体：同指纹 ⇒ 同结果）
//   与 server/experiments.cjs（策略回测实验）的分工：
//     那个按 symbol/strategy 组织、无 uid、jsonl 追加；
//     本模块按 uid 隔离、以 **模型指纹** 为纲、含模型计划快照与 IC 指标。
//
//   🔴 与前端对比逻辑的兼容约定（不满足则 shared/experiments.mjs 直接失效）：
//     记录必须带 `ts`（ISO，唯一键）与**扁平** `params`（paramKeyUnion/diffParams 只做
//     一层 Object.keys）——所以 params 里的人类可读摘要（因子/预处理/过滤）都压成字符串。
//
//   安全与配额：同 modelstore——行级所有权（越权按不存在处理）+ 每 uid 上限。
//   ⚠️ 全部函数 async，调用方必须 await。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.cjs');
const db = require('./db.cjs');

const DIR = process.env.MODEL_EXP_DIR || path.join(__dirname, '..', 'data', 'model-experiments');
const INDEX = path.join(DIR, 'index.json');
const INDEX_MAX = 5000;
/** 每 uid 实验条数上限（超出时最旧的会被轮转删除，与"不可变"不冲突：删的是整条记录） */
const QUOTA_PER_UID = Number(process.env.MODEL_EXP_QUOTA) || 200;
const MAX_DOC_BYTES = 256 * 1024;
const ID_RE = /^x-\d{8}-[a-z0-9]{6}$/;

/** 净值曲线降采样点数（存档足够看趋势，又不至于让存储膨胀） */
const THUMB_POINTS = 120;

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

let indexCache = null;
function readIndex() {
  if (indexCache) return indexCache;
  try {
    const parsed = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : [];
    indexCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    indexCache = [];
  }
  return indexCache;
}
function writeIndex(next) {
  indexCache = next;
  writeJsonAtomic(INDEX, next, true);
}

function newId() {
  return 'x-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 8);
}

const normalizeUid = (uid) => String(uid || 'default').slice(0, 120);
const byTsDesc = (a, b) => String(b.ts || '').localeCompare(String(a.ts || ''));

/** 等间隔降采样（保留首末点），元素 {d:date,v:value} */
function downsample(series, max = THUMB_POINTS) {
  if (!Array.isArray(series) || series.length === 0) return undefined;
  if (series.length <= max) return series.map((p) => ({ d: p.date, v: p.value }));
  const out = [];
  for (let i = 0; i < max; i++) {
    const p = series[Math.round((i * (series.length - 1)) / (max - 1))];
    out.push({ d: p.date, v: p.value });
  }
  return out;
}

/** 计划 → 扁平参数字典（人类可读摘要；前端 paramKeyUnion/diffParams 依赖"扁平"） */
function flatParams(plan, model, result) {
  const f = plan.factors || [];
  return {
    factors: f.map((x) => `${x.expr}×${x.weight}${x.direction === -1 ? '↓' : '↑'}`).join(' | '),
    transforms: (plan.transforms || []).length
      ? plan.transforms.map((t) => (Object.keys(t.args || {}).length ? `${t.type}(${Object.entries(t.args).map(([k, v]) => `${k}=${v}`).join(',')})` : t.type)).join(' → ')
      : '无',
    filters: (plan.filters || []).length
      ? plan.filters.map((x) => `${x.field}${x.min !== undefined ? `≥${x.min}` : ''}${x.max !== undefined ? `≤${x.max}` : ''}`).join(' & ')
      : '无',
    combine: plan.combine || 'weighted_sum',
    universe: model.universe?.type || 'core_pool',
    rebalance: model.backtest?.rebalance || 'monthly',
    groups: model.backtest?.groups,
    fees: model.backtest?.fees,
    topN: result?.topN,
    capital: result?.capital,
    slippage: result?.slippage,
  };
}

/** 把一次 runModel 结果转成实验记录（不可变快照） */
function toRecord(uid, { model, plan, fingerprint, engineVersion, result, modelId, modelHash }) {
  const m = result?.ic || {};
  const bm = typeof result?.benchmarkReturn === 'number' ? result.benchmarkReturn : null;
  const tr = typeof result?.totalReturn === 'number' ? result.totalReturn : null;
  return {
    id: newId(),
    ts: new Date().toISOString(),
    uid,
    modelId: modelId || null,
    modelName: model?.name || '(未命名)',
    /** 语义核心哈希（由调用方 modelrun.modelHash 提供；缺省 null 而不是伪造） */
    modelHash: modelHash || null,
    fingerprint: fingerprint || '',
    engineVersion: engineVersion || '',
    /**
     * 🔴 模型快照（归一化后的 Model JSON，约 1KB）。
     *   为什么必须存：实验记录是「复现承诺的载体」——只存指纹与指标的话，
     *   用户看到一条好结果却拿不回当时那个模型，等于不可复现。
     *   存了它，「载入该实验的模型」就能一键还原当时的定义。
     */
    modelSnapshot: model || null,
    params: flatParams(plan || {}, model || {}, result || {}),
    metrics: {
      totalReturn: tr,
      annualized: result?.annualized ?? null,
      maxDrawdownPct: result?.maxDrawdownPct ?? null,
      sharpe: result?.sharpe ?? null,
      benchmarkReturn: bm,
      /** 超额收益：模型 − 等权基准（对比时最直观的一列） */
      excessReturn: tr !== null && bm !== null ? +(tr - bm).toFixed(2) : null,
      rebalances: result?.rebalances ?? null,
      fills: result?.fills ?? null,
      totalFees: result?.totalFees ?? null,
      feeRatePct: result?.feeRatePct ?? null,
      icMean: m.icMean ?? null,
      icir: m.icir ?? null,
      icPositiveRate: m.icPositiveRate ?? null,
      icN: m.n ?? null,
    },
    range: result?.range || null,
    universeSize: result?.universeSize ?? null,
    ...(downsample(result?.equity) ? { equityThumb: downsample(result.equity) } : {}),
    ...(downsample(result?.benchmark) ? { benchmarkThumb: downsample(result.benchmark) } : {}),
  };
}

// ── 文件后端 ──
const filePath = (id) => path.join(DIR, `${id}.json`);

function indexRowOf(rec) {
  return {
    id: rec.id,
    uid: rec.uid,
    ts: rec.ts,
    modelName: rec.modelName,
    fingerprint: rec.fingerprint,
    // 列表页要展示的关键指标冗余进索引（免解正文）
    totalReturn: rec.metrics?.totalReturn ?? null,
    excessReturn: rec.metrics?.excessReturn ?? null,
    maxDrawdownPct: rec.metrics?.maxDrawdownPct ?? null,
    sharpe: rec.metrics?.sharpe ?? null,
  };
}

async function countForUid(uid) {
  if (db.hasDb()) {
    try {
      const r = await db.query('SELECT count(*)::int AS n FROM model_experiments WHERE uid = $1', [uid]);
      return r.rows?.[0]?.n ?? 0;
    } catch (e) {
      console.error('[ModelExp] 配额查询失败:', e.message?.slice(0, 120));
      return 0;
    }
  }
  return readIndex().filter((x) => x.uid === uid).length;
}

// ── 对外接口 ──

/** 记录一次实验（调用方须 await）。超配额时**显式返回 warning** 并淘汰本 uid 最旧记录。 */
async function record(uid, payload) {
  const u = normalizeUid(uid);
  const rec = toRecord(u, payload);
  const serialized = JSON.stringify(rec);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOC_BYTES) {
    return { ok: false, error: `实验记录体积超限（${MAX_DOC_BYTES} 字节）` };
  }

  let evicted = 0;
  if ((await countForUid(u)) >= QUOTA_PER_UID) {
    // 淘汰本 uid 最旧的若干条（只删自己的，不碰他人数据）
    const oldest = (await list(u, { limit: QUOTA_PER_UID })).slice(-5).map((x) => x.id);
    for (const id of oldest) {
      await remove(id, u);
      evicted += 1;
    }
  }

  if (db.hasDb()) {
    try {
      await db.query(
        `INSERT INTO model_experiments (id, uid, model_name, fingerprint, ts, doc)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rec.id, u, rec.modelName, rec.fingerprint, new Date(rec.ts), JSON.stringify(rec)],
      );
      return { ok: true, id: rec.id, ts: rec.ts, evicted };
    } catch (e) {
      console.error('[ModelExp] DB 写入失败，回落文件:', e.message?.slice(0, 120));
    }
  }

  try {
    ensure();
    writeJsonAtomic(filePath(rec.id), rec);
    const next = [indexRowOf(rec), ...readIndex().filter((x) => x.id !== rec.id)];
    writeIndex(next.slice(0, INDEX_MAX));
    return { ok: true, id: rec.id, ts: rec.ts, evicted };
  } catch (e) {
    console.error('[ModelExp] 记录失败:', e.message);
    return { ok: false, error: `记录失败: ${String(e.message || e).slice(0, 100)}` };
  }
}

/** 取单条（含所有权校验） */
async function get(id, uid) {
  const clean = String(id || '');
  if (!ID_RE.test(clean)) return null;
  const u = normalizeUid(uid);
  if (db.hasDb()) {
    try {
      const r = await db.query('SELECT doc FROM model_experiments WHERE id = $1 AND uid = $2', [clean, u]);
      if (r.rows?.length) return r.rows[0].doc;
    } catch (e) {
      console.error('[ModelExp] DB 读取失败，回落文件:', e.message?.slice(0, 120));
    }
  }
  try {
    const p = filePath(clean);
    if (!fs.existsSync(p)) return null;
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return normalizeUid(doc.uid) === u ? doc : null;
  } catch {
    return null;
  }
}

/** 列出本人实验（索引行，新在前） */
async function list(uid, { limit = 100 } = {}) {
  const u = normalizeUid(uid);
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const out = new Map();

  if (db.hasDb()) {
    try {
      const r = await db.query(
        `SELECT id, ts, model_name, fingerprint, doc->'metrics' AS metrics
         FROM model_experiments WHERE uid = $1 ORDER BY ts DESC LIMIT $2`,
        [u, lim],
      );
      for (const row of r.rows || []) {
        const m = row.metrics || {};
        out.set(row.id, {
          id: row.id,
          ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
          modelName: row.model_name,
          fingerprint: row.fingerprint,
          totalReturn: m.totalReturn ?? null,
          excessReturn: m.excessReturn ?? null,
          maxDrawdownPct: m.maxDrawdownPct ?? null,
          sharpe: m.sharpe ?? null,
        });
      }
    } catch (e) {
      console.error('[ModelExp] DB 列表失败，回落文件:', e.message?.slice(0, 120));
    }
  }

  for (const row of readIndex()) {
    if (row.uid !== u || out.has(row.id)) continue;
    out.set(row.id, {
      id: row.id, ts: row.ts, modelName: row.modelName, fingerprint: row.fingerprint,
      totalReturn: row.totalReturn, excessReturn: row.excessReturn,
      maxDrawdownPct: row.maxDrawdownPct, sharpe: row.sharpe,
    });
  }

  return [...out.values()].sort(byTsDesc).slice(0, lim);
}

/** 删除（含所有权校验） */
async function remove(id, uid) {
  const clean = String(id || '');
  if (!ID_RE.test(clean)) return { ok: false, removed: false, error: 'id 非法' };
  const u = normalizeUid(uid);
  let removed = false;
  if (db.hasDb()) {
    try {
      const r = await db.query('DELETE FROM model_experiments WHERE id = $1 AND uid = $2', [clean, u]);
      if ((r.rowCount ?? 0) > 0) removed = true;
    } catch (e) {
      console.error('[ModelExp] DB 删除失败:', e.message?.slice(0, 120));
    }
  }
  try {
    const index = readIndex();
    const row = index.find((x) => x.id === clean);
    if (row && row.uid === u) {
      try { fs.unlinkSync(filePath(clean)); } catch { /* 正文可能不存在 */ }
      writeIndex(index.filter((x) => x.id !== clean));
      removed = true;
    }
  } catch (e) {
    console.error('[ModelExp] 文件删除失败:', e.message?.slice(0, 120));
  }
  return { ok: true, removed };
}

/** 批量取多条的完整记录（对比页用；越权/不存在的静默跳过——由调用方比对数量） */
async function getMany(ids, uid) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids.slice(0, 20) : []) {
    const doc = await get(id, uid);
    if (doc) out.push(doc);
  }
  return out;
}

async function statsForUid(uid) {
  return { count: await countForUid(normalizeUid(uid)), quota: QUOTA_PER_UID };
}

module.exports = {
  record,
  get,
  list,
  remove,
  getMany,
  statsForUid,
  toRecord,
  downsample,
  flatParams,
  QUOTA_PER_UID,
  THUMB_POINTS,
  ID_RE,
  _resetIndexCache: () => { indexCache = null; },
};
