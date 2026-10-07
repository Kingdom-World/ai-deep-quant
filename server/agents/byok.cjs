// ─────────────────────────────────────────────────────────────
// BYOK（自配 API）全流水线 · 请求级配置校验
//
//   职责：把前端下传的 { provider, base, key, model } 解析为服务端
//   单次流水线调用的覆盖配置。铁律：
//     · key只存于当次请求内存（→ AsyncLocalStorage → cloudAI.chat），
//       不落盘、不进日志、不进 trace/报告、不写任何全局状态；
//     · 不做 FREE_MODELS 白名单拦截——费用由用户自己的账户承担，
//       与 T2 浏览器直连通道同一口径（谁提供算力谁担成本）；
//     · 校验失败一律返回 null（走既有 403/规则引擎路径），不回显原始值。
//
//   🔴 SSRF 防护（本文件存在的第二道理由，2026-10-07 补）：
//     `base` 由**前端下送** ⇒ 若只校验 `^https?://`，用户可让**我们的服务器**
//     去请求内网/云元数据端点。判定走 `shared/ssrf.cjs` 单一源（零 IO 纯函数）。
//     ⚠️ 挡不住 DNS rebinding（攻击者让域名先解析到公网、后解析到内网）——
//     那是"防攻击"级别的机制；本处定位是**防误用**，已在 ssrf.cjs 文件头声明。
//     🔴 注意方向：cloud.cjs 的 `isLocalHostAllowed` 是"**允许**内网"
//     （本地兜底通道专用），与此处"**拒绝**内网"相反，两者不可复用。
// ─────────────────────────────────────────────────────────────

const { assertPublicEgressUrl } = require('../../shared/ssrf.cjs');

const KNOWN_PROVIDERS = new Set(['zhipu', 'siliconflow', 'dashscope', 'custom']);

/** 长度上限：防滥用（真实 key/模型名远小于此） */
const LIMITS = { base: 300, key: 256, model: 120 };

/**
 * @param {unknown} raw 前端 body.byok
 * @returns {{provider,string base,key,model} | null} 合法返回覆盖配置；非法返回 null
 */
function normalizeByokOverride(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const base = String(raw.base ?? '').trim().replace(/\/+$/, '');
  const key = String(raw.key ?? '').trim();
  const model = String(raw.model ?? '').trim();
  const provider = KNOWN_PROVIDERS.has(raw.provider) ? String(raw.provider) : 'custom';
  if (!/^https?:\/\//i.test(base)) return null;
  // 🔴 SSRF 闸门：协议白名单 + 拒绝本机/内网/链路本地/元数据端点。
  //    放在长度校验之前 —— 无论是否超限，都不该被拿去打内网。
  if (!assertPublicEgressUrl(base).ok) return null;
  if (!key || !model) return null;
  if (base.length > LIMITS.base || key.length > LIMITS.key || model.length > LIMITS.model) return null;
  return { provider, base, key, model };
}

module.exports = { normalizeByokOverride, KNOWN_PROVIDERS, LIMITS };
