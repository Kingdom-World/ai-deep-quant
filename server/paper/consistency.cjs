// ─────────────────────────────────────────────────────────────
// 回测 vs 模拟盘一致性报告 + 策略衰减监控 + 成本归因（评审 P2-4）
//   · 归因基础：订单按 src 标记来源策略，卖出单盖 pricePnl/realized/buyFeeShare 戳（P2-1）
//   · 一致性三指标：收益差(pp) / 笔数差 / 费率差(pp)——回测与模拟盘口径必须同源
//     （fees.cjs 费率、滑点 0.1%、涨跌停约束——Phase 1/2 已统一）
//   · 衰减监控：近 30 日 vs 此前 90 日（亏损反转 / 胜率大幅下滑）
//   · 成本归因：净盈亏 = 价差毛盈亏 − 成本（卖出费 + 买入费分摊）
//   · grid 策略无对应回测口径，只出模拟盘统计
// ─────────────────────────────────────────────────────────────
const broker = require('./broker.cjs');
const { runBacktest } = require('../quant.cjs');
const { marketOf } = require('./fees.cjs');
const { priceLimitPct } = require('./matcher.cjs');

/** 收集某策略在 [sinceTs, untilTs) 内的已成交订单（跨 uid，按 src 归因） */
function collectTrades(state, strategyId, sinceTs, untilTs) {
  const buys = [];
  const sells = [];
  for (const uid of Object.keys(state.orders || {})) {
    for (const o of state.orders[uid] || []) {
      if (o.src !== strategyId || o.status !== 'filled') continue;
      const t = new Date(o.createdAt).getTime();
      if (sinceTs && t < sinceTs) continue;
      if (untilTs && t >= untilTs) continue;
      (o.side === 'buy' ? buys : sells).push(o);
    }
  }
  return { buys, sells };
}

/** 模拟盘统计：笔数 / 费用 / 周转 / 净已实现 / 价差毛盈亏 / 胜率 */
function paperStats({ buys, sells }) {
  const all = [...buys, ...sells];
  const feeSum = all.reduce((s, o) => s + (o.fees?.total || 0), 0);
  const sellFeeSum = sells.reduce((s, o) => s + (o.fees?.total || 0), 0);
  const turnover = all.reduce((s, o) => s + o.qty * (o.avgFillPrice || 0), 0);
  const realized = sells.reduce((s, o) => s + (o.realized || 0), 0);
  const pricePnl = sells.reduce((s, o) => s + (o.pricePnl || 0), 0);
  const buyFeeShare = sells.reduce((s, o) => s + (o.buyFeeShare || 0), 0);
  return {
    closedTrades: sells.length,
    openBuys: buys.length,
    realized: +realized.toFixed(2),
    pricePnl: +pricePnl.toFixed(2),
    // 成本口径与 realized 恒等式严格一致：net = pricePnl − (卖出费 + 买入费分摊)。
    // 买入单自身费用已通过 buyFeeShare 分摊计入，不能再算一次（否则双重扣费）。
    costs: +(sellFeeSum + buyFeeShare).toFixed(2),
    feeSum: +feeSum.toFixed(2),
    turnover: +turnover.toFixed(2),
    feeRatePct: turnover > 0 ? +((feeSum / turnover) * 100).toFixed(3) : 0,
    winRate: sells.length ? +((sells.filter((o) => (o.realized || 0) > 0).length / sells.length) * 100).toFixed(1) : null,
  };
}

/** 策略衰减判定：近窗 vs 前窗（亏损反转 / 胜率大幅下滑） */
function decayCheck(stats30, statsPrior) {
  if (!stats30.closedTrades) return null;
  if (stats30.closedTrades >= 3 && stats30.realized < 0 && statsPrior.realized > 0) {
    return `近${stats30.closedTrades}笔共亏 ${stats30.realized}，而此前盈利 ${statsPrior.realized}——策略可能衰减`;
  }
  if (
    stats30.winRate !== null && statsPrior.winRate !== null &&
    statsPrior.closedTrades >= 3 && stats30.winRate < statsPrior.winRate - 30
  ) {
    return `胜率 ${stats30.winRate}% 较此前 ${statsPrior.winRate}% 下滑超 30pp`;
  }
  return null;
}

/** 为单个策略跑同参数回测（同窗口、同费率/滑点/涨跌停口径） */
async function backtestForStrategy(st, windowDays, deps) {
  const map = { maCross: 'ma', rsiReversal: 'rsi' };
  const btStrategy = map[st.type];
  if (!btStrategy) return { skipped: 'grid 策略无对应回测口径' };
  const code = deps.toTencentCode(st.symbol);
  const since = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const rows = await deps.fetchDailyRows(code, windowDays + 80);
  const win = rows.filter((r) => r.date >= since);
  if (win.length < 30) return { skipped: `窗口内 K 线不足（${win.length} 根）` };
  const acc = broker.store.state.accounts[st.uid];
  const capital = acc?.initialCapital || 1_000_000;
  const market = marketOf(code);
  const limitPct = market === 'CN' ? priceLimitPct(code, null) : null;
  const bt = runBacktest(win, btStrategy, Number(st.params?.fast) || 5, Number(st.params?.slow) || 20, capital, market, {
    slippage: 0.001,
    limitPct,
  });
  return {
    strategy: btStrategy,
    totalReturn: bt.totalReturn,
    tradeCount: bt.tradeCount,
    feeRatePct: bt.feeRatePct,
    totalFees: bt.totalFees,
    range: bt.range,
  };
}

/**
 * 构建一致性报告
 * @param opts { strategies, windowDays=30, fetchDailyRows, toTencentCode }
 */
async function buildReport(opts = {}) {
  const {
    strategies = [],
    windowDays = 30,
    fetchDailyRows,
    toTencentCode = (s) => s,
  } = opts;
  const state = broker.store.state;
  const now = Date.now();
  const out = [];
  for (const st of strategies) {
    const stats30 = paperStats(collectTrades(state, st.id, now - windowDays * 86400000, now));
    const statsPrior = paperStats(
      collectTrades(state, st.id, now - (windowDays + 90) * 86400000, now - windowDays * 86400000),
    );
    const acc = state.accounts[st.uid];
    const capital = acc?.initialCapital || 0;
    const paperReturnPct = capital > 0 && stats30.closedTrades >= 0
      ? +((stats30.realized / capital) * 100).toFixed(2)
      : null;

    let bt = null;
    let btError = null;
    try {
      bt = await backtestForStrategy(st, windowDays, { fetchDailyRows, toTencentCode });
    } catch (e) {
      btError = e.message?.slice(0, 80);
    }

    const deltas = bt && bt.totalReturn !== undefined && paperReturnPct !== null
      ? {
          returnDiffPct: +(paperReturnPct - bt.totalReturn).toFixed(2),
          tradeCountDiff: stats30.closedTrades - bt.tradeCount,
          feeRateDiffPct: +(stats30.feeRatePct - (bt.feeRatePct || 0)).toFixed(3),
        }
      : null;

    out.push({
      strategyId: st.id,
      uid: st.uid,
      type: st.type,
      symbol: st.symbol,
      status: st.status,
      paper: stats30,
      paperReturnPct,
      backtest: bt || { skipped: btError || 'unknown' },
      deltas,
      decay: decayCheck(stats30, statsPrior),
      costAttribution: {
        grossPricePnl: stats30.pricePnl,
        costs: stats30.costs,
        netRealized: stats30.realized,
        note: '净已实现 = 价差毛盈亏 − (卖出费 + 买入费分摊)',
      },
      prior90: statsPrior,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    strategyCount: out.length,
    decayCount: out.filter((s) => s.decay).length,
    strategies: out,
  };
}

module.exports = { buildReport, paperStats, collectTrades, decayCheck };
