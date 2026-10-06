// ─────────────────────────────────────────────────────────────
// 数据治理域（Phase 2）—— 归档版本索引与数据质量体检
//   · 数据源：后端 GET /api/data/quality（只读；本地版真算，公网显式返回不可用）
//   · 这是"**这次结论是拿哪一版数据算的**"的唯一入口：
//     模型实验的 fingerprint 只含数据**窗口**，本接口给出归档**内容**指纹（dataVersion）。
// ─────────────────────────────────────────────────────────────
import { apiGet } from './client';

/** 数据版本（内容指纹 + 规模概览） */
export interface ArchiveVersion {
  /** 归档内容摘要 sha256（与 fingerprint 一起构成完整复现凭据） */
  digest: string;
  stocks: number;
  rows: number;
  firstDate: string | null;
  lastDate: string | null;
  /** 达到入池门槛（poolMinRows 行）的标的数 */
  poolStocks: number;
  poolMinRows: number;
}

/** 单只标的的体检明细（不含内容摘要，避免响应体膨胀） */
export interface ArchiveSymbolRow {
  code: string;
  file: string;
  /** 归档原始行数 */
  rows: number;
  /** 通过引擎同源可用性过滤后的行数 */
  rowsUsable: number;
  rowsDropped: number;
  firstDate: string | null;
  lastDate: string | null;
  factorsCount: number;
  /** 无复权因子覆盖而退化为不复权口径的行数 */
  adjFallbackRows: number;
  /** 逐字段缺失行数（只列非零字段） */
  missing: Record<string, number>;
  badPriceRows: number;
  duplicateDates: number;
  inPool: boolean;
}

/** 归档体检汇总 */
export interface ArchiveQuality {
  filesRead: number;
  filesBad: number;
  badFiles: { file: string; error: string }[];
  rowsTotal: number;
  rowsUsable: number;
  rowsDropped: number;
  /** 逐字段总缺失行数 */
  missingTotals: Record<string, number>;
  /** 有该字段缺失的标的数（与 missingTotals 配对看，可判断影响面） */
  symbolsWithMissing: Record<string, number>;
  adjFallbackRows: number;
  symbolsWithAdjFallback: number;
  badPriceRows: number;
  duplicateDates: number;
  /** 可用行数低于入池门槛的标的数 */
  belowPoolMinRows: number;
  /** 可用行数分桶（<80 / 80-249 / 250-999 / 1000-1999 / >=2000） */
  coverageBuckets: Record<string, number>;
  /** 归档最后交易日距计算时刻的自然日数（周末/假期会自然偏大） */
  lastDateAgeDays: number | null;
  lastDateAgeNote: string;
}

/** 数据质量报告（ok=false 时只有 error/reason/issues，无 version/quality/symbols） */
export interface DataQualityReport {
  ok: boolean;
  error?: string;
  /** 公网等环境的边界说明（说明"为什么不可用"，而非"数据坏了"） */
  reason?: string;
  /** 内容摘要算法自述（事后核对"这串指纹怎么来的"） */
  algorithm?: string;
  source?: 'env-override' | 'default';
  env?: 'local' | 'serverless';
  version?: ArchiveVersion;
  quality?: ArchiveQuality;
  symbols?: ArchiveSymbolRow[];
  /** 数据层面的已知问题清单（单一源在服务端 archiveindex.DATA_ISSUES） */
  issues?: string[];
  computedAt?: string;
  cached?: boolean;
}

/** 单条守卫的命中记录（file 为相对路径） */
export interface SingleSourceViolation {
  file: string;
  line: number;
  text: string;
}

export interface SingleSourceCheckResult {
  id: string;
  label: string;
  /** 唯一权威文件（相对仓库根） */
  source: string;
  note: string;
  ok: boolean;
  issues: string[];
  exports: { name: string; found: boolean }[];
  guards: { pattern: string; reason: string; allow: string[]; violations: SingleSourceViolation[] }[];
}

/** 口径单一源清单 + 治理校验报告 */
export interface SingleSourceReport {
  ok: boolean;
  total: number;
  passed: number;
  scannedFiles: number;
  entries: SingleSourceCheckResult[];
  note: string;
  cached?: boolean;
  checkedAt?: string;
  error?: string;
}

export const dataApi = {
  /**
   * 归档版本索引 + 数据质量体检。
   * @param refresh 强制重算（默认走服务端缓存：目录 mtime/size 签名 + 10 分钟 TTL）
   */
  quality: (refresh = false) => apiGet<DataQualityReport>(`/data/quality${refresh ? '?refresh=1' : ''}`),
  /** 口径单一源清单 + 治理校验（扫源码，不依赖归档 ⇒ 公网也可用） */
  sources: (refresh = false) => apiGet<SingleSourceReport>(`/data/sources${refresh ? '?refresh=1' : ''}`),
};
