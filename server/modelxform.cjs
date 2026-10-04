'use strict';
// ─────────────────────────────────────────────────────────────
// 截面预处理算子（Phase 1 模型工坊）
//
//   输入/输出统一为**截面数组** `[{ code, mom }]`——与 crosssect 的 crossSection 同构，
//   因此结果可直接交给引擎（runWithCrossSection）消费，无需任何格式转换。
//
//   🔴 口径纪律：每个算子的取数规则必须**显式写死并有测试**，不接受"业界常见做法"含糊表述。
//     缺失值（mom === null/非有限）一律**透传不参与统计**，由最后一步 fill_missing 兜底，
//     或由组合阶段按"缺任一因子即剔除"处理（与 factorexpr 的交集语义一致）。
//
//   算子白名单由 shared/modelspec.mjs 持有（TRANSFORM_TYPES），本文件负责实现；
//   两者的键一致性由 test/modelxform.test.cjs 的锁用例保证。
// ─────────────────────────────────────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 提取有限值数组（保持顺序，用于统计量计算） */
function finiteValues(rows) {
  return rows.filter((r) => isNum(r.mom)).map((r) => r.mom);
}

/** 中位数（偶数取中间两数均值；空数组返回 null） */
function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 分位数（线性插值；q∈[0,1]）。实现与统计教科书 Definition 7 一致并在此显式固定。 */
function quantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ── 算子实现 ─────────────────────────────────────────────────

/**
 * 去极值（winsorize）
 *   method='mad'：以 `median ± n × 1.4826 × MAD` 为界截断。
 *     1.4826 是使 MAD 成为正态分布 σ 的一致估计的尺度因子（业界标准取值），此处显式固定。
 *   method='pct'：以 [n/2, 100−n/2] 分位数为界截断（如 n=5 → 截断 2.5% / 97.5%）。
 *   缺失值透传。
 */
function winsorize(rows, args = {}) {
  const method = args.method || 'mad';
  const n = isNum(args.n) ? args.n : method === 'pct' ? 5 : 3;
  const vals = finiteValues(rows);
  if (vals.length === 0) return rows.map((r) => ({ ...r }));
  const sorted = [...vals].sort((a, b) => a - b);

  let lo;
  let hi;
  if (method === 'pct') {
    lo = quantile(sorted, n / 200); // n% 双侧 → 每侧 n/2%
    hi = quantile(sorted, 1 - n / 200);
  } else {
    const med = median(sorted);
    const dev = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = median(dev);
    const span = n * 1.4826 * mad;
    lo = med - span;
    hi = med + span;
    // MAD=0（多数点相同）时界退化为中位数本身——此时不做截断，避免把整段压平
    if (!(span > 0)) return rows.map((r) => ({ ...r }));
  }
  return rows.map((r) => (isNum(r.mom) ? { ...r, mom: Math.min(hi, Math.max(lo, r.mom)) } : { ...r }));
}

/** 标准化（z-score）：(x − mean) / std，std 为样本标准差（n−1）。std=0 时全部置 0（不产生 Infinity）。缺失值透传。 */
function zscore(rows) {
  const vals = finiteValues(rows);
  if (vals.length < 2) return rows.map((r) => ({ ...r }));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1);
  const sd = Math.sqrt(varr);
  if (!(sd > 0)) return rows.map((r) => (isNum(r.mom) ? { ...r, mom: 0 } : { ...r }));
  return rows.map((r) => (isNum(r.mom) ? { ...r, mom: +( (r.mom - mean) / sd ).toFixed(10) } : { ...r }));
}

/** 截面排名：转为 0~1 分位（并列取平均秩，与 Spearman 的并列处理口径一致）。缺失值透传。 */
function rank(rows) {
  const vals = finiteValues(rows);
  if (vals.length === 0) return rows.map((r) => ({ ...r }));
  const sorted = [...vals].sort((a, b) => a - b);
  const rankOf = new Map(); // value → 平均秩（0-based）
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[i]) j += 1;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) rankOf.set(sorted[k], avg);
    i = j + 1;
  }
  const denom = sorted.length > 1 ? sorted.length - 1 : 1;
  return rows.map((r) => (isNum(r.mom) ? { ...r, mom: +(rankOf.get(r.mom) / denom).toFixed(10) } : { ...r }));
}

/** 缺失填充（fill_missing）：以截面非缺失均值填充。全部缺失时保持缺失（由组合阶段剔除）。 */
function fillMissing(rows, args = {}) {
  const method = args.method || 'cross_mean';
  if (method !== 'cross_mean') throw new Error(`fill_missing 不支持的 method：${method}`);
  const vals = finiteValues(rows);
  if (vals.length === 0) return rows.map((r) => ({ ...r }));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return rows.map((r) => (isNum(r.mom) ? { ...r } : { ...r, mom: mean }));
}

const IMPL = { winsorize, zscore, rank, fill_missing: fillMissing };

/** 支持的算子名（与 shared/modelspec.mjs TRANSFORM_TYPES 必须一致——测试有锁） */
const SUPPORTED = Object.keys(IMPL);

/**
 * 按声明顺序应用预处理流水线（顺序即语义，用户可控）。
 * @param {{code:string, mom:number}[]} rows 原始截面
 * @param {{type:string, args?:object}[]} transforms 声明式流水线
 * @returns {{code:string, mom:number}[]} 处理后的截面（新数组，不改写入参）
 */
function applyTransforms(rows, transforms = []) {
  let out = rows.map((r) => ({ ...r }));
  for (const t of transforms) {
    const fn = IMPL[t.type];
    if (!fn) throw new Error(`未知预处理算子：${t.type}`);
    out = fn(out, t.args || {});
  }
  return out;
}

module.exports = {
  applyTransforms,
  winsorize,
  zscore,
  rank,
  fillMissing,
  SUPPORTED,
  _internal: { median, quantile }, // 供测试核对统计口径
};
