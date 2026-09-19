// ─────────────────────────────────────────────────────────────
// 参数扫描与稳健性判定（S7）
//
//   回答一个具体问题：**这个参数是不是「挑」出来的？**
//   单次回测给的是"某参数在某区间赚了多少"，但参数往往是**搜出来**的 ——
//   搜得越多，越容易撞到运气好的组合（多重比较 / 选美偏差）。
//
//   本模块提供三层防护（对应方案 S7 的「必做」档）：
//     ① 孤峰判据   最优参数的**邻域**是否也好？孤峰 = 过拟合嫌疑
//     ② 样本外验证 用前段选参数、后段验证；样本外崩塌即过拟合
//     ③ 成本敏感度 同一参数在 0 / 0.1% / 0.3% 滑点下是否仍成立
//
//   另按方案 I4「降级档」给出**多重比较的直观提示**（不做正式 deflated Sharpe 校正），
//   并如实标注其局限。
//
//   ⚠️ 输出不构成投资建议。本模块的用途是**否定**不可信的参数，而非推荐参数。
// ─────────────────────────────────────────────────────────────
const { runBacktest } = require('./quant.cjs');

const DEFAULT_FAST = [3, 30, 1]; // [起, 止, 步长]
const DEFAULT_SLOW = [5, 120, 5];
const MAX_TRIALS = 4000; // 硬上限：防止误传参数把服务打满
const NEIGHBOR_TOL = 1; // 孤峰判据的邻域范围（网格上的切比雪夫距离）
const PEAK_RATIO = 0.5; // 邻域中位数 / 最优 < 该值 → 判为孤峰

/** 生成等差序列（含端点） */
function range([from, to, step]) {
  const out = [];
  const s = Math.max(1, Math.floor(step));
  for (let v = from; v <= to; v += s) out.push(v);
  return out;
}

/** 跑一个网格，返回全部结果（按总收益降序） */
function runGrid(klines, combos, { capital, market, slippage, limitPct }) {
  const rows = [];
  for (const [fast, slow] of combos) {
    const r = runBacktest(klines, 'ma', fast, slow, capital, market, { slippage, limitPct });
    if (r.error) continue;
    rows.push({
      fast,
      slow,
      totalReturn: r.totalReturn,
      maxDrawdownPct: r.maxDrawdownPct,
      sharpe: r.sharpe,
      tradeCount: r.tradeCount,
      winRate: r.winRate,
    });
  }
  rows.sort((a, b) => b.totalReturn - a.totalReturn);
  return rows;
}

/**
 * 孤峰判据：最优参数的邻域表现如何？
 *   邻域 = 「相邻格点」——容差按**网格步长**取（而不是写死 1），
 *          否则当某方向步长 > 1 时邻域会退化成一两个点，判据失去意义。
 *   判据 = 邻域中位数 / 最优 < PEAK_RATIO → 孤峰
 */
function peakAnalysis(rows, best, tol = { fast: NEIGHBOR_TOL, slow: NEIGHBOR_TOL }) {
  const near = rows.filter(
    (r) =>
      Math.abs(r.fast - best.fast) <= tol.fast &&
      Math.abs(r.slow - best.slow) <= tol.slow &&
      !(r.fast === best.fast && r.slow === best.slow),
  );
  if (near.length < 2) {
    return {
      neighborCount: near.length,
      tol,
      verdict: '无法判定',
      reason: `可用邻域点仅 ${near.length} 个（不足 2 个）——最优参数靠近网格边缘，建议扩大网格后重测`,
    };
  }
  const vals = near.map((r) => r.totalReturn).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const min = vals[0];
  const max = vals[vals.length - 1];

  // ⚠️ 关键前置：若最优组合本身不盈利，则「参数稳健性」无从谈起 ——
  //    早期版本在最优为负时把 ratio 兜底为 1，会把**亏损参数误判为「平原（稳健）」**，
  //    属最危险的误导，故单独设「无效」档并短路返回。
  if (best.totalReturn <= 0) {
    return {
      neighborCount: near.length,
      tol,
      neighborMedian: +median.toFixed(2),
      neighborMin: +min.toFixed(2),
      neighborMax: +max.toFixed(2),
      ratio: null,
      threshold: PEAK_RATIO,
      verdict: '无效',
      reason: `最优组合本身即为亏损（${best.totalReturn.toFixed(2)}%）—— 该策略在此区间不具备可用性，无需讨论孤峰`,
    };
  }

  const ratio = median / best.totalReturn;

  let verdict = '平原';
  let reason = `邻域 ${near.length} 点中位数 ${median.toFixed(2)}%，达最优的 ${(ratio * 100).toFixed(0)}%，参数附近表现一致`;
  if (ratio < PEAK_RATIO) {
    verdict = '孤峰';
    reason = `邻域中位数仅 ${median.toFixed(2)}%，不足最优的 ${(PEAK_RATIO * 100).toFixed(0)}% —— 略移参数即大幅劣化，过拟合嫌疑高`;
  }
  if (min < 0) {
    verdict = '孤峰';
    reason += `；且邻域内出现亏损组合（最低 ${min.toFixed(2)}%），稳定性不足`;
  }
  return {
    neighborCount: near.length,
    tol,
    neighborMedian: +median.toFixed(2),
    neighborMin: +min.toFixed(2),
    neighborMax: +max.toFixed(2),
    ratio: +ratio.toFixed(3),
    threshold: PEAK_RATIO,
    verdict,
    reason,
  };
}

/**
 * 参数扫描
 * @param opts { klines, fastRange, slowRange, capital, market, slippage, limitPct, splitRatio }
 */
function scan(opts = {}) {
  const klines = Array.isArray(opts.klines) ? opts.klines : [];
  if (klines.length < 80) {
    return { ok: false, error: `K 线不足（${klines.length} 根，至少需 80 根）` };
  }

  const capital = Math.max(Number(opts.capital) || 100_000, 1000);
  const market = ['CN', 'HK', 'US'].includes(opts.market) ? opts.market : 'CN';
  const slippage = Math.min(Math.max(Number(opts.slippage ?? 0.001), 0), 0.05);
  const limitPct = Number(opts.limitPct) > 0 ? Number(opts.limitPct) : null;
  const splitRatio = Math.min(Math.max(Number(opts.splitRatio ?? 0.7), 0.5), 0.9);

  const fasts = range(opts.fastRange || DEFAULT_FAST);
  const slows = range(opts.slowRange || DEFAULT_SLOW);
  const combos = [];
  for (const f of fasts) for (const s of slows) if (f < s) combos.push([f, s]);

  if (!combos.length) return { ok: false, error: '参数网格为空（需满足 fast < slow）' };
  if (combos.length > MAX_TRIALS) {
    return { ok: false, error: `网格过大（${combos.length} 组，上限 ${MAX_TRIALS}）——请缩小范围或加大步长` };
  }

  const base = { capital, market, slippage, limitPct };
  const rows = runGrid(klines, combos, base);
  if (!rows.length) return { ok: false, error: '全部参数组合回测失败' };
  const best = rows[0];

  // ① 孤峰判据（邻域容差按各自方向的网格步长取）
  const fastStep = (opts.fastRange || DEFAULT_FAST)[2] || 1;
  const slowStep = (opts.slowRange || DEFAULT_SLOW)[2] || 1;
  const peak = peakAnalysis(rows, best, { fast: fastStep, slow: slowStep });

  // ② 样本外验证：前段选参、后段验证（引擎的「收盘信号 / 次日开盘成交」已无前视）
  const splitIdx = Math.floor(klines.length * splitRatio);
  const inK = klines.slice(0, splitIdx);
  const outK = klines.slice(splitIdx);
  const inRows = runGrid(inK, combos, base);
  const inBest = inRows[0] || null;
  let outOfSample = { available: false, reason: '样本内网格无有效结果' };
  if (inBest) {
    const outRun = runBacktest(outK, 'ma', inBest.fast, inBest.slow, capital, market, { slippage, limitPct });
    const fullRun = runBacktest(klines, 'ma', inBest.fast, inBest.slow, capital, market, { slippage, limitPct });
    outOfSample = {
      available: !outRun.error,
      splitRatio,
      splitDate: klines[splitIdx]?.date ?? null,
      inSampleBest: { fast: inBest.fast, slow: inBest.slow, totalReturn: inBest.totalReturn },
      inSampleBars: inK.length,
      outSample: { bars: outK.length, totalReturn: outRun.totalReturn ?? null, maxDrawdownPct: outRun.maxDrawdownPct ?? null },
      fullSampleWithSameParams: fullRun.error ? null : fullRun.totalReturn,
      // 符号含义：**正 = 样本外优于样本内；负 = 样本外劣化**（后者是过拟合的典型信号）
      outMinusIn: outRun.error ? null : +(outRun.totalReturn - inBest.totalReturn).toFixed(2),
    };
  }

  // ③ 成本敏感度：同一最优参数在三档滑点下
  const costSensitivity = [0, 0.001, 0.003].map((s) => {
    const r = runBacktest(klines, 'ma', best.fast, best.slow, capital, market, { slippage: s, limitPct });
    return {
      slippage: s,
      totalReturn: r.error ? null : r.totalReturn,
      tradeCount: r.error ? null : r.tradeCount,
    };
  });

  // 多重比较的「直观提示」（非正式校正，见 caveat）
  const trials = combos.length;
  const randomBestSharpeApprox = +Math.sqrt(2 * Math.log(trials)).toFixed(2);

  return {
    ok: true,
    params: {
      strategy: 'ma',
      capital,
      market,
      slippage,
      limitPct,
      bars: klines.length,
      range: { start: klines[0].date, end: klines[klines.length - 1].date },
      fastRange: opts.fastRange || DEFAULT_FAST,
      slowRange: opts.slowRange || DEFAULT_SLOW,
      trials,
    },
    best,
    top10: rows.slice(0, 10),
    peak,
    outOfSample,
    costSensitivity,
    multipleTesting: {
      trials,
      randomBestSharpeApprox,
      caveat:
        '该值为「N 次相互独立、且无预测能力的试验」下最优 Sharpe 的近似期望（极值分布 √(2·lnN)）。' +
        '但本网格相邻参数高度相关，实际噪声线应低于此值 —— 故此提示**偏保守**，仅供直观参考，**不是正式的多重比较校正**。',
    },
    caveats: [
      '当前仅支持双均线（fast/slow）；RSI 的 30/70 阈值硬编码在引擎内，暂不可扫。',
      '样本外为**单次切分**，未做 walk-forward 多折（方案 I4 的延后项）。',
      '未做正式的 deflated Sharpe 等校正，仅给出上述直观提示。',
      '网格为等差网格，结论受网格分辨率影响（更细的网格可能找到更高的孤峰）。',
    ],
    disclaimer:
      '本结果用于判断参数是否稳健，不构成投资建议。孤峰或样本外崩塌均提示过拟合，' +
      '不应据此类参数推断策略有效。',
  };
}

module.exports = { scan, peakAnalysis, runGrid, range, MAX_TRIALS, PEAK_RATIO };
