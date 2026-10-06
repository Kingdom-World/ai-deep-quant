// 模型分享（可见性与审核状态机）类型声明 —— 与 shared/modelshare.cjs 一一对应

export const SHARE_VERSION: number;
export const VISIBILITIES: readonly ('private' | 'circle' | 'public')[];
export const REVIEW_STATES: readonly ('none' | 'pending' | 'approved' | 'rejected')[];
export const DEFAULT_VISIBILITY: 'private';
export const DEFAULT_REVIEW_STATE: 'none';
export const REVIEW_NOTE_MAX: number;
export const VISIBILITY_LABELS: Record<'private' | 'circle' | 'public', string>;
export const REVIEW_LABELS: Record<'none' | 'pending' | 'approved' | 'rejected', string>;
/** 分享物里允许出现的模型字段（白名单） */
export const MODEL_FIELDS: readonly string[];
export const ACTIONS: Record<
  'set-private' | 'set-circle' | 'request-public' | 'withdraw-request' | 'approve' | 'reject',
  { by: 'owner' | 'admin'; desc: string; label: string }
>;
/** 动作按角色分组（路由层**必须**据此校验，否则 owner 能给自己过审） */
export const OWNER_ACTIONS: readonly ShareAction[];
export const ADMIN_ACTIONS: readonly ShareAction[];
/** 动作归属角色；未知动作返回 null */
export function actionBy(action: string): 'owner' | 'admin' | null;

export type Visibility = 'private' | 'circle' | 'public';
export type ReviewState = 'none' | 'pending' | 'approved' | 'rejected';
export type ShareAction = keyof typeof ACTIONS;

/** 访问者身份（匿名传 null） */
export interface ShareViewer {
  uid?: string;
  isAdmin?: boolean;
}

export interface ShareState {
  visibility: Visibility;
  reviewState: ReviewState;
  reviewNote: string;
  requestedAt: string | null;
  publishedAt: string | null;
}

export interface ShareView {
  shareVersion: number;
  /** 必有（缺失时实现给空串，调用方一次判空即可） */
  id: string;
  name: string;
  /** 归属显示名（**不是** uid） */
  author: string | null;
  modelHash: string | null;
  visibility: Visibility;
  publishedAt: string | null;
  sharedAt: string | null;
  reviewState?: ReviewState;
  reviewNote?: string;
  requestedAt?: string | null;
  model: Record<string, unknown>;
}

export interface ShareSummary {
  /** 必有（缺失时实现给空串，调用方一次判空即可） */
  id: string;
  name: string;
  author: string | null;
  modelHash: string | null;
  visibility: Visibility;
  effective: Visibility;
  reviewState: ReviewState;
  reviewNote?: string;
  publishedAt: string | null;
  updatedAt: string | null;
  /** 列表走索引行时为 null（拿不到正文，不谎报 0） */
  factorCount: number | null;
}

export function isValidVisibility(v: unknown): v is Visibility;
export function isValidReviewState(s: unknown): s is ReviewState;
export function shareOf(doc: unknown): ShareState;
export function effectiveVisibility(doc: unknown): Visibility;
export function canView(doc: unknown, viewer: ShareViewer | null): boolean;
export function applyShareAction(
  doc: unknown,
  action: string,
  opts?: { now?: string; note?: string },
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string };
/** 归属显示名（脱敏）：`ip:` 前缀一律为「匿名用户」，绝不外露 IP */
export function authorNameOf(uid: string): string;
export function shareView(
  doc: unknown,
  opts?: { author?: string; modelHash?: string; includeReview?: boolean },
): ShareView;
export function shareSummary(
  doc: unknown,
  opts?: { author?: string; modelHash?: string; includeReview?: boolean },
): ShareSummary;
export function actionsFor(doc: unknown, actor?: { isOwner?: boolean; isAdmin?: boolean }): ShareAction[];
