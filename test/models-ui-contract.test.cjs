// ─────────────────────────────────────────────────────────────
// 模型工坊「前端契约」测试（Phase 1）
//
//   由来（诚实记录）：本机 Edge 无法以 CDP 方式启动（试过 headless/独立 profile/
//   脱离沙箱，调试端口始终不开），因此**无法做真浏览器渲染验证**。
//   浏览器能抓的是"运行时字段错配"——而这类错误的根因是**前后端字段名不一致**，
//   恰恰可以用契约断言钉死。这个文件就是那个替代方案，而且是长期资产：
//   今后任何一端改名，这里立刻变红。
//
//   🔴 教训来源：本项目曾 6 次臆造后端字段名（TS 不报错、UI 全 undefined）。
// ─────────────────────────────────────────────────────────────
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'models-ui-contract-'));
process.env.MODEL_STORE_DIR = TMP;
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert');

const { registerModelRoutes } = require('../server/routes/models.cjs');
const modelrun = require('../server/modelrun.cjs');
const modelspec = require('../shared/modelspec.mjs');
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
const call = async (app, key, body, user = 'contract_user') => {
  const h = app.routes.get(key);
  assert.ok(h, `路由未注册：${key}`);
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const params = key.includes(':id') ? { id: body && body.__id ? body.__id : '' } : {};
  await h({ body: body || {}, params, query: {}, user: { username: user } }, res);
  return res;
};
const app = () => {
  const a = fakeApp();
  registerModelRoutes(a, {
    modelrun,
    modelspec,
    modelstore,
    uidOf: (req) => req?.user?.username || 'anon',
    IS_VERCEL: false,
  });
  return a;
};

/** 断言 obj 含有全部 key（缺一即失败，并列出缺了哪些） */
function assertHasKeys(obj, keys, label) {
  const missing = keys.filter((k) => !(k in (obj || {})));
  assert.deepStrictEqual(missing, [], `${label} 缺少字段：${missing.join(', ')}（前端会读成 undefined）`);
}

test('契约 schema：页面渲染表单所需的全部字段', async () => {
  const r = await call(app(), 'GET /api/models/schema');
  assertHasKeys(r.body, ['ok', 'schemaVersion', 'presets', 'transforms', 'filterFields', 'filterOps', 'rebalance', 'universes', 'combineMethods', 'limits', 'engineVersion', 'quotaPerUser', 'canRun'], 'schema');
  assertHasKeys(r.body.limits, ['maxFactors', 'maxTransforms', 'maxFilters', 'maxTags', 'maxNameLen', 'maxHypothesisLen', 'maxWeight', 'minGroups', 'maxGroups', 'maxIdLen'], 'schema.limits');
  assert.ok(Array.isArray(r.body.transforms) && r.body.transforms.every((t) => 'type' in t && 'args' in t), 'transforms 每项需含 type/args');
  assert.ok(r.body.presets.length > 0 && r.body.filterFields.length > 0);
});

test('契约 validate：ok / errors[] / warnings[] / model', async () => {
  const ok = await call(app(), 'POST /api/models/validate', {
    schemaVersion: 1, name: '契约', factors: [{ id: 'f1', expr: 'mom20' }], meta: { author: 'x' },
  });
  assertHasKeys(ok.body, ['ok', 'errors', 'warnings', 'model'], 'validate');
  assert.strictEqual(ok.body.errors.length, 0);
  assert.strictEqual(ok.body.warnings.length, 1, '未声明 weight 应给 warning（页面会展示）');
  assertHasKeys(ok.body.warnings[0], ['path', 'message'], 'validate.warnings[0]');

  const bad = await call(app(), 'POST /api/models/validate', {
    schemaVersion: 1, name: '契约', factors: [{ id: 'f1', expr: 'nope(1)' }], meta: { author: 'x' },
  });
  assert.ok(bad.body.errors.length > 0, '应报错');
  assertHasKeys(bad.body.errors[0], ['path', 'message'], 'validate.errors[0]');
});

test('契约 模型库：list/save/get/remove 的字段', async () => {
  const a = app();
  const saved = await call(a, 'POST /api/models', {
    schemaVersion: 1, name: '契约模型', factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: 1 }], meta: { author: 'x' },
  });
  assertHasKeys(saved.body, ['ok', 'id', 'modelHash'], 'save');

  const list = await call(a, 'GET /api/models');
  assertHasKeys(list.body, ['ok', 'items', 'count', 'quota'], 'list');
  assertHasKeys(list.body.items[0], ['id', 'name', 'modelHash', 'createdAt', 'updatedAt'], 'list.items[0]');

  const got = await call(a, 'GET /api/models/:id', { __id: saved.body.id });
  assertHasKeys(got.body, ['ok', 'model'], 'get');
  assert.strictEqual(got.body.model.name, '契约模型');

  const del = await call(a, 'DELETE /api/models/:id', { __id: saved.body.id });
  assertHasKeys(del.body, ['ok', 'removed'], 'remove');
  assert.strictEqual(del.body.removed, true);
});

test('契约 run：结果面板读取的每个字段都真实存在', async (t) => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const r = await call(app(), 'POST /api/models/run', {
    schemaVersion: 1,
    name: '契约回测',
    factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: 1 }],
    meta: { author: 'x' },
  });
  assert.strictEqual(r.body.ok, true, r.body.error);

  assertHasKeys(r.body, ['ok', 'engineVersion', 'plan', 'fingerprint', 'model', 'result'], 'run');
  assertHasKeys(r.body.plan, ['factors', 'transforms', 'filters', 'combine'], 'run.plan');

  const res = r.body.result;
  assertHasKeys(
    res,
    ['totalReturn', 'annualized', 'maxDrawdownPct', 'sharpe', 'benchmarkReturn',
      'rebalances', 'fills', 'range', 'universeSize', 'benchmarkUniverse',
      'totalFees', 'feeRatePct', 'blockedLimitUp', 'blockedLimitDown', 'equity', 'benchmark', 'ic'],
    'run.result',
  );
  assertHasKeys(res.range, ['start', 'end', 'bars'], 'run.result.range');
  assertHasKeys(res.ic, ['icMean', 'icir', 'icPositiveRate', 'n'], 'run.result.ic');
  assert.ok(Array.isArray(res.equity) && res.equity.length > 0);
  assertHasKeys(res.equity[0], ['date', 'value'], 'run.result.equity[0]');
  assert.ok(res.benchmark.length > 0, '基准序列用于图中虚线，必须存在');
});

test('契约 run：失败响应也带页面读取的字段（stage/error）', async () => {
  const r = await call(app(), 'POST /api/models/run', { schemaVersion: 1, name: '', factors: [], meta: {} });
  assert.strictEqual(r.body.ok, false);
  assertHasKeys(r.body, ['ok', 'stage', 'error', 'issues'], 'run(失败)');
});
