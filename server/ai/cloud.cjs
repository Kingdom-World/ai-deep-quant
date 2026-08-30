// ─────────────────────────────────────────────────────────────
// 云端大模型多供应商接入层 v2（OpenAI 兼容协议，全部国内直连）
//   支持供应商（AI_CLOUD_PROVIDER）：
//     zhipu       智谱 BigModel —— glm-4.7-flash 永久免费，思考模式返回真实思考链（推荐）
//     siliconflow 硅基流动 —— 部分模型免费（免费名单随平台调整，见其公告）
//     dashscope   阿里百炼 —— 新用户各模型免费额度
//     custom      任意 OpenAI 兼容端点（需 AI_CLOUD_BASE_URL，含自建/微调模型）
//   · 推理模型自动解析 reasoning_content（DeepSeek/GLM 思考链风格）
//   · 本机只发起 HTTP 请求，不做任何模型计算
// ─────────────────────────────────────────────────────────────
const axios = require('axios');

const PROVIDERS = {
  zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4' },
  siliconflow: { base: 'https://api.siliconflow.cn/v1' },
  dashscope: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  custom: { base: '' }, // 必须配 AI_CLOUD_BASE_URL
};

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

/**
 * 调用云端模型对话
 * @returns { content, reasoning } | null（未配置/失败返回 null，由调用方回退）
 */
async function chat(messages, { maxTokens = 2000, temperature = 0.6, timeout = 45000, thinking } = {}) {
  const cfg = resolve();
  if (!cfg) return null;

  // 模型故障转移链：主模型 → AI_CLOUD_FALLBACK_MODELS（逗号分隔，应对免费模型高峰拥塞 429）
  const models = [
    cfg.model,
    ...(process.env.AI_CLOUD_FALLBACK_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean),
  ];
  const delays = [0, 1000, 3000]; // 429 退避：1s → 3s
  let lastErr = null;
  let lastStatus = null;

  for (const model of models) {
    for (const delay of delays) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const body = { model, messages, max_tokens: maxTokens, temperature, stream: false };
      // 智谱 GLM-4.5+ 思考模式开关（老模型不传该参数）
      if (cfg.provider === 'zhipu' && thinking !== undefined && /glm-4\.[5-9]/.test(model)) {
        body.thinking = { type: thinking };
      }
      try {
        const res = await axios.post(
          `${cfg.base}/chat/completions`,
          body,
          { headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' }, timeout },
        );
        const msg = res.data?.choices?.[0]?.message ?? {};
        // content 归一化：思考模式下可能返回分段数组，拼接 text 片段
        let content = null;
        const raw = msg.content;
        if (typeof raw === 'string') content = raw;
        else if (Array.isArray(raw)) content = raw.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
        else if (raw && typeof raw === 'object' && typeof raw.text === 'string') content = raw.text;
        if (!content) return null;
        return { content, reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : null, model };
      } catch (e) {
        lastErr = e;
        lastStatus = e.response?.status ?? null;
        if (lastStatus && lastStatus !== 429 && lastStatus !== 503) break; // 认证/参数错误换模型也无意义
      }
    }
    console.warn(`[AI云端:${cfg.provider}] 模型 ${model} 不可用（${lastStatus ?? '网络'}），尝试备用模型…`);
  }
  console.warn(`[AI云端:${cfg.provider}] 全部模型不可用:`, lastStatus ?? lastErr?.message?.slice(0, 60));
  return null;
}

module.exports = { configured, chat, resolve };
