// ─────────────────────────────────────────────────────────────
// T2 自配 API 配置 —— 纯逻辑层（跨栈：前端 import，Node 测试 require）
//
//   设计要点（L1.1，方案书「十一、LLM 能力三档分层」）：
//   · 本模块**只做纯逻辑**：校验、归一化、序列化。不直接碰 localStorage/浏览器 API，
//     存储层由调用方注入 —— 这样 Node 侧可以直接单测，不需要 jsdom。
//   · key 只存**用户自己的浏览器**，永不上传服务端（T2 的核心承诺）。
//   · 与 server/ai/cloud.cjs 的 PROVIDERS 保持同一份预设，避免两处口径分叉。
// ─────────────────────────────────────────────────────────────

/** 供应商预设（与 server/ai/cloud.cjs:16 PROVIDERS 同源同口径） */
export const PROVIDERS = {
  zhipu: { label: '智谱 BigModel', base: 'https://open.bigmodel.cn/api/paas/v4' },
  siliconflow: { label: '硅基流动', base: 'https://api.siliconflow.cn/v1' },
  dashscope: { label: '阿里百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  custom: { label: '自定义端点', base: '' },
};

/** 各供应商的免费白名单模型（**仅作下拉提示**；T2 是用户自己的 key，不受平台白名单约束） */
export const SUGGESTED_MODELS = {
  zhipu: ['glm-4.7-flash', 'glm-4-flash-250414', 'glm-4-flash'],
  siliconflow: [
    'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
    'THUDM/GLM-Z1-9B-0414',
    'THUDM/GLM-4-9B-0414',
    'Qwen/Qwen3.5-4B',
    'Qwen/Qwen3-8B',
  ],
  // 阿里百炼 compatible-mode 的常用模型（此前为空数组 ⇒ 模型名只能手打，极易写错成 404）
  dashscope: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
  custom: [], // 自定义端点的模型名只有使用者自己知道，保持为空
};

// ─────────────────────────────────────────────────────────────
// 能力标注（§12.6 欠账 #4）
//
//   🔴 为什么必须显式标注而非默认：
//     用户会理所当然地认为"接了 AI 就能看图"。实测 `glm-4.7-flash`
//     **不支持视觉输入**（返回 400 / code 1210，`content.type` 仅接受 `['text']`），
//     而它是本平台的默认推荐模型（免费白名单首位）。
//     ⇒ 不标注 = 用户传图必失败且不知道为什么。
//
//   🔴 判定纪律：**只标"实测确认支持"的模型，其余一律不标**。
//     不写"推测支持"、不写"应该可以"——能力标注错了比不标更糟
//     （用户会照着标注去用，然后失败）。
//     依据：智谱官方多模态系列命名（`-v` 后缀 = vision）+ 实测。
// ─────────────────────────────────────────────────────────────

/** 支持视觉输入的模型（**实测/官方多模态系列确认**） */
export const VISION_CAPABLE_MODELS = new Set([
  // 智谱多模态系列（官方多模态产品线，`v` = vision）
  'glm-4.1v-thinking-flash',
  'glm-4.6v-flash',
  'glm-4v-flash',
  'glm-4v-plus',
]);

/**
 * 模型是否支持视觉输入。
 * 🔴 **未知一律返回 false**（fail closed）：宁可少标也不误标 ——
 *    误标会让用户按错误前提去用（"我以为它能看图"），比不标更糟。
 * @param {string} model 模型名（大小写不敏感）
 * @returns {boolean}
 */
export function supportsVision(model) {
  return VISION_CAPABLE_MODELS.has(String(model || '').trim().toLowerCase());
}

/**
 * 取模型的能力提示（用于 UI 徽标）；不支持/未知返回 null（不显示徽标）。
 * @param {string} model
 * @returns {{vision: true, label: string, title: string} | null}
 */
export function capabilityBadge(model) {
  if (!supportsVision(model)) return null;
  return {
    vision: true,
    label: '可读图',
    title: '该模型支持视觉输入（可读截图/图片）。注：本平台的 AI 助手当前未开放上传图片的入口。',
  };
}

export const STORAGE_KEY = 'aiq.llm.byok.v1';

/** 把用户输入归一化为可用的配置对象；字段缺失返回带 errors 的结果 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const provider = Object.prototype.hasOwnProperty.call(PROVIDERS, src.provider) ? src.provider : 'zhipu';
  const preset = PROVIDERS[provider];
  // custom 必须自带 base；其余供应商允许覆盖 base（代理场景），缺省回落预设
  const base = String(src.base || '').trim() || preset.base;
  const model = String(src.model || '').trim();
  const key = String(src.key || '').trim();

  const errors = [];
  if (!key) errors.push('缺少 API Key');
  if (!model) errors.push('缺少模型名');
  if (!base) errors.push('缺少接口地址（自定义端点必填）');
  if (base && !/^https?:\/\//i.test(base)) errors.push('接口地址必须以 http(s):// 开头');

  return {
    provider,
    base,
    model,
    key,
    errors,
    ok: errors.length === 0,
    // 是否走用户自备 key（T2 判定用；与 ok 等价，单独给出便于语义化引用）
    byok: errors.length === 0,
  };
}

/** 从存储读取字符串并解析；任何异常都返回 null（不抛） */
export function parseStored(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object') return null;
    return normalizeConfig(o);
  } catch {
    return null;
  }
}

/** 序列化为存储字符串（**只存这四个字段**，不夹带其它信息） */
export function serializeConfig(cfg) {
  const n = normalizeConfig(cfg);
  return JSON.stringify({ provider: n.provider, base: n.base, model: n.model, key: n.key });
}

/**
 * 创建带注入存储的配置管理器。
 * @param store 形如 { getItem(k), setItem(k,v), removeItem(k) }（浏览器传 localStorage）
 */
export function createConfigStore(store) {
  const safe = store && typeof store.getItem === 'function' ? store : null;
  return {
    load() {
      if (!safe) return null;
      try {
        return parseStored(safe.getItem(STORAGE_KEY));
      } catch {
        return null; // 隐私模式等 getItem 抛异常的情形
      }
    },
    save(cfg) {
      const n = normalizeConfig(cfg);
      if (!n.ok) return { ok: false, errors: n.errors };
      if (!safe) return { ok: false, errors: ['当前环境不支持本地存储'] };
      try {
        safe.setItem(STORAGE_KEY, serializeConfig(n));
        return { ok: true };
      } catch {
        return { ok: false, errors: ['写入本地存储失败（可能处于隐私模式）'] };
      }
    },
    clear() {
      if (!safe) return;
      try {
        safe.removeItem(STORAGE_KEY);
      } catch {
        /* 清理失败不阻塞 */
      }
    },
    /** 掩码展示用：只露首尾，避免界面泄露完整 key */
    maskedKey() {
      const cfg = this.load();
      return cfg && cfg.key ? maskKey(cfg.key) : '';
    },
  };
}

/** key 掩码：sk-abc...xyz 形式（保留首 6 尾 4） */
export function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 12) return k ? '****' : '';
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/** 供 UI 提示：T2 的能力边界（与方案书 11.4 同口径，避免各处硬编码文案分叉） */
export const TIER_NOTES = {
  rule: '本机规则引擎产出，无需任何 API Key。全部 13 角色由确定性规则计算，LLM 不参与。',
  byok: '使用你自己的 API Key，请求由浏览器直接发往供应商，不经过本站服务器，本站不保存你的 Key。',
  platform: '使用平台预置的云端模型（免费白名单模型）。仅管理员可用。',
};
