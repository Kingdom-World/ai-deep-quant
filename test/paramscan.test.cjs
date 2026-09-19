// ─────────────────────────────────────────────────────────────
// 参数扫描与稳健性判定测试（S7）
//   重点锁死「孤峰判据」的边界：它是本模块最容易被误解的部分——
//   邻域容差必须按网格步长走，且邻域点不足时**必须明确说"无法判定"**，
//   不能默认判为「平原」（那会把"证据不足"伪装成"参数稳健"）。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { scan, peakAnalysis, range } = require('../server/paramscan.cjs');

const mkKlines = (len, fn) =>
  Array.from({ length: len }, (_, i) => {
    const c = fn(i);
    const d = new Date(Date.UTC(2024, 0, 1 + i));
    return {
      date: d.toISOString().slice(0, 10),
      open: c,
      high: c * 1.01,
      low: c * 0.99,
      close: c,
    };
  });

test('range 生成含端点的等差序列', () => {
  assert.deepEqual(range([5, 10, 1]), [5, 6, 7, 8, 9, 10]);
  assert.deepEqual(range([20, 60, 5]), [20, 25, 30, 35, 40, 45, 50, 55, 60]);
});

test('孤峰判定：邻域中位数不足最优一半 → 判「孤峰」', () => {
  const rows = [
    { fast: 10, slow: 30, totalReturn: 100 },
    { fast: 9, slow: 30, totalReturn: 10 },
    { fast: 11, slow: 30, totalReturn: 12 },
    { fast: 10, slow: 25, totalReturn: 8 },
    { fast: 10, slow: 35, totalReturn: 11 },
    { fast: 20, slow: 60, totalReturn: 99 }, // 远处，不算邻域
  ];
  const p = peakAnalysis(rows, rows[0], { fast: 1, slow: 5 });
  assert.equal(p.neighborCount, 4, '仅统计相邻格点');
  assert.equal(p.verdict, '孤峰');
  assert.ok(p.ratio < 0.5);
});

test('平原判定：邻域表现接近最优 → 判「平原」', () => {
  const rows = [
    { fast: 10, slow: 30, totalReturn: 100 },
    { fast: 9, slow: 30, totalReturn: 95 },
    { fast: 11, slow: 30, totalReturn: 92 },
    { fast: 10, slow: 25, totalReturn: 90 },
    { fast: 10, slow: 35, totalReturn: 88 },
  ];
  const p = peakAnalysis(rows, rows[0], { fast: 1, slow: 5 });
  assert.equal(p.verdict, '平原');
});

test('邻域出现亏损组合时，即使中位数达标也提示稳定性不足', () => {
  const rows = [
    { fast: 10, slow: 30, totalReturn: 100 },
    { fast: 9, slow: 30, totalReturn: 60 },
    { fast: 11, slow: 30, totalReturn: -20 }, // 邻域出现亏损
    { fast: 10, slow: 25, totalReturn: 70 },
  ];
  const p = peakAnalysis(rows, rows[0], { fast: 1, slow: 5 });
  assert.equal(p.verdict, '孤峰');
  assert.ok(p.reason.includes('亏损组合'));
});

test('邻域点不足 2 个时必须判「无法判定」，不得默认判为稳健', () => {
  const rows = [
    { fast: 10, slow: 30, totalReturn: 100 },
    { fast: 9, slow: 30, totalReturn: 5 },
  ];
  const p = peakAnalysis(rows, rows[0], { fast: 1, slow: 5 });
  assert.equal(p.neighborCount, 1);
  assert.equal(p.verdict, '无法判定');
});

test('【关键】最优组合本身亏损时判「无效」，绝不得判为「平原」', () => {
  // 早期实现：最优为负时 ratio 兜底为 1 → 被误判为「平原（稳健）」，
  // 等于把一个亏钱的参数推荐成"稳健参数"，是最危险的误导。
  const rows = [
    { fast: 10, slow: 30, totalReturn: -20 },
    { fast: 9, slow: 30, totalReturn: -25 },
    { fast: 11, slow: 30, totalReturn: -18 },
    { fast: 10, slow: 25, totalReturn: -22 },
  ];
  const p = peakAnalysis(rows, rows[0], { fast: 1, slow: 5 });
  assert.equal(p.verdict, '无效');
  assert.equal(p.ratio, null, '亏损情形下 ratio 不适用，应为 null');
  assert.ok(p.reason.includes('亏损'));
});

test('K 线不足时返回明确错误（不抛异常）', () => {
  const r = scan({ klines: mkKlines(30, () => 10) });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('K 线不足'));
});

test('网格过大时拒绝执行，避免打满服务', () => {
  const r = scan({ klines: mkKlines(120, () => 10), fastRange: [1, 300, 1], slowRange: [1, 900, 1] });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('网格过大'));
});

test('正常扫描：四段输出齐备（最优 / 孤峰 / 样本外 / 成本敏感度）', () => {
  const klines = mkKlines(400, (i) => 10 + Math.sin(i / 9) * 2 + i * 0.01);
  const r = scan({ klines, fastRange: [3, 8, 1], slowRange: [10, 25, 5], capital: 100000 });
  assert.equal(r.ok, true);
  assert.ok(r.best && Number.isFinite(r.best.totalReturn));
  assert.ok(['平原', '孤峰', '无法判定'].includes(r.peak.verdict));
  assert.equal(r.outOfSample.available, true);
  assert.equal(r.costSensitivity.length, 3);
  assert.deepEqual(
    r.costSensitivity.map((x) => x.slippage),
    [0, 0.001, 0.003],
  );
  assert.equal(r.multipleTesting.trials, r.params.trials);
  assert.ok(r.disclaimer.includes('不构成投资建议'));
});
