// ─────────────────────────────────────────────────────────────
// 云端大模型多供应商接入层 v3（OpenAI 兼容协议，全部国内直连）
//   支持供应商（AI_CLOUD_PROVIDER）：
//     zhipu       智谱 BigModel —— glm-4.7-flash 永久免费，思考模式返回真实思考链（主力）
//     siliconflow 硅基流动 —— 仅允许免费白名单模型（见 FREE_MODELS）
//     dashscope   阿里百炼 —— 新用户各模型免费额度
//     custom      任意 OpenAI 兼容端点（需 AI_CLOUD_BASE_URL，含自建/微调模型）
//   · 故障转移链：AI_CLOUD_FALLBACK_MODELS 逗号分隔，支持「模型@供应商」跨供应商切换
//     （跨供应商 Key 从 AI_CLOUD_API_KEY_<供应商大写> 读取，缺省回落主 Key）
//   · ⚠️ 用户指令（2026-08-31）：禁止调用付费模型——白名单外模型直接拦截，绝不发起请求
//     （硅基流动规则：余额不足时连免费模型也 402，跑付费模型会无声扣费）
//   · 推理模型自动解析 reasoning_content（DeepSeek/GLM 思考链风格）
// ─────────────────────────────────────────────────────────────
const axios = require('axios');

const PROVIDERS = {
  zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4' },
  siliconflow: { base: 'https://api.siliconflow.cn/v1' },
  dashscope: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  custom: { base: '' }, // 必须配 AI_CLOUD_BASE_URL
};

// 免费模型白名单（2026-08-31 逐一实测 HTTP 200；白名单外一律不调用）
const FREE_MODELS = {
  zhipu: new Set(['glm-4.7-flash', 'glm-4-flash-250414', 'glm-4-flash']),
  siliconflow: new Set([
    'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
    'THUDM/GLM-Z1-9B-0414',
    'THUDM/GLM-4-9B-0414',
    'Qwen/Qwen3.5-4B',
    'Qwen/Qwen3-8B',
  ]),
};
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 48_000;
const MAX_OUTPUT_TOKENS = 4_000;

function boundedMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let total = 0;
  const systemMessages = list.filter((message) => message?.role === 'system').slice(0, 4);
  const otherMessages = list.filter((message) => message?.role !== 'system').slice(-(MAX_MESSAGES - systemMessages.length));
  const out = [];
  for (const message of [...systemMessages, ...otherMessages]) {
    if (!message || typeof message !== 'object') continue;
    const role = ['system', 'user', 'assistant', 'tool'].includes(message.role) ? message.role : 'user';
    const content = typeof message.content === 'string' ? message.content : String(message.content ?? '');
    const remaining = Math.max(0, MAX_CONTEXT_CHARS - total);
    if (!remaining) break;
    const clipped = content.slice(0, Math.min(MAX_MESSAGE_CHARS, remaining));
    out.push({ role, content: clipped });
    total += clipped.length;
  }
  return out;
}

function resolve() {
  const provider = process.env.AI_CLOUD_PROVIDER || 'zhipu';
  const preset = PROVIDERS[provider];
  const base = process.env.AI_CLOUD_BASE_URL || preset?.base || '';
  const key = process.env.AI_CLOUD_API_KEY;
  const model = process.env.AI_CLOUD_MODEL;
  if (!key || !model || !base) return null;
  return { provider, base: String(base).replace(/\/$/, ''), key, model };
}

function configured() {
  return Boolean(resolve());
}

/** 跨供应商条目的 Key：AI_CLOUD_API_KEY_<PROVIDER> 优先，回落主 Key */
function keyFor(provider, mainKey) {
  return process.env[`AI_CLOUD_API_KEY_${provider.toUpperCase()}`] || mainKey;
}

/** 按免费白名单反查某模型归属的供应商（角色卡只写模型名、不带 @provider 时用） */
function providerOfModel(model) {
  for (const [provider, set] of Object.entries(FREE_MODELS)) {
    if (set.has(model)) return provider;
  }
  return null;
}

/** 把「model」或「model@provider」条目解析为可调用目标；无法解析返回 null */
function resolveTarget(entry, cfg) {
  const at = entry.lastIndexOf('@');
  let model = entry;
  let provider = cfg.provider;
  if (at > 0) {
    model = entry.slice(0, at);
    provider = entry.slice(at + 1);
  } else {
    // 未标注供应商：若当前供应商白名单里没有该模型，自动切到拥有它的供应商。
    // （roles.cjs 里写的是 deepseek-ai/... 、Qwen/... 这类硅基流动模型名，
    //   不自动识别的话会被当成 zhipu 模型撞白名单拦截，导致全员退化到规则引擎）
    const owner = providerOfModel(model);
    if (owner && owner !== provider) provider = owner;
  }
  const preset = PROVIDERS[provider];
  if (!preset) return null;
  const base = provider === cfg.provider
    ? cfg.base
    : String(process.env[`AI_CLOUD_BASE_URL_${provider.toUpperCase()}`] || preset.base).replace(/\/$/, '');
  const key = provider === cfg.provider ? cfg.key : keyFor(provider, cfg.key);
  if (!base || !key) return null;
  return { model, provider, base, key };
}

// ── 本地模型兜底通道（B4 工程骨架，默认完全不生效）──────────────
// 设计意图：真实本地模型尚未部署，这一层只是「可配置、可验证、默认不生效」的通道。
// 仅当配置了 AI_CLOUD_LOCAL_BASE_URL + AI_CLOUD_LOCAL_MODEL 才启用；未配置时
// 任何代码路径都不会产生 local 目标，保证与现有链路 100% 一致。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 校验本地端点 host 是否仅限本机/内网。
 * 安全意图（关键）：本地通道豁免 FREE_MODELS 免费白名单（它本来就不是云端付费模型），
 * 因此必须严格限制其 host 只能是本机或私有网段，防止有人把 AI_CLOUD_LOCAL_BASE_URL
 * 指到某个「云端付费 OpenAI 兼容端点」来借本地通道绕过免费白名单拦截、静默跑付费模型。
 * 只有命中以下白名单的 host 才放行：
 *   localhost / 127.0.0.1 / ::1 / 10.* / 192.168.* / 172.16.*~172.31.*
 */
function isLocalHostAllowed(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost') return true;
  if (host === '127.0.0.1') return true;
  if (host === '::1') return true; // IPv6 环回
  if (host === '[::1]') return true;
  if (host.startsWith('10.')) return true; // RFC1918 私网 A
  if (host.startsWith('192.168.')) return true; // RFC1918 私网 C
  // RFC1918 私网 B：172.16.0.0 ~ 172.31.255.255
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * 解析本地兜底目标；未配置或非本机/内网 host 时返回 null（不启用）。
 * 返回 { model, provider: 'local', base, key, local: true }——provider 固定为 'local'，
 * 既与云端供应商区分，也天然不在 FREE_MODELS 白名单里（豁免白名单）。
 */
function resolveLocalTarget() {
  const baseUrl = process.env.AI_CLOUD_LOCAL_BASE_URL;
  const model = process.env.AI_CLOUD_LOCAL_MODEL;
  if (!baseUrl || !model) return null;
  if (!isLocalHostAllowed(baseUrl)) {
    console.warn(`[AI云端] 本地通道端点「${baseUrl}」非本机/内网地址，拒绝启用（防止借本地通道绕过免费白名单跑付费模型）`);
    return null;
  }
  const base = String(baseUrl).replace(/\/$/, '');
  const key = process.env.AI_CLOUD_LOCAL_API_KEY || '';
  return { model, provider: 'local', base, key, local: true };
}

/**
 * 解析候选调用链（纯同步、绝不发起网络请求），供 chat 与验证脚本复用。
 * @param {object} opts
 *   model  角色指定模型（链首）
 *   tier  角色分层（'heavy'|'light'），仅影响本地通道的排序
 * @returns {Array<{model, provider, base, key, local}>} 形如 [{model, provider, base}]，无网络副作用
 *   云端目标：角色模型 → 主模型 → AI_CLOUD_FALLBACK_MODELS，强制 FREE_MODELS 白名单拦截。
 *   本地目标：仅当 host 校验通过时加入；默认追加到链尾，云端全挂时兜底；
 *             AI_CLOUD_LOCAL_PREFER_LIGHT=1 且 opts.tier==='light' 时提到链首。
 */
function candidateChain({ model, tier } = {}) {
  const cfg = resolve();
  const out = [];
  // 云端候选链（受免费白名单约束）
  if (cfg) {
    const rawChain = [
      ...(model ? [String(model)] : []),
      cfg.model,
      ...(process.env.AI_CLOUD_FALLBACK_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean),
    ];
    const seen = new Set();
    for (const entry of rawChain) {
      const t = resolveTarget(entry, cfg);
      if (!t) continue; // 供应商/Key 缺失，跳过
      // 免费白名单强制拦截（用户指令：禁止跑付费模型）
      const free = FREE_MODELS[t.provider];
      if (!free || !free.has(t.model)) continue;
      const id = targetId(t);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...t, local: false });
    }
  }
  // 本地兜底目标（豁免白名单，但仅限本机/内网 host）
  const local = resolveLocalTarget();
  if (local) {
    const preferLight = process.env.AI_CLOUD_LOCAL_PREFER_LIGHT === '1' && tier === 'light';
    if (preferLight) out.unshift(local); // 轻量角色走本地小模型：提到链首
    else out.push(local); // 默认：云端可用时优先云端，云端全挂时落到本地
  }
  return out;
}


// ── 按供应商隔离的并发闸 ──
// 4 个分析师是 Promise.all 并行发起的，同一瞬间多个请求打向同一供应商会触发免费额度限流（429）。
// 用「每供应商」而非「全局」闸门：既压住单家限流，又不会让 zhipu 的慢请求把硅基流动的并发名额卡死。
const MAX_CONCURRENT_PER_PROVIDER = Math.max(Number(process.env.AI_CLOUD_MAX_CONCURRENT) || 3, 1);
const gates = new Map(); // provider -> { inflight, waiters }
function gateOf(provider) {
  let g = gates.get(provider);
  if (!g) {
    g = { inflight: 0, waiters: [] };
    gates.set(provider, g);
  }
  return g;
}
/**
 * 取得该供应商的并发名额后执行 fn
 * @returns { value, waitedMs } —— waitedMs 为排队耗时，调用方需把它排除在调用预算之外，
 *          否则并行任务里排队最久的那个角色会因"预算被排队吃掉"而超时退化成规则引擎。
 */
async function limited(provider, fn) {
  const g = gateOf(provider);
  const t0 = Date.now();
  while (g.inflight >= MAX_CONCURRENT_PER_PROVIDER) await new Promise((r) => g.waiters.push(r));
  g.inflight += 1;
  const waitedMs = Date.now() - t0;
  try {
    return { value: await fn(), waitedMs };
  } finally {
    g.inflight -= 1;
    const next = g.waiters.shift();
    if (next) next();
  }
}

// ── 限流冷却 ──
// 命中 429/503 的模型进入冷却期，后续调用直接跳过它，
// 避免每次请求都先花时间去撞一个已知被限流的模型（这是此前整条流水线变慢的主因）。
const COOLDOWN_MS = Math.max(Number(process.env.AI_CLOUD_COOLDOWN_MS) || 30_000, 1000);
const cooldownUntil = new Map();
const targetId = (t) => `${t.provider}:${t.model}`;
function isCoolingDown(t) {
  return (cooldownUntil.get(targetId(t)) || 0) > Date.now();
}
function startCooldown(t, ms) {
  cooldownUntil.set(targetId(t), Date.now() + Math.max(Number(ms) || COOLDOWN_MS, 1000));
}
// 冷却表清理：条目到期即删，避免长期运行时 Map 随「角色×模型」组合无界增长
setInterval(() => {
  const now = Date.now();
  for (const [id, until] of cooldownUntil) if (until <= now) cooldownUntil.delete(id);
}, Math.max(COOLDOWN_MS, 10_000)).unref();
function retryAfterMs(e) {
  const v = Number(e?.response?.headers?.['retry-after']);
  return Number.isFinite(v) && v > 0 ? Math.min(v * 1000, 60_000) : COOLDOWN_MS;
}

/** 冷却状态快照（供健康检查/排障） */
function cooldownSnapshot() {
  const now = Date.now();
  const out = {};
  for (const [id, until] of cooldownUntil) {
    if (until > now) out[id] = Math.ceil((until - now) / 1000);
  }
  return out;
}

/**
 * 调用云端模型对话（角色指定模型 → 主模型 → 备用链自动故障转移，白名单外模型直接拦截）
 * @param {object} opts
 *   model      角色指定模型（可选，置于链首，role.cjs 的 13 角色分饰多模型靠它生效）
 *   timeoutMs  单次尝试上限（默认 20000）；budgetMs 总预算（默认 50000）——深推理模型可放宽
 * @returns { content, reasoning, model, provider } | null（未配置/全部失败返回 null，由调用方回退）
 */
async function chat(messages, { maxTokens, temperature = 0.6, thinking, timeoutMs = 20000, budgetMs = 50000, model, tier } = {}) {
  const cfg = resolve();
  if (!cfg) return null;

  // 思考链会占用 max_tokens 预算：开启思考时自动抬高上限（实测 2000 会被长思考挤成"正文 0 字"）
  const requestedTokens = Number(maxTokens) || 0;
  let effMaxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.max(requestedTokens, thinking === 'enabled' ? 3200 : 2000));
  const safeMessages = boundedMessages(messages);

  const started = Date.now();
  const BUDGET_MS = budgetMs;

  // 候选链：角色指定模型优先 → 主模型 → 环境备用链 → （可选）本地兜底
  // candidateChain 同步解析、不发起任何网络请求；本地目标受 host 校验与 tier 路由约束。
  const targets = candidateChain({ model, tier });
  if (!targets.length) {
    console.warn('[AI云端] 候选链为空：无可用模型');
    return null;
  }

  // 冷却中的模型排到最后，优先使用健康的模型
  const ordered = [
    ...targets.filter((t) => !isCoolingDown(t)),
    ...targets.filter((t) => isCoolingDown(t)),
  ];

  let lastErr = null;
  let lastStatus = null;
  let queueWaitMs = 0; // 排队等待不消耗调用预算（见 limited 注释）

  for (const t of ordered) {
    for (const attempt of [0, 1]) {
      if (attempt) await sleep(1200);
      const remain = BUDGET_MS + queueWaitMs - (Date.now() - started);
      if (remain < 4000) break;
      const body = { model: t.model, messages: safeMessages, max_tokens: effMaxTokens, temperature, stream: false };
      if (t.provider === 'zhipu' && thinking !== undefined && /glm-4\.[5-9]/.test(t.model)) {
        body.thinking = { type: thinking };
      }
      try {
        const { value: res, waitedMs } = await limited(t.provider, () => axios.post(
          `${t.base}/chat/completions`,
          body,
          { headers: { Authorization: `Bearer ${t.key}`, 'Content-Type': 'application/json' }, timeout: Math.min(timeoutMs, remain) },
        ));
        queueWaitMs += waitedMs;
        const msg = res.data?.choices?.[0]?.message ?? {};
        let content = null;
        const raw = msg.content;
        if (typeof raw === 'string') content = raw;
        else if (Array.isArray(raw)) content = raw.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
        else if (raw && typeof raw === 'object' && typeof raw.text === 'string') content = raw.text;
        if (!content) {
          // 空正文：多见于思考型模型把 token 预算全花在推理链上（实测 Qwen3.x 系列高发）。
          // 首次遇到时抬高上限重试一次，仍为空才换下一个模型——不能直接放弃整条链。
          lastStatus = 'empty';
          if (attempt === 0) {
            effMaxTokens = Math.min(MAX_OUTPUT_TOKENS, effMaxTokens * 2);
            continue;
          }
          break;
        }
        return {
          content,
          reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : null,
          model: t.model,
          provider: t.provider,
        };
      } catch (e) {
        lastErr = e;
        lastStatus = e.response?.status ?? null;
        if (lastStatus === 429 || lastStatus === 503) {
          // 限流/过载：标记冷却后立刻换下一个模型，不再原地重试浪费预算
          startCooldown(t, retryAfterMs(e));
          break;
        }
        if (lastStatus) break; // 认证/余额/参数错误：换模型也无意义，直接下一个
        // 超时/连接中断（无 HTTP 状态码）同样进入短暂冷却。
        // 否则一个"慢模型"会被后续每个角色反复撞上，逐个烧掉各自的调用预算，
        // 最终整批角色集体退化成规则引擎。
        startCooldown(t, Math.min(COOLDOWN_MS, 20_000));
        break;
      }
    }
    if (!isCoolingDown(t)) {
      console.warn(`[AI云端:${t.provider}] 模型 ${t.model} 不可用（${lastStatus ?? '网络'}），切换下一备用…`);
    }
  }
  console.warn('[AI云端] 全部模型不可用:', lastStatus ?? lastErr?.message?.slice(0, 60));
  return null;
}

module.exports = {
  configured,
  chat,
  resolve,
  cooldownSnapshot,
  candidateChain,
  // 预设与白名单导出供**口径一致性校验**（T2 自配 API 的前端预设须与此同源，
  // 见 shared/llm-config.mjs 与 test/llm-config.test.cjs）。改动这两个常量即视为口径变更。
  PROVIDERS,
  FREE_MODELS,
};

