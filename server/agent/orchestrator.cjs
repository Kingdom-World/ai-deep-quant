// ─────────────────────────────────────────────────────────────
// Agent 编排层（P2）—— 把「模型输出」变成「受控的工具循环」
//
//   本模块实现了红队审查（red-team-p2）后修正的全部防护：
//
//   F1  final 哨兵：final 也走函数式协议（final(结论)），由解析器统一识别。
//       这解决了「解析失败 vs 模型给出结论」无法区分的问题——
//       也顺带消除了「终稿里提到 run_backtest() 被误当空参调用」的翻车场景
//       （提及而非调用时，因缺必填参数 errors 非空 → 不执行、要求修正）。
//   F2  整体墙钟上限（默认 180s）：免费模型单轮可挂 90s，无墙钟则最坏 9 分钟挂起。
//   F3  指纹幂等校验只针对**确定性工具**（回测/扫描/因子评估），
//       显式排除 get_quote/get_klines/get_news（实时源天然变指纹）；
//       触发后**立即转 finalize**，不让模型空转烧轮。
//   F4  去重键建立在**类型强制之后**并做规范化（键排序 + 字符串 trim/小写），
//       否则 "500" vs 500、键序不同都会绕过。
//   F5  解析失败**不回灌原文**（避免强化错误），改为纠正注记；
//       连续失败 ≥2 次转 finalize，不再浪费轮次。
//   F6  工具 summary 按**行**截断（不切半行），超预算注明剩余行数。
//   F7  实际使用模型 ≠ 角色指定模型时，degraded 置位并在结果中如实标注
//       （实测 22 次调用中 13+9 次发生模型回退，用户必须知道结论出自谁）。
//   F9  解析出的调用若带 errors，**不执行**，回灌错误要求修正。
//   F13 审计轨迹**每步增量落盘 JSONL**（崩溃可复盘）。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { parseToolCall, renderToolSpec } = require('./protocol.cjs');

/** final 哨兵：作为"工具"注入协议清单，让解析器统一识别（F1） */
const FINAL_TOOL = {
  name: 'final',
  desc: '信息足够时调用它输出最终结论并结束',
  params: [{ name: 'answer', type: 'string', required: true }],
};

/** 确定性工具：可复现是硬要求，指纹漂移即异常（F3） */
const DETERMINISTIC_TOOLS = new Set(['run_backtest', 'run_param_scan', 'eval_factors']);

/**
 * 从"不守协议的输出"里尽量取出真正的结论文本
 *   场景：模型本该输出 final("...")，却输出了 {"结论": "..."} 或 {"answer": "..."}
 *   （TOOL_RULES 第 5 条明确禁止，但实测仍会发生）。内容通常是对的，
 *   把 JSON 原文当结论给用户看既难读又显得系统粗糙，故做一次保守提取。
 *   保守原则：只认"对象里恰好有一个已知结论键且为字符串"的情形；
 *   解析不出来就原样返回（不猜测、不做字符串裁剪）。
 */
function extractAnswerFromText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return raw;
  const s = (() => {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return fence ? fence[1].trim() : raw;
  })();
  if (!s.startsWith('{')) return raw;
  try {
    const o = JSON.parse(s);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return raw;
    for (const k of ['结论', 'answer', 'result', 'final']) {
      if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
    }
    return raw;
  } catch {
    return raw;
  }
}

const DEFAULTS = {
  maxRounds: 6,
  contextBudget: 12000, // 工具回灌 + 模型输出的字符总预算（软上限，触发即转 finalize）
  maxWallClockMs: 180_000, // F2：整体墙钟
  summaryMax: 800, // 单条工具回灌上限
  consecutiveFailLimit: 2, // 连续解析失败次数上限（F5）
};

/** 进程内结果缓存：跨角色共享（P3 的 13 角色并行会复用），键 = 规范化(tool+args) */
const resultCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 规范化键：键排序 + 字符串 trim/小写 + 纯数字字符串转数值（F4）
 *  "500" 与 500 必须归一，否则模型第二次用 JSON 传数值就会绕过去重 */
function canonicalKey(tool, args) {
  const norm = (o) => {
    if (Array.isArray(o)) return o.map(norm);
    if (o && typeof o === 'object') {
      return Object.keys(o)
        .sort()
        .reduce((acc, k) => {
          acc[k] = norm(o[k]);
          return acc;
        }, {});
    }
    if (typeof o === 'string') {
      const t = o.trim().toLowerCase();
      const n = Number(t);
      return t !== '' && Number.isFinite(n) ? n : t;
    }
    return o;
  };
  return `${tool}:${JSON.stringify(norm(args || {}))}`;
}

/** 按行截断（不切半行），超预算时注明剩余行数（F6） */
function truncateByLine(s, max) {
  const text = String(s ?? '');
  if (text.length <= max) return text;
  const lines = text.split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i += 1) {
    if ((out + lines[i] + '\n').length > max) {
      const rest = lines.length - i;
      return `${out}\n（其余 ${rest} 条已省略，见完整报告）`.trim();
    }
    out += `${lines[i]}\n`;
  }
  return out;
}

/**
 * 运行一次研究循环
 * @param opts { question, toolbox, chat, roleCard?, model?, uid?, maxRounds?, contextBudget?, maxWallClockMs? }
 * @returns { ok, answer, draft, reason, rounds, degraded, actualModel, trace, traceFile }
 */
async function runResearch(opts = {}) {
  const { question, toolbox, chat, roleCard = '', uid = '' } = opts;
  if (!toolbox || typeof toolbox.call !== 'function' || typeof chat !== 'function') {
    return { ok: false, error: '缺少 toolbox 或 chat' };
  }

  const maxRounds = Math.max(2, Math.min(Number(opts.maxRounds) || DEFAULTS.maxRounds, 12));
  // 预算：显式传值则尊重（测试/特殊场景需要极小值），未传用默认 12000
  const contextBudget = Number(opts.contextBudget) > 0 ? Number(opts.contextBudget) : DEFAULTS.contextBudget;
  // 墙钟：显式传值则尊重（测试需要极小值），未传用默认 180s
  const maxWallClockMs = Number(opts.maxWallClockMs) > 0 ? Number(opts.maxWallClockMs) : DEFAULTS.maxWallClockMs;
  const summaryMax = Math.max(200, Number(opts.summaryMax) || DEFAULTS.summaryMax);
  const failLimit = Math.max(1, Number(opts.consecutiveFailLimit) || DEFAULTS.consecutiveFailLimit);
  const roleModel = opts.model ? String(opts.model) : null;

  const spec = [...toolbox.spec, FINAL_TOOL];
  const systemPrompt = [
    roleCard,
    renderToolSpec(spec),
    '工具调用规则：',
    '1. 需要数据时，只输出一行函数调用（如 get_klines("sh600519", 500)），不要输出其他文字。',
    '2. 信息足够时，调用 final(你的完整结论) 结束。',
    '3. 结论中的数字必须来自工具返回的数据，不得编造。',
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: String(question || '') },
  ];

  const trace = [];
  const usedCalls = new Map(); // canonicalKey → { count, fingerprint, summary, result }
  const blacklisted = new Set(); // 指纹漂移的工具
  let contextUsed = 0;
  let degraded = false;
  let actualModel = null;
  let reason = 'maxRounds';
  let answer = null;
  let draft = null;
  let consecutiveFails = 0;
  let finalizeMode = false;

  const jobId = `agent-${Date.now()}`;
  const traceDir = path.join(process.cwd(), 'data', 'agent-trace');
  const traceFile = path.join(traceDir, `${jobId}.jsonl`);
  try {
    fs.mkdirSync(traceDir, { recursive: true });
  } catch { /* 目录失败不阻塞 */ }

  /** 轨迹：内存 + 增量落盘（F13，崩溃可复盘）。同步写：单条极小，且保证测试/调用方能立即读到 */
  const recordTrace = (entry) => {
    const e = { ts: new Date().toISOString(), ...entry };
    trace.push(e);
    try {
      fs.appendFileSync(traceFile, `${JSON.stringify(e)}\n`, 'utf8');
    } catch { /* 落盘失败不阻塞主流程 */ }
  };

  const started = Date.now();
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    if (Date.now() - started > maxWallClockMs) {
      reason = 'timeout';
      degraded = true;
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    const r = await chat(messages, { model: roleModel, maxTokens: 900, temperature: 0.4 });
    if (!r || typeof r.content !== 'string' || !r.content.trim()) {
      reason = 'modelFail';
      degraded = true;
      recordTrace({ step: round, event: 'modelFail' });
      break;
    }
    if (roleModel && r.model && r.model !== roleModel) {
      // F7：被回退到备用模型，必须如实标注
      degraded = true;
      actualModel = r.model;
    }
    draft = r.content;
    contextUsed += r.content.length;

    const parsed = parseToolCall(r.content, spec);

    // ── 解析失败（既非工具也非 final）──
    if (!parsed) {
      consecutiveFails += 1;
      recordTrace({ step: round, event: 'parseFail', preview: r.content.slice(0, 120) });
      if (consecutiveFails >= failLimit || finalizeMode) {
        // F5：连续不守协议 → 把纯文本当结论，但如实标注降级
        //   M1 补强：模型常输出 {"结论": "..."}（TOOL_RULES 第 5 条明确禁止但仍会发生），
        //   内容是对的、只是格式不对。此处**提取结论字段**而不是把 JSON 原文丢给用户——
        //   degraded 标记照常保留（结论可靠性仍下降），但可读性不该为模型的格式错误买单。
        answer = extractAnswerFromText(r.content);
        reason = 'finalize';
        degraded = true;
        recordTrace({ step: round, event: 'finalizeByParseFail' });
        break;
      }
      messages.push({
        role: 'user',
        content:
          '（系统提示）上一次输出不符合协议。需要数据请只输出一行 tool(args)；信息已足够请输出 final(结论)。',
      });
      continue;
    }
    consecutiveFails = 0;

    // ── final 哨兵（F1）──
    if (parsed.action === 'final') {
      if (parsed.errors.length) {
        messages.push({ role: 'user', content: `（系统提示）final 需要 answer 参数：${parsed.errors.join('; ')}` });
        continue;
      }
      answer = parsed.args.answer;
      reason = 'final';
      recordTrace({ step: round, event: 'final', chars: String(answer).length });
      break;
    }

    // ── 参数错误：不执行，要求修正（F9）──
    if (parsed.errors.length) {
      messages.push({ role: 'tool', content: `参数错误：${parsed.errors.join('; ')}。请修正参数后重新调用。` });
      recordTrace({ step: round, tool: parsed.action, event: 'argErrors', errors: parsed.errors });
      continue;
    }

    // ── 工具被列入黑名单（指纹漂移，F3/F14）──
    if (blacklisted.has(parsed.action)) {
      finalizeMode = true;
      messages.push({
        role: 'user',
        content: `（系统提示）工具 ${parsed.action} 因数据指纹不稳定已被禁用。请基于已有信息立即调用 final(结论)，并注明该限制。`,
      });
      continue;
    }

    // ── 上下文预算（F10：把模型输出也计入）──
    if (contextUsed > contextBudget) {
      finalizeMode = true;
      degraded = true; // 预算耗尽 = 研究不充分，属降级
      messages.push({
        role: 'user',
        content: '（系统提示）上下文预算已用尽。请基于已有信息立即调用 final(结论)，不要再调用工具。',
      });
      continue;
    }

    const key = canonicalKey(parsed.action, parsed.args);
    const prev = usedCalls.get(key);

    // ── 同参第三次起：直接回灌缓存（防死循环烧资源）──
    if (prev && prev.count >= 2) {
      messages.push({
        role: 'tool',
        content: `（重复调用，结果与上次一致，已在上下文中）${prev.summary}\n（提示：数据已获取，请直接使用；信息足够请调用 final(结论) 收尾。）`,
      });
      recordTrace({ step: round, tool: parsed.action, event: 'dedupHit', canonicalKey: key });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const res = await toolbox.call(parsed.action, parsed.args);
    const fpHash = res.ok && res.dataFingerprint ? res.dataFingerprint.data?.rowsHash ?? null : null;

    // ── 指纹幂等校验：只针对确定性工具（F3）──
    if (res.ok && DETERMINISTIC_TOOLS.has(parsed.action) && prev && prev.fingerprint && fpHash && prev.fingerprint !== fpHash) {
      blacklisted.add(parsed.action);
      degraded = true;
      finalizeMode = true;
      reason = 'fingerprintBlocked';
      recordTrace({
        step: round,
        tool: parsed.action,
        event: 'fingerprintBlocked',
        prevFingerprint: prev.fingerprint,
        newFingerprint: fpHash,
      });
      messages.push({
        role: 'user',
        content:
          `（系统提示）${parsed.action} 对相同参数返回了不同数据指纹，数据源存在不稳定，该工具已被禁用。` +
          '请基于已有信息立即调用 final(结论)，并在结论中注明数据源存在不稳定。',
      });
      continue;
    }

    usedCalls.set(key, {
      count: (prev?.count ?? 0) + 1,
      fingerprint: fpHash ?? prev?.fingerprint ?? null,
      summary: res.summary,
      result: res,
    });

    const truncated = truncateByLine(res.summary, summaryMax);
    contextUsed += truncated.length;
    messages.push({ role: 'tool', content: truncated });
    // 轮次压力：最后两轮注入收尾提醒，避免模型把轮次耗在重复取证上
    if (round >= maxRounds - 1 && !finalizeMode) {
      messages.push({
        role: 'user',
        content: '（系统提示）剩余轮次已不多。请基于已有信息立即调用 final(结论) 收尾；除非缺少关键数据，不要再调用工具。',
      });
    }
    recordTrace({
      step: round,
      tool: parsed.action,
      args: parsed.args,
      data: res.data ?? null, // 工具原始数据（P5 数值保真：与模型结论并列展示，LLM 只做解读）
      fingerprint: res.dataFingerprint?.data ?? null,
      ok: res.ok,
      summary: truncated,
      elapsedMs: Date.now() - started,
      model: r.model ?? null,
    });
  }

  // P5 数值保真：把工具的原始输出原样带出，与模型 final 并列展示。
  //   模型复述数值不可靠（P3 实测：工具返回约 -75%，final 却说 0%）——
  //   规则引擎算出的数字必须不经模型之手直达用户（项目铁律「LLM 不做算术」的延伸）。
  //
  //   展示层按 (tool, args) 规范化**去重**（用户实测反馈"同一卡片刷三遍很无厘头"）：
  //   编排器允许同参重跑（第二次执行是幂等校验机会，红队 R-A/E 设计），trace 里会有重复条目——
  //   审计真实性由 trace 保障；toolData 只保留每个 (tool,args) 的**最后一次**结果并标注调用次数。
  const byKey = new Map();
  for (const t of trace) {
    if (!t.tool || !t.ok || t.data === undefined || t.data === null) continue;
    const k = canonicalKey(t.tool, t.args ?? {});
    const prev = byKey.get(k);
    byKey.set(k, {
      tool: t.tool,
      args: t.args ?? {},
      data: t.data,
      fingerprint: t.fingerprint,
      calls: (prev?.calls ?? 0) + 1,
    });
  }
  const toolData = Array.from(byKey.values());

  return {
    ok: reason === 'final' && answer !== null,
    answer,
    draft: answer === null ? draft : null,
    reason,
    rounds,
    degraded,
    actualModel,
    contextUsed, // 供前端展示"本次研究消耗了多少上下文"
    toolData,
    trace,
    traceFile: fs.existsSync(traceFile) ? traceFile : null,
  };
}

module.exports = { runResearch, canonicalKey, truncateByLine, FINAL_TOOL, DETERMINISTIC_TOOLS, resultCache, extractAnswerFromText };
