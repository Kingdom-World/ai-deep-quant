// ─────────────────────────────────────────────────────────────
// 模型工坊路由测试（Phase 1）
//   不启 HTTP 服务：用假 app 捕获 (method,path,handler)，再以假 req/res 调用，
//   验证**契约**（状态码 / 响应字段 / 门控行为），而非框架细节。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { registerModelRoutes } = require('../server/routes/models.cjs');
const modelrun = require('../server/modelrun.cjs');
const modelspec = require('../shared/modelspec.mjs');

const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
  };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const call = (app, key, body) => {
  const h = app.routes.get(key);
  assert.ok(h, `路由未注册：${key}`);
  const res = fakeRes();
  h({ body }, res);
  return res;
};
const appFor = (IS_VERCEL = false) => {
  const app = fakeApp();
  registerModelRoutes(app, { modelrun, modelspec, IS_VERCEL });
  return app;
};

const validModel = () => ({
  schemaVersion: 1,
  name: '路由测试',
  factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: 1 }],
  meta: { author: 'tester' },
});

test('路由注册：schema / validate / run 三条', () => {
  const app = appFor();
  assert.deepStrictEqual(
    [...app.routes.keys()].sort(),
    ['GET /api/models/schema', 'POST /api/models/run', 'POST /api/models/validate'],
  );
});

test('GET schema：返回规范常量（前端表单的单一源）', () => {
  const res = call(appFor(), 'GET /api/models/schema');
  assert.strictEqual(res.statusCode, null, '成功路径不显式设状态码（Express 默认 200）');
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.schemaVersion, 1);
  assert.deepStrictEqual(res.body.presets, modelspec.PRESET_FACTORS);
  assert.deepStrictEqual(res.body.filterFields, modelspec.FILTER_FIELDS);
  assert.ok(typeof res.body.engineVersion === 'string' && res.body.engineVersion.length > 0);
  assert.ok(Array.isArray(res.body.transforms) && res.body.transforms.length >= 4);
});

test('POST validate：合法模型 → ok=true 且带归一化结果', () => {
  const res = call(appFor(), 'POST /api/models/validate', validModel());
  assert.strictEqual(res.body.ok, true, JSON.stringify(res.body.errors));
  assert.strictEqual(res.body.model.backtest.rebalance, 'monthly', '应回填默认值');
});

test('POST validate：非法模型 → ok=false 且 errors 非空', () => {
  const bad = validModel();
  bad.factors[0].expr = 'foo(20)'; // 服务端 AST 拒绝
  const res = call(appFor(), 'POST /api/models/validate', bad);
  assert.strictEqual(res.body.ok, false);
  assert.ok(res.body.errors.length > 0);
});

test('POST run：Vercel 上显式 503 拒绝（不启用必然失败的重计算）', () => {
  const res = call(appFor(true), 'POST /api/models/run', validModel());
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.ok, false);
  assert.strictEqual(res.body.stage, 'env');
});

test('POST run：本地 + 非法模型 → 400 + stage=validate + issues', () => {
  const bad = validModel();
  delete bad.name;
  const res = call(appFor(false), 'POST /api/models/run', bad);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.stage, 'validate');
  assert.ok(Array.isArray(res.body.issues) && res.body.issues.length > 0);
});

test('POST run：本地 + 合法模型 → 200 + 指纹 + 计划 + 结果', (t) => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const res = call(appFor(false), 'POST /api/models/run', validModel());
  assert.strictEqual(res.body.ok, true, res.body.error);
  assert.strictEqual(typeof res.body.fingerprint, 'string');
  assert.strictEqual(res.body.fingerprint.length, 64, 'SHA-256 hex');
  assert.strictEqual(res.body.plan.factors.length, 1);
  assert.ok(Array.isArray(res.body.result.equity));
  assert.ok(Number.isFinite(res.body.result.totalReturn));
});

test('POST run：支持 {model:{...}} 包装与裸对象两种入参', (t) => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const a = call(appFor(false), 'POST /api/models/run', validModel());
  const b = call(appFor(false), 'POST /api/models/run', { model: validModel() });
  assert.strictEqual(a.body.fingerprint, b.body.fingerprint, '两种入参应产出同一实验');
});
