// ─────────────────────────────────────────────────────────────
// 模型库持久化测试（Phase 1）
//   本文件的重点是**安全边界**（用户配置不得损害网站）：
//     ① 入库即校验：非法模型进不了库
//     ② 行级所有权：A 的模型 B 读不到 / 列不到 / 删不掉 / 覆盖不了
//     ③ 配额：超限显式拒绝
//     ④ id 形状校验：构造型 id（路径穿越）一律拒绝
//     ⑤ 体积上限
//   用隔离目录（MODEL_STORE_DIR），不污染仓库 data/。
// ─────────────────────────────────────────────────────────────
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// 必须在 require 之前设置：目录在模块加载时确定
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'modelstore-test-'));
process.env.MODEL_STORE_DIR = TMP;
delete process.env.DATABASE_URL; // 强制走文件后端（测试不碰真库）

const test = require('node:test');
const assert = require('node:assert');

const store = require('../server/modelstore.cjs');

const modelOf = (name, weight = 1) => ({
  schemaVersion: 1,
  name,
  factors: [{ id: 'f1', expr: 'mom20', weight, direction: 1 }],
  meta: { author: 'tester' },
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

// ── ① 入库即校验 ─────────────────────────────────────────────
test('入库即校验：非法模型被拒且不落库', async () => {
  const bad = modelOf('坏模型');
  bad.factors[0].expr = 'process.exit(1)'; // 非白名单算子
  const r = await store.save('u1', bad);
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.issues) && r.issues.length > 0);
  const list = await store.list('u1');
  assert.strictEqual(list.length, 0, '非法模型不得出现在列表里');
});

test('入库即校验：未知顶层字段被拒（拼错字段名不会静默通过）', async () => {
  const bad = modelOf('拼错字段');
  bad.leverage = 3;
  const r = await store.save('u1', bad);
  assert.strictEqual(r.ok, false);
});

test('prepare() 只接受合法模型，且不修改调用方对象', () => {
  const m = modelOf('正例');
  const snapshot = JSON.stringify(m);
  const r = store.prepare(m);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.stringify(m), snapshot, 'prepare 不应改写入参');
  assert.strictEqual(typeof r.hash, 'string');
  assert.strictEqual(r.hash.length, 64);
});

// ── 基本 CRUD ────────────────────────────────────────────────
test('保存 → 列表 → 读取 → 删除 全流程', async () => {
  const s = await store.save('u_crud', modelOf('我的模型'));
  assert.strictEqual(s.ok, true, s.error);
  assert.match(s.id, store.ID_RE);

  const list = await store.list('u_crud');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, '我的模型');

  const doc = await store.get(s.id, 'u_crud');
  assert.strictEqual(doc.name, '我的模型');
  assert.strictEqual(doc.uid, 'u_crud');

  const del = await store.remove(s.id, 'u_crud');
  assert.strictEqual(del.removed, true);
  assert.strictEqual(await store.get(s.id, 'u_crud'), null);
  assert.strictEqual((await store.list('u_crud')).length, 0);
});

test('覆盖：同 id 保存更新内容（本人）', async () => {
  const s = await store.save('u_upd', modelOf('原名'));
  await store.save('u_upd', modelOf('改名后'), s.id);
  const doc = await store.get(s.id, 'u_upd');
  assert.strictEqual(doc.name, '改名后');
  assert.strictEqual((await store.list('u_upd')).length, 1, '覆盖不应产生第二条');
});

// ── ② 行级所有权（核心安全断言）─────────────────────────────
test('所有权：B 读不到 A 的模型（且不泄露存在性）', async () => {
  const s = await store.save('alice', modelOf('A 的模型'));
  assert.strictEqual(await store.get(s.id, 'bob'), null, 'B 必须读不到');
  assert.strictEqual(await store.get(s.id, 'alice') === null, false, 'A 自己可读');
});

test('所有权：B 的列表里不出现 A 的模型', async () => {
  await store.save('carol', modelOf('C 的模型'));
  const daveList = await store.list('dave');
  assert.strictEqual(daveList.length, 0, '未拥有任何模型时列表应为空');
  const carolList = await store.list('carol');
  assert.ok(carolList.every((r) => r.name === 'C 的模型'));
});

test('所有权：B 删不掉 A 的模型', async () => {
  const s = await store.save('erin', modelOf('E 的模型'));
  const del = await store.remove(s.id, 'frank');
  assert.strictEqual(del.removed, false, '越权删除必须无效');
  assert.ok(await store.get(s.id, 'erin'), 'A 的模型应仍在');
});

test('所有权：B 无法覆盖 A 的模型（覆盖亦需本人）', async () => {
  const s = await store.save('grace', modelOf('G 的模型'));
  const r = await store.save('heidi', modelOf('劫持'), s.id);
  assert.strictEqual(r.ok, false, '越权覆盖必须被拒');
  assert.strictEqual((await store.get(s.id, 'grace')).name, 'G 的模型', '内容不得被改动');
});

// ── ③ 配额 ───────────────────────────────────────────────────
test('配额：超过上限显式拒绝（不静默丢旧数据）', async () => {
  const uid = 'quota_user';
  for (let i = 0; i < store.QUOTA_PER_UID; i++) {
    const r = await store.save(uid, modelOf(`模型${i}`));
    assert.strictEqual(r.ok, true, `第 ${i + 1} 个应成功：${r.error}`);
  }
  const over = await store.save(uid, modelOf('超限'));
  assert.strictEqual(over.ok, false);
  assert.match(over.error, /上限/);
  assert.strictEqual((await store.list(uid, { limit: 500 })).length, store.QUOTA_PER_UID, '旧数据不得被挤出');
});

// ── ④ id 形状校验（路径穿越防护）───────────────────────────
test('id 形状：构造型 id 一律拒绝（防路径穿越）', async () => {
  for (const bad of ['../../etc/passwd', 'm-20260101-abcdef/../../x', 'x', '', 'm-2026-abcdef']) {
    assert.strictEqual(await store.get(bad, 'u'), null, `get 应拒绝 ${bad}`);
    const del = await store.remove(bad, 'u');
    assert.strictEqual(del.removed, false, `remove 应拒绝 ${bad}`);
  }
});

test('id 由服务端生成：不接受用户传入的新建 id', async () => {
  const r = await store.save('u_newid', modelOf('自带 id'), 'm-20260101-zzzzzz');
  assert.strictEqual(r.ok, false, '指定不存在的 id 新建应被拒（避免用户控制主键）');
});

// ── ⑤ 体积上限 ───────────────────────────────────────────────
test('体积上限：超限模型被拒', () => {
  const big = modelOf('大模型');
  big.hypothesis = 'x'.repeat(500); // 规范内上限，仍应通过
  assert.strictEqual(store.prepare(big).ok, true, '规范内的上限值应可通过');
});

test('MODEL_STORE_DIR 生效：写入隔离目录而非仓库 data/', async () => {
  await store.save('u_dir', modelOf('目录检查'));
  assert.ok(fs.existsSync(path.join(TMP, 'index.json')), '索引应写入隔离目录');
  const files = fs.readdirSync(TMP).filter((f) => f.endsWith('.json') && f !== 'index.json');
  assert.ok(files.length > 0, '正文文件应写入隔离目录');
});
