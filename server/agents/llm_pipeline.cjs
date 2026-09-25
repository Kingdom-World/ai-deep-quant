// ─────────────────────────────────────────────────────────────
// Agent 团队 · LLM 异步流水线（13 角色免费大模型协作版）
//   设计：确定性计算做骨架（指标/风控参数/加权裁决由规则引擎算），LLM 负责每个角色的
//   专业化叙事与辩论——LLM 只解读【注入的真实数据】，绝不臆造；单角色失败自动用规则引擎兜底。
//   记忆隔离：每个角色独立 messages；跨角色信息只经主理人中转摘要（digest/对手论点）传递。
//   进度：onProgress({ step, total, stage }) 供前端轮询。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudAI = require('../ai/cloud.cjs');
const { ROLES, BOUNDARIES, SEAT_ORDER } = require('./roles.cjs');
const {
  techAnalyst,
  fundamentalAnalyst,
  newsAnalyst,
  sentimentAnalyst,
  buildDigest,
  bullResearcher,
  bearResearcher,
  bullRebut,
  bearFinal,
  researchChief,
  trader,
  riskTrio,
  riskChief,
  DISCLAIMER,
} = require('./agents.cjs');

const TOTAL_STEPS = { full: 15, quick: 7, debate: 10, risk: 10, single: 1 };

// ─────────── A6 · 隔离运行时守卫 ───────────
// 记忆隔离原为提示词层面的约定（BOUNDARIES），代码层无断言，任何重构都可能无声击穿。
// 此处在「角色调用入口」加运行时断言：user content 若含其他角色的原文长片段，即判定违规。
const ISOLATION_MIN_OVERLAP = 40; // 连续逐字重合 ≥40 字符 → 原文泄漏
const REDACT_MARK = '【已按记忆隔离规则移除：其他角色原文片段】';

/** 在 src 中寻找出现在 text 里的连续片段（滑窗 + 向右扩展），未命中返回 '' */
function findVerbatimOverlap(text, src, minLen = ISOLATION_MIN_OVERLAP) {
  if (!text || !src || src.length < minLen) return '';
  const step = Math.max(1, Math.floor(minLen / 2));
  for (let i = 0; i + minLen <= src.length; i += step) {
    const win = src.slice(i, i + minLen);
    const at = text.indexOf(win);
    if (at >= 0) {
      let len = minLen;
      while (at + len < text.length && i + len < src.length && text[at + len] === src[i + len]) len += 1;
      return text.slice(at, at + len);
    }
  }
  return '';
}

/**
 * 隔离守卫：检测 userContent 是否混入其他角色的原文
 * @param {string} userContent  即将发给模型的 user 消息
 * @param {object} opts
 *   selfName   当前角色的 seat（不与自己比对）
 *   originals  [{ seat, report }] 其他角色的原文（仅用于比对，不发送）
 * @returns {{ ok: boolean, violations: Array }}
 */
function isolationGuard(userContent, { selfName = '', originals = [] } = {}) {
  const violations = [];
  for (const o of originals) {
    if (!o || !o.report || !o.seat || o.seat === selfName) continue;
    const hit = findVerbatimOverlap(String(userContent || ''), String(o.report));
    if (hit) violations.push({ seat: o.seat, length: hit.length, sample: hit.slice(0, 80) });
  }
  return { ok: violations.length === 0, violations };
}

/** 违规片段剥离（不静默放行）：命中即移除并在原位留痕 */
function redactViolations(userContent, violations) {
  let out = String(userContent || '');
  for (const v of violations) {
    // 用已记录片段的前 40 字符重新定位，剥离整段
    const anchor = String(v.sample || '').slice(0, ISOLATION_MIN_OVERLAP);
    if (!anchor) continue;
    const at = out.indexOf(anchor);
    if (at >= 0) out = out.slice(0, at) + REDACT_MARK + out.slice(at + (v.length || anchor.length));
  }
  return out;
}

// ─────────── C1 · 角色级审计日志 ───────────
// 只落盘元数据与哈希，不落原文，避免审计文件膨胀与隐私外泄。
const AUDIT_DIR = path.join(__dirname, '..', '..', 'data', 'agents', 'audit');
function auditLog(record) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(AUDIT_DIR, `${day}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
  } catch { /* 只读 FS / 磁盘异常忽略，不影响主流程 */ }
}
const sha1 = (s) => crypto.createHash('sha1').update(String(s || ''), 'utf8').digest('hex').slice(0, 16);

const isolationStats = { calls: 0, violations: 0, redactions: 0 };

/**
 * C2 · 数据完整度评估（动态编排判据）——独立导出以便验收脚本直接断言。
 * 缺失维度对应的 LLM 深化环节会被跳过（规则计算照常完成），避免"对空数据做深化"的无意义调用。
 */
function evaluateCoverage(feed) {
  return {
    fundamentals: Boolean(feed?.fundamentals && feed.fundamentals.roe != null) || feed?.valuation?.pe != null,
    news: Boolean((feed?.announcements?.length ?? 0) > 0 || (feed?.stockNews?.length ?? 0) > 0 || (feed?.marketNews?.length ?? 0) > 0),
    flow: Boolean(feed?.moneyFlow || feed?.marginData || feed?.northHold),
  };
}


/** 宽松 JSON 解析：剥掉代码块围栏与前后杂文 */
function parseJSONLoose(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(t.slice(s, e + 1));
  } catch {
    return null;
  }
}

/** 单角色调用：隔离守卫 → 系统卡 + 铁律 + 职责内数据 → 审计留痕；返回 { ok, json, ms, model, provider } */
async function callRole(card, rawUserContent, { maxTokens = 900, originals = [] } = {}) {
  const t0 = Date.now();
  // A6 · 发送前运行时断言：user content 混入其他角色原文即判定违规
  const guard = isolationGuard(rawUserContent, { selfName: card.seat, originals });
  let userContent = rawUserContent;
  if (!guard.ok) {
    isolationStats.violations += 1;
    isolationStats.redactions += 1;
    userContent = redactViolations(rawUserContent, guard.violations);
    auditLog({
      t: new Date().toISOString(),
      kind: 'isolation-violation',
      seat: card.seat,
      violations: guard.violations.map((v) => ({ seat: v.seat, length: v.length })),
      action: 'redacted',
      promptHash: sha1(rawUserContent),
      promptChars: String(rawUserContent).length,
    });
  }
  isolationStats.calls += 1;
  try {
    const out = await cloudAI.chat(
      [
        { role: 'system', content: `${card.system}\n\n${BOUNDARIES}` },
        { role: 'user', content: userContent },
      ],
      {
        maxTokens,
        temperature: 0.5,
        thinking: card.thinking ? 'enabled' : 'disabled',
        timeoutMs: card.timeoutMs,
        budgetMs: card.budgetMs,
        // 角色卡指定的模型置于链首：13 角色分饰多个模型，把负载分摊到 zhipu / 硅基流动，
        // 避免此前"全员打同一个 glm-4.7-flash"把它打到 429 后集体退化成规则引擎。
        model: card.model,
        // B4 · 角色分层路由：tier 供 cloud.cjs 决定是否优先本地端点（已配置时）
        tier: card.tier,
      },
    );
    const json = parseJSONLoose(out?.content);
    const ms = Date.now() - t0;
    auditLog({
      t: new Date().toISOString(),
      kind: 'role-call',
      seat: card.seat,
      tier: card.tier ?? null,
      model: out?.model ?? card.model ?? null,
      provider: out?.provider ?? null,
      ms,
      engine: json ? 'llm' : 'rule',
      promptHash: sha1(userContent),
      promptChars: String(userContent).length,
      outputChars: out?.content ? String(out.content).length : 0,
      guard: guard.ok ? 'ok' : 'redacted',
    });
    return json
      ? { ok: true, json, ms, model: out.model, provider: out.provider }
      : { ok: false, ms, model: out?.model, provider: out?.provider };
  } catch (e) {
    const ms = Date.now() - t0;
    auditLog({
      t: new Date().toISOString(),
      kind: 'role-call',
      seat: card.seat,
      tier: card.tier ?? null,
      model: card.model ?? null,
      provider: null,
      ms,
      engine: 'rule',
      error: String(e?.message || e).slice(0, 120),
      promptHash: sha1(userContent),
      promptChars: String(userContent).length,
      outputChars: 0,
      guard: guard.ok ? 'ok' : 'redacted',
    });
    return { ok: false, ms, err: e?.message };
  }
}

/**
 * C2 辅助 · 构建隔离比对基线：只把「主理人允许中转的字段」（findings 前 2 条）从原文中剔除，
 * 其余正文（数据快照/局限/其余发现）一律视为不可外传的原文——一旦出现在他人的输入里即为泄漏。
 */
function buildIsolationOriginals(agents) {
  return (agents ?? []).map((a) => {
    let report = String(a?.report ?? '');
    for (const f of (a?.findings ?? []).slice(0, 2)) {
      if (f) report = report.split(f).join('');
    }
    // 注意：调用方传的是 { seat, report, findings }（seat 为角色卡座位名）；
    // 兼容 seatName/name 只是防御性写法，实际以 seat 为准——早期版本只读 seatName/name，
    // 导致座位名解析为空串、守卫恒不触发（隔离形同虚设），此处已修正。
    return { seat: a?.seat ?? a?.seatName ?? a?.name ?? '', report, allowKey: true };
  });
}

const clampConf = (v, fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(10, Math.min(90, Math.round(n))) : fb;
};
const validBias = (v) => (['bullish', 'bearish', 'neutral'].includes(v) ? v : null);
const strArr = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, n) : null);

/** 分析师报告重组：LLM 摘要/发现/独立发现 + 规则报告的数据与局限尾部 */
function analystReport(ruleReport, llm, ruleFindings) {
  const tailIdx = ['## 数据快照', '## 财务趋势', '## 数据来源', '## 局限']
    .map((h) => ruleReport.indexOf(h))
    .filter((i) => i > 0);
  const tail = tailIdx.length ? '\n' + ruleReport.slice(Math.min(...tailIdx)) : '';
  const findings = (llm?.findings ?? ruleFindings ?? []).map((f) => '- ' + f);
  const independents = (llm?.independents ?? []).map((f) => '- ' + f);
  return [
    '## 摘要',
    llm?.summary ?? '',
    '',
    '## 核心发现',
    ...findings,
    ...(independents.length ? ['', '## 独立发现（AI 依据注入数据的自主观察）', ...independents] : []),
  ].join('\n') + tail;
}

/** 分析师角色：规则计算 → LLM 叙事 → 合并（失败回退规则全量） */
async function analystStep(key, rule, dataSlice, onStep) {
  const card = ROLES[key];
  const user =
    `【你的任务】基于以下注入数据，以${card.seat}的身份输出 JSON：` +
    `{"summary":"2-3 句摘要","findings":["核心发现 4-6 条，每条必须引用注入的具体数值"],` +
    `"independents":["独立发现 1-3 条：系统初步发现未覆盖、但你能从注入数据边界内严谨推出的观察；确无则给空数组"],` +
    `"bias":"bullish|bearish|neutral","confidence":10-90 整数}\n\n` +
    `【注入数据】\n标的: ${dataSlice.symbol}（${dataSlice.name}）\n现价: ${dataSlice.price}\n\n` +
    `【系统计算的指标快照（可直接引用，禁止编造之外的数字）】\n${dataSlice.metricsText}\n\n` +
    `【系统初步发现（供你深化：可修正、可补充；推翻或修正时须说明依据）】\n${(rule.findings ?? []).map((f) => '- ' + f).join('\n')}\n\n` +
    (dataSlice.extra ? `【补充数据】\n${dataSlice.extra}\n` : '') +
    `\n【局限（必须在 confidence 中反映）】\n${(rule.limitations ?? []).map((f) => '- ' + f).join('\n')}`;
  const r = await callRole(card, user);
  onStep();
  if (!r.ok) {
    return { ...rule, engine: 'rule', model: card.model, ms: r.ms ?? null };
  }
  const findings = strArr(r.json.findings, 6);
  const independents = strArr(r.json.independents, 3) ?? [];
  return {
    ...rule,
    findings: findings ?? rule.findings,
    independents,
    report: analystReport(rule.report, { summary: r.json.summary, findings, independents }, rule.findings),
    bias: validBias(r.json.bias) ?? rule.bias,
    confidence: clampConf(r.json.confidence, rule.confidence),
    engine: 'llm',
    model: r.model ?? card.model,
    ms: r.ms ?? null,
  };
}

function fmtNum(v, d = 2) {
  return Number.isFinite(v) ? Number(v).toFixed(d) : '--';
}

/** 各分析师的指标快照文本（供 LLM 引用，禁止编造之外的数字） */
function metricsTextOf(key, rule, klines, feed, marketNewsText) {
  if (key === 'alpha') {
    const m = rule.metrics;
    return `MA5/MA20/MA60: ${fmtNum(m.ma5)} / ${fmtNum(m.ma20)} / ${fmtNum(m.ma60)}\nMACD 柱: ${fmtNum(m.macdHist, 3)}\nRSI(14): ${fmtNum(m.rsi, 1)}\n趋势健康值: ${m.health}/100\n日K样本: ${klines.length} 根`;
  }
  if (key === 'beta') {
    const m = rule.metrics;
    return `ROE: ${fmtNum(m.roe, 1)}%\nEPS: ${fmtNum(m.eps)}\nPE(动): ${fmtNum(m.pe)}\nPB: ${fmtNum(m.pb)}\n净利润同比: ${fmtNum(m.profitYoY, 1)}%\n（若均为 -- 表示财务数据源本次不可用，已降级为价格行为代理）`;
  }
  if (key === 'gamma') {
    const m = rule.metrics;
    return (
      `事件检出: ${m.events} 起 | 利好关键词 ${m.good} 条 / 利空 ${m.bad} 条 | 公告 ${m.annCount} 条 | 个股新闻 ${m.newsCount} 条\n\n` +
      `【个股公告（东方财富）】\n${(feed?.announcements ?? []).slice(0, 5).map((a) => `- [${a.date}] ${a.title}`).join('\n') || '（本次不可用）'}\n` +
      `【个股新闻（东方财富）】\n${(feed?.stockNews ?? []).slice(0, 5).map((n) => `- [${n.date}] ${n.title}（${n.media}）`).join('\n') || '（本次不可用）'}\n` +
      `【市场要闻背景（新浪滚动，大盘环境，需自行判断与本标的的关联度）】\n${marketNewsText || '（本次不可用）'}`
    );
  }
  const m = rule.metrics;
  return (
    `量价配合度: ${fmtNum(m.pvRatio)}\nRSI: ${fmtNum(m.rsi, 1)}\n52 周分位: ${fmtNum(m.posInRange, 0)}%\n` +
    `主力近5日: ${fmtNum(m.sum5 / 1e8, 2)} 亿（连续 ${m.streak} 日同向）\n融资余额: ${fmtNum(m.rzye / 1e8, 1)} 亿\n\n` +
    `【市场要闻背景（新浪滚动）】\n${marketNewsText || '（本次不可用）'}`
  );
}

/** 主入口：异步 LLM 流水线。云端未配置返回 null（调用方回退同步规则引擎） */
async function runLLM({ symbol, klines, quote, name, mode = 'full', agent, entryPrice, feed, uid = 'default', onProgress = () => {} }) {
  if (!cloudAI.configured()) return null;
  const total = TOTAL_STEPS[mode] ?? TOTAL_STEPS.full;
  let step = 0;
  const onStep = () => {
    step += 1;
    onProgress({ step, total });
  };
  const roster = [];
  const price = quote?.price ?? klines[klines.length - 1]?.close ?? null;
  const stockLabel = `${symbol}（${name ?? quote?.name ?? ''}）`;

  // ─────────── C2 · 动态编排 ───────────
  // 数据完整度评估：缺失维度对应的 LLM 深化环节自动跳过（规则计算仍然完成），
  // 避免"对空数据做深化"的无意义调用，并在 trace 中留下 skipped 记录（可观测、可审计）。
  const coverage = evaluateCoverage(feed);
  const skipped = [];

  const finish = (stages_, final_) => {
    // 降级可观测：roster 已记录每个角色实际由 LLM 还是规则引擎产出，
    // 这里汇总成显式标记，避免「全角色退化为规则引擎」时用户仍以为是大模型分析。
    const ruleSeats = roster.filter((r) => r.engine === 'rule').map((r) => r.seat);
    const degraded = {
      degraded: ruleSeats.length > 0,
      llm: roster.length - ruleSeats.length,
      rule: ruleSeats.length,
      total: roster.length,
      seats: ruleSeats,
    };
    const trace = {
      ok: true,
      symbol,
      name: name ?? quote?.name ?? '',
      mode,
      ranAt: new Date().toISOString(),
      price,
      stages: stages_,
      final: final_,
      disclaimer: DISCLAIMER,
      llmRoster: roster,
      llmEnabled: true,
      degraded,
      orchestration: {
        coverage,
        skipped,
        isolation: { ...isolationStats },
        degraded,
      },
    };
    return trace;
  };

  // ═══ 单点调用：一位分析师独立调研（single 模式） ═══
  if (mode === 'single') {
    const map = {
      tech: 'alpha',
      fundamental: 'beta',
      news: 'gamma',
      sentiment: 'delta',
    };
    const key = map[agent] ?? 'alpha';
    const ruleMap = {
      alpha: () => techAnalyst(symbol, klines, quote),
      beta: () => fundamentalAnalyst(symbol, klines, quote, feed),
      gamma: () => newsAnalyst(symbol, klines, quote, feed),
      delta: () => sentimentAnalyst(symbol, klines, quote, feed),
    };
    const stage1Title = '单点调用 · 独立调研';
    onProgress({ step: 0, total: 1, stage: stage1Title });
    const marketNewsText = (feed?.marketNews ?? [])
      .slice(0, 6)
      .map((n) => `- [${n.date}] ${n.title}（${n.media}）`)
      .join('\n');
    const rule = ruleMap[key]();
    // Vercel 硬截止（2026-09-25 实测教训）：免费模型单轮常超 30s，曾撞死
    // FUNCTION_INVOCATION_TIMEOUT（504 纯文本，前端拿不到任何报告）。改为：
    // Vercel 上 50s 内 LLM 未返回 ⇒ 该 seat 显式降级为规则引擎结果（engine:'rule'，
    // 与 analystStep 自身的失败降级同形）——响应永不 504，降级可观测（铁律 #4）。
    // 本地无常驻限制，不启用截止。
    let one;
    if (process.env.VERCEL === '1') {
      const VERCEL_SEAT_DEADLINE_MS = 50_000; // maxDuration=60 内留响应余量
      let timer;
      one = await Promise.race([
        analystStep(key, rule, {
          symbol,
          name: name ?? quote?.name ?? '',
          price,
          metricsText: metricsTextOf(key, rule, klines, feed, marketNewsText),
        }, onStep),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({
            ...rule, engine: 'rule', model: ROLES[key].model, ms: null,
            timeout: 'LLM 超过 50s 未返回，Vercel 环境下降级为规则引擎结论',
          }), VERCEL_SEAT_DEADLINE_MS);
        }),
      ]);
      clearTimeout(timer);
    } else {
      one = await analystStep(key, rule, {
        symbol,
        name: name ?? quote?.name ?? '',
        price,
        metricsText: metricsTextOf(key, rule, klines, feed, marketNewsText),
      }, onStep);
    }
    roster.push({ seat: ROLES[key].seat, model: one.model, engine: one.engine, ms: one.ms ?? null });
    return finish(
      { collect: { title: '单点调用 · ' + rule.name, agents: [one] } },
      {
        decision: '——',
        note: `单点调研完成。${one.name} 的全文报告已归档，可通过报告链接查看`,
      },
    );
  }

  // ═══ 第一阶段 · 数据收集（规则指标为骨，LLM 叙事为肉） ═══
  const stage1Title = '第一阶段 · 数据收集（四分析师并行）';
  onProgress({ step: 0, total, stage: stage1Title });
  const ruleAlpha = techAnalyst(symbol, klines, quote);
  const ruleBeta = fundamentalAnalyst(symbol, klines, quote, feed);
  const ruleGamma = newsAnalyst(symbol, klines, quote, feed);
  const ruleDelta = sentimentAnalyst(symbol, klines, quote, feed);

  const marketNewsText = (feed?.marketNews ?? [])
    .slice(0, 6)
    .map((n) => `- [${n.date}] ${n.title}（${n.media}）`)
    .join('\n');
  const baseSlice = { symbol, name: name ?? quote?.name ?? '', price };

  // C2：数据源缺失时跳过对应分析师的 LLM 深化（规则计算已完成，报告结构不变，仅标注跳过原因）
  const skippedStep = (key, rule, reason) => {
    skipped.push({ seat: ROLES[key].seat, stage: stage1Title, reason });
    onStep();
    return Promise.resolve({ ...rule, engine: 'rule', model: ROLES[key].model, ms: null, skipReason: reason });
  };

  const [alpha, beta, gamma, delta] = await Promise.all([
    analystStep('alpha', ruleAlpha, {
      ...baseSlice,
      metricsText: metricsTextOf('alpha', ruleAlpha, klines, feed, marketNewsText),
    }, onStep),
    coverage.fundamentals
      ? analystStep('beta', ruleBeta, {
        ...baseSlice,
        metricsText: metricsTextOf('beta', ruleBeta, klines, feed, marketNewsText),
      }, onStep)
      : skippedStep('beta', ruleBeta, '财务与估值数据源本次不可用（已降级为价格行为代理），跳过基本面 LLM 深化'),
    coverage.news
      ? analystStep('gamma', ruleGamma, {
        ...baseSlice,
        metricsText: metricsTextOf('gamma', ruleGamma, klines, feed, marketNewsText),
      }, onStep)
      : skippedStep('gamma', ruleGamma, '公告/个股新闻/市场要闻三源均不可用（已降级为量价事件检测），跳过新闻 LLM 深化'),
    analystStep('delta', ruleDelta, {
      ...baseSlice,
      metricsText: metricsTextOf('delta', ruleDelta, klines, feed, marketNewsText),
    }, onStep),
  ]);

  const ALL_ANALYSTS = [alpha, beta, gamma, delta];
  roster.push(
    { seat: ROLES.alpha.seat, model: alpha.model, engine: alpha.engine, ms: alpha.ms ?? null },
    { seat: ROLES.beta.seat, model: beta.model, engine: beta.engine, ms: beta.ms ?? null },
    { seat: ROLES.gamma.seat, model: gamma.model, engine: gamma.engine, ms: gamma.ms ?? null },
    { seat: ROLES.delta.seat, model: delta.model, engine: delta.engine, ms: delta.ms ?? null },
  );

  // A6 · 隔离比对基线：仅「findings 前 2 条」属于允许中转的内容，其余正文一律不得外传
  const ISOLATION_ORIGINALS = [
    { seat: ROLES.alpha.seat, report: alpha.report, findings: alpha.findings },
    { seat: ROLES.beta.seat, report: beta.report, findings: beta.findings },
    { seat: ROLES.gamma.seat, report: gamma.report, findings: gamma.findings },
    { seat: ROLES.delta.seat, report: delta.report, findings: delta.findings },
  ];
  const isolationBaseline = buildIsolationOriginals(ISOLATION_ORIGINALS);

  // ═══ 主理人中转摘要（确定性加权，成员只看这个，不看原文） ═══
  const digest = buildDigest(ALL_ANALYSTS, quote, klines);

  // ═══ 第二阶段 · 裁决（quick=主理人直接加权裁决；其余=两轮多空辩论） ═══
  const debateTitle = '第二阶段 · 多空辩论';
  const digestText =
    `【主理人中转摘要（你唯一的信息来源）】\n标的: ${stockLabel}\n现价: ${price}\n` +
    `四份调研投票: 多头 ${digest.votes.bullish} / 空头 ${digest.votes.bearish} / 中性 ${digest.votes.neutral}\n` +
    `加权偏多度: ${digest.weightedBias}\n要点:\n${digest.keyPoints.map((kp) => `-（${kp.from}）${kp.points.join('；')}`).join('\n')}\n` +
    `已知局限: ${digest.limitations.join('；')}` +
    ((digest.evidence ?? []).length
      ? `\n【结构化论据图（本方论证唯一可引用的数值来源）】\n` +
        digest.evidence
          .map((e) => `- ${e.metric}｜取值 ${e.value}｜方向 ${e.direction === 'bull' ? '多' : '空'}｜权重 ${e.weight}（来源：${e.seat}）`)
          .join('\n') +
        `\n要求：arguments 每条须引用上述论据的「指标 + 取值」，不得引用论据图之外的数字。`
      : '');

  const debateUser = (ownSeat, opponentName, opponentArgs, final_) =>
    `${digestText}\n\n【你的任务】以「${ownSeat}」的身份输出 JSON：` +
    `{"arguments":["3-4 条论点，每条引用摘要中的具体数据"],"stance":"一句话立场"}\n` +
    (opponentArgs?.length
      ? `\n【主理人中转的对方论点（${opponentName}）——逐条回应】\n${opponentArgs.map((a) => '- ' + a).join('\n')}`
      : '\n（本轮对方尚未发言，请率先构建你的证据链）') +
    (final_ ? '\n（本轮为最终陈述：总结你的核心证据，不再开辟新论点）' : '');

  const mkDebater = (key, ruleOut, llm) => ({
    ...ruleOut,
    arguments: (llm?.ok ? strArr(llm.json.arguments, 4) : null) ?? ruleOut.arguments,
    stance: (llm?.ok && typeof llm.json.stance === 'string' && llm.json.stance.trim()) || ruleOut.stance,
    engine: llm?.ok ? 'llm' : 'rule',
    model: ROLES[key].model,
  });

  let chief = null;
  let debateStages = null;

  if (mode === 'quick') {
    onProgress({ step, total, stage: '第二阶段 · 综合裁决' });
    const w = digest.weightedBias;
    const fbVerdict = w >= 0.3 ? 'BUY' : w <= -0.3 ? 'SELL' : 'HOLD';
    const sensusRes = await callRole(
      ROLES.sensus,
      `${digestText}\n\n【你的任务】研究主管快速裁决（跳过辩论），输出 JSON：{"verdict":"BUY|SELL|HOLD 之一","reason":"2-3 句裁决理由"}\n铁律：不和稀泥，必须三选一；|加权偏多度|≥0.3 应顺势裁决。`,
      { originals: isolationBaseline },
    );
    onStep();
    chief = {
      name: 'Sensus · 研究主管',
      verdict: sensusRes.ok && ['BUY', 'SELL', 'HOLD'].includes(sensusRes.json.verdict) ? sensusRes.json.verdict : fbVerdict,
      reason: (sensusRes.ok && typeof sensusRes.json.reason === 'string' && sensusRes.json.reason.trim()) || `快速模式：按加权偏多度 ${w} 裁决 ${fbVerdict}`,
      score: w,
      rounds: 0,
      engine: sensusRes.ok ? 'llm' : 'rule',
      model: ROLES.sensus.model,
    };
    roster.push({ seat: ROLES.sensus.seat, model: ROLES.sensus.model, engine: chief.engine, ms: null });
  } else {
    onProgress({ step, total, stage: debateTitle });
    const bullCard = ROLES.bull;
    const bearCard = ROLES.bear;
    const [bull1Res, bull1Rule] = [
      await callRole(bullCard, debateUser(bullCard.seat, null, null, false), { originals: isolationBaseline }),
      bullResearcher(digest),
    ];
    onStep();
    const bear1Rule = bearResearcher(digest, bull1Rule);
    const [bear1Res, bull2Rule] = [
      await callRole(bearCard, debateUser(bearCard.seat, bullCard.seat, bull1Res.ok ? strArr(bull1Res.json.arguments, 4) ?? bull1Rule.arguments : bull1Rule.arguments, false), { originals: isolationBaseline }),
      bullRebut(digest, bear1Rule),
    ];
    onStep();
    const bull1 = mkDebater('bull', bull1Rule, bull1Res);
    const bear1 = mkDebater('bear', bear1Rule, bear1Res);
    const [bull2Res, bear2Res] = [
      await callRole(bullCard, debateUser(bullCard.seat, bearCard.seat, bear1.arguments, false), { originals: isolationBaseline }),
      await callRole(bearCard, debateUser(bearCard.seat, bullCard.seat, bull2Rule.arguments, true), { originals: isolationBaseline }),
    ];
    onStep();
    const bull2Rule2 = bullRebut(digest, bear1);
    const bear2Rule2 = bearFinal(digest, bull2Rule);
    const bull2 = mkDebater('bull', bull2Rule2, bull2Res);
    const bear2 = mkDebater('bear', bear2Rule2, bear2Res);
    onStep();

    const sensusUser =
      `${digestText}\n\n【两轮辩论交锋（主理人中转）】\n` +
      `多头首轮: ${bull1.arguments.join('；')}\n空头首轮: ${bear1.arguments.join('；')}\n` +
      `多头反驳: ${bull2.arguments.join('；')}\n空头最终: ${bear2.arguments.join('；')}\n\n` +
      `【你的任务】以研究主管身份裁决，输出 JSON：{"verdict":"BUY|SELL|HOLD 之一","reason":"3-4 句裁决理由，说明哪方证据链更完整"}\n铁律：不和稀泥，必须三选一。`;
    const sensusRes = await callRole(ROLES.sensus, sensusUser, { originals: isolationBaseline });
    onStep();
    const ruleChief = researchChief(digest, bull1, bear1, bull2, bear2);
    chief = {
      ...ruleChief,
      reason: (sensusRes.ok && typeof sensusRes.json.reason === 'string' && sensusRes.json.reason.trim()) || ruleChief.reason,
      verdict: sensusRes.ok && ['BUY', 'SELL', 'HOLD'].includes(sensusRes.json.verdict) ? sensusRes.json.verdict : ruleChief.verdict,
      engine: sensusRes.ok ? 'llm' : 'rule',
      model: ROLES.sensus.model,
    };
    roster.push(
      { seat: bullCard.seat, model: bullCard.model, engine: bull1.engine === 'llm' || bull2.engine === 'llm' ? 'llm' : 'rule', ms: (bull1Res.ms ?? null) ?? (bull2Res.ms ?? null) },
      { seat: bearCard.seat, model: bearCard.model, engine: bear1.engine === 'llm' || bear2.engine === 'llm' ? 'llm' : 'rule', ms: (bear1Res.ms ?? null) ?? (bear2Res.ms ?? null) },
      { seat: ROLES.sensus.seat, model: ROLES.sensus.model, engine: chief.engine, ms: sensusRes.ms ?? null },
    );
    debateStages = {
      title: debateTitle,
      round1: { bull: bull1, bear: bear1 },
      round2: { bull: bull2, bear: bear2 },
      bull: bull1,
      bear: bear1,
      chief,
    };
  }

  // ═══ 第三阶段 · 交易决策（参数确定性，LLM 写执行纪律） ═══
  const trade = trader(chief.verdict, digestPriceSafe(digest, entryPrice), klines);
  let vectorStep = Promise.resolve();
  if (mode === 'full' || mode === 'quick' || mode === 'risk') {
    onProgress({ step, total, stage: '第三阶段 · 交易决策' });
    const tradeText = trade.approved
      ? `裁决 ${chief.verdict}，风控引擎已算出委托参数：入场 ${trade.entry} / 止损 ${trade.stop} / 目标 ${trade.target} / 风险回报比 1:${trade.rr}，三场景：${trade.scenarios.map((s) => `${s.name}${s.price}(${s.prob * 100}%)`).join('、')}`
      : `裁决 HOLD，不出具委托参数，进入观望`;
    vectorStep = callRole(ROLES.vector, `${digestText}\n\n【交易计划（风控引擎计算）】\n${tradeText}\n\n【你的任务】用两三句话点评这笔计划的执行纪律，输出 JSON：{"note":"执行纪律点评（仓位节奏/放弃条件）"}`, { maxTokens: 500, originals: isolationBaseline }).then((r) => {
      onStep();
      if (r.ok && typeof r.json.note === 'string' && r.json.note.trim()) {
        trade.note = `${trade.note} —— Vector：${r.json.note.trim()}`;
      }
      roster.push({ seat: ROLES.vector.seat, model: ROLES.vector.model, engine: r.ok ? 'llm' : 'rule', ms: r.ms ?? null });
      return trade;
    });
  }
  await vectorStep;
  if (mode === 'quick') {
    const finalQuick = {
      decision: trade.approved ? chief.verdict : '观望',
      note: `${chief.reason} ${trade.note}`,
      teamScore: Math.round(50 + digest.weightedBias * 50),
    };
    // 快速模式补一段主理人总结
    const arb = await arbiterSummary({ digest, stockLabel, price, chief, trade, risk: null, originals: isolationBaseline });
    onStep();
    if (arb.text) finalQuick.note = arb.text;
    roster.push({ seat: ROLES.arbiter.seat, model: ROLES.arbiter.model, engine: arb.ok ? 'llm' : 'rule', ms: arb.ms });
    return finish(
      {
        collect: { title: stage1Title, agents: ALL_ANALYSTS, digest },
        debate: { title: '（快速模式：主理人直接加权裁决，跳过辩论）', chief },
        trade,
      },
      finalQuick,
    );
  }

  if (mode === 'debate') {
    const arb = await arbiterSummary({ digest, stockLabel, price, chief, trade: null, risk: null, originals: isolationBaseline });
    onStep();
    roster.push({ seat: ROLES.arbiter.seat, model: ROLES.arbiter.model, engine: arb.ok ? 'llm' : 'rule', ms: arb.ms });
    return finish(
      { collect: { title: stage1Title, agents: ALL_ANALYSTS, digest }, debate: debateStages },
      { decision: chief.verdict, note: arb.text ?? `辩论模式完成：研究主管裁决 ${chief.verdict} —— ${chief.reason}` },
    );
  }

  // ═══ 第四阶段 · 风险辩论（full / risk） ═══
  onProgress({ step, total, stage: '第四阶段 · 风险辩论' });
  const assumedVerdict = mode === 'risk' ? (digest.weightedBias >= 0 ? 'BUY' : 'SELL') : chief.verdict;
  const effTrade = mode === 'risk' ? trader(assumedVerdict, entryPrice ?? price, klines) : trade;
  if (mode === 'risk') {
    effTrade.note = `风险诊断模式：按 ${effTrade.entry} 假设 ${assumedVerdict} 方向。${effTrade.note}`;
  }
  const trio = riskTrio(effTrade, digest, klines);
  const worstPct = trio._worstPct ?? 5;
  const mdd = maxDrawdownOf(klines);
  const riskCommon =
    `${digestText}\n\n【交易计划（风控引擎计算）】\n${effTrade.approved ? `裁决 ${assumedVerdict}，入场 ${effTrade.entry} / 止损 ${effTrade.stop} / 目标 ${effTrade.target} / RR 1:${effTrade.rr}` : '裁决观望，无委托参数'}\n` +
    `【风险数据】单笔最坏止损亏损约 ${worstPct.toFixed(1)}% · 250 日最大回撤 ${mdd.toFixed(1)}%\n\n`;

  // C2 · 动态编排：裁决未出具委托参数时，三方风险辩论的 LLM 深化无标的可审，
  // 直接由规则引擎终裁（结构不变、可观测性由 skipped + engine 标注保证）。
  const riskLLMAllowed = Boolean(effTrade.approved);
  const NO_LLM = { ok: false, ms: null, skipped: true };
  if (!riskLLMAllowed) {
    skipped.push({
      seat: '第四阶段 · 风险辩论（Ra / Co / Ne / Aegis）',
      stage: '第四阶段 · 风险辩论',
      reason: '裁决未出具委托参数（HOLD/观望），三方风险 LLM 深化无标的，改由规则引擎直接终裁',
    });
  }
  const riskAsk = (card, extra) =>
    callRole(card, `${riskCommon}${extra}\n【你的任务】输出 JSON：{"opinion":"3-4 句风险意见，必须引用上面的具体数字"}`, { maxTokens: 600, originals: isolationBaseline });
  const [raRes, coRes, neRes] = await Promise.all([
    riskLLMAllowed ? riskAsk(ROLES.ra, '你的立场是"错过机会同样是风险"。') : Promise.resolve(NO_LLM),
    riskLLMAllowed ? riskAsk(ROLES.co, '你的立场是"先想最坏的情况"。') : Promise.resolve(NO_LLM),
    riskLLMAllowed
      ? callRole(ROLES.ne, `${riskCommon}\n【你的任务】给出分批建仓方案（若计划不可执行则说明观察条件），输出 JSON：{"plan":"3-4 句，含具体分批价位与止损纪律"}`, { maxTokens: 600, originals: isolationBaseline })
      : Promise.resolve(NO_LLM),
  ]);
  onStep();
  if (raRes.ok && typeof raRes.json.opinion === 'string') trio.aggressive.opinion = raRes.json.opinion.trim();
  if (coRes.ok && typeof coRes.json.opinion === 'string') trio.conservative.opinion = coRes.json.opinion.trim();
  if (neRes.ok && typeof neRes.json.plan === 'string') trio.neutral.plan = neRes.json.plan.trim();
  trio.aggressive.engine = raRes.ok ? 'llm' : 'rule';
  trio.conservative.engine = coRes.ok ? 'llm' : 'rule';
  trio.neutral.engine = neRes.ok ? 'llm' : 'rule';
  roster.push(
    { seat: ROLES.ra.seat, model: ROLES.ra.model, engine: trio.aggressive.engine, ms: raRes.ms ?? null },
    { seat: ROLES.co.seat, model: ROLES.co.model, engine: trio.conservative.engine, ms: coRes.ms ?? null },
    { seat: ROLES.ne.seat, model: ROLES.ne.model, engine: trio.neutral.engine, ms: neRes.ms ?? null },
  );

  const debateRounds = [
    { round: '第一轮', aggressive: trio.aggressive.opinion, conservative: trio.conservative.opinion },
    {
      round: '第二轮（主理人转述交锋）',
      aggressive: `保守派的最坏情形论（-${worstPct.toFixed(1)}% 止损、250 日回撤 ${mdd.toFixed(1)}%）成立，但可用"预设熔断 + 避免重仓单一标的"管理而非放弃信号；当前加权偏多度 ${digest.weightedBias}。`,
      conservative: `激进派也承认熔断必要——这正是本方立场；研究与演示语境下，任何仓位讨论都应默认带上"最坏情形 ${worstPct.toFixed(1)}%"的脚注。`,
    },
    { round: '中性方案', neutral: trio.neutral.plan },
  ];
  const ruleRiskChief = riskChief(effTrade, trio, debateRounds, assumedVerdict, digest);
  onProgress({ step, total, stage: '第五阶段 · 终审与总结' });
  const aegisRes = riskLLMAllowed ? await callRole(
    ROLES.aegis,
    `${riskCommon}【三方风险意见（主理人中转）】\n激进派: ${trio.aggressive.opinion}\n保守派: ${trio.conservative.opinion}\n中性派: ${trio.neutral.plan}\n\n` +
      `【程序裁决参考】决策 ${ruleRiskChief.decision}，仓位语义 ${ruleRiskChief.sizing}\n\n【你的任务】输出 JSON：{"notes":"3-4 句终裁陈词，综合三方意见并标注研究结论·非投资建议"}`,
    { maxTokens: 600, originals: isolationBaseline },
  ) : NO_LLM;
  onStep();
  const riskChiefOut = {
    ...ruleRiskChief,
    notes: (aegisRes.ok && typeof aegisRes.json.notes === 'string' && aegisRes.json.notes.trim()) || ruleRiskChief.notes,
    engine: aegisRes.ok ? 'llm' : 'rule',
    model: ROLES.aegis.model,
    skipReason: aegisRes.ok ? null : (riskLLMAllowed ? null : '无委托参数，规则引擎直接终裁'),
  };
  roster.push({ seat: ROLES.aegis.seat, model: ROLES.aegis.model, engine: riskChiefOut.engine, ms: aegisRes.ms ?? null });

  const riskStages = { ...trio, debate: debateRounds, chief: riskChiefOut };
  if (mode === 'risk') {
    const final_ = { decision: riskChiefOut.decision, note: riskChiefOut.notes };
    const arb = await arbiterSummary({ digest, stockLabel, price, chief: { verdict: assumedVerdict, reason: '' }, trade: effTrade, risk: riskChiefOut, originals: isolationBaseline });
    onStep();
    if (arb.text) final_.note = arb.text;
    roster.push({ seat: ROLES.arbiter.seat, model: ROLES.arbiter.model, engine: arb.ok ? 'llm' : 'rule', ms: arb.ms });
    return finish(
      {
        collect: { title: stage1Title, agents: ALL_ANALYSTS, digest },
        debate: debateStages,
        trade: effTrade,
        risk: riskStages,
      },
      final_,
    );
  }

  // ═══ full：终审 ═══
  const tradeFinal = trade;
  const final_ = {
    decision: riskChiefOut.decision,
    note: riskChiefOut.notes,
    teamScore: Math.round(50 + digest.weightedBias * 50),
  };
  const arb = await arbiterSummary({ digest, stockLabel, price, chief, trade: tradeFinal, risk: riskChiefOut, originals: isolationBaseline });
  onStep();
  if (arb.text) final_.note = arb.text;
  roster.push({ seat: ROLES.arbiter.seat, model: ROLES.arbiter.model, engine: arb.ok ? 'llm' : 'rule', ms: arb.ms });

  return finish(
    {
      collect: { title: stage1Title, agents: ALL_ANALYSTS, digest },
      debate: debateStages,
      trade: tradeFinal,
      risk: riskStages,
    },
    final_,
  );
}

function digestPriceSafe(digest, entryPrice) {
  return entryPrice ?? digest.price;
}

function maxDrawdownOf(klines) {
  const seg = klines.slice(-250).map((k) => k.close);
  let peak = -Infinity;
  let mdd = 0;
  for (const v of seg) {
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd * 100;
}

/** 主理人终审主笔：总结陈词（失败返回 { text: null }，由调用方用规则文案兜底） */
async function arbiterSummary({ digest, stockLabel, price, chief, trade, risk, originals = [] }) {
  const user =
    `【主理人中转摘要】\n标的: ${stockLabel}\n现价: ${price}\n加权偏多度: ${digest.weightedBias}（投票 多${digest.votes.bullish}/空${digest.votes.bearish}/中${digest.votes.neutral}）\n` +
    `要点: ${digest.keyPoints.map((kp) => `${kp.from}：${kp.points[0] ?? ''}`).join('；')}\n` +
    (digest.evidence?.length
      ? `证据图权重: 多头 ${digest.evidence.filter((e) => e.direction === 'bull').reduce((a, e) => a + e.weight, 0).toFixed(2)} / 空头 ${digest.evidence.filter((e) => e.direction === 'bear').reduce((a, e) => a + e.weight, 0).toFixed(2)}\n`
      : '') +
    `研究裁决: ${chief.verdict}${chief.reason ? `（${chief.reason.slice(0, 80)}）` : ''}\n` +
    (trade ? `交易计划: ${trade.approved ? `入场 ${trade.entry}/止损 ${trade.stop}/目标 ${trade.target}` : '观望，无委托参数'}\n` : '') +
    (risk ? `风险终裁: ${risk.decision}，仓位语义 ${risk.sizing}\n` : '') +
    `\n【你的任务】以主理人身份写最终总结陈词，输出 JSON：{"summary":"150-250 字，结构：多空天平 → 研究结论 → 关键风险提示，落款注明研究结论·非投资建议"}`;
  const r = await callRole(ROLES.arbiter, user, { maxTokens: 800, originals });
  return {
    text: r.ok && typeof r.json.summary === 'string' && r.json.summary.trim() ? r.json.summary.trim() : null,
    ms: r.ms ?? null,
    ok: Boolean(r.ok),
  };
}

module.exports = { runLLM, isolationGuard, isolationStats, findVerbatimOverlap, buildIsolationOriginals, evaluateCoverage, ISOLATION_MIN_OVERLAP };
