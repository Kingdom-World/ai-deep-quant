// ─────────────────────────────────────────────────────────────
// 回撤熔断回归测试（评审 P2-2）：两级阈值 / 锁定 / 解锁
//   场景：90,000 股 @10 建仓（总资产 1M）→ 股价跌至 8.5（回撤 ~13.5% → L1）
//   → 跌至 8.0（回撤 ~18% → L2 锁定）→ 解锁重置基准 → 恢复买入
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-cb-'));
process.env.PAPER_DATA_DIR = tmpDir;
process.env.PAPER_TRADE_247 = '1';
process.env.PAPER_MAX_ORDER_PCT = '1';
process.env.PAPER_MAX_POSITION_PCT = '1';
process.env.PAPER_MAX_DAILY_BUYS = '10';
process.env.PAPER_DD_HALT = '0.10';
process.env.PAPER_DD_LOCK = '0.15';

const broker = require('../server/paper/broker.cjs');

let quotePrice = 10;
broker.init({ getQuote: async () => ({ price: quotePrice, name: '测试', prevClose: quotePrice }) });

const uid = 'cb-user';

test('建仓后净值 1M 为高水位', async () => {
  broker.store.ensureAccount(uid);
  const r = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'buy', type: 'market', qty: 90000 });
  assert.equal(r.order.status, 'filled');
  assert.equal(broker.store.state.accounts[uid].peakAssets, 1_000_000);
  assert.equal(broker.store.state.accounts[uid].ddLevel, 0);
});

test('回撤 13.5% → L1：买入被拒、卖出减仓放行', async () => {
  quotePrice = 8.5; // 持仓 765k + 现金 ~99,766 → 总资产 ~864.8k，回撤 ~13.5%
  const buy = await broker.placeOrder(uid, { symbol: 'sh600036', side: 'buy', type: 'market', qty: 100 });
  assert.equal(buy.ok, false);
  assert.ok(buy.error.includes('回撤熔断'), buy.error);
  assert.ok(buy.error.includes('L1'), buy.error);
  assert.equal(broker.store.state.accounts[uid].ddLevel, 1);

  // 卖出减仓放行（T+1 锁定手动解除以构造可卖）
  const pos = broker.store.state.positions[uid].find((p) => p.symbol === 'sh600519');
  pos.todayBoughtDate = '2020-01-01';
  pos.todayBoughtQty = 0;
  const sell = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'sell', type: 'market', qty: 1000 });
  assert.equal(sell.order.status, 'filled', '熔断期卖出减仓必须放行');
});

test('回撤 18% → L2：riskLocked 锁定，仍可卖出', async () => {
  quotePrice = 8.0; // 持仓 712k + 现金 ~108k → 总资产 ~820k，回撤 ~18%
  const buy = await broker.placeOrder(uid, { symbol: 'sh600036', side: 'buy', type: 'market', qty: 100 });
  assert.equal(buy.ok, false);
  assert.ok(buy.error.includes('L2'), buy.error);
  const acc = broker.store.state.accounts[uid];
  assert.equal(acc.riskLocked, true);
  assert.equal(acc.ddLevel, 2);

  const pos = broker.store.state.positions[uid].find((p) => p.symbol === 'sh600519');
  const sell = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'sell', type: 'market', qty: 1000 });
  assert.equal(sell.order.status, 'filled', '锁定期卖出减仓仍放行');
});

test('手动解锁：基准重置为当前净值，买入恢复', async () => {
  const r = await broker.unlockAccount(uid);
  assert.equal(r.ok, true);
  const acc = broker.store.state.accounts[uid];
  assert.equal(acc.riskLocked, false);
  assert.equal(acc.ddLevel, 0);
  assert.ok(acc.peakAssets < 1_000_000, '基准已重置为当前净值');

  const buy = await broker.placeOrder(uid, { symbol: 'sh600036', side: 'buy', type: 'market', qty: 100 });
  assert.equal(buy.ok, true, '解锁后买入恢复');
});

test('快照透出熔断状态字段', async () => {
  const snap = await broker.accountSnapshot(uid);
  assert.ok(Number.isFinite(snap.drawdownPct));
  assert.ok(Number.isFinite(snap.peakAssets));
  assert.equal(snap.riskLocked, false);
});
