// ─────────────────────────────────────────────────────────────
// 撮合引擎
//   · 市价单：按最新成交价立即成交；停牌/无行情 → 拒单并给出明确原因
//   · 限价单：立即尝试成交，未成交部分挂入 resting 撮合队列，
//     每次 runMatcher 轮询时用最新行情重试
//   · 撮合频率：每 5 秒一次（PAPER_MATCH_INTERVAL_MS 可调）
// ─────────────────────────────────────────────────────────────
const { calcFees, marketOf } = require('./fees.cjs');

function nowISO() {
  return new Date().toISOString();
}

/** 市价单按最新价立即撮合 */
function fillMarketOrder(order, quote) {
  const price = Number(quote.price);
  if (!Number.isFinite(price) || price <= 0) {
    order.status = 'rejected';
    order.reason = '无有效行情（可能停牌或代码错误），市价单拒绝';
    return;
  }
  execFill(order, price);
}

/** 限价单按最新价判断能否成交 */
function tryFillLimitOrder(order, quote) {
  const price = Number(quote.price);
  if (!Number.isFinite(price) || price <= 0) return; // 无行情：继续挂着
  const fillable = order.side === 'buy' ? price <= order.limitPrice : price >= order.limitPrice;
  if (fillable) execFill(order, price);
}

/** 按指定价格完成成交：更新持仓、扣款/收款、写订单成交明细 */
function execFill(order, price) {
  const fees = calcFees(marketOf(order.symbol), order.side, order.qty * price);
  order.fills.push({
    price: +price.toFixed(4),
    qty: order.qty,
    fees,
    at: nowISO(),
  });
  order.status = 'filled';
  order.filledAt = nowISO();
  order.fees = fees;
  order.avgFillPrice = +price.toFixed(4);
  order.filledQty = order.qty;
}

module.exports = { fillMarketOrder, tryFillLimitOrder, execFill, nowISO };
