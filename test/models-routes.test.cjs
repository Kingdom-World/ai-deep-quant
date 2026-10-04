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
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert');

const { registerModelRoutes } = require('../server/routes/models.cjs');
const modelrun = require('../server/modelrun.cjs');
const modelspec = require('../shared/modelspec.cjs');
const modelstore = require('../server/modelstore.cjs');

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
const appFor = (IS_VERCEL = false) => {
  const app = fakeApp();
  registerModelRoutes(app, {
    modelrun,
    modelspec,
    modelstore,
    uidOf: (req) => req?.user?.username || 'anon',
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

test('路由注册：七条，且 /schema 必须排在 /:id 之前', () => {
  const app = appFor();
  const keys = [...app.routes.keys()]; // 保持注册顺序
  assert.deepStrictEqual([...keys].sort(), [
    'DELETE /api/models/:id',
    'GET /api/models',
    'GET /api/models/:id',
    'GET /api/models/schema',
    'POST /api/models',
    'POST /api/models/run',
    'POST /api/models/validate',
  ].sort()); // 注意：用副本排序，避免污染下面要用注册顺序的 keys
  assert.ok(
    keys.indexOf('GET /api/models/schema') < keys.indexOf('GET /api/models/:id'),
    '/schema 必须先注册，否则会被 :id 吃掉',
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
