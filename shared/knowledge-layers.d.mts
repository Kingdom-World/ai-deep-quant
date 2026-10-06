// 知识库分层 taxonomy 的类型声明（实现见 knowledge-layers.cjs）

/** 教学五层的 key（术语 → 方法论 → 原理 → 案例 → 周期专题） */
export type KnowledgeLayer = 'term' | 'method' | 'principle' | 'case' | 'cycle';

/** 平台辅助类的 key（不是教学层，不进学习路径） */
export type KnowledgeAux = 'basis' | 'paper';

/** 全部分类 key */
export type KnowledgeCategory = KnowledgeLayer | KnowledgeAux;

export declare const LAYERS: Record<KnowledgeLayer, string>;
export declare const AUX: Record<KnowledgeAux, string>;
export declare const CATEGORIES: Record<KnowledgeCategory, string>;
/** 教学五层的 key，按学习路径自然顺序 */
export declare const LAYER_KEYS: KnowledgeLayer[];
/** 是否教学层 */
export declare function isTeachingLayer(c: string): boolean;
