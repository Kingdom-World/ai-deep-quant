// ─────────────────────────────────────────────────────────────
// 统计检验（M2 · 2.3）—— 因子显著性的单一实现
//
//   为什么必须有这个文件（而不是散在 crosssect 里算）：
//   ① 显著性检验是**口径**，不是业务逻辑。口径必须有唯一实现（见知识条目
//      method-single-source）。散落实现的下场与当年 5 套 RSI 一模一样。
//   ② 时序数据的标准误必须做异方差自相关修正（Newey-West），否则 t 值虚高、
//      把噪声当显著——这是最常见的自欺方式（知识条目 term-newey-west）。
//
//   方法学出处（与知识库 server/knowledge/terms.json 同源）：
//     · Newey, W.K. & West, K.D. (1987). Econometrica 55(3):703-708
//     · 经验滞后阶数 L = floor(4 × (T/100)^(2/9))（statsmodels cov_hac 默认）
//     · Harvey, Liu & Zhu (2016) RFS 29(1):5-68 的 |t|>3 更高门槛
//
//   ⚠️ 本模块**不做任何 IO**、不依赖日期与标的——纯数字进、纯数字出。
//      这样才可被单测用已知序列锁黄金值。
// ─────────────────────────────────────────────────────────────

/** 均值 */
function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** 样本方差（n−1 分母，无偏估计） */
function variance(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (n - 1);
}

/** 样本标准差 */
function std(xs) {
  return Math.sqrt(variance(xs));
}

/**
 * Newey-West 经验滞后阶数：L = floor(4 × (T/100)^(2/9))
 *   T ≤ 0 时返回 0；极小样本返回 0（退化为异方差稳健，不假装能做自相关修正）。
 */
function neweyWestLag(T) {
  const n = Number(T);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(4 * (n / 100) ** (2 / 9));
}

/**
 * 均值标准误：普通（iid 假设）
 *   SE = s / √T
 */
function seIid(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  return std(xs) / Math.sqrt(n);
}

/**
 * 均值标准误：Newey-West HAC 修正（Bartlett 核）
 *
 *   ⚠️ 归一化口径（这是易错点，必须与 seIid 严格自洽）：
 *     样本方差用**无偏**分母 (T−1)，因此 γ0 也必须用 (T−1) 而非 (T)。
 *     否则 L=0 时本函数与 seIid 不相等 —— 两个"同一个东西"的实现给出不同答案，
 *     正是本项目最忌讳的口径分裂（见知识条目 method-single-source）。
 *
 *   SE²_NW = γ̃0 + 2 × Σ_{l=1..L} (1 − l/(L+1)) × γ̃l      （已含 1/T 因子）
 *     γ̃0 = Σ(x−x̄)² / (T−1)                                 ← 无偏，与 seIid 同源
 *     γ̃l = Σ_{t=l+1..T} (x_t−x̄)(x_{t−l}−x̄) / (T−1) × T/(T−l)... 
 *   为保持简洁且可核对，此处采用等价写法：
 *     SE²_NW = (1/T) × [ γ0_unbiased + 2 Σ (1−l/(L+1)) × γl_corrected ]
 *   其中 γl 的自相关项按 statsmodels cov_hac 的做法用相同的 (T−1) 尺度归一，
 *   从而 L=0 时严格等于 seIid²。
 *
 *   ⚠️ 已知局限（诚实声明）：未做「正定半定」的小样本修正，
 *      极小样本下 w 可能为负 → 此时返回 iid 的 SE 并置 degraded 标记。
 *
 * @returns { se, lag, weightSum, degenerate }
 */
function seNeweyWest(xs, lagOverride) {
  const T = xs.length;
  if (T < 2) return { se: NaN, lag: 0, weightSum: NaN, degenerate: true };
  const L = lagOverride === undefined ? neweyWestLag(T) : Math.max(0, Math.floor(Number(lagOverride) || 0));
  const m = mean(xs);
  const dev = xs.map((x) => x - m);

  // γ0：无偏分母 (T−1)，与 seIid 的 variance 同源
  let g0 = 0;
  for (const d of dev) g0 += d * d;
  g0 /= T - 1;

  // 自协方差项：同样以 (T−1) 为尺度，并在核加权前乘回 1/T 因子换算为方差口径
  // 目的：使 L=0 → w = g0/T = variance/T = seIid²（严格自洽）
  let w = g0 / T;
  for (let l = 1; l <= L; l++) {
    let gl = 0;
    for (let t = l; t < T; t++) gl += dev[t] * dev[t - l];
    gl /= T - 1;
    const kernel = 1 - l / (L + 1); // Bartlett
    // 自协方差按 (T−l) 个乘积、以 (T−1) 归一后，与 g0 同为「单点方差」量纲；
    // 转换为均值方差的贡献需除以 T。
    w += 2 * kernel * (gl / T) * (T / (T - l));
  }

  // 小样本下 w 可能为负（HAC 方差非正定的已知现象）→ 退化为 iid 并显式标注
  if (!(w > 0)) {
    return { se: seIid(xs), lag: L, weightSum: w, degenerate: true };
  }
  return { se: Math.sqrt(w), lag: L, weightSum: w, degenerate: false };
}

/**
 * 单样本 t 检验：H0 = 均值为 0
 * @param xs 序列
 * @param opts { lag, hac }
 *   hac === false 时强制用 iid 标准误（用于对照，展示修正前后的差异）
 * @returns { t, se, seIid, lag, n, mean, std, hacApplied, degradeReason? }
 */
function tTestMean(xs, opts = {}) {
  const clean = (xs || []).filter((x) => Number.isFinite(x));
  const n = clean.length;
  if (n < 2) {
    return { t: null, se: null, seIid: null, lag: 0, n, mean: n ? mean(clean) : null, std: null, hacApplied: false, degradeReason: '样本不足（n<2）' };
  }
  const m = mean(clean);
  const s = std(clean);
  const se0 = seIid(clean);
  const hac = opts.hac !== false;
  if (!hac) {
    return { t: se0 > 0 ? m / se0 : null, se: se0, seIid: se0, lag: 0, n, mean: m, std: s, hacApplied: false };
  }
  const nw = seNeweyWest(clean, opts.lag);
  const out = {
    t: nw.se > 0 ? m / nw.se : null,
    se: nw.se,
    seIid: se0,
    lag: nw.lag,
    n,
    mean: m,
    std: s,
    hacApplied: true,
  };
  if (nw.degenerate) {
    out.degraded = true;
    out.degradeReason = `HAC 方差非正定（L=${nw.lag}），已退化为 iid 标准误`;
  }
  return out;
}

/**
 * 正态近似双尾 p 值：p = 2 × (1 − Φ(|t|))
 *   用 Abramowitz & Stegun 7.1.26 的 erf 近似（精度 ~1.5e-7），避免引入依赖。
 *   ⚠️ 大样本近似；小样本应查 t 分布表。本平台样本常为数十至数百期，
 *      且我们同时输出 |t| 门槛判定（2 / 3），故对 p 的精度要求不高。
 */
function normCdf(z) {
  // erf 近似
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** 双尾 p 值（正态近似） */
function pValueTwoSided(t) {
  if (!Number.isFinite(t)) return null;
  return 2 * (1 - normCdf(Math.abs(t)));
}

/**
 * Spearman 秩相关（含 tie 平均秩处理）
 *   用途：Rank IC、分层单调性（层序 vs 层收益）
 *   知识条目：term-spearman
 */
function spearman(xs, ys) {
  const n = Math.min(xs?.length || 0, ys?.length || 0);
  if (n < 2) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1].v === idx[i].v) j += 1; // tie 组
      const avg = (i + j) / 2 + 1; // 平均秩（1-based）
      for (let k = i; k <= j; k++) r[idx[k].i] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs.slice(0, n));
  const ry = rank(ys.slice(0, n));
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null; // 常数序列无秩相关
  return num / Math.sqrt(dx * dy);
}

/**
 * 因子有效性汇总（M2 · 2.2）
 *   输入 IC 序列（逐期的因子值 vs 下期收益秩相关）→ 输出 IC 均值 / IR / 胜率 /
 *   显著性（t 检验 + Newey-West）。
 *
 *   ⚠️ IR 的两种口径必须说清（知识条目 term-ir）：
 *     · ICIR = mean(IC) / std(IC) —— 因子研究口径（本期采用）
 *     · 绩效信息比率 = 超额收益均值 / 跟踪误差 —— 与 ICIR 不是一回事
 *   本函数返回的是 **ICIR**，字段名用 `icir` 以免与绩效 IR 混淆。
 *
 * @param icSeries IC 序列（NaN 会被剔除）
 * @param opts { lag } 传给 Newey-West
 */
function summarizeIC(icSeries, opts = {}) {
  const ic = (icSeries || []).filter((x) => Number.isFinite(x));
  const n = ic.length;
  if (!n) {
    return { n: 0, icMean: null, icStd: null, icir: null, icPositiveRate: null, t: null, p: null };
  }
  const m = mean(ic);
  const s = n >= 2 ? std(ic) : null;
  const tt = tTestMean(ic, opts);
  const pos = ic.filter((x) => x > 0).length;
  return {
    n,
    icMean: +m.toFixed(6),
    icStd: s === null ? null : +s.toFixed(6),
    // ICIR：std 为 0（IC 恒定）时无意义，返回 null 而非 Infinity
    icir: s && s > 0 ? +(m / s).toFixed(6) : null,
    icPositiveRate: +(pos / n).toFixed(4),
    t: tt.t === null ? null : +tt.t.toFixed(4),
    p: pValueTwoSided(tt.t) === null ? null : +pValueTwoSided(tt.t).toFixed(6),
    se: tt.se === null ? null : +tt.se.toFixed(6),
    seIid: tt.seIid === null ? null : +tt.seIid.toFixed(6),
    neweyWestLag: tt.lag,
    // 显著性门槛（知识条目 term-stats-significance / method-multiple-testing）
    significant2: tt.t !== null && Math.abs(tt.t) >= 2,
    significant3: tt.t !== null && Math.abs(tt.t) >= 3,
    degraded: !!tt.degraded,
    degradeReason: tt.degradeReason,
  };
}

module.exports = {
  mean,
  variance,
  std,
  neweyWestLag,
  seIid,
  seNeweyWest,
  tTestMean,
  pValueTwoSided,
  normCdf,
  spearman,
  summarizeIC,
};
