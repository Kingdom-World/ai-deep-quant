'use strict';
// ─────────────────────────────────────────────────────────────
// 独立验证套件（Phase 2 · master-plan §5.3）
//
//   🔴 独立性原则（这是本模块的定义，不是建议）：
//      验证套件**只读**模型与回测产物，**不参与**模型/因子的生成与调参。
//      一旦验证逻辑能反过来影响模型，它就不再是验证，而是自证。
//      故本模块只做两件事：① 用现成引擎多次跑同一个模型；② 对结果做统计判定。
//
//   提供四项检查：
//     · bhFdr            多重检验 BH-FDR 校正（纯函数；用于"扫一批因子"的场景）
//     · walkForward      样本外滚动（时间切折，逐折独立跑）—— 防事后诸葛
//     · plateauScan      参数平原扫描（参数 ±30% 网格）—— 防尖峰过拟合
//     · runValidation    汇总报告（含**样本量与功效说明**与已知局限）
//
//   ⚠️ 因果性/扰动测试（未来数据泄露）不在本文件：它需要**变异数据**（截断或置换
//      未来行后重跑），与本文件的"只读、零数据变异"边界不同，单独实现以保持边界清晰。
//
//   强制披露纪律（§5.3 末段）：任何验证结论都必须自带样本量与功效说明；
//   阈值全部作为具名常量写明并随结果返回，避免"魔法数字"式的不可复核判定。
// ─────────────────────────────────────────────────────────────
const { runModel, ENGINE_VERSION } = require('./modelrun.cjs');

// ── 判定阈值（全部显式；随结果返回，便于复核与争议时追溯）──
const RULES = {
  /** 参数平原：±30% 边界点上，总收益相对基准的跌幅超过此比例 ⇒ 判为尖峰 */
  plateauMaxDropPct: 50,
  /** 参数平原：中心点跌幅超过此比例即视为已不稳健（更严） */
  plateauCenterHintPct: 30,
  /** 样本外：任一折收益与整体收益符号相反、且幅度超过此值（百分点）⇒ 判为不稳定 */
  walkForwardSignFlipPct: 5,
  /** 样本外：折间总收益的离散度（max−min）超过此值（百分点）⇒ 提示波动大 */
  walkForwardDispersionPct: 40,
  /** 样本量门槛：IC 期数少于此值时，显著性结论一律标注功效不足 */
  minIcPeriods: 12,
};

/** 已知局限（§5.3：必须在报告与 UI 显式标注，防止小样本假信心） */
const LIMITATIONS = [
  '核心股票池（非全市场）；退市股未入归档 ⇒ 存在幸存者偏差，历史表现偏乐观',
  '撮合成交价做了简化，成本仅含佣金/印花/过户；未建模冲击成本',
  '股票池构成随归档演进，跨期比较时池子本身可能变化',
  '验证结论只反映"在所测区间与参数邻域内"的行为，不构成对未来表现的保证',
];

// ─────────────────────────────────────────────────────────────
// 一、多重检验：BH-FDR 校正
// ─────────────────────────────────────────────────────────────
/**
 * Benjamini–Hochberg FDR 校正。
 *
 * 为什么需要：一次评估 N 个因子时，"至少有一个碰巧显著"的概率随 N 上升——
 * 直接看单个 p 值等于**试出来的显著**。BH 比 Bonferroni 温和（控制的是
 * 错误发现比例而非族错误率），在"筛选候选因子"场景更合适（§5.3 表格）。
 *
 * @param {number[]} pValues 各假设的 p 值（0~1）
 * @param {number} [q=0.05] 目标 FDR
 * @returns {{q:number,m:number,rejected:boolean[],adjusted:number[],rejectedMaxP:number|null,note:string}}
 */
function bhFdr(pValues, q = 0.05) {
  const ps = (Array.isArray(pValues) ? pValues : []).filter((p) => Number.isFinite(p));
  const m = ps.length;
  if (!m) {
    return { q, m: 0, rejected: [], adjusted: [], rejectedMaxP: null, note: '没有可检验的假设，未做校正' };
  }
  const idx = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  // BH 调整 p：p_adj(k) = min_{j≥k} (m/j)·p_(j)，从大到小累加 min 保证单调
  const adjusted = new Array(m);
  let running = 1;
  for (let k = m - 1; k >= 0; k--) {
    running = Math.min(running, (idx[k].p * m) / (k + 1));
    adjusted[idx[k].i] = +Math.min(1, running).toFixed(6);
  }
  // 最大的 k 使得 p_(k) ≤ (k/m)·q；它及其之前全部拒绝
  let kmax = -1;
  for (let k = 0; k < m; k++) if (idx[k].p <= ((k + 1) / m) * q) kmax = k;
  const rejected = new Array(m).fill(false);
  for (let k = 0; k <= kmax; k++) rejected[idx[k].i] = true;
  const nRej = kmax + 1;
  return {
    q,
    m,
    rejected,
    adjusted,
    rejectedMaxP: kmax >= 0 ? idx[kmax].p : null,
    note: `${m} 个假设，q=${q}：拒绝 ${nRej} 个（未校正时同名 p<${q} 的假设数为 ${ps.filter((p) => p < q).length} 个——差额即多重检验带来的假阳性）`,
  };
}

// ─────────────────────────────────────────────────────────────
// 二、样本外：Walk-forward 滚动
// ─────────────────────────────────────────────────────────────
/**
 * 把回测区间切成若干折，**逐折独立重跑**（不共享任何状态）。
 *
 * 与"整段跑一次再看分段收益"的区别：后者是同一批持仓/资金连续滚出来的，
 * 分段收益受前段仓位与费用影响；逐折独立跑才是真正的"样本外"视角。
 *
 * @param {object} model
 * @param {{folds?:number, opts?:object}} [cfg]
 */
function walkForward(model, cfg = {}) {
  const folds = Math.max(2, Math.min(Number(cfg.folds) || 3, 8));
  const opts = cfg.opts || {};

  let backtests = 0;
  const full = runModel(model, opts);
  backtests += 1;
  if (!full.ok) return { ok: false, stage: full.stage, error: full.error, issues: full.issues || null, backtests };

  // 用整段回测的净值日期轴做切分依据（它是真实交易日，且已随结果返回，无需新契约）
  const axis = (full.result.equity || []).map((p) => p.date);
  if (axis.length < folds + 1) {
    return { ok: false, error: `区间内可用日期点不足（${axis.length}）以切 ${folds} 折——请放宽区间或减少折数`, backtests };
  }
  const boundAt = (i) => axis[Math.min(axis.length - 1, Math.round((i * (axis.length - 1)) / folds))];

  const segs = [];
  const skipped = [];
  for (let i = 0; i < folds; i++) {
    const startDate = boundAt(i);
    const endDate = boundAt(i + 1);
    const r = runModel(model, { ...opts, startDate, endDate });
    backtests += 1;
    if (!r.ok) {
      // 折内样本不足是**显式**结果，不是静默跳过
      skipped.push({ fold: i + 1, startDate, endDate, reason: `${r.stage}: ${r.error}` });
      continue;
    }
    segs.push({
      fold: i + 1,
      startDate,
      endDate,
      actualRange: r.result.range,
      bars: r.result.range.bars,
      totalReturn: r.result.totalReturn,
      maxDrawdownPct: r.result.maxDrawdownPct,
      sharpe: r.result.sharpe,
      benchmarkReturn: r.result.benchmarkReturn,
      excessReturn: r.result.benchmarkReturn === null ? null : +(r.result.totalReturn - r.result.benchmarkReturn).toFixed(2),
      icMean: r.result.ic.icMean,
      icN: r.result.ic.n,
      rebalances: r.result.rebalances,
    });
  }

  if (!segs.length) {
    return { ok: false, error: '所有折都因样本不足无法回测', skipped, rules: RULES };
  }

  const rets = segs.map((s) => s.totalReturn);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const max = Math.max(...rets);
  const min = Math.min(...rets);
  const spread = +(max - min).toFixed(2);
  const overall = full.result.totalReturn;

  const flags = [];
  for (const s of segs) {
    if (overall > 0 && s.totalReturn < -RULES.walkForwardSignFlipPct) {
      flags.push(`第 ${s.fold} 折（${s.startDate}~${s.endDate}）收益 ${s.totalReturn}%，与整段 ${overall}% 方向相反`);
    }
  }
  if (spread > RULES.walkForwardDispersionPct) {
    flags.push(`折间总收益离散度 ${spread} 个百分点（> ${RULES.walkForwardDispersionPct}）——分期表现不稳定`);
  }

  return {
    ok: true,
    folds: segs,
    skipped,
    overall: { totalReturn: overall, maxDrawdownPct: full.result.maxDrawdownPct, sharpe: full.result.sharpe },
    dispersion: { mean: +mean.toFixed(2), min, max, spread },
    verdict: flags.length ? 'unstable' : 'stable',
    flags,
    rules: RULES,
    backtests,
    note: `每折独立重跑（不共享仓位与费用），共 ${segs.length} 折${skipped.length ? `，${skipped.length} 折因样本不足未评估` : ''}；本项共执行 ${backtests} 次回测`,
  };
}

// ─────────────────────────────────────────────────────────────
// 三、参数稳健：平原扫描
// ─────────────────────────────────────────────────────────────
const roundInt = (v) => Math.max(1, Math.round(v));

/**
 * 参数 ±30% 网格扫描，看性能衰减曲线。
 *
 * 判据（§5.3）：真实有效的模型在参数邻域内应是**平原**；尖峰说明结果依赖于
 * 某个被调到恰好的取值——这是过拟合最典型的样子。
 *
 * @param {object} model
 * @param {{param?:'topN'|'weight', ratios?:number[], opts?:object}} [cfg]
 */
function plateauScan(model, cfg = {}) {
  const param = cfg.param === 'weight' ? 'weight' : 'topN';
  const ratios = (cfg.ratios || [0.7, 0.85, 1, 1.15, 1.3]).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const opts = cfg.opts || {};
  if (param === 'weight' && (!model.factors || !model.factors.length)) {
    return { ok: false, error: '模型没有因子，无法扫描权重' };
  }

  const baseTopN = Number(opts.topN) || 5;
  const baseWeight = model.factors && model.factors.length ? Number(model.factors[0].weight ?? 1) : 1;

  const seen = new Map(); // 去重后的参数值 → 点
  // 🔴 必须按"离基准由近到远"的顺序处理：取整合并时**保留最接近基准的比例**。
  //    否则先到的极端比例会占坑（如 topN=1 时 0.7 抢在 1 前面），
  //    导致后面的 `center` 找不到 ratio=1 而退化成 points[0] —— 中心点被误认，
  //    所有 delta/drop 都相对一个边界点计算，整份扫描结论失真（且不会报错）。
  const ordered = [...ratios].sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1));
  for (const ratio of ordered) {
    let value;
    let runOpts = opts;
    let runModel_ = model;
    if (param === 'topN') {
      value = roundInt(baseTopN * ratio);
      runOpts = { ...opts, topN: value };
    } else {
      value = +(baseWeight * ratio).toFixed(6);
      // 只改第一个因子的权重 → 改变因子间的相对配比（整体等比缩放不会改变排序，等于白扫）
      runModel_ = { ...model, factors: model.factors.map((f, i) => (i === 0 ? { ...f, weight: value } : f)) };
    }
    const key = `${param}=${value}`;
    const hit = seen.get(key);
    if (hit) {
      hit.mergedRatios.push(ratio); // 如实记录被合并的比例，不假装扫了 5 个点
      continue;
    }
    const point = { value, ratio, mergedRatios: [ratio] };
    const r = runModel(runModel_, runOpts);
    if (!r.ok) {
      point.ok = false;
      point.reason = `${r.stage}: ${r.error}`;
      seen.set(key, point);
      continue;
    }
    point.ok = true;
    point.totalReturn = r.result.totalReturn;
    point.maxDrawdownPct = r.result.maxDrawdownPct;
    point.sharpe = r.result.sharpe;
    point.icMean = r.result.ic.icMean;
    point.icN = r.result.ic.n;
    seen.set(key, point);
  }
  const points = [...seen.values()];

  const center = points.find((p) => Math.abs(p.ratio - 1) < 1e-9) || points[0];
  if (!center || !center.ok) {
    return { ok: false, error: '中心点（原参数）回测失败，无法比较衰减', points, rules: RULES };
  }
  const baseRet = center.totalReturn;
  const withDelta = points.map((p) => ({
    ...p,
    /** 相对中心点的收益变化（百分点）；中心点为 0 */
    deltaPct: p.ok ? +(p.totalReturn - baseRet).toFixed(2) : null,
    /** 相对中心点的跌幅（正数表示变差） */
    dropPct: p.ok && baseRet !== 0 ? +(((baseRet - p.totalReturn) / Math.abs(baseRet)) * 100).toFixed(1) : null,
  }));

  // 🔴 边界点按**实际可达的极值**取，而不是按 ratio 匹配 0.7 / 1.3：
  //    取整合并会让某一侧的比例被吞掉（实测 topN=5 时 0.7 与 0.85 都取整到 4，
  //    按 ratio 匹配就只剩 1.3 一侧被检查，−30% 那一侧静默漏检）。
  //    真实可达的极值点才是"邻域稳健性"真正要检验的地方。
  const okPts = withDelta.filter((p) => p.ok);
  const byValue = [...okPts].sort((a, b) => a.value - b.value);
  const edgePts = byValue.length > 1 ? [byValue[0], byValue[byValue.length - 1]] : [];
  const wantMin = Math.min(...ratios);
  const wantMax = Math.max(...ratios);
  const gotMin = okPts.length ? Math.min(...okPts.map((p) => p.ratio)) : null;
  const gotMax = okPts.length ? Math.max(...okPts.map((p) => p.ratio)) : null;

  const flags = [];
  for (const e of edgePts) {
    const at = `${(e.ratio * 100).toFixed(0)}%（${param}=${e.value}）`;
    if (e.dropPct !== null && e.dropPct > RULES.plateauMaxDropPct) {
      flags.push(`边界点 ${at} 收益跌幅 ${e.dropPct}%（> ${RULES.plateauMaxDropPct}%）——尖峰`);
    }
    if (baseRet > 0 && e.totalReturn < 0) {
      flags.push(`边界点 ${at} 收益转负（${e.totalReturn}%）——邻域不稳健`);
    }
  }
  // 最接近基准的可达点若已明显变差，给出较早的提示（不必等到边界）
  const near = okPts
    .filter((p) => Math.abs(p.ratio - 1) > 1e-9)
    .sort((a, b) => Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1))[0];
  if (near && near.dropPct !== null && near.dropPct > RULES.plateauCenterHintPct) {
    flags.push(`最近邻参数点 ${(near.ratio * 100).toFixed(0)}%（${param}=${near.value}）收益跌幅已达 ${near.dropPct}%（> ${RULES.plateauCenterHintPct}%）——参数敏感`);
  }
  // 边界点缺失（所有比例都塌到同一个取值）时显式说明，避免"看着像扫过但没扫"
  if (!edgePts.length) {
    flags.push(`no-edge-points：取整后 ±30% 边界与基准点重合（${param} 基准值 ${param === 'topN' ? baseTopN : baseWeight} 太小），本次扫描**未能覆盖 ±30% 边界**——需提高基准参数才能做真正的邻域检验`);
  } else if (gotMin > wantMin + 1e-9 || gotMax < wantMax - 1e-9) {
    flags.push(
      `partial-coverage：请求覆盖 ${(wantMin * 100).toFixed(0)}%~${(wantMax * 100).toFixed(0)}%，` +
        `实际可达 ${(gotMin * 100).toFixed(0)}%~${(gotMax * 100).toFixed(0)}%` +
        `（取整后部分比例合并到同一取值，见 mergedPoints）——判定以**实际可达的极值点**为准`,
    );
  }

  const merged = withDelta.filter((p) => p.mergedRatios.length > 1);
  return {
    ok: true,
    param,
    baseValue: param === 'topN' ? baseTopN : baseWeight,
    points: withDelta,
    distinctPoints: points.length,
    requestedRatios: ratios.length,
    mergedPoints: merged.map((p) => ({ value: p.value, keptRatio: p.ratio, mergedRatios: p.mergedRatios })),
    /** 真实覆盖范围（请求 vs 实际可达）——取整合并会缩窄，必须显式给出 */
    coverage: { requested: [wantMin, wantMax], actual: [gotMin, gotMax] },
    verdict: flags.some((f) => !f.startsWith('no-edge-points') && !f.startsWith('partial-coverage')) ? 'spike' : 'plateau',
    flags,
    rules: RULES,
    backtests: points.filter((p) => p.ok || p.reason).length,
    note:
      `${param} 在基准 ±30% 内扫描；${points.length}/${ratios.length} 个网格取到不同取值` +
      `，实际可达覆盖 ${gotMin === null ? '—' : `${(gotMin * 100).toFixed(0)}%~${(gotMax * 100).toFixed(0)}%`}` +
      (merged.length
        ? `（${merged.length} 个点由多个比例合并而来，已保留最接近基准的比例并如实列出：见 mergedPoints）`
        : '') +
      `；本项共执行 ${points.length} 次回测`,
  };
}

// ─────────────────────────────────────────────────────────────
// 四、汇总报告
// ─────────────────────────────────────────────────────────────
/**
 * 组装完整验证报告。任何一项失败都**如实带出**，不用"通过"掩盖未跑项。
 * @param {object} model
 * @param {{opts?:object, folds?:number, param?:string, skip?:string[]}} [cfg]
 */
function runValidation(model, cfg = {}) {
  const opts = cfg.opts || {};
  const skip = new Set(cfg.skip || []);
  let backtests = 1; // 基准整段回测
  const full = runModel(model, opts);

  const report = {
    ok: full.ok,
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    fingerprint: full.ok ? full.fingerprint : null,
    model: { name: (model && model.name) || '(未命名)', factors: (model && model.factors || []).length },
    sample: null,
    power: null,
    checks: {},
    verdict: { pass: null, flags: [] },
    /** 本次验证实际执行了多少次回测 —— 界面据此提示耗时，也便于事后复核"是否真跑过" */
    cost: { backtests: 0 },
    rules: RULES,
    limitations: LIMITATIONS,
  };

  if (!full.ok) {
    report.cost.backtests = backtests;
    report.error = { stage: full.stage, message: full.error, issues: full.issues || null };
    report.verdict.pass = false;
    report.verdict.flags.push(`回测未能完成（${full.stage}），无法进入验证：${full.error}`);
    return report;
  }

  const s = full.result;
  report.sample = {
    range: s.range,
    bars: s.range.bars,
    universeSize: s.universeSize,
    benchmarkUniverse: s.benchmarkUniverse,
    rebalances: s.rebalances,
    equityPointsReturned: s.equity.length,
  };
  // 样本量与功效说明（§5.3 强制披露）
  report.power = {
    icPeriods: s.ic.n,
    rebalances: s.rebalances,
    sufficient: s.ic.n >= RULES.minIcPeriods,
    note:
      s.ic.n >= RULES.minIcPeriods
        ? `IC 共 ${s.ic.n} 期，达到最低门槛 ${RULES.minIcPeriods} 期`
        : `IC 仅 ${s.ic.n} 期（< ${RULES.minIcPeriods}）——显著性结论**功效不足**，不宜据此判定因子有效`,
  };
  if (!report.power.sufficient) report.verdict.flags.push(report.power.note);

  if (!skip.has('walkForward')) {
    report.checks.walkForward = walkForward(model, { folds: cfg.folds, opts });
    const wf = report.checks.walkForward;
    backtests += wf.backtests || 0;
    if (!wf.ok) report.verdict.flags.push(`样本外滚动未能完成：${wf.error}`);
    else report.verdict.flags.push(...wf.flags);
  }
  if (!skip.has('plateau')) {
    report.checks.plateau = plateauScan(model, { param: cfg.param, opts });
    const pl = report.checks.plateau;
    backtests += pl.backtests || 0;
    if (!pl.ok) report.verdict.flags.push(`参数平原扫描未能完成：${pl.error}`);
    else report.verdict.flags.push(...pl.flags);
  }

  report.cost.backtests = backtests;
  report.verdict.pass = report.verdict.flags.length === 0;
  return report;
}

module.exports = {
  bhFdr,
  walkForward,
  plateauScan,
  runValidation,
  RULES,
  LIMITATIONS,
};
