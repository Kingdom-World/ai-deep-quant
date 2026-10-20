// ─────────────────────────────────────────────────────────────
// 逐根 K 线回放引擎（Phase 5 · 进阶回测）：截面引擎的「精确执行」对照组
//
// ## 定位（为什么存在）
// crosssect.cjs 头部诚实声明了三条简化：
//   ① 已持有且仍在目标内的标的不再调平衡（持仓权重随涨跌漂移）
//   ② 等权目标值按上一交易日净值计算
//   ③ 期末按最后收盘价强平（不加滑点）
// 本引擎把这三条**逐一替换为精确执行**（每条一个独立开关），跑同一策略，
// 与截面引擎的差异即为"简化带来的偏差"—— 这才是"口径对照"的产出。
//
// ## 单源纪律（选股与前置零分叉）
//   · 选股：复用 crosssect.resolveFactor 的 crossSection（同一排名、无前视时序）
//   · 前置：复用 crosssect.loadUniverseCached / buildContext（同一归档、同一交易日轴、同一 priceAt）
//   · 守卫：涨跌停用 paper/matcher.limitPrices、费用用 paper/fees.calcFees（与两引擎同源）
//   · 指标：quant.equityMetrics（P4 建立的单源实现）
//   ⇒ 本文件**只新写执行层**——恰是要对照的东西。
//
// ## 执行层与截面引擎的差异（= 四个开关，默认全开=精确模式）
//   rebalance     消除简化①：调仓日把**已持有且在目标内**的也调回目标权重（差额整手）
//   freshEquity   消除简化②：等权目标值用 T 日开盘的实际净值（先卖后买，卖出所得当日可用）
//   finalSlippage 消除简化③：期末强平计滑点（卖出 ×(1−slip)）
//   sellSlippage  消除**截面引擎的缺陷**（见下）：卖出侧也计滑点
//   全部关闭时应≈截面引擎结果（实测 slippage=0 时换手/费用差仅 0.02%，为取整级）。
//
// ## 🔴 对照中发现截面引擎的真实缺陷（2026-10-20）
//   crosssect.cjs 第 470 行注释写「卖出…（T 日开盘 ×(1−滑点)）」，
//   但**代码里卖出从未乘 (1−slippage)**（slippage 仅出现在买入侧 506/511 行）。
//   ⇒ 历史回测的收益被**系统性高估**（少扣一半滑点）。
//   本引擎用 `sellSlippage` 开关保留两种口径，便于量化该缺陷的影响；
//   **不擅自修截面引擎**（会改变所有历史结果与既有测试），是否修复留待决策。
//
// ## 逐日盯市
// equity 序列**每个交易日**一条（cash + 持仓×当日复权收盘），供 equityMetrics 单源计算。
// ⚠️ 本引擎不做任何"事件"注入（分红/拆股已在复权口径内），它精确的是**资金约束与权重**。
// ─────────────────────────────────────────────────────────────
'use strict';

const crosssect = require('./crosssect.cjs');
const { calcFees, marketOf } = require('./paper/fees.cjs');
const { limitPrices } = require('./paper/matcher.cjs');
const { equityMetrics } = require('./quant.cjs');

/**
 * @param opts 与 runCrossBacktest 同构：{ factor, topN, rebalanceEvery, capital, slippage, startDate, endDate }
 *   外加三个开关（默认 true = 精确模式）：{ rebalance, freshEquity, finalSlippage }
 * @returns { error } 或 {
 *   equity: [{date, value}], days, metrics,       // metrics 由 quant.equityMetrics 单源产出
 *   rebalances, fills, turnover, totalFees,
 *   blockedLimitUp, blockedLimitDown, skippedTinyAdjust,
 *   switches: { rebalance, freshEquity, finalSlippage }, factorLabel, topN, rebalanceEvery,
 * }
 */
function runReplay(opts = {}) {
  const dirAbs = crosssect.resolveArchiveDir();
  const universe = crosssect.loadUniverseCached(dirAbs, crosssect.UNIVERSE_MIN_ROWS);
  if (universe.size < 2) return { error: `归档标的不足（${universe.size}）` };

  const resolved = crosssect.resolveFactor(opts.factor ?? 'mom20');
  if (!resolved.ok) return { error: resolved.error };
  const crossSection = resolved.crossSection;
  const factorWin = resolved.factorWin;
  const isRevFactor = resolved.isReversal;

  const topN = Math.max(1, Math.min(Number(opts.topN) || 5, 20));
  const rebalanceEvery = Math.max(1, Math.min(Number(opts.rebalanceEvery) || 20, 250));
  const capital = Math.max(Number(opts.capital) || 1_000_000, 10_000);
  const slippage = Math.min(Math.max(Number(opts.slippage ?? 0.001), 0), 0.05);
  const sw = {
    rebalance: opts.rebalance !== false,
    freshEquity: opts.freshEquity !== false,
    finalSlippage: opts.finalSlippage !== false,
    sellSlippage: opts.sellSlippage !== false, // false = 复刻截面引擎的单边滑点缺陷
  };

  const ctx = crosssect.buildContext(universe, factorWin, opts);
  if (ctx.error) return { error: ctx.error };
  const { dates, rowIndex, priceAt } = ctx;

  // 账本（与截面引擎同构：cash + holdings Map<code, qty>）
  let cash = capital;
  const holdings = new Map();
  const equity = [];
  let rebalances = 0;
  let fills = 0;
  let turnover = 0;
  let totalFees = 0;
  let blockedLimitUp = 0;
  let blockedLimitDown = 0;
  let skippedTinyAdjust = 0; // 差额不足一手而放弃的微调次数（精确模式的诚实账）

  const sellAll = (code, date, withSlip = true) => {
    const rawOpen = priceAt(code, date, 'open');
    if (rawOpen === null) return false;
    const prevClose = priceAt(code, dates[rowIndexSafe(date) - 1] ?? date, 'close');
    if (marketOf(code) === 'CN' && prevClose !== null) {
      const lp = limitPrices(code, null, prevClose);
      if (lp && rawOpen <= lp.lower) { blockedLimitDown += 1; return false; }
    }
    const px = priceAt(code, date, 'open', true);
    if (px === null) return false;
    const qty = holdings.get(code);
    if (!qty) return false;
    const execPx = withSlip && sw.sellSlippage ? px * (1 - slippage) : px;
    const value = qty * execPx;
    const fee = calcFees('CN', 'sell', value).total;
    cash += value - fee;
    totalFees += fee;
    turnover += value;
    fills += 1;
    holdings.delete(code);
    return true;
  };

  /** rowIndexSafe：dates 轴上的下标（供取 prevDate；找不到返回 0） */
  function rowIndexSafe(date) {
    return _dateIdx.get(date) ?? 0;
  }
  const _dateIdx = new Map();
  dates.forEach((d, i) => _dateIdx.set(d, i));

  const buyTo = (code, date, amount) => {
    // 涨跌停守卫：开盘涨停买不进（rawOpen 与 limitPrices 同口径，均为真实价）
    const rawOpen = priceAt(code, date, 'open');
    if (rawOpen === null) return 0;
    const di = _dateIdx.get(date);
    const prevClose = di > 0 ? priceAt(code, dates[di - 1], 'close') : null;
    if (marketOf(code) === 'CN' && prevClose !== null) {
      const lp = limitPrices(code, null, prevClose);
      if (lp && rawOpen >= lp.upper) { blockedLimitUp += 1; return 0; }
    }
    const px = priceAt(code, date, 'open', true);
    if (px === null) return 0;
    const execPx = px * (1 + slippage);
    let qty = Math.floor(amount / (execPx * 100)) * 100;
    while (qty > 0) {
      const value = qty * execPx;
      const fee = calcFees('CN', 'buy', value).total;
      if (cash >= value + fee) {
        cash = +(cash - value - fee).toFixed(2);
        totalFees += fee;
        turnover += value;
        fills += 1;
        holdings.set(code, (holdings.get(code) || 0) + qty);
        return qty;
      }
      qty -= 100;
    }
    return 0;
  };

  for (let di = factorWin + 1; di < dates.length; di += 1) {
    const date = dates[di];

    if ((di - factorWin - 1) % rebalanceEvery === 0) {
      rebalances += 1;
      const prevDate = dates[di - 1];
      // 选股：T-1 收盘截面排名（与截面引擎同一 crossSection、同一无前视时序）
      const cands = crossSection(universe, rowIndex, prevDate);
      cands.sort((a, b) => (isRevFactor ? a.mom - b.mom : b.mom - a.mom));
      const target = cands.slice(0, topN).map((c) => c.code);
      const targetSet = new Set(target);

      // 1) 调出：卖出不在目标内的（同截面引擎）
      for (const code of [...holdings.keys()]) {
        if (targetSet.has(code)) continue;
        sellAll(code, date);
      }

      // 2) 精确模式的差额卖出：已持有且在目标内、市值显著超标的先减（腾资金给低配者）
      let openEquity = cash;
      for (const [code, qty] of holdings) {
        const px = priceAt(code, date, 'open', true);
        if (px !== null) openEquity += qty * px;
      }
      let perName;
      if (sw.freshEquity) {
        // 简化②的精确版：T 日开盘实际净值（此时 cash 已含当日卖出所得 ⇒ 修正为"可用资金 + 开盘持仓市值"）
        perName = openEquity / Math.max(1, target.length);
      } else {
        // 简化②的旧行为，必须与截面引擎**逐字同口径**：
        //   取 equity 尾值（= 上一交易日收盘净值），而不是现算 ——
        //   ⚠️ 现算 `cash + Σqty×prevClose` 会被"当日卖出所得"污染（cash 已变），
        //      实测会带来约 3% 的终值偏差（本引擎首版的真实 bug）。
        const baseEquity = equity.length ? equity[equity.length - 1].value : capital;
        perName = baseEquity / Math.max(1, target.length);
      }

      if (sw.rebalance) {
        for (const code of target) {
          if (!holdings.has(code)) continue;
          const qty = holdings.get(code);
          const px = priceAt(code, date, 'open', true);
          if (px === null) continue;
          const over = qty * px - perName;
          // 差额卖出的门槛：超出额 ≥ 一手价值才动（微调的费用不划算，诚实计数）
          if (over > px * 100) {
            const sellQty = Math.floor(over / (px * 100)) * 100;
            if (sellQty >= 100 && qty - sellQty >= 0) {
              const rawOpen = priceAt(code, date, 'open');
              const lp = limitPrices(code, null, priceAt(code, prevDate, 'close'));
              if (rawOpen !== null && lp && rawOpen <= lp.lower) { blockedLimitDown += 1; continue; }
              const execPx = sw.sellSlippage ? px * (1 - slippage) : px;
              const value = sellQty * execPx;
              const fee = calcFees('CN', 'sell', value).total;
              cash += value - fee;
              totalFees += fee;
              turnover += value;
              fills += 1;
              const left = qty - sellQty;
              if (left > 0) holdings.set(code, left); else holdings.delete(code);
            }
          } else if (over > 0) {
            skippedTinyAdjust += 1;
          }
        }
      }

      // 3) 调入 / 差额买入（rebalance=false 时与截面引擎一致：只补空缺）
      for (const code of target) {
        if (!sw.rebalance && holdings.has(code)) continue; // 简化①（旧行为）
        const heldQty = holdings.get(code) || 0;
        const px = priceAt(code, date, 'open', true);
        if (px === null) continue;
        const need = perName - heldQty * px;
        if (need < px * 100) { if (need > 0) skippedTinyAdjust += 1; continue; }
        buyTo(code, date, need);
      }
    }

    // 逐日盯市：当日收盘净值（复权口径，与截面引擎估值同源）
    let value = cash;
    for (const [code, qty] of holdings) {
      const px = priceAt(code, date, 'close', true);
      if (px !== null) value += qty * px;
    }
    equity.push({ date, value: +value.toFixed(2) });
  }

  // 期末强平（口径分档：finalSlippage=true 计滑点 = 消除简化③）
  //   🔴 必须与截面引擎**同价源**：按最后交易日**收盘价**（close），不是开盘价。
  //      （首版误用了 sellAll，其取 open ⇒ 与截面引擎终值差最多 4%+，看起来像账本错误。）
  //   与截面引擎对齐：不做涨跌停守卫（计价惯例，非真实委托）；
  //   `equity` 保留**强平前**的逐日序列，另给 `finalEquity`（强平后现金）；
  //   metrics 用 [`...equity`, {强平后}] 计算，但年化年限仍取强平前的条数（同 crosssect 的 bars）。
  const lastDate = dates[dates.length - 1];
  const finalSlipMul = sw.finalSlippage ? 1 - slippage : 1;
  for (const [code, qty] of [...holdings.entries()]) {
    const rawPx = priceAt(code, lastDate, 'close', true);
    if (rawPx === null) continue;
    const px = rawPx * finalSlipMul;
    const value = qty * px;
    const fee = calcFees('CN', 'sell', value).total;
    cash += value - fee;
    totalFees += fee;
    turnover += value;
    fills += 1;
    holdings.delete(code);
  }
  const finalEquity = [...equity, { date: lastDate, value: +cash.toFixed(2) }];

  return {
    equity,
    finalEquity,
    finalValue: +cash.toFixed(2),
    days: equity.length,
    metrics: equityMetrics(finalEquity, capital, equity.length),
    rebalances,
    fills,
    turnover: +turnover.toFixed(2),
    totalFees: +totalFees.toFixed(2),
    blockedLimitUp,
    blockedLimitDown,
    skippedTinyAdjust,
    switches: sw,
    factorLabel: resolved.factor,
    topN,
    rebalanceEvery,
  };
}

module.exports = { runReplay };
