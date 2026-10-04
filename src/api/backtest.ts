// ─────────────────────────────────────────────────────────────
// 回测 域（自 src/api/dataService.ts 原样迁出 · 行为零变化）
// ─────────────────────────────────────────────────────────────
import { apiGet } from './client';

export interface BacktestTrade {
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  pnlPct: number;
  holdDays: number;
  forced?: boolean;
}

/** 回测结果 */
export interface BacktestResult {
  symbol: string;
  strategy: string;
  params: { fast: number; slow: number; capital: number };
  range: { start: string; end: string; bars: number };
  finalValue: number;
  totalReturn: number;
  annualized: number;
  maxDrawdownPct: number;
  maxDrawdown: number;
  tradeCount: number;
  winRate: number;
  annualVol?: number;
  sharpe?: number | null;
  sortino?: number | null;
  calmar?: number | null;
  profitFactor?: number | null;
  avgWinPct: number;
  avgLossPct: number;
  benchmarkReturn: number;
  /** 沪深300 指数基准（仅 A 股标的返回） */
  benchmark300?: { date: string; value: number }[];
  benchmark300Return?: number;
  trades: BacktestTrade[];
  equity: { date: string; value: number }[];
  benchmark: { date: string; value: number }[];
  error?: string;
}

/** 5e. 策略回测（后端回测引擎） */
export const runBacktest = async (params: {
  symbol: string;
  strategy?: 'ma' | 'rsi' | 'buyhold';
  fast?: number;
  slow?: number;
  capital?: number;
  count?: number;
  slippage?: number;
}): Promise<BacktestResult> => {
  const qs = new URLSearchParams();
  qs.set('symbol', params.symbol);
  qs.set('strategy', params.strategy || 'ma');
  if (params.fast) qs.set('fast', String(params.fast));
  if (params.slow) qs.set('slow', String(params.slow));
  if (params.capital) qs.set('capital', String(params.capital));
  if (params.count) qs.set('count', String(params.count));
  if (typeof params.slippage === 'number') qs.set('slippage', String(params.slippage));
  return apiGet<BacktestResult>(`/backtest?${qs.toString()}`);
};
