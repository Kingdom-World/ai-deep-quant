'use strict';
// ─────────────────────────────────────────────────────────────
// modeldag —— 把 Model JSON 派生为 DAG 图模型（Phase 2 · 可编辑 DAG）
//
//   🔴 本模块是**纯函数单一源**（.cjs 实现 + .mjs 转发壳 + .d.mts 类型）：
//      无 React、无 IO ⇒ 前后端可用，且能在 node 下**真实测行为**（而非源码级断言）。
//      放 shared/ 而非 src/ 正是为此 —— 前端 TS 文件无法被 node 直接 require。
//
//   🔴 设计裁定：Model JSON v1 是**固定 schema**（schemaVersion:1、combine 只有
//      weighted_sum、字段固定），**不是自由拓扑图**。因此不做"自由拖拽连线"
//      —— 拖出来的图存不进去，会变成"看起来能编辑、实际存不下来"的假编辑器。
//      DAG 是 Model JSON 的**可视化编辑面**：编辑动作 = 增删因子 / 调权重方向 /
//      开关变换过滤 / 调回测参数，产物仍是同一种声明式 Model JSON。
//
//   🔴 停用的语义：停用 = **从 Model JSON 移除该条**（规范没有"禁用"字段）。
//      代价：重新启用会用该类型**默认参数**，不是恢复原值 —— 这是刻意的：
//      声明式模型只表达"现在跑什么"，不表达"曾经跑过什么"（无隐藏状态）。
//
//   🔴 方向三态：'auto' ⇒ **删除** direction 字段（写死会固化此刻的推导结果，
//      改名后不再跟随，还会触发校验警告噪声）。实际方向由规范按因子名推导。
//
//   ⚠️ 编辑期**不做**本地规范校验：normalizeModel 需要 parseExpr（白名单 AST
//      解析器），它实现在 server/factorexpr.cjs —— 前端拿不到，此前前端也从不
//      本地校验模型。故编辑期只做内联边界检查，完整校验在**保存时走服务端**。
// ─────────────────────────────────────────────────────────────
const { LIMITS, PRESET_FACTORS, REBALANCE_BARS } = require('./modelspec.cjs');

/** 归一化（非 null）读：老数据可能缺字段，一律回落空对象而非抛错 */
const safe = (model) => (model && typeof model === 'object' ? model : {});
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 因子方向的可编辑三态：字段缺失 ⇒ 'auto'（交由规范按名推导） */
const directionTri = (f) => (f.direction === 1 || f.direction === -1 ? f.direction : 'auto');

/** 变换参数的可读摘要（{type:'winsorize',args:{method:'mad',n:3}} → "method=mad · n=3"） */
function describeArgs(t) {
  const args = t.args || {};
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? parts.join(' · ') : '无参数';
}

/**
 * 从 Model JSON 派生 DAG。
 * 固定形态：数据 → 因子 → 变换 → 过滤 → 组合 → 回测；某类为空时**连线自动跳过**该层。
 * @param {unknown} model
 * @returns {{nodes:Array<object>, edges:Array<{from:string,to:string}>, stats:object}}
 */
function buildDag(model) {
  const m = safe(model);
  const factors = Array.isArray(m.factors) ? m.factors : [];
  const transforms = Array.isArray(m.transforms) ? m.transforms : [];
  const filters = Array.isArray(m.filters) ? m.filters : [];
  const backtest = m.backtest || {};
  const combine = m.combine || {};
  const universe = m.universe || {};

  const nodes = [];
  const edges = [];

  // ① 数据源
  nodes.push({
    id: 'data', kind: 'data', title: '数据源', sub: String(universe.type || 'core_pool'),
    fields: [], removable: false, addable: false, issuePrefix: 'universe',
  });

  // ② 因子（可增删、可调权重与方向）
  const factorIds = [];
  factors.forEach((f, i) => {
    const id = `f:${String(f.id ?? f.expr ?? i)}`;
    factorIds.push(id);
    nodes.push({
      id, kind: 'factor', title: String(f.expr ?? f.id ?? `因子${i + 1}`), sub: `权重 ${num(f.weight, 1)}`,
      fields: [
        { kind: 'weight', path: `factors.${i}.weight`, value: num(f.weight, 1), min: 0, max: LIMITS.maxWeight },
        { kind: 'direction', path: `factors.${i}.direction`, value: directionTri(f) },
      ],
      removable: true, addable: false, issuePrefix: `factors.${i}`,
    });
  });
  // 因子区添加入口（可选项来自规范，不手抄）
  //   ⚠️ 留档事实：PRESET_FACTORS(6) < LIMITS.maxFactors(8) ⇒ 白名单比上限更紧，
  //      用户实际能加到的因子数是 6 而非 8。这是刻意的（因子名走白名单，不允许自造）。
  nodes.push({
    id: 'f:add', kind: 'factor',
    title: '+ 添加因子',
    sub: factors.length >= LIMITS.maxFactors
      ? `已达上限 ${LIMITS.maxFactors}`
      : `可选 ${PRESET_FACTORS.length} 个预置${PRESET_FACTORS.length < LIMITS.maxFactors ? `（上限 ${LIMITS.maxFactors}，白名单更紧）` : ''}`,
    fields: [], removable: false, addable: true, issuePrefix: 'factors',
  });
  factorIds.forEach((id) => edges.push({ from: 'data', to: id }));

  // ③ 变换 ④ 过滤（停用 = 移除）
  const transformIds = [];
  transforms.forEach((t, i) => {
    const id = `t:${i}`;
    transformIds.push(id);
    nodes.push({
      id, kind: 'transform', title: String(t.type || 'transform'), sub: describeArgs(t),
      fields: [], removable: true, addable: false, issuePrefix: `transforms.${i}`,
    });
  });
  const filterIds = [];
  filters.forEach((f, i) => {
    const id = `ft:${i}`;
    filterIds.push(id);
    nodes.push({
      id, kind: 'filter', title: `${f.field ?? '?'} ${f.op ?? '?'} ${f.value ?? '?'}`, sub: '停用即从模型移除',
      fields: [], removable: true, addable: false, issuePrefix: `filters.${i}`,
    });
  });

  // ⑤ 组合 ⑥ 回测
  nodes.push({
    id: 'combine', kind: 'combine', title: '组合', sub: String(combine.method || 'weighted_sum'),
    fields: [], removable: false, addable: false, issuePrefix: 'combine',
  });
  nodes.push({
    id: 'backtest', kind: 'backtest', title: '回测',
    sub: `${String(backtest.rebalance ?? 'monthly')} · ${num(backtest.groups, 5)} 组`,
    fields: [
      { kind: 'select', path: 'backtest.rebalance', value: String(backtest.rebalance ?? 'monthly'), options: Object.keys(REBALANCE_BARS) },
      { kind: 'number', path: 'backtest.groups', value: num(backtest.groups, 5), min: LIMITS.minGroups, max: LIMITS.maxGroups, unit: '组' },
      { kind: 'select', path: 'backtest.fees', value: backtest.fees === false ? 'off' : 'on', options: ['on', 'off'] },
    ],
    removable: false, addable: false, issuePrefix: 'backtest',
  });
  edges.push({ from: 'combine', to: 'backtest' });

  // 连线：因子 →（变换 →）→（过滤 →）→ 组合；某层为空则跳过，不留悬空节点
  if (transformIds.length) {
    factorIds.forEach((f) => transformIds.forEach((t) => edges.push({ from: f, to: t })));
    if (filterIds.length) {
      transformIds.forEach((t) => filterIds.forEach((ft) => edges.push({ from: t, to: ft })));
      filterIds.forEach((ft) => edges.push({ from: ft, to: 'combine' }));
    } else {
      transformIds.forEach((t) => edges.push({ from: t, to: 'combine' }));
    }
  } else if (filterIds.length) {
    factorIds.forEach((f) => filterIds.forEach((ft) => edges.push({ from: f, to: ft })));
    filterIds.forEach((ft) => edges.push({ from: ft, to: 'combine' }));
  } else {
    factorIds.forEach((f) => edges.push({ from: f, to: 'combine' }));
  }

  const weights = factors.map((f) => num(f.weight, 1));
  return {
    nodes,
    edges,
    stats: {
      factors: factors.length,
      transforms: transforms.length,
      filters: filters.length,
      groups: num(backtest.groups, 5),
      rebalance: String(backtest.rebalance ?? 'monthly'),
      equalWeight: weights.length > 0 && weights.every((w) => w === weights[0]),
      // 已占用的预置因子：供 UI 算"还能加哪些"，**不在组件里重算**（单一源）
      usedExprs: factors.map((f) => String(f.expr)),
    },
  };
}

const findFactor = (factors, id) => {
  const key = String(id).startsWith('f:') ? String(id).slice(2) : '';
  return factors.findIndex((f) => String(f.id) === key || String(f.expr) === key);
};

/**
 * 应用一次编辑。**纯函数**：不改入参，返回深拷贝。
 * 越界值在**编辑期**就拒（不等点保存才报错）。
 * @param {unknown} model
 * @param {{type:string}} edit
 * @returns {{ok:true, model:object} | {ok:false, error:string}}
 */
function applyEdit(model, edit) {
  // 深拷贝：模型是纯 JSON，JSON 往返最直白（不会有 Date/函数被带过去）
  const next = JSON.parse(JSON.stringify(model ?? {}));
  if (!Array.isArray(next.factors)) next.factors = [];
  if (!Array.isArray(next.transforms)) next.transforms = [];
  if (!Array.isArray(next.filters)) next.filters = [];
  if (!next.backtest || typeof next.backtest !== 'object') next.backtest = {};

  try {
    switch (edit.type) {
      case 'addFactor': {
        if (next.factors.length >= LIMITS.maxFactors) {
          return { ok: false, error: `因子数量已达上限（${LIMITS.maxFactors} 个）` };
        }
        if (!PRESET_FACTORS.includes(edit.expr)) {
          return { ok: false, error: `未知预置因子：${String(edit.expr).slice(0, 20)}（可选项以规范为准）` };
        }
        if (next.factors.some((f) => f.expr === edit.expr)) {
          return { ok: false, error: `因子 ${edit.expr} 已在模型中` };
        }
        next.factors.push({ id: edit.expr, expr: edit.expr, weight: 1 });
        break;
      }
      case 'removeFactor': {
        const i = findFactor(next.factors, edit.id);
        if (i < 0) return { ok: false, error: '因子不存在' };
        if (next.factors.length <= 1) return { ok: false, error: '至少保留一个因子' };
        next.factors.splice(i, 1);
        break;
      }
      case 'setFactorWeight': {
        const i = findFactor(next.factors, edit.id);
        if (i < 0) return { ok: false, error: '因子不存在' };
        const v = Number(edit.value);
        if (!Number.isFinite(v) || v < 0 || v > LIMITS.maxWeight) {
          return { ok: false, error: `权重需在 0 ~ ${LIMITS.maxWeight} 之间（收到 ${String(edit.value).slice(0, 20)}）` };
        }
        next.factors[i].weight = v;
        break;
      }
      case 'setFactorDirection': {
        const i = findFactor(next.factors, edit.id);
        if (i < 0) return { ok: false, error: '因子不存在' };
        if (edit.value === 'auto') {
          // 🔴 'auto' ⇒ **删除**该键，而不是写 1/-1（写死会固化此刻的推导结果）
          delete next.factors[i].direction;
        } else {
          next.factors[i].direction = edit.value === 1 ? 1 : -1;
        }
        break;
      }
      case 'removeTransform': {
        if (!next.transforms[edit.index]) return { ok: false, error: '变换不存在' };
        next.transforms.splice(edit.index, 1);
        break;
      }
      case 'removeFilter': {
        if (!next.filters[edit.index]) return { ok: false, error: '过滤不存在' };
        next.filters.splice(edit.index, 1);
        break;
      }
      case 'setBacktest': {
        const bt = next.backtest;
        if (edit.key === 'rebalance') {
          if (!Object.keys(REBALANCE_BARS).includes(String(edit.value))) {
            return { ok: false, error: `调仓周期非法：${String(edit.value).slice(0, 20)}` };
          }
          bt.rebalance = String(edit.value);
        } else if (edit.key === 'groups') {
          const g = Number(edit.value);
          if (!Number.isInteger(g) || g < LIMITS.minGroups || g > LIMITS.maxGroups) {
            return { ok: false, error: `组数需为 ${LIMITS.minGroups}~${LIMITS.maxGroups} 的整数` };
          }
          bt.groups = g;
        } else {
          bt.fees = edit.value !== false && edit.value !== 'off';
        }
        break;
      }
      default:
        return { ok: false, error: `未知编辑动作：${JSON.stringify(edit).slice(0, 60)}` };
    }
  } catch (e) {
    return { ok: false, error: `编辑失败：${String((e && e.message) || e).slice(0, 80)}` };
  }

  return { ok: true, model: next };
}

/** 统计摘要（UI 顶栏用；避免组件里重复数） */
const dagStats = (graph) => graph.stats;

module.exports = { buildDag, applyEdit, dagStats, LIMITS, PRESET_FACTORS };
