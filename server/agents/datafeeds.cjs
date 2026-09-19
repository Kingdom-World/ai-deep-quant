// ─────────────────────────────────────────────────────────────
// 数据接入层：东方财富公开接口（基本面 / 资金流 / 公告 / 估值）
//   · 全部带内存缓存与 6s 超时；任一接口失败返回 null（Agent 降级为价格行为代理）
//   · 覆盖范围：沪深 A 股（sh/sz 前缀）；港股/美股返回 null
// ─────────────────────────────────────────────────────────────
const axios = require('axios');
const newsEngine = require('../news/index.cjs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const cache = new Map();
const lastGood = new Map();
const TTL = { flow: 120_000, fund: 600_000, news: 600_000, val: 120_000 };

async function getJSON(url, referer) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': UA, Referer: referer }, timeout: 6000 });
      return res.data;
    } catch (e) {
      lastErr = e;
      if (url.includes('push2.eastmoney.com')) {
        try {
          const res2 = await axios.get(url.replace('push2.eastmoney.com', 'push2delay.eastmoney.com'), { headers: { 'User-Agent': UA }, timeout: 6000 });
          return res2.data;
        } catch (e2) {
          lastErr = e2;
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

function emSecid(symbol) {
  const s = String(symbol).toLowerCase();
  if (/^sh/.test(s)) return '1.' + s.replace(/^sh/, '');
  if (/^sz/.test(s)) return '0.' + s.replace(/^sz/, '');
  if (/^bj/.test(s)) return '0.' + s.replace(/^bj/, ''); // 北交所与深市同用 0 市场前缀
  return null;
}

function emSecucode(symbol) {
  const s = String(symbol).toLowerCase();
  if (/^sh/.test(s)) return s.replace(/^sh/, '') + '.SH';
  if (/^sz/.test(s)) return s.replace(/^sz/, '') + '.SZ';
  if (/^bj/.test(s)) return s.replace(/^bj/, '') + '.BJ';
  return null;
}

function cached(key, ttl, loader) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < ttl) return Promise.resolve(c.data);
  return (async () => {
    let data = null;
    try {
      data = await loader();
    } catch {
      data = null;
    }
    if (data != null) {
      cache.set(key, { ts: Date.now(), data });
      lastGood.set(key, { ts: Date.now(), data });
      return data;
    }
    const g = lastGood.get(key);
    if (g && Date.now() - g.ts < 10 * 60_000) return g.data;
    return null;
  })();
}

/** 个股资金流：近 20 日主力净流入（元），含 5/10 日合计与连续方向 */
function getMoneyFlow(symbol) {
  return cached('flow:' + symbol, TTL.flow, async () => {
    const secid = emSecid(symbol);
    if (!secid) return null;
    const url =
      `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=${secid}` +
      `&fields1=f1,f2,f3,f7&fields2=f51,f52,f57&klt=101&lmt=20&invt=2`;
    const j = await getJSON(url, 'https://data.eastmoney.com/');
    const klines = j?.data?.klines;
    if (!Array.isArray(klines) || !klines.length) return null;
    const rows = klines
      .map((s) => {
        const p = s.split(',');
        const pct = Number(p[2]);
        return {
          date: p[0],
          mainNet: Number(p[1]),
          mainPct: Number.isFinite(pct) ? pct : null,
        };
      })
      .filter((r) => Number.isFinite(r.mainNet));
    if (!rows.length) return null;
    const last5 = rows.slice(-5);
    const last10 = rows.slice(-10);
    let streak = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const d = rows[i].mainNet > 0 ? 1 : -1;
      if (i === rows.length - 1) streak = d;
      else if (d === Math.sign(streak)) streak += d;
      else break;
    }
    return {
      rows,
      sum5: last5.reduce((a, r) => a + r.mainNet, 0),
      sum10: last10.reduce((a, r) => a + r.mainNet, 0),
      streak, // 正=连续净流入 N 天，负=连续净流出
      lastPct: rows[rows.length - 1].mainPct,
    };
  });
}

/** 财务主要指标（近 6 期报告）：EPS / ROE / 负债率 / 毛利率 / 营收 / 归母净利 + 净利同比 */
function getFundamentals(symbol) {
  return cached('fund:' + symbol, TTL.fund, async () => {
    const code = emSecucode(symbol);
    if (!code) return null;
    const url =
      `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA` +
      `&columns=SECUCODE,REPORT_DATE,EPSJB,ROEJQ,ZCFZL,XSMLL,TOTALOPERATEREVE,PARENTNETPROFIT` +
      `&filter=(SECUCODE%3D%22${encodeURIComponent(code)}%22)&pageNumber=1&pageSize=6` +
      `&sortColumns=REPORT_DATE&sortTypes=-1&source=HSF10&client=PC`;
    const j = await getJSON(url, 'https://emweb.securities.eastmoney.com/');
    const rows = j?.result?.data;
    if (!Array.isArray(rows) || !rows.length) return null;
    const latest = rows[0];
    const d = String(latest.REPORT_DATE || '').slice(0, 10);
    let profitYoY = null;
    const prev = rows.find(
      (r) => String(r.REPORT_DATE || '').slice(5, 10) === d.slice(5, 10) && String(r.REPORT_DATE || '').slice(0, 4) === String(Number(d.slice(0, 4)) - 1),
    );
    if (prev && prev.PARENTNETPROFIT && latest.PARENTNETPROFIT != null) {
      profitYoY = ((latest.PARENTNETPROFIT - prev.PARENTNETPROFIT) / Math.abs(prev.PARENTNETPROFIT)) * 100;
    }
    return {
      reportDate: d,
      eps: latest.EPSJB,
      roe: latest.ROEJQ,
      debt: latest.ZCFZL,
      grossMargin: latest.XSMLL,
      revenue: latest.TOTALOPERATEREVE,
      profit: latest.PARENTNETPROFIT,
      profitYoY,
      quarters: rows.length,
      trend: rows.map((r) => ({
        date: String(r.REPORT_DATE || '').slice(0, 10),
        profit: r.PARENTNETPROFIT,
        roe: r.ROEJQ,
        revenue: r.TOTALOPERATEREVE,
      })),
    };
  });
}

/** 公告列表（近 30 条标题）：用于新闻分析师关键词情绪扫描 */
function getAnnouncements(symbol) {
  return cached('news:' + symbol, TTL.news, async () => {
    const digits = String(symbol).replace(/^(sh|sz|hk)/i, '');
    if (!/^\d{6}$/.test(digits)) return null;
    const url =
      `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=30&page_index=1` +
      `&ann_type=A&client_source=web&stock_list=${digits}`;
    const j = await getJSON(url, 'https://data.eastmoney.com/');
    const list = j?.data?.list;
    if (!Array.isArray(list) || !list.length) return null;
    return list.map((x) => ({
      date: String(x.notice_date || '').slice(0, 10),
      publishedAt: x.notice_date ? new Date(x.notice_date).toISOString() : '',
      title: String(x.title || ''),
      // 上游部分公告只返回标题和日期，使用可核验的股票公告来源页，不伪造单篇原文链接。
      url: String(x.url || x.attach_url || x.pdf_url || `https://data.eastmoney.com/notices/stock/${digits}.html`),
      media: '东方财富公告接口',
    }));
  });
}

/** 估值快照：PE(动)/PE(TTM)/PB/换手率/总市值/流通市值（fltt=2 返回浮点） */
function getValuation(symbol) {
  return cached('val:' + symbol, TTL.val, async () => {
    const secid = emSecid(symbol);
    if (!secid) return null;
    const url =
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&invt=2&fltt=2` +
      `&fields=f43,f57,f58,f162,f164,f167,f168,f116,f117`;
    const j = await getJSON(url, 'https://quote.eastmoney.com/');
    const d = j?.data;
    if (!d) return null;
    const out = {
      price: d.f43,
      pe: d.f162,
      peTtm: d.f164,
      pb: d.f167,
      turnover: d.f168,
      marketCap: d.f116,
      floatCap: d.f117,
    };
    for (const k of Object.keys(out)) {
      if (out[k] === '-' || out[k] === -1) out[k] = null;
    }
    return out;
  });
}

/**
 * 个股新闻
 * 旧实现仅用 6 位代码做全文检索，会把「百元股数量盘点」这类只是正文罗列代码的文章误召回。
 * 改为走资讯匹配引擎：官方个股资讯接口 + 名称/代码双路召回 + 上游标注关联，按相关度打分排序。
 */
function getStockNews(symbol) {
  return cached('snews:' + symbol, TTL.news, async () => {
    const norm = String(symbol).toLowerCase();
    if (!/^(sh|sz|bj)\d{6}$/.test(norm)) return null;
    const { items } = await newsEngine.getStockNews(norm, { limit: 30 });
    if (!Array.isArray(items) || !items.length) return null;
    return items.map((a) => ({
      date: String(a.publishedAt || '').slice(0, 10),
      publishedAt: String(a.publishedAt || ''),
      title: String(a.title || ''),
      media: String(a.media || '东方财富资讯'),
      snippet: String(a.snippet || ''),
      url: String(a.url || ''),
      matchScore: a.matchScore,
      matchReason: a.matchReason,
    }));
  });
}

/** 融资融券明细（近 10 个交易日：融资余额 / 融资买入额 / 偿还额） */
function getMarginData(symbol) {
  return cached('margin:' + symbol, TTL.fund, async () => {
    const digits = String(symbol).replace(/^(sh|sz|hk)/i, '');
    if (!/^\d{6}$/.test(digits)) return null;
    const url =
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_RZRQ_GGMX` +
      `&columns=ALL&filter=(scode%3D%22${digits}%22)&pageNumber=1&pageSize=10&sortColumns=DATE&sortTypes=-1&source=WEB&client=WEB`;
    const j = await getJSON(url, 'https://data.eastmoney.com/');
    const rows = j?.result?.data;
    if (!Array.isArray(rows) || !rows.length) return null;
    const items = rows.map((r) => ({
      date: String(r.DATE || '').slice(0, 10),
      rzye: Number(r.RZYE), // 融资余额（元）
      rzrqye: Number(r.RZRQYE), // 融资融券余额
      rzbuy: Number(r.RZMRE), // 融资买入额
    }));
    const first = items[0];
    const oldest = items[items.length - 1];
    return {
      rows: items,
      latestDate: first.date,
      rzye: first.rzye,
      change5: oldest.rzye ? ((first.rzye - oldest.rzye) / oldest.rzye) * 100 : null,
    };
  });
}

/** 北向持股（尝试接口，失败自动降级 null） */
function getNorthHold(symbol) {
  return cached('north:' + symbol, TTL.fund, async () => {
    const digits = String(symbol).replace(/^(sh|sz|hk)/i, '');
    if (!/^\d{6}$/.test(digits)) return null;
    const url =
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_MUTUAL_HOLDSTOCKNORTH_STA` +
      `&columns=ALL&filter=(SECURITY_CODE%3D%22${digits}%22)&pageNumber=1&pageSize=5&sortColumns=HOLD_DATE&sortTypes=-1&source=WEB&client=WEB`;
    const j = await getJSON(url, 'https://data.eastmoney.com/');
    const rows = j?.result?.data;
    if (!Array.isArray(rows) || !rows.length) return null;
    const first = rows[0];
    return {
      date: String(first.HOLD_DATE || '').slice(0, 10),
      holdShares: Number(first.HOLD_SHARES) || null,
      marketValue: Number(first.HOLD_MARKET_CAP) || null,
      ratio: Number(first.FREESHARES_RATIO ?? first.HOLD_SHARES_RATIO) || null,
    };
  });
}

/** 新浪滚动财经要闻（市场背景，非个股检索——新浪公开接口不支持关键词过滤） */
async function getMarketNews() {
  return cached('market_news', 5 * 60_000, async () => {
    const url = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=12&page=1';
    const res = await axios.get(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' }, timeout: 8000 });
    const items = res.data?.result?.data ?? [];
    const rows = items
      .filter((n) => n?.title)
      .map((n) => ({
        title: String(n.title).slice(0, 60),
        publishedAt: n.ctime ? new Date(Number(n.ctime) * 1000).toISOString() : '',
        date: n.ctime ? new Date(Number(n.ctime) * 1000).toISOString().slice(0, 10) : '',
        media: '新浪财经',
        // 滚动接口部分版本不返回单篇链接，退回新浪财经滚动来源页并保留来源标识。
        url: String(n.url || n.link || 'https://finance.sina.com.cn/roll/'),
      }));
    return rows.length ? rows : null;
  });
}

async function getAll(symbol) {
  const [moneyFlow, fundamentals, announcements, valuation, stockNews, marginData, northHold, marketNews] = await Promise.all([
    getMoneyFlow(symbol).catch(() => null),
    getFundamentals(symbol).catch(() => null),
    getAnnouncements(symbol).catch(() => null),
    getValuation(symbol).catch(() => null),
    getStockNews(symbol).catch(() => null),
    getMarginData(symbol).catch(() => null),
    getNorthHold(symbol).catch(() => null),
    getMarketNews().catch(() => null),
  ]);
  return { moneyFlow, fundamentals, announcements, valuation, stockNews, marginData, northHold, marketNews };
}

module.exports = { getAll, getMoneyFlow, getFundamentals, getAnnouncements, getValuation, getStockNews, getMarginData, getNorthHold, getMarketNews };
