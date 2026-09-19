// ─────────────────────────────────────────────────────────────
// 回测执行环回归测试：滑点模型 + 开盘涨跌停不成交（评审 P1-3）
//   场景数据经探针校准：开盘价 = 当日收盘 − 0.5（makeKlines 约定）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { runBacktest } = require('../server/quant.cjs');

function makeKlines(closes) {
  return closes.map((c, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: +(c - 0.5).toFixed(2),
    close: c,
    high: c + 1,
    low: c - 1,
    volume: 1000,
  }));
}

test('滑点：默认 0.1%——买入价 = 开盘 ×(1+s)，卖出价 = 开盘 ×(1−s)', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const noSlip = runBacktest(makeKlines(closes), 'buyhold', 5, 20, 100000, 'CN', { slippage: 0, limitPct: null });
  const slip = runBacktest(makeKlines(closes), 'buyhold', 5, 20, 100000, 'CN', { slippage: 0.001, limitPct: null });
  assert.equal(noSlip.trades[0].entryPrice, 100.5);
  assert.equal(slip.trades[0].entryPrice, 100.6); // 100.5 × 1.001 = 100.6005
  assert.ok(slip.totalReturn < noSlip.totalReturn, '滑点必须拉低收益');
  assert.equal(slip.params.slippage, 0.001);
});

test('开盘涨停：买单无法成交，信号保留至次日开盘（拉回后买入）', () => {
  // closes[0]=100（涨停价 110），closes[1]=112 → open=111.5 ≥ 110 → 阻断；
  // closes[2]=105 → open=104.5 < 123.2 → 正常成交 104.5×1.001=104.6
  const closes = [100, 112, 105, ...Array.from({ length: 40 }, (_, i) => 105 + i * 0.5), ...Array.from({ length: 20 }, () => 125)];
  const r = runBacktest(makeKlines(closes), 'buyhold', 5, 20, 100000, 'CN', { slippage: 0.001, limitPct: 10 });
  assert.equal(r.blockedLimitUp, 1);
  assert.equal(r.tradeCount, 1);
  assert.equal(r.trades[0].entryPrice, 104.6, '应在拉回日成交而非阻断日');
});

test('开盘跌停：卖单无法成交，信号保留至次日开盘（反弹后卖出）', () => {
  // 12 平台 + 11 上涨（ma3>ma5 买入）→ 134 顶 → 126、120 翻转出卖出信号
  // → 次日 closes=105：open=104.5 ≤ 跌停价 108（120×0.9）→ 阻断
  // → 再次日 closes=110：open=109.5 > 99 → 成交 109.5×0.999=109.39
  const closes = [
    ...Array.from({ length: 12 }, () => 100),
    ...Array.from({ length: 11 }, (_, i) => 102 + i * 3),
    134, 126, 120, 105, 110,
    ...Array.from({ length: 20 }, () => 110),
  ];
  const r = runBacktest(makeKlines(closes), 'ma', 3, 5, 1000000, 'CN', { slippage: 0.001, limitPct: 10 });
  assert.equal(r.blockedLimitDown, 1);
  assert.ok(r.tradeCount >= 1);
  assert.equal(r.trades[0].exitPrice, 109.39, '应在反弹日成交而非阻断日');
});

test('limitPct 为 null（港美股口径）时不做涨跌停校验', () => {
  const closes = [100, 112, 105, ...Array.from({ length: 40 }, (_, i) => 105 + i * 0.5), ...Array.from({ length: 20 }, () => 125)];
  const r = runBacktest(makeKlines(closes), 'buyhold', 5, 20, 100000, 'US', { slippage: 0.001, limitPct: null });
  assert.equal(r.blockedLimitUp, 0, '无涨跌停约束：涨停开盘照常买入');
  assert.equal(r.trades[0].entryPrice, 111.61); // 111.5 × 1.001
});
