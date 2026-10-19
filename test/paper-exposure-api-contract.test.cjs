'use strict';
// ─────────────────────────────────────────────────────────────
// /api/paper/exposure 的**前端契约测试**
//
// 为什么单独写：项目曾经吃过一次亏 —— 前端臆造了 6 处字段名，
// TS 编译不报错，但页面全是 undefined。所以凡是前端要读的字段，
// 都要有一条**机器可验**的断言，证明后端真的产出它们。
//
// 这里直接调计算模块（API 就是 `{ ok, ...computeExposure 结果, benchmark }`），
// 断言**前端 TS 类型里声明的每个字段**都真实存在 —— 字段清单与
// `src/api/paper.ts` 的 PaperExposure / FactorExposure / BenchmarkFactor 对齐。
// ⚠️ 若改了 TS 类型，请同步本文件的字段清单（两处不一致正是要防的事）。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { computeExposure, computeBenchmark } = require(path.join(__dirname, '..', 'server', 'paper', 'exposure.cjs'));

function rising(n) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 10 + i * 0.1, high: 10.1 + i * 0.1, low: 9.9 + i * 0.1, close: 10 + i * 0.1, volume: 1e6,
  }));
}
const klines = async () => rising(80);

/** 模拟 GET /api/paper/exposure 的响应体（与 routes/paper.cjs 一致） */
async function fetchExposureShape() {
  const r = await computeExposure({
    positions: [{ symbol: 'A', marketValue: 60000 }, { symbol: 'C', marketValue: 40000 }],
    factors: ['mom20'],
    getKlines: async (sym) => (sym === 'C' ? rising(5) : rising(80)), // C 故意算不出
  });
  const b = await computeBenchmark({ symbols: ['B1', 'B2'], factors: ['mom20'], getKlines: klines, maxSymbols: 2 });
  return { ok: r.ok, ...r, benchmark: b };
}

test('契约：顶层字段齐全（对齐 src/api/paper.ts 的 PaperExposure）', async () => {
  const j = await fetchExposureShape();
  const required = ['ok', 'totalValue', 'positionCount', 'factors', 'coverage', 'adjFallbackSymbols', 'benchmark'];
  for (const k of required) {
    assert.ok(k in j, `响应缺少前端要读的字段「${k}」—— 页面会拿到 undefined`);
  }
  assert.ok(Array.isArray(j.factors), 'factors 必须是数组（页面 map 它）');
});

test('契约：factor 项字段齐全（对齐 FactorExposure）', async () => {
  const j = await fetchExposureShape();
  const required = ['factor', 'ok', 'exposure', 'coverage', 'failed', 'contributions'];
  for (const k of required) {
    assert.ok(k in j.factors[0], `factor 项缺少「${k}」`);
  }
  // 类型：exposure 可为 null（算不出），coverage 必须是数字（页面按数字格式化）
  assert.strictEqual(typeof j.factors[0].coverage, 'number');
  assert.ok(j.factors[0].exposure === null || typeof j.factors[0].exposure === 'number');
});

test('契约：contribution 项字段齐全（对齐 ExposureContribution）', async () => {
  const j = await fetchExposureShape();
  const c = j.factors[0].contributions[0];
  for (const k of ['symbol', 'weight', 'value']) {
    assert.ok(k in c, `contribution 缺少「${k}」`);
  }
  // 算不出的那只必须带 skip（页面会显示原因）
  const skipped = j.factors[0].contributions.find((x) => x.value === null);
  assert.ok(skipped, '本用例应有一只算不出的标的');
  assert.strictEqual(typeof skipped.skip, 'string');
  assert.ok(skipped.skip.length > 0, 'skip 原因不能是空串（否则页面显示空白）');
});

test('契约：coverage 结构（页面读 min 与 byFactor）', async () => {
  const j = await fetchExposureShape();
  assert.strictEqual(typeof j.coverage.min, 'number');
  assert.strictEqual(typeof j.coverage.byFactor, 'object');
  assert.ok('mom20' in j.coverage.byFactor, 'byFactor 必须按因子名索引');
});

test('契约：benchmark 字段齐全（对齐 BenchmarkFactor）', async () => {
  const j = await fetchExposureShape();
  const b = j.benchmark;
  for (const k of ['ok', 'sampleSize', 'factors']) {
    assert.ok(k in b, `benchmark 缺少「${k}」`);
  }
  const bf = b.factors[0];
  for (const k of ['factor', 'ok', 'mean', 'median', 'count', 'poolSize']) {
    assert.ok(k in bf, `benchmark.factors 项缺少「${k}」—— 页面「基准」列会空白`);
  }
  assert.strictEqual(typeof bf.median, 'number', '页面显示基准用的是 median');
});

test('契约：无持仓时仍返回 ok:false + error（页面能展示原因而不是崩）', async () => {
  const r = await computeExposure({ positions: [], factors: ['mom20'], getKlines: klines });
  const api = { ok: r.ok, ...r };
  assert.strictEqual(api.ok, false);
  assert.strictEqual(typeof api.error, 'string');
  assert.ok(Array.isArray(api.factors), '即使失败也要给空数组，页面才能安全 map');
});
