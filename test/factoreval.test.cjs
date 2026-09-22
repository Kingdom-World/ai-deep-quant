// ─────────────────────────────────────────────────────────────
// 因子稳健性评估单元测试（S3）
//   判定规则的边界必须锁死：**正超额占比 与 平均超额 是「与」关系**——
//   占比再高，只要平均超额 ≤ 0 就不能判为稳健（否则会把"高波动无 alpha"误判为可用）。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stabilityOf, evaluate, ALL_FACTORS } = require('../server/factoreval.cjs');

// evaluate() 走真实本地归档（data/history/kline，已被 gitignore）——
// CI / 全新 clone 没有这些数据，必须显式跳过而不是红掉（与 factorexpr.test.cjs 同一模式）
const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);

const mk = (arr) => arr.map((e) => ({ year: 2000, excess: e }));

test('占比≥70% 且平均>0 → 稳健', () => {
  const s = stabilityOf(mk([5, 3, 8, -1, 2])); // 4/5 = 0.8，avg = 3.4
  assert.equal(s.verdict, '稳健');
  assert.equal(s.posRatio, 0.8);
  assert.equal(s.posYears, 4);
  assert.equal(s.totalYears, 5);
});

test('占比≥50% 但平均≤0 → 不稳定（两项是「与」关系）', () => {
  const s = stabilityOf(mk([10, -12])); // 1/2 = 0.5，avg = -1
  assert.equal(s.posRatio, 0.5);
  assert.ok(s.avgExcess < 0);
  assert.equal(s.verdict, '不稳定');
});

test('占比≥50% 且平均>0 → 边缘', () => {
  const s = stabilityOf(mk([3, 3, -1])); // 2/3 ≈ 0.67，avg ≈ 1.67
  assert.equal(s.verdict, '边缘');
});

test('占比<50% → 不稳定', () => {
  const s = stabilityOf(mk([-5, -3, 1])); // 1/3 ≈ 0.33
  assert.equal(s.verdict, '不稳定');
});

test('无有效样本时不得误判为稳健', () => {
  const s = stabilityOf([{ year: 2000, error: '区间不足' }]);
  assert.equal(s.totalYears, 0);
  assert.equal(s.verdict, '不稳定');
});

test('evaluate 应过滤非法因子并如实回报', () => {
  const r = evaluate({ factors: ['rev60', 'bogus'], topN: 5, rebalanceEvery: 60, yearFrom: 2024 });
  assert.ok(r.ok);
  assert.equal(r.factors.length, 1);
  assert.equal(r.factors[0].factor, 'rev60');
  assert.deepEqual(r.invalidFactors, ['bogus']);
  assert.ok(r.disclaimer.includes('不构成投资建议'));
  assert.ok(r.disclaimer.includes('路径依赖'));
});

test('evaluate 输出的因子应落在可用清单内，且逐年含策略/基准/超额', () => {
  if (!hasRealArchive) {
    console.log('  [skip] evaluate 全链路：真实归档不存在（data/history/kline，CI 无本地数据）');
    return;
  }
  const r = evaluate({ factors: ['mom20', 'rev20'], topN: 5, rebalanceEvery: 60, yearFrom: 2025 });
  assert.equal(r.factors.length, 2);
  for (const f of r.factors) {
    assert.ok(ALL_FACTORS.includes(f.factor));
    assert.ok(Array.isArray(f.byYear) && f.byYear.length >= 1);
    for (const y of f.byYear) {
      assert.ok(Number.isFinite(y.strategy) && Number.isFinite(y.benchmark) && Number.isFinite(y.excess));
    }
    assert.ok(['稳健', '边缘', '不稳定'].includes(f.stability.verdict));
  }
});
