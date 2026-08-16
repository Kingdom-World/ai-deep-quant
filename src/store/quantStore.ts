// ─────────────────────────────────────────────────────────────
// 全局状态管理（Zustand）
// 统一管理跨页面共享状态：当前股票、大盘指数、数据源状态
// ─────────────────────────────────────────────────────────────
import { create } from 'zustand';
import type { Market } from '../lib/stock';
import { DEFAULT_MARKET, DEFAULT_SYMBOL } from '../config';

/** 大盘指数条目 */
export interface IndexStateItem {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
}

/** 数据源状态 */
export interface DataSourceState {
  primary: string;
  current: string;
  primaryHealthy: boolean;
  cacheSize: number;
}

interface QuantStore {
  // 当前股票
  symbol: string;
  market: Market;
  setSymbol: (symbol: string, market: Market) => void;
  // 大盘指数（主页轮询写入，详情页可读）
  indices: IndexStateItem[];
  setIndices: (items: IndexStateItem[]) => void;
  indicesUpdatedAt: string;
  setIndicesUpdatedAt: (t: string) => void;
  // 数据源状态
  dataSource: DataSourceState;
  setDataSource: (s: DataSourceState) => void;
  // 缓存统计
  cacheSize: number;
  setCacheSize: (n: number) => void;
}

export const useQuantStore = create<QuantStore>((set) => ({
  symbol: DEFAULT_SYMBOL,
  market: DEFAULT_MARKET,
  setSymbol: (symbol, market) => set({ symbol, market }),
  indices: [],
  setIndices: (indices) => set({ indices }),
  indicesUpdatedAt: '',
  setIndicesUpdatedAt: (t) => set({ indicesUpdatedAt: t }),
  dataSource: { primary: 'backend', current: 'backend', primaryHealthy: true, cacheSize: 0 },
  setDataSource: (dataSource) => set({ dataSource }),
  cacheSize: 0,
  setCacheSize: (cacheSize) => set({ cacheSize }),
}));
