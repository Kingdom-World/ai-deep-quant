'use strict';
// ─────────────────────────────────────────────────────────────
// 板块与资讯域路由（Provider 网关拆分 · 第一刀）
//   · /api/ticks/:symbol    逐笔成交（东财 push2 双 host 容错，5s 缓存）
//   · /api/sectors/flow     板块主力净流入排行
//   · /api/sectors/cards    板块卡片（涨跌幅 + sparkline + 领涨股）
//   · /api/feed/:symbol     量化看板右侧面板（资金流/财务/估值/公告）
//   · /api/news             多源聚合资讯（market/stock/official）
//   · /api/news/health      资讯源健康度观测
// 行为零变化拆分：路由体自 index.cjs 原样迁移，仅依赖改为显式注入；
// tdxHealth 由宿主以 getter 注入（该值在宿主侧被定时探测刷新）。
// ─────────────────────────────────────────────────────────────

/** 注册板块与资讯域路由 */
function registerSectorsNewsRoutes(app, deps) {
  const { axios, UA, sectors, datafeeds, newsEngine, newsStore, toTencentCode, getTdxHealth } = deps;

  const ticksCache = new Map(); // secid -> { ts, data }（5s TTL，仅本域使用）

  /** 资讯统一结构转换：补 id / 分类 / 抓取时间，保留匹配信息 */
  function toNewsItem(item, { category, symbol, fetchedAt }) {
    const publishedMs = Date.parse(String(item?.publishedAt || item?.date || '')) || Date.now();
    const media = String(item?.media || '公开资讯').trim();
    const url = String(item?.url || '').trim();
    return {
      id: `${media}:${url}`.slice(0, 500),
      title: String(item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      snippet: String(item?.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      media,
      url,
      date: new Date(publishedMs).toISOString().slice(0, 10),
      publishedAt: new Date(publishedMs).toISOString(),
      fetchedAt,
      category,
      sourceType: 'public-media',
      symbol: String(symbol || ''),
      symbols: Array.isArray(item?.symbols) ? item.symbols.slice(0, 20) : [],
      source: String(item?.source || '').slice(0, 40),
      matchScore: typeof item?.matchScore === 'number' ? item.matchScore : undefined,
      matchReason: item?.matchReason || undefined,
      matchLevel: item?.matchLevel || undefined,
    };
  }

  /** GET /api/ticks/:symbol —— 逐笔成交（东财 push2 双 host 容错） */
  app.get('/api/ticks/:symbol', async (req, res) => {
    const raw = String(req.params.symbol || '').trim().toLowerCase();
    const m = raw.match(/^(?:sh|sz|bj)?(\d{6})$/);
    if (!m) return res.status(400).json({ ok: false, error: '逐笔成交仅支持 A 股代码（沪 60 / 深 00·30 / 北交所）' });
    const code = m[1];
    const secid = (code.startsWith('6') ? '1.' : '0.') + code;
    const cached = ticksCache.get(secid);
    if (cached && Date.now() - cached.ts < 5000) return res.json(cached.data);
    const hosts = ['push2.eastmoney.com', 'push2delay.eastmoney.com'];
    let details = null;
    let lastErr = null;
    for (const host of hosts) {
      try {
        const url = `https://${host}/api/qt/stock/details/get?secid=${secid}&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55&pos=-600`;
        const r = await axios.get(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout: 8000 });
        details = r.data?.data?.details ?? null;
        if (details && details.length) break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!details) {
      return res.status(502).json({ ok: false, error: '逐笔数据获取失败: ' + String(lastErr?.message || '无数据').slice(0, 60) });
    }
    // 行格式 "HH:MM:SS,成交价,价格变动(分),成交量(手),性质(1买/2卖/4中性)"
    const ticks = details
      .map((line) => {
        const [time, price, chg, vol, type] = String(line).split(',');
        return { time, price: +price, chg: +chg, vol: +vol, type: type === '1' ? 'B' : type === '2' ? 'S' : 'M' };
      })
      .filter((t) => Number.isFinite(t.price));
    const data = { ok: true, code: code, ticks, ts: Date.now() };
    ticksCache.set(secid, { ts: Date.now(), data });
    res.json(data);
  });

  /** GET /api/sectors/flow?type=industry|concept|region —— 板块主力净流入排行 */
  app.get('/api/sectors/flow', async (req, res) => {
    const type = ['industry', 'concept', 'region'].includes(req.query.type) ? req.query.type : 'industry';
    try {
      const r = await sectors.getFlow(type);
      if (!r) return res.status(502).json({ ok: false, error: '板块数据源暂不可用' });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: `板块数据失败: ${e.message?.slice(0, 60)}` });
    }
  });

  /** GET /api/sectors/cards?type=... —— 板块卡片（涨跌幅排序 + 分时 sparkline + 领涨股） */
  app.get('/api/sectors/cards', async (req, res) => {
    const type = ['industry', 'concept', 'region'].includes(req.query.type) ? req.query.type : 'industry';
    try {
      const r = await sectors.getCards(type, 8);
      if (!r) return res.status(502).json({ ok: false, error: '板块数据源暂不可用' });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: `板块数据失败: ${e.message?.slice(0, 60)}` });
    }
  });

  /** GET /api/feed/:symbol —— 量化看板右侧面板数据（资金流/财务/估值/公告） */
  app.get('/api/feed/:symbol', async (req, res) => {
    try {
      const code = toTencentCode(req.params.symbol);
      const feed = await datafeeds.getAll(code);
      res.json({ ok: true, ...feed });
    } catch (e) {
      res.status(500).json({ ok: false, error: `数据获取失败: ${e.message?.slice(0, 80)}` });
    }
  });

  /** GET /api/news?type=market|stock|official&symbol=sh600519&limit=60 */
  app.get('/api/news', async (req, res) => {
    const type = ['market', 'stock', 'official'].includes(String(req.query.type || 'market')) ? String(req.query.type || 'market') : 'market';
    const symbol = req.query.symbol ? toTencentCode(String(req.query.symbol)) : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    if ((type === 'stock' || type === 'official') && !/^(sh|sz|bj)\d{6}$/.test(symbol)) {
      return res.status(400).json({ ok: false, error: '个股资讯需要有效的 A 股代码（例如 sh600519）' });
    }
    const fetchedAt = new Date().toISOString();
    const sourceNote =
      type === 'official'
        ? '东方财富公告聚合接口，具体来源以原文链接为准；不等同于监管机构或交易所官网'
        : '多源聚合（东方财富 7x24 快讯 / 个股官方资讯 / 新浪财经 / 腾讯自选股资讯），个股资讯经匹配引擎按相关度排序';

    try {
      let rows = [];
      if (type === 'market') {
        const market = await newsEngine.getMarketNews({ pages: 3 });
        rows = (market || []).map((item) => toNewsItem(item, { category: 'market', symbol: '', fetchedAt }));
      } else if (type === 'stock') {
        const { profile, items } = await newsEngine.getStockNews(symbol, { limit });
        rows = (items || []).map((item) => toNewsItem(item, { category: 'stock', symbol, fetchedAt }));
        if (rows.length) newsStore.merge(rows.map((r) => ({ ...r, symbols: [symbol] })));
        return res.json({
          ok: true,
          type,
          symbol,
          stockName: profile?.name || null,
          items: rows,
          fetchedAt,
          stale: false,
          retentionHours: 72,
          sourceNote,
        });
      } else {
        const feed = await datafeeds.getAll(symbol);
        rows = (feed?.announcements || []).map((item) => toNewsItem(item, { category: 'official', symbol, fetchedAt }));
      }

      if (rows.length) newsStore.merge(rows);
      const result = rows.length ? rows.slice(0, limit) : newsStore.list({ category: type, symbol: type === 'market' ? '' : symbol, limit });
      res.json({
        ok: true,
        type,
        symbol: symbol || null,
        items: result,
        fetchedAt,
        stale: rows.length === 0,
        retentionHours: 72,
        sourceNote,
      });
    } catch (e) {
      // 上游全失败：有本地快照则 200+stale 返回快照；连快照都没有（如 Vercel 冷实例首次失败）
      // 也返回 200 + ok:false 的**显式降级载荷**，而不是 502 —— 502 会触发前端错误重试链路、
      // 让页面长时间停留在加载态；ok:false 才能让 UI 立即渲染"暂不可用"空态并保留错误文案。
      const result = newsStore.list({ category: type, symbol: type === 'market' ? '' : symbol, limit });
      res.status(200).json({
        ok: result.length > 0,
        type,
        symbol: symbol || null,
        items: result,
        fetchedAt: new Date().toISOString(),
        stale: true,
        retentionHours: 72,
        error: result.length ? '上游资讯暂不可用，当前展示近三天本地快照' : '上游资讯源全部不可用且暂无本地快照，请稍后刷新重试',
      });
    }
  });

  /** GET /api/news/health —— 数据源健康度观测（含通达信行情通道探测结果） */
  app.get('/api/news/health', (_req, res) => {
    res.json({ ok: true, ...newsEngine.getHealth(), tdxChannel: getTdxHealth(), snapshot: newsStore.snapshotInfo() });
  });
}

module.exports = { registerSectorsNewsRoutes };
