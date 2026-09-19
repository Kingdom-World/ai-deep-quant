// ─────────────────────────────────────────────────────────────
// Agent 工具层（P1）
//
//   三个设计要点（都来自前序决策，不是随意选择）：
//
//   ① **进程内调用**（D2）：回测/参数扫描/因子评估一律 require 直调，
//      不走 HTTP 回环。这让「调用者身份」天然二分且不可伪造
//      （进程内 = Agent / HTTP = 人），也避免了自己请求自己。
//
//   ② **summary 与 data 分离**（R3）：工具返回同时给出
//      · summary —— 简短文本，**回灌给模型**（控制上下文，避免 MAX_CONTEXT_CHARS 撑爆）
//      · data    —— 完整结构，**给报告与前端**（不进入模型上下文）
//
//   ③ **每个工具必带指纹**（A2）：复用 fingerprint.cjs，
//      使 Agent 的结论可追溯、可复现。
//
//   依赖注入：行情/K线/资讯的抓取函数由 index.cjs 传入
//   （它们原本内联在路由里，不重复实现一份在线抓取逻辑）。
// ─────────────────────────────────────────────────────────────
const fingerprint = require('../fingerprint.cjs');
const { runBacktest } = require('../quant.cjs');
const paramscan = require('../paramscan.cjs');
const factoreval = require('../factoreval.cjs');
const knowledgeBase = require('../knowledge.cjs');

/** 统一的成功返回 */
function ok(summary, data, fp, extra = {}) {
  return { ok: true, summary, data, dataFingerprint: fp, ...extra };
}
/** 统一的失败返回（失败也要回灌给模型，让它能自我纠正） */
function fail(summary, extra = {}) {
  return { ok: false, summary: `调用失败：${summary}`, data: null, ...extra };
}

/**
 * 创建工具箱
 * @param deps { fetchQuote, fetchKlines, fetchNews, marketOf, priceLimitPct }
 */
function createToolbox(deps = {}) {
  const { fetchQuote, fetchKlines, fetchNews, marketOf, priceLimitPct } = deps;

  const tools = [
    {
      name: 'get_quote',
      desc: '获取标的实时行情快照',
      params: [{ name: 'symbol', type: 'string', required: true }],
      async run({ symbol }) {
        if (!fetchQuote) return fail('行情模块未接入');
        const q = await fetchQuote(symbol);
        if (!q) return fail(`未取到 ${symbol} 的报价`);
        const s = `${symbol} 最新价 ${q.price}，涨跌幅 ${q.changePct ?? '--'}%，前收 ${q.prevClose ?? '--'}`;
        return ok(s, q, fingerprint.build({ params: { symbol }, data: { source: 'realtime', adjust: 'none', lastDate: null } }));
      },
    },

    {
      name: 'get_klines',
      desc: '获取标的日 K 线（前复权）',
      params: [
        { name: 'symbol', type: 'string', required: true },
        { name: 'count', type: 'number', required: false, default: 500 },
      ],
      async run({ symbol, count }) {
        if (!fetchKlines) return fail('K 线模块未接入');
        const n = Math.min(Math.max(Number(count) || 500, 30), 2000);
        const klines = await fetchKlines(symbol, n);
        if (!klines || !klines.length) return fail(`未取到 ${symbol} 的 K 线`);
        const first = klines[0];
        const last = klines[klines.length - 1];
        const s = `${symbol} 取得 ${klines.length} 根日K（${first.date} ~ ${last.date}），最新收 ${last.close}`;
        return ok(
          s,
          { bars: klines.length, range: { start: first.date, end: last.date }, lastClose: last.close },
          fingerprint.build({
            params: { symbol, count: n },
            data: {
              source: 'tencent',
              adjust: 'qfq',
              lastDate: last.date,
              rowsHash: fingerprint.rowsHash(klines),
            },
          }),
        );
      },
    },

    {
      name: 'run_backtest',
      desc: '对单标的执行策略回测',
      params: [
        { name: 'symbol', type: 'string', required: true },
        { name: 'strategy', type: 'string', required: false, default: 'ma' },
        { name: 'fast', type: 'number', required: false, default: 5 },
        { name: 'slow', type: 'number', required: false, default: 20 },
        { name: 'count', type: 'number', required: false, default: 1000 },
      ],
      async run({ symbol, strategy, fast, slow, count }) {
        if (!fetchKlines) return fail('K 线模块未接入');
        const mkt = marketOf ? marketOf(symbol) : 'CN';
        const klines = await fetchKlines(symbol, Math.min(Math.max(Number(count) || 1000, 80), 2000));
        if (!klines || !klines.length) return fail(`未取到 ${symbol} 的 K 线`);

        const strat = ['ma', 'rsi', 'buyhold'].includes(strategy) ? strategy : 'ma';
        const r = runBacktest(klines, strat, Number(fast), Number(slow), 100000, mkt, {
          slippage: 0.001,
          limitPct: mkt === 'CN' && priceLimitPct ? priceLimitPct(symbol, null) : null,
        });
        if (r.error) return fail(r.error);

        const s =
          `${symbol} ${strat}(fast=${fast},slow=${slow})：总收益 ${r.totalReturn}%，` +
          `年化 ${r.annualized}%，最大回撤 ${r.maxDrawdownPct}%，成交 ${r.tradeCount} 笔，胜率 ${r.winRate}%`;
        return ok(
          s,
          {
            symbol,
            strategy: strat,
            totalReturn: r.totalReturn,
            annualized: r.annualized,
            maxDrawdownPct: r.maxDrawdownPct,
            sharpe: r.sharpe,
            tradeCount: r.tradeCount,
            winRate: r.winRate,
            range: r.range,
          },
          fingerprint.build({
            params: { symbol, strategy: strat, fast, slow, count: klines.length },
            data: {
              source: 'tencent',
              adjust: 'qfq',
              lastDate: r.range?.end ?? null,
              rowsHash: fingerprint.rowsHash(klines),
            },
          }),
        );
      },
    },

    {
      name: 'run_param_scan',
      desc: '扫描参数网格并判定稳健性（孤峰/样本外/成本敏感度）',
      params: [
        { name: 'symbol', type: 'string', required: true },
        { name: 'fastFrom', type: 'number', required: false, default: 5 },
        { name: 'fastTo', type: 'number', required: false, default: 20 },
        { name: 'slowFrom', type: 'number', required: false, default: 20 },
        { name: 'slowTo', type: 'number', required: false, default: 60 },
        { name: 'count', type: 'number', required: false, default: 1500 },
      ],
      async run({ symbol, fastFrom, fastTo, slowFrom, slowTo, count }) {
        if (!fetchKlines) return fail('K 线模块未接入');
        const mkt = marketOf ? marketOf(symbol) : 'CN';
        const klines = await fetchKlines(symbol, Math.min(Math.max(Number(count) || 1500, 200), 2000));
        const r = paramscan.scan({
          klines,
          fastRange: [Number(fastFrom) || 5, Number(fastTo) || 20, 1],
          slowRange: [Number(slowFrom) || 20, Number(slowTo) || 60, 5],
          capital: 100000,
          market: mkt,
          limitPct: mkt === 'CN' && priceLimitPct ? priceLimitPct(symbol, null) : null,
        });
        if (!r.ok) return fail(r.error);

        const oos = r.outOfSample?.available
          ? `样本内最优 ${r.outOfSample.inSampleBest.totalReturn}% → 样本外 ${r.outOfSample.outSample.totalReturn}%（差 ${r.outOfSample.outMinusIn}pp）`
          : '样本外不可用';
        const s =
          `${symbol} 扫描 ${r.params.trials} 组：最优 fast=${r.best.fast}/slow=${r.best.slow} 收益 ${r.best.totalReturn}%；` +
          `孤峰判定「${r.peak.verdict}」（${r.peak.reason}）；${oos}`;
        return ok(
          s,
          {
            best: r.best,
            peak: r.peak,
            outOfSample: r.outOfSample,
            costSensitivity: r.costSensitivity,
            trials: r.params.trials,
          },
          fingerprint.build({
            params: { symbol, fastFrom, fastTo, slowFrom, slowTo },
            data: { source: 'tencent', adjust: 'qfq', rowsHash: fingerprint.rowsHash(klines) },
          }),
        );
      },
    },

    {
      name: 'eval_factors',
      desc: '评估因子的稳健性（全区间 + 逐年，判定是否稳定）',
      params: [
        { name: 'factors', type: 'string', required: false, default: '' },
        { name: 'topN', type: 'number', required: false, default: 20 },
        { name: 'rebalanceEvery', type: 'number', required: false, default: 20 },
      ],
      async run({ factors, topN, rebalanceEvery }) {
        const list = String(factors || '')
          .split(/[,，\s]+/)
          .map((x) => x.trim())
          .filter(Boolean);
        const r = factoreval.evaluate({
          factors: list.length ? list : undefined,
          topN: Number(topN) || 20,
          rebalanceEvery: Number(rebalanceEvery) || 20,
        });
        if (!r.ok) return fail('因子评估失败');

        const lines = r.factors.map(
          (f) => `${f.factor}：全区间超额 ${f.full?.excess ?? '--'}pp，逐年 ${f.stability.posYears}/${f.stability.totalYears} 年为正，平均 ${f.stability.avgExcess}pp → ${f.stability.verdict}`,
        );
        return ok(
          `${r.params.yearFrom}-${r.params.yearTo} 逐年评估：\n${lines.join('\n')}`,
          r.factors.map((f) => ({ factor: f.factor, full: f.full, stability: f.stability })),
          fingerprint.build({ params: { topN, rebalanceEvery, yearFrom: r.params.yearFrom }, data: { source: 'archive', adjust: 'none+factor' } }),
        );
      },
    },

    {
      name: 'get_news',
      desc: '获取标的最近资讯与公告',
      params: [
        { name: 'symbol', type: 'string', required: true },
        { name: 'limit', type: 'number', required: false, default: 5 },
      ],
      async run({ symbol, limit }) {
        if (!fetchNews) return fail('资讯模块未接入');
        const list = (await fetchNews(symbol)) || [];
        const n = Math.min(Math.max(Number(limit) || 5, 1), 20);
        const top = list.slice(0, n);
        if (!top.length) return fail(`未取到 ${symbol} 的资讯`);
        return ok(
          top.map((x, i) => `${i + 1}. ${x.title || x.name || '(无标题)'}`).join('\n'),
          top,
          fingerprint.build({ params: { symbol, limit: n }, data: { source: 'news' } }),
        );
      },
    },

    // ── 知识库检索（M1-1.5）──
    //   为什么给 Agent 这个工具：模型最容易犯的错是"用自己的先验解释平台口径"
    //   （例如凭常识说清印花税、凭印象说复权规则）。知识库是平台口径的唯一权威源，
    //   带出处，因此要求模型涉及定义/口径/方法时先查再答，并在结论中标注条目 id。
    //   返回的 summary 里**直接列出条目 id**，这样引用行为在 trace 中可核查。
    {
      name: 'knowledge_search',
      desc: '检索平台知识库（术语定义 / 口径出处 / 方法论），返回带出处的结构化条目',
      params: [
        { name: 'query', type: 'string', required: true },
        { name: 'category', type: 'string', required: false, default: '' },
      ],
      async run({ query, category }) {
        const q = String(query || '').trim();
        const catRaw = String(category || '');
        const cat = ['term', 'basis', 'method', 'paper'].includes(catRaw) ? catRaw : undefined;
        // query 与 category 至少给一个：
        //   只给 category = 按分类浏览（Agent 常问「方法论都有哪些」）
        //   只给 query    = 全库检索
        if (!q && !cat) return fail('query 与 category 至少需要一个（category 可为 term/basis/method/paper）');
        const r = knowledgeBase.search(q, { category: cat, limit: 5 });
        if (!r.total) {
          return fail(
            q
              ? `知识库中没有与「${q}」相关的条目（可换关键词，或去掉 category 限制）`
              : `知识库中没有 category=${cat} 的条目`,
          );
        }
        const scope = q ? `「${q}」` : `分类 ${cat}`;

        const lines = r.items.map(
          (e, i) => `${i + 1}. [${e.id}]（${e.categoryLabel}）${e.title}\n   摘要：${e.body.slice(0, 120)}…\n   出处：${e.source.slice(0, 100)}…`,
        );
        return ok(
          `知识库${scope}命中 ${r.total} 条（检索模式：${r.mode}），取前 ${r.items.length} 条：\n${lines.join('\n')}\n\n【引用要求】结论中涉及定义/口径/方法时，引用对应条目 id（如 term-pit），不要改述出处内容。`,
          r.items.map((e) => ({ id: e.id, category: e.category, title: e.title, body: e.body, source: e.source, tags: e.tags })),
          // 知识条目是随代码版本管理的静态内容，指纹用 title 集合表达"内容版本"
          fingerprint.build({ params: { query: q, category: cat || null }, data: { source: 'knowledge', adjust: 'none', lastDate: null } }),
        );
      },
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    tools,
    /** 供协议层使用的最小契约（含参数顺序，R1 教训：模型用位置参数） */
    get spec() {
      return tools.map((t) => ({ name: t.name, desc: t.desc, params: t.params }));
    },
    /** 执行一次工具调用；任何异常都转成可回灌的失败结果，不抛出 */
    async call(name, args) {
      const t = byName.get(name);
      if (!t) return { ok: false, summary: `调用失败：未知工具 "${name}"`, data: null };
      try {
        return await t.run(args || {});
      } catch (e) {
        return { ok: false, summary: `调用失败：${String(e.message).slice(0, 120)}`, data: null };
      }
    },
  };
}

module.exports = { createToolbox };
