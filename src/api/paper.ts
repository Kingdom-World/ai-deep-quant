// ─────────────────────────────────────────────────────────────
// 模拟交易域（Paper Trading）—— 账户 / 下单 / 撤单 / 策略 / 日志 / 价格告警
//   · 数据源：后端 /api/paper/*（server/paper/*）
//   · 行为零变化：自 src/api/dataService.ts 原样迁出
// ─────────────────────────────────────────────────────────────
import { apiGet, apiPost, apiDelete } from './client';

export interface PaperPosition {
  symbol: string;
  name?: string;
  market: string;
  qty: number;
  avgCost: number;
  lastPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  /** A股 T+1：当前可卖出数量（= qty - 当日买入锁定数） */
  sellableQty?: number;
  /** A股 T+1：今日买入、当日不可卖的数量 */
  t1Locked?: number;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  name?: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  qty: number;
  limitPrice: number | null;
  status: 'pending' | 'resting' | 'filled' | 'canceled' | 'rejected';
  /** GFD 当日有效：YYYY-MM-DD（限价挂单挂出时设置，到期由撮合自动撤销） */
  validUntil?: string;
  /** 委托估算价（下单瞬间的行情价） */
  estimatePrice?: number | null;
  /** 策略归因标记（策略引擎下单时传入，人工下单为空串） */
  src?: string;
  filledAt?: string;
  reason?: string;
  avgFillPrice?: number;
  fees?: { total: number };
  createdAt: string;
}

export interface PaperAccount {
  uid: string;
  cash: number;
  /** 可用现金 = 现金 − 挂单冻结（评审 P1-4） */
  availableCash?: number;
  reservedCash?: number;
  initialCapital: number;
  marketValue: number;
  totalAssets: number;
  totalPnl: number;
  totalPnlPct: number;
  todayPnl: number;
  /** 回撤熔断状态（评审 P2-2） */
  peakAssets?: number;
  drawdownPct?: number;
  riskLocked?: boolean;
  ddLevel?: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  equity: { t: string; total: number; cash: number; marketValue: number }[];
}

export interface PaperStrategy {
  id: string;
  type: string;
  symbol: string;
  name?: string;
  params: Record<string, number>;
  status: 'running' | 'stopped';
  lastSignal: string;
  startedAt: string;
  lastRunAt: string;
  error: string;
}

export interface PaperLogEntry {
  t: string;
  msg: string;
}

export interface PaperAlert {
  id: string;
  symbol: string;
  name: string;
  condition: 'above' | 'below';
  price: number;
  createdAt: string;
  triggeredAt?: string;
  triggeredPrice?: number;
}

export interface PaperTriggeredAlert {
  id: string;
  alertId: string;
  symbol: string;
  name: string;
  condition: 'above' | 'below';
  price: number;
  triggeredPrice: number;
  at: string;
}

/** 模拟交易 API（后端 server/paper/*） */
export const paperApi = {
  getAccount: () => apiGet<PaperAccount>('/paper/account'),
  placeOrder: (body: {
    symbol: string;
    name?: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    qty: number;
    limitPrice?: number;
  }) => apiPost<{ ok: boolean; order?: PaperOrder; error?: string }>('/paper/order', body),
  cancelOrder: (id: string) =>
    apiPost<{ ok: boolean; error?: string }>(`/paper/order/${encodeURIComponent(id)}/cancel`, {}),
  reset: () => apiPost<{ ok: boolean; message?: string }>('/paper/reset', {}),
  listStrategies: () => apiGet<PaperStrategy[]>('/paper/strategies'),
  startStrategy: (body: {
    type: string;
    symbol: string;
    name?: string;
    params: Record<string, number>;
  }) => apiPost<{ ok: boolean; error?: string }>('/paper/strategies', body),
  stopStrategy: (id: string) =>
    apiPost<{ ok: boolean; error?: string }>(`/paper/strategies/${encodeURIComponent(id)}/stop`, {}),
  getLogs: () => apiGet<PaperLogEntry[]>('/paper/logs'),
  listAlerts: () =>
    apiGet<{ ok: boolean; alerts: PaperAlert[]; triggered: PaperTriggeredAlert[] }>('/paper/alerts'),
  addAlert: (body: { symbol: string; name?: string; condition: 'above' | 'below'; price: number }) =>
    apiPost<{ ok: boolean; alert?: PaperAlert; error?: string }>('/paper/alerts', body),
  removeAlert: (id: string) =>
    apiDelete<{ ok: boolean; error?: string }>(`/paper/alerts/${encodeURIComponent(id)}`),
  clearTriggeredAlerts: () => apiPost<{ ok: boolean }>('/paper/alerts/clear-triggered', {}),
};
