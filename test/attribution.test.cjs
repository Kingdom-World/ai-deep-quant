// ─────────────────────────────────────────────────────────────
// 归因地基测试（评审 P2-1）：订单 src 策略标记 + 卖出归因戳 + 回测费用口径
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-'));
process.env.PAPER_DATA_DIR = tmpDir;
process.env.PAPER_TRADE_247 = '1';
process.env.PAPER_MAX_ORDER_PCT = '1';
process.env.PAPER_MAX_POSITION_PCT = '1';
process.env.PAPER_MAX_DAILY_BUYS = '10';

const broker = require('../server/paper/broker.cjs');
const { runBacktest } = require('../server/quant.cjs');

let quotePrice = 10;
broker.init({ getQuote: async () => ({ price: quotePrice, name: '测试', prevClose: quotePrice }) });

test('下单 src 策略标记透传到订单', async () => {
  const uid = 'attr-src';
  broker.store.ensureAccount(uid);
  const r = await broker.placeOrder(uid, {
    symbol: 'sh600519', side: 'buy', type: 'market', qty: 100, src: 'strategy-abc',
  });
  assert.equal(r.order.status, 'filled');
  assert.equal(r.order.src, 'strategy-abc');
  const r2 = await broker.placeOrder(uid, { symbol: 'sh600036', side: 'buy', type: 'market', qty: 100 });
  assert.equal(r2.order.src, '', '人工下单 src 为空串');
});

test('卖出订单归因戳：pricePnl / realized / buyFeeShare', async () => {
  const uid = 'attr-sell';
  broker.store.ensureAccount(uid);
  const buy = await broker.placeOrder(uid, { symbol: 'AAPL', side: 'buy', type: 'market', qty: 100 });
  assert.equal(buy.order.status, 'filled');
  quotePrice = 12; // 价差 +20/股
  const sell = await broker.placeOrder(uid, { symbol: 'AAPL', side: 'sell', type: 'market', qty: 100 });
  assert.equal(sell.order.status, 'filled');
  const o = sell.order;
  assert.equal(o.pricePnl, 200, '价差毛盈亏 = (12−10)×100');
  assert.ok(o.realized < o.pricePnl, '净已实现 < 价差毛盈亏（费用）');
  assert.equal(o.realized, +(o.pricePnl - o.fees.total - o.buyFeeShare).toFixed(2), 'realized = pricePnl − 卖出费 − 买入费分摊');
  assert.ok(o.buyFeeShare >= 0);
  quotePrice = 10;
});

test('回测费用口径：totalFees / turnover / feeRatePct', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const klines = closes.map((c, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: +(c - 0.5).toFixed(2), close: c, high: c + 1, low: c - 1, volume: 1000,
  }));
  const r = runBacktest(klines, 'buyhold', 5, 20, 100000, 'CN', { slippage: 0, limitPct: null });
  assert.ok(r.totalFees > 0);
  assert.ok(r.turnover > 0);
  // 一买一卖（期末强平）：turnover = 买入额 + 卖出额，费率应为万分之几量级
  assert.ok(r.feeRatePct > 0 && r.feeRatePct < 0.5, `feeRatePct=${r.feeRatePct}`);
});
