// ─────────────────────────────────────────────────────────────
// 撮合引擎
//   · 市价单：按最新成交价立即成交；停牌/无行情 → 拒单并给出明确原因
//   · 限价单：立即尝试成交，未成交部分挂入 resting 撮合队列，
//     每次 runMatcher 轮询时用最新行情重试
//   · 涨跌停守卫（评审致命缺陷 #4）：A股封板价上不得成交——
//     市价买单触涨停价拒绝、卖单触跌停价拒绝；限价挂单轮询期间触板继续挂起。
//     依赖 quote.prevClose，缺失时跳过校验（与下单侧限价校验同口径 fail-open）
//   · 撮合频率：每 5 秒一次（PAPER_MATCH_INTERVAL_MS 可调）
// ─────────────────────────────────────────────────────────────
const { calcFees, marketOf } = require('./fees.cjs');

function nowISO() {
  return new Date().toISOString();
}

/** A股涨跌停幅度：主板 10% / 创业板 20% / 北交所 30%；ST 5%（按名称识别） */
function priceLimitPct(symbol, name) {
  const s = String(symbol).toLowerCase();
  const bare = s.replace(/^(sh|sz|bj)/, '');
  if (bare.startsWith('30') || bare.startsWith('68')) return 20;
  if (bare.startsWith('92') || bare.startsWith('83') || bare.startsWith('87') || bare.startsWith('43')) return 30;
  if ((name || '').toUpperCase().includes('ST')) return 5;
  return 10;
}

/** 涨跌停价（四舍五入到分）；prevClose 无效返回 null（跳过校验） */
function limitPrices(symbol, name, prevClose) {
  const pc = Number(prevClose);
  if (!Number.isFinite(pc) || pc <= 0) return null;
  const pct = priceLimitPct(symbol, name);
  return {
    upper: +(pc * (1 + pct / 100)).toFixed(2),
    lower: +(pc * (1 - pct / 100)).toFixed(2),
    pct,
  };
}

/** 市价单按最新价立即撮合（触板拒单） */
function fillMarketOrder(order, quote) {
  const price = Number(quote.price);
  if (!Number.isFinite(price) || price <= 0) {
    order.status = 'rejected';
    order.reason = '无有效行情（可能停牌或代码错误），市价单拒绝';
    return;
  }
  if (marketOf(order.symbol) === 'CN') {
    const lp = limitPrices(order.symbol, order.name, quote.prevClose);
    if (lp) {
      if (order.side === 'buy' && price >= lp.upper) {
        order.status = 'rejected';
        order.reason = `当前价 ${price} 已达涨停价 ${lp.upper}，涨停无法买入（市价单拒绝）`;
        return;
      }
      if (order.side === 'sell' && price <= lp.lower) {
        order.status = 'rejected';
        order.reason = `当前价 ${price} 已达跌停价 ${lp.lower}，跌停无法卖出（市价单拒绝）`;
        return;
      }
    }
  }
  execFill(order, price);
}

/**
 * 限价单按最新价判断能否成交。
 * 状态守卫（关键）：撮合循环会先快照 resting 订单、再 await 行情，期间用户可能已撤单。
 * 若此处不校验状态，就会出现「撤单后仍被成交」的账实不符。仅 pending/resting 才允许成交。
 * 涨跌停守卫：轮询期间价格触板时不得成交（涨停买不进/跌停卖不出），继续挂起等回落。
 */
function tryFillLimitOrder(order, quote) {
  if (order.status !== 'pending' && order.status !== 'resting') return;
  const price = Number(quote.price);
  if (!Number.isFinite(price) || price <= 0) return; // 无行情：继续挂着
  const fillable = order.side === 'buy' ? price <= order.limitPrice : price >= order.limitPrice;
  if (!fillable) return;
  if (marketOf(order.symbol) === 'CN') {
    const lp = limitPrices(order.symbol, order.name, quote.prevClose);
    if (lp && ((order.side === 'buy' && price >= lp.upper) || (order.side === 'sell' && price <= lp.lower))) return;
  }
  execFill(order, price);
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

module.exports = { fillMarketOrder, tryFillLimitOrder, execFill, nowISO, priceLimitPct, limitPrices };
