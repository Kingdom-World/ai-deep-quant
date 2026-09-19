// ─────────────────────────────────────────────────────────────
// 一致性报告 + 衰减监控 + 成本归因 单元测试（评审 P2-4）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-cons-'));
process.env.PAPER_DATA_DIR = tmpDir;
process.env.PAPER_TRADE_247 = '1';

const broker = require('../server/paper/broker.cjs');
const { buildReport, paperStats, decayCheck } = require('../server/paper/consistency.cjs');

broker.init({ getQuote: async () => ({ price: 10, name: '测试', prevClose: 10 }) });

const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const o = (over = {}) => ({
  id: Math.random().toString(36).slice(2, 8),
  status: 'filled',
  fees: { total: 5 },
  ...over,
});

function seedTrades(uid, strategyId) {
  const orders = (broker.store.state.orders[uid] = broker.store.state.orders[uid] || []);
  broker.store.ensureAccount(uid);
  broker.store.state.accounts[uid].initialCapital = 1_000_000;
  // 近 30 日：一买一卖，赚 200（pricePnl 210 − 费 5 − 买入费分摊 5）
  orders.push(o({
    uid, src: strategyId, symbol: 'sh600519', side: 'buy', qty: 100, avgFillPrice: 10,
    createdAt: iso(10), fills: [{}],
  }));
  orders.push(o({
    uid, src: strategyId, symbol: 'sh600519', side: 'sell', qty: 100, avgFillPrice: 12.1,
    createdAt: iso(9), fills: [{}], pricePnl: 210, realized: 200, buyFeeShare: 5,
  }));
  // 此前 90 日：两笔卖出共赚 500
  orders.push(o({
    uid, src: strategyId, symbol: 'sh600519', side: 'sell', qty: 50, avgFillPrice: 11,
    createdAt: iso(60), fills: [{}], pricePnl: 300, realized: 290, buyFeeShare: 5,
  }));
  orders.push(o({
    uid, src: strategyId, symbol: 'sh600519', side: 'sell', qty: 50, avgFillPrice: 11,
    createdAt: iso(50), fills: [{}], pricePnl: 210, realized: 200, buyFeeShare: 5,
  }));
  // 人工单（无 src）不得计入
  orders.push(o({
    uid, src: '', symbol: 'sh600519', side: 'sell', qty: 500, avgFillPrice: 12,
    createdAt: iso(8), fills: [{}], pricePnl: 5000, realized: 4900, buyFeeShare: 0,
  }));
}

test('paperStats：净已实现 = 价差毛盈亏 − 成本；人工单不计入', () => {
  const s = paperStats({
    buys: [{ qty: 100, avgFillPrice: 10, fees: { total: 5 } }],
    sells: [{ qty: 100, avgFillPrice: 12.1, fees: { total: 5 }, realized: 200, pricePnl: 210, buyFeeShare: 5 }],
  });
  assert.equal(s.closedTrades, 1);
  assert.equal(s.realized, 200);
  assert.equal(s.pricePnl, 210);
  assert.equal(s.costs, 10);
  assert.ok(Math.abs(s.realized - (s.pricePnl - s.costs)) < 0.01, '归因恒等式');
});

test('衰减判定：近 30 日亏损而此前盈利 → 触发', () => {
  const recent = { closedTrades: 4, realized: -300, winRate: 25 };
  const prior = { closedTrades: 5, realized: 800, winRate: 70 };
  assert.ok(decayCheck(recent, prior));
  assert.equal(decayCheck({ closedTrades: 0, realized: 0, winRate: null }, prior), null, '无成交不判定');
  assert.equal(decayCheck({ closedTrades: 4, realized: 100, winRate: 60 }, prior), null, '近窗盈利不判定');
});

test('buildReport：三指标差值 + 归因 + 人工单隔离', async () => {
  seedTrades('cons-user', 's1');
  // 合成 K 线：窗口内 40 根缓慢上涨
  const today = new Date();
  const rows = Array.from({ length: 40 }, (_, i) => {
    const d = new Date(today.getTime() - (39 - i) * DAY).toISOString().slice(0, 10);
    const c = 10 + i * 0.05;
    return { date: d, open: c - 0.05, close: c, high: c + 0.1, low: c - 0.1, volume: 1000 };
  });
  const report = await buildReport({
    strategies: [{ id: 's1', uid: 'cons-user', type: 'maCross', symbol: 'sh600519', status: 'running', params: { fast: 5, slow: 20 } }],
    windowDays: 30,
    fetchDailyRows: async () => rows,
    toTencentCode: (s) => s,
  });

  assert.equal(report.strategyCount, 1);
  const entry = report.strategies[0];
  assert.equal(entry.paper.closedTrades, 1, '近 30 日只统计到 1 笔卖出（人工单被 src 隔离）');
  assert.equal(entry.paper.realized, 200);
  assert.equal(entry.paperReturnPct, 0.02); // 200 / 1,000,000
  assert.ok(entry.backtest && entry.backtest.totalReturn !== undefined, '回测口径已运行');
  assert.ok(entry.deltas, '回测有效时应产出三指标差值');
  assert.equal(entry.deltas.tradeCountDiff, entry.paper.closedTrades - entry.backtest.tradeCount);
  assert.ok(Math.abs(entry.costAttribution.netRealized - (entry.costAttribution.grossPricePnl - entry.costAttribution.costs)) < 0.01);
  assert.equal(entry.decay, null, '近窗盈利不触发衰减');
});

test('buildReport：grid 策略出模拟盘统计并标注无回测口径', async () => {
  const report = await buildReport({
    strategies: [{ id: 's2', uid: 'cons-user', type: 'gridTrading', symbol: 'sh600519', status: 'running', params: {} }],
    windowDays: 30,
    fetchDailyRows: async () => [],
    toTencentCode: (s) => s,
  });
  assert.equal(report.strategies[0].backtest.skipped.includes('grid'), true);
  assert.equal(report.strategies[0].deltas, null);
});
