// ─────────────────────────────────────────────────────────────
// 模型工坊路由测试（Phase 1）
//   不启 HTTP 服务：用假 app 捕获 (method,path,handler)，再以假 req/res 调用，
//   验证**契约**（状态码 / 响应字段 / 门控 / uid 隔离 / 注册顺序）。
// ─────────────────────────────────────────────────────────────
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// 隔离存储目录（须在 require 之前设置）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'models-routes-test-'));
process.env.MODEL_STORE_DIR = TMP;
process.env.MODEL_EXP_DIR = path.join(TMP, 'experiments');
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert');

const { registerModelRoutes } = require('../server/routes/models.cjs');
const modelrun = require('../server/modelrun.cjs');
const modelspec = require('../shared/modelspec.cjs');
const modelstore = require('../server/modelstore.cjs');
const modelexp = require('../server/modelexperiments.cjs');
const validation = require('../server/validation.cjs');

const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
    delete: (p, h) => routes.set(`DELETE ${p}`, h),
  };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
/** 调用路由处理器（同步/异步皆可） */
const call = async (app, key, body, user) => {
  const h = app.routes.get(key);
  assert.ok(h, `路由未注册：${key}`);
  const res = fakeRes();
  await h({ body, params: key.includes(':id') ? { id: '' } : {}, query: {}, user: user ? { username: user } : undefined }, res);
  return res;
};
const callId = async (app, key, id, user) => {
  const h = app.routes.get(key);
  assert.ok(h, `路由未注册：${key}`);
  const res = fakeRes();
  await h({ params: { id }, query: {}, body: {}, user: user ? { username: user } : undefined }, res);
  return res;
};
const appFor = (IS_VERCEL = false, isAdmin = () => false) => {
  const app = fakeApp();
  registerModelRoutes(app, {
    modelrun,
    modelspec,
    modelstore,
    modelexp,
    validation,
    uidOf: (req) => req?.user?.username || 'anon',
    isAdmin, // 分享审核闸门（新增 deps；缺了会让分享路由 500 —— 刻意不给默认值，避免静默失效）
    IS_VERCEL,
  });
  return app;
};

const validModel = (name = '路由测试') => ({
  schemaVersion: 1,
  name,
  factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: 1 }],
  meta: { author: 'tester' },
});

test('路由注册：十九条，且所有单段字面量路径必须排在 /:id 之前', () => {
  const app = appFor();
  const keys = [...app.routes.keys()]; // 保持注册顺序
  assert.deepStrictEqual([...keys].sort(), [
    'DELETE /api/model-experiments/:id',
    'DELETE /api/models/:id',
    'GET /api/model-experiments',
    'GET /api/model-experiments/:id',
    'GET /api/models',
    'GET /api/models/:id',
    'GET /api/models/circle',
    'GET /api/models/public',
    'GET /api/models/public/:id',
    'GET /api/models/review-queue',
    'GET /api/models/schema',
    'GET /api/models/shared/:id',
    'POST /api/model-experiments/compare',
    'POST /api/models',
    'POST /api/models/:id/review',
    'POST /api/models/:id/share',
    'POST /api/models/run',
    'POST /api/models/validate',
    'POST /api/models/validate-suite',
  ].sort()); // 注意：用副本排序，避免污染下面要用注册顺序的 keys

  // 🔴 所有**单段字面量**路径都必须排在 GET /:id 之前 —— 这是真实踩过的坑
  //    （/schema 曾因此被当成 id 吃掉；分享域的 /public、/circle、/review-queue 同理）。
  //    数据驱动：以后新增单段路由，只要写进这个数组就自动纳入守卫。
  const idIdx = keys.indexOf('GET /api/models/:id');
  assert.ok(idIdx >= 0, '应存在 GET /api/models/:id');
  for (const k of [
    'GET /api/models/schema',
    'GET /api/models/public',
    'GET /api/models/circle',
    'GET /api/models/review-queue',
  ]) {
    const i = keys.indexOf(k);
    assert.ok(i >= 0, `路由未注册：${k}`);
    assert.ok(i < idIdx, `${k} 必须先于 GET /api/models/:id 注册，否则会被 :id 吃掉`);
  }
  assert.ok(
    keys.indexOf('GET /api/model-experiments') < keys.indexOf('GET /api/model-experiments/:id'),
    '/api/model-experiments 必须先于 /:id 注册，否则列表会被当成 id 吃掉',
  );
});

test('GET schema：含 canRun 与配额（前端据此禁用运行按钮）', async () => {
  const res = await call(appFor(false), 'GET /api/models/schema');
  assert.strictEqual(res.body.ok, true);
  assert.deepStrictEqual(res.body.presets, modelspec.PRESET_FACTORS);
  assert.strictEqual(res.body.canRun, true, '本地可运行');
  assert.strictEqual(res.body.quotaPerUser, modelstore.QUOTA_PER_UID);
});

test('GET schema：Vercel 上 canRun=false（能力边界如实下发）', async () => {
  const res = await call(appFor(true), 'GET /api/models/schema');
  assert.strictEqual(res.body.canRun, false);
});

test('POST validate：合法 → ok=true 且回填默认值；非法 → ok=false', async () => {
  const ok = await call(appFor(), 'POST /api/models/validate', validModel());
  assert.strictEqual(ok.body.ok, true, JSON.stringify(ok.body.errors));
  assert.strictEqual(ok.body.model.backtest.rebalance, 'monthly');

  const bad = validModel();
  bad.factors[0].expr = 'foo(20)';
  const no = await call(appFor(), 'POST /api/models/validate', bad);
  assert.strictEqual(no.body.ok, false);
  assert.ok(no.body.errors.length > 0);
});

test('POST /api/models：保存成功并返回 id', async () => {
  const res = await call(appFor(), 'POST /api/models', validModel('存一个'), 'u_route');
  assert.strictEqual(res.body.ok, true, res.body.error);
  assert.match(res.body.id, modelstore.ID_RE);
});

test('POST /api/models：非法模型 → 400 且不入库', async () => {
  const bad = validModel('非法');
  bad.factors[0].expr = 'x;y';
  const res = await call(appFor(), 'POST /api/models', bad, 'u_bad');
  assert.strictEqual(res.statusCode, 400);
  const list = await call(appFor(), 'GET /api/models', null, 'u_bad');
  assert.strictEqual(list.body.items.length, 0);
});

test('GET /api/models：只列本人模型（uid 隔离）', async () => {
  await call(appFor(), 'POST /api/models', validModel('甲的模型'), 'alice');
  const bob = await call(appFor(), 'GET /api/models', null, 'bob');
  assert.strictEqual(bob.body.items.length, 0, 'B 不应看到 A 的模型');
  const alice = await call(appFor(), 'GET /api/models', null, 'alice');
  assert.ok(alice.body.items.some((m) => m.name === '甲的模型'));
  assert.ok(typeof alice.body.count === 'number' && typeof alice.body.quota === 'number');
});

test('GET /api/models/:id：他人模型返回 404（不泄露存在性）', async () => {
  const saved = await call(appFor(), 'POST /api/models', validModel('私有'), 'owner1');
  const mine = await callId(appFor(), 'GET /api/models/:id', saved.body.id, 'owner1');
  assert.strictEqual(mine.body.ok, true);
  const other = await callId(appFor(), 'GET /api/models/:id', saved.body.id, 'intruder');
  assert.strictEqual(other.statusCode, 404);
});

test('DELETE /api/models/:id：他人模型删不掉（404）', async () => {
  const saved = await call(appFor(), 'POST /api/models', validModel('待删'), 'owner2');
  const bad = await callId(appFor(), 'DELETE /api/models/:id', saved.body.id, 'thief');
  assert.strictEqual(bad.statusCode, 404);
  const still = await callId(appFor(), 'GET /api/models/:id', saved.body.id, 'owner2');
  assert.strictEqual(still.body.ok, true, '模型应仍在');
  const good = await callId(appFor(), 'DELETE /api/models/:id', saved.body.id, 'owner2');
  assert.strictEqual(good.body.removed, true);
});

test('POST run：Vercel → 503 且提示公网可配置/导出', async () => {
  const res = await call(appFor(true), 'POST /api/models/run', validModel());
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.stage, 'env');
  assert.match(res.body.error, /配置|导出/);
});

test('POST validate-suite：Vercel → 503（多次重计算不放到公网）', async () => {
  const res = await call(appFor(true), 'POST /api/models/validate-suite', { model: validModel() });
  assert.strictEqual(res.statusCode, 503, '公网不得承担 9 次回测的重计算');
  assert.strictEqual(res.body.stage, 'env');
  assert.match(res.body.error, /本地/);
});

test('POST run：本地 + 非法模型 → 400 + stage=validate', async () => {
  const bad = validModel();
  delete bad.name;
  const res = await call(appFor(false), 'POST /api/models/run', bad);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.stage, 'validate');
});

test('POST run：本地 + 合法模型 → 200 + 指纹 + 结果', async (t) => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const res = await call(appFor(false), 'POST /api/models/run', validModel());
  assert.strictEqual(res.body.ok, true, res.body.error);
  assert.strictEqual(res.body.fingerprint.length, 64);
  assert.ok(Array.isArray(res.body.result.equity));
  assert.ok(Number.isFinite(res.body.result.totalReturn));
});

test('入参两种包装（裸对象 / {model}）产出同一实验', async (t) => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const a = await call(appFor(false), 'POST /api/models/run', validModel());
  const b = await call(appFor(false), 'POST /api/models/run', { model: validModel() });
  assert.strictEqual(a.body.fingerprint, b.body.fingerprint);
});

// ── 模型实验记录路由（第六刀）─────────────────────────────────
/** 合成一条实验记录（不依赖真实归档：record() 只做快照，不跑引擎） */
const seedExp = (uid, name) =>
  modelexp.record(uid, {
    model: { schemaVersion: 1, name, factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: 1 }], backtest: { rebalance: 'monthly', groups: 5, fees: true }, meta: { author: 'x' } },
    plan: { factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: 1 }], transforms: [], filters: [], combine: 'weighted_sum' },
    fingerprint: 'f'.repeat(64),
    engineVersion: 'crosssect-m1.0',
    modelHash: 'h'.repeat(64),
    result: {
      totalReturn: 12.5, annualized: 8.1, maxDrawdownPct: -9.3, sharpe: 1.2, benchmarkReturn: 5,
      rebalances: 12, fills: 40, totalFees: 800, feeRatePct: 0.08,
      range: { start: '2024-01-01', end: '2025-01-01', bars: 240 }, universeSize: 200,
      ic: { icMean: 0.03, icir: 0.4, icPositiveRate: 0.55, n: 12 },
      equity: [{ date: '2024-01-01', value: 1 }], benchmark: [{ date: '2024-01-01', value: 1 }],
    },
  });

test('实验记录：GET 列表返回 ok/items/count/quota/maxCompare（空库也成立）', async () => {
  const r = await call(appFor(), 'GET /api/model-experiments', null, 'exp_empty_user');
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.items, []);
  assert.strictEqual(r.body.count, 0);
  assert.strictEqual(r.body.quota, modelexp.QUOTA_PER_UID);
  // maxCompare 由 shared/experiments.cjs 单一源下发（前端不硬编码上限）
  assert.strictEqual(r.body.maxCompare, require('../shared/experiments.cjs').MAX_COMPARE);
});

test('实验记录：uid 隔离——列表看不到他人的、读取/删除一律 404（不泄露存在性）', async () => {
  const a = await seedExp('exp_owner_a', 'A 的实验');
  assert.strictEqual(a.ok, true, a.error);

  const listB = await call(appFor(), 'GET /api/model-experiments', null, 'exp_owner_b');
  assert.deepStrictEqual(listB.body.items, [], 'B 不得看到 A 的实验');

  const getB = await callId(appFor(), 'GET /api/model-experiments/:id', a.id, 'exp_owner_b');
  assert.strictEqual(getB.statusCode, 404, '越权读取必须按"不存在"处理');

  const delB = await callId(appFor(), 'DELETE /api/model-experiments/:id', a.id, 'exp_owner_b');
  assert.strictEqual(delB.statusCode, 404, '越权删除必须失败且不泄露存在性');

  const listA = await call(appFor(), 'GET /api/model-experiments', null, 'exp_owner_a');
  assert.strictEqual(listA.body.items.length, 1);
  assert.strictEqual(listA.body.items[0].id, a.id, 'A 的数据必须没被 B 动过');
});

test('实验记录：compare 超过上限 → 400 且说明上限（不静默截断）', async () => {
  const max = require('../shared/experiments.cjs').MAX_COMPARE;
  const ids = Array.from({ length: max + 1 }, (_, i) => `x-20260101-aaaaa${i}`);
  const r = await call(appFor(), 'POST /api/model-experiments/compare', { ids }, 'exp_cmp_user');
  assert.strictEqual(r.statusCode, 400);
  assert.match(String(r.body.error), new RegExp(`最多对比 ${max}`));
});

test('实验记录：compare 返回完整记录（含 params/modelSnapshot，供对比与载入）', async () => {
  const a = await seedExp('exp_cmp_owner', '对比 A');
  const b = await seedExp('exp_cmp_owner', '对比 B');
  const r = await call(appFor(), 'POST /api/model-experiments/compare', { ids: [a.id, b.id] }, 'exp_cmp_owner');
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.items.length, 2);
  assert.strictEqual(r.body.requested, 2);
  for (const it of r.body.items) {
    // 前端对比表直接读 params（paramKeyUnion/diffParams 依赖"扁平 params"）
    assert.ok(it.params && typeof it.params === 'object', 'compare 需返回 params');
    // 「载入该实验的模型」依赖快照
    assert.ok(it.modelSnapshot && Array.isArray(it.modelSnapshot.factors), 'compare 需返回 modelSnapshot');
    assert.strictEqual(typeof it.ts, 'string', 'recKey(e)=e.ts —— 缺 ts 会导致勾选逻辑失效');
    assert.ok(it.metrics && typeof it.metrics.totalReturn === 'number');
    assert.strictEqual(typeof it.metrics.excessReturn, 'number', '超额收益（对比最直观的一列）必须算出');
  }
});

test('实验记录：DELETE 非法 id → 400；合法但不存在的 id → 404', async () => {
  const bad = await callId(appFor(), 'DELETE /api/model-experiments/:id', 'not-an-id', 'exp_del_user');
  assert.strictEqual(bad.statusCode, 400);
  const gone = await callId(appFor(), 'DELETE /api/model-experiments/:id', 'x-20260101-zzzzzz', 'exp_del_user');
  assert.strictEqual(gone.statusCode, 404);
});

test('实验记录：/api/models/run 自动留痕，且包装形态下 body.record=false 可关闭', async (t) => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const a = appFor(false);
  const r = await call(a, 'POST /api/models/run', validModel('留痕测试'), 'exp_run_user');
  assert.strictEqual(r.body.ok, true, r.body.error);
  assert.ok(r.body.experimentId, 'run 必须返回 experimentId（留痕是默认行为）');

  const list = await call(a, 'GET /api/model-experiments', null, 'exp_run_user');
  assert.ok(list.body.items.some((x) => x.id === r.body.experimentId), '留痕必须能在列表里查到');

  // 关闭开关只在**包装形态**下生效（裸对象形态里 body 就是模型本体）
  const off = await call(a, 'POST /api/models/run', { model: validModel('不留痕'), record: false }, 'exp_run_user');
  assert.strictEqual(off.body.experimentId, null, 'record=false 时不得留痕');
});

test('实验记录：裸对象形态下把 record 塞进模型体会被拒绝（开关不得污染模型）', async (t) => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const r = await call(appFor(false), 'POST /api/models/run', { ...validModel('污染'), record: false }, 'exp_pollute_user');
  assert.strictEqual(r.body.ok, false, '裸形态 + record 键 ⇒ 未知键必须显式报错，而不是被静默忽略');
  assert.strictEqual(r.body.stage, 'validate');
});
