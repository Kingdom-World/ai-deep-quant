'use strict';
// ─────────────────────────────────────────────────────────────
// 组合因子暴露测试（Phase 4 · PortfolioPilot）
//
// 🔴 本文件最重要的一条：**缺失值绝不按 0 计**。
//   若把算不出因子值的标的当 0 参与加权，组合暴露会被"稀释"、
//   显得比实际更中性 —— 这是**看不出对错的错误结论**（数字仍在合理区间）。
//   实测对比：某组合正确值 0.0545，按 0 计则得 0.0409，差 25%，
//   而两者"看起来都是正常的暴露值"。所以这里用**反例断言**把它钉死。
//
// 其余口径：
//   · 因子值是**小数**（0.1439 = 14.39%），不是百分数
//   · rev 在引擎内已自动取负（数值上 = −mom）
//   · 窗口不足时 evalOnStock 返回 null（不是 0）
//   · 复权降级（adjFallback）必须外露
//
// ⚠️ 全部用假 K 线，不读 data/（gitignore，CI 里不存在）。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { computeExposure, requiredRows, computeBenchmark } = require(path.join(__dirname, '..', 'server', 'paper', 'exposure.cjs'));
const { createToolbox } = require(path.join(__dirname, '..', 'server', 'agent', 'toolbox.cjs'));

/** 单调上涨 n 根（mom = 正） */
function rising(n) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 10 + i * 0.1, high: 10.1 + i * 0.1, low: 9.9 + i * 0.1, close: 10 + i * 0.1, volume: 1e6,
  }));
}
/** 单调下跌 n 根（mom = 负） */
function falling(n) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 20 - i * 0.1, high: 20.1 - i * 0.1, low: 19.9 - i * 0.1, close: 20 - i * 0.1, volume: 1e6,
  }));
}
const mkKlines = (map) => async (sym) => map[sym];

// ── 基础 ─────────────────────────────────────────────────────
test('前置：requiredRows 按因子窗口给出所需根数（不足则返回 ok:false）', () => {
  const a = requiredRows('mom20');
  assert.strictEqual(a.ok, true);
  assert.ok(a.need > 20, `mom20 需要 >20 根热身，实际 ${a.need}`);
  assert.ok(a.need <= 400, '不得要求超过归档长度的数据');
  const b = requiredRows('不是因子');
  assert.strictEqual(b.ok, false);
});

test('加权正确：60% 上涨 + 40% 下跌 ⇒ 暴露在两者之间', async () => {
  const r = await computeExposure({
    positions: [{ symbol: 'A', marketValue: 60000 }, { symbol: 'B', marketValue: 40000 }],
    factors: ['mom20'],
    getKlines: mkKlines({ A: rising(80), B: falling(80) }),
  });
  assert.strictEqual(r.ok, true);
  const f = r.factors[0];
  assert.strictEqual(f.coverage, 1, '两只都有数据 ⇒ 覆盖率 100%');
  assert.ok(f.exposure > -0.2 && f.exposure < 0.2, `暴露应在 ±20% 内，实际 ${f.exposure}`);
  assert.strictEqual(f.contributions.length, 2);
});

test('rev 与 mom 互为相反数（引擎已自动取负）', async () => {
  const r = await computeExposure({
    positions: [{ symbol: 'A', marketValue: 50000 }, { symbol: 'B', marketValue: 50000 }],
    factors: ['mom20', 'rev20'],
    getKlines: mkKlines({ A: rising(80), B: falling(80) }),
  });
  const [mom, rev] = r.factors;
  assert.ok(Math.abs(mom.exposure + rev.exposure) < 1e-9,
    `mom 与 rev 应互为相反数：${mom.exposure} vs ${rev.exposure}`);
});

// ── 🔴 核心：缺失值不按 0 计 ──────────────────────────────────
test('🔴 缺失值绝不按 0 计：剔除后归一化到有效权重', async () => {
  // 构造：A、B 的 K 线**完全相同**（因此各自 mom20 相同），C 只有 5 根（算不出）。
  //   · 正确（归一化到有效权重）：暴露 = 该共同值（权重全落在同值标的上）
  //   · 错误（按 0 计）：暴露 = 该共同值 × 0.75
  // ⇐ 用"完全同值"让正确值可**预先算出**，反例才有判别力。
  //   （先前版本用 exposure×coverage 作反例是错的：那对两种实现都成立，破坏后仍全绿。）
  const map = { A: rising(80), B: rising(80), C: rising(5) };

  // 基准：只算 A 单只 ⇒ 得到该共同因子值
  const single = await computeExposure({
    positions: [{ symbol: 'A', marketValue: 100000 }],
    factors: ['mom20'],
    getKlines: mkKlines(map),
  });
  const base = single.factors[0].exposure;
  assert.ok(base > 0, '基准值应为正（单调上涨）');

  const r = await computeExposure({
    positions: [
      { symbol: 'A', marketValue: 50000 },
      { symbol: 'B', marketValue: 25000 },
      { symbol: 'C', marketValue: 25000 },
    ],
    factors: ['mom20'],
    getKlines: mkKlines(map),
  });
  const f = r.factors[0];
  assert.ok(Math.abs(f.coverage - 0.75) < 1e-9, `覆盖率应为 75%，实际 ${f.coverage}`);

  // ✅ 核心断言：归一化后应**等于**共同值
  assert.ok(Math.abs(f.exposure - base) < 1e-9,
    `归一化后暴露应等于单只基准值 ${base}，实际 ${f.exposure}`);
  // ❌ 反例：绝不能是按 0 计的结果
  assert.ok(Math.abs(f.exposure - base * 0.75) > 1e-6,
    `暴露不应等于"按 0 计"的 ${base * 0.75}（那是被稀释的错误值）`);

  // C 必须有明确的 skip 原因，而不是静默消失
  const c = f.contributions.find((x) => x.symbol === 'C');
  assert.strictEqual(c.value, null);
  assert.match(c.skip, /K 线不足/);
});

test('🔴 覆盖率不足时组合级最低覆盖率如实反映（含完全算不出的因子）', async () => {
  const r = await computeExposure({
    positions: [{ symbol: 'A', marketValue: 50000 }, { symbol: 'C', marketValue: 50000 }],
    factors: ['mom20', 'mom60'],
    // A 只有 40 根：mom20 够（需 26）、mom60 不够（需 66）；C 只有 5 根，两个都不够
    getKlines: mkKlines({ A: rising(40), C: rising(5) }),
  });
  // mom20：只有 A 有效 ⇒ 覆盖 50%；mom60：全军覆没 ⇒ 覆盖 0%
  assert.ok(Math.abs(r.coverage.min - 0) < 1e-9,
    `最低覆盖率应取到"完全算不出"的 mom60（0），实际 ${r.coverage.min}`);
  assert.strictEqual(r.coverage.byFactor.mom60, 0, 'byFactor 也要如实给 0，而不是把该因子整个略去');
  assert.ok(Math.abs(r.coverage.byFactor.mom20 - 0.5) < 1e-9, 'mom20 覆盖 50%（仅 A 有效）');
  // 只要还有一个因子可用，整体仍算成功（否则上层会误判为"完全失败"）
  assert.strictEqual(r.ok, true, 'mom20 可用 ⇒ 整体 ok=true');
  // 但 mom60 这一项自己必须是 ok:false
  const m60 = r.factors.find((f) => f.factor === 'mom60');
  assert.strictEqual(m60.ok, false);
  assert.ok(m60.error, '失败因子必须带原因');
});

// ── 边界与错误 ────────────────────────────────────────────────
test('无持仓 / 市值为 0 / 未注入 getKlines ⇒ 明确失败而非空结果', async () => {
  const a = await computeExposure({ positions: [], factors: ['mom20'], getKlines: async () => [] });
  assert.strictEqual(a.ok, false);
  assert.match(a.error, /没有持仓/);

  const b = await computeExposure({ positions: [{ symbol: 'A', marketValue: 0 }], factors: ['mom20'], getKlines: async () => [] });
  assert.strictEqual(b.ok, false);
  assert.match(b.error, /市值/);

  const c = await computeExposure({ positions: [{ symbol: 'A', marketValue: 100 }], factors: ['mom20'] });
  assert.strictEqual(c.ok, false);
  assert.match(c.error, /getKlines/);
});

test('取数抛错 ⇒ 该标的标记 skip，不中断其它标的', async () => {
  const r = await computeExposure({
    positions: [{ symbol: 'A', marketValue: 50000 }, { symbol: 'BAD', marketValue: 50000 }],
    factors: ['mom20'],
    getKlines: async (sym) => {
      if (sym === 'BAD') throw new Error('网络超时');
      return rising(80);
    },
  });
  const f = r.factors[0];
  assert.strictEqual(f.ok, true, 'A 仍应算出来');
  assert.ok(Math.abs(f.coverage - 0.5) < 1e-9);
  const bad = f.contributions.find((x) => x.symbol === 'BAD');
  assert.match(bad.skip, /取数失败.*网络超时/);
});

test('🔴 复权降级必须外露（adjFallback）', async () => {
  // 假 K 线没有复权因子 ⇒ withAdjustedPrices 走 else 分支 ⇒ 置 adjFallback
  const r = await computeExposure({
    positions: [{ symbol: 'A', marketValue: 100000 }],
    factors: ['mom20'],
    getKlines: mkKlines({ A: rising(80) }),
  });
  assert.deepStrictEqual(r.adjFallbackSymbols, ['A'],
    '无复权因子时应如实报告降级标的（对 qfq 数据无害，但换数据源时会静默错）');
});

// ── 工具层 ────────────────────────────────────────────────────
function makeTb({ snapshot = null, klines = null } = {}) {
  return createToolbox({
    accountSnapshot: async () => snapshot,
    fetchKlines: klines || (async () => rising(80)),
  });
}
const toolOf = (tb) => tb.tools.find((t) => t.name === 'get_factor_exposure');

test('工具契约：params 正确（factors + benchmark），desc 说明"需要持仓"与"只读"', () => {
  const spec = makeTb().spec.find((s) => s.name === 'get_factor_exposure');
  assert.ok(spec);
  assert.deepStrictEqual(spec.params.map((p) => p.name), ['factors', 'benchmark']);
  assert.strictEqual(spec.params[0].required, false);
  assert.strictEqual(spec.params[1].type, 'boolean');
  assert.match(spec.desc, /持仓/);
  assert.match(spec.desc, /只读/);
});

test('工具：正常路径输出含各因子暴露与覆盖率', async () => {
  const tb = makeTb({
    snapshot: { totalAssets: 100000, positions: [
      { symbol: 'A', marketValue: 50000 }, { symbol: 'B', marketValue: 50000 },
    ] },
    klines: async (sym) => (sym === 'A' ? rising(80) : falling(80)),
  });
  const r = await toolOf(tb).run({});
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /组合因子暴露/);
  assert.match(r.summary, /mom20/);
  assert.match(r.summary, /覆盖/);
  assert.match(r.summary, /小数/); // 口径说明必须带
  assert.match(r.summary, /不要替用户下/); // 越界防护
});

test('工具：无持仓 ⇒ fail 且引导建立持仓', async () => {
  const r = await toolOf(makeTb({ snapshot: { positions: [] } })).run({});
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /无持仓/);
  assert.match(r.summary, /建立持仓/);
});

test('工具：覆盖率不足时解释"为什么不 100%"并列出被剔除标的', async () => {
  const tb = makeTb({
    snapshot: { positions: [
      { symbol: 'A', marketValue: 50000 }, { symbol: 'C', marketValue: 50000 },
    ] },
    klines: async (sym) => (sym === 'A' ? rising(80) : rising(5)),
  });
  const r = await toolOf(tb).run({});
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /为什么覆盖率不是 100%/);
  assert.match(r.summary, /不按 0 计/);
  assert.match(r.summary, /K 线不足/);
});

test('工具：可指定因子列表（逗号/空格分隔）', async () => {
  const tb = makeTb({
    snapshot: { positions: [{ symbol: 'A', marketValue: 100000 }] },
  });
  const r = await toolOf(tb).run({ factors: 'mom20, rev60' });
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /mom20/);
  assert.match(r.summary, /rev60/);
  assert.ok(!/mom60/.test(r.summary.split('【')[0]), '未指定的因子不应出现');
});

test('工具：deps 未接入 ⇒ fail（不抛异常）', async () => {
  const a = await toolOf(createToolbox({})).run({});
  assert.strictEqual(a.ok, false);
  assert.match(a.summary, /未接入/);
});

test('工具：返回带 dataFingerprint（供编排层幂等判定）', async () => {
  const tb = makeTb({
    snapshot: { positions: [{ symbol: 'A', marketValue: 100000 }] },
  });
  const r = await toolOf(tb).run({ factors: 'mom20' });
  assert.ok(r.dataFingerprint, '应带指纹');
  assert.strictEqual(r.dataFingerprint.data.adjust, 'qfq', '口径必须标为前复权');
});

// ── 基准对比（P4 第二轮）──────────────────────────────────────
test('基准：🔴 等距抽样而非取前 N 只（避免板块系统性偏差）', async () => {
  // 构造 100 只标的，名称按序排列；若实现取"前 20 只"，则抽样集合必然都是 sym-00..19
  const symbols = Array.from({ length: 100 }, (_, i) => `sym-${String(i).padStart(3, '0')}`);
  const seen = [];
  const r = await computeBenchmark({
    symbols, factors: ['mom20'], maxSymbols: 20,
    getKlines: async (sym) => { seen.push(sym); return rising(80); },
  });
  assert.strictEqual(r.sampleSize, 20);
  assert.strictEqual(seen.length, 20);
  // 等距抽样应**覆盖整个区间**，而不是只集中在头部
  const idx = seen.map((s) => Number(s.slice(4))).sort((a, b) => a - b);
  assert.ok(idx[idx.length - 1] >= 80, `抽样最大下标应接近池尾（≥80），实际 ${idx[idx.length - 1]}`);
  assert.ok(idx[0] <= 20, `抽样最小下标应接近池头（≤20），实际 ${idx[0]}`);
});

test('基准：🔴 用中位数（单只极端值不得拉偏）', async () => {
  // 9 只正常上涨 + 1 只暴涨 10 倍 ⇒ 均值会被明显拉高，中位数基本不受影响
  const symbols = Array.from({ length: 10 }, (_, i) => `s${i}`);
  const r = await computeBenchmark({
    symbols, factors: ['mom20'], maxSymbols: 10,
    getKlines: async (sym) => {
      if (sym === 's0') {
        // 暴涨：最后一根变成 100 倍
        const rows = rising(80);
        rows[rows.length - 1].close = 1000;
        return rows;
      }
      return rising(80);
    },
  });
  const f = r.factors[0];
  assert.strictEqual(f.ok, true);
  assert.ok(f.median < f.mean, `中位数 ${f.median} 应小于被极端值拉高的均值 ${f.mean}`);
  assert.ok(Math.abs(f.median - f.mean) > 1e-6, '两者应有可观测差异，否则本用例没有判别力');
});

test('基准：缺值不按 0 计（只统计能算出的，并报告有效样本数）', async () => {
  const r = await computeBenchmark({
    symbols: ['good1', 'good2', 'bad1'],
    factors: ['mom20'], maxSymbols: 3,
    getKlines: async (sym) => (sym.startsWith('bad') ? rising(5) : rising(80)),
  });
  const f = r.factors[0];
  assert.strictEqual(f.count, 2, '只应有 2 只有效样本');
  assert.strictEqual(f.poolSize, 3);
  assert.ok(f.mean > 0, '若把缺值当 0，均值会被拉低');
});

test('基准：空池 / 未注入 getKlines ⇒ 明确失败', async () => {
  const a = await computeBenchmark({ symbols: [], factors: ['mom20'], getKlines: async () => [] });
  assert.strictEqual(a.ok, false);
  assert.match(a.error, /标的池为空/);
  const b = await computeBenchmark({ symbols: ['A'], factors: ['mom20'] });
  assert.strictEqual(b.ok, false);
  assert.match(b.error, /getKlines/);
});

test('基准：单只取数失败不影响整体（统计量少一两只不致命）', async () => {
  const r = await computeBenchmark({
    symbols: ['ok1', 'ok2', 'boom'],
    factors: ['mom20'], maxSymbols: 3,
    getKlines: async (sym) => { if (sym === 'boom') throw new Error('超时'); return rising(80); },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.factors[0].count, 2);
});

test('🔴 工具层：基准不可用时**不拖垮主结果**，但必须标注', async () => {
  const tb = createToolbox({
    accountSnapshot: async () => ({ positions: [{ symbol: 'A', marketValue: 100000 }] }),
    fetchKlines: async () => rising(80),
    // 不注入 listUniverse ⇒ 基准不可用
  });
  const r = await tb.tools.find((t) => t.name === 'get_factor_exposure').run({});
  assert.strictEqual(r.ok, true, '基准缺失不得让暴露本身失败');
  assert.match(r.summary, /基准不可用/, '但必须如实标注');
});

test('工具层：基准可用时给出"相对 pp"（不是比值）', async () => {
  // 组合：1 只上涨票；基准：全部下跌票 ⇒ 相对应为正
  const tb = createToolbox({
    accountSnapshot: async () => ({ positions: [{ symbol: 'UP', marketValue: 100000 }] }),
    fetchKlines: async (sym) => (sym === 'UP' ? rising(80) : falling(80)),
    listUniverse: () => ['D1', 'D2', 'D3', 'D4'],
  });
  const r = await tb.tools.find((t) => t.name === 'get_factor_exposure').run({ factors: 'mom20' });
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /基准 /, '应给出基准值');
  assert.match(r.summary, /相对 \+[\d.]+pp/, '相对暴露用百分点 pp，且为正');
  assert.match(r.summary, /百分点 pp/, '口径说明要解释 pp 的含义');
});

test('工具层：benchmark=false 可关闭基准（省掉 20 次取数）', async () => {
  let called = 0;
  const tb = createToolbox({
    accountSnapshot: async () => ({ positions: [{ symbol: 'A', marketValue: 100000 }] }),
    fetchKlines: async () => { called += 1; return rising(80); },
    listUniverse: () => ['D1', 'D2', 'D3'],
  });
  await tb.tools.find((t) => t.name === 'get_factor_exposure').run({ factors: 'mom20', benchmark: false });
  assert.strictEqual(called, 1, '关闭基准后只应取持仓自己的 K 线');
});
