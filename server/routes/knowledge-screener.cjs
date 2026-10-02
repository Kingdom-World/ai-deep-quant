'use strict';
// ─────────────────────────────────────────────────────────────
// 知识库 / 选股 / 市场温度计 / 自选股域路由（Provider 网关拆分 · 第三刀）
//   · /api/knowledge/search|entries   知识库检索（M1-1.3）
//   · /api/screener/strategies|screener  全市场选股
//   · /api/mood                        市场温度计
//   · /api/watchlist GET|POST|DELETE   自选股池（uid 隔离，持久化）
// 行为零变化拆分：路由体自 index.cjs 原样迁移，仅依赖改为显式注入。
// knowledgeBase/screener 的 require 留守宿主（AI 问答工具注册仍在引用）。
// ─────────────────────────────────────────────────────────────

/** 注册知识/选股/自选域路由 */
function registerKnowledgeScreenerRoutes(app, deps) {
  const { knowledgeBase, screener, watchlist, broker } = deps;

// ── 知识库（M1-1.3）：结构化条目检索 + 出处 ──
//   口径：q 为空时返回该分类全部条目（浏览模式）；多词按 AND 语义，命中位置加权排序。
//   返回 stats/categories 随结果一并给出，供 UI 渲染过滤器与页头统计，避免二次请求。
app.get('/api/knowledge/search', (req, res) => {
  try {
    // 长度上限：超长 query 会让 n-gram 切词做平方级 slice（子代理评审 non-blocking）
    const q = String(req.query.q || '').slice(0, 200);
    const category = req.query.category ? String(req.query.category) : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const r = knowledgeBase.search(q, { category, limit });
    res.json({ ok: true, query: q, category: category || null, mode: r.mode, total: r.total, items: r.items, stats: knowledgeBase.stats(), categories: knowledgeBase.categories() });
  } catch (e) {
    res.status(500).json({ ok: false, error: '知识库检索失败: ' + (e.message || '').slice(0, 80) });
  }
});

// 按 id 取条目（前端关联口径跳转 / Agent 引用校验）
app.get('/api/knowledge/entries', (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    res.json({ ok: true, items: knowledgeBase.byIds(ids) });
  } catch (e) {
    res.status(500).json({ ok: false, error: '知识库读取失败: ' + (e.message || '').slice(0, 80) });
  }
});

// ── 全市场选股 + 市场温度计（融合 tick-stock-panel/TSP） ──
app.get('/api/screener/strategies', (req, res) => {
  res.json({ ok: true, strategies: Object.entries(screener.STRATEGIES).map(([key, s]) => ({ key, name: s.name, desc: s.desc })) });
});
app.get('/api/screener', async (req, res) => {
  try {
    res.json(await screener.runScreener(String(req.query.strategy || 'volumeSurge'), String(req.query.sort || 'pct'), Math.min(Number(req.query.limit) || 50, 100)));
  } catch (e) {
    res.status(502).json({ ok: false, error: '选股失败: ' + (e.message || '').slice(0, 80) });
  }
});
app.get('/api/mood', async (req, res) => {
  try {
    res.json(await screener.getMood());
  } catch (e) {
    res.status(502).json({ ok: false, error: '市场温度计失败: ' + (e.message || '').slice(0, 80) });
  }
});

// ── 自选股池（uid 隔离，持久化） ──
app.get('/api/watchlist', (req, res) => {
  res.json({ ok: true, items: watchlist.list(broker.uidOf(req)) });
});
app.post('/api/watchlist', (req, res) => {
  const r = watchlist.add(broker.uidOf(req), req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
app.delete('/api/watchlist/:symbol', (req, res) => {
  const r = watchlist.remove(broker.uidOf(req), req.params.symbol);
  res.status(r.ok ? 200 : 400).json(r);
});
}

module.exports = { registerKnowledgeScreenerRoutes };
