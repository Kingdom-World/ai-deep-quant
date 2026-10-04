'use strict';
// ─────────────────────────────────────────────────────────────
// Model JSON → 回测执行桥接（Phase 1 模型工坊）
//
//   职责：把**声明式 Model JSON**（shared/modelspec.mjs 规范）翻译成引擎能吃的
//   「复合截面函数」，再交给 crosssect.runWithCrossSection 跑同一套账本。
//
//   🔴 绝不静默忽略：模型里声明的 factors / transforms / filters 必须**全部生效**。
//     任何一项无法实现（未知算子、表达式非法、字段不可用）都在这里显式报错，
//     而不是悄悄跳过——"用户以为生效、实际没有"是最危险的失效形态。
//
//   复合语义（显式固定，可复现）：
//     ① 每个因子独立取截面 → 独立过 transforms 流水线（顺序即声明顺序）
//     ② 按 weight × direction 加权求和为一个综合分（**综合分越高越强**，
//        故 isRevFactor=false：方向已由 direction 表达，不再二次反转）
//     ③ 只保留**全部因子都有值**的股票（与 factorexpr 的交集语义一致，
//        不用 0 填充制造虚假截面样本）
//     ④ 应用 filters（按归档真实字段在 T-1 日取值判定，字段缺失视为不满足）
//     ⑤ 前 topN 名等权持有——调仓、涨跌停守卫、手续费、估值、IC 全部复用引擎
//
//   指纹：同 Model + 同引擎版本 + 同数据窗口 ⇒ 同指纹（复现承诺的载体）。
// ─────────────────────────────────────────────────────────────
const crypto = require('crypto');

const ms = require('../shared/modelspec.cjs');
const fe = require('./factorexpr.cjs');
const crosssect = require('./crosssect.cjs');
const xform = require('./modelxform.cjs');

/** 引擎版本：账本/口径发生任何语义变化时必须递增（指纹的一部分） */
const ENGINE_VERSION = 'crosssect-m1.0';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── 过滤器 ───────────────────────────────────────────────────

/** 单条过滤器判定；字段缺失/非有限 → 不满足（不静默放行） */
function passesFilter(flt, row) {
  const v = row[flt.field];
  if (!isNum(v)) return false;
  if (isNum(flt.min) && !(v >= flt.min)) return false;
  if (isNum(flt.max) && !(v <= flt.max)) return false;
  if (isNum(flt.value)) {
    switch (flt.op) {
      case '>': return v > flt.value;
      case '>=': return v >= flt.value;
      case '<': return v < flt.value;
      case '<=': return v <= flt.value;
      default: return false; // 规范校验已保证 op 合法；此处是纵深防御
    }
  }
  return true;
}

/** 按 T-1 日归档字段过滤截面 */
function applyFilters(rows, filters, universe, rowIndex, prevDate) {
  if (!filters || filters.length === 0) return rows;
  return rows.filter((r) => {
    const i = rowIndex.get(r.code)?.get(prevDate);
    if (i === undefined) return false;
    const row = universe.get(r.code)?.[i];
    if (!row) return false;
    return filters.every((flt) => passesFilter(flt, row));
  });
}

// ── 复合截面 ─────────────────────────────────────────────────

/**
 * 由规范化模型构建复合截面函数。
 * @returns {{crossSection:Function, factorWin:number, factorLabel:string, plan:object}}
 * @throws {Error} 任一因子不可用时抛出（由 runModel 捕获转成结构化错误）
 */
function buildCompositeCrossSection(model) {
  const parts = model.factors.map((f) => {
    const resolved = crosssect.resolveFactor(f.expr);
    if (!resolved.ok) throw new Error(`因子「${f.id}」（${f.expr}）不可用：${resolved.error}`);
    return { f, resolved, sign: f.weight * f.direction };
  });

  // 窗口取所有因子窗口的最大值——保证每个因子在自己的窗口内都有足够历史
  const factorWin = Math.max(1, ...parts.map((p) => p.resolved.factorWin || 1));
  const transforms = model.transforms || [];
  const filters = model.filters || [];

  const crossSection = (universe, rowIndex, prevDate) => {
    // ① 各因子独立取截面 + 独立过预处理流水线
    const perFactor = parts.map((p) => {
      const raw = p.resolved.crossSection(universe, rowIndex, prevDate); // [{code, mom}]
      const done = transforms.length ? xform.applyTransforms(raw, transforms) : raw;
      const m = new Map();
      for (const r of done) m.set(r.code, r.mom);
      return m;
    });

    // ② + ③ 交集 + 加权求和
    const out = [];
    for (const [code, first] of perFactor[0]) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const v = i === 0 ? first : perFactor[i].get(code);
        if (!isNum(v)) { ok = false; break; }
        sum += parts[i].sign * v;
      }
      if (ok && Number.isFinite(sum)) out.push({ code, mom: sum });
    }

    // ④ 过滤器
    return applyFilters(out, filters, universe, rowIndex, prevDate);
  };

  return {
    crossSection,
    factorWin,
    factorLabel: model.factors.map((f) => f.expr).join(' | '),
    plan: {
      factors: model.factors.map((f) => ({ id: f.id, expr: f.expr, weight: f.weight, direction: f.direction })),
      transforms: transforms.map((t) => ({ type: t.type, args: t.args || {} })),
      filters: filters.map((f) => ({ ...f })),
      combine: model.combine.method,
    },
  };
}

// ── 指纹 ─────────────────────────────────────────────────────

/**
 * 语义核心：指纹**只覆盖决定结果的字段**。
 *   为什么剔除 name / hypothesis / meta：它们是元数据，改个标题不该被视为"换了一个模型"，
 *   否则指纹会把同一份实验判成两份，破坏"同指纹即同实验"的判据。
 */
function semanticCore(model) {
  return {
    schemaVersion: model.schemaVersion,
    factors: model.factors,
    transforms: model.transforms,
    combine: model.combine,
    filters: model.filters,
    universe: model.universe,
    backtest: model.backtest,
  };
}

/**
 * 实验指纹：SHA-256(规范序列化{语义核心, engineVersion, 数据窗口, 股票池规模, 参数})。
 * 承诺：同指纹重跑同结果（引擎数值稳定性由黄金样本回归测试保证）。
 */
function fingerprint(model, result, opts = {}) {
  const payload = {
    core: semanticCore(model),
    engineVersion: ENGINE_VERSION,
    dataWindow: result && result.range ? { start: result.range.start, end: result.range.end } : null,
    universeSize: result ? result.universeSize : null,
    params: {
      topN: result ? result.topN : null,
      rebalanceEvery: result ? result.rebalanceEvery : null,
      capital: result ? result.capital : null,
      slippage: result ? result.slippage : null,
      ...(opts.startDate ? { startDate: opts.startDate } : {}),
      ...(opts.endDate ? { endDate: opts.endDate } : {}),
    },
  };
  return crypto.createHash('sha256').update(ms.canonicalJSON(payload)).digest('hex');
}

// ── 主入口 ───────────────────────────────────────────────────

/**
 * 执行一个 Model JSON。
 * @param {object} inputModel 用户提交的 Model（未归一化）
 * @param {object} [opts] { topN, capital, slippage, startDate, endDate }
 * @returns {{ok:true, model:object, engineVersion:string, plan:object, fingerprint:string, result:object}
 *          | {ok:false, stage:'validate'|'build'|'engine', error:string, issues?:object[]}}
 */
function runModel(inputModel, opts = {}) {
  // ① 校验 + 归一化（服务端权威校验：注入真实 AST 解析器）
  const norm = ms.normalizeModel(inputModel, { parseExpr: fe.parseExpression });
  if (!norm.ok) {
    return { ok: false, stage: 'validate', error: 'Model 校验失败', issues: norm.errors };
  }
  const model = norm.model;

  // ② 构建复合截面（因子不可用在此显式失败）
  let composite;
  try {
    composite = buildCompositeCrossSection(model);
  } catch (e) {
    return { ok: false, stage: 'build', error: e.message };
  }

  // ③ 执行（复用引擎账本）
  const result = crosssect.runWithCrossSection(composite.crossSection, {
    factorWin: composite.factorWin,
    factorLabel: composite.factorLabel,
    isRevFactor: false, // 综合分越高越强；方向已由 direction 表达
    factorExprMeta: { composite: true, plan: composite.plan },
    topN: opts.topN,
    rebalanceEvery: ms.rebalanceBars(model.backtest.rebalance),
    capital: opts.capital,
    slippage: opts.slippage,
    startDate: opts.startDate,
    endDate: opts.endDate,
  });
  if (result.error) return { ok: false, stage: 'engine', error: result.error };

  return {
    ok: true,
    model,
    engineVersion: ENGINE_VERSION,
    plan: composite.plan,
    fingerprint: fingerprint(model, result, opts),
    result,
  };
}

/**
 * 模型**定义**身份（与运行窗口/参数无关）：语义核心的 SHA-256。
 *   与 fingerprint 的分工：fingerprint 标识"一次实验"（含数据窗口与参数），
 *   modelHash 标识"一份模型定义"——模型库里判重、列表展示用它。
 */
function modelHash(model) {
  return crypto.createHash('sha256').update(ms.canonicalJSON(semanticCore(model))).digest('hex');
}

module.exports = {
  runModel,
  buildCompositeCrossSection,
  fingerprint,
  modelHash,
  semanticCore,
  ENGINE_VERSION,
  applyFilters,
  passesFilter,
};
