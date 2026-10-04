// ─────────────────────────────────────────────────────────────
// 知识库 域（自 src/api/dataService.ts 原样迁出 · 行为零变化）
// ─────────────────────────────────────────────────────────────
import { apiGet } from './client';

export interface KnowledgeEntry {
  id: string;
  category: 'term' | 'basis' | 'method' | 'paper';
  categoryLabel: string;
  title: string;
  body: string;
  /** 可核查出处（教材章节 / 交易所规则 / 论文题目与链接）——非空是内容硬约束 */
  source: string;
  tags: string[];
  /** 关联条目 id，用于口径互跳 */
  related: string[];
  /** 检索得分（浏览模式为 0） */
  score: number;
  /** 命中的查询词项，供 UI 说明"为何命中" */
  matched: string[];
}

export interface KnowledgeSearchResult {
  ok: boolean;
  query: string;
  category: string | null;
  /** 命中总数（不受 limit 影响） */
  total: number;
  items: KnowledgeEntry[];
  /** 检索路径：browse=浏览 / and=严格多词 / keyword=整句提问已自动放宽为关键词 */
  mode: KnowledgeSearchMode;
  stats: { total: number; byCategory: Record<string, number>; withSource: number };
  categories: { key: string; label: string; count: number }[];
}

export type KnowledgeSearchMode = 'browse' | 'and' | 'keyword';

export const knowledgeApi = {
  /** 检索知识条目；q 为空 = 浏览模式（返回该分类全部） */
  search: (q: string, category?: string, limit?: number) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (category) p.set('category', category);
    if (limit) p.set('limit', String(limit));
    const qs = p.toString();
    return apiGet<KnowledgeSearchResult>(`/knowledge/search${qs ? `?${qs}` : ''}`);
  },
  /** 按 id 批量取条目（关联口径跳转） */
  entries: (ids: string[]) => apiGet<{ ok: boolean; items: KnowledgeEntry[] }>(`/knowledge/entries?ids=${encodeURIComponent(ids.join(','))}`),
};
