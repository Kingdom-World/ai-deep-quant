// ─────────────────────────────────────────────────────────────
// AI 助手推理引擎 v3（ReAct 模式：推理 → 行动（调数据工具）→ 观察 → 综合）
//   · 不再套模板：先识别意图，实际调用平台数据工具取证，再组织带思考链的回答
//   · 工具由宿主（index.cjs）注入，避免循环依赖
//   · 云端大模型可用时，工具观察结果会作为上下文交给大模型综合（真·思考链）
//
//   v3（2026-09-26，子代理评审后修订）：
//   · 新增 skillExplain（名词解释，吃透知识库 48 条）与 skillMood（市场情绪）
//   · 🔴 双知识库口径分离：knowledge.cjs 的 score 是**整型加权**（title 10/tags 6/body 3/source 2），
//     不能套 brain.cjs 的 0-1 阈值 —— 标题命中（score≥10）才可作答，其余只做"相关条目"提示；
//     空查询返回 browse 模式（全量条目 score=0），**必须拒绝**，否则空问题会得到任意答案。
//   · 🔴 显式降级：技能失败返回 {type:'skill-error', answer:null, degraded}（用户可见），
//     不再静默 return null —— 静默降级违反铁律 #1。
//   · 意图优先级：sector → mood → stock（代码是最强信号）→ explain → market。
//     stock 的英文 ticker 分支收紧为词边界（此前 [A-Za-z]{1,6} 会把"what is p/e"这类句子误入 stock）。
// ─────────────────────────────────────────────────────────────
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// ── 数据工具 ──

/** 大盘指数（腾讯源，与 /api/indices 同源） */
async function toolIndices() {
  const codes = ['sh000001', 'sz399001', 'sh000300'].join(',');
  const text = (
    await axios.get(`https://qt.gtimg.cn/q=${codes}`, {
      headers: { 'User-Agent': UA },
      timeout: 6000,
    })
  ).data;
  const out = [];
  const names = { sh000001: '上证指数', sz399001: '深证成指', sh000300: '沪深300' };
  for (const code of ['sh000001', 'sz399001', 'sh000300']) {
    const m = text.match(new RegExp(`v_${code}="([^"]*)"`));
    if (!m) continue;
    const p = m[1].split('~');
    const price = parseFloat(p[3]);
    const prev = parseFloat(p[4]);
    if (Number.isFinite(price) && prev > 0) {
      out.push({ name: names[code], price, chg: +(((price - prev) / prev) * 100).toFixed(2) });
    }
  }
  return out;
}

/** 板块主力资金（行业/概念） */
async function toolSectorFlow(type = 'industry') {
  const fsMap = { industry: 'm:90+t:2', concept: 'm:90+t:3' };
  const j = (
    await axios.get(
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f62` +
        `&fs=${encodeURIComponent(fsMap[type])}&fields=f14,f62`,
      { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout: 6000 },
    )
  ).data;
  const rows = (j?.data?.diff ?? [])
    .map((d) => ({ name: d.f14, mainNet: Number.isFinite(d.f62) ? d.f62 : null }))
    .filter((r) => r.mainNet != null)
    .sort((a, b) => b.mainNet - a.mainNet);
  const yi = (v) => (v / 1e8).toFixed(2);
  return {
    inflow: rows.slice(0, 3).map((r) => `${r.name} +${yi(r.mainNet)} 亿`),
    outflow: rows.slice(-3).reverse().map((r) => `${r.name} ${yi(r.mainNet)} 亿`),
  };
}

// ── 意图识别 ──
//   优先级即判断顺序：代码信号最强（stock 次序靠前），情绪先于大盘（"市场情绪怎么样"不该走 market）。

function detectIntent(q) {
  if (/板块|资金流|净流入|净流出|热点|异动|哪个行业|行业.*好/.test(q)) return 'sector';
  if (/情绪|赚钱效应|涨跌家数|市场温度/.test(q)) return 'mood';
  // 个股：6 位代码是最强信号；英文 ticker 必须词边界 + 动词语境（防"what is p/e"误入）
  if (/(sh|sz|bj)?\d{5,6}/.test(q)) return 'stock';
  if (/\b[A-Za-z]{1,6}\b/.test(q) && /分析|解读|怎么样|评估|健康/.test(q)) return 'stock';
  if (/什么是|什么意思|啥意思|解释一下|为什么.*会/.test(q)) return 'explain';
  if (/大盘|市场(怎么样|如何|状态)|今天行情|行情总结/.test(q)) return 'market';
  return null;
}

function composeCoT(steps, answer) {
  return `🧠 思考链：\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n${answer}`;
}

// ── 技能实现 ──

async function skillSector(q, tools) {
  const type = /概念/.test(q) ? 'concept' : 'industry';
  const flow = await tools.sectorFlow(type);
  const reasoning = [
    `识别意图：用户想了解${type === 'concept' ? '概念' : '行业'}板块的主力资金动向`,
    '调用东财板块资金流数据，按主力净流入排序',
  ];
  const answer = [
    `📊 ${type === 'concept' ? '概念' : '行业'}板块主力资金概览`,
    '',
    '净流入前列：',
    ...flow.inflow.map((x) => `· ${x}`),
    '净流出前列：',
    ...flow.outflow.map((x) => `· ${x}`),
    '',
    '解读：净流入居前的板块通常是当日资金共识方向，可结合板块内领涨股与量能持续性观察；单日数据波动较大，建议看多日趋势。',
    '⚠️ 研究演示，不构成投资建议。',
  ].join('\n');
  return { type: 'sector-flow', reasoning, answer: composeCoT(reasoning, answer) };
}

async function skillMarket(q, tools) {
  const idx = await tools.indices();
  const reasoning = ['识别意图：了解大盘整体状态', '调取三大指数实时行情'];
  const up = idx.filter((x) => x.chg >= 0).length;
  reasoning.push(`三大指数 ${up}/3 收红，整体${idx.every((x) => x.chg > 0) ? '偏强' : idx.every((x) => x.chg < 0) ? '偏弱' : '分化'}`);
  const answer = [
    '📊 大盘概览',
    ...idx.map((x) => `· ${x.name}：${x.price.toFixed(2)}（${x.chg >= 0 ? '+' : ''}${x.chg}%）`),
    '',
    `解读：三大指数${idx.every((x) => x.chg > 0) ? '集体收红，市场情绪偏积极' : idx.every((x) => x.chg < 0) ? '集体走弱，注意控制仓位与节奏' : '走势分化，结构性机会与风险并存'}。可在首页查看板块主力资金流向，把握资金共识方向。`,
    '⚠️ 研究演示，不构成投资建议。',
  ].join('\n');
  return { type: 'market-status', reasoning, answer: composeCoT(reasoning, answer) };
}

async function skillStock(q, tools) {
  const symbol = await tools.extractSymbol(q);
  if (!symbol) return null;
  const reasoning = [
    `识别意图：个股研究（${symbol}）`,
    '调取实时行情、历史K线，计算均线与五因子评分',
  ];
  const brief = await tools.analyzeStock(symbol);
  const answer = `关于 ${symbol}：\n\n${brief}\n\n思考链已展示数据来源与计算口径；更深入的研究可在量化看板查看K线结构，或用 Agent 团队跑一次完整分析。\n⚠️ 研究演示，不构成投资建议。`;
  return { type: 'stock-analysis', reasoning, answer };
}

/**
 * 名词解释（v3 新增）：吃透知识库（knowledge.cjs，48 条带真实出处）。
 * 🔴 口径（子代理评审 Blocking#1/#3）：
 *   · score 是整型加权分（title 命中 10 分），score≥10 才视为"标题相关"，可作答；
 *   · mode==='browse'（空查询/停用词吃光）必须拒绝，否则空问题得到任意条目；
 *   · 输出强制带出处；score<10 只做"相关条目"提示（不冒充答案），无命中返回 null 落兜底。
 */
async function skillExplain(q, tools) {
  if (typeof tools.knowledgeSearch !== 'function') return null;
  const r = await tools.knowledgeSearch(q);
  if (!r || r.mode === 'browse' || !Array.isArray(r.items) || !r.items.length) return null;
  const top = r.items[0];
  const titleHit = Number(top.score) >= 10; // 标题命中（title 权重 10）
  const reasoning = [
    '识别意图：名词/概念解释',
    `检索结构化知识库（${r.total} 条，命中模式 ${r.mode}）`,
    titleHit ? `命中条目「${top.title}」（标题相关，得分 ${top.score}）` : `无标题命中（最高分 ${r.items[0]?.score ?? 0} < 10），仅提示相关条目`,
  ];
  const answer = titleHit
    ? [
        `📖 ${top.title}`,
        '',
        String(top.body || '').trim(),
        '',
        `📚 出处：${top.source || '（条目未标注出处）'}`,
        r.items[1] ? `相关条目：${r.items.slice(1, 3).map((x) => x.title).join('、')}` : '',
        '⚠️ 研究演示，不构成投资建议。',
      ].filter(Boolean).join('\n')
    : [
        '没有找到标题完全匹配的词条，以下是知识库中的相关条目：',
        ...r.items.slice(0, 3).map((x) => `· 《${x.title}》（得分 ${x.score}）—— 详见研究中心「知识库」页`),
        '',
        '也可以换一种问法，例如「什么是夏普比率」「前复权是什么意思」。',
      ].join('\n');
  return { type: 'knowledge-explain', reasoning, answer: composeCoT(reasoning, answer) };
}

/**
 * 市场情绪（v3 新增）：宿主注入 marketMood（与 /api/mood 同源，60s 缓存 + lastGood 兜底）。
 * 问答路径预算 ≤500ms：情绪数据取的是缓存快照，不做实时全市场扫描。
 */
async function skillMood(q, tools) {
  if (typeof tools.marketMood !== 'function') return null;
  const m = await tools.marketMood();
  if (!m) return null;
  const reasoning = ['识别意图：市场情绪/赚钱效应', '读取市场温度计快照（60s 缓存，腾讯全A快照口径）'];
  // 字段口径与 screener.getMood() 对齐：{up, down, flat, limitUp, limitDown, score(0-100), ...}
  // 缺失判定不用 ?? 0 —— "字段缺失"与"真的是 0"是两回事，缺失即落兜底（不硬编）
  const up = Number(m.up), down = Number(m.down);
  const limitUp = Number(m.limitUp), limitDown = Number(m.limitDown);
  const temp = Number(m.score);
  if (!Number.isFinite(up) || !Number.isFinite(down) || !up && !down && !Number.isFinite(temp)) return null;
  const lines = [];
  lines.push(`· 上涨 ${up} 家 / 下跌 ${down} 家${Number.isFinite(Number(m.flat)) ? ` / 平盘 ${m.flat} 家` : ''}`);
  if (Number.isFinite(limitUp)) lines.push(`· 涨停 ${limitUp} 家${Number.isFinite(limitDown) ? ` / 跌停 ${limitDown} 家` : ''}`);
  if (Number.isFinite(temp)) lines.push(`· 市场温度：${temp}°（0=冰点，100=过热）`);
  const hot = Number.isFinite(temp) ? temp : 50;
  const judge = hot >= 75 ? '情绪偏热，注意追高风险' : hot >= 45 ? '情绪中性，结构性行情为主' : '情绪偏冷，观察企稳信号';
  const answer = [
    '🌡️ 市场情绪概览',
    ...lines,
    '',
    `解读：${judge}。情绪指标反映的是全市场涨跌结构的即时状态，短线波动大，建议结合指数走势与板块资金流一起看。`,
    '⚠️ 研究演示，不构成投资建议。',
  ].join('\n');
  return { type: 'market-mood', reasoning, answer: composeCoT(reasoning, answer) };
}

// ── 主路由 ──

async function route(q, tools) {
  const intent = detectIntent(q);
  try {
    if (intent === 'sector') return await skillSector(q, tools);
    if (intent === 'mood') {
      const r = await skillMood(q, tools);
      if (r) return r;
    }
    if (intent === 'stock') {
      const r = await skillStock(q, tools);
      if (r) return r;
    }
    if (intent === 'explain') {
      const r = await skillExplain(q, tools);
      if (r) return r;
    }
    if (intent === 'market') return await skillMarket(q, tools);
  } catch (e) {
    // 🔴 显式降级（子代理评审 Blocking#4）：不再静默吞错落兜底——
    // 返回带 degraded 标记的对象，由 qa 路由透传给用户（answer:null 不返回，走后续分支）。
    console.warn('[Reasoning] 技能执行失败:', e.message?.slice(0, 60));
    return { type: 'skill-error', answer: null, degraded: '数据技能执行失败，本次回答由通用兜底生成' };
  }
  return null;
}

/** 为云端大模型生成平台数据上下文（ReAct 观察 → LLM 综合） */
async function buildCloudContext(q, tools = {}) {
  const intent = detectIntent(q);
  const parts = [];
  try {
    if (intent === 'sector') {
      const f = await toolSectorFlow(/概念/.test(q) ? 'concept' : 'industry');
      parts.push(`当前${/概念/.test(q) ? '概念' : '行业'}板块主力资金——净流入前列：${f.inflow.join('、')}；净流出前列：${f.outflow.join('、')}（单位：亿元）`);
    } else if (intent === 'mood') {
      if (typeof tools.marketMood === 'function') {
        const m = await tools.marketMood();
        if (m) parts.push(`市场情绪快照：${JSON.stringify(m).slice(0, 300)}`);
      }
    } else if (intent === 'explain') {
      if (typeof tools.knowledgeSearch === 'function') {
        const r = await tools.knowledgeSearch(q);
        if (r && r.mode !== 'browse' && r.items?.length && Number(r.items[0].score) >= 10) {
          const e = r.items[0];
          parts.push(`知识库条目「${e.title}」（出处 ${e.source || '未标注'}）：\n${String(e.body || '').slice(0, 400)}`);
        }
      }
    } else {
      const idx = await toolIndices();
      parts.push(`当前大盘：${idx.map((x) => `${x.name} ${x.price}（${x.chg >= 0 ? '+' : ''}${x.chg}%）`).join('；')}`);
      if (intent === 'stock') {
        const sym = (q.match(/(sh|sz|bj)?\d{5,6}/) || [])[0];
        if (sym) {
          const brief = await tools.analyzeStock(sym);
          if (brief) parts.push(`${sym} 平台分析摘要：\n${brief.slice(0, 400)}`);
        }
      }
    }
  } catch { /* 数据上下文可选 */ }
  return parts.length ? '【平台实时数据观察】\n' + parts.join('\n') : null;
}

module.exports = { route, buildCloudContext, detectIntent, skillExplain, skillMood };
