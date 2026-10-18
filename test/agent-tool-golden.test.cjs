'use strict';
// ─────────────────────────────────────────────────────────────
// 黄金工具调用集（Phase 3 收尾护栏）
//
// ## 为什么需要
// 工具箱从 6 个涨到 11 个启用项后，最大的新风险不再是"工具算错"，
// 而是**模型选错工具**：该查历史却重跑一遍回测、该读报告却又发一次团队分析。
// 既有 eval（`test/fixtures/agent-eval-cases.cjs`）测的是**回答层**
// （refuse / abstain / answer + 不编造），**完全不覆盖工具选择**。
//
// ## 为什么这里不测"模型选得对不对"
// 选工具是 LLM 行为，CI 里不能跑真模型（不确定、要网络、要钱）。
// 所以本文件守的是**可以被机器判定的三条前提** —— 它们不成立时，
// 模型再聪明也选不对：
//
//   ① **注册表一致**：`ENABLED_TOOLS` 里每一项都必须真实存在于工具箱。
//      漏了会让模型"看不到"某个工具（白名单是硬闸），多了则是幽灵项。
//   ② **描述自洽**：工具 desc 里**承诺**的能力，实现里必须真的支持。
//      desc 说"可按策略过滤"但实现不支持 ⇒ 模型被文档误导，比没写更糟。
//   ③ **能力可用**：黄金问题交给期望工具，必须能拿到有意义的输出（不是 fail）。
//
// 另加一条覆盖检查：每个已启用工具都应至少被一个黄金问题覆盖 ——
// 新增工具却没补黄金用例时，这条会提醒（避免护栏随工具增长而失效）。
//
// ⚠️ 全部用**注入的假 deps**，不读 data/ 也不打网络（CI 可跑）。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createToolbox } = require(path.join(__dirname, '..', 'server', 'agent', 'toolbox.cjs'));
const { ENABLED_TOOLS } = require(path.join(__dirname, '..', 'server', 'agent', 'alpha.cjs'));
const crosssect = require(path.join(__dirname, '..', 'server', 'crosssect.cjs'));

// ── 假 deps：足够让每个工具跑出有意义结果 ──────────────────────
const FAKE_ROWS = Array.from({ length: 300 }, (_, i) => ({
  date: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
  open: 10 + i * 0.01, high: 10.2 + i * 0.01, low: 9.8 + i * 0.01,
  close: 10 + i * 0.01 + (i % 5) * 0.02, volume: 1e6,
}));

const FAKE_EXPS = [
  { ts: '2026-10-01T08:00:00.000Z', symbol: 'sh600519', strategy: 'ma', params: { fast: 5, slow: 20 },
    market: 'CN', range: { start: '2024-01-01', end: '2026-09-30' },
    metrics: { totalReturn: 12.34, annualized: 5.67, maxDrawdownPct: 8.9, sharpe: 1.23, tradeCount: 42 } },
];
const FAKE_TRACE = {
  symbol: 'sh600519', name: '贵州茅台', mode: 'full', ranAt: '2026-10-01T07:50:58.490Z', price: 1258.62,
  final: { decision: '观望', note: '空头证据链更完整。', teamScore: 58 },
  disclaimer: '研究结论 · 非投资建议',
  degraded: { degraded: true, llm: 9, rule: 4, total: 13, seats: ['Ra · 激进风险分析师'] },
  uid: 'admin',
};
const FAKE_REPORTS = [
  { id: 'r-1', symbol: 'sh600519', name: '贵州茅台', mode: 'full', decision: '观望', ranAt: '2026-10-01T07:50:58.490Z' },
];
const FAKE_SNAPSHOT = {
  cash: 20000, availableCash: 18000, initialCapital: 100000,
  marketValue: 80000, totalAssets: 100000, totalPnl: 5000, totalPnlPct: 5, todayPnl: 120,
  peakAssets: 110000, drawdownPct: 9.09, ddLevel: 0, riskLocked: false,
  positions: [
    { symbol: 'sh600519', name: '贵州茅台', qty: 100, avgCost: 500, lastPrice: 600, marketValue: 60000, sellableQty: 100, unrealizedPnl: 10000, unrealizedPct: 20 },
  ],
  equity: [], orders: [],
};

function makeTb() {
  return createToolbox({
    fetchKlines: async () => FAKE_ROWS,
    fetchQuote: async () => ({ price: 600, changePct: 1.2, prevClose: 593 }),
    fetchNews: async () => [],
    marketOf: () => 'CN',
    priceLimitPct: () => 10,
    listExperiments: (limit, filters) => {
      let out = FAKE_EXPS;
      if (filters && filters.symbol) out = out.filter((r) => r.symbol === filters.symbol);
      if (filters && filters.strategy) out = out.filter((r) => r.strategy === filters.strategy);
      return out.slice(0, limit);
    },
    getReport: async (id) => (id === 'r-1' ? FAKE_TRACE : null),
    listReports: async () => FAKE_REPORTS,
    accountSnapshot: async () => FAKE_SNAPSHOT,
  });
}

/**
 * 黄金集：问题 → 期望工具 → 期望输出特征。
 *
 * `descMustMention` 是**可判别性契约**：desc 里必须出现这些"何时该用我"的信号词，
 * 否则模型无法把它和相邻工具区分开（例如分不清 list_experiments 与 run_backtest）。
 */
const GOLDEN = [
  {
    id: 'hist-experiments',
    question: '我之前跑过哪些回测？结果如何？',
    tool: 'list_experiments',
    args: { limit: 5 },
    descMustMention: ['实验记录', '历史'],
    expect: (r) => /历史实验/.test(r.summary),
    rationale: '该问题应"读历史"，不该重跑回测（重跑既慢又会污染实验记录）',
  },
  {
    id: 'team-report',
    question: '上次对茅台的团队分析结论是什么？降级了吗？',
    tool: 'read_report',
    args: { id: 'r-1' },
    descMustMention: ['历史', '报告'],
    expect: (r) => /团队结论/.test(r.summary) && /降级/.test(r.summary),
    rationale: '结论与降级情况必须一起给，否则模型会把降级结论当完整分析',
  },
  {
    id: 'portfolio-exposure',
    question: '我现在的持仓结构如何？集中度高不高？',
    tool: 'get_portfolio',
    args: { top: 5 },
    descMustMention: ['集中度', '持仓'],
    expect: (r) => /集中度/.test(r.summary),
    rationale: '暴露的核心是占比与集中度，只给持仓列表等于没答',
  },
  {
    id: 'factor-catalog',
    question: '平台有哪些因子可用？mom20 是什么？',
    tool: 'list_factors',
    args: {},
    descMustMention: ['因子'],
    expect: (r) => /预置因子/.test(r.summary),
    rationale: '列举能力类问题，应查目录而不是跑计算',
  },
  {
    id: 'expr-check',
    question: 'mom60 - mom20 这个表达式能写吗？',
    tool: 'check_factor_expr',
    args: { expr: 'mom60 - mom20' },
    descMustMention: ['表达式'],
    expect: (r) => /合法/.test(r.summary) && /不计算/.test(r.summary),
    rationale: '问"能不能写"是语法问题；必须声明不计算，否则会被当成"已验证有效"',
  },
  {
    id: 'knowledge-lookup',
    question: '未来函数是什么？怎么避免？',
    tool: 'knowledge_search',
    args: { query: '未来函数' },
    descMustMention: ['知识库', '口径'],
    expect: (r) => typeof r.ok === 'boolean',
    rationale: '定义/口径类问题应先查知识库（平台权威源），而不是让模型凭记忆答',
  },
  {
    id: 'klines',
    question: '给我茅台最近 200 根日 K',
    tool: 'get_klines',
    args: { symbol: 'sh600519', count: 200 },
    descMustMention: ['K', '日'],
    expect: (r) => /K 线|K线/.test(r.summary) || r.ok,
    rationale: '纯取数问题，不该触发回测或因子计算',
  },
  {
    id: 'backtest',
    question: '用双均线（5/20）回测一下茅台',
    tool: 'run_backtest',
    args: { symbol: 'sh600519', strategy: 'ma', fast: 5, slow: 20, count: 300 },
    descMustMention: ['回测'],
    expect: (r) => /总收益/.test(r.summary) && /最大回撤/.test(r.summary),
    rationale: '明确的"跑一次回测"诉求 —— 与 list_experiments（读历史）是**不同意图**，最容易混淆',
  },
  {
    id: 'param-scan',
    question: '帮我扫一下均线参数，看哪组稳',
    tool: 'run_param_scan',
    args: { symbol: 'sh600519', strategy: 'ma', count: 300 },
    descMustMention: ['参数', '稳健'],
    expect: (r) => /扫描|组/.test(r.summary),
    rationale: '"扫参数看稳健性"要的是孤峰/平原判定，不是单次回测的收益数字',
  },
  {
    id: 'factor-exposure',
    question: '我这个组合偏向什么风格？动量暴露多高？',
    tool: 'get_factor_exposure',
    args: {},
    descMustMention: ['暴露', '加权'],
    expect: (r) => /因子暴露/.test(r.summary) && /覆盖/.test(r.summary),
    rationale:
      '组合"风格/暴露"要按持仓市值加权各标的的因子值；与 get_portfolio（只给持仓结构）不同 —— ' +
      '这是 Phase 4 与 Phase 3 的意图边界，最容易混',
  },
];

/**
 * 需要**真实横截面归档**（data/history 多标的）才能跑的工具 ——
 * 假 K 线不足以构造截面，故不纳入黄金集；它们的正确性由各自专项测试保证：
 *   · eval_factors → test/agent-*.test.cjs 中的因子评估用例
 *   · factor_ic    → test/agent-factor-ic.test.cjs
 * ⚠️ 这里显式列出而不是静默跳过：将来若有人把这两个改成可离线验证，
 *   应当补黄金用例并把它们从本清单移除。
 */
const NEEDS_REAL_ARCHIVE = ['eval_factors', 'factor_ic'];

// ── ① 注册表一致 ──────────────────────────────────────────────
test('① 注册表一致：ENABLED_TOOLS 每一项都真实存在于工具箱', () => {
  const names = new Set(makeTb().tools.map((t) => t.name));
  const ghost = ENABLED_TOOLS.filter((n) => !names.has(n));
  assert.deepStrictEqual(ghost, [],
    `以下被启用的工具在工具箱里不存在（模型永远看不到它们）：${ghost.join(', ')}`);
});

test('① 反向：工具箱里的工具若未启用，必须能说明原因（防止"写了但忘了开"）', () => {
  const enabled = new Set(ENABLED_TOOLS);
  const disabled = makeTb().tools.map((t) => t.name).filter((n) => !enabled.has(n));
  // 目前有 2 个：get_quote / get_news（P3 试点未注入实时依赖）
  // 这不算错，但数量变化应当被察觉 —— 所以断言"已知的未启用集合"
  assert.deepStrictEqual(disabled.sort(), ['get_news', 'get_quote'],
    '未启用集合发生变化：若是新增工具请补黄金用例并更新此断言；若是漏启用请修 ENABLED_TOOLS');
});

// ── ② 描述自洽（承诺 vs 实现）──────────────────────────────────
test('② 每个黄金工具的 desc 都含"何时该用我"的判别信号', () => {
  const tb = makeTb();
  for (const c of GOLDEN) {
    const t = tb.tools.find((x) => x.name === c.tool);
    assert.ok(t, `${c.id}: 工具 ${c.tool} 不存在`);
    for (const word of c.descMustMention) {
      assert.ok(t.desc.includes(word),
        `${c.id}: ${c.tool} 的 desc 缺少「${word}」——模型可能无法把它与相邻工具区分开`);
    }
  }
});

test('② desc 不得承诺实现里没有的能力（抽查高辨识度承诺）', () => {
  const tb = makeTb();
  const promises = [
    // [工具, desc 中的承诺关键词, 用假 deps 跑出来是否真能体现]
    ['list_experiments', '可按标的', (r) => /sh600519/.test(r.summary)],
    ['read_report', '降级情况', (r) => /降级/.test(r.summary)],
    ['get_portfolio', '占总资产比', (r) => /占 60\.00%/.test(r.summary)],
    ['check_factor_expr', '方向推断', (r) => /方向推断/.test(r.summary)],
  ];
  return (async () => {
    for (const [name, promise, verify] of promises) {
      const t = tb.tools.find((x) => x.name === name);
      // desc 里没写这条承诺就不必验证（避免过度约束：不是每个工具都要承诺所有能力）
      if (!t.desc.includes(promise)) continue;
      const args = name === 'read_report' ? { id: 'r-1' } : name === 'check_factor_expr' ? { expr: 'mom20' } : {};
      const r = await t.run(args);
      assert.ok(verify(r), `${name}: desc 承诺了「${promise}」，但实际输出没有体现 —— 文档在说谎`);
    }
  })();
});

// ── ③ 能力可用 ────────────────────────────────────────────────
test('③ 黄金集的每个问题，用期望工具都能拿到有意义的输出', async () => {
  const tb = makeTb();
  for (const c of GOLDEN) {
    const t = tb.tools.find((x) => x.name === c.tool);
    const r = await t.run(c.args);
    // knowledge_search 在假知识库下可能命中 0 条 ⇒ 允许 fail，但必须给出可操作提示
    if (c.tool === 'knowledge_search') {
      assert.ok(typeof r.summary === 'string' && r.summary.length > 0, `${c.id}: 应有可读输出`);
      continue;
    }
    assert.strictEqual(r.ok, true, `${c.id}: ${c.tool} 返回 fail —— ${r.summary}`);
    assert.ok(c.expect(r), `${c.id}: 输出未包含期望特征\n---\n${r.summary.slice(0, 200)}`);
  }
});

// ── 覆盖检查 ──────────────────────────────────────────────────
test('覆盖：每个已启用工具至少被一个黄金问题覆盖（或明确标注需真实归档）', () => {
  const covered = new Set([...GOLDEN.map((c) => c.tool), ...NEEDS_REAL_ARCHIVE]);
  const uncovered = ENABLED_TOOLS.filter((n) => !covered.has(n));
  assert.deepStrictEqual(uncovered, [],
    `以下已启用工具既无黄金用例、也未标注"需真实归档"（新增工具后请补）：${uncovered.join(', ')}`);
});

test('黄金集自洽：每条都有 rationale（说明"为什么这个问题该用这个工具"）', () => {
  for (const c of GOLDEN) {
    assert.ok(c.rationale && c.rationale.length > 8, `${c.id} 缺少 rationale`);
    assert.ok(c.question && c.tool && typeof c.expect === 'function', `${c.id} 结构不完整`);
  }
  // id 唯一
  const ids = GOLDEN.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'golden id 必须唯一');
});

test('因子目录单一源：list_factors 的因子数与 crosssect.FACTOR_WINDOWS 一致', async () => {
  // 与 agent-factor-tools.test.cjs 重复是刻意的：这里是"黄金集口径"，
  // 若哪天有人把 factor-tools 的断言放宽，这一条仍会盯着单一源。
  const r = await makeTb().tools.find((t) => t.name === 'list_factors').run({});
  assert.strictEqual(r.data.factors.length, Object.keys(crosssect.FACTOR_WINDOWS).length);
});
