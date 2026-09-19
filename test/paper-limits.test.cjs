// ─────────────────────────────────────────────────────────────
// 撮合守卫回归测试：涨跌停市价/限价守卫 + T+1 下单层 + 撤单全流程
//   评审致命缺陷 #4（零滑点 + 市价单无涨跌停约束）与未测场景补齐
//
//   ⚠️ process.env 必须在 require broker 之前设置——
//   PaperStore 在模块加载时实例化，晚设置会污染真实账本。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-limits-'));
process.env.PAPER_DATA_DIR = tmpDir;
process.env.PAPER_TRADE_247 = '1'; // 全天可交易，避免测试随时段漂移
process.env.PAPER_MAX_ORDER_PCT = '0.2';
process.env.PAPER_MAX_POSITION_PCT = '0.3';
process.env.PAPER_MAX_DAILY_BUYS = '10';

const { fillMarketOrder, tryFillLimitOrder } = require('../server/paper/matcher.cjs');
const broker = require('../server/paper/broker.cjs');

function newOrder(overrides = {}) {
  return {
    id: 't9',
    symbol: 'sh600000',
    side: 'buy',
    type: 'market',
    qty: 100,
    limitPrice: null,
    status: 'pending',
    reason: '',
    fills: [],
    ...overrides,
  };
}

// ── 市价单涨跌停守卫 ──
test('市价买入：当前价已达涨停价 → 拒单（主板 10%）', () => {
  const o = newOrder();
  fillMarketOrder(o, { price: 11.0, prevClose: 10.0 });
  assert.equal(o.status, 'rejected');
  assert.ok(o.reason.includes('涨停'), o.reason);
});

test('市价买入：未触板正常成交', () => {
  const o = newOrder();
  fillMarketOrder(o, { price: 10.99, prevClose: 10.0 });
  assert.equal(o.status, 'filled');
});

test('市价卖出：当前价已达跌停价 → 拒单', () => {
  const o = newOrder({ side: 'sell' });
  fillMarketOrder(o, { price: 9.0, prevClose: 10.0 });
  assert.equal(o.status, 'rejected');
  assert.ok(o.reason.includes('跌停'), o.reason);
});

test('创业板 20% 涨跌停幅度正确', () => {
  const sealed = newOrder({ symbol: 'sz300001' });
  fillMarketOrder(sealed, { price: 12.0, prevClose: 10.0 }); // 10 × 1.2 = 12.00 封板
  assert.equal(sealed.status, 'rejected');

  const ok = newOrder({ symbol: 'sz300001' });
  fillMarketOrder(ok, { price: 11.99, prevClose: 10.0 });
  assert.equal(ok.status, 'filled');
});

test('ST 5% 涨跌停幅度正确', () => {
  const o = newOrder({ symbol: 'sz000001', name: 'ST测试' });
  fillMarketOrder(o, { price: 10.5, prevClose: 10.0 }); // 5% → 10.50 封板
  assert.equal(o.status, 'rejected');
});

test('无 prevClose 时跳过涨跌停校验（fail-open，与下单侧限价校验同口径）', () => {
  const o = newOrder();
  fillMarketOrder(o, { price: 11.0 });
  assert.equal(o.status, 'filled');
});

test('限价挂单轮询触板：不成交继续挂起，回落后正常成交', () => {
  const o = newOrder({ type: 'limit', limitPrice: 10.5 });
  tryFillLimitOrder(o, { price: 11.0, prevClose: 10.0 }); // 涨停，买不进
  assert.equal(o.status, 'pending');
  assert.equal(o.fills.length, 0);
  tryFillLimitOrder(o, { price: 10.4, prevClose: 10.0 }); // 回落后成交
  assert.equal(o.status, 'filled');
});

// ── 集成：T+1 下单层 + 撤单全流程 ──
broker.init({ getQuote: async () => ({ price: 10, name: '测试标的', prevClose: 10 }) });

test('T+1 下单层：当日买入的股份当日卖出被拒', async () => {
  const uid = 't1-user';
  broker.store.ensureAccount(uid);
  const buy = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'buy', type: 'market', qty: 100 });
  assert.equal(buy.order.status, 'filled');
  const sell = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'sell', type: 'market', qty: 100 });
  assert.equal(sell.ok, false);
  assert.ok(sell.error.includes('T+1'), sell.error);
});

test('撤单全流程：resting → canceled → 重复撤单报错', async () => {
  const uid = 'cancel-user';
  broker.store.ensureAccount(uid);
  const placed = await broker.placeOrder(uid, {
    symbol: 'sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 5,
  });
  assert.equal(placed.order.status, 'resting');
  const canceled = await broker.cancelOrder(uid, placed.order.id);
  assert.equal(canceled.ok, true);
  const again = await broker.cancelOrder(uid, placed.order.id);
  assert.equal(again.ok, false);
  assert.ok(again.error.includes('不可撤销'), again.error);
});
