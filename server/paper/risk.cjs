// ─────────────────────────────────────────────────────────────
// 风控检查（下单前置校验）
//   1. 单笔委托金额 ≤ 账户总资产 20%（PAPER_MAX_ORDER_PCT 可调）
//   2. 单标的持仓市值 ≤ 账户总资产 30%（PAPER_MAX_POSITION_PCT 可调）
//   3. 当日该标的买入笔数 ≤ 3（防高频误操作；PAPER_MAX_DAILY_BUYS 可调）
// ─────────────────────────────────────────────────────────────
function getTodayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/**
 * @returns {{ok: boolean, reason?: string}}
 */
function preTradeCheck({ order, account, positions, latestPrices }) {
  const maxOrderPct = Math.min(Math.max(Number(process.env.PAPER_MAX_ORDER_PCT) || 0.2, 0.01), 1);
  const maxPosPct = Math.min(Math.max(Number(process.env.PAPER_MAX_POSITION_PCT) || 0.3, 0.01), 1);
  const maxDailyBuys = Math.max(Number(process.env.PAPER_MAX_DAILY_BUYS) || 3, 1);

  // 总资产 = 现金 + 持仓按最新价估值
  let marketValue = 0;
  for (const p of positions) {
    const px = latestPrices[p.symbol];
    // 🔴 2026-10-25 修：原为 `latestPrices[p.symbol] || p.avgCost`。
    //    调用方（broker.valuationOf）已用 **null 明确表示「不可估值」**，这里若再兜回成本价，
    //    等于把刚刚拆掉的 fail-open 原样装回去 —— 资产×数量的分母重新变回虚高值，
    //    单笔 20% / 单标的 30% 两道限制再次失效。
    //    · 买入 ⇒ 拒绝（总资产不可信，比例判断无意义）
    //    · 卖出 ⇒ 跳过该项（卖出减少敞口，不依赖「现在值多少」判断安全性）
    if (px == null) {
      if (order.side === 'buy') {
        return { ok: false, reason: `持仓 ${p.symbol} 无可用行情，无法估算总资产，暂不接受新开仓` };
      }
      continue;
    }
    marketValue += p.qty * px;
  }
  const totalAssets = account.cash + marketValue;

  // 规则 3：当日买入次数
  if (order.side === 'buy') {
    const today = getTodayStr();
    const buysToday = positions.filter(
      (p) => p.symbol === order.symbol && p.todayBoughtDate === today,
    ).reduce((a, p) => a + (p.todayBuyCount || 0), 0);
    if (buysToday >= maxDailyBuys) {
      return { ok: false, reason: `当日该标的买入已达上限（${maxDailyBuys} 次/天）` };
    }
  }

  // 规则 1：单笔委托金额占比
  const estValue = order.qty * (order.type === 'limit' ? order.limitPrice : order.estimatePrice || 0);
  if (order.side === 'buy' && estValue > totalAssets * maxOrderPct) {
    return {
      ok: false,
      reason: `单笔委托金额 ${estValue.toFixed(0)} 超过总资产 ${Math.round(maxOrderPct * 100)}% 上限（当前总资产 ${totalAssets.toFixed(0)}）`,
    };
  }

  // 规则 2：调仓后单标的持仓占比
  const pos = positions.find((p) => p.symbol === order.symbol);
  const px = order.type === 'limit' ? order.limitPrice : order.estimatePrice || 0;
  const newQty = order.side === 'buy' ? (pos?.qty || 0) + order.qty : (pos?.qty || 0) - order.qty;
  const newPosValue = Math.max(newQty, 0) * px;
  if (newPosValue > totalAssets * maxPosPct && order.side === 'buy') {
    return {
      ok: false,
      reason: `该标的持仓将达 ${newPosValue.toFixed(0)}，超过单标的 ${Math.round(maxPosPct * 100)}% 上限（总资产 ${totalAssets.toFixed(0)}）`,
    };
  }

  return { ok: true };
}

module.exports = { preTradeCheck, getTodayStr };
