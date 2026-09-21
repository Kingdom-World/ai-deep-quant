// ─────────────────────────────────────────────────────────────
// 一码一人邀请码（2026-09-20；2026-09-21 增加数据库后端）
//
//   为什么需要它：原实现（auth.cjs 的 INVITE_CODE）是 .env 里的**单一共享值**——
//   所有注册者填同一个码。它的问题不是"不安全"，而是**失控**：
//     · 码一旦外泄，任何人都能注册，且你无从知道是谁漏的
//     · 想收回只能改全局码，然后**重新通知所有还没注册的朋友**
//     · 无法回答"这张码是谁用的"
//   一码一人把这三件事都解决：泄露影响限于单张码、可追溯、可单独吊销。
//
//   ── 两个后端，同一套**异步**接口 ─────────────────────────────
//   · **file 后端**（本地开发/测试）：`data/auth/invites.json`，落盘走 atomic-write
//     （铁律 #10，含 fsync）。未配置数据库时自动使用，行为与改造前一致。
//   · **db 后端**（Vercel 等只读 FS 环境）：表 `invite_codes`。
//     为什么必须换：只读 FS 上 `invites.json` **写不进去** ⇒ "已使用"状态无法记录
//     ⇒ 一码一人**在线上形同虚设**（人人都能重复用同一张码）。
//
//   🔴 原子性：`claim()` 是唯一的"占用"入口。
//     · db 后端：单条 `UPDATE ... WHERE used_by IS NULL AND revoked=false RETURNING`，
//       由**数据库行锁**保证一张码只能被占一次 —— 天然免疫并发，
//       远比应用层的"先 check 后 consume"可靠（那两步之间一旦插入 await 就会漏）。
//     · file 后端：全程同步，靠 Node 单线程在"同一 tick 内完成读改写"保证。
//     故调用方**不再需要** check/consume 两步套路 —— 那正是并发漏洞的来源。
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.cjs');
const db = require('./db.cjs');

const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, '..', 'data', 'auth');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');

// ═══════════════════ file 后端 ═══════════════════
/** 读全部邀请码；文件不存在/损坏时返回空表（坏文件不该让注册彻底不可用） */
function loadAll() {
  try {
    const raw = fs.readFileSync(INVITES_FILE, 'utf8');
    const doc = JSON.parse(raw);
    if (doc && Array.isArray(doc.codes)) return doc.codes;
  } catch {
    /* 首次运行或文件损坏，按空表处理 */
  }
  return [];
}

function saveAll(codes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(INVITES_FILE, { codes, updatedAt: new Date().toISOString() });
}

/** 生成码：`dsh-XXXX-XXXX`，crypto 随机，字母表去掉易混的 0/O/1/I/L */
function newCode() {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = (n) =>
    Array.from(crypto.randomBytes(n))
      .map((b) => ALPHABET[b % ALPHABET.length])
      .join('');
  return `dsh-${pick(4)}-${pick(4)}`;
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    code: row.code,
    note: row.note || '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    usedBy: row.used_by || null,
    usedAt: row.used_at ? new Date(row.used_at).toISOString() : null,
    revoked: Boolean(row.revoked),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

// ═══════════════════ 统一接口（全部异步） ═══════════════════

/**
 * 是否启用了"一码一人"。
 *   未启用时调用方应回落到 `INVITE_CODE`（.env 共享码），保持向后兼容。
 */
async function enabled() {
  if (db.hasDb()) return true; // 库表就是邀请码的家；即便暂时为空，也按一码一人处理
  try {
    if (String(process.env.INVITE_MODE || '').toLowerCase() === 'on') return true;
    return fs.existsSync(INVITES_FILE);
  } catch {
    return false;
  }
}

/** 生成一张新邀请码。`ttlDays` 省略 = 不过期。 */
async function create({ note = '', ttlDays } = {}) {
  const code = newCode();
  const n = String(note || '').trim().slice(0, 60);
  // ttlDays 语义：**未提供**才不过期；提供了就按数值算 ——
  // 含负数（→ 已过期），供测试与运维构造"过期码"；不能只认正数，
  // 否则 `ttlDays:-1` 会静默变成"永不过期"（2026-09-21 重构时踩到，测试抓出）。
  const days = ttlDays === undefined || ttlDays === null || ttlDays === '' ? null : Number(ttlDays);
  const hasTtl = days !== null && !Number.isNaN(days);

  if (db.hasDb()) {
    const r = await db.query(
      `INSERT INTO invite_codes (code, note, expires_at)
       VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + ($3::int * interval '1 day') END)
       RETURNING code, note, created_at, used_by, used_at, revoked, expires_at`,
      [code, n, hasTtl ? Math.trunc(days) : null],
    );
    return rowToEntry(r.rows[0]);
  }
  const codes = loadAll();
  const entry = {
    code,
    note: n,
    createdAt: new Date().toISOString(),
    usedBy: null,
    usedAt: null,
    revoked: false,
    expiresAt: hasTtl ? new Date(Date.now() + days * 86400_000).toISOString() : null,
  };
  codes.push(entry);
  saveAll(codes);
  return entry;
}

/** 列表（含已用与已吊销，供管理员核对） */
async function list() {
  if (db.hasDb()) {
    const r = await db.query(
      `SELECT code, note, created_at, used_by, used_at, revoked, expires_at
       FROM invite_codes ORDER BY created_at DESC`,
    );
    return r.rows.map(rowToEntry);
  }
  return loadAll();
}

/** 吊销某张码（保留记录而非删除，便于追溯"这张码曾经存在过"） */
async function revoke(code) {
  const key = String(code || '').trim();
  if (db.hasDb()) {
    const r = await db.query(
      `UPDATE invite_codes SET revoked = true WHERE code = $1
       RETURNING code, note, created_at, used_by, used_at, revoked, expires_at`,
      [key],
    );
    if (!r.rowCount) return { ok: false, error: '邀请码不存在' };
    return { ok: true, entry: rowToEntry(r.rows[0]) };
  }
  const codes = loadAll();
  const hit = codes.find((c) => c.code === key);
  if (!hit) return { ok: false, error: '邀请码不存在' };
  hit.revoked = true;
  saveAll(codes);
  return { ok: true, entry: hit };
}

/** file 后端：判断一张码为何不可用（失败时给出具体原因） */
function explainFile(code) {
  const hit = loadAll().find((c) => c.code === code);
  if (!hit) return '邀请码无效，请向站点管理员索取';
  if (hit.revoked) return '该邀请码已被吊销';
  if (hit.usedBy) return '该邀请码已被使用（一码一人，如有疑问请联系管理员）';
  if (hit.expiresAt && Date.parse(hit.expiresAt) < Date.now()) return '该邀请码已过期';
  return '该邀请码不可用';
}

/**
 * 占用一张码（**唯一的"使用"入口**）。成功即绑定 `used_by`，且不可撤销地占住。
 * @returns {Promise<{ok:true, entry}|{ok:false, error}>}
 */
async function claim(code, username) {
  const key = String(code || '').trim();
  if (!key) return { ok: false, error: '请填写邀请码' };

  if (db.hasDb()) {
    // 一条语句完成"校验 + 占用"，靠行锁保证同一张码只被占一次
    const r = await db.query(
      `UPDATE invite_codes
          SET used_by = $1, used_at = now()
        WHERE code = $2
          AND used_by IS NULL
          AND revoked = false
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING code, note, created_at, used_by, used_at, revoked, expires_at`,
      [String(username || ''), key],
    );
    if (r.rowCount) return { ok: true, entry: rowToEntry(r.rows[0]) };
    // 占用失败 → 查清具体原因，给出可读错误（而非笼统的"无效"）
    const q = await db.query(`SELECT code, used_by, revoked, expires_at FROM invite_codes WHERE code = $1`, [key]);
    const row = q.rows[0];
    if (!row) return { ok: false, error: '邀请码无效，请向站点管理员索取' };
    if (row.revoked) return { ok: false, error: '该邀请码已被吊销' };
    if (row.used_by) return { ok: false, error: '该邀请码已被使用（一码一人，如有疑问请联系管理员）' };
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now())
      return { ok: false, error: '该邀请码已过期' };
    return { ok: false, error: '该邀请码不可用' };
  }

  // file 后端：同步读改写，同一 tick 内完成
  const codes = loadAll();
  const hit = codes.find((c) => c.code === key);
  if (!hit || hit.revoked || hit.usedBy || (hit.expiresAt && Date.parse(hit.expiresAt) < Date.now())) {
    return { ok: false, error: explainFile(key) };
  }
  hit.usedBy = String(username || '');
  hit.usedAt = new Date().toISOString();
  saveAll(codes);
  return { ok: true, entry: hit };
}

/**
 * 归还一张**已占用但账号未建成**的码（注册失败回滚专用）。
 *   只归还给"恰好是本次占用者"的码 —— 防止误释放别人已占用的码。
 *   为什么需要它：claim() 是原子的"先占后用"，若后续建号失败（重名等），
 *   不归还就会白烧一张码 —— 原实现的"先建号后消费"正是为了避免这点。
 */
async function release(code, username) {
  const key = String(code || '').trim();
  const name = String(username || '');
  if (!key) return { ok: false, error: '缺少邀请码' };
  if (db.hasDb()) {
    const r = await db.query(
      `UPDATE invite_codes SET used_by = NULL, used_at = NULL
        WHERE code = $1 AND used_by = $2 RETURNING code`,
      [key, name],
    );
    return r.rowCount ? { ok: true } : { ok: false, error: '该码当前不归本次注册所有，未归还' };
  }
  const codes = loadAll();
  const hit = codes.find((c) => c.code === key && c.usedBy === name);
  if (!hit) return { ok: false, error: '该码当前不归本次注册所有，未归还' };
  hit.usedBy = null;
  hit.usedAt = null;
  saveAll(codes);
  return { ok: true };
}

module.exports = { enabled, create, list, revoke, claim, release, INVITES_FILE, DATA_DIR };
