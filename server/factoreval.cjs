// ─────────────────────────────────────────────────────────────
// 因子稳健性评估（S3 · 把「样本外验证」沉淀为平台能力）
//
//   动机（本项目实测）：单看全区间收益会骗人。
//     动量 mom20/60/120 全区间超额 -128 ~ -159pp；
//     反转 rev60 全区间超额 +253pp —— 但逐年一拆是 6 正 5 负、平均 **-9.07pp**。
//     即：全区间那个漂亮数字是**路径依赖**的产物（正超额年落在高净值段、负超额年落在低净值段，
//     复利把差异放大），换个起点/截止日结论就变。
//   本模块把「全区间 + 逐年」的对照固化下来，并给出**可判定**的稳健性结论。
//
//   判定规则（量化，非主观）：
//     正超额年份占比 ≥ 0.70 且 平均超额 > 0  →  稳健
//     正超额年份占比 ≥ 0.50 且 平均超额 > 0  →  边缘
//     其余                                   →  不稳定
//
//   ⚠️ 本模块的用途恰恰是**否定**不可靠的因子，而不是推荐因子；输出不构成投资建议。
// ─────────────────────────────────────────────────────────────
const crosssect = require('./crosssect.cjs');

const DEFAULT_FACTORS = ['mom20', 'mom60', 'rev20', 'rev60'];
const ALL_FACTORS = Object.keys(crosssect.FACTOR_WINDOWS);
const DEFAULT_TOP_N = 20;
const DEFAULT_REBALANCE = 20;
const YEAR_FROM = 2016; // 归档自 2015-02 起，且因子窗口需前置热身，故自 2016 年起评估

/** 逐年超额 → 稳定性判定 */
function stabilityOf(byYear) {
  const valid = byYear.filter((r) => Number.isFinite(r.excess));
  const total = valid.length;
  const pos = valid.filter((r) => r.excess > 0).length;
  const avg = total ? valid.reduce((a, r) => a + r.excess, 0) / total : 0;
  const variance = total ? valid.reduce((a, r) => a + (r.excess - avg) ** 2, 0) / total : 0;
  const posRatio = total ? pos / total : 0;

  let verdict = '不稳定';
  if (posRatio >= 0.7 && avg > 0) verdict = '稳健';
  else if (posRatio >= 0.5 && avg > 0) verdict = '边缘';

  return {
    posYears: pos,
    totalYears: total,
    posRatio: +posRatio.toFixed(2),
    avgExcess: +avg.toFixed(2),
    stdExcess: +Math.sqrt(variance).toFixed(2),
    verdict,
  };
}

/** 单因子：跑全区间 + 逐年 */
function evalFactor(factor, { topN, rebalanceEvery, capital, years }) {
  const base = { topN, rebalanceEvery, capital, factor };

  const fullRaw = crosssect.runCrossBacktest(base);
  const full = fullRaw.error
    ? { error: fullRaw.error }
    : {
        range: fullRaw.range,
        totalReturn: fullRaw.totalReturn,
        benchmarkReturn: fullRaw.benchmarkReturn,
        excess: +(fullRaw.totalReturn - fullRaw.benchmarkReturn).toFixed(2),
        maxDrawdownPct: fullRaw.maxDrawdownPct,
        sharpe: fullRaw.sharpe,
        rebalances: fullRaw.rebalances,
      };

  const byYear = years.map((y) => {
    const r = crosssect.runCrossBacktest({ ...base, startDate: `${y}-01-01`, endDate: `${y}-12-31` });
    if (r.error) return { year: y, error: r.error };
    return {
      year: y,
      strategy: r.totalReturn,
      benchmark: r.benchmarkReturn,
      excess: +(r.totalReturn - r.benchmarkReturn).toFixed(2),
      rebalances: r.rebalances,
    };
  });

  return { factor, full, byYear, stability: stabilityOf(byYear) };
}

/**
 * 批量评估
 * @param opts { factors?, topN?, rebalanceEvery?, capital?, yearFrom? }
 */
function evaluate(opts = {}) {
  const listed = Array.isArray(opts.factors) && opts.factors.length ? opts.factors : DEFAULT_FACTORS;
  const factors = listed.filter((f) => ALL_FACTORS.includes(f));
  const invalidFactors = listed.filter((f) => !ALL_FACTORS.includes(f));

  const topN = Math.max(1, Math.min(Number(opts.topN) || DEFAULT_TOP_N, 20));
  const rebalanceEvery = Math.max(1, Math.min(Number(opts.rebalanceEvery) || DEFAULT_REBALANCE, 250));
  const capital = Math.max(Number(opts.capital) || 1_000_000, 10_000);

  const yearTo = new Date().getFullYear();
  const yearFrom = Math.max(YEAR_FROM, Number(opts.yearFrom) || YEAR_FROM);
  const years = [];
  for (let y = yearFrom; y <= yearTo; y += 1) years.push(y);

  return {
    ok: true,
    params: { topN, rebalanceEvery, capital, yearFrom, yearTo },
    years,
    availableFactors: ALL_FACTORS,
    invalidFactors,
    factors: factors.map((f) => evalFactor(f, { topN, rebalanceEvery, capital, years })),
    disclaimer:
      '本评估用于判定因子是否稳健，不构成投资建议。判定规则：正超额年占比≥70% 且平均超额>0 为「稳健」，' +
      '≥50% 为「边缘」，其余为「不稳定」。⚠️ 全区间超额可能由路径依赖放大，务必以逐年分布为准。',
  };
}

module.exports = { evaluate, stabilityOf, DEFAULT_FACTORS, ALL_FACTORS, YEAR_FROM };
