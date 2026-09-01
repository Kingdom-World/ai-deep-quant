// ─────────────────────────────────────────────────────────────
// 纯量化计算引擎（无 I/O，可单元测试）
//   · smaSeries / rsiSeries 技术指标
//   · runBacktest 回测引擎
//     - 信号当日收盘产生，次日开盘价成交（消除同收盘价成交的前视偏差）
//     - 建仓失败（资金 < 股价）不再静默空转，结果带 note 说明
// ─────────────────────────────────────────────────────────────
const FEE = 0.001; // 双边手续费 0.1%（与前端展示口径一致）

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

/** RSI 序列（窗口简单均值简化版，与前端 calcRSI 口径一致） */
function rsiSeries(values, n = 14) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < n) {
      out.push(null);
      continue;
    }
    let gains = 0;
    let losses = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const diff = values[j] - values[j - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / n;
    const avgLoss = losses / n;
    if (avgLoss === 0) out.push(100);
    else out.push(100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

/**
 * 单策略回测引擎（全仓多头，收盘出信号、次日开盘成交）
 * @returns 结果对象；数据不足时返回 {error}
 */
function runBacktest(klines, strategy, fast, slow, capital) {
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

  for (let i = 0; i < n; i++) {
    if (pending === 'buy' && !position) {
      const price = opens[i];
      if (cash >= price * (1 + FEE)) {
        shares = (cash * (1 - FEE)) / price;
        cash = 0;
        position = true;
        entryPrice = price;
        entryDate = klines[i].date;
        entryIdx = i;
      } else {
        blockedBuy = true;
      }
    } else if (pending === 'sell' && position) {
      const price = opens[i];
      cash = shares * price * (1 - FEE);
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
    }
    pending = null;

    if (wantLong[i] && !position) pending = 'buy';
    if (!wantLong[i] && position) pending = 'sell';

    const value = cash + shares * closes[i];
    equity.push({ date: klines[i].date, value: +value.toFixed(2) });
    peak = Math.max(peak, value);
    const dd = (peak - value) / peak;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    maxDrawdown = Math.max(maxDrawdown, peak - value);
  }

  // 3) 期末强平（最后一日收盘价成交，标记 forced）
  let finalValue = equity[n - 1].value;
  if (position) {
    finalValue = shares * closes[n - 1] * (1 - FEE);
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
    params: { fast, slow, capital },
    range: { start: klines[0].date, end: klines[n - 1].date, bars: n },
    finalValue: +finalValue.toFixed(2),
    totalReturn: +totalReturn.toFixed(2),
    annualized: +annualized.toFixed(2),
    maxDrawdownPct: +(maxDrawdownPct * 100).toFixed(2),
    maxDrawdown: +maxDrawdown.toFixed(2),
    tradeCount: trades.length,
    winRate: +winRate.toFixed(1),
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
      ? `初始资金 ${capital} 低于股价，未能建仓——本次回测未产生任何交易，请调高初始资金`
      : '回测期间未产生交易信号（策略条件从未触发）';
  }
  return result;
}

module.exports = { smaSeries, rsiSeries, runBacktest, FEE };
