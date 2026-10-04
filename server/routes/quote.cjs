'use strict';
// ─────────────────────────────────────────────────────────────
// 行情域路由（Provider 网关拆分 · 第四刀）
//   · /api/quote/:symbol            实时报价
//   · /api/history/:symbol          历史 K 线
//   · /api/period-policy/:symbol    周期可用性策略
//   · /api/mkline/:symbol           分钟 K 线
//   · /api/minute/:symbol           当日分时
//   · /api/indices                  大盘指数
//   · /api/search/:keyword          代码搜索
// 行为零变化拆分：路由体自 index.cjs 原样迁移，仅数据获取改为调用 Provider 网关。
// 路由层只负责：参数解析、HTTP 响应、错误状态码映射。
// ─────────────────────────────────────────────────────────────

/** 注册行情域路由 */
function registerQuoteRoutes(app, deps) {
  const { quoteGateway } = deps;

  // ───────────── 1. 实时报价 ─────────────
  app.get('/api/quote/:symbol', async (req, res) => {
    try {
      const quote = await quoteGateway.fetchQuote(req.params.symbol);
      res.json(quote);
    } catch (e) {
      const status = e.status || 500;
      res.status(status).json({ error: e.message || '获取报价失败' });
    }
  });

  // ───────────── 2. 历史 K 线 ─────────────
  app.get('/api/history/:symbol', async (req, res) => {
    try {
      const result = await quoteGateway.fetchHistory(
        req.params.symbol,
        req.query.frequency,
        req.query.count,
        req.query.adjust,
      );
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message?.slice(0, 80) || '获取历史数据失败' });
    }
  });

  // ───────────── 2a. 周期可用性策略 ─────────────
  app.get('/api/period-policy/:symbol', async (req, res) => {
    try {
      const policy = await quoteGateway.fetchPeriodPolicy(req.params.symbol);
      res.json(policy);
    } catch (e) {
      res.status(500).json({ error: `周期策略计算失败: ${e.message?.slice(0, 80)}` });
    }
  });

  // ───────────── 2b. 分钟 K 线 ─────────────
  app.get('/api/mkline/:symbol', async (req, res) => {
    try {
      const result = await quoteGateway.fetchMkline(req.params.symbol, req.query.period, req.query.count);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: `获取分钟K线失败: ${e.message?.slice(0, 80)}` });
    }
  });

  // ───────────── 2c. 当日分时 ─────────────
  app.get('/api/minute/:symbol', async (req, res) => {
    try {
      const result = await quoteGateway.fetchMinute(req.params.symbol);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: `获取分时数据失败: ${e.message?.slice(0, 80)}` });
    }
  });

  // ───────────── 3. 大盘指数 ─────────────
  app.get('/api/indices', async (req, res) => {
    try {
      const items = await quoteGateway.fetchIndices();
      res.json(items);
    } catch (e) {
      res.status(500).json({ error: `获取指数失败: ${e.message?.slice(0, 80)}` });
    }
  });

  // ───────────── 4. 搜索 ─────────────
  app.get('/api/search/:keyword', async (req, res) => {
    try {
      const items = await quoteGateway.searchSymbol(req.params.keyword);
      res.json(items);
    } catch (e) {
      res.status(500).json({ error: `搜索失败: ${e.message?.slice(0, 80)}` });
    }
  });
}

module.exports = { registerQuoteRoutes };
