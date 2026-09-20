// ─────────────────────────────────────────────────────────────
// 纯量化计算引擎（无 I/O，可单元测试）
//   · smaSeries / rsiSeries 技术指标
//   · runBacktest 回测引擎
//     - 信号当日收盘产生，次日开盘价成交（消除同收盘价成交的前视偏差）
//     - 费用与模拟盘同源（paper/fees.cjs 分项费率表），不再用平坦双边 0.1%
//     - A 股按 100 股整手买入（此前允许碎股，高估资金利用率）
//     - 建仓失败（资金不足一手）不再静默空转，结果带 note 说明
// ─────────────────────────────────────────────────────────────
const { calcFees, marketOf } = require('./paper/fees.cjs');
const { wilderRsiSeries } = require('../shared/rsi.cjs');

/** SMA 序列（不足 N 为 null） */
function smaSeries(values, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    out.push(i + 1 >= n ? sum / n : null);
  }
  return out;
}

/**
 * RSI 序列 —— 口径统一为 **Wilder 标准**（实现见 shared/rsi.cjs，前后端共用同一份源码）
 *   历史：此处原为「窗口简单均值」实现；项目曾同时存在 4 套各自为政、且**均非行业标准**的 RSI。
 *   S6 起收敛为单一实现。⚠️ 口径切换会改变穿越 30/70 的信号时点（实测两口径相对差可达 13%），
 *   故回测结果会与切换前不同 —— 该差异属**口径修正**，非缺陷。
 */
const rsiSeries = wilderRsiSeries;

/**
 * 单策略回测引擎（全仓多头，收盘出信号、次日开盘成交）
 * @param market 'CN'|'HK'|'US'，默认 CN——决定费率表与是否整手约束
 * @param opts { slippage, limitPct }
 *   - slippage  单边滑点比例，默认 0.001（0.1% 起步模型，评审 P1-3）：买入 ×(1+s)、卖出 ×(1−s)
 *   - limitPct  涨跌停幅度（A 股由 matcher.priceLimitPct 按板块传入；港美股 null 不校验）。
 *               开盘触板不成交：涨停开不进买单、跌停开不出卖单，信号保留隔日重试（信号翻转则撤销）
 * @returns 结果对象；数据不足时返回 {error}
 */
function runBacktest(klines, strategy, fast, slow, capital, market = 'CN', opts = {}) {
  const mkt = ['CN', 'HK', 'US'].includes(market) ? market : 'CN';
  const slippage = Math.min(Math.max(Number(opts.slippage ?? 0.001), 0), 0.05);
  const limitPct = Number(opts.limitPct) > 0 ? Number(opts.limitPct) : null;
  const n = klines.length;
  if (n < 30) return { error: '历史数据不足 30 根，无法回测' };
  const closes = klines.map((k) => k.close);
  const opens = klines.map((k) => (Number.isFinite(k.open) && k.open > 0 ? k.open : k.close));
  const fastSMA = smaSeries(closes, fast);
  const slowSMA = smaSeries(closes, slow);
  const rsi = rsiSeries(closes, 14);

  // 1) 逐日收盘产生目标仓位
  const wantLong = new Array(n).fill(false);
  if (strategy === 'buyhold') {
    wantLong.fill(true);
  } else if (strategy === 'ma') {
    for (let i = 0; i < n; i++) {
      if (fastSMA[i] !== null && slowSMA[i] !== null) wantLong[i] = fastSMA[i] > slowSMA[i];
    }
  } else if (strategy === 'rsi') {
    let long = false;
    for (let i = 0; i < n; i++) {
      if (i > 0 && rsi[i] !== null && rsi[i - 1] !== null) {
        if (rsi[i - 1] <= 30 && rsi[i] > 30) long = true; // 超卖回升
        if (rsi[i - 1] >= 70 && rsi[i] < 70) long = false; // 超买回落
      }
      wantLong[i] = long;
    }
  }

  // 2) 逐日撮合：开盘执行昨日信号 → 收盘估值
  const equity = [];
  const trades = [];
  let cash = capital;
  let shares = 0;
  let position = false;
  let pending = null; // 'buy' | 'sell'（次日开盘执行）
  let entryPrice = 0;
  let entryDate = '';
  let entryIdx = 0;
  let peak = capital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let blockedBuy = false; // 出现过"想建仓但资金不足"
  let blockedLimitUp = 0; // 开盘涨停无法买入的次数
  let blockedLimitDown = 0; // 开盘跌停无法卖出的次数
  let totalFees = 0; // 累计费用（买入+卖出）——费率归因用
  let turnover = 0; // 累计成交额

  /** 可买股数：费用按分项费率表计入；CN 按 100 股整手向下取整，其余市场按 1 股 */
  const buySharesFor = (cashAvail, price) => {
    const step = mkt === 'CN' ? 100 : 1;
    let qty = Math.floor(cashAvail / (price * step)) * step;
    while (qty > 0 && cashAvail < qty * price + calcFees(mkt, 'buy', qty * price).total) qty -= step;
    return qty;
  };

  for (let i = 0; i < n; i++) {
    if (pending === 'buy' && !position) {
      const rawOpen = opens[i];
      // 开盘涨停（≥ 涨停价）：买单无法成交，信号保留至下一开盘（信号翻转则撤销）
      if (limitPct && i > 0 && rawOpen >= +(closes[i - 1] * (1 + limitPct / 100)).toFixed(2)) {
        blockedLimitUp += 1;
        if (!wantLong[i]) pending = null;
      } else {
        const price = +(rawOpen * (1 + slippage)).toFixed(4);
        const qty = buySharesFor(cash, price);
        if (qty > 0) {
          const value = qty * price;
          const fee = calcFees(mkt, 'buy', value).total;
          shares = qty;
          cash = +(cash - value - fee).toFixed(2);
          totalFees += fee;
          turnover += value;
          position = true;
          entryPrice = price;
          entryDate = klines[i].date;
          entryIdx = i;
          pending = null;
        } else {
          blockedBuy = true;
          pending = null;
        }
      }
    } else if (pending === 'sell' && position) {
      const rawOpen = opens[i];
      // 开盘跌停（≤ 跌停价）：卖单无法成交，信号保留至下一开盘（信号翻转则撤销）
      if (limitPct && i > 0 && rawOpen <= +(closes[i - 1] * (1 - limitPct / 100)).toFixed(2)) {
        blockedLimitDown += 1;
        if (wantLong[i]) pending = null;
      } else {
        const price = +(rawOpen * (1 - slippage)).toFixed(4);
        const fee = calcFees(mkt, 'sell', shares * price).total;
        cash = +(shares * price - fee).toFixed(2);
        totalFees += fee;
        turnover += shares * price;
        trades.push({
          entryDate,
          entryPrice: +entryPrice.toFixed(2),
          exitDate: klines[i].date,
          exitPrice: +price.toFixed(2),
          pnlPct: +(((price - entryPrice) / entryPrice) * 100).toFixed(2),
          holdDays: i - entryIdx,
        });
        shares = 0;
        position = false;
        pending = null;
      }
    } else {
      pending = null;
    }

    if (wantLong[i] && !position) pending = 'buy';
    if (!wantLong[i] && position) pending = 'sell';

    const value = cash + shares * closes[i];
    equity.push({ date: klines[i].date, value: +value.toFixed(2) });
    peak = Math.max(peak, value);
    const dd = (peak - value) / peak;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    maxDrawdown = Math.max(maxDrawdown, peak - value);
  }

  // 3) 期末强平（最后一日收盘价成交，标记 forced；注：同 bar 轻微前视，仅影响最后一日）
  //    强平后净值 = 残余现金 + 卖出净额（整手约束下买入不再全额满仓，现金项不可遗漏）
  let finalValue = equity[n - 1].value;
  if (position) {
    const exitValue = shares * closes[n - 1];
    finalValue = +(cash + exitValue - calcFees(mkt, 'sell', exitValue).total).toFixed(2);
    trades.push({
      entryDate,
      entryPrice: +entryPrice.toFixed(2),
      exitDate: klines[n - 1].date,
      exitPrice: +closes[n - 1].toFixed(2),
      pnlPct: +(((closes[n - 1] - entryPrice) / entryPrice) * 100).toFixed(2),
      holdDays: n - 1 - entryIdx,
      forced: true,
    });
    equity[n - 1] = { date: klines[n - 1].date, value: +finalValue.toFixed(2) };
  }

  const totalReturn = (finalValue / capital - 1) * 100;
  const years = Math.max(n / 252, 0.25);
  const annualized = (Math.pow(finalValue / capital, 1 / years) - 1) * 100;
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;

  // 风险调整指标（对标开源回测框架标准口径）
  const rets = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i].value / equity[i - 1].value - 1);
  const meanRet = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const std = rets.length ? Math.sqrt(rets.reduce((a, b) => a + (b - meanRet) ** 2, 0) / rets.length) : 0;
  const annualVol = std * Math.sqrt(252) * 100;
  const sharpe = annualVol > 0 ? +((annualized - 2) / annualVol).toFixed(2) : null; // 无风险利率按 2%
  const downside = rets.filter((r) => r < 0);
  const downDev = downside.length ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length) * Math.sqrt(252) * 100 : 0;
  const sortino = downDev > 0 ? +((annualized - 2) / downDev).toFixed(2) : null;
  const calmar = maxDrawdownPct > 0 ? +(annualized / maxDrawdownPct).toFixed(2) : null;
  const grossWin = trades.filter((t) => t.pnlPct > 0).reduce((a, t) => a + t.pnlPct, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnlPct <= 0).reduce((a, t) => a + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : trades.length ? null : null;
  const buyholdReturn = (closes[n - 1] / closes[0] - 1) * 100;
  const buyholdEquity = closes.map((c, i) => ({
    date: klines[i].date,
    value: +((capital / closes[0]) * c).toFixed(2),
  }));

  const result = {
    strategy,
    params: { fast, slow, capital, slippage, limitPct, market: mkt },
    range: { start: klines[0].date, end: klines[n - 1].date, bars: n },
    finalValue: +finalValue.toFixed(2),
    totalReturn: +totalReturn.toFixed(2),
    annualized: +annualized.toFixed(2),
    maxDrawdownPct: +(maxDrawdownPct * 100).toFixed(2),
    maxDrawdown: +maxDrawdown.toFixed(2),
    tradeCount: trades.length,
    winRate: +winRate.toFixed(1),
    blockedLimitUp,
    blockedLimitDown,
    totalFees: +totalFees.toFixed(2),
    turnover: +turnover.toFixed(2),
    feeRatePct: turnover > 0 ? +((totalFees / turnover) * 100).toFixed(3) : 0,
    annualVol: +annualVol.toFixed(2),
    sharpe,
    sortino,
    calmar,
    profitFactor,
    avgWinPct: trades.filter((t) => t.pnlPct > 0).reduce((a, t) => a + t.pnlPct, 0) /
      Math.max(1, wins),
    avgLossPct: trades.filter((t) => t.pnlPct <= 0).reduce((a, t) => a + t.pnlPct, 0) /
      Math.max(1, trades.length - wins),
    benchmarkReturn: +buyholdReturn.toFixed(2),
    trades: trades.slice(-50),
    equity,
    benchmark: buyholdEquity,
  };
  if (trades.length === 0) {
    result.note = blockedBuy
      ? `初始资金 ${capital} 不足以买入最小交易单位（股价 ${+closes[0].toFixed(2)}${mkt === 'CN' ? '，A 股一手 100 股' : ''}），未能建仓——请调高初始资金`
      : '回测期间未产生交易信号（策略条件从未触发）';
  }
  return result;
}

module.exports = { smaSeries, rsiSeries, runBacktest };
