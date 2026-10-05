// 研究包（research bundle）类型声明（与 shared/research-bundle.cjs 一一对应）

export const BUNDLE_VERSION: number;
export const KIND: string;

export interface BaselineMetrics {
  range: { start: string; end: string; bars: number } | null;
  universeSize: number | null;
  benchmarkUniverse: number | null;
  topN: number | null;
  rebalanceEvery: number | null;
  capital: number | null;
  slippage: number | null;
  rebalances: number | null;
  fills: number | null;
  totalReturn: number | null;
  annualized: number | null;
  maxDrawdownPct: number | null;
  sharpe: number | null;
  benchmarkReturn: number | null;
  /** 总收益 − 等权基准（百分点）；任一缺失时为 null */
  excessReturn: number | null;
  totalFees: number | null;
  feeRatePct: number | null;
  blockedLimitUp: number | null;
  blockedLimitDown: number | null;
  icMean: number | null;
  icir: number | null;
  icPositiveRate: number | null;
  icN: number | null;
  icP: number | null;
  priceBasis: Record<string, unknown> | null;
}

export interface ResearchBundle {
  kind: string;
  bundleVersion: number;
  exportedAt: string;
  origin?: string;
  engineVersion: string | null;
  identity: {
    modelHash: string | null;
    fingerprint: string | null;
    validationFingerprint: string | null;
    name: string;
    factorCount: number;
  };
  /** 原始 Model JSON（可原样导回）；回测参数**不在**这里 */
  model: unknown;
  runOptions: {
    topN: number | string | null;
    capital: number | string | null;
    slippage: number | string | null;
    startDate: string | null;
    endDate: string | null;
  };
  baseline: { present: boolean; plan: unknown; metrics: BaselineMetrics | null };
  validation: { present: boolean; [k: string]: unknown };
  experiments: { present: boolean; count: number; items: unknown[] };
  provenance: {
    reproduce: string;
    identityNote: string;
    bundleScope: string;
    /** 最容易误读的一句：pass 只是"没报警"，不是"有效" */
    verdictCaveat: string;
    /** 验证套件**不覆盖**的面（覆盖边界，非模型缺点）；报告里只在验证一节渲染一次 */
    notCovered: string[];
    limitations: string[];
  };
  /** 缺什么、为什么缺 —— 显式列出，避免"没写=没这项=没问题"的误读 */
  missing: string[];
}

export interface BuildBundleInput {
  model?: unknown;
  modelHash?: string | null;
  runOpts?: Record<string, unknown>;
  run?: unknown;
  validation?: unknown;
  experiments?: unknown[];
  limitations?: string[];
  exportedAt?: string;
  origin?: string | null;
}

export function buildResearchBundle(input?: BuildBundleInput): ResearchBundle;
export function renderResearchReport(bundle: ResearchBundle): string;
