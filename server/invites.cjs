// ─────────────────────────────────────────────────────────────
// 一码一人邀请码（2026-09-20）
//
//   为什么需要它：原实现（auth.cjs 的 INVITE_CODE）是 .env 里的**单一共享值**——
//   所有注册者填同一个码。它的问题不是"不安全"，而是**失控**：
//     · 码一旦外泄，任何人都能注册，且你无从知道是谁漏的
//     · 想收回只能改全局码，然后**重新通知所有还没注册的朋友**
//     · 无法回答"这张码是谁用的"
//   一码一人把这三件事都解决：泄露影响限于单张码、可追溯、可单独吊销。
//
//   存储：data/auth/invites.json（与 users.json 同目录）
//     结构：{ codes: [{ code, note, createdAt, usedBy, usedAt, revoked, expiresAt }] }
//     ⚠️ AUTH_DATA_DIR 供测试隔离（沿用 auth.cjs 的约定，勿另造变量名）。
//
//   落盘走 atomic-write（项目铁律 #10：含 fsync），避免半损文件。
//
//   🔴 并发约定：Node 单线程 + 本模块全部**同步**操作 ⇒ 一个请求内的
//      「校验 → 建用户 → 消费」不会被其他请求插入。**故调用方必须保证
//      这三步之间没有 await**，否则会退化成"两张请求用同一张码"。
//      为此把接口拆成 check() 与 consume() 两个同步函数，由调用方串起来。
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write.cjs');

const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, '..', 'data', 'auth');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');

/** 读全部邀请码；文件不存在/损坏时返回空表（坏文件不该让注册彻底不可用） */
function loadAll() {
  try {
    const raw = fs.readFileSync(INVITES_FILE, 'utf8');
    const doc = JSON.parse(raw);
    if (doc && Array.isArray(doc.codes)) return doc.codes;
  } catch { /* 首次运行或文件损坏，按空表处理 */ }
  return [];
}

function saveAll(codes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(INVITES_FILE, { codes, updatedAt: new Date().toISOString() });
}

/**
 * 生成一张新邀请码。
 *   码形如 `dsh-A7K2-9QX4`：用 crypto 随机（非 Math.random），去掉易混字符（0/O/1/I/L）。
 * @param {string} note 备注（给谁用），便于日后核对
 * @param {number} [ttlDays] 有效天数，省略=不过期
 */
function create({ note = '', ttlDays } = {}) {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 无 0/O/1/I/L
  const pick = (n) =>
    Array.from(crypto.randomBytes(n))
      .map((b) => ALPHABET[b % ALPHABET.length])
      .join('');
  const code = `dsh-${pick(4)}-${pick(4)}`;
  const now = new Date().toISOString();
  const entry = {
    code,
    note: String(note || '').trim().slice(0, 60),
    createdAt: now,
    usedBy: null,
    usedAt: null,
    revoked: false,
    expiresAt: ttlDays ? new Date(Date.now() + Number(ttlDays) * 86400_000).toISOString() : null,
  };
  const codes = loadAll();
  codes.push(entry);
  saveAll(codes);
  return entry;
}

/** 列表（含已用与已吊销，供管理员核对） */
function list() {
  return loadAll();
}

/** 吊销某张码（保留记录而非删除，便于追溯"这张码曾经存在过"） */
function revoke(code) {
  const codes = loadAll();
  const hit = codes.find((c) => c.code === code);
  if (!hit) return { ok: false, error: '邀请码不存在' };
  hit.revoked = true;
  saveAll(codes);
  return { ok: true, entry: hit };
}

/**
 * 校验一张码**是否可用**（不消费）。
 *   与 consume() 配对使用：调用方须在**同一同步块**内先 check 后 consume。
 * @returns {{ok:true, entry}} | {{ok:false, error}}
 */
function check(code) {
  const key = String(code || '').trim();
  if (!key) return { ok: false, error: '请填写邀请码' };
  const hit = loadAll().find((c) => c.code === key);
  if (!hit) return { ok: false, error: '邀请码无效，请向站点管理员索取' };
  if (hit.revoked) return { ok: false, error: '该邀请码已被吊销' };
  if (hit.usedBy) return { ok: false, error: '该邀请码已被使用（一码一人，如有疑问请联系管理员）' };
  if (hit.expiresAt && Date.parse(hit.expiresAt) < Date.now()) return { ok: false, error: '该邀请码已过期' };
  return { ok: true, entry: hit };
}

/**
 * 消费一张码（标记已用）。**调用前必须已通过 check**，且中途不得 await。
 * @returns {{ok:true}} | {{ok:false, error}}
 */
function consume(code, username) {
  const key = String(code || '').trim();
  const codes = loadAll();
  const hit = codes.find((c) => c.code === key);
  if (!hit) return { ok: false, error: '邀请码无效' };
  // 二次校验：即便调用方漏了 check，也不会把同一张码发两次
  if (hit.revoked || hit.usedBy) return { ok: false, error: '该邀请码不可用' };
  hit.usedBy = String(username || '');
  hit.usedAt = new Date().toISOString();
  saveAll(codes);
  return { ok: true };
}

/**
 * 是否启用了"一码一人"模式。
 *   判定：存在 invites.json 或显式设置 INVITE_MODE=on。
 *   **未启用时调用方应回落到旧的 INVITE_CODE 单码逻辑**，保证向后兼容。
 */
function isEnabled() {
  if (String(process.env.INVITE_MODE || '').toLowerCase() === 'on') return true;
  try {
    return fs.existsSync(INVITES_FILE);
  } catch {
    return false;
  }
}

module.exports = { create, list, revoke, check, consume, isEnabled, INVITES_FILE, DATA_DIR };
