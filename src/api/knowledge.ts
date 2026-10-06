// ─────────────────────────────────────────────────────────────
// 知识库 域（自 src/api/dataService.ts 原样迁出 · 行为零变化）
//
//   🔴 #70：category 的联合类型此前是手抄的 `'term'|'basis'|'method'|'paper'`，
//   **缺 principle/case/cycle**（知识库 2.0 加了三层，类型没跟上）。
//   现从 shared/knowledge-layers 单一源派生 —— 后端加层时前端会**编译报错**，
//   而不是静默把新层渲染成灰 chip。
//   ⚠️ 字段名一律以真实 JSON 为准（先打真实响应再写类型），不凭记忆臆造。
// ─────────────────────────────────────────────────────────────
import { apiGet } from './client';
import type { KnowledgeCategory, KnowledgeLayer } from '../../shared/knowledge-layers.mjs';

export type { KnowledgeCategory, KnowledgeLayer };

export interface KnowledgeEntry {
  id: string;
  category: KnowledgeCategory;
  categoryLabel: string;
  /** 是否教学层（basis/paper 为 false —— Learn 路径只消费教学层） */
  isTeachingLayer: boolean;
  title: string;
  body: string;
  // ── 知识库 2.0 结构化字段（§11.1：定义/公式/适用场景/局限）──
  //   全部**可选**：存量 49 条只有 body，缺失时后端给空串（不是 undefined），
  //   渲染层按"降级到 body"处理。
  summary: string;
  formula: string;
  applicability: string;
  limitations: string;
  /** 教学用模型（shared/modelspec 的 MODEL_TEMPLATES key）；不适用时为 null */
  teachingModel: string | null;
  /** 教学说明：挂着 teachingModel 时学生具体观察什么；teachingModel 为 null 时说明为何不挂 */
  teachingNote: string;
  /** 可核查出处（教材章节 / 交易所规则 / 论文题目与链接）——非空是内容硬约束 */
  source: string;
  /** 发布门：true = 无出处、未过审，**不会**出现在默认检索结果里 */
  draft: boolean;
  tags: string[];
  /** 关联条目 id，用于口径互跳 */
  related: string[];
  /** 检索得分（浏览模式为 0） */
  score: number;
  /** 命中的查询词项，供 UI 说明"为何命中" */
  matched: string[];
}

/** 分类过滤器的一项。🔴 count = **已发布**数（与 search 严格一致，见 #68） */
export interface KnowledgeCategoryCount {
  key: KnowledgeCategory;
  label: string;
  /** 已发布条数 = 点进去能看到的条数 */
  count: number;
  /** 全量条数（含草稿） */
  total: number;
  /** 草稿条数（待办量） */
  draft: number;
}

export interface KnowledgeStats {
  total: number;
  published: number;
  draft: number;
  withSource: number;
  /** 全量口径（含草稿）= 内容工作量视角 */
  byCategory: Record<string, number>;
  byLayer: Record<string, number>;
  /** 已发布口径 = 学习路径可用量视角（#68：与 byLayer 必须并存） */
  publishedByCategory: Record<string, number>;
  publishedByLayer: Record<string, number>;
  teachingTotal: number;
  withTeachingModel: number;
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
  stats: KnowledgeStats;
  categories: KnowledgeCategoryCount[];
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
  /** 按 id 批量取条目（关联口径跳转）。⚠️ 不传 includeDraft：草稿视图仅管理员可用 */
  entries: (ids: string[]) => apiGet<{ ok: boolean; items: KnowledgeEntry[] }>(`/knowledge/entries?ids=${encodeURIComponent(ids.join(','))}`),
};
