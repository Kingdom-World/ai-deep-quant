// ─────────────────────────────────────────────────────────────
// 每日账实对账单元测试（评审 P2-3）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-recon-'));
process.env.PAPER_DATA_DIR = tmpDir;
process.env.PAPER_TRADE_247 = '1';
process.env.PAPER_MAX_ORDER_PCT = '1';
process.env.PAPER_MAX_POSITION_PCT = '1';
process.env.PAPER_MAX_DAILY_BUYS = '10';

const broker = require('../server/paper/broker.cjs');
const { reconcileAccount, reconcileAll } = require('../server/paper/reconcile.cjs');

broker.init({ getQuote: async () => ({ price: 10, name: '测试', prevClose: 10 }) });

test('健康账本零问题（含挂单冻结场景）', async () => {
  const uid = 'recon-clean';
  broker.store.ensureAccount(uid);
  const buy = await broker.placeOrder(uid, { symbol: 'AAPL', side: 'buy', type: 'market', qty: 100 });
  assert.equal(buy.order.status, 'filled');
  // 挂一张不会成交的限价单（冻结资金）——健康状态应包含合法冻结
  const limit = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'buy', type: 'limit', qty: 10, limitPrice: 5 });
  assert.equal(limit.order.status, 'resting');

  const issues = reconcileAccount(uid, broker.store.state);
  assert.deepEqual(issues, [], `健康账本不应有问题: ${issues.join(';')}`);
  assert.equal(reconcileAll(broker.store).ok, true);
});

test('注入违规：负现金 / 冻结越界 / 冻结账实不符 全部被抓出', () => {
  const uid = 'recon-bad';
  const state = broker.store.state;
  state.accounts[uid] = { cash: -100, reservedCash: 500, initialCapital: 1_000_000 };
  state.positions[uid] = [
    { symbol: 'sh600519', market: 'CN', qty: 10, avgCost: 10, reservedQty: 20 },
  ];
  state.orders[uid] = [];
  state.equity[uid] = [];

  const issues = reconcileAccount(uid, state);
  assert.ok(issues.some((i) => i.includes('现金为负')), issues.join(';'));
  assert.ok(issues.some((i) => i.includes('冻结现金 500 超过现金')), issues.join(';'));
  assert.ok(issues.some((i) => i.includes('冻结股数 20 超过持仓')), issues.join(';'));
  assert.ok(issues.some((i) => i.includes('冻结现金账实不符')), issues.join(';'));
  assert.ok(issues.some((i) => i.includes('冻结股数账实不符')), issues.join(';'));
  assert.equal(reconcileAll(broker.store).ok, false);
});

test('订单状态一致性：filled 无明细 / resting 缺 GFD / 非 resting 占冻结 / pending 滞留', () => {
  const uid = 'recon-orders';
  const state = broker.store.state;
  state.accounts[uid] = { cash: 1_000_000, reservedCash: 50, initialCapital: 1_000_000 };
  state.positions[uid] = [];
  state.equity[uid] = [];
  state.orders[uid] = [
    { id: 'a', status: 'filled', fills: [] },                                       // 已成交无明细
    { id: 'b', status: 'resting', reservedCash: 50, validUntil: undefined },        // 缺 GFD
    { id: 'c', status: 'canceled', reservedCash: 30 },                              // 非 resting 仍占冻结
    { id: 'd', status: 'pending', createdAt: new Date(Date.now() - 7200_000).toISOString() }, // 滞留 2h
  ];

  const issues = reconcileAccount(uid, state);
  assert.ok(issues.some((i) => i.includes('已成交但无成交明细')), issues.join(';'));
  assert.ok(issues.some((i) => i.includes('缺 GFD 有效期')), issues.join(';'));
  assert.ok(issues.some((i) => i.includes('状态 canceled 仍占用冻结资金')), issues.join(';'));
  assert.ok(issues.some((i) => i.includes('pending 滞留超 1 小时')), issues.join(';'));
  // 冻结账实：挂单合计 50（b）与账本 50 一致 → 不应出现现金冻结不符
  assert.ok(!issues.some((i) => i.includes('冻结现金账实不符')), issues.join(';'));
});

test('净值快照现金项不一致被抓出', () => {
  const uid = 'recon-equity';
  const state = broker.store.state;
  state.accounts[uid] = { cash: 5000, reservedCash: 0, initialCapital: 1_000_000 };
  state.positions[uid] = [];
  state.equity[uid] = [{ t: new Date().toISOString(), total: 9999, cash: 4800, marketValue: 5199 }];
  state.orders[uid] = [];
  const issues = reconcileAccount(uid, state);
  assert.ok(issues.some((i) => i.includes('净值快照现金(4800) 与账本(5000) 不一致')), issues.join(';'));
});
