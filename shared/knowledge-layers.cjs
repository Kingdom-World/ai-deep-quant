// ─────────────────────────────────────────────────────────────
// 知识库分层 taxonomy 单一源（Phase 2.5 · #70）
//
//   存在的理由（不是为了"整理"，是为了防一类具体错误）：
//   知识库 2.0 加了教学五层后，前端 `KnowledgeEntry.category` 的
//   联合类型仍停在 `'term'|'basis'|'method'|'paper'` —— **缺 3 个层，类型是错的**。
//   而修法如果是在前端手抄一份 `['term','method','principle','case','cycle',…]`，
//   就等于建了第二份 taxonomy：后端加层时前端不会报错，只会静默把新层
//   渲染成「其他」灰chip —— 正是本项目吃过 6 次的「字段错配」类 bug。
//
//   故按平台既有约定抽成三件套：
//     .cjs    实现（后端 require；平台运行时禁用 require(ESM)）
//     .mjs    零逻辑转发壳（前端 import）
//     .d.mts  类型声明（TS 侧）
//
//   ⚠️ 本文件**不含任何 IO**，纯常量 —— 它被前端 import 是安全的。
// ─────────────────────────────────────────────────────────────

/**
 * 🔴 教学五层（计划书 §11.1）：学科知识，是 Learn 学习路径的编排依据。
 *   顺序 = 学习路径的自然顺序，**不要重排**（前端按此渲染层间导航）。
 */
const LAYERS = {
  term: '术语',
  method: '方法论',
  principle: '原理',
  case: '案例',
  cycle: '周期专题',
};

/** 平台辅助类：平台自身的计算口径与权威文献，**不是教学层**（混进五层会污染学习路径） */
const AUX = {
  basis: '口径',
  paper: '文献',
};

/** 全部分类（教学五层 + 辅助类） */
const CATEGORIES = { ...LAYERS, ...AUX };

/** 教学五层的 key，顺序同 LAYERS */
const LAYER_KEYS = Object.keys(LAYERS);

/** 是否教学层（Learn 路径只消费教学层） */
const isTeachingLayer = (c) => Object.prototype.hasOwnProperty.call(LAYERS, c);

module.exports = { LAYERS, AUX, CATEGORIES, LAYER_KEYS, isTeachingLayer };
