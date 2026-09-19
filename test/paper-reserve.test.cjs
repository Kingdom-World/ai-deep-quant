// ─────────────────────────────────────────────────────────────
// 挂单冻结资金 + GFD 当日有效 回归测试（评审 P1-4）
//   ⚠️ process.env 必须在 require broker 之前设置（PaperStore 模块加载即实例化）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-reserve-'));
process.env.PAPER_DATA_DIR = tmpDir;
process.env.PAPER_TRADE_247 = '1';
process.env.PAPER_MAX_ORDER_PCT = '1'; // 风控按「可用现金」口径（扣除冻结）天然构成第一道防线
process.env.PAPER_MAX_POSITION_PCT = '1';
process.env.PAPER_MAX_DAILY_BUYS = '10';
process.env.PAPER_RISK_OFF = '1'; // 本文件测试冻结逻辑，回撤熔断由 paper-circuitbreaker.test.cjs 专测

const { calcFees } = require('../server/paper/fees.cjs');
const broker = require('../server/paper/broker.cjs');

let quotePrice = 10;
// prevClose 跟随现价：保证限价 12 相对 prevClose 15 不触发涨停校验（真实场景由行情提供）
broker.init({ getQuote: async () => ({ price: quotePrice, name: '测试标的', prevClose: quotePrice }) });

function cnToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

test('限价买单挂单冻结资金：冻结额=限价×数量+买入费，撤单后全额释放', async () => {
  const uid = 'reserve-buyer';
  broker.store.ensureAccount(uid);
  const r = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 5 });
  assert.equal(r.order.status, 'resting');
  const expected = +(100 * 5 + calcFees('CN', 'buy', 500).total).toFixed(2);
  assert.equal(r.order.reservedCash, expected);
  const acc = broker.store.state.accounts[uid];
  assert.equal(acc.reservedCash, expected);
  assert.equal(acc.cash, 1_000_000, '冻结不动扣现金，只记占用');

  const cancel = await broker.cancelOrder(uid, r.order.id);
  assert.equal(cancel.ok, true);
  assert.equal(broker.store.state.accounts[uid].reservedCash, 0, '撤单释放冻结');
});

test('挂单约束：超过可用资金的挂单必被拒绝（风控/冻结双重防线）', async () => {
  const uid = 'reserve-limit';
  const acc = broker.store.ensureAccount(uid);
  acc.cash = 1000;
  const ok = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 9.5 });
  assert.equal(ok.order.status, 'resting', '955.01（限价+费）≤ 1000 可冻结');
  assert.equal(acc.reservedCash, +(950 + calcFees('CN', 'buy', 950).total).toFixed(2));

  // 冻结后可用仅 ~45 元 → 再挂 100 股必被拒（单笔上限按可用现金口径先拦，冻结校验兜底费率边际）
  const over = await broker.placeOrder(uid, { symbol: 'sh600036', side: 'buy', type: 'limit', qty: 100, limitPrice: 9.5 });
  assert.equal(over.ok, false);
  assert.ok(over.error.includes('上限') || over.error.includes('冻结'), over.error);
  assert.equal(acc.reservedCash, +(950 + calcFees('CN', 'buy', 950).total).toFixed(2), '被拒订单不产生新冻结');
  assert.ok(!over.order.reservedCash, '被拒订单自身无冻结额');
});

test('挂单成交：按实际成交价扣款并释放冻结（差额留可用）', async () => {
  const uid = 'reserve-fill';
  broker.store.ensureAccount(uid);
  quotePrice = 15; // 高于限价 → 挂起
  const r = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 12 });
  assert.equal(r.order.status, 'resting');
  const reservedBefore = broker.store.state.accounts[uid].reservedCash;
  assert.equal(reservedBefore, +(1200 + calcFees('CN', 'buy', 1200).total).toFixed(2)); // 限价×数量 + 买入费

  quotePrice = 10; // 回落 → 撮合循环以 10 成交（优于限价）
  await broker.runMatcher();
  const order = broker.store.state.orders[uid].find((o) => o.id === r.order.id);
  assert.equal(order.status, 'filled');
  assert.equal(order.avgFillPrice, 10);
  const acc = broker.store.state.accounts[uid];
  assert.equal(acc.reservedCash, 0, '成交释放全部冻结');
  // 实扣 = 1000 + 买入费(佣金5+过户0.01) = 1005.01
  assert.equal(acc.cash, +(1_000_000 - 1005.01).toFixed(2), '按实际成交价扣款，冻结差额留作可用');
});

test('GFD：过期挂单被撮合循环自动撤销并释放冻结', async () => {
  const uid = 'reserve-gfd';
  broker.store.ensureAccount(uid);
  quotePrice = 15;
  const r = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'buy', type: 'limit', qty: 100, limitPrice: 12 });
  assert.equal(r.order.status, 'resting');
  assert.equal(r.order.validUntil, cnToday(), '247 模式视为盘中挂出 → 当日有效');

  const order = broker.store.state.orders[uid].find((o) => o.id === r.order.id);
  order.validUntil = '2020-01-01'; // 人为过期
  quotePrice = 10;
  await broker.runMatcher();
  assert.equal(order.status, 'canceled');
  assert.ok(order.reason.includes('GFD'), order.reason);
  assert.equal(broker.store.state.accounts[uid].reservedCash, 0, '过期撤销释放冻结');
});

test('卖出挂单冻结持仓：可卖扣除冻结，撤单后恢复', async () => {
  const uid = 'reserve-seller';
  broker.store.ensureAccount(uid);
  quotePrice = 10;
  const buy = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'buy', type: 'market', qty: 200 });
  assert.equal(buy.order.status, 'filled');
  // T+1：今日买入锁定。把买入日改到昨天以构造可卖持仓（仅测试环境）
  const pos = broker.store.state.positions[uid].find((p) => p.symbol === 'sh600519');
  pos.todayBoughtDate = '2020-01-01';
  pos.todayBoughtQty = 0;

  quotePrice = 15; // 高于限价 → 卖单挂起
  const sell = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'sell', type: 'limit', qty: 100, limitPrice: 20 });
  assert.equal(sell.order.status, 'resting');
  assert.equal(pos.reservedQty, 100);

  const snap = await broker.accountSnapshot(uid);
  const snapPos = snap.positions.find((p) => p.symbol === 'sh600519');
  assert.equal(snapPos.sellableQty, 100, '可卖 = 持仓 200 − 冻结 100');

  // 委托 150 超过剩余可卖 100 → 拒单
  const oversell = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'sell', type: 'market', qty: 150 });
  assert.equal(oversell.ok, false);

  await broker.cancelOrder(uid, sell.order.id);
  assert.equal(pos.reservedQty, 0, '撤单释放持仓冻结');
  const oversell2 = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'sell', type: 'market', qty: 150 });
  assert.equal(oversell2.order.status, 'filled', '释放后可卖恢复 200');
});
