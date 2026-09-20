// ─────────────────────────────────────────────────────────────
// RSI 单一实现（Wilder 标准）—— 前后端共用同一份源码
//
//   为什么放 shared/：
//     此前项目里有 **4 套各写各的 RSI**（agents.cjs:rsiLast / quant.cjs:rsiSeries /
//     src/lib/stock.ts:calcRSI / StockDetailPage.tsx:rsiSeriesCalc），
//     而且四套**都是简单均值**，没有一套是行业标准口径 —— 等于「四份不同的错」。
//     本文件成为唯一实现，其余四处全部改为引用它。
//
//   🔴 2026-09-20 为什么从 .mjs 改为 .cjs（本次线上故障的经验）：
//     原实现放在 `rsi.mjs`，后端用 `require('../../shared/rsi.mjs')` 加载。
//     这依赖 Node 的 `require(ESM)` 特性 —— **仅在 Node 20.19+ / 22.12+ 可用**。
//     线上 Vercel 拿到的是较早的 Node 20.x，直接抛：
//         [ERR_REQUIRE_ESM] require() of ES Module shared/rsi.mjs not supported
//     导致**整个 Serverless 函数崩溃**（全站 500、登录不可用）。
//     钉 `engines.node` 只能"祈祷平台给对版本"，不是可靠解法。
//
//     ⇒ 改为 **实现放在 .cjs**：
//         · 后端 `require('./rsi.cjs')` —— **任何 Node 版本都能加载**（CommonJS 原生）
//         · 前端 `import './rsi.mjs'` —— .mjs 只做一行转发（ESM 可安全 import CJS）
//       两个方向都是各自模块系统最稳定的用法，**彻底摆脱版本依赖**。
//
//     ⚠️ 仍然只有**一份实现**（本文件）。`rsi.mjs` 是转发壳、无任何逻辑，
//        不构成第二真相源 —— 满足「全仓不得存在第二份 RSI 实现」的约束。
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
function wilderRsiSeries(closes, n = 14) {
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
function wilderRsiLast(closes, n = 14) {
  const series = wilderRsiSeries(closes, n);
  const v = series.length ? series[series.length - 1] : null;
  return v === undefined ? null : v;
}

module.exports = { wilderRsiSeries, wilderRsiLast };
