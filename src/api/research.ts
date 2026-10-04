// ─────────────────────────────────────────────────────────────
// 研究工作台 域（自 src/api/dataService.ts 原样迁出 · 行为零变化）
// ─────────────────────────────────────────────────────────────
import { apiGet, apiPost } from './client';
import type { PaperAccount } from './paper';

/** 15. 研究工作台（横截面回测 / 实验历史 / 一致性报告 / 对账 / 熔断解锁） */
export interface CrossBacktestResult {
  engine: string;
  factor: string;
  /** 'preset' = 预置因子；'expr' = 自定义表达式（M3）。历史响应可能无此字段 */
  factorKind?: 'preset' | 'expr';
  /** 表达式元数据（仅 factorKind==='expr' 时有值）：算子列表、最长窗口、推断方向 */
  factorExprMeta?: { ops: string[]; maxWindow: number; direction: string | null } | null;
  factorWindow: number;
  topN: number;
  rebalanceEvery: number;
  universeSize: number;
  capital: number;
  slippage: number;
  range: { start: string; end: string; bars: number };
  rebalances: number;
  fills: number;
  totalFees: number;
  turnover: number;
  feeRatePct: number;
  finalValue: number;
  totalReturn: number;
  annualized: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  equity: { date: string; value: number }[];
  benchmarkReturn?: number | null;
  benchmarkUniverse?: string | null;
  benchmark?: { date: string; value: number }[] | null;
  /**
   * IC（Rank IC / Spearman）序列与显著性摘要（M2.2）。
   * ⚠️ `degraded: true` 表示「**不可检验**」而非「不显著」——常见于 IC 序列方差为 0
   *    （t 统计量分母为 0，无定义）或期数不足。此时 t/p 为 null，UI **必须显式说明原因**，
   *    不能让用户把「算不出来」误读成「因子无效」。
   * ⚠️ `se` 为 Newey-West (HAC) 标准误、`seIid` 为独立同分布假设下的标准误。
   *    两者差异即自相关对显著性的影响幅度，同屏展示更有信息量。
   */
  ic?: {
    series: { date: string; ic: number; n: number }[];
    n: number;
    icMean: number | null;
    icStd: number | null;
    icir: number | null;
    icPositiveRate: number | null;
    t: number | null;
    p: number | null;
    se: number | null;
    seIid: number | null;
    neweyWestLag: number;
    significant2: boolean;
    significant3: boolean;
    degraded?: boolean;
    degradeReason?: string;
    factor?: string;
    factorWindow?: number;
    basis?: string;
  };
  error?: string;
}

export interface ExperimentRecord {
  ts: string;
  symbol: string;
  strategy: string;
  params: Record<string, number | string | null>;
  range: { start: string; end: string; bars: number } | null;
  metrics: {
    sortino?: number | null;
    calmar?: number | null;
    benchmarkReturn?: number | null;
    blockedLimitUp?: number | null;
    blockedLimitDown?: number | null;
    [k: string]: number | null | undefined;
  };
  note: string;
  rawSymbol?: string;
  equityThumb?: { d: string; v: number }[];
}

export interface ConsistencyEntry {
  strategyId: string;
  uid: string;
  type: string;
  symbol: string;
  status: string;
  paper: { closedTrades: number; openBuys: number; realized: number; pricePnl: number; costs: number; feeSum: number; turnover: number; feeRatePct: number; winRate: number | null };
  paperReturnPct: number | null;
  backtest: { strategy?: string; totalReturn?: number; tradeCount?: number; feeRatePct?: number; totalFees?: number; skipped?: string; error?: string };
  deltas: { returnDiffPct: number; tradeCountDiff: number; feeRateDiffPct: number } | null;
  decay: string | null;
  costAttribution: { grossPricePnl: number; costs: number; netRealized: number; note: string };
  prior90: { closedTrades: number; realized: number; winRate: number | null };
}

// ── 因子稳健性评估（S3）──
//   用途：判定因子是否稳健。单看全区间收益会被**路径依赖**放大
//   （实测 rev60 全区间超额 +253pp，逐年 6 正 5 负、平均仅 -0.82pp）。
export type FactorVerdict = '稳健' | '边缘' | '不稳定';

export interface FactorEvalYearRow {
  year: number;
  strategy?: number;
  benchmark?: number;
  excess?: number;
  rebalances?: number;
  error?: string;
}

export interface FactorEvalStability {
  posYears: number;
  totalYears: number;
  posRatio: number;
  avgExcess: number;
  stdExcess: number;
  verdict: FactorVerdict;
}

export interface FactorEvalItem {
  factor: string;
  full:
    | { error: string }
    | {
        range: { start: string; end: string; bars: number };
        totalReturn: number;
        benchmarkReturn: number;
        excess: number;
        maxDrawdownPct: number;
        sharpe: number | null;
        rebalances: number;
      };
  byYear: FactorEvalYearRow[];
  stability: FactorEvalStability;
}

export interface FactorEvalResult {
  ok: boolean;
  params: { topN: number; rebalanceEvery: number; capital: number; yearFrom: number; yearTo: number };
  years: number[];
  availableFactors: string[];
  invalidFactors: string[];
  factors: FactorEvalItem[];
  disclaimer: string;
}

/**
 * 分层回测结果（M2.1 / 服务端 `crosssect.cjs: layerAnalysis`）。
 *
 * ⚠️ **口径：不计手续费与滑点**——本接口度量因子的原始预测力，成本影响体现在
 *    crossBacktest 的净值里。两者口径有意分离，**不是可直接比较的收益**。
 * ⚠️ **层号语义固定「layer 1 = 因子值最高」**（与因子方向无关）。因此 mom* 期望
 *    `spearman < 0`（强层跑赢），rev* 期望 `spearman > 0`。**判定有效性请看
 *    `mono.strategyAligned`（已按 mom/rev 分判），不要只看 ρ 的符号。**
 */
export interface LayerAnalysisResult {
  engine?: string;
  factor?: string;
  factorWindow?: number;
  /** 'preset' | 'expr'（M3） */
  factorKind?: 'preset' | 'expr';
  /**
   * 表达式**方向是否不定**（M3）。true 时 `mono.strategyAligned` 为 null——
   *   如 `mom60 - mom20` 混合了动量语义，无法判定"是否与策略方向一致"。
   * ⚠️ UI **必须**区分「null = 不可判」与「false = 判定为相反」，不可都显示成"不一致"。
   */
  directionUncertain?: boolean;
  /** 表达式元数据（仅 expr 时有值） */
  exprMeta?: { ops: string[]; maxWindow: number; direction: string | null } | null;
  /** 该因子是否属反转族（决定 mono.strategyAligned 的判定方向） */
  isReversal?: boolean;
  /**
   * ⚠️ 后端在响应里**同时**用 `layers` 承载两个不同语义的字段：
   *    `layers: number`（请求的层数）与 `layers: [...]`（逐层结果）——
   *    JS 对象字面量后写的键会覆盖前者，实测响应中 `layers` **是数组**。
   * 为消除歧义，此处对数组用 `layers`，对层数用 `layerCount`；
   * 读取层数请用 `layers?.length`，**不要**读 `layerCount`（后端不返回此键）。
   * 之所以保留 `layerCount` 仅为文档说明，实际值恒为 undefined。
   */
  layers?: Array<{
    layer: number;
    label: string;
    totalReturnPct: number;
    annualizedPct: number;
    meanPeriodRetPct: number;
    stdPeriodRetPct: number;
    periods: number;
  }>;
  layerCount?: number;
  rebalanceEvery?: number;
  range?: { start: string; end: string; bars: number; periods: number };
  universeSize?: number;
  /** 口径声明原样透传，供 UI 展示（防止前端自行编造口径） */
  layerBasis?: string;
  note?: string;
  mono?: {
    /** 层号 × 层期均收益 的 Spearman。完全单调时 |ρ| = 1。不可计算时为 null */
    spearman: number | null;
    monotonic: boolean;
    threshold: number;
    /** 纯因子层面的描述（与策略无关），如「因子值越高、下期收益越低」 */
    factorDirection: string | null;
    /**
     * 因子方向与**当前策略方向**是否一致（已按 mom/rev 分判）。
     * true = 一致（有利）；false = 相反（按此选股会系统性亏损）；
     * **null = 方向不定不可判**（如 mom60 - mom20），此时不得显示成"相反"。
     */
    strategyAligned: boolean | null;
    strategyNote: string | null;
    /** 第 1 层 − 第 N 层 的期均收益差（pp）。注意这是**期均**而非累计收益差 */
    longShortSpreadPct: number;
    interpretation: string;
  };
  error?: string;
}

export const researchApi = {
  crossBacktest: (p: {
    factor: string;
    topN: number;
    rebalanceEvery: number;
    capital: number;
    slippage?: number;
    /** 区间裁剪（样本外验证用；仅截断交易日轴，因子窗口仍读前置历史） */
    startDate?: string;
    endDate?: string;
  }) => {
    const q = new URLSearchParams({
      factor: p.factor,
      topN: String(p.topN),
      rebalanceEvery: String(p.rebalanceEvery),
      capital: String(p.capital),
      slippage: String(p.slippage ?? 0.001),
    });
    if (p.startDate) q.set('startDate', p.startDate);
    if (p.endDate) q.set('endDate', p.endDate);
    return apiGet<CrossBacktestResult>(`/crossbacktest?${q.toString()}`);
  },
  /**
   * 分层回测（M2.1）：判定因子有效性是否贯穿全截面。
   * ⚠️ 口径：**不计手续费与滑点**（度量因子原始预测力），勿与本接口的净值直接比较。
   */
  factorLayers: (p: { factor: string; layers?: number; rebalanceEvery?: number; startDate?: string; endDate?: string }) => {
    const q = new URLSearchParams({
      factor: p.factor,
      layers: String(p.layers ?? 5),
      rebalanceEvery: String(p.rebalanceEvery ?? 20),
    });
    if (p.startDate) q.set('startDate', p.startDate);
    if (p.endDate) q.set('endDate', p.endDate);
    return apiGet<LayerAnalysisResult>(`/factor-layers?${q.toString()}`);
  },
  /** 因子稳健性评估（全区间 + 逐年）。⚠️ 服务端计算约 8s，调用方必须有 loading 态 */
  factorEval: (
    p: { factors?: string[]; topN?: number; rebalanceEvery?: number; capital?: number; yearFrom?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (p.factors?.length) q.set('factors', p.factors.join(','));
    if (p.topN) q.set('topN', String(p.topN));
    if (p.rebalanceEvery) q.set('rebalanceEvery', String(p.rebalanceEvery));
    if (p.capital) q.set('capital', String(p.capital));
    if (p.yearFrom) q.set('yearFrom', String(p.yearFrom));
    const qs = q.toString();
    return apiGet<FactorEvalResult>(`/factor-eval${qs ? `?${qs}` : ''}`);
  },
  experiments: (limit = 50, symbol?: string, strategy?: string) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (symbol) q.set('symbol', symbol);
    if (strategy) q.set('strategy', strategy);
    return apiGet<{ ok: boolean; experiments: ExperimentRecord[] }>(`/experiments?${q.toString()}`);
  },
  consistency: (windowDays = 30) =>
    apiGet<{ generatedAt: string; windowDays: number; strategyCount: number; decayCount: number; strategies: ConsistencyEntry[] }>(
      `/paper/consistency?windowDays=${windowDays}`,
    ),
  reconcile: () => apiGet<{ ok: boolean; checkedAt: string; uid: string; issues: string[] }>('/paper/reconcile'),
  unlock: () => apiPost<{ ok: boolean; message?: string; peakAssets?: number; error?: string }>('/paper/unlock', {}),
  /** 熔断状态复用账户快照 */
  paperAccount: () => apiGet<PaperAccount>('/paper/account'),
};

// ── Agent 研究（P3-P4：Alpha 角色 + 工具循环）──
