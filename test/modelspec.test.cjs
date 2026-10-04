// ─────────────────────────────────────────────────────────────
// Model JSON v1 规范与校验器测试（Phase 1 · 模型工坊）
//
//   三类断言：
//     1. 通过性：合法模型 → ok=true，默认值按规范填充。
//     2. 拒绝性：一切越界输入必须**显式报错**（未知键/未知算子/越界取值/
//        保留能力 expr_predicate）——静默忽略是不可接受的（用户会以为生效）。
//     3. 一致性锁：本模块的 PRESET_FACTORS 必须与 crosssect.FACTOR_WINDOWS
//        完全一致；白名单字段必须与归档真实字段一致。
//        参照 shared/rsi.mjs 的单一实现纪律。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ms = require('../shared/modelspec.cjs');
const crosssect = require('../server/crosssect.cjs');
const fe = require('../server/factorexpr.cjs');

const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);

/** 最小合法模型 */
const base = () => ({
  schemaVersion: 1,
  name: '20日动量',
  factors: [{ id: 'mom20', expr: 'mom20', weight: 1, direction: 1 }],
  meta: { author: 'tester' },
});

const errPaths = (r) => r.errors.map((e) => e.path);
const hasErr = (r, pathFragment) => r.errors.some((e) => e.path.includes(pathFragment));

// ── 1. 通过性 ────────────────────────────────────────────────
test('合法最小模型通过校验', () => {
  const r = ms.validateModel(base());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('normalizeModel 填默认值：combine/universe/backtest/meta.tags', () => {
  const r = ms.normalizeModel(base());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.model.combine.method, 'weighted_sum');
  assert.strictEqual(r.model.universe.type, 'core_pool');
  assert.strictEqual(r.model.backtest.rebalance, 'monthly');
  assert.strictEqual(r.model.backtest.groups, 5);
  assert.strictEqual(r.model.backtest.fees, true);
  assert.deepStrictEqual(r.model.meta.tags, []);
  assert.deepStrictEqual(r.model.transforms, []);
  assert.deepStrictEqual(r.model.filters, []);
});

test('未声明 weight 时按等权并给出 warning（不报错）', () => {
  const m = base();
  delete m.factors[0].weight;
  const r = ms.normalizeModel(m);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.model.factors[0].weight, 1);
  assert.ok(r.warnings.some((w) => w.path === 'factors'), '应提示等权处理');
});

test('完整模型（多因子 + 预处理 + 过滤 + 标签）通过', () => {
  const m = {
    schemaVersion: 1,
    name: '动量+低波动',
    hypothesis: '短期动量在低波动股上更持续',
    factors: [
      { id: 'mom20', expr: 'mom20', weight: 1, direction: 1 },
      { id: 'vol20', expr: 'vol20', weight: -0.5, direction: -1 },
      { id: 'spread', expr: 'mom60 - mom20', weight: 0.3, direction: 1 },
    ],
    transforms: [
      { type: 'winsorize', args: { method: 'mad', n: 3 } },
      { type: 'zscore' },
      { type: 'rank' },
      { type: 'fill_missing', args: { method: 'cross_mean' } },
    ],
    combine: { method: 'weighted_sum' },
    filters: [{ type: 'field_range', field: 'amount', min: 1e8 }],
    universe: { type: 'core_pool' },
    backtest: { rebalance: 'weekly', groups: 5, fees: true },
    meta: { author: 'tester', tags: ['momentum', '低波动'] },
  };
  const r = ms.normalizeModel(m, { parseExpr: fe.parseExpression });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.model.factors.length, 3);
  assert.strictEqual(r.model.backtest.rebalance, 'weekly');
  assert.strictEqual(ms.rebalanceBars('weekly'), 5);
  assert.strictEqual(ms.rebalanceBars('monthly'), 20);
  assert.strictEqual(ms.rebalanceBars('daily'), 1);
});

// ── 2. 拒绝性 ────────────────────────────────────────────────
test('拒绝：非对象输入', () => {
  for (const bad of [null, 42, 'x', []]) {
    const r = ms.validateModel(bad);
    assert.strictEqual(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('拒绝：schemaVersion 不为 1', () => {
  const m = base();
  m.schemaVersion = 2;
  const r = ms.validateModel(m);
  assert.strictEqual(r.ok, false);
  assert.ok(hasErr(r, 'schemaVersion'));
});

test('拒绝：未知顶层字段（不得静默忽略）', () => {
  const m = base();
  m.leverage = 3;
  const r = ms.validateModel(m);
  assert.strictEqual(r.ok, false);
  assert.ok(hasErr(r, 'leverage'));
});

test('拒绝：name 缺失 / 超长', () => {
  const a = base(); delete a.name;
  assert.ok(hasErr(ms.validateModel(a), 'name'));
  const b = base(); b.name = 'x'.repeat(61);
  assert.ok(hasErr(ms.validateModel(b), 'name'));
});

test('拒绝：factors 为空 / 超上限 / 因子非对象', () => {
  const a = base(); a.factors = [];
  assert.ok(hasErr(ms.validateModel(a), 'factors'));
  const b = base();
  b.factors = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, expr: 'mom20' }));
  assert.ok(hasErr(ms.validateModel(b), 'factors'));
  const c = base(); c.factors = ['mom20'];
  assert.ok(hasErr(ms.validateModel(c), 'factors[0]'));
});

test('拒绝：expr 缺失 / 含危险字符（无解析器时字符级校验）', () => {
  const a = base(); a.factors[0].expr = '';
  assert.ok(hasErr(ms.validateModel(a), 'factors[0].expr'));
  const c = base(); c.factors[0].expr = 'close;rm -rf /';
  assert.ok(hasErr(ms.validateModel(c), 'factors[0].expr'), '分号等危险字符必须拒绝');
  const d = base(); d.factors[0].expr = 'close`x`';
  assert.ok(hasErr(ms.validateModel(d), 'factors[0].expr'), '反引号必须拒绝');
});

test('无解析器时：字符级通过但未经 AST 验证 → 必须给出 warning（不得静默当合法）', () => {
  const m = base();
  m.factors[0].expr = 'foo(1)'; // 字符级合法、但 foo 不是白名单算子
  const r = ms.validateModel(m);
  assert.strictEqual(r.ok, true, '字符级无法判定，不应报错');
  assert.ok(
    r.warnings.some((w) => w.path.includes('expr') && /未经 AST/.test(w.message)),
    '必须显式提示未经验证',
  );
});

test('注入解析器后：foo(1) 被真实拒绝（证明 warning 不是摆设）', () => {
  const m = base();
  m.factors[0].expr = 'foo(1)';
  const r = ms.validateModel(m, { parseExpr: fe.parseExpression });
  assert.strictEqual(r.ok, false);
  assert.ok(hasErr(r, 'factors[0].expr'));
});

test('注入解析器后：非法表达式被真实拒绝（如未知算子）', () => {
  const m = base();
  m.factors[0].expr = 'foo(20)';
  const r = ms.validateModel(m, { parseExpr: fe.parseExpression });
  assert.strictEqual(r.ok, false);
  assert.ok(hasErr(r, 'factors[0].expr'));
});

test('注入解析器后：合法表达式通过（mom60 - mom20）', () => {
  const m = base();
  m.factors[0].expr = 'mom60 - mom20';
  const r = ms.validateModel(m, { parseExpr: fe.parseExpression });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('拒绝：weight 为 0 / 非数字 / 超上限', () => {
  const a = base(); a.factors[0].weight = 0;
  assert.ok(hasErr(ms.validateModel(a), 'weight'));
  const b = base(); b.factors[0].weight = 'x';
  assert.ok(hasErr(ms.validateModel(b), 'weight'));
  const c = base(); c.factors[0].weight = 1e4;
  assert.ok(hasErr(ms.validateModel(c), 'weight'));
});

test('拒绝：direction 非 ±1', () => {
  const m = base();
  m.factors[0].direction = 0;
  assert.ok(hasErr(ms.validateModel(m), 'direction'));
});

test('拒绝：因子 id 重复 / 非法字符', () => {
  const a = base();
  a.factors = [{ id: 'x', expr: 'mom20' }, { id: 'x', expr: 'rev20' }];
  assert.ok(hasErr(ms.validateModel(a), 'factors[1].id'));
  const b = base();
  b.factors[0].id = 'has space';
  assert.ok(hasErr(ms.validateModel(b), 'factors[0].id'));
});

test('拒绝：未知预处理算子 / 越界参数', () => {
  const a = base(); a.transforms = [{ type: 'pca' }];
  assert.ok(hasErr(ms.validateModel(a), 'transforms[0].type'));
  const b = base(); b.transforms = [{ type: 'winsorize', args: { method: 'iqr' } }];
  assert.ok(hasErr(ms.validateModel(b), 'transforms[0].args.method'));
  const c = base(); c.transforms = [{ type: 'winsorize', args: { n: 999 } }];
  assert.ok(hasErr(ms.validateModel(c), 'transforms[0].args.n'));
  const d = base(); d.transforms = [{ type: 'zscore', args: { foo: 1 } }];
  assert.ok(hasErr(ms.validateModel(d), 'transforms[0].args.foo'));
});

test('拒绝：combine 非 weighted_sum', () => {
  const m = base();
  m.combine = { method: 'ic_weighted' };
  assert.ok(hasErr(ms.validateModel(m), 'combine.method'));
});

test('保留能力 expr_predicate 必须**显式报错**，不得静默忽略', () => {
  const m = base();
  m.filters = [{ type: 'expr_predicate', expr: 'amount > 1e8' }];
  const r = ms.validateModel(m);
  assert.strictEqual(r.ok, false);
  assert.ok(hasErr(r, 'filters[0]'), '应报错而不是忽略');
  assert.match(r.errors.find((e) => e.path === 'filters[0]').message, /v1 不支持/);
});

test('拒绝：filter 未知字段 / 未知类型 / 缺边界 / min>max', () => {
  const a = base(); a.filters = [{ type: 'field_range', field: 'pe_ttm', min: 1 }];
  assert.ok(hasErr(ms.validateModel(a), 'filters[0].field'), 'pe_ttm 不在归档字段白名单');
  const b = base(); b.filters = [{ type: 'quantile', field: 'amount' }];
  assert.ok(hasErr(ms.validateModel(b), 'filters[0].type'));
  const c = base(); c.filters = [{ type: 'field_range', field: 'amount' }];
  assert.ok(hasErr(ms.validateModel(c), 'filters[0]'));
  const d = base(); d.filters = [{ type: 'field_range', field: 'amount', min: 10, max: 1 }];
  assert.ok(hasErr(ms.validateModel(d), 'filters[0]'));
  const e = base(); e.filters = [{ type: 'field_range', field: 'amount', value: 5 }];
  assert.ok(hasErr(ms.validateModel(e), 'op'), 'value 必须配 op');
});

test('拒绝：universe / backtest 越界', () => {
  const a = base(); a.universe = { type: 'all_market' };
  assert.ok(hasErr(ms.validateModel(a), 'universe.type'));
  const b = base(); b.backtest = { rebalance: 'hourly' };
  assert.ok(hasErr(ms.validateModel(b), 'backtest.rebalance'));
  const c = base(); c.backtest = { groups: 20 };
  assert.ok(hasErr(ms.validateModel(c), 'backtest.groups'));
  const d = base(); d.backtest = { fees: 'yes' };
  assert.ok(hasErr(ms.validateModel(d), 'backtest.fees'));
});

test('拒绝：meta.author 缺失 / tags 非法', () => {
  const a = base(); delete a.meta;
  assert.ok(hasErr(ms.validateModel(a), 'meta'));
  const b = base(); b.meta = {};
  assert.ok(hasErr(ms.validateModel(b), 'meta.author'));
  const c = base(); c.meta = { author: 't', tags: ['ok', 'has space'] };
  assert.ok(hasErr(ms.validateModel(c), 'meta.tags[1]'));
});

// ── 3. 一致性锁 ──────────────────────────────────────────────
test('锁：PRESET_FACTORS 与 crosssect.FACTOR_WINDOWS 完全一致', () => {
  const fromEngine = Object.keys(crosssect.FACTOR_WINDOWS).sort();
  const fromSpec = [...ms.PRESET_FACTORS].sort();
  assert.deepStrictEqual(fromSpec, fromEngine, '预置因子清单分叉——必须同步 modelspec 与 crosssect');
});

test('锁：FILTER_FIELDS 必须是归档真实字段的子集（不得臆造字段名）', () => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const f = fs.readdirSync(REAL_DIR).find((x) => x.endsWith('.json'));
  assert.ok(f, '归档目录应有 json 文件');
  const doc = JSON.parse(fs.readFileSync(path.join(REAL_DIR, f), 'utf8'));
  const realFields = new Set(Object.keys(doc.rows[0]));
  const runtimeDerived = new Set(['adjClose', 'adjOpen']); // crosssect.withAdjustedPrices 运行时派生
  for (const field of ms.FILTER_FIELDS) {
    assert.ok(
      realFields.has(field) || runtimeDerived.has(field),
      `字段「${field}」既不在归档也不在运行时派生清单中（臆造字段名）`,
    );
  }
});

test('锁：canonicalJSON 与键序无关（同模型 → 同字符串）', () => {
  const a = { schemaVersion: 1, name: 'x', meta: { author: 'a', tags: [] } };
  const b = { meta: { tags: [], author: 'a' }, name: 'x', schemaVersion: 1 };
  assert.strictEqual(ms.canonicalJSON(a), ms.canonicalJSON(b));
});

// ── 4. 接链：规范化的模型能驱动引擎 ─────────────────────────
test('接链：规范化模型的因子表达式可直接喂给 runCrossBacktest', () => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const m = {
    schemaVersion: 1,
    name: '接链验证',
    factors: [{ id: 'spread', expr: 'mom60 - mom20', weight: 1, direction: 1 }],
    meta: { author: 'tester' },
  };
  const r = ms.normalizeModel(m, { parseExpr: fe.parseExpression });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const bt = crosssect.runCrossBacktest({
    factor: r.model.factors[0].expr,
    topN: 5,
    rebalanceEvery: ms.rebalanceBars(r.model.backtest.rebalance),
    capital: 1_000_000,
  });
  assert.ok(!bt.error, `引擎应接受该表达式，实际：${bt.error}`);
  assert.ok(Array.isArray(bt.equity) && bt.equity.length > 5, '应产出净值序列');
});
