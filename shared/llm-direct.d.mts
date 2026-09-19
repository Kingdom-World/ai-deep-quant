// shared/llm-direct.mjs 的类型声明（供 TypeScript 前端引用唯一实现源）
//   .mjs 本身是 JS，TS 无法直接推断，故此处补声明。
//   口径：T2「自配 API」直连通道 —— 请求由浏览器直接发往供应商，不经本站服务器。

/** T2 默认系统提示（含铁律与能力边界声明） */
export declare const T2_SYSTEM_PROMPT: string;

/** 直连错误码 → 可读文案 */
export declare const DIRECT_ERRORS: Record<
  'NO_CONFIG' | 'NETWORK' | 'UNAUTHORIZED' | 'RATE_LIMIT' | 'NOT_FOUND' | 'SERVER' | 'BAD_RESPONSE' | 'TIMEOUT',
  string
>;

export interface DirectOk {
  ok: true;
  content: string;
  model: string;
  elapsedMs: number;
  tier: 'byok';
}

export interface DirectFail {
  ok: false;
  code: string;
  message: string;
  status?: number;
}

export type DirectResult = DirectOk | DirectFail;

/** 把 HTTP 状态映射为可读错误 */
export declare function classifyHttpError(status: number): { code: string; message: string };

/** 构造单角色分析的 user 消息与角色提示 */
export declare function buildUserMessage(ctx: {
  role?: string;
  symbol: string;
  name?: string;
  digest?: string;
}): { rolePrompt: string; user: string };

/**
 * 发起一次直连请求。
 * cfg 来自 llm-config 的 normalizeConfig；fetchImpl 可注入（Node 侧测试用）。
 */
export declare function callDirect(
  cfg: { base?: string; model?: string; key?: string } | null | undefined,
  userContent: string,
  opts?: {
    system?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<DirectResult>;
