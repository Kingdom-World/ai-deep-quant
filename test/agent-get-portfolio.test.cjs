'use strict';
// ─────────────────────────────────────────────────────────────
// Agent 工具 get_portfolio 测试（Phase 3 · 读组合暴露）
//
// 三条最关键的约束（都是"错了会很糟"的类型）：
//   ① **占比与集中度必须算对** —— 这是"暴露"的全部意义。
//      数值错（如把百分比当小数再乘 100）会让模型给出完全相反的判断。
//   ② **不得返回 equity / orders** —— accountSnapshot 里 equity 最多 500 条、
//      orders 最多 100 条，原样回灌会瞬间挤爆上下文。
//   ③ **熔断等级必须显式** —— ddLevel 决定"还能不能开新仓"（L1 禁新开、L2 锁定），
//      不给模型这一条，它可能建议用户加仓而实际会被风控拒绝。
//
// ⚠️ 用注入的假 deps，不读 data/（gitignore，CI 里不存在）。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createToolbox } = require(path.join(__dirname, '..', 'server', 'agent', 'toolbox.cjs'));

/** 真实结构的快照：总资产 100000，茅台 60000（60%）、平安 20000（20%）、现金 20000（20%） */
function makeSnap(over = {}) {
  return {
    cash: 20000, availableCash: 18000, reservedCash: 2000,
    initialCapital: 100000, marketValue: 80000, totalAssets: 100000,
    totalPnl: 5000, totalPnlPct: 5, todayPnl: 120,
    peakAssets: 110000, drawdownPct: 9.09, ddLevel: 0, riskLocked: false,
    positions: [
      { symbol: 'sh600519', name: '贵州茅台', qty: 100, avgCost: 500, lastPrice: 600, marketValue: 60000, sellableQty: 100, unrealizedPnl: 10000, unrealizedPct: 20 },
      { symbol: 'sz000001', name: '平安银行', qty: 2000, avgCost: 10, lastPrice: 10, marketValue: 20000, sellableQty: 1500, unrealizedPnl: 0, unrealizedPct: 0 },
    ],
    // 故意塞满：验证工具不会把它们带出去
    equity: Array.from({ length: 500 }, (_, i) => ({ t: `d${i}`, total: 1 })),
    orders: Array.from({ length: 100 }, (_, i) => ({ id: `o${i}` })),
    ...over,
  };
}
function makeTb(snap = makeSnap(), onCall = null) {
  return createToolbox({
    accountSnapshot: async () => { if (onCall) return onCall(); return snap; },
  });
}
const toolOf = (tb) => tb.tools.find((t) => t.name === 'get_portfolio');

test('前置：工具在箱中，spec 契约完整', () => {
  const spec = makeTb().spec.find((s) => s.name === 'get_portfolio');
  assert.ok(spec, 'spec 必须含 get_portfolio');
  assert.deepStrictEqual(spec.params.map((p) => p.name), ['top']);
  assert.match(spec.desc, /降级|退回成本价/, 'desc 必须标注行情降级口径（否则模型会把"退回成本价"读成"没涨没跌"）');
});

test('🔴 占比算对：60% / 20% / 现金 20%', async () => {
  const r = await toolOf(makeTb()).run({ top: 5 });
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /现金 ¥20000\.00（可用 ¥18000\.00，占 20\.00%）/);
  assert.match(r.summary, /持仓市值 ¥80000\.00（占 80\.00%）/);
  assert.match(r.summary, /贵州茅台 · 100 股 · 成本 500\.00 → 现价 600\.00 · 市值 ¥60000\.00（占 60\.00%）/);
  assert.match(r.summary, /平安银行.*（占 20\.00%）/);
});

test('🔴 集中度：最大持仓与前三大合计', async () => {
  const r = await toolOf(makeTb()).run({ top: 5 });
  assert.match(r.summary, /集中度：最大持仓 60\.00% · 前三大合计 80\.00% · 持仓只数 2/);
});

test('🔴 不得返回 equity / orders（分别可达 500 / 100 条）', async () => {
  const r = await toolOf(makeTb()).run({ top: 5 });
  const s = JSON.stringify(r.data);
  assert.ok(!s.includes('equity'), 'data 不得含 equity 序列');
  assert.ok(!s.includes('orders'), 'data 不得含 orders');
  assert.ok(!/d0|o0/.test(r.summary), 'summary 也不得带出这些数组的内容');
  // 但账户级与持仓必须在
  assert.strictEqual(r.data.totalAssets, 100000);
  assert.strictEqual(r.data.positionCount, 2);
});

test('🔴 熔断三态必须区分（决定"还能不能开新仓"）', async () => {
  const l0 = await toolOf(makeTb(makeSnap({ ddLevel: 0 }))).run({ top: 5 });
  assert.match(l0.summary, /回撤熔断等级 L0（正常，可开新仓）/);

  const l1 = await toolOf(makeTb(makeSnap({ ddLevel: 1 }))).run({ top: 5 });
  assert.match(l1.summary, /L1【L1：禁止新开仓，可卖出减仓】/);

  const l2 = await toolOf(makeTb(makeSnap({ ddLevel: 2, riskLocked: true }))).run({ top: 5 });
  assert.match(l2.summary, /L2【已锁定：新的开仓会被拒绝，可卖出减仓】/);
});

test('持仓按市值降序（暴露应先看占大头的）', async () => {
  const snap = makeSnap();
  snap.positions = [...snap.positions].reverse(); // 打乱顺序
  const r = await toolOf(makeTb(snap)).run({ top: 5 });
  const firstPos = r.summary.split('\n').find((l) => l.startsWith('1. '));
  assert.match(firstPos, /贵州茅台/, '市值最大的应排在第一条');
});

test('top 参数限制列出条数，并说明还有几只未列出', async () => {
  const r = await toolOf(makeTb()).run({ top: 1 });
  assert.match(r.summary, /（另有 1 只未列出/);
  assert.strictEqual(r.data.positions.length, 1, 'data 也应只给 top 只');
});

test('空持仓 ⇒ 明确说明全为现金（而不是空表）', async () => {
  const snap = makeSnap({ positions: [], marketValue: 0, totalAssets: 100000, cash: 100000 });
  const r = await toolOf(makeTb(snap)).run({ top: 5 });
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /当前无持仓（全部为现金）/);
});

test('不越界下结论：输出含"不要替用户下结论"的引用要求', async () => {
  const r = await toolOf(makeTb()).run({ top: 5 });
  assert.match(r.summary, /引用要求/);
  assert.match(r.summary, /不要替用户下/);
});

test('deps 未接入 / 抛错 / 返回空 ⇒ fail，不中断编排循环', async () => {
  const a = await toolOf(createToolbox({})).run({});
  assert.strictEqual(a.ok, false);
  assert.match(a.summary, /未接入/);

  const b = await toolOf(makeTb(null, () => { throw new Error('store 未就绪'); })).run({});
  assert.strictEqual(b.ok, false);
  assert.match(b.summary, /读取组合失败/);
  assert.match(b.summary, /store 未就绪/);

  const c = await toolOf(makeTb(null, () => null)).run({});
  assert.strictEqual(c.ok, false);
  assert.match(c.summary, /未取到组合状态/);
});

test('top 夹取到 1..30；返回带 dataFingerprint', async () => {
  const r1 = await toolOf(makeTb()).run({ top: 999 });
  assert.strictEqual(r1.data.positions.length, 2, '持仓只有 2 只时最多给 2 只');
  assert.ok(r1.dataFingerprint, '应带指纹');
});

test('⚠️ async 契约：data 不得是未 await 的 Promise', async () => {
  const r = await toolOf(makeTb()).run({ top: 5 });
  assert.ok(!(r.data instanceof Promise));
});
