// ─────────────────────────────────────────────────────────────
// 模拟交易模块单元测试：fees / matcher / risk / store
// 运行：npm test（PAPER_DATA_DIR 指向临时目录，不污染真实账本）
// ─────────────────────────────────────────────────────────────
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { calcFees, marketOf } = require('../server/paper/fees.cjs');
const { fillMarketOrder, tryFillLimitOrder } = require('../server/paper/matcher.cjs');
const { preTradeCheck } = require('../server/paper/risk.cjs');

// ── 手续费 ──
// 口径：佣金万2.5（最低5元）+ 卖出印花税万5（2023-08-28 起减半后现行税率）+ 过户费0.001%（买卖双向）
test('A股佣金：万2.5、最低5元；印花税仅卖出收取；过户费双边万0.1', () => {
  const buy = calcFees('CN', 'buy', 100000);
  assert.equal(buy.commission, 25);
  assert.equal(buy.stampTax, 0);
  assert.equal(buy.transferFee, 1); // 100000 × 0.00001
  assert.equal(buy.total, 26);

  const sell = calcFees('CN', 'sell', 100000);
  assert.equal(sell.stampTax, 50);
  assert.equal(sell.transferFee, 1);
  assert.equal(sell.total, 76);

  const tiny = calcFees('CN', 'buy', 1000); // 1000×0.00025=0.25 → 保底 5
  assert.equal(tiny.commission, 5);
});

test('港美股：不收过户费与印花税（简化口径）', () => {
  assert.equal(calcFees('US', 'sell', 100000).transferFee, 0);
  assert.equal(calcFees('US', 'sell', 100000).stampTax, 0);
  assert.equal(calcFees('HK', 'buy', 100000).transferFee, 0);
});

test('marketOf 市场识别', () => {
  assert.equal(marketOf('sh600519'), 'CN');
  assert.equal(marketOf('sz000858'), 'CN');
  assert.equal(marketOf('hk00700'), 'HK');
  assert.equal(marketOf('AAPL'), 'US');
});

// ── 撮合 ──
function newOrder(overrides = {}) {
  return {
    id: 't1',
    symbol: 'sh600519',
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

test('市价单：无有效行情 → 拒单并说明原因', () => {
  const o = newOrder();
  fillMarketOrder(o, {});
  assert.equal(o.status, 'rejected');
  assert.ok(o.reason.includes('无有效行情'));
});

test('市价单：按最新价成交并计费（小额触发 5 元佣金保底）', () => {
  const o = newOrder();
  fillMarketOrder(o, { price: 100 });
  assert.equal(o.status, 'filled');
  assert.equal(o.avgFillPrice, 100);
  // 100×100=10000 → 佣金 2.5 触发保底 5 元；过户费 10000×0.00001=0.1
  assert.equal(o.fees.commission, 5);
  assert.equal(o.fees.transferFee, 0.1);
  assert.equal(o.fees.total, 5.1);
});

test('限价单：买入 ≤ 限价成交、高于限价继续挂起', () => {
  const filled = newOrder({ type: 'limit', limitPrice: 10 });
  tryFillLimitOrder(filled, { price: 9.5 });
  assert.equal(filled.status, 'filled');

  const resting = newOrder({ type: 'limit', limitPrice: 10 });
  tryFillLimitOrder(resting, { price: 10.5 });
  assert.equal(resting.status, 'pending');
});

test('限价单卖出：≥ 限价成交', () => {
  const o = newOrder({ side: 'sell', type: 'limit', limitPrice: 10 });
  tryFillLimitOrder(o, { price: 10.5 });
  assert.equal(o.status, 'filled');
});

// ── 风控 ──
test('风控：单笔委托超过总资产 20% 拒绝', () => {
  const r = preTradeCheck({
    order: { symbol: 'sh600519', side: 'buy', type: 'market', qty: 300, estimatePrice: 1297 },
    account: { cash: 1000000 },
    positions: [],
    latestPrices: {},
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('20%'));
});

test('风控：调仓后单标的持仓超过总资产 30% 拒绝', () => {
  const r = preTradeCheck({
    order: { symbol: 'X', side: 'buy', type: 'market', qty: 200, estimatePrice: 10 },
    account: { cash: 9000 },
    positions: [{ symbol: 'X', qty: 300, avgCost: 10 }],
    latestPrices: { X: 10 },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('单标的'));
});

test('风控：正常小额买单通过', () => {
  const r = preTradeCheck({
    order: { symbol: 'X', side: 'buy', type: 'market', qty: 100, estimatePrice: 10 },
    account: { cash: 10000 },
    positions: [{ symbol: 'X', qty: 100, avgCost: 10 }],
    latestPrices: { X: 10 },
  });
  assert.equal(r.ok, true);
});

// ── 持久化（独立临时目录，不碰真实账本） ──
let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-test-'));
  process.env.PAPER_DATA_DIR = tmpDir;
});

test('store：账户创建 / 落盘 / 重载 / 重置', async () => {
  const { PaperStore } = require('../server/paper/store.cjs');
  const s1 = new PaperStore();
  const acc = s1.ensureAccount('tester');
  assert.equal(acc.cash, 1_000_000);
  acc.cash = 888888;
  s1.save();

  const s2 = new PaperStore();
  assert.equal(s2.state.accounts.tester.cash, 888888);

  s2.reset('tester');
  assert.equal(s2.state.accounts.tester.cash, 1_000_000);
  assert.ok(fs.existsSync(path.join(tmpDir, 'state.json')));
});
