// ─────────────────────────────────────────────────────────────
// 模拟交易并发安全回归测试
//   覆盖：撮合状态守卫 / 撮合循环重入保护 / 风控 TOCTOU / 已实现盈亏口径
//
//   ⚠️ 注意：process.env 必须在 require broker 之前设置——
//   PaperStore 在模块加载时就会实例化并读写 PAPER_DATA_DIR，
//   晚设置会让测试污染真实账本（data/paper/state.json）。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-concurrency-'));
process.env.PAPER_DATA_DIR = tmpDir;
process.env.PAPER_TRADE_247 = '1'; // 强制全天可交易，避免测试结果随时段漂移
process.env.PAPER_MAX_ORDER_PCT = '0.2';
process.env.PAPER_MAX_POSITION_PCT = '0.3';
process.env.PAPER_MAX_DAILY_BUYS = '3';

const broker = require('../server/paper/broker.cjs');
const { tryFillLimitOrder } = require('../server/paper/matcher.cjs');

const PRICE = 10;
broker.init({ getQuote: async () => ({ price: PRICE, name: '测试标的' }) });

function cnToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

// ── 撮合状态守卫：撤单 / 已成交的订单不得再被填单 ──
test('matcher：已撤单或已成交的订单不会被再次撮合', () => {
  const canceled = {
    id: 'c1', symbol: 'sh600519', side: 'buy', type: 'limit',
    qty: 100, limitPrice: 10, status: 'canceled', fills: [],
  };
  tryFillLimitOrder(canceled, { price: 9 });
  assert.equal(canceled.status, 'canceled', '撤单后不得改状态');
  assert.equal(canceled.fills.length, 0, '撤单后不得产生成交明细');

  const filled = {
    id: 'c2', symbol: 'sh600519', side: 'buy', type: 'limit',
    qty: 100, limitPrice: 10, status: 'filled', fills: [],
  };
  tryFillLimitOrder(filled, { price: 9 });
  assert.equal(filled.fills.length, 0, '已成交订单不得重复填单');
});

// ── 撮合循环重入保护 ──
test('runMatcher：上一轮未结束时的重叠调用被丢弃', async () => {
  // 先挂一个不会成交的限价买单，让首轮撮合确实有活可干
  await broker.placeOrder('reentry-user', {
    symbol: 'sh600519', side: 'buy', type: 'limit', qty: 10, limitPrice: PRICE - 5,
  });
  const first = broker.runMatcher();
  const second = await broker.runMatcher();
  assert.equal(second.skipped, true, '重叠的一轮撮合必须被丢弃，否则同一挂单会被重复成交');
  await first;
});

// ── 风控 TOCTOU：串行化后并发下单不得穿透「当日买入次数」上限 ──
test('并发下单：账户级串行化后不会穿透当日买入次数上限', async () => {
  const uid = 'concurrent-buyer';
  broker.store.ensureAccount(uid);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      broker.placeOrder(uid, { symbol: 'sz000001', side: 'buy', type: 'market', qty: 1 }),
    ),
  );
  const filled = results.filter((r) => r.order?.status === 'filled').length;
  assert.equal(filled, 3, `当日买入上限 3 被穿透：实际成交 ${filled} 笔（并发未串行化的典型症状）`);
});

// ── 已实现盈亏须计入买入端费用 ──
test('已实现盈亏：卖出时按比例扣除买入佣金与过户费', async () => {
  // 用美股标的规避 A 股 T+1（同一交易日买入后无法卖出，无法构造平仓场景）
  const uid = 'pnl-user';
  broker.store.ensureAccount(uid);
  const buy = await broker.placeOrder(uid, { symbol: 'AAPL', side: 'buy', type: 'market', qty: 100 });
  assert.equal(buy.order.status, 'filled');
  const sell = await broker.placeOrder(uid, { symbol: 'AAPL', side: 'sell', type: 'market', qty: 100 });
  assert.equal(sell.order.status, 'filled');

  // 成交额 100×10=1000：买入费 = 佣金保底 5；卖出费 = 佣金保底 5
  // 平价进出 → 已实现盈亏 = −(5 + 5) = −10（原实现在此会算成 −5，遗漏买入端费用）
  const today = cnToday();
  assert.equal(broker.store.state.dailyPnl[uid][today], -10);
});
