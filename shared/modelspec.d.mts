// Model JSON v1 类型声明（与 shared/modelspec.mjs 一一对应）

export const SCHEMA_VERSION: 1;
export const PRESET_FACTORS: readonly string[];
/** 反转预置名（值越大越不看好）；与 server/crosssect.cjs 的 REVERSAL_FACTORS 有等价锁 */
export const REVERSAL_PRESETS: readonly string[];
/** 因子名的默认方向：反转预置 -1，其余 1（direction 缺省时由规范化器使用） */
export function defaultDirection(expr: string): 1 | -1;
export const TRANSFORM_TYPES: Record<string, { args: Record<string, readonly string[] | { type: 'number'; min: number; max: number }> }>;
export const FILTER_FIELDS: readonly string[];
export const FILTER_OPS: readonly string[];
export const REBALANCE_BARS: { daily: number; weekly: number; monthly: number };
export const UNIVERSES: readonly string[];
export const COMBINE_METHODS: readonly string[];
export const LIMITS: {
  maxFactors: number;
  maxTransforms: number;
  maxFilters: number;
  maxTags: number;
  maxNameLen: number;
  maxHypothesisLen: number;
  maxWeight: number;
  minGroups: number;
  maxGroups: number;
  maxIdLen: number;
};

export interface ModelFactor {
  id?: string;
  /** 预置因子名（mom20…）或白名单 AST 表达式（如 `mom60 - mom20`） */
  expr: string;
  /** 组合权重（默认 1；0 非法） */
  weight?: number;
  /** 方向：1 原向 / -1 反向（默认 1） */
  direction?: 1 | -1;
}

export interface ModelTransform {
  type: 'winsorize' | 'zscore' | 'rank' | 'fill_missing';
  args?: Record<string, unknown>;
}

export interface ModelFilter {
  /** v1 仅 field_range（expr_predicate 为保留能力，v1 显式拒绝） */
  type: 'field_range';
  field: string;
  min?: number;
  max?: number;
  value?: number;
  op?: '>' | '>=' | '<' | '<=';
}

export interface ModelSpec {
  schemaVersion: 1;
  name: string;
  hypothesis?: string;
  factors: ModelFactor[];
  transforms?: ModelTransform[];
  combine?: { method: 'weighted_sum' };
  filters?: ModelFilter[];
  universe?: { type: 'core_pool' };
  backtest?: { rebalance?: 'daily' | 'weekly' | 'monthly'; groups?: number; fees?: boolean };
  meta: { author: string; tags?: string[] };
}

/** 归一化后的模型：默认值已填充、字段已收敛（用于回测执行与版本快照） */
export interface NormalizedModel {
  schemaVersion: 1;
  name: string;
  hypothesis?: string;
  factors: { id: string; expr: string; weight: number; direction: 1 | -1 }[];
  transforms: { type: string; args: Record<string, unknown> }[];
  combine: { method: string };
  filters: ModelFilter[];
  universe: { type: string };
  backtest: { rebalance: string; groups: number; fees: boolean };
  meta: { author: string; tags: string[] };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface NormalizeResult {
  ok: boolean;
  model: NormalizedModel | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateOptions {
  /** 表达式解析器（服务端注入 factorexpr.parseExpression；前端缺省=仅字符级校验） */
  parseExpr?: (src: string) => { ok: boolean; error?: string };
  /** 预置因子清单（缺省用本模块 PRESET_FACTORS） */
  presets?: string[];
}

export function validateModel(input: unknown, opts?: ValidateOptions): ValidationResult;
export function normalizeModel(input: unknown, opts?: ValidateOptions): NormalizeResult;
export function rebalanceBars(period: string): number;
export function canonicalJSON(model: unknown): string;
