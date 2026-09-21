// ─────────────────────────────────────────────────────────────
// 一码一人邀请码测试（2026-09-20；2026-09-21 适配异步接口 + 数据库后端）
//
//   核心断言只有一条：**同一张码不能被用两次**。
//   其余（格式/吊销/过期/兼容/可追溯）都是围绕它的边界。
//
//   ⚠️ 测试隔离（两件事，都必须做）：
//     1. `AUTH_DATA_DIR` 在 invites.cjs **模块加载时**求值 ⇒ 必须在 require 之前设置，
//        否则会写进真实的 data/auth/（含 users.json 与签名密钥）。
//     2. **必须清掉数据库连接串** —— 否则 db.hasDb() 为真，本文件会去读写真实数据库。
//        本文件的目的正是覆盖 **file 后端**，故显式断言 hasDb() 为 false。
//        这是项目"测试必须起隔离实例"约定的同一类问题。
//
//   ⚠️ 接口已于 2026-09-21 变为**全异步**：check/consume 两步被 `claim()` 取代
//      （单条原子操作，天然免疫并发）；新增 `release()` 供注册失败回滚。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 先隔离，再 require（顺序不可颠倒）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'invites-test-'));
process.env.AUTH_DATA_DIR = TMP;
delete process.env.INVITE_MODE; // 让 enabled() 走"文件存在"判定
delete process.env.DATABASE_URL; // 强制走 file 后端，别碰真实数据库
delete process.env.POSTGRES_URL;
delete process.env.DATABASE_URL_UNPOOLED;

const invites = require('../server/invites.cjs');
const db = require('../server/db.cjs');

test('前置：本文件必须跑在 file 后端（未被数据库接管）', () => {
  assert.strictEqual(db.hasDb(), false, '测试环境不应存在数据库连接串');
  assert.ok(invites.INVITES_FILE.startsWith(TMP), 'INVITES_FILE 必须落在临时目录');
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
});

test('生成：码格式可读，且不含易混字符', async () => {
  const e = await invites.create({ note: '给张三' });
  assert.match(e.code, /^dsh-[A-Z2-9]{4}-[A-Z2-9]{4}$/, `码格式不符：${e.code}`);
  assert.doesNotMatch(e.code, /[0O1IL]/, '不应含易混字符 0/O/1/I/L');
  assert.strictEqual(e.note, '给张三');
  assert.strictEqual(e.usedBy, null);
  assert.strictEqual(e.revoked, false);
  assert.strictEqual(e.expiresAt, null, '未指定 ttl 则不过期');
});

test('生成：两张码不重复', async () => {
  const codes = new Set();
  for (let i = 0; i < 20; i++) codes.add((await invites.create({})).code);
  assert.strictEqual(codes.size, 20, '不应出现重复码');
});

test('核心：同一张码不能被用两次', async () => {
  const e = await invites.create({ note: '单次性' });
  const first = await invites.claim(e.code, 'userA');
  assert.strictEqual(first.ok, true, '未使用的码应可占用');
  // 第二次：必须拒绝，且给出可读原因
  const c2 = await invites.claim(e.code, 'userB');
  assert.strictEqual(c2.ok, false, '已使用的码 claim 必须失败');
  assert.match(c2.error, /已被使用/);
});

test('核心：claim 后记录使用人与时间（可追溯）', async () => {
  const e = await invites.create({});
  await invites.claim(e.code, 'userC');
  const row = (await invites.list()).find((x) => x.code === e.code);
  assert.strictEqual(row.usedBy, 'userC');
  assert.ok(row.usedAt && !Number.isNaN(Date.parse(row.usedAt)), 'usedAt 应是合法时间');
});

test('校验：不存在的码与空码都被拒绝', async () => {
  const miss = await invites.claim('dsh-ZZZZ-ZZZZ', 'u');
  assert.strictEqual(miss.ok, false);
  assert.match(miss.error, /无效/);
  assert.strictEqual((await invites.claim('', 'u')).ok, false);
  assert.strictEqual((await invites.claim(null, 'u')).ok, false);
  assert.strictEqual((await invites.claim(undefined, 'u')).ok, false);
});

test('校验：已吊销的码不可用，且不能被重新占用', async () => {
  const e = await invites.create({});
  assert.strictEqual((await invites.revoke(e.code)).ok, true);
  const c = await invites.claim(e.code, 'someone');
  assert.strictEqual(c.ok, false);
  assert.match(c.error, /已被吊销/);
});

test('校验：吊销保留记录（便于追溯，而非删除）', async () => {
  const e = await invites.create({ note: '待吊销' });
  await invites.revoke(e.code);
  const row = (await invites.list()).find((x) => x.code === e.code);
  assert.ok(row, '吊销后记录应仍在表中');
  assert.strictEqual(row.revoked, true);
});

test('校验：已过期的码不可用', async () => {
  const e = await invites.create({ ttlDays: -1 }); // 负数天 → 已过期
  assert.ok(e.expiresAt, '负数 ttl 应产出 expiresAt（而非静默变成永不过期）');
  const c = await invites.claim(e.code, 'u');
  assert.strictEqual(c.ok, false, '过期码应被拒绝');
  assert.match(c.error, /过期|无效|不可用/);
});

test('吊销不存在的码应报错而非静默成功', async () => {
  const r = await invites.revoke('dsh-NOPE-NOPE');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不存在/);
});

test('enabled：有文件即启用；未创建前不启用', async () => {
  const f = invites.INVITES_FILE;
  const bak = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
    assert.strictEqual(await invites.enabled(), false, '无文件且未设 INVITE_MODE 时不应启用');
    await invites.create({});
    assert.strictEqual(await invites.enabled(), true, '创建后应启用');
  } finally {
    if (bak !== null) fs.writeFileSync(f, bak);
  }
});

test('健壮性：文件损坏时不抛异常（注册不该因坏文件彻底不可用）', async () => {
  const f = invites.INVITES_FILE;
  const bak = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  try {
    fs.writeFileSync(f, '{ 这不是合法 JSON');
    assert.deepStrictEqual(await invites.list(), [], '坏文件按空表处理');
    // 且仍能继续生成新码（自愈）
    const e = await invites.create({ note: '损坏后重建' });
    assert.strictEqual((await invites.claim(e.code, 'u')).ok, true);
  } finally {
    if (bak !== null) fs.writeFileSync(f, bak);
  }
});

test('并发语义：真并发下只有一张请求能占用同一张码', async () => {
  const e = await invites.create({ note: '并发' });
  // 同时发起 3 个占用请求 —— 旧实现的 check→consume 两步套路正是死在这里，
  // claim() 把它压成单条原子操作后，必须恰好只有一个成功。
  const results = await Promise.all(['u1', 'u2', 'u3'].map((u) => invites.claim(e.code, u)));
  const okCount = results.filter((r) => r.ok).length;
  assert.strictEqual(okCount, 1, `恰好应 1 个成功，实际 ${okCount} 个`);
  const row = (await invites.list()).find((x) => x.code === e.code);
  assert.ok(['u1', 'u2', 'u3'].includes(row.usedBy), '占用者必须是三者之一');
});

test('回归：注册失败时 release 能归还码（不白烧一张）', async () => {
  const e = await invites.create({ note: '回滚' });
  assert.strictEqual((await invites.claim(e.code, 'u1')).ok, true, '先占用');
  // 模拟"占码成功但建号失败" → 归还
  assert.strictEqual((await invites.release(e.code, 'u1')).ok, true);
  const after = (await invites.list()).find((x) => x.code === e.code);
  assert.strictEqual(after.usedBy, null, '归还后应回到未使用');
  assert.strictEqual((await invites.claim(e.code, 'u2')).ok, true, '归还后应可再次占用');
});

test('回归：release 不能释放"不属于本次占用者"的码（防误放）', async () => {
  const e = await invites.create({ note: '防误放' });
  await invites.claim(e.code, 'owner');
  const r = await invites.release(e.code, 'attacker');
  assert.strictEqual(r.ok, false, '非占用者不得归还');
  const row = (await invites.list()).find((x) => x.code === e.code);
  assert.strictEqual(row.usedBy, 'owner', '占用者不应被改动');
});
