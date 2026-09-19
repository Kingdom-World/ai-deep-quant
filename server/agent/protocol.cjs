// ─────────────────────────────────────────────────────────────
// Agent 文本协议解析器（P1）
//
//   ⚠️ 主格式是「函数调用式」，**不是 JSON** —— 这是 R1 实测的结论，不是猜测：
//      28 次真实调用（`.tmpdir/probe/protocol*.cjs`）中：
//        · 纯 JSON（严格）通过率  0% ~ 5%
//        · JSON 宽松提取          0% ~ 5%
//        · 函数调用式            9/9（100%）
//      模型**每次都正确识别了工具与参数**，只是使用了它自己的语法。
//      即使 prompt 中明确要求"只输出 JSON、不要 markdown 围栏"，依然 100% 输出函数式。
//
//   ⇒ 设计原则：**适配模型的自然输出，而不是要求模型适配我们设计的格式。**
//
//   支持格式（按优先级）：
//     ① tool_name(a, b)                位置参数（最常见）
//     ② tool_name(k=v, k2=v2)          具名参数
//     ③ {"action":"tool","args":{...}} JSON（含 markdown 围栏内、或夹杂散文时截取）
// ─────────────────────────────────────────────────────────────

/** 去掉常见前后缀噪声：markdown 围栏、多余空白 */
function stripNoise(text) {
  let s = String(text ?? '').trim();
  const fence = s.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

/** 截取第一个**平衡**的花括号对象（忽略字符串内的括号） */
function firstBalancedObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 按逗号切分参数（忽略引号内逗号） */
function splitArgs(raw) {
  const parts = [];
  let buf = '';
  let quote = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** 去掉包裹的引号（成对才去） */
function unquote(v) {
  const s = String(v).trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 按契约声明的类型做强制转换；失败返回 { error } */
function coerce(value, type) {
  if (type === 'number') {
    const n = Number(unquote(value));
    return Number.isFinite(n) ? { value: n } : { error: `期望数字，得到 "${value}"` };
  }
  if (type === 'boolean') {
    const s = String(unquote(value)).toLowerCase();
    if (s === 'true' || s === '1') return { value: true };
    if (s === 'false' || s === '0') return { value: false };
    return { error: `期望布尔，得到 "${value}"` };
  }
  return { value: String(unquote(value)) }; // string 默认
}

/** 把「已解析出的原始键值」按工具契约绑定为最终 args（位置参数按 params 顺序） */
function bindArgs(raw, spec) {
  const params = spec?.params || [];
  const args = {};
  const errors = [];

  Object.keys(raw).forEach((k) => {
    if (/^arg\d+$/.test(k)) {
      const idx = Number(k.slice(3));
      const p = params[idx];
      if (!p) {
        errors.push(`位置参数超出工具签名（第 ${idx + 1} 个）`);
        return;
      }
      const c = coerce(raw[k], p.type);
      if (c.error) errors.push(`${p.name}: ${c.error}`);
      else args[p.name] = c.value;
      return;
    }
    const p = params.find((x) => x.name === k);
    if (!p) {
      errors.push(`未知参数 "${k}"`);
      return;
    }
    const c = coerce(raw[k], p.type);
    if (c.error) errors.push(`${p.name}: ${c.error}`);
    else args[p.name] = c.value;
  });

  // 必填校验 + 默认值
  for (const p of params) {
    if (args[p.name] === undefined) {
      if (p.default !== undefined) args[p.name] = p.default;
      else if (p.required) errors.push(`缺少必填参数 "${p.name}"`);
    }
  }
  return { args, errors };
}

/**
 * 工具名别名表（适配模型的自然输出，而非要求模型适配我们）
 *   M1 实测：模型偶尔把 knowledge_search 写成「知识_search」——
 *   它**认对了意图**，只是用了中文名。这种输出不该被判为 parseFail，
 *   否则一次正确意图的调用被浪费，还要多耗一轮。
 *   仅收录"意图明确唯一"的别名，不做模糊匹配（避免误绑定到别的工具）。
 */
const TOOL_ALIASES = {
  知识_search: 'knowledge_search',
  知识搜索: 'knowledge_search',
  知识库搜索: 'knowledge_search',
  知识库检索: 'knowledge_search',
  知识检索: 'knowledge_search',
  查知识: 'knowledge_search',
};

/** 别名归一：输入可能是中文别名，返回规范工具名 */
function canonicalToolName(name) {
  const n = String(name || '').trim();
  return TOOL_ALIASES[n] || n;
}

/**
 * 解析模型输出为工具调用
 * @param text 模型原始输出
 * @param tools 工具清单 [{ name, desc, params:[{name,type,required,default}] }]
 * @returns { action, args, format, errors } | null（完全无法识别时）
 */
function parseToolCall(text, tools = []) {
  const names = tools.map((t) => t.name);
  const specOf = (name) => tools.find((t) => t.name === canonicalToolName(name));
  // 正则候选名 = 规范名 + 意图唯一的别名（转义后拼接，避免别名含正则元字符时炸正则）
  const aliases = Object.keys(TOOL_ALIASES).filter((a) => names.includes(TOOL_ALIASES[a]));
  const escaped = [...new Set([...names, ...aliases])].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  // ── ① 函数调用式（主格式）──
  //    ⚠️ 括号必须存在：否则 JSON 输入（如 {"action":"get_klines",...}）里出现的
  //       "get_klines" 字符串会被抢先匹配，导致被误判为「无参调用」而丢掉 args。
  const fc = String(text ?? '').match(new RegExp(`(${escaped.join('|')})\\s*\\(([^)]*)\\)`));
  if (fc) {
    const name = canonicalToolName(fc[1]);
    const rawArgs = fc[2].trim();
    const raw = {};
    if (rawArgs) {
      splitArgs(rawArgs).forEach((part, i) => {
        const eq = part.indexOf('=');
        // 具名参数（且等号左侧是合法标识符）才按名字绑定
        if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(part.slice(0, eq).trim())) {
          raw[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
        } else {
          raw[`arg${i}`] = part;
        }
      });
    }
    const { args, errors } = bindArgs(raw, specOf(name));
    return { action: name, args, format: 'funcCall', errors };
  }

  // ── ② JSON（兼容分支）──
  const s = stripNoise(text);
  const candidates = [];
  try {
    candidates.push(JSON.parse(s));
  } catch { /* 继续尝试截取 */ }
  const bal = firstBalancedObject(s);
  if (bal) {
    try {
      candidates.push(JSON.parse(bal));
    } catch { /* 花括号截取也失败 */ }
  }
  for (const o of candidates) {
    if (!o || typeof o !== 'object') continue;
    const rawAction = typeof o.action === 'string' ? o.action : typeof o.name === 'string' ? o.name : null;
    if (!rawAction) continue;
    const action = canonicalToolName(rawAction); // 中文别名同样归一
    const isKnown = names.includes(action);
    const rawIn = o.args && typeof o.args === 'object' ? o.args : {};
    const raw = {};
    Object.entries(rawIn).forEach(([k, v]) => {
      raw[k] = v;
    });
    const { args, errors } = bindArgs(raw, specOf(action));
    if (!isKnown) errors.push(`未知工具 "${action}"`);
    return { action, args, format: 'json', errors };
  }

  return null;
}

/** 渲染工具清单为 prompt 文本（供 system prompt 使用） */
function renderToolSpec(tools = []) {
  const lines = ['可调用工具：'];
  for (const t of tools) {
    const sig = (t.params || [])
      .map((p) => (p.required ? p.name : `${p.name}?`))
      .join(', ');
    lines.push(`- ${t.name}(${sig})  ${t.desc || ''}`);
  }
  return lines.join('\n');
}

module.exports = { parseToolCall, renderToolSpec, bindArgs, coerce, splitArgs, canonicalToolName, TOOL_ALIASES };
