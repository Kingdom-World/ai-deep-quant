// ─────────────────────────────────────────────────────────────
// 模拟交易引擎中枢：订单生命周期 / 持仓与现金账本 / 净值快照 / 撮合循环
//   · 通过 init({ getQuote }) 注入行情函数（复用主服务的行情缓存，避免循环依赖）
//   · 现金在成交时扣收；挂单成交瞬间若资金不足则拒单（不冻结保证金的简化模型）
// ─────────────────────────────────────────────────────────────
const { PaperStore } = require('./store.cjs');
const { fillMarketOrder, tryFillLimitOrder, nowISO } = require('./matcher.cjs');
const { preTradeCheck } = require('./risk.cjs');
const { marketOf } = require('./fees.cjs');

const store = new PaperStore();

let getQuote = null; // async (code) => { price, name, ... } | null

function init({ getQuote: fn }) {
  getQuote = fn;
}

function uidOf(req) {
  // 认证系统接管后按登录用户名分账（多用户数据隔离）
  return req.user?.username || req.authUser || 'default';
}

function logEvent(msg) {
  store.state.logs.push({ t: nowISO(), msg: String(msg).slice(0, 300) });
  if (store.state.logs.length > 500) store.state.logs.splice(0, store.state.logs.length - 500);
}

/** 拉取最新价（失败返回 null） */
async function latestPrice(symbol) {
  if (!getQuote) return null;
  try {
    const q = await getQuote(symbol, symbol);
    return q && Number.isFinite(q.price) ? q : null;
  } catch {
    return null;
  }
}

/** 成交后账本变更：现金、持仓、当日盈亏（卖出时计入已实现盈亏） */
function applyFill(uid, order, price) {
  const acc = store.ensureAccount(uid);
  const positions = store.state.positions[uid];
  const fees = order.fees || { total: 0 };
  const value = order.qty * price;

  if (order.side === 'buy') {
    const cost = value + fees.total;
    if (acc.cash < cost) {
      order.status = 'rejected';
      order.reason = `成交时资金不足（需 ${cost.toFixed(2)}，可用 ${acc.cash.toFixed(2)}）`;
      return false;
    }
    acc.cash = +(acc.cash - cost).toFixed(2);
    let pos = positions.find((p) => p.symbol === order.symbol);
    if (!pos) {
      pos = {
        symbol: order.symbol,
        name: order.name,
        market: marketOf(order.symbol),
        qty: 0,
        avgCost: 0,
        todayBoughtQty: 0,
        todayBoughtDate: nowISO().slice(0, 10),
        todayBuyCount: 0,
      };
      positions.push(pos);
    }
    const newQty = pos.qty + order.qty;
    pos.avgCost = +((pos.avgCost * pos.qty + value) / newQty).toFixed(4);
    pos.qty = newQty;
    pos.name = pos.name || order.name;
    const today = nowISO().slice(0, 10);
    if (pos.todayBoughtDate !== today) {
      pos.todayBoughtDate = today;
      pos.todayBoughtQty = 0;
      pos.todayBuyCount = 0;
    }
    pos.todayBoughtQty += order.qty;
    pos.todayBuyCount += 1;
  } else {
    const pos = positions.find((p) => p.symbol === order.symbol);
    if (!pos || pos.qty < order.qty) {
      order.status = 'rejected';
      order.reason = '持仓不足，卖出拒绝';
      return false;
    }
    const proceeds = value - fees.total;
    acc.cash = +(acc.cash + proceeds).toFixed(2);
    const realized = (price - pos.avgCost) * order.qty - fees.total;
    const today = nowISO().slice(0, 10);
    store.state.dailyPnl[uid][today] = +((store.state.dailyPnl[uid][today] || 0) + realized).toFixed(2);
    pos.qty -= order.qty;
    if (pos.qty <= 0) positions.splice(positions.indexOf(pos), 1);
  }
  return true;
}

/** 下单入口：风控 → 建单 → 立即撮合（市价）/ 挂单（限价） */
async function placeOrder(uid, { symbol, name, side, type, qty, limitPrice }) {
  symbol = String(symbol || '').trim();
  side = String(side) === 'sell' ? 'sell' : 'buy';
  type = String(type) === 'limit' ? 'limit' : 'market';
  qty = Math.floor(Number(qty) || 0);
  limitPrice = Number(limitPrice) || 0;

  const acc = store.ensureAccount(uid);
  if (!symbol) return { ok: false, error: '缺少股票代码' };
  if (qty <= 0) return { ok: false, error: '数量必须为正整数' };
  if (type === 'limit' && limitPrice <= 0) return { ok: false, error: '限价单必须提供有效价格' };

  const quote = await latestPrice(symbol);
  const positions = store.state.positions[uid];

  const order = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    uid,
    symbol,
    name: name || quote?.name || symbol,
    side,
    type,
    qty,
    limitPrice: type === 'limit' ? limitPrice : null,
    estimatePrice: quote?.price || null,
    status: 'pending',
    reason: '',
    fills: [],
    createdAt: nowISO(),
  };

  // 风控前置校验（用最新行情估算总资产）
  const latestPrices = {};
  for (const p of positions) {
    const q = await latestPrice(p.symbol);
    latestPrices[p.symbol] = q?.price || p.avgCost;
  }
  const risk = preTradeCheck({ order, account: acc, positions, latestPrices });
  if (!risk.ok) {
    order.status = 'rejected';
    order.reason = risk.reason;
    store.state.orders[uid].unshift(order);
    store.save();
    logEvent(`拒单 ${side} ${symbol} ×${qty}: ${risk.reason}`);
    return { ok: false, error: risk.reason, order };
  }

  // 立即撮合
  if (type === 'market') {
    fillMarketOrder(order, quote || {});
    if (order.status === 'filled' && !applyFill(uid, order, order.avgFillPrice)) {
      // applyFill 内部已把状态改为 rejected 并写明原因
    }
  } else {
    tryFillLimitOrder(order, quote || {});
    if (order.status === 'filled') applyFill(uid, order, order.avgFillPrice);
    else order.status = 'resting';
  }

  store.state.orders[uid].unshift(order);
  if (store.state.orders[uid].length > 300) store.state.orders[uid].length = 300;
  store.save();
  if (order.status === 'filled') {
    logEvent(`成交 ${side} ${symbol} ×${qty} @ ${order.avgFillPrice}（费 ${order.fees.total}）`);
  } else if (order.status === 'resting') {
    logEvent(`挂单 ${side} ${symbol} ×${qty} @ 限价 ${limitPrice}`);
  }
  return { ok: order.status !== 'rejected', order };
}

/** 取消挂单 */
function cancelOrder(uid, orderId) {
  const order = store.state.orders[uid].find((o) => o.id === orderId);
  if (!order) return { ok: false, error: '订单不存在' };
  if (order.status !== 'resting' && order.status !== 'pending') {
    return { ok: false, error: `当前状态 ${order.status} 不可撤销` };
  }
  order.status = 'canceled';
  order.filledAt = nowISO();
  store.save();
  logEvent(`撤单 ${order.side} ${order.symbol} ×${order.qty}`);
  return { ok: true };
}

/** 撮合循环：每 5s 重试挂单；每 60s 记录净值快照 */
let tickCount = 0;
async function runMatcher() {
  tickCount += 1;
  try {
    for (const uid of Object.keys(store.state.accounts)) {
      const resting = store.state.orders[uid].filter((o) => o.status === 'resting');
      for (const order of resting) {
        const quote = await latestPrice(order.symbol);
        if (!quote) continue;
        const before = order.status;
        tryFillLimitOrder(order, quote);
        if (order.status === 'filled' && before !== 'filled') {
          if (applyFill(uid, order, order.avgFillPrice)) {
            logEvent(`挂单成交 ${order.side} ${order.symbol} ×${order.qty} @ ${order.avgFillPrice}`);
          }
        }
      }

      // 净值快照（每 12 个 tick ≈ 60s）
      if (tickCount % 12 === 0) {
        const acc = store.state.accounts[uid];
        const positions = store.state.positions[uid];
        let marketValue = 0;
        for (const p of positions) {
          const q = await latestPrice(p.symbol);
          marketValue += p.qty * (q?.price || p.avgCost);
        }
        const total = +(acc.cash + marketValue).toFixed(2);
        const eq = store.state.equity[uid];
        const last = eq[eq.length - 1];
        if (!last || last.total !== total) {
          eq.push({ t: nowISO(), total, cash: +acc.cash.toFixed(2), marketValue: +marketValue.toFixed(2) });
          if (eq.length > 5000) eq.splice(0, eq.length - 5000);
        }
      }
    }
    store.save();
  } catch (e) {
    console.error('[PaperBroker] 撮合循环异常:', e.message);
  }
}

/** 账户快照（前端展示） */
async function accountSnapshot(uid) {
  const acc = store.ensureAccount(uid);
  const positions = [];
  let marketValue = 0;
  for (const p of store.state.positions[uid]) {
    const q = await latestPrice(p.symbol);
    const price = q?.price || p.avgCost;
    const value = +(p.qty * price).toFixed(2);
    marketValue += value;
    positions.push({
      ...p,
      lastPrice: price,
      marketValue: value,
      unrealizedPnl: +((price - p.avgCost) * p.qty).toFixed(2),
      unrealizedPct: +(((price - p.avgCost) / p.avgCost) * 100).toFixed(2),
    });
  }
  marketValue = +marketValue.toFixed(2);
  const total = +(acc.cash + marketValue).toFixed(2);
  const today = nowISO().slice(0, 10);
  const totalPnl = +(total - acc.initialCapital).toFixed(2);
  return {
    uid,
    cash: +acc.cash.toFixed(2),
    initialCapital: acc.initialCapital,
    marketValue,
    totalAssets: total,
    totalPnl,
    totalPnlPct: +((totalPnl / acc.initialCapital) * 100).toFixed(2),
    todayPnl: +(store.state.dailyPnl[uid][today] || 0).toFixed(2),
    positions,
    orders: store.state.orders[uid].slice(0, 100),
    equity: store.state.equity[uid].slice(-500),
  };
}

module.exports = { init, placeOrder, cancelOrder, runMatcher, accountSnapshot, logEvent, store, uidOf };
