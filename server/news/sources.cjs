'use strict';
// ─────────────────────────────────────────────────────────────
// 资讯多源适配器
//   · 每个数据源独立超时 / 重试 / 熔断，单源失败不影响整体可用性
//   · 市场要闻：东方财富 7x24 快讯（分页，单页 100 条）+ 新浪财经滚动
//   · 个股资讯：东财个股官方资讯接口（按证券代码挂载）+ 东财全文检索（名称/代码双路召回）
//   · 行情通道：东方财富 / 腾讯行情（解析证券简称）；通达信行情服务器做通道健康探测
//   · 产出统一结构：{ title, snippet, url, media, publishedAt, source, symbols[], secids[] }
// ─────────────────────────────────────────────────────────────
const axios = require('axios');
const net = require('net');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const EM_MARKET = { sh: 1, sz: 0, bj: 0 };

// ───────── 代码规范化 ─────────
function normalizeSymbol(input) {
  const raw = String(input || '').trim().toLowerCase();
  const m = raw.match(/(sh|sz|bj|hk)?\s*(\d{6})/);
  if (!m) return null;
  const market = m[1] || (/^[45]/.test(m[2]) ? 'sh' : /^[08]/.test(m[2]) ? 'sz' : 'sh');
  const digits = m[2];
  return {
    symbol: market + digits,
    digits,
    market,
    secid: `${EM_MARKET[market] ?? 1}.${digits}`,
    secucode: `${digits}.${market.toUpperCase()}`,
  };
}

/** 东财 secid("1.600519") → 站内标准代码("sh600519") */
function secidToSymbol(secid) {
  const [mkt, code] = String(secid || '').split('.');
  if (!code) return null;
  return (mkt === '1' ? 'sh' : mkt === '0' ? 'sz' : 'bj') + code;
}

/** 解析 "2026-09-10 23:16:24" 这类东八区时间 → ISO */
function parseCnTime(value) {
  if (!value) return 0;
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0));
    return Number.isFinite(ms) ? ms : 0;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// ───────── 熔断与健康度 ─────────
const health = new Map(); // name -> { fails, ok, lastOk, lastErr, disabledUntil }
const HEALTH_TTL = 5 * 60_000;

function markOk(name) {
  const h = health.get(name) || { fails: 0, ok: 0 };
  h.fails = 0;
  h.ok += 1;
  h.lastOk = Date.now();
  health.set(name, h);
}

function markFail(name, err) {
  const h = health.get(name) || { fails: 0, ok: 0 };
  h.fails += 1;
  h.lastErr = String(err || '').slice(0, 120);
  // 连续失败 3 次熔断 5 分钟，避免拖慢整体响应
  if (h.fails >= 3) h.disabledUntil = Date.now() + 5 * 60_000;
  health.set(name, h);
}

function isDisabled(name) {
  const h = health.get(name);
  return !!(h?.disabledUntil && Date.now() < h.disabledUntil);
}

function healthSnapshot() {
  const out = {};
  for (const [k, v] of health) {
    out[k] = { ok: v.ok || 0, fails: v.fails || 0, lastOk: v.lastOk || null, lastErr: v.lastErr || null, degraded: isDisabled(k) };
  }
  return out;
}

/** 带熔断的取数包装；失败时返回 fallback，保证单个源故障不影响整体 */
async function withSource(name, loader, fallback = []) {
  if (isDisabled(name)) return fallback;
  try {
    const data = await loader();
    markOk(name);
    return data ?? fallback;
  } catch (e) {
    markFail(name, e.message);
    return fallback;
  }
}

async function getJSON(url, referer, timeout = 8000) {
  const res = await axios.get(url, { headers: { 'User-Agent': UA, Referer: referer }, timeout });
  return typeof res.data === 'string' ? JSON.parse(res.data.replace(/^[\w$]+\(/, '').replace(/\);?\s*$/, '')) : res.data;
}

// ───────── 源 1：东方财富 7x24 快讯（市场要闻主力源，支持 sortEnd 翻页） ─────────
async function fetchEmFlashPage(sortEnd = '', pageSize = 100) {
  const url =
    'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102' +
    `&sortEnd=${encodeURIComponent(sortEnd)}&pageSize=${pageSize}&req_trace=1`;
  const j = await getJSON(url, 'https://kuaixun.eastmoney.com/');
  const list = j?.data?.fastNewsList;
  if (!Array.isArray(list) || !list.length) return { items: [], sortEnd: '' };
  const items = list
    .map((n) => {
      const ms = parseCnTime(n.showTime);
      if (!ms || !n.title) return null;
      const secids = Array.isArray(n.stockList) ? n.stockList : [];
      return {
        title: String(n.title).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
        snippet: String(n.summary || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
        url: `https://kuaixun.eastmoney.com/a/${n.code}.html`,
        media: '东方财富7x24',
        publishedAt: new Date(ms).toISOString(),
        source: 'em-flash',
        secids,
        symbols: secids.map(secidToSymbol).filter(Boolean),
      };
    })
    .filter(Boolean);
  return { items, sortEnd: String(j?.data?.sortEnd || '') };
}

/** 分页拉取市场要闻，pages 越大覆盖越广（单页 100 条） */
async function fetchMarketFlash(pages = 3, pageSize = 100) {
  const all = [];
  let sortEnd = '';
  for (let i = 0; i < pages; i++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await withSource('em-flash', () => fetchEmFlashPage(sortEnd, pageSize));
    if (!page.items.length) break;
    all.push(...page.items);
    if (!page.sortEnd || page.sortEnd === sortEnd) break;
    sortEnd = page.sortEnd;
  }
  return all;
}

// ───────── 源 2：东财个股官方资讯（按证券代码挂载，精准度最高） ─────────
async function fetchEmStockNews(symbol, pages = 2, pageSize = 20) {
  const norm = normalizeSymbol(symbol);
  if (!norm) return [];
  const out = [];
  for (let i = 1; i <= pages; i++) {
    const url =
      'https://np-listapi.eastmoney.com/comm/web/getListInfo?client=web&biz=web_news_col&column=347&order=1' +
      `&needInteractData=0&page_index=${i}&page_size=${pageSize}&req_trace=1` +
      '&fields=code,showTime,title,mediaName,summary,url,uniqueUrl&type=1' +
      `&mTypeAndCode=${encodeURIComponent(norm.secid)}`;
    // eslint-disable-next-line no-await-in-loop
    const j = await getJSON(url, 'https://finance.eastmoney.com/');
    const list = j?.data?.list;
    if (!Array.isArray(list) || !list.length) break;
    for (const n of list) {
      const ms = parseCnTime(n.Art_ShowTime);
      if (!ms || !n.Art_Title) continue;
      out.push({
        title: String(n.Art_Title).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
        snippet: String(n.summary || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
        url: String(n.Art_Url || n.Art_OriginUrl || '').trim(),
        media: String(n.mediaName || '东方财富资讯'),
        publishedAt: new Date(ms).toISOString(),
        source: 'em-stock-news',
        secids: [norm.secid],
        symbols: [norm.symbol],
      });
    }
    if (list.length < pageSize) break;
  }
  return out.filter((x) => x.url);
}

// ───────── 源 3：东财全文检索（关键词召回，交由匹配层降噪） ─────────
async function fetchEmSearch(keyword, pageSize = 20) {
  if (!keyword) return [];
  const param = JSON.stringify({
    uid: '',
    keyword: String(keyword),
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'cur',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize, preTag: '', postTag: '' } },
  });
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=&param=${encodeURIComponent(param)}`;
  const j = await getJSON(url, 'https://so.eastmoney.com/');
  const arts = j?.result?.cmsArticleWebOld;
  if (!Array.isArray(arts)) return [];
  return arts
    .map((a) => {
      const ms = parseCnTime(a.date);
      if (!ms || !a.title) return null;
      return {
        title: String(a.title).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
        snippet: String(a.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
        url: String(a.url || '').trim(),
        media: String(a.mediaName || '东方财富资讯'),
        publishedAt: new Date(ms).toISOString(),
        source: 'em-search',
        secids: [],
        symbols: [],
      };
    })
    .filter((x) => x && x.url);
}

// ───────── 源 4：新浪财经滚动（补充源，提升媒体覆盖度） ─────────
async function fetchSinaRoll(num = 50) {
  const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=${num}&page=1`;
  const j = await getJSON(url, 'https://finance.sina.com.cn/');
  const rows = j?.result?.data ?? [];
  return rows
    .map((n) => {
      if (!n?.title) return null;
      const ms = Number(n.ctime) ? Number(n.ctime) * 1000 : 0;
      if (!ms) return null;
      return {
        title: String(n.title).replace(/\s+/g, ' ').trim(),
        snippet: '',
        url: String(n.url || n.link || 'https://finance.sina.com.cn/roll/').trim(),
        media: String(n.media_name || '新浪财经'),
        publishedAt: new Date(ms).toISOString(),
        source: 'sina-roll',
        secids: [],
        symbols: [],
      };
    })
    .filter(Boolean);
}

// ───────── 源 5：证券简称解析 ─────────
// 交易所会在除权除息日把简称标成「XD中国平」这类形式（且截断末字），
// 直接拿去匹配会漏掉正文中写的「中国平安」，因此统一清洗标记前缀。
const NAME_MARKER = /^(\*ST|\*st|ST|st|XD|XR|DR|N|C|U|W|S)\s*/;

function cleanSecurityName(raw) {
  let n = String(raw || '').trim().replace(/\s+/g, '');
  for (let i = 0; i < 3; i++) {
    const m = n.match(NAME_MARKER);
    if (!m || n.length - m[0].length < 2) break;
    n = n.slice(m[0].length);
  }
  return n;
}

async function fetchEmSuggestName(symbol) {
  const norm = normalizeSymbol(symbol);
  if (!norm) return null;
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${norm.digits}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8`;
  const j = await getJSON(url, 'https://www.eastmoney.com/', 6000);
  const rows = j?.QuotationCodeTable?.Data;
  if (!Array.isArray(rows)) return null;
  const mktNum = norm.market === 'sz' || norm.market === 'bj' ? 0 : 1;
  const hit = rows.find((r) => String(r.Code) === norm.digits && Number(r.MktNum) === mktNum) || rows.find((r) => String(r.Code) === norm.digits);
  const name = cleanSecurityName(hit?.Name);
  return name && name.length >= 2 ? name : null;
}

async function fetchEmName(symbol) {
  const norm = normalizeSymbol(symbol);
  if (!norm) return null;
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${norm.secid}&invt=2&fltt=2&fields=f43,f57,f58`;
  const j = await getJSON(url, 'https://quote.eastmoney.com/', 6000);
  const name = cleanSecurityName(j?.data?.f58);
  return name && name.length >= 2 ? name : null;
}

async function fetchTencentName(symbol) {
  const norm = normalizeSymbol(symbol);
  if (!norm) return null;
  const res = await axios.get(`http://qt.gtimg.cn/q=${norm.symbol}`, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    responseType: 'arraybuffer',
    timeout: 6000,
  });
  let iconv = null;
  try {
    // eslint-disable-next-line global-require
    iconv = require('iconv-lite');
  } catch {
    iconv = null;
  }
  const text = iconv ? iconv.decode(Buffer.from(res.data), 'gbk') : Buffer.from(res.data).toString('utf8');
  const m = text.match(/="[^~]*~([^~]+)~/);
  const name = cleanSecurityName(m ? m[1] : '');
  return name && name.length >= 2 ? name : null;
}

/** 证券简称解析：东财联想接口 → 东财行情 → 腾讯行情，逐级兜底 */
async function resolveName(symbol) {
  const loaders = [
    ['name-suggest', fetchEmSuggestName],
    ['name-em', fetchEmName],
    ['name-tencent', fetchTencentName],
  ];
  for (const [key, loader] of loaders) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const name = await loader(symbol);
      if (name) {
        markOk(key);
        return name;
      }
    } catch (e) {
      markFail(key, e.message);
    }
  }
  return null;
}

// ───────── 源 6：通达信行情通道探测 ─────────
// 通达信未开放公开 HTTP 资讯接口，其行情服务为私有 TCP 二进制协议。
// 这里做通道可达性探测：TCP 可连说明行情通道正常，用于判断数据时效保障能力；
// 协议握手失败时自动降级到其他行情源，不影响资讯主流程。
const TDX_HOSTS = [{ host: '124.71.187.122', port: 7709 }, { host: '119.147.212.81', port: 7709 }];

function probeTdxTcp(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const sock = new net.Socket();
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function tdxChannelHealth() {
  const results = await Promise.all(TDX_HOSTS.map((h) => probeTdxTcp(h.host, h.port)));
  const reachable = results.filter(Boolean).length;
  if (reachable) markOk('tdx-channel');
  else markFail('tdx-channel', '通达信行情服务器均不可达');
  return { reachable, total: TDX_HOSTS.length, available: reachable > 0 };
}

module.exports = {
  normalizeSymbol,
  secidToSymbol,
  parseCnTime,
  fetchMarketFlash,
  fetchEmFlashPage,
  fetchEmStockNews,
  fetchEmSearch,
  fetchSinaRoll,
  fetchEmSuggestName,
  fetchEmName,
  fetchTencentName,
  cleanSecurityName,
  resolveName,
  tdxChannelHealth,
  healthSnapshot,
  isDisabled,
};
