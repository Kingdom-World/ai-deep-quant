// ─────────────────────────────────────────────────────────────
// RSI 单一实现（Wilder 标准）—— 前后端共用同一份源码
//
//   为什么放在 shared/：
//     此前项目里有 **4 套各写各的 RSI**（agents.cjs:rsiLast / quant.cjs:rsiSeries /
//     src/lib/stock.ts:calcRSI / StockDetailPage.tsx:rsiSeriesCalc），
//     而且四套**都是简单均值**，没有一套是行业标准口径 —— 等于「四份不同的错」。
//     本文件成为唯一实现，其余四处全部改为引用它。
//
//   为什么用 .mjs：
//     前端（Vite/ESM）可直接 import；后端（CommonJS）在 Node ≥20.19 / ≥22.12 可用
//     require() 直接加载无顶层 await 的 ESM（实测 Node v22.22.2 通过）。
//     因此**不需要写两份、也不需要构建期代码生成**（后者会制造第二真相源）。
//
//   口径说明（Wilder 平滑，通达信 / 同花顺 / TradingView 采用）：
//     首次 n 期用简单平均初始化，之后 avg = (prevAvg × (n−1) + cur) / n
//     ⚠️ 实测与「简单均值」口径相对差可达 13%（同一序列 Wilder 29.57 vs 简单均值 26.15），
//        足以改变穿越 30/70 的信号时点，故口径切换会**实质改变回测结果**。
// ─────────────────────────────────────────────────────────────

/**
 * Wilder RSI 序列
 * @param closes 收盘价序列（升序）
 * @param n 周期，默认 14
 * @returns 与 closes 等长的数组；前 n 位为 null
 */
export function wilderRsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (!Array.isArray(closes) || closes.length < n + 1 || n < 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= n; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / n;
  let avgLoss = lossSum / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = n + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * 最新一根的 Wilder RSI 值
 * @returns 数值；数据不足返回 null
 */
export function wilderRsiLast(closes, n = 14) {
  const series = wilderRsiSeries(closes, n);
  const v = series.length ? series[series.length - 1] : null;
  return v === undefined ? null : v;
}
