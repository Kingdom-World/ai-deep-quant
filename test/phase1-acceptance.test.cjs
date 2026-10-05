// ─────────────────────────────────────────────────────────────
// Phase 1 验收门（模型工坊）—— 「建模型 → 回测 → 存档 → 同指纹重跑结果一致」
//
//   为什么单独成文件：这是计划书 Phase 1 的**验收判据**，而不是普通单测。
//   它回答一个对外承诺级别的问题：**同一个模型，任何时候重跑，结果是否逐字段一致？**
//   「同指纹 ⇒ 同结果」此前只写在注释与产品文案里 —— 本文件把它变成机器可验的断言。
//
//   🔴 关键设计：**用合成归档**（LOCAL_HISTORY_DIR 指向临时目录）而不是真实归档。
//     真实归档被 gitignore，CI 上没有 ⇒ 依赖它的测试只能 skip，等于没有保护。
//     合成归档让本文件在任何环境都能跑，也顺便把「引擎对一组完全已知的输入
//     产出完全已知的输出」钉死成黄金样本（golden sample）。
//
//   ⚠️ 黄金样本红了怎么办：先判断是「引擎数值口径变了」还是「纯属抖动」。
//     口径变更（含 ENGINE_VERSION 变更）属于**有意的破坏性改动**，必须
//     重新核对数值合理性后**显式更新本文件的 GOLDEN**，不得为了让测试变绿而放宽断言。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ARCHIVE = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-accept-arch-'));
const EXPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-accept-exp-'));
process.env.LOCAL_HISTORY_DIR = ARCHIVE; // crosssect 在调用时读取，故此处设置即生效
process.env.MODEL_EXP_DIR = EXPDIR;
delete process.env.DATABASE_URL; // 强制走文件后端，避免测试触及真实库

const { runModel, ENGINE_VERSION } = require('../server/modelrun.cjs');
const modelspec = require('../shared/modelspec.cjs');
const fe = require('../server/factorexpr.cjs');
const modelexp = require('../server/modelexperiments.cjs');

test.after(() => {
  for (const d of [ARCHIVE, EXPDIR]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ── 合成归档：8 只 × 200 个交易日，价格路径完全确定 ──────────
//   每只标的给不同斜率（横截面动量有区分度）+ 不同相位的正弦扰动
//   （避免走势过于完美导致「只有一只值得买」的退化情形）。
const N_BARS = 200;
const CODES = ['sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005', 'sh600006', 'sh600007', 'sh600008'];

function genDates(n) {
  const out = [];
  const d = new Date(Date.UTC(2025, 0, 1));
  while (out.length < n) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); // 只取工作日
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const DATES = genDates(N_BARS);

function writeStock(code, k) {
  const rows = DATES.map((date, i) => {
    const trend = 1 + k * 0.0025 * i;
    const wave = 1 + 0.05 * Math.sin((i + k * 13) / 11);
    const close = +(10 * trend * wave).toFixed(4);
    return {
      date,
      open: +(close * 0.998).toFixed(4),
      close,
      high: +(close * 1.01).toFixed(4),
      low: +(close * 0.99).toFixed(4),
      volume: 1000,
    };
  });
  // factors: [] ⇒ 引擎走 adjFallback（adjClose = close），合成数据无除权，等价且更可控
  fs.writeFileSync(path.join(ARCHIVE, `${code}.json`), JSON.stringify({ code, adjust: 'none+factor', rows, factors: [] }));
}
CODES.forEach((c, k) => writeStock(c, k));

// ── 验收用的基准模型：覆盖 多因子 + 预处理 + 过滤器 + 计费 + 月度调仓 ──
const MODEL = {
  schemaVersion: 1,
  name: '验收基准模型',
  hypothesis: '合成归档上的确定性基准（Phase 1 验收门）',
  factors: [
    { id: 'trend', expr: 'mom60', weight: 1, direction: 1 },
    { id: 'short', expr: 'mom20', weight: 0.5, direction: 1 },
  ],
  transforms: [{ type: 'winsorize', args: { method: 'mad', n: 3 } }, { type: 'zscore' }],
  filters: [{ type: 'field_range', field: 'close', min: 1 }],
  backtest: { rebalance: 'monthly', groups: 5, fees: true },
  meta: { author: 'acceptance' },
};

// ── 黄金样本：由合成归档完全决定，跨机器可复现 ──
const GOLDEN = {
  engineVersion: 'crosssect-m1.0',
  fingerprint: 'f1f96686db51cd2e70d2dc8595422e73bfa0686e2501cbb619e8e25458c28f97',
  universeSize: 8,
  benchmarkUniverse: 8,
  range: { start: '2025-03-27', end: '2025-10-07', bars: 139 },
  rebalances: 7,
  fills: 9,
  totalReturn: 92.74,
  annualized: 228.59,
  maxDrawdownPct: 0.08,
  sharpe: 112.54,
  benchmarkReturn: 70.25,
  totalFees: 2267.24,
  feeRatePct: 0.057,
  turnover: 3989825.9,
  finalValue: 1927428.44,
  ic: { icMean: 0.369048, icStd: 0.169533, icir: 2.176846, icPositiveRate: 1, n: 6, t: 5.3942, degraded: false },
  equityLen: 29,
  equityFirst: { date: '2025-03-27', value: 1000740.62 },
  equityLast: { date: '2025-10-07', value: 1927428.44 },
};

const EPS = 1e-6;
const closeTo = (actual, expected, label) =>
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= EPS,
    `${label}：黄金样本 ${expected}，实际 ${actual}（差 ${typeof actual === 'number' ? (actual - expected).toExponential(2) : 'N/A'}）`,
  );

// ── 验收① 建模型：规范层必须接受它 ────────────────────────────
test('验收① 建模型：基准模型通过权威校验（0 error / 0 warning）', () => {
  const r = modelspec.normalizeModel(MODEL, { parseExpr: fe.parseExpression });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.warnings.length, 0, `不应有 warning：${JSON.stringify(r.warnings)}`);
});

// ── 验收② 回测：数值命中黄金样本 ──────────────────────────────
test('验收② 回测：跑通且全部关键数值命中黄金样本', () => {
  const r = runModel(MODEL);
  assert.strictEqual(r.ok, true, `${r.stage}: ${r.error} ${JSON.stringify(r.issues || [])}`);

  // 引擎版本变了就必须有意重冻黄金样本（指纹本应随之改变）——故这里也是断言的
  assert.strictEqual(r.engineVersion, GOLDEN.engineVersion, 'ENGINE_VERSION 变更 ⇒ 需重新核对并更新黄金样本');
  assert.strictEqual(r.fingerprint, GOLDEN.fingerprint, '实验指纹偏离黄金样本');

  const s = r.result;
  assert.strictEqual(s.universeSize, GOLDEN.universeSize);
  assert.strictEqual(s.benchmarkUniverse, GOLDEN.benchmarkUniverse);
  assert.deepStrictEqual(s.range, GOLDEN.range, '区间/根数（bars）偏离黄金样本');
  assert.strictEqual(s.rebalances, GOLDEN.rebalances);
  assert.strictEqual(s.fills, GOLDEN.fills);

  closeTo(s.totalReturn, GOLDEN.totalReturn, 'totalReturn');
  closeTo(s.annualized, GOLDEN.annualized, 'annualized');
  closeTo(s.maxDrawdownPct, GOLDEN.maxDrawdownPct, 'maxDrawdownPct');
  closeTo(s.sharpe, GOLDEN.sharpe, 'sharpe');
  closeTo(s.benchmarkReturn, GOLDEN.benchmarkReturn, 'benchmarkReturn');
  closeTo(s.totalFees, GOLDEN.totalFees, 'totalFees');
  closeTo(s.feeRatePct, GOLDEN.feeRatePct, 'feeRatePct');
  closeTo(s.turnover, GOLDEN.turnover, 'turnover');
  closeTo(s.finalValue, GOLDEN.finalValue, 'finalValue');

  assert.strictEqual(s.ic.n, GOLDEN.ic.n, 'IC 期数');
  closeTo(s.ic.icMean, GOLDEN.ic.icMean, 'ic.icMean');
  closeTo(s.ic.icStd, GOLDEN.ic.icStd, 'ic.icStd');
  closeTo(s.ic.icir, GOLDEN.ic.icir, 'ic.icir');
  closeTo(s.ic.icPositiveRate, GOLDEN.ic.icPositiveRate, 'ic.icPositiveRate');
  closeTo(s.ic.t, GOLDEN.ic.t, 'ic.t');
  assert.strictEqual(s.ic.degraded, GOLDEN.ic.degraded);

  // 净值序列形状是**对外契约**（前端画图直接消费）：抽稀规则变了会静默改变图表点数
  assert.strictEqual(s.equity.length, GOLDEN.equityLen, 'equity 抽稀规则（每 5 根 + 末根）变化');
  assert.deepStrictEqual(s.equity[0], GOLDEN.equityFirst);
  assert.deepStrictEqual(s.equity[s.equity.length - 1], GOLDEN.equityLast);
  assert.ok(s.benchmark.length > 0, '基准序列必须存在（前端虚线依赖）');
});

// ── 验收③ 复现承诺：同模型重跑逐字段一致 ──────────────────────
test('验收③ 复现承诺：同模型重跑 → 同指纹，且结果逐字段一致', () => {
  const a = runModel(MODEL);
  const b = runModel(MODEL);
  assert.strictEqual(a.ok && b.ok, true);
  assert.strictEqual(a.fingerprint, b.fingerprint, '同定义必须同指纹');
  // 逐字段深比：净值/基准抽稀序列 + 全部指标 + IC 摘要（含显著性）
  assert.deepStrictEqual(a.result.equity, b.result.equity, '净值序列出现漂移');
  assert.deepStrictEqual(a.result.benchmark, b.result.benchmark, '基准序列出现漂移');
  assert.deepStrictEqual(a.result.ic, b.result.ic, 'IC 摘要出现漂移');
  assert.deepStrictEqual(a.result.priceBasis, b.result.priceBasis, '口径自述出现漂移');
  for (const k of ['totalReturn', 'annualized', 'maxDrawdownPct', 'sharpe', 'finalValue', 'turnover', 'totalFees', 'fills', 'rebalances']) {
    assert.strictEqual(a.result[k], b.result[k], `${k} 出现漂移`);
  }
});

// ── 验收④ 跨实例复现（同进程重跑测不出模块级状态泄漏）────────
//   ⚠️ 本项需要派生子进程。若运行环境禁止派生（实测本机沙箱下连最简 spawn 都 EBUSY），
//      显式跳过并说明"哪一项没被验证"，**绝不用假断言冒充通过**。
//      同类风险由「验收④b 运行顺序无关性」在本进程内覆盖。
test('验收④ 跨实例复现：换一个进程重跑 → 仍同指纹同数值', () => {
  const script = path.join(os.tmpdir(), `p1-accept-child-${process.pid}-${Date.now()}.cjs`);
  fs.writeFileSync(
    script,
    [
      `process.env.LOCAL_HISTORY_DIR = ${JSON.stringify(ARCHIVE)};`,
      `process.env.MODEL_EXP_DIR = ${JSON.stringify(EXPDIR)};`,
      `delete process.env.DATABASE_URL;`,
      `const { runModel } = require(${JSON.stringify(path.join(ROOT, 'server', 'modelrun.cjs'))});`,
      `const r = runModel(${JSON.stringify(MODEL)});`,
      `if (!r.ok) { console.error('CHILD_FAILED', r.stage, r.error); process.exit(2); }`,
      `console.log(JSON.stringify({ fp: r.fingerprint, tr: r.result.totalReturn, fills: r.result.fills, eq: r.result.equity.length }));`,
    ].join('\n'),
    'utf8',
  );
  let out = null;
  try {
    out = execFileSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  } catch (e) {
    // 区分「环境不允许派生」与「子进程真的跑失败」：后者是产品缺陷，必须让测试红
    const spawned = typeof e.status === 'number'; // status 存在 ⇒ 子进程确实起来了
    if (!spawned && /EBUSY|EPERM|EACCES|ENOTSUP/.test(`${e.code} ${e.message}`)) {
      console.log(`[skip] 当前环境禁止派生子进程（${e.code}）—— 跨进程复现未验证；同类风险已由「验收③ 同进程重跑一致」与「验收④b 运行顺序无关性」覆盖。`);
      return;
    }
    throw e;
  } finally {
    try {
      fs.rmSync(script, { force: true });
    } catch {
      /* ignore */
    }
  }
  const got = JSON.parse(out.trim().split('\n').pop());
  assert.strictEqual(got.fp, GOLDEN.fingerprint, '另一进程算出的指纹不同 —— 存在进程内状态泄漏或未固定因素');
  closeTo(got.tr, GOLDEN.totalReturn, '另一进程的 totalReturn');
  assert.strictEqual(got.fills, GOLDEN.fills);
  assert.strictEqual(got.eq, GOLDEN.equityLen);
});

// ── 验收④b 运行顺序无关性（不依赖 spawn 的"状态污染"探针）────
//   跨进程不一致的最常见成因是"上一次运行残留影响了这一次"（缓存键碰撞、
//   模块级累加器、可变默认参数…）。顺序无关性正是它的进程内等价检查：
//   夹在两个**不同**模型之间再跑基准模型，结果必须与首次完全相同。
test('验收④b 状态无污染：夹在其它模型之间重跑，结果与首次完全一致', () => {
  const first = runModel(MODEL);
  assert.strictEqual(first.ok, true, first.error);

  // 制造"污染压力"：不同因子窗口 / 不同调仓 / 不同因子数 / 会改变分组数的模型
  runModel({ ...MODEL, factors: [{ id: 'a', expr: 'mom120', weight: -1, direction: 1 }] });
  runModel({ ...MODEL, backtest: { rebalance: 'weekly', groups: 10, fees: false } });
  runModel({ ...MODEL, transforms: [{ type: 'rank' }], filters: [] });
  runModel({ ...MODEL, factors: [{ id: 'a', expr: 'mom20 - mom60', weight: 2, direction: -1 }] });

  const again = runModel(MODEL);
  assert.strictEqual(again.fingerprint, first.fingerprint, '指纹受前序运行影响 ⇒ 存在状态污染');
  assert.deepStrictEqual(again.result.equity, first.result.equity, '净值受前序运行影响 ⇒ 存在状态污染');
  assert.deepStrictEqual(again.result.ic, first.result.ic, 'IC 受前序运行影响 ⇒ 存在状态污染');
  assert.strictEqual(again.result.totalReturn, first.result.totalReturn);
  assert.strictEqual(again.result.fills, first.result.fills);
});

// ── 验收⑤ 存档 → 由快照重跑（实验是复现的载体）────────────────
test('验收⑤ 存档复现：留痕后由模型快照重跑 → 同指纹同数值', async () => {
  const run = runModel(MODEL);
  assert.strictEqual(run.ok, true, run.error);

  const rec = await modelexp.record('accept_user', {
    model: run.model,
    plan: run.plan,
    fingerprint: run.fingerprint,
    engineVersion: run.engineVersion,
    modelHash: require('../server/modelrun.cjs').modelHash(run.model),
    result: run.result,
  });
  assert.strictEqual(rec.ok, true, rec.error);

  const doc = await modelexp.get(rec.id, 'accept_user');
  assert.ok(doc && doc.modelSnapshot, '存档必须带模型快照，否则"当时那个模型"就丢了');
  assert.strictEqual(doc.modelHash, require('../server/modelrun.cjs').modelHash(run.model), '存档哈希必须与原模型一致');

  // 🔴 复现闭环：只凭存档里的快照重跑
  const replay = runModel(doc.modelSnapshot);
  assert.strictEqual(replay.ok, true, replay.error);
  assert.strictEqual(replay.fingerprint, run.fingerprint, '存档快照重跑指纹不同 ⇒ 复现承诺失效');
  assert.deepStrictEqual(replay.result.equity, run.result.equity);
  assert.deepStrictEqual(replay.result.ic, run.result.ic);
  assert.strictEqual(replay.result.totalReturn, run.result.totalReturn);

  // 且存档里的指标与重跑一致（记录不会"悄悄对不上"）
  assert.strictEqual(doc.metrics.totalReturn, run.result.totalReturn);
  assert.strictEqual(doc.metrics.fills, run.result.fills);
});

// ── 验收⑥ 指纹只认语义 ────────────────────────────────────────
test('验收⑥ 指纹只认语义：改标题不改指纹与数值；改权重必须改指纹', () => {
  const renamed = runModel({ ...MODEL, name: '换了个标题', hypothesis: '换了假设', meta: { author: 'someone-else' } });
  const base = runModel(MODEL);
  assert.strictEqual(renamed.fingerprint, base.fingerprint, 'name/hypothesis/meta 属非语义字段，不得影响指纹');
  assert.strictEqual(renamed.result.totalReturn, base.result.totalReturn, '非语义字段不得影响数值');

  const heavier = runModel({
    ...MODEL,
    factors: [
      { id: 'trend', expr: 'mom60', weight: 2, direction: 1 },
      { id: 'short', expr: 'mom20', weight: 0.5, direction: 1 },
    ],
  });
  assert.strictEqual(heavier.ok, true, heavier.error);
  assert.notStrictEqual(heavier.fingerprint, base.fingerprint, '权重是语义核心，必须改变指纹');
});

test('ENGINE_VERSION 与黄金样本同步（变更引擎必须显式重冻样本）', () => {
  assert.strictEqual(ENGINE_VERSION, GOLDEN.engineVersion);
});
