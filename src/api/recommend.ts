// ─────────────────────────────────────────────────────────────
// 推荐域（Recommend）—— 因子评分观察
//   · python 模式：后端 Baostock 数据 + 评分一次聚合（/api/recommend）
//   · node 模式：前端 lib 评分（复用历史 + 报价，3 路并发）
//   · 行为零变化：自 src/api/dataService.ts 原样迁出
// ─────────────────────────────────────────────────────────────
import type { Market } from '../lib/stock';
import { apiGet } from './client';
import { PYTHON, setLastComputedAt } from './runtime';
import { getHistory } from './history';
import { getQuote } from './quote';

/** 因子评分观察（python 模式：后端聚合；node 模式：前端 lib 评分） */
export const getRecommendations = async (
  codes: { symbol: string; market: Market; name: string }[],
  count = 6,
): Promise<{ symbol: string; market: Market; name: string; price: number; changePercent: number; score: number; rating: string }[]> => {
  if (PYTHON) {
    const raw = await apiGet<
      {
        items: { symbol: string; market: Market; name: string; price: number; changePercent: number; score: number; rating: string }[];
        computedAt?: string;
      }
    >(`/recommend?count=${count}`);
    if (raw?.computedAt) setLastComputedAt(raw.computedAt);
    return raw?.items || [];
  }
  const { analyzeStockPotential } = await import('../lib/stock');
  const results: { symbol: string; market: Market; name: string; price: number; changePercent: number; score: number; rating: string }[] = [];
  const queue = [...codes];
  const workers = Array.from({ length: Math.min(3, codes.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const [rows, quote] = await Promise.all([
          getHistory(item.symbol, item.market, 'day', 300, true),
          getQuote(item.symbol, item.market, true),
        ]);
        const points = rows.map((r) => ({
          date: r.date,
          open: r.open,
          close: r.close,
          high: r.high,
          low: r.low,
          volume: r.volume,
        }));
        const report = analyzeStockPotential(item.symbol, points, {
          price: quote.price,
          changePercent: quote.changePercent ?? 0,
        });
        results.push({
          symbol: item.symbol,
          market: item.market,
          name: item.name,
          price: quote.price,
          changePercent: quote.changePercent ?? 0,
          score: report?.total ?? 0,
          rating: report?.rating ?? '数据不足',
        });
      } catch (e) {
        console.error(`推荐评分失败 ${item.symbol}:`, e);
      }
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, count);
};
