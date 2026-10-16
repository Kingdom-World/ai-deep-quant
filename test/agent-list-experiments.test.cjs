'use strict';
// ─────────────────────────────────────────────────────────────
// Agent 工具 list_experiments 测试（Phase 3 · 让助手能「读历史」）
//
// 背景（plans/master-plan.md Phase 3）：
//   研究助手的价值是"读实验/因子/报告做解读"。此前 8 个工具全在单标的层，
//   没有一个是读 Phase 1/2 产物的 ⇒ 新增本工具。
//
// 🔴 测试用**注入的假数据**，不读 `data/experiments.jsonl`：
//   该目录在 .gitignore 内（运行时数据），CI 环境（git archive）里并不存在 ——
//   依赖它会让测试在 CI 红、在本地绿。
//
// 🔴 两条最关键的断言：
//   ① **口径**：指标已是百分数（12.34 表示 12.34%），**不得再乘 100**。
//      这条口径来自 src/pages/research/ExperimentsTab.tsx（前端直接拼 `%`）。
//      写错会让所有数值差 100 倍，且"看起来完全正常"。
//   ② **equityThumb 必须剔除**：它是 200 点的图表缩略曲线，
//      对模型叙述无用，混进上下文会大量挤占推理空间。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createToolbox } = require(path.join(__dirname, '..', 'server', 'agent', 'toolbox.cjs'));

/** 固定假数据：两条，故意含 equityThumb 与 null 指标 */
const ROWS = [
  {
    ts: '2026-10-01T08:00:00.000Z',
    symbol: 'sh600519', strategy: 'ma', market: 'CN',
    params: { fast: 5, slow: 20, market: 'CN' },
    range: { start: '2024-01-01', end: '2026-09-30' },
    metrics: { totalReturn: 12.34, annualized: 5.67, maxDrawdownPct: 8.9, sharpe: 1.23, tradeCount: 42 },
    equityThumb: [{ d: '2024-01-01', v: 1 }, { d: '2026-09-30', v: 1.1234 }],
    note: '测试夹具',
  },
  {
    ts: '2026-09-15T08:00:00.000Z',
    symbol: 'usAAPL', strategy: 'ma', market: 'US',
    params: { fast: 10, slow: 30 },
    range: null,
    metrics: { totalReturn: -3.5, annualized: -2.1, maxDrawdownPct: 15, sharpe: null, tradeCount: 7 },
  },
];

/** 用可观察的假 deps 建工具箱 */
function makeToolbox(rows = ROWS, spy = {}) {
  const tb = createToolbox({
    listExperiments: (limit, filters) => {
      spy.limit = limit;
      spy.filters = filters;
      let out = rows;
      if (filters && filters.symbol) out = out.filter((r) => r.symbol === filters.symbol);
      if (filters && filters.strategy) out = out.filter((r) => r.strategy === filters.strategy);
      return out.slice(0, limit);
    },
  });
  return tb;
}
const toolOf = (tb) => tb.tools.find((t) => t.name === 'list_experiments');

test('前置：工具已在工具箱中，且 spec 契约完整（模型按位置传参，顺序即签名）', () => {
  const tb = makeToolbox();
  const spec = tb.spec.find((s) => s.name === 'list_experiments');
  assert.ok(spec, 'spec 中必须存在 list_experiments');
  assert.ok(spec.desc && spec.desc.length > 20, 'desc 必须让模型能判断何时该用');
  assert.deepStrictEqual(
    spec.params.map((p) => p.name),
    ['symbol', 'strategy', 'limit'],
    '参数顺序即模型的位置传参签名，不得随意调整',
  );
  assert.strictEqual(spec.params[0].required, false, '过滤参数应为可选');
  assert.strictEqual(spec.params[2].type, 'number');
});

test('🔴 口径：指标是百分数，绝不能再乘 100', async () => {
  const r = await toolOf(makeToolbox()).run({ limit: 5 });
  assert.strictEqual(r.ok, true);
  // 12.34 应原样呈现为 12.34%——若被乘 100 会变成 1234%
  assert.match(r.summary, /总收益=12\.34%/, `百分数被改动了：${r.summary}`);
  assert.ok(!/1234/.test(r.summary), 'summary 中出现了被乘 100 的数值');
  assert.match(r.summary, /最大回撤=8\.90%/);
});

test('🔴 equityThumb 必须从 data 中剔除（防上下文爆炸）', async () => {
  const r = await toolOf(makeToolbox()).run({ limit: 5 });
  assert.ok(!JSON.stringify(r.data).includes('equityThumb'),
    'data 中不得含 equityThumb —— 200 点曲线会挤占模型推理空间');
  // 但关键字段必须在
  assert.strictEqual(r.data[0].symbol, 'sh600519');
  assert.strictEqual(r.data[0].metrics.totalReturn, 12.34);
  assert.deepStrictEqual(r.data[0].range, { start: '2024-01-01', end: '2026-09-30' });
});

test('无效指标呈现为 --，产出 NaN/null 假值（防模型复述假数）', async () => {
  const r = await toolOf(makeToolbox()).run({ limit: 5 });
  // 第二条 sharpe 是 null ⇒ 应不出现"夏普=null"或"夏普=NaN"
  assert.ok(!/夏普=null|夏普=NaN|夏普=undefined/.test(r.summary),
    `无效指标未被格式化：${r.summary}`);
  // 无 range 的记录应显示明确文案
  assert.match(r.summary, /区间未记录/);
});

test('过滤：symbol / strategy 会透传给数据层', async () => {
  const spy = {};
  await toolOf(makeToolbox(ROWS, spy)).run({ symbol: 'sh600519', strategy: 'ma' });
  assert.strictEqual(spy.filters.symbol, 'sh600519');
  assert.strictEqual(spy.filters.strategy, 'ma');
});

test('过滤无命中 → fail，且提示"可放宽条件"（失败也要能自我纠正）', async () => {
  const r = await toolOf(makeToolbox()).run({ symbol: 'sz000001' });
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /没有符合条件/);
  assert.match(r.summary, /放宽/, 'fail 消息必须给出下一步动作');
});

test('完全无记录 → fail，且引导先跑 run_backtest', async () => {
  const r = await toolOf(makeToolbox([])).run({});
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /还没有任何实验记录/);
  assert.match(r.summary, /run_backtest/, '应指明补充数据的途径');
});

test('limit 有上限 30（防止把上下文塞满）', async () => {
  const spy = {};
  await toolOf(makeToolbox(ROWS, spy)).run({ limit: 999 });
  assert.strictEqual(spy.limit, 30, 'limit 必须被夹到 30');
  const spy2 = {};
  await toolOf(makeToolbox(ROWS, spy2)).run({ limit: 0 });
  assert.ok(spy2.limit >= 1, 'limit 下限为 1');
});

test('deps 未接入 → fail（而不是抛异常中断整个循环）', async () => {
  const tb = createToolbox({}); // 不传 listExperiments
  const r = await toolOf(tb).run({});
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /未接入/);
});

test('返回带 dataFingerprint（供编排层做幂等判定 F3）', async () => {
  const r = await toolOf(makeToolbox()).run({ limit: 5 });
  assert.ok(r.dataFingerprint, '应带指纹');
  const r2 = await toolOf(makeToolbox()).run({ limit: 5 });
  // ⚠️ 必须用 deepStrictEqual：strictEqual 比的是**对象引用**，
  //    两个独立对象即使内容全同也永远不等（首次写成本测试时踩过）。
  assert.deepStrictEqual(r.dataFingerprint, r2.dataFingerprint,
    '同参数同数据 ⇒ 指纹内容应一致');
});

test('summary 携带引用要求（防跨实验混算）', async () => {
  const r = await toolOf(makeToolbox()).run({ limit: 5 });
  assert.match(r.summary, /引用要求/);
  assert.match(r.summary, /不得相加/, '必须明确禁止跨实验数值合并');
});
