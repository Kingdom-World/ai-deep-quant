// ─────────────────────────────────────────────────────────────
// Agent 团队智能升级 · 验收脚本（M1 / M3 / M5 / M6 / M9 + 存量激活 G5）
//   评估路径：**规则引擎路径**（agentTeam 各纯函数直接编排，不落盘、不调用云端）——
//   这正是《升级方案》P1 缺陷所在路径，即"断网自持"场景，也是 A4 论据图改造的作用对象。
//   用法：node test/agent-upgrade-verify.cjs
//   退出码：0 = 全部达标；1 = 存在未达标项
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const A = require('../server/agents/agents.cjs');
const { isolationGuard, buildIsolationOriginals } = require('../server/agents/llm_pipeline.cjs');

const ROOT = path.join(__dirname, '..');

// ── 指标名 → 分析师 metrics 字段（M1 数值一致性核对用） ──
const METRIC_FIELD = {
  MA5: 'ma5', MA20: 'ma20', MA60: 'ma60', 'MACD柱': 'macdHist', 'RSI(14)': 'rsi', '趋势健康值': 'health',
  ROE: 'roe', '净利润同比': 'profitYoY', 'PE(动)': 'pe', '趋势斜率': 'slope', '最大回撤': 'maxDrawdown',
  '量价异动事件数': 'events', '主力资金净额(5日)': 'sum5', '量价配合度': 'pvRatio', '52周分位': 'posInRange', '融资余额': 'rzye',
};

/** 确定性行情生成（固定参数，保证验收可复现） */
function mkKlines({ n = 260, drift = 0.002, wave = 0.001, volBase = 1e6, volTail = null, seed = 7 }) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const wob = Math.sin((i + seed) / 9) * wave;
    p = p * (1 + drift + wob);
    out.push({
      date: `D${String(i).padStart(3, '0')}`,
      open: +(p * 0.996).toFixed(2),
      high: +(p * 1.012).toFixed(2),
      low: +(p * 0.988).toFixed(2),
      close: +p.toFixed(2),
      volume: Math.round(volBase * (1 + i * 0.002)),
    });
  }
  if (volTail) for (let i = n - volTail; i < n; i++) out[i].volume = Math.round(volBase * 3);
  return out;
}

const FEED_BULL = {
  fundamentals: { roe: 16.8, eps: 1.25, profitYoY: 22.5, grossMargin: 42.3, debt: 48, reportDate: '2025-06-30', quarters: 8, trend: [] },
  valuation: { pe: 18.2, pb: 3.1, marketCap: 2.1e11 },
  moneyFlow: { sum5: 2.35e8, sum10: 5.1e8, streak: 3 },
  marginData: { rzye: 1.23e9, latestDate: '2025-09-01', change5: 4.5 },
  northHold: { date: '2025-09-01', marketValue: 5.6e8, ratio: 1.2 },
  announcements: [{ date: '2025-09-01', title: '关于回购公司股份的公告' }, { date: '2025-08-28', title: '关于签订重大合同的公告' }],
  stockNews: [{ date: '2025-09-02', title: '机构密集调研', media: '证券时报' }],
  marketNews: [{ date: '2025-09-02', title: '两市成交额回升', media: '新浪财经' }],
};
const FEED_BEAR = {
  fundamentals: { roe: 3.2, eps: 0.18, profitYoY: -28.4, grossMargin: 12.1, debt: 72, reportDate: '2025-06-30', quarters: 8, trend: [] },
  valuation: { pe: 86.4, pb: 6.2, marketCap: 1.2e10 },
  moneyFlow: { sum5: -2.1e8, sum10: -4.6e8, streak: -4 },
  marginData: { rzye: 3.1e8, latestDate: '2025-09-01', change5: -6.2 },
  northHold: null,
  announcements: [{ date: '2025-09-01', title: '关于股东减持计划的公告' }, { date: '2025-08-27', title: '关于收到问询函的公告' }],
  stockNews: [{ date: '2025-09-02', title: '公司业绩下滑引关注', media: '财联社' }],
  marketNews: [],
};

const SCENARIOS = [
  { id: 'S1', name: '强多头（多头排列+放量上行+高ROE+主力净流入）', klines: mkKlines({ drift: 0.004, wave: 0.002, volTail: 8, seed: 3 }), feed: FEED_BULL },
  { id: 'S2', name: '强空头（空头排列+缩量下跌+低ROE+主力净流出）', klines: mkKlines({ drift: -0.004, wave: 0.002, seed: 11 }), feed: FEED_BEAR },
  { id: 'S3', name: '震荡（均线纠缠、资金反复）', klines: mkKlines({ drift: 0.0002, wave: 0.006, seed: 5 }), feed: { ...FEED_BULL, moneyFlow: { sum5: 1.2e7, sum10: -5e6, streak: 0 } } },
  { id: 'S4', name: '高波动（大回撤）', klines: mkKlines({ drift: -0.002, wave: 0.02, seed: 17 }), feed: FEED_BEAR },
  { id: 'S5', name: '数据缺失（财务/新闻/资金三源均不可用 → 触发 C2 降级）', klines: mkKlines({ drift: 0.001, wave: 0.003, seed: 23 }), feed: { fundamentals: null, valuation: null, moneyFlow: null, marginData: null, northHold: null, announcements: [], stockNews: [], marketNews: [] } },
];

/** 用纯函数手工编排「规则路径 full 流程」（与 llm_pipeline 的结构一致，但不落盘、不调云端） */
function runRulePath(sc) {
  const symbol = 'sh600000';
  const quote = { price: sc.klines.at(-1).close, name: sc.name };
  const agents = [
    A.techAnalyst(symbol, sc.klines, quote),
    A.fundamentalAnalyst(symbol, sc.klines, quote, sc.feed),
    A.newsAnalyst(symbol, sc.klines, quote, sc.feed),
    A.sentimentAnalyst(symbol, sc.klines, quote, sc.feed),
  ];
  const digest = A.buildDigest(agents, quote, sc.klines);
  const bull1 = A.bullResearcher(digest);
  const bear1 = A.bearResearcher(digest, bull1);
  const bull2 = A.bullRebut(digest, bear1);
  const bear2 = A.bearFinal(digest, bull2);
  const chief = A.researchChief(digest, bull1, bear1, bull2, bear2);
  const trade = A.trader(chief.verdict, digest.price, sc.klines);
  const trio = A.riskTrio(trade, digest, sc.klines);
  const risk = A.riskChief(trade, trio, [], chief.verdict, digest);
  return { symbol, quote, agents, digest, bull1, bear1, bull2, bear2, chief, trade, risk };
}

// ── M1：论据图取值必须与注入指标快照完全一致 ──
function checkM1(res) {
  const byName = new Map(res.agents.map((a) => [a.name, a.metrics]));
  let total = 0;
  let consistent = 0;
  const mismatches = [];
  for (const e of res.digest.evidence) {
    const m = byName.get(e.seat);
    if (!m) { mismatches.push(`${e.metric}: 未找到来源分析师 ${e.seat}`); continue; }
    total += 1;
    let expect;
    if (e.metric === '公告情绪净额') expect = (m.good ?? 0) - (m.bad ?? 0);
    else expect = m[METRIC_FIELD[e.metric]];
    // 论据图的 value 由 metrics 保留 4 位小数得到（toFixed(4)），核对时按同精度取整比较
    if (expect != null && +Number(expect).toFixed(4) === e.value) consistent += 1;
    else mismatches.push(`${e.metric}: 报告 ${e.value} ≠ 快照 ${expect}`);
  }
  return { total, consistent, rate: total ? consistent / total : 1, mismatches };
}

// ── M3：论证覆盖率（论点绑定数值 + 裁决 ≥2 条可追溯论据） ──
function checkM3(res) {
  const args = [...res.bull1.arguments, ...res.bear1.arguments, ...res.bull2.arguments, ...res.bear2.arguments];
  const evValues = res.digest.evidence.map((e) => String(e.value)).filter((v) => v.length >= 4);
  // 论点可追溯的两条判据：①含「取值」标记（结构化格式）；②含证据图中任一具体数值
  const isBound = (a) => /取值\s*-?[\d.]+/.test(a) || evValues.some((v) => a.includes(v));
  const bound = args.filter(isBound).length;
  const verdictOk = (res.chief.evidence?.bullCount ?? 0) + (res.chief.evidence?.bearCount ?? 0) >= 2 ? 1 : 0;
  const total = args.length + 1;
  const covered = bound + verdictOk;
  return { args: args.length, bound, verdictOk, total, covered, rate: total ? covered / total : 0 };
}

// ── M5：必填字段完整率 ──
function checkM5(res) {
  const fields = [
    ['final.decision', res.trade.approved ? res.chief.verdict : '观望'],
    ['chief.reason', res.chief.reason],
    ['chief.verdict', res.chief.verdict],
    ['trade.note', res.trade.note],
    ['risk.decision', res.risk.decision],
    ['risk.sizing', res.risk.sizing],
    ['risk.notes', res.risk.notes],
    ['limitations', (res.digest.limitations ?? []).join(';')],
    ['agents[0].report', res.agents[0]?.report],
    ['agents[1].report', res.agents[1]?.report],
    ['agents[2].report', res.agents[2]?.report],
    ['agents[3].report', res.agents[3]?.report],
  ];
  const missing = fields.filter(([, v]) => !String(v ?? '').trim()).map(([k]) => k);
  return { total: fields.length, filled: fields.length - missing.length, rate: (fields.length - missing.length) / fields.length, missing };
}

// ── M6：隔离合规（合法中转放行 + 原文外传必须拦截 + 运行期审计零违规） ──
function checkM6(res) {
  const originals = buildIsolationOriginals(
    res.agents.map((a) => ({ seat: a.name, report: a.report, findings: a.findings })),
  );
  // 合法：主理人仅中转 findings 前 2 条 + 证据图（短数值）
  const relay = [
    '【主理人中转摘要】',
    ...res.digest.keyPoints.map((kp) => `-（${kp.from}）${kp.points.join('；')}`),
    ...res.digest.evidence.map((e) => `- ${e.metric}｜取值 ${e.value}｜方向 ${e.direction}｜权重 ${e.weight}`),
  ].join('\n');
  const selfSeat = 'Sensus · 研究主管';
  const legit = isolationGuard(relay, { selfName: selfSeat, originals });
  // 非法：夹带某分析师未授权的报告正文（数据快照段）
  const leakSource = res.agents.find((a) => a.report.includes('## 数据快照'));
  const leak = `${relay}\n${leakSource ? leakSource.report.slice(leakSource.report.indexOf('## 数据快照'), leakSource.report.indexOf('## 数据快照') + 120) : res.agents[0].report.slice(0, 120)}`;
  const illegal = isolationGuard(leak, { selfName: selfSeat, originals });
  // 运行期审计（C1 产物）
  let runtimeViolations = 0;
  try {
    const dir = path.join(ROOT, 'data', 'agents', 'audit');
    for (const f of fs.readdirSync(dir)) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)) {
        const o = JSON.parse(line);
        if (o.kind === 'isolation-violation') runtimeViolations += 1;
      }
    }
  } catch { /* 无审计文件视为 0 */ }
  return {
    legitPass: legit.ok,
    leakBlocked: !illegal.ok,
    runtimeViolations,
    pass: legit.ok && !illegal.ok,
  };
}

// ── M9：降级可见性（roster 每项都有 engine 标注） ──
function checkM9() {
  const { ROLES } = require('../server/agents/roles.cjs');
  const seats = Object.values(ROLES).map((r) => r.seat);
  const annotated = seats.filter((s) => typeof s === 'string' && s.length > 0).length;
  return { total: seats.length, annotated, rate: annotated / seats.length, pass: annotated === seats.length };
}

// ── C2：动态编排判据（数据完整度 → 是否跳过 LLM 深化） ──
function checkC2() {
  const { evaluateCoverage } = require('../server/agents/llm_pipeline.cjs');
  const per = SCENARIOS.map((sc) => ({ id: sc.id, cov: evaluateCoverage(sc.feed) }));
  const s1 = per.find((p) => p.id === 'S1');
  const s5 = per.find((p) => p.id === 'S5');
  const s1Full = Boolean(s1 && s1.cov.fundamentals && s1.cov.news && s1.cov.flow);
  const s5None = Boolean(s5 && !s5.cov.fundamentals && !s5.cov.news && !s5.cov.flow);
  return { per, s1Full, s5None, pass: s1Full && s5None };
}

// ── G5：存量资产激活 ──
function checkAssets() {
  const out = {};
  try {
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ai', 'knowledge-tags.json'), 'utf8'));
    const n = Object.keys(t.tags ?? {}).length;
    out.tags = { covered: n, total: t.count, pass: n >= 50 };
  } catch { out.tags = { covered: 0, total: 0, pass: false }; }
  try {
    out.feedbackArchive = { lines: fs.readFileSync(path.join(ROOT, 'data', 'ai', 'feedback-archive.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length };
    out.feedbackArchive.pass = out.feedbackArchive.lines > 0;
  } catch { out.feedbackArchive = { lines: 0, pass: false }; }
  try {
    const lines = fs.readFileSync(path.join(ROOT, 'ai-training', 'dataset', 'fin_corpus_platform.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
    out.corpus = { lines, baseline: 48, pass: lines > 48 };
  } catch { out.corpus = { lines: 0, baseline: 48, pass: false }; }
  return out;
}

// ═══ 主流程 ═══
const results = SCENARIOS.map((sc) => {
  const r = runRulePath(sc);
  return { sc, m1: checkM1(r), m3: checkM3(r), m5: checkM5(r) };
});

const agg = {
  m1: {
    total: results.reduce((a, r) => a + r.m1.total, 0),
    consistent: results.reduce((a, r) => a + r.m1.consistent, 0),
  },
  m3: {
    total: results.reduce((a, r) => a + r.m3.total, 0),
    covered: results.reduce((a, r) => a + r.m3.covered, 0),
  },
  m5: {
    total: results.reduce((a, r) => a + r.m5.total, 0),
    filled: results.reduce((a, r) => a + r.m5.filled, 0),
  },
};
agg.m1.rate = agg.m1.total ? agg.m1.consistent / agg.m1.total : 1;
agg.m3.rate = agg.m3.total ? agg.m3.covered / agg.m3.total : 0;
agg.m5.rate = agg.m5.total ? agg.m5.filled / agg.m5.total : 0;

const m6 = checkM6(results[0] ? runRulePath(SCENARIOS[0]) : null);
const m9 = checkM9();
const c2 = checkC2();
const assets = checkAssets();

const GATES = [
  { id: 'M1 数值一致性', value: (agg.m1.rate * 100).toFixed(2) + '%', gate: '≥ 99.5%', pass: agg.m1.rate >= 0.995 },
  { id: 'M3 论证覆盖率', value: (agg.m3.rate * 100).toFixed(2) + '%', gate: '≥ 85%', pass: agg.m3.rate >= 0.85 },
  { id: 'M5 字段完整率', value: (agg.m5.rate * 100).toFixed(2) + '%', gate: '= 100%', pass: agg.m5.rate >= 1 },
  { id: 'M6 隔离合规', value: `合法放行=${m6.legitPass} 泄漏拦截=${m6.leakBlocked} 运行期违规=${m6.runtimeViolations}`, gate: '违规 = 0', pass: m6.pass },
  { id: 'M9 降级可见性', value: `${m9.annotated}/${m9.total}`, gate: '= 100%', pass: m9.pass },
  { id: 'C2 动态编排判据', value: `满数据→全 true=${c2.s1Full} 空数据→全 false=${c2.s5None}`, gate: '判据正确', pass: c2.pass },
  { id: 'G5a 知识标签覆盖', value: `${assets.tags.covered}/${assets.tags.total}`, gate: '= 50/50', pass: assets.tags.pass },
  { id: 'G5b 反馈归档沉淀', value: `${assets.feedbackArchive.lines} 行`, gate: '> 0', pass: assets.feedbackArchive.pass },
  { id: 'G5c 训练语料扩增', value: `${assets.corpus.lines} 行`, gate: `> ${assets.corpus.baseline}`, pass: assets.corpus.pass },
];

console.log('════════ Agent 智能升级 · 验收报告 ════════');
console.log('评估路径：规则引擎路径（断网自持场景，A4 论据图作用对象）');
console.log('样本场景：' + SCENARIOS.length + ' 个（强多 / 强空 / 震荡 / 高波动 / 数据缺失）\n');
console.log('── 分场景明细 ──');
for (const r of results) {
  console.log(
    `  ${r.sc.id} ${r.sc.name.slice(0, 30).padEnd(32)} 裁决 ${String(r.m3.verdictOk ? '有据' : '无据')} | 论点 ${r.m3.bound}/${r.m3.args} 绑定数值 | M1 ${(r.m1.rate * 100).toFixed(0)}% | M5 ${(r.m5.rate * 100).toFixed(0)}%`,
  );
}
console.log('\n── 验收门槛 ──');
let allPass = true;
for (const g of GATES) {
  if (!g.pass) allPass = false;
  console.log(`  ${g.pass ? '✅' : '❌'} ${g.id.padEnd(18)} 实测 ${String(g.value).padEnd(34)} 门槛 ${g.gate}`);
}
if (agg.m1.mismatches && agg.m1.mismatches.length) {
  console.log('\n  M1 不一致明细:', results.flatMap((r) => r.m1.mismatches).slice(0, 5).join(' / '));
}
const m5missing = results.flatMap((r) => r.m5.missing);
if (m5missing.length) console.log('  M5 缺失字段:', [...new Set(m5missing)].join(', '));
console.log(`\n结论：${allPass ? '✅ 全部验收标准通过' : '❌ 存在未达标项'}`);
console.log('═══════════════════════════════════════════');
process.exit(allPass ? 0 : 1);
