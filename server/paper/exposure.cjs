// ─────────────────────────────────────────────────────────────
// 组合因子暴露（Phase 4 · PortfolioPilot 的基石）
//
// 目的：回答「我这个组合在风格上偏向什么」——
//   对每只持仓算出它在某因子上的当前值，再按**市值权重**加权，
//   得到组合在该因子上的暴露。
//
// 🔴 口径纪律（每条都有实测依据）：
//   ① 因子值**只用 factorexpr 的单一实现**（parseExpression + evalOnStock），
//      不另写一份"组合专用因子计算" —— 那必然与截面/回测口径分叉。
//   ② 价格必须先 `withAdjustedPrices`（前复权）。它是复权口径的**单一实现**，
//      回测/截面引擎都用它；不用它算出的 mom 会与回测结果对不上。
//      🔴 **调用时故意不传第二个参数（复权因子列表）**，依据：
//        · 注入的 `getKlines`（quoteGateway.fetchDailyRows(..., 'qfq')）**已经是前复权价**；
//        · 传 factors 会再乘一次复权因子 ⇒ **双重复权**（数值全错且看不出来）；
//        · 不传时 `withAdjustedPrices` 走 else 分支：`adjClose = close` 并置 `adjFallback`。
//      ⚠️ 该前提（"传入的 close 已是前复权"）是**隐性假设**，故本模块把它显式外露：
//        若出现 `adjFallback`，说明"没有复权因子、直接用 close"——
//        对 qfq 数据无害，但若哪天数据源换成不复权的，这里会**静默错**。
//        因此结果里统计 `adjFallbackCount`，>0 时由上层如实标注。
//   ③ 因子值是**小数**（0.1439 表示 14.39%），不是百分数。
//      展示层要乘 100，这里保持引擎原值。
//   ④ **缺失值绝不按 0 计**：窗口不足时 evalOnStock 返回 null。
//      若把 null 当 0，组合暴露会被"稀释"、显得比实际更中性 ——
//      这是一个**看不出对错的错误结论**。正确做法是把它从权重中剔除，
//      并**如实报告覆盖率**，让人知道这个数是在多大比例上算出来的。
//   ⑤ expsoure 用 `Σ(w·v) / Σ(w_有效)` 归一化到有效权重，
//      而不是 `Σ(w·v)` —— 后者在部分标的缺失时会系统性偏小。
// ─────────────────────────────────────────────────────────────
'use strict';

const factorexpr = require('../factorexpr.cjs');
const crosssect = require('../crosssect.cjs');

/** 每只标的至少要有多少根 K 线才可能算出该因子（maxWindow + 1 根热身） */
function requiredRows(factor) {
  const p = factorexpr.parseExpression(factor);
  if (!p.ok) return { ok: false, error: p.error };
  // maxWindow 需要 i-n ≥ 0 ⇒ 至少 n+1 根；再留 5 根余量给算子内部可能的更长回看
  return { ok: true, need: Math.min(p.meta.maxWindow + 6, 400), meta: p.meta, ast: p.ast };
}

/**
 * 计算组合在若干因子上的暴露。
 *
 * @param {object} opts
 * @param {Array<{symbol:string, marketValue:number}>} opts.positions 持仓（市值即权重）
 * @param {string[]} opts.factors 因子名或表达式
 * @param {(symbol:string, count:number)=>Promise<Array>} opts.getKlines 取 K 线
 * @returns {Promise<{ok:boolean, factors:Array, coverage:object, error?:string}>}
 */
async function computeExposure({ positions, factors, getKlines }) {
  if (!Array.isArray(positions) || !positions.length) {
    return { ok: false, error: '没有持仓，无法计算暴露', factors: [] };
  }
  if (typeof getKlines !== 'function') {
    return { ok: false, error: '未注入行情能力（getKlines）', factors: [] };
  }
  const list = (Array.isArray(factors) && factors.length ? factors : ['mom20', 'mom60', 'rev20', 'rev60'])
    .map((f) => String(f || '').trim())
    .filter(Boolean);

  const totalValue = positions.reduce((a, p) => a + (Number(p.marketValue) || 0), 0);
  if (!(totalValue > 0)) {
    return { ok: false, error: '持仓市值为 0，无法确定权重', factors: [] };
  }

  const out = [];
  const fallbackSyms = new Set(); // 走了"无复权因子"降级的标的（见文件头 ②）
  for (const factor of list) {
    const req = requiredRows(factor);
    if (!req.ok) {
      out.push({ factor, ok: false, error: req.error });
      continue;
    }
    let sum = 0;         // Σ(w · v)，仅对有效标的
    let effWeight = 0;   // Σ(w)，仅对有效标的
    let failed = 0;
    const contributions = [];

    for (const p of positions) {
      const w = (Number(p.marketValue) || 0) / totalValue;
      let v = null;
      let skip = null;
      try {
        const rows = await getKlines(p.symbol, req.need);
        if (!Array.isArray(rows) || rows.length < req.need) {
          skip = `K 线不足（${Array.isArray(rows) ? rows.length : 0} < ${req.need}）`;
        } else {
          crosssect.withAdjustedPrices(rows); // 复权口径的单一实现（原地补 adjClose）
          // 走了 else 分支 ⇒ 无复权因子、直接用 close。对 qfq 数据无害，
          // 但若数据源换成不复权的就会静默出错 ⇒ 必须计数外露（见文件头 ②）
          const lastRow = rows[rows.length - 1];
          if (lastRow && lastRow.adjFallback) fallbackSyms.add(p.symbol);
          v = factorexpr.evalOnStock(req.ast, rows, rows.length - 1);
          if (v === null || !Number.isFinite(v)) {
            v = null;
            skip = '因子值不可计算（可能停牌/窗口内无有效价）';
          }
        }
      } catch (e) {
        skip = `取数失败：${(e && e.message ? e.message : '未知错误').slice(0, 60)}`;
      }

      if (v === null) {
        failed += 1;
        contributions.push({ symbol: p.symbol, weight: w, value: null, skip });
        continue;
      }
      sum += w * v;
      effWeight += w;
      contributions.push({ symbol: p.symbol, weight: w, value: v });
    }

    out.push({
      factor,
      ok: effWeight > 0,
      // 归一化到**有效权重**：否则部分缺失会让暴露系统性偏小（看起来更中性）
      exposure: effWeight > 0 ? sum / effWeight : null,
      coverage: effWeight,               // 参与计算的权重占比（1 = 全覆盖）
      failed,
      contributions,
      error: effWeight > 0 ? undefined : '所有标的都无法计算该因子',
    });
  }

  const usable = out.filter((f) => f.ok);
  return {
    ok: usable.length > 0,
    totalValue,
    positionCount: positions.length,
    factors: out,
    // 组合级覆盖率取所有因子里**最低**的 —— 最需要被注意的那个
    // 组合级覆盖率取**所有因子中最差的那个**（含完全算不出的）。
    // 🔴 只统计 usable 是错的：某个因子如果全军覆没（coverage=0），
    //   那它恰恰最该被注意 —— 把它过滤掉会让"最低覆盖率"永远偏高，
    //   等于把最严重的问题藏起来了。
    coverage: {
      min: out.length ? Math.min(...out.map((f) => (f.ok ? f.coverage : 0))) : 0,
      byFactor: Object.fromEntries(out.map((f) => [f.factor, f.ok ? f.coverage : 0])),
    },
    // 🔴 复权降级外露：这些标的没有复权因子、用的是 close。
    //   对前复权数据无害；非空时上层应提示"价格口径可能不完整"。
    adjFallbackSymbols: [...fallbackSyms],
    error: usable.length ? undefined : '所有因子都无法计算（可能是行情不可用或数据不足）',
  };
}

module.exports = { computeExposure, requiredRows };
