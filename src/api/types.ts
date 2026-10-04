// ─────────────────────────────────────────────────────────────
// API 共享数据结构（跨域复用）
//   · 统一对外的前端数据结构（Unified*）与后端原始响应结构（Backend*）分开。
//   · 本模块只放**被两个以上域模块引用**的类型；单域专属类型留在各自域文件。
// ─────────────────────────────────────────────────────────────

/** 统一报价 */
export interface UnifiedQuote {
  symbol: string;
  name?: string;
  price: number;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  prevClose: number | null;
  timestamp: number;
  _source: 'backend';
  /** A 股五档盘口（腾讯源提供；美股/港股为 null） */
  bids?: { price: number; qty: number }[] | null;
  asks?: { price: number; qty: number }[] | null;
  quoteTime?: string | null;
}

/** 统一 K 线 */
export interface UnifiedKline {
  time: number;
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  _source?: 'backend';
}

/** 后端报价响应 */
export interface BackendQuote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  changePercent: number;
  bids?: { price: number; qty: number }[] | null;
  asks?: { price: number; qty: number }[] | null;
  quoteTime?: string | null;
}

/** 后端 K 线响应 */
export interface BackendHistory {
  symbol: string;
  frequency: string;
  /** 实际复权口径：主源失败回退新浪（不复权）时后端标注 'none(备用源)'，前端必须透传展示 */
  adjust?: string;
  klines: { date: string; open: number | null; close: number | null; high: number | null; low: number | null; volume: number | null }[];
}
