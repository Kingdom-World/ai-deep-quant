// ─────────────────────────────────────────────────────────────
// 认证域（Auth）—— 登录/注册/改密/登出 + 邀请码管理
//   · 数据源：后端 /api/auth/*（Cookie 会话由后端 Set-Cookie 维护）
//   · 行为零变化：自 src/api/dataService.ts 原样迁出
// ─────────────────────────────────────────────────────────────
import { apiGet, apiPost } from './client';

/** 认证 API（/api/auth/*，Cookie 会话由后端 Set-Cookie 维护） */
export const authApi = {
  me: () =>
    apiGet<{ ok: boolean; username: string | null; isAdmin?: boolean; authEnabled?: boolean }>('/auth/me'),
  login: (username: string, password: string) =>
    apiPost<{ ok: boolean; username?: string; error?: string }>('/auth/login', { username, password }),
  register: (username: string, password: string, invite?: string) =>
    apiPost<{ ok: boolean; username?: string; error?: string }>('/auth/register', { username, password, invite }),
  changePassword: (oldPassword: string, newPassword: string) =>
    apiPost<{ ok: boolean; username?: string; error?: string }>('/auth/change-password', { oldPassword, newPassword }),
  logout: () => apiPost<{ ok: boolean }>('/auth/logout', {}),

  // ── 邀请码管理（一码一人）──────────────────────────────────
  //   后端挂在 /api/auth/* 下（该路由段在鉴权中间件之前，故**自行校验管理员身份**，
  //   非管理员一律 403）。管理员判定 = 用户名等于后端 SITE_USERNAME。
  listInvites: () =>
    apiGet<{
      ok: boolean;
      enabled: boolean;
      codes: InviteEntry[];
      summary?: { total: number; unused: number; used: number; revoked: number };
    }>('/auth/invites'),
  createInvite: (note: string, ttlDays?: number) =>
    apiPost<{ ok: boolean; entry?: InviteEntry; error?: string }>('/auth/invites', { note, ttlDays }),
  revokeInvite: (code: string) =>
    apiPost<{ ok: boolean; entry?: InviteEntry; error?: string }>('/auth/invites/revoke', { code }),
};

/** 邀请码条目 —— 字段与 server/invites.cjs 的 rowToEntry 一一对应（勿臆造字段名） */
export type InviteEntry = {
  code: string;
  note: string;
  createdAt: string | null;
  usedBy: string | null;
  usedAt: string | null;
  revoked: boolean;
  expiresAt: string | null;
};
