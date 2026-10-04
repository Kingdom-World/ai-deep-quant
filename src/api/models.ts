// ─────────────────────────────────────────────────────────────
// 模型工坊域（Phase 1）—— 规范常量 / 校验 / 回测执行
//   · 数据源：后端 /api/models/schema|validate|run
//   · 规范常量由服务端下发（单一源），前端表单不手抄白名单
//   · 类型自 shared/modelspec.mjs 引入，与后端校验器共用同一份定义
// ─────────────────────────────────────────────────────────────
import { apiGet, apiPost, apiDelete } from './client';
import type { ModelSpec, NormalizedModel, ValidationIssue } from '../../shared/modelspec.mjs';

export type { ModelSpec, NormalizedModel, ValidationIssue };

/** 预置模型骨架（模板库；规范单一源在 shared/modelspec.cjs → 服务端下发） */
export interface ModelTemplate {
  key: string;
  label: string;
  desc: string;
  tags: string[];
  model: ModelSpec;
}

/** 规范常量（由服务端下发，前端据此渲染表单） */
export interface ModelSchema {
  ok: boolean;
  schemaVersion: number;
  presets: string[];
  transforms: { type: string; args: Record<string, unknown> }[];
  filterFields: string[];
  filterOps: string[];
  rebalance: Record<string, number>;
  universes: string[];
  combineMethods: string[];
  limits: Record<string, number>;
  engineVersion: string;
  /** 每用户模型库上限 */
  quotaPerUser: number;
  /** 模板库（新手冷启动入口） */
  templates: ModelTemplate[];
  /** 当前环境是否支持执行回测（公网 false：仅可配置/校验/保存/导出） */
  canRun: boolean;
}

/** 模型回测结果（字段名以服务端实际返回为准，勿臆造） */
export interface ModelBacktestResult {
  engine: string;
  factor: string;
  factorKind: string;
  factorWindow: number;
  topN: number;
  rebalanceEvery: number;
  universeSize: number;
  capital: number;
  slippage: number;
  range: { start: string; end: string; bars: number };
  rebalances: number;
  fills: number;
  blockedLimitUp: number;
  blockedLimitDown: number;
  totalFees: number;
  turnover: number;
  feeRatePct: number;
  finalValue: number;
  totalReturn: number;
  annualized: number;
  maxDrawdownPct: number;
  sharpe: number;
  benchmarkReturn: number | null;
  benchmarkUniverse: number;
  benchmark: { date: string; value: number }[];
  equity: { date: string; value: number }[];
  ic: {
    series: { date: string; ic: number; n: number }[];
    n: number;
    icMean: number;
    icStd: number;
    icir: number;
    icPositiveRate: number;
    t: number;
    p: number;
    significant2?: boolean;
    degraded?: string | null;
    basis: string;
  };
}

/** 执行计划回显（可审计：声明的因子/预处理/过滤必须原样出现在这里） */
export interface ModelPlan {
  factors: { id: string; expr: string; weight: number; direction: number }[];
  transforms: { type: string; args: Record<string, unknown> }[];
  filters: Record<string, unknown>[];
  combine: string;
}

export interface ModelValidationResponse {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  model: NormalizedModel | null;
  /**
   * 语义核心哈希（模型**定义**身份；与 name / 数据窗口 / 回测参数无关）。
   * 公网不能执行回测时，用它生成「离线执行回执」——本地跑出的结果
   * 可凭同一哈希核对是同一个模型定义。校验不通过时为 null。
   */
  modelHash: string | null;
}

export type ModelRunResponse =
  | {
      ok: true;
      engineVersion: string;
      plan: ModelPlan;
      fingerprint: string;
      model: NormalizedModel;
      result: ModelBacktestResult;
    }
  | { ok: false; stage: 'validate' | 'build' | 'engine' | 'env'; error: string; issues?: ValidationIssue[] };

export interface ModelRunOptions {
  /** 持仓数（缺省 5，上限 20） */
  topN?: number;
  /** 初始资金（缺省 100 万） */
  capital?: number;
  /** 滑点（缺省 0.001，上限 0.05） */
  slippage?: number;
  startDate?: string;
  endDate?: string;
}

/** 模型库条目（列表用，仅元信息） */
export interface ModelLibraryItem {
  id: string;
  name: string;
  modelHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelLibraryResponse {
  ok: boolean;
  items: ModelLibraryItem[];
  /** 本人已存模型数 */
  count: number;
  /** 每用户上限 */
  quota: number;
}

export type ModelSaveResponse =
  | { ok: true; id: string; modelHash?: string }
  | { ok: false; error: string; issues?: ValidationIssue[] };

// ── 实验记录（第六刀：不可变留痕 + 对比）─────────────────────
//   与「我的模型库」的分工：模型库是**可变**的模型定义；实验是**不可变**的留痕。
/** 列表行（索引冗余字段，免解正文） */
export interface ModelExperimentRow {
  id: string;
  /** ISO 时间；同时是前端勾选的唯一键（shared/experiments.cjs 的 recKey = e.ts） */
  ts: string;
  modelName: string;
  fingerprint: string;
  totalReturn: number | null;
  /** 总收益 − 等权基准（对比时最直观的一列） */
  excessReturn: number | null;
  maxDrawdownPct: number | null;
  sharpe: number | null;
}

export interface ModelExperimentMetrics {
  totalReturn: number | null;
  annualized: number | null;
  maxDrawdownPct: number | null;
  sharpe: number | null;
  benchmarkReturn: number | null;
  excessReturn: number | null;
  rebalances: number | null;
  fills: number | null;
  totalFees: number | null;
  feeRatePct: number | null;
  icMean: number | null;
  icir: number | null;
  icPositiveRate: number | null;
  icN: number | null;
}

/** 完整实验记录（对比页与「载入该实验的模型」用） */
export interface ModelExperimentDoc {
  id: string;
  ts: string;
  modelId: string | null;
  modelName: string;
  modelHash: string | null;
  fingerprint: string;
  engineVersion: string;
  /**
   * **扁平**参数字典（人类可读摘要）。
   * ⚠️ 必须是扁平的：前端 paramKeyUnion/diffParams 只做一层 Object.keys，
   * 嵌套对象会让对比表静默变成一堆 undefined。
   */
  params: Record<string, string | number | boolean | undefined>;
  metrics: ModelExperimentMetrics;
  range: { start: string; end: string; bars: number } | null;
  universeSize: number | null;
  /** 模型快照（约 1KB）：实验是"复现承诺的载体"，只存指纹则拿不回当时那个模型 */
  modelSnapshot: ModelSpec | null;
  equityThumb?: { d: string; v: number }[];
  benchmarkThumb?: { d: string; v: number }[];
}

export interface ModelExperimentListResponse {
  ok: boolean;
  items: ModelExperimentRow[];
  count: number;
  quota: number;
  /** 对比上限（由 shared/experiments.cjs 单一源下发，前端不硬编码） */
  maxCompare: number;
}

export interface ModelExperimentCompareResponse {
  ok: boolean;
  items: ModelExperimentDoc[];
  maxCompare: number;
  requested: number;
}

export const modelsApi = {
  /** 规范常量（表单渲染用；服务端为单一源） */
  schema: () => apiGet<ModelSchema>('/models/schema'),

  // ── 模型库（per-uid 隔离；越权一律 404）──
  /** 列出本人模型 */
  list: (limit?: number) =>
    apiGet<ModelLibraryResponse>(`/models${limit ? `?limit=${encodeURIComponent(String(limit))}` : ''}`),
  /** 保存（不传 id 为新建；传 id 为覆盖，需本人所有） */
  save: (model: ModelSpec, id?: string) =>
    apiPost<ModelSaveResponse>('/models', id ? { model, id } : { model }),
  /** 读取本人模型 */
  get: (id: string) =>
    apiGet<{ ok: boolean; model: NormalizedModel & { id?: string; uid?: string }; error?: string }>(
      `/models/${encodeURIComponent(id)}`,
    ),
  /** 删除本人模型 */
  remove: (id: string) => apiDelete<{ ok: boolean; removed: boolean; error?: string }>(`/models/${encodeURIComponent(id)}`),
  /** 只校验不执行（表单实时反馈；权威结论仍以服务端为准） */
  validate: (model: ModelSpec) => apiPost<ModelValidationResponse>('/models/validate', model),
  /** 执行回测（本地版可用；公网返回 stage='env' 的 503 显式拒绝） */
  run: (model: ModelSpec, opts?: ModelRunOptions) =>
    apiPost<ModelRunResponse>('/models/run', opts ? { model, ...opts } : { model }),

  // ── 实验记录（不可变留痕；per-uid 隔离，越权一律 404）──
  experiments: {
    /** 本人实验列表（新在前） */
    list: (limit?: number) =>
      apiGet<ModelExperimentListResponse>(
        `/model-experiments${limit ? `?limit=${encodeURIComponent(String(limit))}` : ''}`,
      ),
    /** 一次取多条完整记录（前端直接喂 shared/experiments.mjs 的纯函数做对比） */
    compare: (ids: string[]) => apiPost<ModelExperimentCompareResponse>('/model-experiments/compare', { ids }),
    get: (id: string) =>
      apiGet<{ ok: boolean; experiment: ModelExperimentDoc; error?: string }>(
        `/model-experiments/${encodeURIComponent(id)}`,
      ),
    remove: (id: string) =>
      apiDelete<{ ok: boolean; removed: boolean; error?: string }>(`/model-experiments/${encodeURIComponent(id)}`),
  },
};
