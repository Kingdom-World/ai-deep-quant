// ─────────────────────────────────────────────────────────────
// 行情不可得时的估值口径回归锁（2026-10-25 修 fail-open）
//
//   原实现各处直接写 `q?.price || p.avgCost`：行情缺失时回退**成本价**。
//   但 avgCost 是「你当初多少钱买的」的记录，**不是它现在值多少钱**。
//   用它算总资产的后果不是显示偏差，而是两处风控失效：
//     · preTradeCheck：单笔 20% / 单标的 30% 的分母虚高 ⇒ 比例限制形同虚设
//     · 回撤熔断：股价腰斩而行情不可用时市值仍按成本计 ⇒ 净值不跌 ⇒ 熔断永不触发
//   两者都属于 fail-open（拿不到数据就假装安全），而风控必须 fail-closed。
//
//   本文件锁定修复后的口径：实时价 > 前收 > 不可估值 ⇒ 买入拒绝 / 卖出放行。
//   （每个用例都在修改实现后验证过会变红 —— 不变红的锁不是锁。）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-unpriced-'));
process.env.PAPER_DATA_DIR = tmpDir;
process.env.PAPER_TRADE_247 = '1'; // 免交易时段拦截（构造场景用，与被测口径无关）
process.env.PAPER_RISK_OFF = '1'; // 隔离：关掉熔断，本文件只测估值口径
process.env.PAPER_MAX_ORDER_PCT = '1';
process.env.PAPER_MAX_POSITION_PCT = '1';
process.env.PAPER_MAX_DAILY_BUYS = '10';

const broker = require('../server/paper/broker.cjs');
const { preTradeCheck } = require('../server/paper/risk.cjs');

// 行情三种形态：正常 / 只有前收 / 完全不可得
let quoteMode = 'live';
let lastPrice = 10;
broker.init({
  getQuote: async () => {
    if (quoteMode === 'none') return null; // 连 getQuote 都拿不到东西
    if (quoteMode === 'prevCloseOnly') return { name: '测试', prevClose: 8.5 }; // 有前收、无实时价
    return { name: '测试', price: lastPrice, prevClose: lastPrice };
  },
});

const uid = 'unpriced-user';

test('前置：正常行情下建仓（1000 股 @10）', async () => {
  broker.store.ensureAccount(uid);
  const r = await broker.placeOrder(uid, { symbol: 'sh600519', side: 'buy', type: 'market', qty: 1000 });
  assert.equal(r.order.status, 'filled');
  const pos = broker.store.state.positions[uid].find((p) => p.symbol === 'sh600519');
  assert.ok(pos && pos.qty === 1000 && pos.avgCost > 0, '应持有 1000 股且有成本价');
});

test('🔴 行情完全不可得 ⇒ 拒绝新开仓（不得用成本价冒充估值）', async () => {
  quoteMode = 'none';
  try {
    const buy = await broker.placeOrder(uid, { symbol: 'sh600036', side: 'buy', type: 'market', qty: 100 });
    assert.equal(buy.ok, false, '行情不可得时必须拒绝，而不是拿成本价算出"看起来正常"的总资产后放行');
    assert.match(buy.error, /无可用行情|无法可靠估算总资产/, `拒单理由应说明原因，实际：${buy.error}`);
  } finally {
    quoteMode = 'live';
  }
});

test('🔴 估值单一实现：实时价 > 前收 > 不可估值（且签名上就拿不到成本价）', () => {
  // 为什么必须直接锁它：broker 构造 latestPrices 时决定「行情缺失用哪个数」，这一步错了后面全错。
  // 而它无法只用端到端断言 —— 市价单缺 price 时本来就成交不了，会把原因掩盖掉。
  const { valuationOf } = broker;

  assert.deepEqual(
    valuationOf({ price: 10, prevClose: 9 }),
    { price: 10, source: 'live' },
    '有实时价就该用实时价',
  );

  const pc = valuationOf({ prevClose: 8.5 });
  assert.equal(pc.price, 8.5, '无实时价时退回前收（前收同属市场事实）');
  assert.equal(pc.source, 'prevClose');

  // 不可估值的各种形态都必须返回 null —— 用任何数字冒充都会让风控重新失真
  for (const bad of [null, undefined, {}, { price: 0 }, { price: NaN }, { prevClose: NaN }]) {
    const v = valuationOf(bad);
    assert.equal(v.price, null, `不可估值必须返回 null，不得拿任何数冒充：got ${v.price}`);
    assert.equal(v.source, 'unknown');
  }
});

test('🔴 占比计算必须随估值变化（防止「px 被约掉」的假通过）', () => {
  // ⚠️ 构造陷阱：若只有单一持仓且现金为 0，则 newPosValue 与 totalAssets 都线性含 px，
  //    比值 newQty/qty 与 px 无关 ⇒ 无论传 8.5 还是 100 结论都一样，测不出差别。
  //    所以这里必须引入**与 px 无关的现金**作锚，让两种口径拉开距离：
  //      · 按前收 8.5 估值 ⇒ 占比 ≈ 46.4% ⇒ 放行
  //      · 按成本价 100 估值 ⇒ 占比 ≈ 91.8% ⇒ 必须拒绝
  const saved = process.env.PAPER_MAX_POSITION_PCT;
  process.env.PAPER_MAX_POSITION_PCT = '0.6';
  try {
    const check = (px) =>
      preTradeCheck({
        order: { symbol: 'X', side: 'buy', type: 'market', qty: 100, estimatePrice: px },
        account: { cash: 100000 },
        positions: [{ symbol: 'X', qty: 10000, avgCost: 100 }],
        latestPrices: { X: px },
      });

    assert.equal(check(8.5).ok, true, '真实估值（前收 8.5）：占比约 46%，应放行');
    assert.equal(
      check(100).ok,
      false,
      '若分母按成本价 100 计（虚高）：占比约 92%，必须拒绝 —— 这条防止回退成本价的做法复活',
    );
  } finally {
    process.env.PAPER_MAX_POSITION_PCT = saved;
  }
});

test('🔴 latestPrices 为 null ⇒ 买入拒绝、卖出放行', () => {
  const base = {
    account: { cash: 10000 },
    positions: [{ symbol: 'X', qty: 100, avgCost: 10 }],
    latestPrices: { X: null }, // 调用方用 null 明确表示「不可估值」
  };

  const buy = preTradeCheck({
    ...base,
    order: { symbol: 'X', side: 'buy', type: 'market', qty: 100, estimatePrice: 10 },
  });
  assert.equal(buy.ok, false, '不可估值时买入必须拒绝（总资产不可信）');
  assert.match(buy.reason, /无可用行情/);

  const sell = preTradeCheck({
    ...base,
    order: { symbol: 'X', side: 'sell', type: 'market', qty: 100, estimatePrice: 10 },
  });
  assert.equal(sell.ok, true, '卖出减少敞口且不依赖估值判断安全性，应放行');
});

test('🔴 卖出不该被「无可用行情」这条理由拦下（理由里不得出现估值缺失）', () => {
  const r = preTradeCheck({
    account: { cash: 10000 },
    positions: [{ symbol: 'X', qty: 100, avgCost: 10 }],
    latestPrices: { X: null },
    order: { symbol: 'X', side: 'sell', type: 'market', qty: 100, estimatePrice: 10 },
  });
  assert.ok(
    !/无可用行情/.test(r.reason || ''),
    `卖出若被以估值缺失为由拒绝，等于把 fail-closed 用错了方向：${r.reason}`,
  );
});
