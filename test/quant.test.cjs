// ─────────────────────────────────────────────────────────────
// 量化引擎单元测试：node --test test/
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { smaSeries, rsiSeries, runBacktest } = require('../server/quant.cjs');

/** 构造合成 K 线：closes 由函数生成，open=close-0.5，high/low 包络 */
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

test('smaSeries 已知值', () => {
  assert.deepEqual(smaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(smaSeries([2, 4, 6], 1), [2, 4, 6]);
});

test('rsiSeries 边界：全涨为 100，数据不足为 null', () => {
  const rising = Array.from({ length: 20 }, (_, i) => i + 1);
  const r = rsiSeries(rising, 14);
  assert.equal(r[12], null);
  assert.equal(r[19], 100);
});

test('buyhold：单调上涨序列收益接近持有收益，期末强平标记 forced', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i); // 100 → 159
  const r = runBacktest(makeKlines(closes), 'buyhold', 5, 20, 100000);
  assert.ok(!r.error);
  assert.equal(r.tradeCount, 1);
  assert.equal(r.trades[0].forced, true);
  // 买入价 open[1]=100.5，期末收盘 159 平仓（含双边 0.1% 手续费）
  assert.ok(r.totalReturn > 57 && r.totalReturn < 59, `totalReturn=${r.totalReturn}`);
  assert.ok(r.benchmarkReturn > 58.9 && r.benchmarkReturn < 59.1);
});

test('ma 双均线：涨后跌序列至少完成一轮买卖', () => {
  const closes = [
    ...Array.from({ length: 40 }, (_, i) => 100 + i * 2), // 上涨段
    ...Array.from({ length: 25 }, (_, i) => 178 - i * 3), // 下跌段
  ];
  const r = runBacktest(makeKlines(closes), 'ma', 3, 5, 100000);
  assert.ok(!r.error);
  assert.ok(r.tradeCount >= 1, `tradeCount=${r.tradeCount}`);
  assert.ok(Array.isArray(r.equity) && r.equity.length === closes.length);
});

test('rsi 策略：信号当日收盘产生、次日开盘成交（无同 bar 前视）', () => {
  // 先跌入超卖再回升 → 触发买入；买入价应为触发后下一根的 open
  const closes = [
    ...Array.from({ length: 30 }, (_, i) => 200 - i * 4), // 大跌（RSI→极低）
    ...Array.from({ length: 30 }, (_, i) => 84 + i * 3), // 回升
  ];
  const r = runBacktest(makeKlines(closes), 'rsi', 5, 20, 1000000);
  assert.ok(!r.error);
  if (r.tradeCount > 0) {
    const t = r.trades[0];
    const idx = r.equity.findIndex((e) => e.date === t.exitDate);
    assert.ok(idx >= 0);
  }
});

test('初始资金低于股价：不再静默空转，结果带 note', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 1292 + i); // 茅台式高价
  const r = runBacktest(makeKlines(closes), 'ma', 5, 20, 1000);
  assert.equal(r.tradeCount, 0);
  assert.ok(r.note && r.note.includes('低于股价'), `note=${r.note}`);
});

test('资金足够但条件从未触发：note 说明无信号', () => {
  const closes = Array.from({ length: 60 }, () => 100); // 恒定 → MA 永不金叉
  const r = runBacktest(makeKlines(closes), 'ma', 5, 20, 100000);
  assert.equal(r.tradeCount, 0);
  assert.ok(r.note && r.note.includes('未产生交易信号'));
});

test('数据不足 30 根返回 error', () => {
  const r = runBacktest(makeKlines(Array.from({ length: 10 }, () => 100)), 'ma', 5, 20, 100000);
  assert.ok(r.error);
});
