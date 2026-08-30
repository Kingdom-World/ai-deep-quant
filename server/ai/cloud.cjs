// ─────────────────────────────────────────────────────────────
// 云端专家模型客户端（OpenAI 兼容协议）
//   · 环境变量（.env 或系统环境变量）：AI_CLOUD_BASE_URL / AI_CLOUD_API_KEY / AI_CLOUD_MODEL
//   · 未配置 → configured() 返回 false，QA 自动回退本地规则引擎
//   · 本机只发起 HTTP 请求，不做任何模型计算（云端推理）
// ─────────────────────────────────────────────────────────────
const axios = require('axios');

function configured() {
  return Boolean(process.env.AI_CLOUD_BASE_URL && process.env.AI_CLOUD_API_KEY && process.env.AI_CLOUD_MODEL);
}

async function chat(messages, { maxTokens = 1000, temperature = 0.5, timeout = 30000 } = {}) {
  if (!configured()) return null;
  try {
    const res = await axios.post(
      `${String(process.env.AI_CLOUD_BASE_URL).replace(/\/$/, '')}/chat/completions`,
      { model: process.env.AI_CLOUD_MODEL, messages, max_tokens: maxTokens, temperature, stream: false },
      { headers: { Authorization: `Bearer ${process.env.AI_CLOUD_API_KEY}`, 'Content-Type': 'application/json' }, timeout },
    );
    return res.data?.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.warn('[AI云端] 调用失败，回退本地引擎:', e.message?.slice(0, 80));
    return null;
  }
}

module.exports = { configured, chat };
