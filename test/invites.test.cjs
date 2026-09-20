// ─────────────────────────────────────────────────────────────
// 一码一人邀请码测试（2026-09-20）
//
//   核心断言只有一条：**同一张码不能被用两次**。
//   其余（格式/吊销/过期/兼容）都是围绕它的边界。
//
//   ⚠️ 测试隔离：DATA_DIR 在 invites.cjs **模块加载时**求值，故必须在 require 之前
//      设置 AUTH_DATA_DIR，否则会写进真实的 data/auth/（该目录含 users.json 与签名密钥）。
//      这是本项目"抽取时发现模块不可隔离"教训的同一类问题。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 先隔离，再 require（顺序不可颠倒）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'invites-test-'));
process.env.AUTH_DATA_DIR = TMP;
delete process.env.INVITE_MODE; // 让 isEnabled 走"文件存在"判定

const invites = require('../server/invites.cjs');

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
});

test('生成：码格式可读，且不含易混字符', () => {
  const e = invites.create({ note: '给张三' });
  assert.match(e.code, /^dsh-[A-Z2-9]{4}-[A-Z2-9]{4}$/, `码格式不符：${e.code}`);
  assert.doesNotMatch(e.code, /[0O1IL]/, '不应含易混字符 0/O/1/I/L');
  assert.strictEqual(e.note, '给张三');
  assert.strictEqual(e.usedBy, null);
  assert.strictEqual(e.revoked, false);
  assert.strictEqual(e.expiresAt, null, '未指定 ttl 则不过期');
});

test('生成：两张码不重复', () => {
  const codes = new Set();
  for (let i = 0; i < 20; i++) codes.add(invites.create({}).code);
  assert.strictEqual(codes.size, 20, '不应出现重复码');
});

test('核心：同一张码不能被用两次', () => {
  const e = invites.create({ note: '单次性' });
  assert.strictEqual(invites.check(e.code).ok, true, '未使用的码应可用');
  assert.strictEqual(invites.consume(e.code, 'userA').ok, true);
  // 第二次：两种入口都必须拒绝
  const c2 = invites.check(e.code);
  assert.strictEqual(c2.ok, false, '已使用的码 check 必须失败');
  assert.match(c2.error, /已被使用/);
  assert.strictEqual(invites.consume(e.code, 'userB').ok, false, 'consume 也必须拒绝（纵深防御）');
});

test('核心：consume 后记录使用人与时间（可追溯）', () => {
  const e = invites.create({});
  invites.consume(e.code, 'userC');
  const row = invites.list().find((x) => x.code === e.code);
  assert.strictEqual(row.usedBy, 'userC');
  assert.ok(row.usedAt && !Number.isNaN(Date.parse(row.usedAt)), 'usedAt 应是合法时间');
});

test('校验：不存在的码与空码都被拒绝', () => {
  assert.strictEqual(invites.check('dsh-ZZZZ-ZZZZ').ok, false);
  assert.match(invites.check('dsh-ZZZZ-ZZZZ').error, /无效/);
  assert.strictEqual(invites.check('').ok, false);
  assert.strictEqual(invites.check(null).ok, false);
  assert.strictEqual(invites.check(undefined).ok, false);
});

test('校验：已吊销的码不可用，且不能被重新消费', () => {
  const e = invites.create({});
  assert.strictEqual(invites.revoke(e.code).ok, true);
  const c = invites.check(e.code);
  assert.strictEqual(c.ok, false);
  assert.match(c.error, /已被吊销/);
  assert.strictEqual(invites.consume(e.code, 'someone').ok, false);
});

test('校验：吊销保留记录（便于追溯，而非删除）', () => {
  const e = invites.create({ note: '待吊销' });
  invites.revoke(e.code);
  const row = invites.list().find((x) => x.code === e.code);
  assert.ok(row, '吊销后记录应仍在表中');
  assert.strictEqual(row.revoked, true);
});

test('校验：已过期的码不可用', () => {
  const e = invites.create({ ttlDays: -1 }); // 负数天 → 已过期
  const c = invites.check(e.code);
  assert.strictEqual(c.ok, false, '过期码应被拒绝');
  assert.match(c.error, /过期|无效|不可用/);
});

test('吊销不存在的码应报错而非静默成功', () => {
  const r = invites.revoke('dsh-NOPE-NOPE');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不存在/);
});

test('isEnabled：有文件即启用；未创建前不启用', () => {
  // 清掉文件，确认回到未启用（此时调用方应回落共享码逻辑）
  const f = invites.INVITES_FILE;
  const bak = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
    assert.strictEqual(invites.isEnabled(), false, '无文件且未设 INVITE_MODE 时不应启用');
    invites.create({});
    assert.strictEqual(invites.isEnabled(), true, '创建后应启用');
  } finally {
    if (bak !== null) fs.writeFileSync(f, bak);
  }
});

test('健壮性：文件损坏时不抛异常（注册不该因坏文件彻底不可用）', () => {
  const f = invites.INVITES_FILE;
  const bak = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  try {
    fs.writeFileSync(f, '{ 这不是合法 JSON');
    assert.doesNotThrow(() => invites.list());
    assert.deepStrictEqual(invites.list(), [], '坏文件按空表处理');
    // 且仍能继续生成新码（自愈）
    const e = invites.create({ note: '损坏后重建' });
    assert.strictEqual(invites.check(e.code).ok, true);
  } finally {
    if (bak !== null) fs.writeFileSync(f, bak);
  }
});

test('并发语义：串行 check→consume 是安全的（无 await 插入）', () => {
  const e = invites.create({ note: '并发' });
  // 同一同步块内：先 check 再 consume，模拟真实注册路径
  const results = [];
  for (const u of ['u1', 'u2', 'u3']) {
    const chk = invites.check(e.code);
    if (!chk.ok) { results.push(false); continue; }
    results.push(invites.consume(e.code, u).ok);
  }
  assert.deepStrictEqual(results, [true, false, false], '只有第一个能成功，其余必须失败');
  assert.strictEqual(invites.list().find((x) => x.code === e.code).usedBy, 'u1');
});
