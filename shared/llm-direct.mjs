// ─────────────────────────────────────────────────────────────
// T2 自配 API 直连通道（L1.2）
//
//   设计边界（Q3 已确认，方案书 11.2）：
//     · **单角色、不调工具**。前端发起一次请求，拿一次答复。
//     · 不复用后端 orchestrator 的工具循环 —— 那会形成"两份编排器"，
//       逻辑分叉后无法保证一致。宁可能力收窄、语义清晰。
//     · 请求由**浏览器直接发往供应商**，不经本站服务器。
//
//   为什么能直连（实测依据）：三家供应商 CORS 均放行（方案书 11.3）。
//   注意智谱返回精确 Origin 回显 → 域名变更后须复测。
//
//   ⚠️ 能力差异要**显式**告知用户：T2 不参与五阶段流水线、不做多空辩论。
// ─────────────────────────────────────────────────────────────

/** 精简角色卡：与 server/agents/roles.cjs 的 BOUNDARIES 铁律保持同一口径 */
export const T2_SYSTEM_PROMPT = [
  '【铁律 · 必须遵守】',
  '1. 你是「AI深度量化」学术研究演示系统中的一个分析角色，所有输出仅供研究学习。',
  '2. 严禁荐股、严禁承诺或暗示收益、严禁使用煽动交易的措辞。',
  '3. 只基于【注入数据】发言；数据不足时必须明确写"数据不足"，绝不编造数字或事件。',
  '4. 不联网、不检索：你的全部依据来自下方注入的数据。',
  '',
  '【本模式的能力边界 · 须诚实告知使用者】',
  '你处于「自配 API 单角色模式」：只做一次独立分析，不参与五阶段流水线、',
  '不做多空辩论、不调用任何工具（不回测、不查 K 线）。请勿声称已完成上述工作。',
].join('\n');

/**
 * 构造单角色分析的 user 消息。
 * @param ctx { role, symbol, name, digest }
 *   role   —— 角色系统提示（可覆盖默认）
 *   digest —— 已由平台规则引擎算好的指标文本（**数值不由 LLM 产出**）
 */
export function buildUserMessage({ role, symbol, name, digest }) {
  return {
    rolePrompt: role || T2_SYSTEM_PROMPT,
    user: [
      `【标的】${name ? `${name}（${symbol}）` : symbol}`,
      '',
      '【注入数据（由平台规则引擎计算，数字请直接引用，不要自行推算）】',
      String(digest || '（无可用数据）'),
      '',
      '【任务】基于以上数据给出独立分析：',
      '1) 结论（偏多 / 偏空 / 中性，必须给出一项）',
      '2) 依据（逐条挂钩上面的具体数值）',
      '3) 局限（本模式未做回测与工具取证，明说你没能验证什么）',
      '输出纯文本，不要 JSON、不要 markdown 代码块。',
    ].join('\n'),
  };
}

/** 直连错误分类：便于 UI 给出可操作提示，而不是笼统一句"失败" */
export const DIRECT_ERRORS = {
  NO_CONFIG: '尚未配置 API Key，请先在「自配 API」档位填入你自己的 Key。',
  NETWORK: '网络请求失败：可能是浏览器拦截（CORS）或本机网络不可达。请确认能否直接访问该供应商。',
  UNAUTHORIZED: 'API Key 无效或已过期（供应商返回 401/403）。请检查 Key 是否正确、是否有该模型的权限。',
  RATE_LIMIT: '触发供应商限流（429）。请稍后重试，或更换模型。',
  NOT_FOUND: '模型不存在或端点地址错误（404）。请核对模型名与接口地址。',
  SERVER: '供应商服务端异常（5xx）。请稍后重试。',
  BAD_RESPONSE: '响应格式异常：未取到有效内容。',
  TIMEOUT: '请求超时。免费模型可能响应较慢，请重试或更换模型。',
};

/** 把 HTTP 状态映射为可读错误 */
export function classifyHttpError(status) {
  if (status === 401 || status === 403) return { code: 'UNAUTHORIZED', message: DIRECT_ERRORS.UNAUTHORIZED };
  if (status === 429) return { code: 'RATE_LIMIT', message: DIRECT_ERRORS.RATE_LIMIT };
  if (status === 404) return { code: 'NOT_FOUND', message: DIRECT_ERRORS.NOT_FOUND };
  if (status >= 500) return { code: 'SERVER', message: DIRECT_ERRORS.SERVER };
  return { code: 'HTTP_' + status, message: `请求被拒绝（HTTP ${status}）。` };
}

/**
 * 发起一次直连请求。
 * @param cfg  { base, model, key }（来自 llm-config 的 normalizeConfig）
 * @param userContent 已构造好的 user 文本
 * @param opts { system, maxTokens, temperature, timeoutMs, fetchImpl }
 * @returns { ok, content, model, elapsedMs } | { ok:false, code, message, status? }
 *
 * ⚠️ fetchImpl 可注入（Node 侧测试用），不注入则用全局 fetch。
 */
export async function callDirect(cfg, userContent, opts = {}) {
  if (!cfg || !cfg.key || !cfg.model || !cfg.base) {
    return { ok: false, code: 'NO_CONFIG', message: DIRECT_ERRORS.NO_CONFIG };
  }
  const doFetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) {
    return { ok: false, code: 'NO_FETCH', message: '当前环境不支持直连请求。' };
  }

  const url = `${String(cfg.base).replace(/\/$/, '')}/chat/completions`;
  const started = Date.now();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: opts.system || T2_SYSTEM_PROMPT },
          { role: 'user', content: String(userContent || '') },
        ],
        max_tokens: Number(opts.maxTokens) || 1500,
        temperature: opts.temperature !== undefined ? opts.temperature : 0.5,
        stream: false,
      }),
      signal: controller ? controller.signal : undefined,
    });

    if (!res.ok) {
      const cls = classifyHttpError(res.status);
      return { ok: false, status: res.status, ...cls };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, code: 'BAD_RESPONSE', message: DIRECT_ERRORS.BAD_RESPONSE };
    }
    return {
      ok: true,
      content,
      model: data?.model || cfg.model,
      elapsedMs: Date.now() - started,
      tier: 'byok',
    };
  } catch (e) {
    const name = e?.name || '';
    if (name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', message: DIRECT_ERRORS.TIMEOUT };
    }
    // TypeError: Failed to fetch —— 浏览器 CORS 拦截或网络不可达
    return {
      ok: false,
      code: 'NETWORK',
      message: `${DIRECT_ERRORS.NETWORK}（${String(e?.message || e).slice(0, 80)}）`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
