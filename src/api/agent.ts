// ─────────────────────────────────────────────────────────────
// Agent 团队与研究 域（自 src/api/dataService.ts 原样迁出 · 行为零变化）
// ─────────────────────────────────────────────────────────────
import { apiGet, apiPost, apiDelete } from './client';

// ───────────── Agent 团队分析 ─────────────

export interface AgentReport {
  name: string;
  role: string;
  findings: string[];
  bias?: 'bullish' | 'bearish' | 'neutral';
  confidence?: number;
  metrics?: Record<string, number | null>;
  limitations?: string[];
}

export interface AgentRosterEntry {
  seat: string;
  /** 实际产出该角色内容的模型 */
  model: string;
  /** llm = 真调用了云端大模型；rule = 降级到本地规则引擎 */
  engine: 'llm' | 'rule';
  ms: number | null;
}

/** 降级汇总：哪些角色由本地规则引擎兜底（后端 trace.degraded） */
export interface AgentDegraded {
  degraded: boolean;
  /** 真正由大模型产出的角色数 */
  llm: number;
  /** 降级到规则引擎的角色数 */
  rule: number;
  total: number;
  /** 降级角色名 */
  seats: string[];
  reason?: string;
}

export interface AgentTrace {
  ok: boolean;
  symbol: string;
  name?: string;
  mode: string;
  ranAt: string;
  price: number | null;
  stages: Record<string, any>;
  final: { decision: string; note?: string; teamScore?: number; disclaimer?: string };
  disclaimer: string;
  reportId?: string;
  error?: string;
  /** 每个角色的实际执行引擎与模型（用于判断 AI 是否真的参与了分析） */
  llmRoster?: AgentRosterEntry[];
  llmEnabled?: boolean;
  /** 本次运行的降级情况（显式可观测，避免把规则产出误读为大模型分析） */
  degraded?: AgentDegraded;
  /**
   * 本次实际使用的 LLM 能力档位（L1.5）。
   * 后端在三条路径上分别打标：rule（规则引擎同步返回）/ platform（T3 异步流水线）/
   * 以及 403 拒绝时的 tier:'platform'（表示「你请求的档位」而非「实际使用的档位」）。
   * 前端必须据此回显，避免用户把规则产出误认为大模型产出。
   */
  tier?: AgentTier;
}

/** LLM 能力档位（与 server/index.cjs 的 tiers 声明同口径） */
export type AgentTier = 'rule' | 'byok' | 'platform';

export interface TierDeclaration {
  key: AgentTier;
  available: boolean;
  /** 该档位是否消耗平台侧 LLM 配额 */
  platformLLM: boolean;
  label: string;
  adminOnly?: boolean;
}

export interface AgentCapabilities {
  ok: boolean;
  /** public = 公网演示版（长任务受限）；full = 完整版（无时限）。取值不带任何平台含义 */
  runtime: 'public' | 'full';
  tiers: TierDeclaration[];
  /** 各模式在当前 runtime + 档位下是否可跑 */
  modes: Record<string, { available: boolean; reason?: string }>;
  hints: { byok?: string; platform?: string };
}

/** 12. Agent 团队分析（主理人调度制五阶段流水线，程序化规则引擎） */
export const agentsApi = {
  analyze: (body: { symbol: string; mode?: string; agent?: string; entryPrice?: number; tier?: AgentTier }) =>
    apiPost<AgentTrace & { jobId?: string }>('/agents/analyze', body, {
      // Agent 流水线公网耗时 30-60s（13 角色多次数据调用），全局 30s 预算必现假性超时——
      // 单独放宽到 58s（贴服务端 maxDuration=60 留余量）；超时文案引导查历史报告（后端会存档）
      timeoutMs: 58_000,
      timeoutMessage: '分析耗时超过公网处理上限（约 55 秒）。流水线可能已在后台完成——请稍后到「Agent 团队」页查看历史报告；或改用「快速分析」模式。',
    }),
  /**
   * 能力档位声明（L1.3/L1.5）。纯声明接口：不消耗 LLM 配额、不触发外部请求。
   * 前端据此决定档位 Tab 的可见性与模式置灰，而不是等用户点了才撞 503/403。
   */
  capabilities: () => apiGet<AgentCapabilities>('/agents/capabilities'),
  job: (id: string) =>
    apiGet<{ ok: boolean; status: 'running' | 'done' | 'error'; stage: string; step: number; total: number; reportId?: string; error?: string; trace?: AgentTrace }>(
      `/agents/job/${encodeURIComponent(id)}`,
    ),
  report: (id: string) =>
    apiGet<{ ok: boolean; report: AgentTrace }>(`/agents/report/${encodeURIComponent(id)}`),
  list: (symbol?: string) =>
    apiGet<{ ok: boolean; list: { id: string; symbol: string; name?: string; mode: string; decision: string; ranAt: string }[] }>(
      `/agents/reports${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`,
    ),
  remove: (id: string) =>
    apiDelete<{ ok: boolean; error?: string }>(`/agents/reports/${encodeURIComponent(id)}`),
};

export interface AgentTraceEntry {
  ts?: string;
  step?: number;
  tool?: string;
  args?: Record<string, unknown>;
  /** 工具原始数据（数值保真通道：与模型结论并列核对） */
  data?: unknown;
  fingerprint?: { rowsHash?: string } | null;
  ok?: boolean;
  summary?: string;
  elapsedMs?: number;
  model?: string | null;
  event?: string;
  preview?: string;
  errors?: string[];
}

export interface AgentToolData {
  tool: string;
  args: Record<string, unknown>;
  data: Record<string, unknown> | null;
  fingerprint: { rowsHash?: string } | null;
  /** 该 (工具,参数) 被调用的次数（同参重复已合并展示，>1 时 UI 应标注） */
  calls?: number;
}

export interface AgentResearchResult {
  ok: boolean;
  /** 模型最终结论（解读）。⚠️ 数字请以 toolData 为准——模型复述数值不可靠（P3 实测） */
  answer: string | null;
  draft: string | null;
  reason: string;
  rounds: number;
  /** true = 发生模型回退或研究不充分，结论可靠性下降 */
  degraded: boolean;
  actualModel: string | null;
  toolData: AgentToolData[];
  trace: AgentTraceEntry[];
  error?: string;
}

export const agentApi = {
  /** 真调云端模型（Alpha + 工具循环），实测约 5-10s，调用方必须有 loading 态 */
  research: (question: string) => apiPost<AgentResearchResult>('/agent/research', { question }),
};

// ── 知识库（M1）：结构化条目 + 可核查出处 ──
