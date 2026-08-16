// ─────────────────────────────────────────────────────────────
// 收藏管理（localStorage 持久化，主页与详情页共享）
// ─────────────────────────────────────────────────────────────
import type { Market } from './stock';

export interface FavoriteEntry {
  symbol: string;
  market: Market;
  name?: string;
}

const FAV_KEY = 'quant_favorites';

/** 读取全部收藏 */
export const getFavorites = (): FavoriteEntry[] => {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as FavoriteEntry[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

/** 是否已收藏 */
export const isFavorite = (symbol: string): boolean =>
  getFavorites().some((f) => f.symbol === symbol);

/** 写入收藏列表 */
const saveFavorites = (list: FavoriteEntry[]) => {
  localStorage.setItem(FAV_KEY, JSON.stringify(list));
};

/** 添加收藏（返回是否新增成功） */
export const addFavorite = (entry: FavoriteEntry): boolean => {
  const list = getFavorites();
  if (list.some((f) => f.symbol === entry.symbol)) return false;
  list.push(entry);
  saveFavorites(list);
  return true;
};

/** 取消收藏（返回是否移除成功） */
export const removeFavorite = (symbol: string): boolean => {
  const list = getFavorites();
  const next = list.filter((f) => f.symbol !== symbol);
  if (next.length === list.length) return false;
  saveFavorites(next);
  return true;
};

/** 切换收藏状态（收藏 ↔ 取消），返回切换后的收藏状态 */
export const toggleFavorite = (entry: FavoriteEntry): boolean => {
  if (isFavorite(entry.symbol)) {
    removeFavorite(entry.symbol);
    return false;
  }
  addFavorite(entry);
  return true;
};
