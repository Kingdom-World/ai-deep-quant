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
const share = require('../shared/modelshare.cjs');
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
  const s = share.shareOf(doc);
  return {
    id,
    uid,
    name: doc.name,
    modelHash: hash,
    // 可见性冗余进索引：列表/广场过滤不必逐个读正文（索引是**派生数据**，可从正文重建）
    visibility: s.visibility,
    reviewState: s.reviewState,
    createdAt: doc.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 保存时该带哪些分享字段。
 *
 * 🔴 **覆盖保存必须继承原有分享状态**（这是真陷阱）：
 *    若不继承，用户每改一次模型都会被悄悄降级回「私有」——
 *    对已上架的公开示例尤其糟糕：改个参数就下架，而用户完全不知情。
 *    新建时用安全默认（私有 / 未申请）。老文档没有这些字段 ⇒ shareOf 自动回落默认。
 */
function shareFieldsFor(existing) {
  if (!existing) return { visibility: share.DEFAULT_VISIBILITY, reviewState: share.DEFAULT_REVIEW_STATE };
  const s = share.shareOf(existing);
  return {
    visibility: s.visibility,
    reviewState: s.reviewState,
    ...(s.reviewNote ? { reviewNote: s.reviewNote } : {}),
    ...(s.requestedAt ? { requestedAt: s.requestedAt } : {}),
    ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
  };
}

/** 排序：updatedAt 降序（字符串 ISO 可直接比较） */
const byUpdatedDesc = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));

/** 索引行/查询行 → 分享字段。老数据没有这些字段 ⇒ 安全默认（私有 / 未申请），无需数据迁移 */
const shareRowOf = (row) => ({
  visibility: share.isValidVisibility(row && row.visibility) ? row.visibility : share.DEFAULT_VISIBILITY,
  reviewState: share.isValidReviewState(row && row.reviewState) ? row.reviewState : share.DEFAULT_REVIEW_STATE,
});

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
  let existing = null;
  if (id !== undefined) {
    if (!ID_RE.test(String(id))) return { ok: false, error: 'id 非法' };
    existing = await get(String(id), u);
    if (!existing) return { ok: false, error: '模型不存在' };
  } else {
    const n = await countForUid(u);
    if (n >= QUOTA_PER_UID) {
      return { ok: false, error: `模型数量已达上限（${QUOTA_PER_UID} 个），请先删除不再需要的模型` };
    }
  }

  const docId = id !== undefined ? String(id) : newId();
  // 🔴 分享状态**继承**（见 shareFieldsFor 注释）：覆盖保存不得重置可见性/审核状态。
  //    模型语义字段以本次提交为准，分享字段以库中现值为准。
  const doc = { ...prep.doc, id: docId, uid: u, ...shareFieldsFor(existing) };

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
        `SELECT id, name, model_hash, created_at, updated_at,
                doc->>'visibility' AS visibility, doc->>'reviewState' AS review_state
         FROM model_store
         WHERE uid = $1 ORDER BY updated_at DESC LIMIT $2`,
        [u, lim],
      );
      for (const row of r.rows || []) {
        out.set(row.id, {
          id: row.id,
          name: row.name,
          modelHash: row.model_hash,
          ...shareRowOf(row),
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
      ...shareRowOf(row),
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

// ── 分享（Phase 2 · 模型分享 v1）────────────────────────────────

/**
 * 读取模型正文，**不做所有权校验**。
 * 🔴 危险函数：调用方**必须**自己执行 `modelshare.canView(doc, viewer)` 判定。
 *    模型库其余读取路径一律走 `get(id, uid)`（那里有行级所有权，越权即返回 null）。
 *    存在的唯一理由：分享路由要先拿到 `doc.uid` / `visibility` 才能做可见性判定。
 */
async function getRaw(id) {
  const clean = String(id || '');
  if (!ID_RE.test(clean)) return null;
  if (db.hasDb()) {
    try {
      const r = await db.query('SELECT doc FROM model_store WHERE id = $1', [clean]);
      if (r.rows?.length) return r.rows[0].doc;
    } catch (e) {
      console.error('[ModelStore] DB 读取失败，回落文件:', e.message?.slice(0, 120));
    }
  }
  try {
    const p = fileDocPath(clean);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** setShareState 允许写入的键（**白名单**：防止调用方顺手改模型语义字段） */
const SHARE_PATCH_KEYS = ['visibility', 'reviewState', 'reviewNote', 'requestedAt', 'publishedAt'];

/**
 * 写入分享状态（**含所有权校验**：只能改自己的模型）。
 * @param {string} id
 * @param {string} uid 必须等于模型所有者（否则视为不存在，不区分"非本人"与"不存在"）
 * @param {object} patch 见 SHARE_PATCH_KEYS
 * @returns {Promise<{ok:boolean, error?:string, doc?:object}>}
 */
async function setShareState(id, uid, patch) {
  const clean = String(id || '');
  if (!ID_RE.test(clean)) return { ok: false, error: 'id 非法' };
  const u = normalizeUid(uid);
  const safePatch = {};
  for (const k of SHARE_PATCH_KEYS) if (patch && patch[k] !== undefined) safePatch[k] = patch[k];
  if (!Object.keys(safePatch).length) return { ok: false, error: '没有可更新的分享字段' };

  if (db.hasDb()) {
    try {
      // jsonb `||` 只合并补丁键 ⇒ 不会覆盖模型语义字段（比整份 doc 覆写安全）
      const r = await db.query(
        `UPDATE model_store SET doc = doc || $3::jsonb, updated_at = now()
         WHERE id = $1 AND uid = $2 RETURNING doc`,
        [clean, u, JSON.stringify(safePatch)],
      );
      if (r.rows?.length) return { ok: true, doc: r.rows[0].doc };
    } catch (e) {
      console.error('[ModelStore] DB 分享状态写入失败，回落文件:', e.message?.slice(0, 120));
    }
  }

  try {
    const p = fileDocPath(clean);
    if (!fs.existsSync(p)) return { ok: false, error: '模型不存在' };
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (normalizeUid(doc.uid) !== u) return { ok: false, error: '模型不存在' };
    const next = { ...doc, ...safePatch, updatedAt: new Date().toISOString() };
    writeJsonAtomic(p, next);
    // 同步索引行（索引是派生数据；这里保持"正文为准"）
    const index = readIndex();
    const i = index.findIndex((r) => r.id === clean);
    if (i >= 0) {
      const s = share.shareOf(next);
      index[i] = { ...index[i], visibility: s.visibility, reviewState: s.reviewState, updatedAt: next.updatedAt };
      writeIndex(index);
    }
    return { ok: true, doc: next };
  } catch (e) {
    return { ok: false, error: `分享状态写入失败: ${String(e.message || e).slice(0, 100)}` };
  }
}

/**
 * 广场列表（**跨 uid**）。返回行含 `uid`（供调用方脱敏成作者显示名）。
 * scope:
 *   · `public`  → visibility=public 且 reviewState=approved（任何人可读，含匿名）
 *   · `circle`  → visibility=circle（需登录）。与 public **互斥**：
 *                 "圈内共享"的语义是"仅圈内可见"，公开档另成一类，避免同一模型出现两次。
 *   · `pending` → reviewState=pending（**仅管理员**；闸门在路由层，不在本函数）
 */
async function listShared({ scope = 'public', limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const sc = ['public', 'circle', 'pending'].includes(scope) ? scope : 'public';
  const matchRow = (row) => {
    const { visibility: v, reviewState: r } = shareRowOf(row);
    if (sc === 'public') return v === 'public' && r === 'approved';
    if (sc === 'circle') return v === 'circle';
    return r === 'pending';
  };

  const out = new Map();
  if (db.hasDb()) {
    const cond =
      sc === 'public'
        ? "doc->>'visibility' = 'public' AND doc->>'reviewState' = 'approved'"
        : sc === 'circle'
          ? "doc->>'visibility' = 'circle'"
          : "doc->>'reviewState' = 'pending'";
    try {
      const r = await db.query(
        `SELECT id, uid, name, model_hash, updated_at,
                doc->>'visibility' AS visibility, doc->>'reviewState' AS review_state
         FROM model_store WHERE ${cond}
         ORDER BY updated_at DESC LIMIT $1`,
        [lim],
      );
      for (const row of r.rows || []) {
        out.set(row.id, {
          id: row.id,
          uid: row.uid,
          name: row.name,
          modelHash: row.model_hash,
          ...shareRowOf(row),
          updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        });
      }
    } catch (e) {
      console.error('[ModelStore] DB 广场查询失败，回落文件:', e.message?.slice(0, 120));
    }
  }

  for (const row of readIndex()) {
    if (out.has(row.id) || !matchRow(row)) continue;
    out.set(row.id, {
      id: row.id,
      uid: row.uid,
      name: row.name,
      modelHash: row.modelHash,
      ...shareRowOf(row),
      updatedAt: row.updatedAt,
    });
  }

  return [...out.values()].sort(byUpdatedDesc).slice(0, lim);
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
  // 分享（Phase 2）
  getRaw,
  setShareState,
  listShared,
  SHARE_PATCH_KEYS,
  QUOTA_PER_UID,
  MAX_DOC_BYTES,
  ID_RE,
  _resetIndexCache: () => {
    indexCache = null;
  },
};
