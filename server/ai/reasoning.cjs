// ─────────────────────────────────────────────────────────────
// AI 助手推理引擎 v2（ReAct 模式：推理 → 行动（调数据工具）→ 观察 → 综合）
//   · 不再套模板：先识别意图，实际调用平台数据工具取证，再组织带思考链的回答
//   · 工具由宿主（index.cjs）注入，避免循环依赖
//   · 云端大模型可用时，工具观察结果会作为上下文交给大模型综合（真·思考链）
// ─────────────────────────────────────────────────────────────
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// ── 数据工具 ──

/** 大盘指数（腾讯源，与 /api/indices 同源） */
async function toolIndices() {
  const codes = ['sh000001', 'sz399001', 'sh000300'].join(',');
  const text = (
    await axios.get(`http://qt.gtimg.cn/q=${codes}`, {
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

function detectIntent(q) {
  if (/板块|资金流|净流入|净流出|热点|异动|哪个行业|行业.*好/.test(q)) return 'sector';
  if (/大盘|市场(怎么样|如何|状态)|今天行情|行情总结|大盘.*如何/.test(q)) return 'market';
  if (/分析|解读|怎么样|健康值|五因子|评估/.test(q) && /(sh|sz|bj)?\d{5,6}|[A-Za-z]{1,6}/.test(q)) return 'stock';
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

// ── 主路由 ──

async function route(q, tools) {
  const intent = detectIntent(q);
  try {
    if (intent === 'sector') return await skillSector(q, tools);
    if (intent === 'market') return await skillMarket(q, tools);
    if (intent === 'stock') {
      const r = await skillStock(q, tools);
      if (r) return r;
    }
  } catch (e) {
    // 推理技能失败时静默回退到规则分支
    console.warn('[Reasoning] 技能执行失败:', e.message?.slice(0, 60));
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

module.exports = { route, buildCloudContext };
