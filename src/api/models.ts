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
  /**
   * 验证套件的阈值与已知局限（单一源在 server/validation.cjs → 服务端下发）。
   * 界面直接渲染，不再各抄一份；阈值改了界面自动跟随。
   */
  validation: ValidationSpec | null;
}

/** 验证套件规范（阈值 + 强制披露的已知局限） */
export interface ValidationSpec {
  rules: Record<string, number>;
  limitations: string[];
  /** 验证同样需要重跑回测 ⇒ 与 canRun 同门禁 */
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

// ── 独立验证套件（Phase 2：walk-forward + 参数平原 + 强制披露）────────
//   🔴 独立性：验证**只读**模型与产物，不回写模型、不落库、不留实验痕。
//   ⚠️ 字段名以服务端实际返回为准（server/validation.cjs），勿臆造。

/** 样本外滚动的一折（逐折**独立**重跑，不共享仓位与费用） */
export interface WalkForwardFold {
  fold: number;
  startDate: string;
  endDate: string;
  actualRange: { start: string; end: string; bars: number };
  bars: number;
  totalReturn: number;
  maxDrawdownPct: number;
  sharpe: number;
  benchmarkReturn: number | null;
  /** 总收益 − 基准（百分点） */
  excessReturn: number | null;
  icMean: number | null;
  icN: number;
  rebalances: number;
}

export interface WalkForwardResult {
  ok: true;
  folds: WalkForwardFold[];
  /** 因样本不足未能评估的折（**显式**列出，不是静默跳过） */
  skipped: { fold: number; startDate: string; endDate: string; reason: string }[];
  overall: { totalReturn: number; maxDrawdownPct: number; sharpe: number };
  dispersion: { mean: number; min: number; max: number; spread: number };
  verdict: 'stable' | 'unstable';
  flags: string[];
  rules: Record<string, number>;
  backtests: number;
  note: string;
}
export type WalkForwardResponse =
  | WalkForwardResult
  | { ok: false; stage?: string; error: string; issues?: ValidationIssue[] | null; backtests?: number };

/** 参数平原扫描的一个网格点 */
export interface PlateauPoint {
  value: number;
  /** 该点所保留的比例（最接近基准的那个；被合并的比例见 mergedRatios） */
  ratio: number;
  /** 合并到该点的全部比例（取整后重复的已合并，如实记录不假装扫过） */
  mergedRatios: number[];
  ok: boolean;
  reason?: string;
  totalReturn?: number;
  maxDrawdownPct?: number;
  sharpe?: number;
  icMean?: number | null;
  icN?: number;
  /** 相对基准点的收益变化（百分点）；基准点为 0 */
  deltaPct?: number | null;
  /** 相对基准点的跌幅（正数=变差，百分比） */
  dropPct?: number | null;
}

export interface PlateauResult {
  ok: true;
  param: 'topN' | 'weight';
  baseValue: number;
  points: PlateauPoint[];
  distinctPoints: number;
  requestedRatios: number;
  mergedPoints: { value: number; keptRatio: number; mergedRatios: number[] }[];
  /**
   * 真实覆盖范围（请求 vs 实际可达）。
   * ⚠️ 参数取整会让部分比例合并到同一取值 ⇒ 实际覆盖可能窄于 ±30%；
   *   判定以**实际可达的极值点**为准，故这里必须显式给出，不能只声称"扫了 ±30%"。
   */
  coverage: { requested: [number, number]; actual: [number | null, number | null] };
  verdict: 'spike' | 'plateau';
  flags: string[];
  rules: Record<string, number>;
  backtests: number;
  note: string;
}
export type PlateauResponse =
  | PlateauResult
  | { ok: false; error: string; points?: PlateauPoint[]; rules?: Record<string, number> };

/** 样本量与功效披露（§5.3 强制：结论必须自带"有多少样本"） */
export interface ValidationPower {
  icPeriods: number;
  rebalances: number;
  sufficient: boolean;
  note: string;
}

/** 因果性检验的一个截断点（截断段必须是全集的前缀，逐点比对） */
export interface CausalityCut {
  cut: string;
  /** 逐日点数（已剥离期末强平追加点） */
  dailyBars: number;
  terminalPointStripped: boolean;
  /** 实际比对的数据点数 */
  compared: number;
  totalReturn: number;
  actualRange: { start: string; end: string; bars: number };
  /** 该截断下的 as-of 池子规模 */
  universeSize: number;
  /** 池子是否与全集不同（不同则该点结论不可归因于泄露） */
  universeShift: boolean;
  /** 首个不一致点；null = 该截断段与全集逐点一致 */
  mismatch: {
    index: number;
    date: string;
    fullDate?: string;
    segValue?: number;
    fullValue?: number;
    reason: string;
  } | null;
}

export interface CausalityResult {
  ok: true;
  fullRange: { start: string; end: string; bars: number };
  fullPoints: number;
  fullDailyPoints: number;
  terminalPointStripped: boolean;
  fullUniverseSize: number;
  /**
   * 核心池的 as-of 事实：池子按**全期**行数选定 ⇒ `stableFrom` 之前，as-of 池子只是全集池的真子集
   * （事后选池带来的轻微 as-of 偏差）。默认截断点一律取在 `stableFrom` 之后，判读才可能确定。
   */
  pool: { stableFrom: string | null; stocks: number; cutSelection: 'explicit' | 'after-pool-stable' };
  /** 归档截断概况（证明数据真的被改写，而不是只传了 endDate） */
  archiveTruncation: { cuts: number; kept: number; emptied: number; rowsKept: number };
  cuts: CausalityCut[];
  skipped: { cut: string; reason: string }[];
  /**
   * `causal` = 全部截断段与全集逐点一致。
   * `inconclusive` = 历史段不同，但同时股票池也变了（分不清是泄露还是池子缩水）。
   * `leak` = 池子一致却路径不同 ⇒ 用 t 之前的数据得到的结论被 t 之后的数据改变。
   * ⚠️ 只覆盖**数据截断型**泄露；日内信息泄露（用当日收盘决定并当日成交）
   *    需 tick/时间戳数据，日线归档检不出。
   */
  verdict: 'causal' | 'inconclusive' | 'leak';
  flags: string[];
  rules: Record<string, number>;
  backtests: number;
  note: string;
}
export type CausalityResponse =
  | CausalityResult
  | { ok: false; stage?: string; error: string; issues?: ValidationIssue[] | null; skipped?: { cut: string; reason: string }[]; rules?: Record<string, number>; backtests?: number };

export interface ValidationReport {
  ok: boolean;
  engineVersion: string;
  generatedAt: string;
  fingerprint: string | null;
  model: { name: string; factors: number };
  sample: {
    range: { start: string; end: string; bars: number };
    bars: number;
    universeSize: number;
    benchmarkUniverse: number;
    rebalances: number;
    equityPointsReturned: number;
  } | null;
  power: ValidationPower | null;
  checks: { walkForward?: WalkForwardResponse; plateau?: PlateauResponse; causality?: CausalityResponse };
  verdict: { pass: boolean | null; flags: string[] };
  /** 本次验证实际执行了多少次回测（界面据此提示耗时/复核"是否真跑过"） */
  cost: { backtests: number };
  rules: Record<string, number>;
  /** 强制披露纪律：任何结论都必须自带已知局限 */
  limitations: string[];
  /** 仅当基准回测就失败时出现 */
  error?: { stage: string; message: string; issues: ValidationIssue[] | null };
}

export interface ValidateSuiteOptions extends ModelRunOptions {
  /** 样本外折数（2~8，缺省 3） */
  folds?: number;
  /** 平原扫描的参数（缺省 topN） */
  param?: 'topN' | 'weight';
  /** 因果性检验的截断点数（1~6，缺省 3）或指定的截断日期数组 */
  cuts?: number | string[];
  /** 显式跳过某项检查（'walkForward' | 'plateau' | 'causality'） */
  skip?: string[];
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
  /**
   * 独立验证套件（walk-forward + 参数平原 + 样本量/功效披露）。
   * ⚠️ 默认一次跑 9 回测（1 基准 + 3 折 + 5 参数点），响应的 cost.backtests 即实跑次数。
   * 公网 503 显式拒绝（需本地数据归档）。
   */
  validateSuite: (model: ModelSpec, opts?: ValidateSuiteOptions) =>
    apiPost<ValidationReport>('/models/validate-suite', opts ? { model, ...opts } : { model }),

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
