'use strict';
// ─────────────────────────────────────────────────────────────
// 模型库持久化（Phase 1 模型工坊）
//
//   🔴 安全边界（用户配置不得损害网站）——四道闸：
//     ① **入库即校验**：只接受通过 modelspec + 真实 AST 校验的模型；非法模型进不了库。
//        因此库里永远只有声明式数据，不含任何可执行内容。
//     ② **行级所有权**：读取/删除**必须带 uid 条件**（SQL WHERE / 索引过滤），
//        A 用户拿不到也删不掉 B 用户的模型；无 uid 匹配一律视为不存在（不泄露"存在性"）。
//     ③ **配额**：每 uid 模型数上限；超限显式拒绝，不静默丢旧数据。
//     ④ **id 由服务端生成**且读取时严格校验形状（^m-\d{8}-[a-z0-9]{6}$）——
//        用户无法构造 id，也就无从做路径穿越。
//
//   双后端（沿 reportstore 模式）：
//     · 有 DATABASE_URL → model_store 表（Vercel 只读 FS 上文件写不进去）
//     · 无 DB → data/models/{id}.json 正文 + data/models/index.json 轻量索引
//     · 列表双源合并（按 id 去重、updatedAt 降序）：本地配 DB 后历史文件模型仍可见
//   ⚠️ 全部函数 async：调用方必须 await（Serverless 响应返回后写入会被冻结丢弃）。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.cjs');
const db = require('./db.cjs');
const ms = require('../shared/modelspec.cjs');
const fe = require('./factorexpr.cjs');
const { modelHash } = require('./modelrun.cjs');

/** 存储目录可经环境变量覆盖（测试用隔离目录，避免污染仓库 data/） */
const DIR = process.env.MODEL_STORE_DIR || path.join(__dirname, '..', 'data', 'models');
const INDEX = path.join(DIR, 'index.json');
const INDEX_MAX = 2000;

/** 每 uid 模型数上限 */
const QUOTA_PER_UID = Number(process.env.MODEL_QUOTA_PER_UID) || 50;
/** 单模型序列化字节上限（规范本身很小，这是硬闸，防畸形请求撑爆存储） */
const MAX_DOC_BYTES = 32 * 1024;
/** id 形状（服务端生成；读取时严格校验，杜绝构造型路径穿越） */
const ID_RE = /^m-\d{8}-[a-z0-9]{6}$/;

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

// ── 索引（文件后端；内存缓存，只有本进程会写）──
let indexCache = null;
function readIndex() {
  if (indexCache) return indexCache;
  try {
    const parsed = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : [];
    indexCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    indexCache = []; // 索引损坏：正文文件仍在，可重建
  }
  return indexCache;
}
function writeIndex(next) {
  indexCache = next;
  writeJsonAtomic(INDEX, next, true);
}

function newId() {
  return 'm-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 8);
}

const normalizeUid = (uid) => String(uid || 'default').slice(0, 120);

function indexRowOf(id, uid, doc, hash) {
  return {
    id,
    uid,
    name: doc.name,
    modelHash: hash,
    createdAt: doc.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** 排序：updatedAt 降序（字符串 ISO 可直接比较） */
const byUpdatedDesc = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));

// ── 校验 ─────────────────────────────────────────────────────
/**
 * 入库前校验 + 归一化。仅接受合法模型；不合法时返回 issues（不落库）。
 * @returns {{ok:true, doc:object, hash:string} | {ok:false, error:string, issues?:object[]}}
 */
function prepare(input) {
  const norm = ms.normalizeModel(input, { parseExpr: fe.parseExpression });
  if (!norm.ok) return { ok: false, error: 'Model 校验失败，未入库', issues: norm.errors };

  const doc = {
    ...norm.model,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(doc);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOC_BYTES) {
    return { ok: false, error: `模型体积超过上限 ${MAX_DOC_BYTES} 字节` };
  }
  return { ok: true, doc, hash: modelHash(norm.model) };
}

// ── 文件后端 ─────────────────────────────────────────────────
function fileDocPath(id) {
  return path.join(DIR, `${id}.json`);
}

async function countForUid(uid) {
  if (db.hasDb()) {
    try {
      const r = await db.query('SELECT count(*)::int AS n FROM model_store WHERE uid = $1', [uid]);
      return r.rows?.[0]?.n ?? 0;
    } catch (e) {
      console.error('[ModelStore] 配额查询失败:', e.message?.slice(0, 120));
      return 0; // 查询失败不阻塞保存（配额是保护而非正确性约束），但会记日志
    }
  }
  return readIndex().filter((r) => r.uid === uid).length;
}

// ── 对外接口 ─────────────────────────────────────────────────

/**
 * 保存模型（新建或覆盖同 id）。调用方须 await。
 * @param {string} uid 所有权标识（uidOf(req)）
 * @param {object} input 用户提交的 Model（未归一化）
 * @param {string} [id] 覆盖已有模型时传入（须为其本人所有）
 * @returns {Promise<{ok:boolean, id?:string, modelHash?:string, error?:string, issues?:object[]}>}
 */
async function save(uid, input, id) {
  const u = normalizeUid(uid);
  const prep = prepare(input);
  if (!prep.ok) return prep;

  // 覆盖：先确认目标存在且属于本人（越权 → 视为不存在）
  if (id !== undefined) {
    if (!ID_RE.test(String(id))) return { ok: false, error: 'id 非法' };
    const existing = await get(String(id), u);
    if (!existing) return { ok: false, error: '模型不存在' };
  } else {
    const n = await countForUid(u);
    if (n >= QUOTA_PER_UID) {
      return { ok: false, error: `模型数量已达上限（${QUOTA_PER_UID} 个），请先删除不再需要的模型` };
    }
  }

  const docId = id !== undefined ? String(id) : newId();
  const doc = { ...prep.doc, id: docId, uid: u };

  if (db.hasDb()) {
    try {
      await db.query(
        `INSERT INTO model_store (id, uid, name, model_hash, doc, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name, model_hash = EXCLUDED.model_hash,
               doc = EXCLUDED.doc, updated_at = now()
           WHERE model_store.uid = EXCLUDED.uid`,
        [docId, u, doc.name, prep.hash, JSON.stringify(doc)],
      );
      return { ok: true, id: docId, modelHash: prep.hash };
    } catch (e) {
      console.error('[ModelStore] DB 保存失败，回落文件:', e.message?.slice(0, 120));
      // 继续尝试文件后端（本地可写时保住数据）
    }
  }

  try {
    ensure();
    writeJsonAtomic(fileDocPath(docId), doc);
    const index = readIndex().filter((r) => r.id !== docId);
    index.unshift(indexRowOf(docId, u, doc, prep.hash));
    writeIndex(index.slice(0, INDEX_MAX).sort(byUpdatedDesc));
    return { ok: true, id: docId, modelHash: prep.hash };
  } catch (e) {
    console.error('[ModelStore] 保存失败:', e.message);
    return { ok: false, error: `保存失败: ${String(e.message || e).slice(0, 100)}` };
  }
}

/**
 * 读取模型（**含所有权校验**：只有本人能读）。
 * @returns {Promise<object|null>} 文档或 null（不存在 / 非本人 → 一律 null，不区分）
 */
async function get(id, uid) {
  const clean = String(id || '');
  if (!ID_RE.test(clean)) return null; // 形状不符直接拒（防构造 id）
  const u = normalizeUid(uid);

  if (db.hasDb()) {
    try {
      const r = await db.query('SELECT doc FROM model_store WHERE id = $1 AND uid = $2', [clean, u]);
      if (r.rows?.length) return r.rows[0].doc;
    } catch (e) {
      console.error('[ModelStore] DB 读取失败，回落文件:', e.message?.slice(0, 120));
    }
  }
  try {
    const p = fileDocPath(clean);
    if (!fs.existsSync(p)) return null;
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return normalizeUid(doc.uid) === u ? doc : null; // 文件侧同样校验所有权
  } catch {
    return null;
  }
}

/**
 * 列出**本人**模型（不含他人）。
 * @returns {Promise<Array<{id:string,name:string,modelHash:string,createdAt:string,updatedAt:string}>>}
 */
async function list(uid, { limit = 100 } = {}) {
  const u = normalizeUid(uid);
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const out = new Map(); // id → row（双源合并去重）

  if (db.hasDb()) {
    try {
      const r = await db.query(
        `SELECT id, name, model_hash, created_at, updated_at FROM model_store
         WHERE uid = $1 ORDER BY updated_at DESC LIMIT $2`,
        [u, lim],
      );
      for (const row of r.rows || []) {
        out.set(row.id, {
          id: row.id,
          name: row.name,
          modelHash: row.model_hash,
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
          updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        });
      }
    } catch (e) {
      console.error('[ModelStore] DB 列表失败，回落文件:', e.message?.slice(0, 120));
    }
  }

  for (const row of readIndex()) {
    if (row.uid !== u || out.has(row.id)) continue;
    out.set(row.id, {
      id: row.id,
      name: row.name,
      modelHash: row.modelHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return [...out.values()].sort(byUpdatedDesc).slice(0, lim);
}

/**
 * 删除模型（**含所有权校验**）。他人模型不可删。
 * @returns {Promise<{ok:boolean, removed:boolean, error?:string}>}
 */
async function remove(id, uid) {
  const clean = String(id || '');
  if (!ID_RE.test(clean)) return { ok: false, removed: false, error: 'id 非法' };
  const u = normalizeUid(uid);
  let removed = false;

  if (db.hasDb()) {
    try {
      const r = await db.query('DELETE FROM model_store WHERE id = $1 AND uid = $2', [clean, u]);
      if ((r.rowCount ?? 0) > 0) removed = true;
    } catch (e) {
      console.error('[ModelStore] DB 删除失败:', e.message?.slice(0, 120));
    }
  }

  try {
    const index = readIndex();
    const row = index.find((r) => r.id === clean);
    if (row && row.uid === u) {
      try {
        fs.unlinkSync(fileDocPath(clean));
      } catch {
        /* 正文可能不存在（纯 DB 记录），忽略 */
      }
      writeIndex(index.filter((r) => r.id !== clean));
      removed = true;
    }
  } catch (e) {
    console.error('[ModelStore] 文件删除失败:', e.message?.slice(0, 120));
  }

  return { ok: true, removed };
}

/** 统计（管理/自检用）：按 uid 计数 */
async function statsForUid(uid) {
  return { count: await countForUid(normalizeUid(uid)), quota: QUOTA_PER_UID };
}

module.exports = {
  save,
  get,
  list,
  remove,
  statsForUid,
  prepare,
  QUOTA_PER_UID,
  MAX_DOC_BYTES,
  ID_RE,
  _resetIndexCache: () => {
    indexCache = null;
  },
};
