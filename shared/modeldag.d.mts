// modeldag 类型声明 —— 与 shared/modeldag.cjs 一一对应

export type DagNodeKind = 'data' | 'factor' | 'transform' | 'filter' | 'combine' | 'backtest';

/** 可编辑字段清单：UI 照单渲染，不在组件里 if/else 猜字段 */
export type DagField =
  | { kind: 'weight'; path: string; value: number; min: number; max: number }
  | { kind: 'direction'; path: string; value: 'auto' | 1 | -1 }
  | { kind: 'number'; path: string; value: number; min: number; max: number; unit?: string }
  | { kind: 'select'; path: string; value: string; options: string[] };

export interface DagNode {
  /** 稳定 id：因子用表达式（改名会变，故 UI 只用它做 React key） */
  id: string;
  kind: DagNodeKind;
  title: string;
  sub: string;
  fields: DagField[];
  /** 可删除（因子/变换/过滤） */
  removable: boolean;
  /** 该类型是否支持"添加"（仅因子区展示添加器） */
  addable: boolean;
  /** 归一化路径前缀（供校验 issue 定位到节点） */
  issuePrefix: string;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagStats {
  factors: number;
  transforms: number;
  filters: number;
  groups: number;
  rebalance: string;
  /** 组合权重是否全为 1（提示"当前等权"） */
  equalWeight: boolean;
  /** 已占用的预置因子（UI 据此算"还能加哪些"，不在组件里重算） */
  usedExprs: string[];
}

export interface DagGraph {
  nodes: DagNode[];
  edges: DagEdge[];
  stats: DagStats;
}

export type DagEdit =
  | { type: 'addFactor'; expr: string }
  | { type: 'removeFactor'; id: string }
  | { type: 'setFactorWeight'; id: string; value: number | string }
  | { type: 'setFactorDirection'; id: string; value: 'auto' | 1 | -1 }
  | { type: 'removeTransform'; index: number }
  | { type: 'removeFilter'; index: number }
  | { type: 'setBacktest'; key: 'rebalance' | 'groups' | 'fees'; value: string | number | boolean };
//   注：权重/组数接受 string —— input 元素天然给字符串，而 `applyEdit` 内部
//   会 `Number()` 并拒绝非数值（清空输入会被拒，而不是静默变成 0）。

export type DagEditResult = { ok: true; model: Record<string, unknown> } | { ok: false; error: string };

export const LIMITS: { maxFactors: number; maxWeight: number; minGroups: number; maxGroups: number };
export const PRESET_FACTORS: readonly string[];

export function buildDag(model: unknown): DagGraph;
export function applyEdit(model: unknown, edit: DagEdit): DagEditResult;
export function dagStats(graph: DagGraph): DagStats;
