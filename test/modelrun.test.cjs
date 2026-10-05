// ─────────────────────────────────────────────────────────────
// Model JSON → 回测桥接测试（Phase 1 模型工坊）
//
//   最重要的两条是**跨路径等价锁**：
//     ① 单因子模型 ≡ runCrossBacktest（同一账本，逐点净值一致）
//     ② 多因子加权 ≡ 等价的单表达式（组合语义与表达式语义一致）
//   它们保证"复合截面"没有偷偷长出第二套账本或第二套口径。
//
//   其余断言围绕「绝不静默忽略」：过滤器全过滤必须显式报错；
//   单调变换不得改变选股结果；指纹只认语义、不认标题。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { runModel, fingerprint, buildCompositeCrossSection, ENGINE_VERSION } = require('../server/modelrun.cjs');
const crosssect = require('../server/crosssect.cjs');
const modelspec = require('../shared/modelspec.cjs');
const fe = require('../server/factorexpr.cjs');

const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);

const model = (over = {}) => ({
  schemaVersion: 1,
  name: '测试模型',
  factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: 1 }],
  meta: { author: 'tester' },
  ...over,
});

// ── 校验阶段（无需归档）──────────────────────────────────────
test('校验失败：返回 stage=validate 且带 issues（不使用半成品）', () => {
  const r = runModel(model({ factors: [] }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'validate');
  assert.ok(Array.isArray(r.issues) && r.issues.length > 0);
});

test('校验失败：非法表达式被服务端 AST 拒绝（stage=validate）', () => {
  const r = runModel(model({ factors: [{ id: 'f1', expr: 'foo(20)' }] }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'validate');
  assert.ok(r.issues.some((i) => i.path.includes('expr')));
});

// ── 构建阶段不变量（无需归档）─────────────────────────────────
//   🔴 2026-10-05 修正：原用例名为「构建阶段失败：因子合法但引擎不认时给出 stage=build」，
//      但断言的是「正常模型不应有 stage」——**标题与断言不符**，且它需要一次成功回测，
//      因此依赖真实归档却**漏了 skip 守卫**：本地有归档所以一直绿，CI 无归档时
//      收到 stage:'build'（本地归档不足）直接红 —— CI 连续 8 次失败的成因之一。
//
//   同时实测确认：`stage:'build'` 在**公开路径上已不可达**（validate 会把 engine 不认的
//   因子全部拦下，见下方矩阵实验），它本质是「引擎与规范脱节」的安全网。
//   故这里锁住真正有价值的不变量：**validate 接受集 ⊆ build 可构建集**。
test('构建阶段不变量：通过校验的模型一律可构建（validate 接受集 ⊆ build 可构建集）', () => {
  const cases = [
    ['预置因子', model()],
    ['表达式因子', model({ factors: [{ id: 's', expr: 'mom60 - mom20', weight: 1, direction: 1 }] })],
    ['多因子+反向', model({
      factors: [
        { id: 'a', expr: 'mom20', weight: 1, direction: 1 },
        { id: 'b', expr: 'rev20', weight: -0.5, direction: -1 },
      ],
    })],
    ['全算子链', model({
      transforms: [
        { type: 'winsorize', args: { method: 'mad', n: 3 } },
        { type: 'zscore' },
        { type: 'rank' },
        { type: 'fill_missing', args: { method: 'cross_mean' } },
      ],
    })],
    ['过滤器', model({ filters: [{ type: 'field_range', field: 'close', min: 1 }] })],
  ];
  for (const [label, m] of cases) {
    const norm = modelspec.normalizeModel(m, { parseExpr: fe.parseExpression });
    assert.strictEqual(norm.ok, true, `${label}: 本应通过校验 ${JSON.stringify(norm.errors)}`);
    let err = null;
    try {
      buildCompositeCrossSection(norm.model);
    } catch (e) {
      err = e.message;
    }
    assert.strictEqual(
      err,
      null,
      `${label}: 通过校验却在构建期抛错 ⇒ 用户会看到莫名的 stage=build 失败（规范与引擎脱节）：${err}`,
    );
  }
});

test('正常模型成功执行时不得携带 stage（stage 仅用于表示失败阶段）', (t) => {
  if (skip(t)) return;
  assert.strictEqual(typeof runModel(model()).stage, 'undefined', '成功结果不应带 stage');
});

test('指纹只认语义：改标题/作者/标签不换指纹，改权重才换', () => {
  const base = { range: { start: 'a', end: 'b' }, universeSize: 100, topN: 5, rebalanceEvery: 20, capital: 1e6, slippage: 0.001 };
  const m1 = model();
  const m2 = model({ name: '换个名字', meta: { author: '别人', tags: ['x'] } });
  const m3 = model({ factors: [{ id: 'f1', expr: 'mom20', weight: 2, direction: 1 }] });
  assert.strictEqual(fingerprint(m1, base), fingerprint(m2, base), '元数据不应影响指纹');
  assert.notStrictEqual(fingerprint(m1, base), fingerprint(m3, base), '权重变化必须改变指纹');
});

test('指纹确定性：同输入两次调用一致', () => {
  const base = { range: { start: 'a', end: 'b' }, universeSize: 100, topN: 5, rebalanceEvery: 20, capital: 1e6, slippage: 0.001 };
  assert.strictEqual(fingerprint(model(), base), fingerprint(model(), base));
});

test('引擎版本已声明（指纹的一部分）', () => {
  assert.strictEqual(typeof ENGINE_VERSION, 'string');
  assert.ok(ENGINE_VERSION.length > 0);
});

// ── 执行阶段（需真实归档）────────────────────────────────────
const skip = (t) => {
  if (!hasRealArchive) {
    console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
    return true;
  }
  return false;
};

test('等价锁①：单因子模型 ≡ runCrossBacktest（同一账本，逐点净值一致）', (t) => {
  if (skip(t)) return;
  const a = runModel(model(), { topN: 5 });
  assert.strictEqual(a.ok, true, a.error);
  const b = crosssect.runCrossBacktest({
    factor: 'mom20',
    topN: 5,
    rebalanceEvery: 20,
    capital: 1_000_000,
    slippage: 0.001,
  });
  assert.ok(!b.error, b.error);
  assert.deepStrictEqual(a.result.equity, b.equity, '净值序列应逐点一致');
  assert.strictEqual(a.result.totalFees, b.totalFees);
  assert.strictEqual(a.result.turnover, b.turnover);
  assert.strictEqual(a.result.fills, b.fills);
  assert.strictEqual(a.result.factorKind, 'composite');
});

test('等价锁②：多因子加权 ≡ 等价的单表达式', (t) => {
  if (skip(t)) return;
  const m = model({
    factors: [
      { id: 'a', expr: 'mom20', weight: 1, direction: 1 },
      { id: 'b', expr: 'rev20', weight: 0.5, direction: 1 },
    ],
  });
  const a = runModel(m, { topN: 5 });
  assert.strictEqual(a.ok, true, a.error);
  const b = crosssect.runCrossBacktest({
    factor: 'mom20 + 0.5*rev20',
    topN: 5,
    rebalanceEvery: 20,
    capital: 1_000_000,
    slippage: 0.001,
  });
  assert.ok(!b.error, b.error);
  assert.deepStrictEqual(a.result.equity, b.equity, '组合语义应与表达式语义一致');
});

test('direction=-1 等价于取负表达式', (t) => {
  if (skip(t)) return;
  const a = runModel(model({ factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: -1 }] }));
  assert.strictEqual(a.ok, true, a.error);
  const b = crosssect.runCrossBacktest({ factor: '-mom20', topN: 5, rebalanceEvery: 20 });
  assert.ok(!b.error, b.error);
  assert.deepStrictEqual(a.result.equity, b.equity);
});

test('单调变换不改变选股结果：zscore 与 rank 应给出与无变换完全相同的净值', (t) => {
  if (skip(t)) return;
  const base = runModel(model());
  const withZ = runModel(model({ transforms: [{ type: 'zscore' }] }));
  const withR = runModel(model({ transforms: [{ type: 'rank' }] }));
  assert.strictEqual(base.ok && withZ.ok && withR.ok, true);
  assert.deepStrictEqual(withZ.result.equity, base.result.equity, 'zscore 是严格单调变换，选股不应变化');
  assert.deepStrictEqual(withR.result.equity, base.result.equity, 'rank 同理');
});

test('绝不为空的过滤器必须显式报错（不得静默返回 0 收益）', (t) => {
  if (skip(t)) return;
  const m = model({ filters: [{ type: 'field_range', field: 'amount', min: 1e18 }] }); // 不可能有标的满足
  const r = runModel(m);
  assert.strictEqual(r.ok, false, '应失败而不是返回一条平线');
  assert.strictEqual(r.stage, 'engine');
  assert.match(r.error, /全为空/, `错误应说明空截面，实际：${r.error}`);
});

test('恒真过滤器不误伤：用无缺失字段(close)时结果与无过滤完全一致', (t) => {
  if (skip(t)) return;
  const plain = runModel(model());
  const f = runModel(model({ filters: [{ type: 'field_range', field: 'close', min: -1e9 }] }));
  assert.strictEqual(f.ok, true, f.error);
  assert.deepStrictEqual(f.result.equity, plain.result.equity, '恒真过滤器不应改变任何选择');
});

test('过滤器语义：字段缺失/非有限 → 视为不满足（不静默放行）', () => {
  const { passesFilter } = require('../server/modelrun.cjs');
  assert.strictEqual(passesFilter({ field: 'amount', min: 0 }, { amount: undefined }), false);
  assert.strictEqual(passesFilter({ field: 'amount', min: 0 }, { amount: NaN }), false);
  assert.strictEqual(passesFilter({ field: 'amount', min: 0 }, { amount: null }), false);
  assert.strictEqual(passesFilter({ field: 'amount', min: 0 }, { amount: 5 }), true);
  assert.strictEqual(passesFilter({ field: 'amount', min: 0 }, { amount: -1 }), false);
  // 区间与比较算子
  assert.strictEqual(passesFilter({ field: 'amount', min: 1, max: 10 }, { amount: 10 }), true);
  assert.strictEqual(passesFilter({ field: 'amount', value: 10, op: '>' }, { amount: 10 }), false);
  assert.strictEqual(passesFilter({ field: 'amount', value: 10, op: '>=' }, { amount: 10 }), true);
});

test('归档事实：pctChg/turn 存在缺失行（故以它们做过滤会真实剔除样本）', () => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const f = fs.readdirSync(REAL_DIR).filter((x) => x.endsWith('.json')).slice(0, 40);
  let tot = 0;
  let missPct = 0;
  for (const fn of f) {
    const doc = JSON.parse(fs.readFileSync(path.join(REAL_DIR, fn), 'utf8'));
    for (const r of doc.rows) {
      tot += 1;
      if (!Number.isFinite(r.pctChg)) missPct += 1;
    }
  }
  assert.ok(tot > 1000, '样本量应足够');
  assert.ok(missPct > 0, 'pctChg 确有缺失行——过滤器的缺失语义因此是可观测的');
});

test('plan 回显：声明的 transforms/filters 必须出现在计划里（可审计）', (t) => {
  if (skip(t)) return;
  const m = model({
    transforms: [{ type: 'winsorize', args: { method: 'mad', n: 3 } }],
    filters: [{ type: 'field_range', field: 'amount', min: 1e6 }],
    backtest: { rebalance: 'weekly', groups: 5, fees: true },
  });
  const r = runModel(m);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.result.rebalanceEvery, 5, 'weekly → 5 根');
  assert.deepStrictEqual(r.plan.transforms, [{ type: 'winsorize', args: { method: 'mad', n: 3 } }]);
  assert.strictEqual(r.plan.filters.length, 1);
  assert.strictEqual(r.plan.factors.length, 1);
  assert.strictEqual(r.result.factorExprMeta.composite, true);
});

test('端到端：同一模型两次执行 → 同指纹且同净值（复现承诺）', (t) => {
  if (skip(t)) return;
  const m = model({
    factors: [{ id: 'a', expr: 'mom20', weight: 1, direction: 1 }, { id: 'b', expr: 'vol20', weight: -0.5, direction: 1 }],
    transforms: [{ type: 'zscore' }],
  });
  const a = runModel(m);
  const b = runModel(m);
  assert.strictEqual(a.ok && b.ok, true);
  assert.strictEqual(a.fingerprint, b.fingerprint);
  assert.deepStrictEqual(a.result.equity, b.result.equity);
  assert.strictEqual(a.result.totalReturn, b.result.totalReturn);
});
