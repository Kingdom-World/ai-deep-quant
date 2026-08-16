// ─────────────────────────────────────────────────────────────
// 统一格式化工具（全项目数值显示唯一入口）
// ─────────────────────────────────────────────────────────────

export type Currency = 'CNY' | 'HKD' | 'USD';

/** 货币符号映射 */
export const CURRENCY_SYMBOL: Record<Currency, string> = {
  CNY: '¥',
  HKD: 'HK$',
  USD: '$',
};

/** 市场 → 货币 */
export const marketToCurrency = (market: 'US' | 'CN' | 'HK'): Currency =>
  market === 'US' ? 'USD' : market === 'HK' ? 'HKD' : 'CNY';

/** 涨跌幅格式化：保留两位小数，带符号（+2.35% / -0.17%） */
export const formatPercent = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

/** 价格格式化：保留两位小数，带货币符号 */
export const formatPrice = (value: number | null | undefined, currency: Currency): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${CURRENCY_SYMBOL[currency]}${value.toFixed(2)}`;
};

/** 价格格式化（不带头，仅两位小数） */
export const formatNumber = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toFixed(2);
};

/** 整数/大数格式化（千分位） */
export const formatInt = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return Math.round(value).toLocaleString('en-US');
};

/** 时间戳 → 本地时间字符串 */
export const formatTime = (ts: number | null | undefined): string => {
  if (!ts) return '--';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
};

/** 日期字符串 → YYYY-MM-DD（保留） */
export const formatDate = (date: string | null | undefined): string => date || '--';
