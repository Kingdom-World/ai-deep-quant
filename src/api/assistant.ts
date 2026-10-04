// ─────────────────────────────────────────────────────────────
// 助手域（Assistant）—— 站内 AI 问答 / 学习系统后台接口
//   · 数据源：后端 /api/qa、/api/ai/*
//   · askAssistant 需 75s 专用超时（云端模型生成慢）与外部取消信号
//   · 行为零变化：自 src/api/dataService.ts 原样迁出
// ─────────────────────────────────────────────────────────────
import { apiGet, apiGetTimed, apiPost } from './client';

/** 网站 AI 问答（云端模型生成较慢，专用 75s 超时；思考链独立返回） */
export const askAssistant = async (
  question: string,
  externalSignal?: AbortSignal,
): Promise<{ question: string; type: string; answer: string; symbol?: string; engine?: string; reasoning?: string | null; degraded?: string }> => {
  const qs = new URLSearchParams();
  qs.set('q', question);
  return apiGetTimed<{
    question: string;
    type: string;
    answer: string;
    engine?: string;
    reasoning?: string | null;
    degraded?: string;
  }>(`/qa?${qs.toString()}`, {
    timeoutMs: 75000,
    signal: externalSignal,
    timeoutMessage: '云端模型响应超时，请稍后重试',
  });
};

/** AI 助手学习系统（知识库 / 反馈 / 教学 / 训练状态） */
export const aiApi = {
  stats: () => apiGet<{ ok: boolean; knowledge: number; trainCount: number; lastNightly: any; pendingQuestions: number }>('/ai/stats'),
  feedback: (body: { question: string; answer: string; rating: 'up' | 'down'; comment?: string }) =>
    apiPost<{ ok: boolean }>('/ai/feedback', body),
  teach: (body: { q: string; a: string }) => apiPost<{ ok: boolean; updated?: boolean; error?: string }>('/ai/teach', body),
};
