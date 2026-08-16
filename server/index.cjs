#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// AI深度量化 - 独立一体化服务（单端口 3001）
//   · RESTful API：quote / history / mkline(分钟K线) / minute(分时)
//     / indices / search / backtest(策略回测) / qa(网站AI问答) / health
//   · 生产模式：直接托管 dist/ 静态资源（单 URL 即可访问整站）
//   · 数据源：新浪/腾讯公开财经接口，无需任何 API Key，自动切换
//   · 自维护：每日 02:00–03:00 自动自检（代码扫描 + 接口冒烟测试 + 报告）
// ─────────────────────────────────────────────────────────────
// 启动方式：
//   node server/index.cjs                # 正常启动（API + dist 静态托管 + 自检调度）
//   node server/index.cjs --maintain-once  # 立即执行一次自检后退出（供计划任务调用）
//   node server/index.cjs --no-maintain  # 关闭自检调度（调试用）
// ─────────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');
const iconv = require('iconv-lite');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;
const ARGS = process.argv.slice(2);
const MAINTAIN_ONCE = ARGS.includes('--maintain-once');
const NO_MAINTAIN = ARGS.includes('--no-maintain');
/** Vercel Serverless 环境（由 Vercel 注入 VERCEL=1）：不监听端口、不做本地调度、收紧超时 */
const IS_VERCEL = process.env.VERCEL === '1';

const APP_NAME = 'AI深度量化';
const APP_VERSION = '2.0.0';

// 允许跨域（前端开发服务器访问）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ───────────── 内存缓存 ─────────────
const cache = new Map();
function getCached(key, ttlMs) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

const QUOTE_TTL = 5_000; // 实时报价 5 秒
const HISTORY_TTL = 300_000; // 历史数据 5 分钟
const INDICES_TTL = 5_000;
const SEARCH_TTL = 60_000;
const MKLINE_TTL = 60_000; // 分钟K线 1 分钟

// ───────────── HTTP 工具 ─────────────
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** 带重试的 GET（GBK 解码；失败换数据源重试 1 次）。
 *  Vercel 环境函数最长执行 10s：缩短超时且不重试，避免被平台掐断。 */
async function fetchText(url, headers, retryUrl) {
  const timeout = IS_VERCEL ? 5000 : 8000;
  try {
    const res = await axios.get(url, { headers, responseType: 'arraybuffer', timeout });
    return iconv.decode(Buffer.from(res.data), 'gbk');
  } catch (e) {
    if (retryUrl && !IS_VERCEL) {
      console.warn(`⚠️ 数据源失败，切换备用: ${e.message?.slice(0, 60)}`);
      const res = await axios.get(retryUrl, { headers, responseType: 'arraybuffer', timeout });
      return iconv.decode(Buffer.from(res.data), 'gbk');
    }
    throw e;
  }
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// ───────────── 代码规范 ─────────────
/** 统一为腾讯代码：sh600519 / sz000858 / hk00700 / usAAPL / usINX */
function toTencentCode(symbol) {
  const raw = String(symbol).trim();
  const lower = raw.toLowerCase();
  if (/^(sh|sz|hk)/.test(lower)) return lower;
  if (/^us/i.test(lower)) return `us${raw.slice(2)}`;
  if (/^\d{6}$/.test(raw)) return /^[69]/.test(raw) ? `sh${raw}` : `sz${raw}`;
  if (/^\d{5}$/.test(raw)) return `hk${raw}`;
  return `us${raw.toUpperCase()}`;
}

// ───────────── 1. 实时报价 ─────────────
/** 解析腾讯行情文本：v_sh600519="名称~代码~现价~昨收~今开~成交量~...~" */
function parseTencentQuote(text, symbol) {
  const m = text.match(/"([^"]*)"/);
  if (!m) return null;
  const parts = m[1].split('~');
  if (parts.length < 6) return null;
  const name = parts[1];
  const price = num(parts[3]);
  const prevClose = num(parts[4]);
  const open = num(parts[5]);
  // A股成交量单位为手（×100 = 股）；港股/美股直接为股
  const isCN = /^(sh|sz)/.test(String(symbol).toLowerCase());
  const volume = num(parts[6]) * (isCN ? 100 : 1);
  const changePercent = prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
  return {
    symbol: parts[2] || symbol,
    name,
    price,
    prevClose,
    open,
    high: num(parts[33]) ?? price,
    low: num(parts[34]) ?? price,
    volume,
    changePercent,
    timestamp: Date.now(),
    source: 'tencent',
  };
}

/** 获取腾讯行情文本；美股自动探测交易所后缀（usAAPL → usAAPL.OQ / usAAPL.N） */
async function fetchTencentQuoteText(code) {
  const headers = { 'User-Agent': UA, Referer: 'http://finance.qq.com' };
  let text = await fetchText(`http://qt.gtimg.cn/q=${code}`, headers);
  const isEmpty = new RegExp(`v_${code}=""`).test(text);
  if (/^us/i.test(code) && isEmpty) {
    for (const suffix of ['.OQ', '.N', '.A']) {
      const candidate = `${code}${suffix}`;
      try {
        const t = await fetchText(`http://qt.gtimg.cn/q=${candidate}`, headers);
        if (t && !new RegExp(`v_${candidate}=""`).test(t)) return t;
      } catch {
        /* 尝试下一个后缀 */
      }
    }
  }
  return text;
}

app.get('/api/quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const code = toTencentCode(symbol);
  const cacheKey = `quote:${code}`;
  const cached = getCached(cacheKey, QUOTE_TTL);
  if (cached) return res.json(cached);

  try {
    const text = await fetchTencentQuoteText(code);
    const quote = parseTencentQuote(text, symbol);
    if (!quote || !quote.price) {
      return res.status(404).json({ error: `未获取到 ${symbol} 的实时报价` });
    }
    setCache(cacheKey, quote);
    res.json(quote);
  } catch (e) {
    res.status(500).json({ error: `获取报价失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 2. 历史 K 线 ─────────────
/** 解析腾讯 K 线 JSON：{data:{code:{day:[[date,open,close,high,low,vol],...]}}} */
function parseTencentKlines(json, symbol, unit = 'day') {
  const data = json?.data?.[symbol];
  if (!data) return [];
  const rows = data?.[`qfq${unit}`] || data?.[unit] || [];
  return rows.map((r) => ({
    date: String(r[0]).slice(0, 10),
    open: num(r[1]),
    close: num(r[2]),
    high: num(r[3]),
    low: num(r[4]),
    volume: num(r[5]),
  }));
}

/** 获取日 K 原始行（美股自动探测交易所后缀；供 history/backtest/qa 复用） */
async function fetchDailyRows(code, count = 500) {
  const candidates = /^us/i.test(code) ? [`${code}.OQ`, `${code}.N`, code] : [code];
  let best = [];
  for (const cand of candidates) {
    try {
      const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${cand},day,,,${count},qfq`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'http://finance.qq.com' });
      const json = JSON.parse(text);
      if (json.code !== 0) continue;
      const rows = parseTencentKlines(json, cand, 'day');
      if (rows.length > 2) {
        best = rows;
        break;
      }
      if (rows.length > best.length) best = rows;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  // A股 qfq 复权数据量受限（如贵州茅台仅约 640 根 ≈ 2.6 年）→
  // 用新浪长历史补充（不复权，约 8 年），保证季线/年线可绘制
  if (best.length < 800 && /^(sh|sz)/i.test(code) && count > 800) {
    try {
      const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=240&ma=no&datalen=${Math.min(count, 2000)}`;
      const text = await fetchText(url, {
        'User-Agent': UA,
        Referer: 'https://finance.sina.com.cn',
      });
      const data = JSON.parse(text);
      if (Array.isArray(data) && data.length > best.length) {
        const rows = data
          .map((r) => ({
            date: String(r.day).slice(0, 10),
            open: num(r.open),
            close: num(r.close),
            high: num(r.high),
            low: num(r.low),
            volume: num(r.volume),
          }))
          .filter((r) => r.close !== null && r.open !== null)
          .sort((a, b) => a.date.localeCompare(b.date));
        if (rows.length > best.length) return rows;
      }
    } catch {
      /* 新浪不可用时保持腾讯结果 */
    }
  }
  return best;
}

app.get('/api/history/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const code = toTencentCode(symbol);
  const frequency = req.query.frequency || '1d';
  const count = Math.min(Number(req.query.count) || 500, 2000);
  const cacheKey = `history:${code}:${frequency}:${count}`;
  const cached = getCached(cacheKey, HISTORY_TTL);
  if (cached) return res.json(cached);

  // 周期映射：1d/1w/1M → 腾讯 unit
  const unitMap = { '1d': 'day', '1w': 'week', '1M': 'month' };
  const unit = unitMap[frequency] || 'day';

  try {
    const klines = await fetchDailyRows(code, count);
    if (!klines.length) throw new Error('K 线数据为空');
    // 周/月线：后端直接请求对应 unit，避免前端聚合
    let out = klines;
    if (unit === 'week' || unit === 'month') {
      const cand = /^us/i.test(code) ? `${code}.OQ` : code;
      try {
        const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${cand},${unit},,,${count},qfq`;
        const text = await fetchText(url, { 'User-Agent': UA, Referer: 'http://finance.qq.com' });
        const json = JSON.parse(text);
        const rows = parseTencentKlines(json, cand, unit);
        if (rows.length > 1) out = rows;
      } catch {
        /* 保留日线回退 */
      }
    }
    const result = { symbol: code, frequency, klines: out };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    // 备用：新浪日 K
    try {
      const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=240&ma=no&datalen=${count}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' });
      const data = JSON.parse(text);
      const klines = (Array.isArray(data) ? data : []).map((r) => ({
        date: String(r.day).slice(0, 10),
        open: num(r.open),
        close: num(r.close),
        high: num(r.high),
        low: num(r.low),
        volume: num(r.volume),
      }));
      if (!klines.length) throw new Error('新浪 K 线数据为空');
      const result = { symbol: code, frequency, klines };
      setCache(cacheKey, result);
      res.json(result);
    } catch (e2) {
      res.status(500).json({ error: `获取历史数据失败: ${e2.message?.slice(0, 80)}` });
    }
  }
});

// ───────────── 2b. 分钟 K 线（真实多日 OHLCV） ─────────────
/** 解析腾讯 mkline：data.<code>.<m5> = [[YYYYMMDDHHmm, open, close, high, low, vol, ...]] */
function parseTencentMkline(json, code, mKey) {
  const rows = json?.data?.[code]?.[mKey];
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      const raw = String(r[0]);
      const y = raw.slice(0, 4);
      const mo = raw.slice(4, 6);
      const d = raw.slice(6, 8);
      const hh = raw.slice(8, 10);
      const mm = raw.slice(10, 12);
      return {
        date: `${y}-${mo}-${d} ${hh}:${mm}`,
        open: num(r[1]),
        close: num(r[2]),
        high: num(r[3]),
        low: num(r[4]),
        volume: num(r[5]),
      };
    })
    .filter((k) => k.open !== null && k.close !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 解析新浪美股分钟 K（JSONP: var _=([{d,o,h,l,c,v,a},...])） */
function parseSinaUSMinute(text) {
  try {
    const s = text.indexOf('([');
    const e = text.lastIndexOf('])');
    if (s < 0 || e < 0) return [];
    const arr = JSON.parse(text.slice(s + 1, e + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((r) => ({
        date: String(r.d).slice(0, 16),
        open: num(r.o),
        close: num(r.c),
        high: num(r.h),
        low: num(r.l),
        volume: num(r.v),
      }))
      .filter((k) => k.open !== null && k.close !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/** 解析腾讯分时（1 分钟粒度）→ K 线点（日期按北京时间，兼容海外服务器 UTC 时区） */
function parseTencentMinuteKlines(json, symbol) {
  const rows = json?.data?.[symbol]?.data?.data;
  if (!Array.isArray(rows)) return [];
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, mo, d] = fmt.format(now).split('-');
  return rows
    .map((line) => {
      const parts = String(line).trim().split(/\s+/);
      if (parts.length < 2) return null;
      const t = parts[0];
      const price = num(parts[1]);
      if (price === null || price <= 0) return null;
      return {
        date: `${y}-${mo}-${d} ${t.slice(0, 2)}:${t.slice(2, 4)}`,
        open: price,
        close: price,
        high: price,
        low: price,
        volume: num(parts[2]) || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 将 N 根 1 分钟 K 聚合为 1 根周期 K（尾部分组，OHLCV 标准聚合） */
function aggregateMinuteKlines(points, step) {
  if (step <= 1) return points;
  const out = [];
  for (let i = points.length; i > 0; i -= step) {
    const grp = points.slice(Math.max(0, i - step), i);
    if (grp.length === 0) continue;
    out.unshift({
      date: grp[grp.length - 1].date,
      open: grp[0].open,
      close: grp[grp.length - 1].close,
      high: Math.max(...grp.map((p) => p.high)),
      low: Math.min(...grp.map((p) => p.low)),
      volume: grp.reduce((a, p) => a + p.volume, 0),
    });
  }
  return out;
}

/**
 * GET /api/mkline/:symbol?period=m5&count=320
 * 真实分钟 K 线（多日）：
 *   - A股/指数：腾讯 mkline（m1/m5/m15/m30/m60）
 *   - 美股：新浪 US_MinKService（type=1/5/15/30/60）
 *   - 港股：腾讯当日分时聚合
 */
app.get('/api/mkline/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const code = toTencentCode(symbol);
  const period = String(req.query.period || 'm5').replace(/^m/, '');
  const valid = ['1', '5', '15', '30', '60'];
  const step = valid.includes(period) ? Number(period) : 5;
  const count = Math.min(Number(req.query.count) || 320, 800);
  const cacheKey = `mkline:${code}:${step}`;
  const cached = getCached(cacheKey, MKLINE_TTL);
  if (cached) return res.json(cached);

  try {
    let klines = [];
    let source = 'tencent-mkline';
    if (/^us/i.test(code)) {
      // ── 美股：新浪分钟 K ──
      const bare = code.replace(/^us/i, '').toLowerCase();
      const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService.getMinK?symbol=${bare}&type=${step}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' });
      klines = parseSinaUSMinute(text);
      source = 'sina-us';
    } else if (/^hk/i.test(code)) {
      // ── 港股：腾讯当日分时 → 本地聚合 ──
      const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'http://finance.qq.com' });
      const json = JSON.parse(text);
      const base = parseTencentMinuteKlines(json, code);
      klines = aggregateMinuteKlines(base, step);
      source = 'tencent-minute';
    } else {
      // ── A股：腾讯 mkline ──
      const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},m${step},,${count}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'http://finance.qq.com' });
      const json = JSON.parse(text);
      klines = parseTencentMkline(json, code, `m${step}`);
      source = 'tencent-mkline';
    }
    if (!klines.length) throw new Error('分钟 K 线数据为空');
    const result = { symbol: code, period: `m${step}`, source, klines: klines.slice(-count) };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: `获取分钟K线失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 2c. 当日分时 ─────────────
/** 解析腾讯当日分时：["0930 1355.00 227 30758500.00", ...] */
function parseTencentMinute(json, symbol) {
  const rows = json?.data?.[symbol]?.data?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((line) => {
      const parts = String(line).trim().split(/\s+/);
      if (parts.length < 2) return null;
      const time = parts[0];
      const price = num(parts[1]);
      if (price === null || price <= 0) return null;
      return {
        time: `${time.slice(0, 2)}:${time.slice(2, 4)}`,
        price,
        volume: num(parts[2]) || 0,
      };
    })
    .filter(Boolean);
}

/** 判断美东日期是否为夏令时（3月第2个周日 02:00 ~ 11月第1个周日 02:00） */
function isUSDST(y, m, d) {
  // 3月第二个周日
  const mar1 = new Date(Date.UTC(y, 2, 1));
  const secondSun = 8 + ((7 - mar1.getUTCDay()) % 7);
  // 11月第一个周日
  const nov1 = new Date(Date.UTC(y, 10, 1));
  const firstSun = 1 + ((7 - nov1.getUTCDay()) % 7);
  const ts = Date.UTC(y, m - 1, d);
  const dstStart = Date.UTC(y, 2, secondSun);
  const dstEnd = Date.UTC(y, 10, firstSun);
  return ts >= dstStart && ts < dstEnd;
}

/** 美东时间(EDT/EST) → 北京时间（EDT +12h / EST +13h），用于美股分时按当前时间窗口制图 */
function usTimeToBeijing(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr).split(':').map(Number);
  const offsetHours = isUSDST(y, m, d) ? 12 : 13;
  const bj = new Date(Date.UTC(y, m - 1, d, hh, mm) + offsetHours * 3600 * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return {
    date: `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`,
    time: `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`,
  };
}

app.get('/api/minute/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const code = toTencentCode(symbol);
  const cacheKey = `minute:${code}`;
  const cached = getCached(cacheKey, QUOTE_TTL);
  if (cached) return res.json(cached);

  try {
    let points = [];
    let source = 'tencent-minute';
    if (/^us/i.test(code)) {
      // ── 美股：新浪 1 分钟 K 线（腾讯分时接口对美股仅返回当前 1 个点） ──
      const bare = code.replace(/^us/i, '').toLowerCase();
      const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/US_MinKService.getMinK?symbol=${bare}&type=1`;
      const text = await fetchText(url, {
        'User-Agent': UA,
        Referer: 'https://finance.sina.com.cn',
      });
      const klines = parseSinaUSMinute(text);
      points = klines.map((k) => {
        // 新浪美股时间为美东时区 → 统一转为北京时间（前端按当前时间窗口制图）
        const bj = usTimeToBeijing(String(k.date).slice(0, 10), String(k.date).slice(11, 16));
        return {
          date: bj.date,
          time: bj.time,
          price: k.close,
          volume: k.volume ?? 0,
        };
      });
      source = 'sina-us';
    } else {
      // ── A股/港股：腾讯当日分时（补北京时间日期） ──
      const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'http://finance.qq.com' });
      const json = JSON.parse(text);
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(new Date())
        .split('-')
        .join('-');
      points = parseTencentMinute(json, code).map((p) => ({ ...p, date: today }));
    }
    if (!points.length) throw new Error('分时数据为空');
    const result = { symbol: code, source, points };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: `获取分时数据失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 3. 大盘指数 ─────────────
const INDEX_CODES = ['sh000001', 'sh000300', 'sz399001', 'usINX', 'usIXIC', 'usDJI'];
const INDEX_NAMES = {
  sh000001: '上证指数',
  sh000300: '沪深300',
  sz399001: '深证成指',
  usINX: '标普500',
  usIXIC: '纳斯达克',
  usDJI: '道琼斯',
};

app.get('/api/indices', async (req, res) => {
  const cacheKey = 'indices';
  const cached = getCached(cacheKey, INDICES_TTL);
  if (cached) return res.json(cached);

  try {
    const text = await fetchText(`http://qt.gtimg.cn/q=${INDEX_CODES.join(',')}`, {
      'User-Agent': UA,
      Referer: 'http://finance.qq.com',
    });
    const items = [];
    for (const code of INDEX_CODES) {
      const re = new RegExp(`v_${code}="([^"]*)"`);
      const m = text.match(re);
      if (!m) continue;
      const parts = m[1].split('~');
      if (parts.length < 6) continue;
      const price = num(parts[3]);
      const prevClose = num(parts[4]);
      items.push({
        symbol: code,
        name: INDEX_NAMES[code] || parts[1],
        price,
        changePercent: prevClose && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      });
    }
    if (!items.length) throw new Error('指数数据为空');
    setCache(cacheKey, items);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: `获取指数失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 4. 搜索 ─────────────
/** 常见美股代码兜底名称表（新浪 suggest 不返回英文代码时使用） */
const US_FALLBACK = {
  AAPL: '苹果',
  MSFT: '微软',
  NVDA: '英伟达',
  GOOGL: '谷歌-A',
  GOOG: '谷歌-C',
  AMZN: '亚马逊',
  META: 'Meta',
  TSLA: '特斯拉',
  AMD: '超威半导体',
  NFLX: '奈飞',
  AVGO: '博通',
  INTC: '英特尔',
  IBM: 'IBM',
  ORCL: '甲骨文',
  CRM: '赛富时',
  ADBE: 'Adobe',
  DIS: '迪士尼',
  KO: '可口可乐',
  PEP: '百事可乐',
  WMT: '沃尔玛',
  MCD: '麦当劳',
  BA: '波音',
  GE: '通用电气',
  XOM: '埃克森美孚',
  JPM: '摩根大通',
  BAC: '美国银行',
  V: 'Visa',
  MA: '万事达',
  PYPL: 'PayPal',
  INX: '标普500',
  IXIC: '纳斯达克',
  DJI: '道琼斯',
};
/** 解析新浪搜索：var suggestvalue="名称1,类型1,代码1|名称2,类型2,代码2|..." */
function parseSinaSearch(text) {
  const m = text.match(/"([^"]*)"/);
  if (!m || !m[1]) return [];
  return m[1]
    .split('|')
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(',');
      if (parts.length < 3) return null;
      const raw = parts[2].trim();
      let market;
      if (/^(sh|sz)/i.test(raw)) market = 'CN';
      else if (/^hk/i.test(raw)) market = 'HK';
      else if (/^us/i.test(raw)) market = 'US';
      else if (/^\d{6}$/.test(raw)) market = 'CN';
      else if (/^\d{5}$/.test(raw)) market = 'HK';
      else market = 'US';
      return { name: parts[0], code: raw, market };
    })
    .filter(Boolean);
}

app.get('/api/search/:keyword', async (req, res) => {
  const keyword = req.params.keyword;
  const cacheKey = `search:${keyword}`;
  const cached = getCached(cacheKey, SEARCH_TTL);
  if (cached) return res.json(cached);

  try {
    const url = `https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(keyword)}`;
    const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' });
    const items = parseSinaSearch(text);

    const upper = keyword.trim().toUpperCase();
    const isCodeLike = /^[A-Z0-9.]{1,10}$/.test(upper);
    if (isCodeLike) {
      const direct = US_FALLBACK[upper];
      if (direct) {
        items.length = 0;
        items.push({ name: direct, code: upper, market: 'US' });
      } else if (/^\d{6}$/.test(upper)) {
        items.length = 0;
        items.push({ name: upper, code: upper, market: 'CN' });
      } else if (/^\d{5}$/.test(upper)) {
        items.length = 0;
        items.push({ name: upper, code: upper, market: 'HK' });
      } else if (/^[A-Z]{1,6}$/.test(upper) && items.every((it) => it.code.toUpperCase() !== upper)) {
        items.push({ name: upper, code: upper, market: 'US' });
      }
    }
    setCache(cacheKey, items);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: `搜索失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 5. 策略回测 ─────────────
/** SMA 序列（不足 N 为 null） */
function smaSeries(values, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    out.push(i + 1 >= n ? sum / n : null);
  }
  return out;
}

/** RSI 序列（Wilder 简化） */
function rsiSeries(values, n = 14) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < n) {
      out.push(null);
      continue;
    }
    let gains = 0;
    let losses = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const diff = values[j] - values[j - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / n;
    const avgLoss = losses / n;
    if (avgLoss === 0) out.push(100);
    else out.push(100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

/** 单策略回测引擎（全仓多头，0.1% 双边手续费，收盘价成交） */
function runBacktest(klines, strategy, fast, slow, capital) {
  const n = klines.length;
  if (n < 30) return { error: '历史数据不足 30 根，无法回测' };
  const closes = klines.map((k) => k.close);
  const equity = [];
  const trades = [];
  let cash = capital;
  let shares = 0;
  let position = false;
  let peak = capital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let entryPrice = 0;
  let entryDate = '';

  const fastSMA = smaSeries(closes, fast);
  const slowSMA = smaSeries(closes, slow);
  const rsi = rsiSeries(closes, 14);
  const FEE = 0.001;

  for (let i = 0; i < n; i++) {
    const price = closes[i];
    let target = position;
    if (strategy === 'buyhold') {
      target = true;
    } else if (strategy === 'ma') {
      if (fastSMA[i] !== null && slowSMA[i] !== null) {
        if (fastSMA[i] > slowSMA[i]) target = true; // 快线上穿慢线 → 持有
        else if (fastSMA[i] < slowSMA[i]) target = false; // 死叉 → 空仓
      }
    } else if (strategy === 'rsi') {
      if (rsi[i] !== null && rsi[i - 1] !== null) {
        if (rsi[i - 1] <= 30 && rsi[i] > 30) target = true; // 超卖回升 → 买入
        if (rsi[i - 1] >= 70 && rsi[i] < 70) target = false; // 超买回落 → 卖出
      }
    }
    // 执行交易（收盘价成交，双向手续费 0.1%）
    if (target && !position && cash > price) {
      const cost = cash * (1 - FEE);
      shares = cost / price;
      cash = 0;
      position = true;
      entryPrice = price;
      entryDate = klines[i].date;
    } else if (!target && position) {
      const proceeds = shares * price * (1 - FEE);
      cash = proceeds;
      shares = 0;
      position = false;
      const pnlPct = ((price - entryPrice) / entryPrice) * 100;
      trades.push({
        entryDate,
        entryPrice: +entryPrice.toFixed(2),
        exitDate: klines[i].date,
        exitPrice: +price.toFixed(2),
        pnlPct: +pnlPct.toFixed(2),
        holdDays: i - klines.findIndex((k) => k.date === entryDate),
      });
    }
    const value = cash + shares * price;
    equity.push({ date: klines[i].date, value: +value.toFixed(2) });
    peak = Math.max(peak, value);
    const dd = (peak - value) / peak;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    maxDrawdown = Math.max(maxDrawdown, peak - value);
  }

  // 期末清仓
  let finalValue = equity[n - 1].value;
  if (position) {
    finalValue = shares * closes[n - 1] * (1 - FEE);
    trades.push({
      entryDate,
      entryPrice: +entryPrice.toFixed(2),
      exitDate: klines[n - 1].date,
      exitPrice: +closes[n - 1].toFixed(2),
      pnlPct: +(((closes[n - 1] - entryPrice) / entryPrice) * 100).toFixed(2),
      holdDays: n - 1 - klines.findIndex((k) => k.date === entryDate),
      forced: true,
    });
    equity[n - 1] = { date: klines[n - 1].date, value: +finalValue.toFixed(2) };
  }

  const totalReturn = (finalValue / capital - 1) * 100;
  const years = Math.max(n / 252, 0.25);
  const annualized = (Math.pow(finalValue / capital, 1 / years) - 1) * 100;
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  // 基准：买入持有
  const buyholdReturn = (closes[n - 1] / closes[0] - 1) * 100;
  const buyholdEquity = closes.map((c, i) => ({
    date: klines[i].date,
    value: +((capital / closes[0]) * c).toFixed(2),
  }));

  return {
    strategy,
    params: { fast, slow, capital },
    range: { start: klines[0].date, end: klines[n - 1].date, bars: n },
    finalValue: +finalValue.toFixed(2),
    totalReturn: +totalReturn.toFixed(2),
    annualized: +annualized.toFixed(2),
    maxDrawdownPct: +(maxDrawdownPct * 100).toFixed(2),
    maxDrawdown: +maxDrawdown.toFixed(2),
    tradeCount: trades.length,
    winRate: +winRate.toFixed(1),
    avgWinPct: trades.filter((t) => t.pnlPct > 0).reduce((a, t) => a + t.pnlPct, 0) /
      Math.max(1, wins),
    avgLossPct: trades.filter((t) => t.pnlPct <= 0).reduce((a, t) => a + t.pnlPct, 0) /
      Math.max(1, trades.length - wins),
    benchmarkReturn: +buyholdReturn.toFixed(2),
    trades: trades.slice(-50),
    equity,
    benchmark: buyholdEquity,
  };
}

/** GET /api/backtest?symbol=MSFT&strategy=ma&fast=5&slow=20&capital=100000&count=500 */
app.get('/api/backtest', async (req, res) => {
  const symbol = String(req.query.symbol || 'MSFT');
  const code = toTencentCode(symbol);
  const strategy = ['ma', 'rsi', 'buyhold'].includes(String(req.query.strategy))
    ? String(req.query.strategy)
    : 'ma';
  const fast = Math.min(Math.max(Number(req.query.fast) || 5, 2), 120);
  const slow = Math.min(Math.max(Number(req.query.slow) || 20, fast + 1), 250);
  const capital = Math.min(Math.max(Number(req.query.capital) || 100000, 1000), 1e9);
  const count = Math.min(Number(req.query.count) || 500, 2000);

  try {
    const klines = await fetchDailyRows(code, count);
    if (!klines.length) throw new Error('K 线数据为空');
    const result = runBacktest(klines, strategy, fast, slow, capital);
    result.symbol = symbol;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: `回测失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 6. 网站 AI 问答（离线规则引擎，无外部 AI API） ─────────────
/** 推荐股票池（与前端 STOCK_POOL 一致） */
const QA_POOL = [
  { symbol: 'MSFT', name: '微软' },
  { symbol: 'NVDA', name: '英伟达' },
  { symbol: 'AAPL', name: '苹果' },
  { symbol: 'GOOGL', name: '谷歌-A' },
  { symbol: 'TSLA', name: '特斯拉' },
  { symbol: 'AMZN', name: '亚马逊' },
  { symbol: 'META', name: 'Meta' },
  { symbol: 'AMD', name: '超威半导体' },
  { symbol: '600519', name: '贵州茅台' },
  { symbol: '300750', name: '宁德时代' },
  { symbol: '00700', name: '腾讯控股' },
  { symbol: '03690', name: '美团-W' },
];

/** 简洁五因子评分（趋势/动量/量能/波动/位置，满分 100） */
function scoreStock(klines, quotePrice) {
  const closes = klines.map((k) => k.close);
  if (closes.length < 60) return { score: 0, rating: '数据不足', note: '历史数据不足 60 个交易日' };
  const latest = quotePrice || closes[closes.length - 1];
  let score = 0;
  const notes = [];
  // 趋势 30
  const avg = (arr, n) => arr.slice(-n).reduce((a, b) => a + b, 0) / n;
  const ma5 = avg(closes, 5);
  const ma20 = avg(closes, 20);
  const ma60 = avg(closes, 60);
  if (ma5 > ma20 && ma20 > ma60) {
    score += 22;
    notes.push('均线多头排列');
  } else if (ma5 < ma20 && ma20 < ma60) {
    score += 6;
    notes.push('均线空头排列');
  } else {
    score += 13;
    notes.push('均线纠缠');
  }
  if (latest > ma20) {
    score += 8;
  }
  // 动量 25
  const ret20 = (latest / closes[closes.length - 21] - 1) * 100;
  if (ret20 >= 5 && ret20 <= 25) {
    score += 15;
    notes.push(`近20日涨幅 ${ret20.toFixed(1)}%`);
  } else if (ret20 > 25) {
    score += 7;
    notes.push(`近20日涨幅过大 ${ret20.toFixed(1)}%`);
  } else if (ret20 < -10) {
    score += 7;
    notes.push(`近20日超跌 ${ret20.toFixed(1)}%`);
  } else {
    score += 10;
  }
  const rsiArr = rsiSeries(closes, 14);
  const rsi = rsiArr[rsiArr.length - 1];
  if (rsi !== null && rsi >= 50 && rsi <= 70) {
    score += 10;
    notes.push(`RSI=${rsi.toFixed(1)} 强势区间`);
  } else if (rsi !== null && (rsi > 70 || rsi < 30)) {
    score += 5;
    notes.push(`RSI=${rsi.toFixed(1)} 极端区间`);
  }
  // 量能 15
  const vols = klines.map((k) => k.volume || 0);
  const avgVol5 = avg(vols.slice(-5), 5);
  const avgVol20 = avg(vols.slice(-20, -5), 15);
  const ratio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
  if (ratio > 1.3) {
    score += 12;
    notes.push(`量比 ${ratio.toFixed(2)} 放量`);
  } else if (ratio > 1) {
    score += 8;
  } else {
    score += 4;
  }
  // 波动 15
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const recent = rets.slice(-20);
  const m = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, b) => a + (b - m) * (b - m), 0) / recent.length;
  const volPct = Math.sqrt(variance) * 100;
  if (volPct >= 1 && volPct <= 3.5) {
    score += 12;
  } else if (volPct < 1) {
    score += 8;
  } else {
    score += 5;
  }
  // 位置 15
  const highs = klines.slice(-250).map((k) => k.high);
  const lows = klines.slice(-250).map((k) => k.low);
  const high52 = Math.max(...highs);
  const low52 = Math.min(...lows);
  const distHigh = ((high52 - latest) / high52) * 100;
  if (distHigh < 10) {
    score += 10;
    notes.push(`距52周高点仅 ${distHigh.toFixed(1)}%`);
  } else if (distHigh < 25) {
    score += 7;
  } else {
    score += 4;
  }
  if (((latest - low52) / low52) * 100 < 15) {
    score += 5;
  }
  const rating = score >= 80 ? '强烈关注' : score >= 65 ? '关注' : score >= 45 ? '中性' : '谨慎';
  return { score, rating, note: notes.join('；') };
}

/** 从问题中提取股票代码/名称 → symbol */
function extractSymbol(q) {
  const upper = q.toUpperCase();
  // 前缀代码：sh600519 / sz000858 / hk00700 / usAAPL
  let m = upper.match(/\b((?:SH|SZ|HK|US)\d{5,6}|(?:SH|SZ|HK|US)[A-Z]{1,6})\b/);
  if (m) {
    const code = m[1];
    if (/^US[A-Z]{1,6}$/.test(code)) return code.slice(2);
    return code.toLowerCase();
  }
  // 6 位 / 5 位数字
  m = upper.match(/\b(\d{6}|\d{5})\b/);
  if (m) return m[1];
  // 英文代码（排除常见疑问词）
  m = upper.match(/\b([A-Z]{2,6})\b/);
  if (m && !['AI', 'MACD', 'RSI', 'ETF', 'CEO'].includes(m[1])) {
    if (US_FALLBACK[m[1]] || /^[A-Z]{2,6}$/.test(m[1])) return m[1];
  }
  // 中文名称反查
  for (const [code, name] of Object.entries(US_FALLBACK)) {
    if (q.includes(name)) return code;
  }
  const CN_NAMES = {
    600519: '贵州茅台',
    300750: '宁德时代',
    '000001': '平安银行',
    601318: '中国平安',
    601899: '紫金矿业',
    002230: '科大讯飞',
  };
  for (const [code, name] of Object.entries(CN_NAMES)) {
    if (q.includes(name)) return code;
  }
  const HK_NAMES = { '00700': '腾讯控股', '09988': '阿里巴巴', '03690': '美团', '01810': '小米' };
  for (const [code, name] of Object.entries(HK_NAMES)) {
    if (q.includes(name)) return code;
  }
  return null;
}

const USAGE_GUIDE = [
  '📖 AI深度量化 使用指南',
  '1. 首页查看市场概况（6 大指数，每 10 秒自动刷新）、我的收藏、今日观察（因子评分）。',
  '2. 在任意搜索框输入股票代码（如 AAPL / 600519 / 00700 / sh000001），进入量化看板：',
  '   K线 + MA5/10/20/60/120/250 + 成交量 + MACD + 形态标注；',
  '   短期副图提供 1/5/15/30/60/120 分钟 K 线（多日真实数据）。',
  '3. 「量化因子分析」页面对个股做五因子（趋势/动量/量能/波动/位置）评分。',
  '4. 「策略回测」页面支持 MA 双均线 / RSI / 买入持有 策略的历史回测。',
  '5. 问我「分析 AAPL」「600519 怎么样」可直接获取个股解读；问「今天观察什么」获取因子评分排名。',
  '6. 数据来源：新浪/腾讯公开行情（无需 API Key），仅供参考，不构成投资建议。',
].join('\n');

/** 生成个股分析报告文本 */
async function analyzeForQA(symbol) {
  const code = toTencentCode(symbol);
  const quote = await getQuoteInternal(code, symbol);
  const klines = await fetchDailyRows(code, 250);
  if (!klines.length) return `⚠️ 未获取到 ${symbol} 的历史数据，请确认代码是否正确。`;
  const closes = klines.map((k) => k.close);
  const latest = quote?.price || closes[closes.length - 1];
  const { score, rating, note } = scoreStock(klines, quote?.price);
  const avg = (arr, n) => (arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const ma5 = avg(closes, 5);
  const ma20 = avg(closes, 20);
  const ma60 = avg(closes, 60);
  const high52 = Math.max(...klines.slice(-250).map((k) => k.high));
  const low52 = Math.min(...klines.slice(-250).map((k) => k.low));
  const lines = [
    `📊 ${symbol}${quote?.name ? `（${quote.name}）` : ''} 快速解读`,
    `最新价: ${latest.toFixed(2)}${quote?.changePercent != null ? `（${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%）` : ''}`,
    `MA5: ${ma5?.toFixed(2) ?? '--'} | MA20: ${ma20?.toFixed(2) ?? '--'} | MA60: ${ma60?.toFixed(2) ?? '--'}`,
    `52周区间: ${low52.toFixed(2)} ~ ${high52.toFixed(2)}（现价处于 ${(((latest - low52) / (high52 - low52)) * 100).toFixed(0)}% 分位）`,
    `AI 五因子评分: ${score}/100（${rating}）`,
    note ? `要点: ${note}` : '',
    '⚠️ 以上为量化指标解读，仅供参考，不构成投资建议。',
  ];
  return lines.filter(Boolean).join('\n');
}

/** 内部报价获取（复用缓存） */
async function getQuoteInternal(code, symbol) {
  const cacheKey = `quote:${code}`;
  const cached = getCached(cacheKey, QUOTE_TTL);
  if (cached) return cached;
  try {
    const text = await fetchTencentQuoteText(code);
    const quote = parseTencentQuote(text, symbol);
    if (quote?.price) {
      setCache(cacheKey, quote);
      return quote;
    }
  } catch {
    /* 报价失败不影响分析 */
  }
  return null;
}

/** GET /api/qa?q=问题 */
app.get('/api/qa', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ question: q, type: 'empty', answer: '请告诉我你的问题，例如「分析 AAPL」或「平台怎么用？」' });

  try {
    // 回测指引（优先级高于通用指南：避免「回测怎么用」被使用指南截胡）
    if (/回测|backtest/i.test(q)) {
      return res.json({
        question: q,
        type: 'guide',
        answer: [
          '📈 策略回测：',
          '1. 打开「策略回测」页面（首页功能中心或导航）。',
          '2. 输入股票代码，选择策略：MA 双均线（默认 5/20）、RSI 超买超卖（30/70）、买入持有。',
          '3. 设置初始资金，点击「开始回测」查看收益曲线、最大回撤、胜率、交易明细。',
          '回测基于真实历史日 K（新浪/腾讯），含 0.1% 双边手续费，仅供参考。',
        ].join('\n'),
      });
    }
    // 使用指南
    if (/怎么|如何|教程|帮助|使用|操作|入门|指南|help|guide|usage/i.test(q)) {
      return res.json({ question: q, type: 'guide', answer: USAGE_GUIDE });
    }
    // 今日观察（五因子评分）
    if (/推荐|选股|观察|机会|评分/i.test(q)) {
      const results = [];
      for (const item of QA_POOL.slice(0, 10)) {
        try {
          const code = toTencentCode(item.symbol);
          const [klines, quote] = await Promise.all([
            fetchDailyRows(code, 250),
            getQuoteInternal(code, item.symbol),
          ]);
          if (!klines.length) continue;
          const { score, rating } = scoreStock(klines, quote?.price);
          results.push({ symbol: item.symbol, name: item.name, price: quote?.price ?? klines[klines.length - 1].close, score, rating });
        } catch {
          /* 单只失败跳过 */
        }
      }
      results.sort((a, b) => b.score - a.score);
      const top = results.slice(0, 5);
      const answer = [
        '📊 因子评分观察 Top 5（五因子模型，满分 100）：',
        ...top.map((r, i) => `${i + 1}. ${r.symbol}（${r.name}）现价 ${Number(r.price).toFixed(2)} → ${r.score} 分 · ${r.rating}`),
        '想看某只的详细解读，可以问「分析 <代码>」。',
      ];
      return res.json({ question: q, type: 'recommend', answer: answer.join('\n') });
    }
    // 个股分析
    const symbol = extractSymbol(q);
    if (symbol) {
      const answer = await analyzeForQA(symbol);
      return res.json({ question: q, type: 'analysis', symbol, answer });
    }
    // 兜底
    return res.json({
      question: q,
      type: 'fallback',
      answer: [
        '🤖 我是 AI深度量化 的站内智能助手，可以：',
        '· 「分析 AAPL」—— 个股五因子解读（任何美股/A股/港股代码）',
        '· 「今天观察什么」—— 股票池因子评分排名',
        '· 「平台怎么用」—— 使用指南',
        '· 「回测怎么用」—— 策略回测指引',
        '试试输入上面任意一句吧！',
      ].join('\n'),
    });
  } catch (e) {
    res.status(500).json({ error: `AI 问答失败: ${e.message?.slice(0, 80)}` });
  }
});

// ───────────── 7. 健康检查 ─────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    name: `${APP_NAME}数据服务`,
    version: APP_VERSION,
    uptime: Math.floor(process.uptime()),
    cacheSize: cache.size,
    staticMode: fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html')),
    maintainWindow: !NO_MAINTAIN,
    time: new Date().toISOString(),
  });
});

// ───────────── 8. 自检维护（每日 02:00–03:00） ─────────────
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

/** 执行一次完整自检，返回报告对象 */
async function runMaintenance() {
  const report = {
    app: APP_NAME,
    version: APP_VERSION,
    startedAt: new Date().toISOString(),
    checks: [],
    summary: { total: 0, passed: 0, failed: 0 },
    issues: [],
  };
  const add = (name, ok, detail = '') => {
    report.checks.push({ name, ok, detail: String(detail).slice(0, 300), at: new Date().toISOString() });
    report.summary.total += 1;
    if (ok) report.summary.passed += 1;
    else {
      report.summary.failed += 1;
      report.issues.push(`${name}: ${String(detail).slice(0, 200)}`);
    }
  };

  // 1) 代码语法扫描（node --check 每个服务端文件）
  const serverDir = path.join(__dirname, '..', 'server');
  try {
    const files = fs.readdirSync(serverDir).filter((f) => /\.(cjs|js|mjs)$/.test(f));
    let allOk = true;
    const details = [];
    for (const f of files) {
      try {
        execFileSync(process.execPath, ['--check', path.join(serverDir, f)], { stdio: 'pipe' });
        details.push(`${f} ✓`);
      } catch (e) {
        allOk = false;
        details.push(`${f} ✗ ${String(e.message).slice(0, 80)}`);
      }
    }
    add('代码语法扫描', allOk, details.join('；'));
  } catch (e) {
    add('代码语法扫描', false, e.message);
  }

  // 2) dist 产物完整性
  try {
    const dist = path.join(__dirname, '..', 'dist');
    const idx = path.join(dist, 'index.html');
    const ok = fs.existsSync(idx) && fs.statSync(idx).size > 500;
    add('前端产物完整性', ok, ok ? `dist/index.html ${fs.statSync(idx).size} 字节` : 'dist/index.html 缺失或过小');
  } catch (e) {
    add('前端产物完整性', false, e.message);
  }

  // 3) 接口冒烟测试
  const base = `http://127.0.0.1:${PORT}`;
  const smoke = async (pathName, validate) => {
    try {
      const res = await axios.get(base + pathName, { timeout: 10000 });
      const ok = validate(res.data);
      return { ok, detail: ok ? 'OK' : '数据校验失败' };
    } catch (e) {
      return { ok: false, detail: `HTTP 失败: ${e.message?.slice(0, 60)}` };
    }
  };
  const s1 = await smoke('/api/health', (d) => d?.ok === true);
  add('冒烟: /api/health', s1.ok, s1.detail);
  const s2 = await smoke('/api/indices', (d) => Array.isArray(d) && d.length >= 4 && d.every((i) => Number.isFinite(i.price)));
  add('冒烟: /api/indices', s2.ok, s2.detail);
  const s3 = await smoke('/api/quote/AAPL', (d) => Number.isFinite(d?.price) && d.price > 0);
  add('冒烟: /api/quote/AAPL', s3.ok, s3.detail);
  const s4 = await smoke('/api/history/MSFT?count=30', (d) => Array.isArray(d?.klines) && d.klines.length >= 20);
  add('冒烟: /api/history/MSFT', s4.ok, s4.detail);
  const s5 = await smoke('/api/minute/sh600519', (d) => Array.isArray(d?.points) && d.points.length > 50);
  add('冒烟: /api/minute/sh600519', s5.ok, s5.detail);
  const s6 = await smoke('/api/mkline/sh600519?period=m5&count=20', (d) => Array.isArray(d?.klines) && d.klines.length >= 10);
  add('冒烟: /api/mkline/sh600519(m5)', s6.ok, s6.detail);
  const s7 = await smoke('/api/backtest?symbol=AAPL&strategy=ma&count=120', (d) => Number.isFinite(d?.totalReturn) && Array.isArray(d?.equity));
  add('冒烟: /api/backtest/AAPL', s7.ok, s7.detail);
  const s8 = await smoke(`/api/qa?q=${encodeURIComponent('平台怎么用')}`, (d) => typeof d?.answer === 'string' && d.answer.length > 10);
  add('冒烟: /api/qa', s8.ok, s8.detail);

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - new Date(report.startedAt).getTime();

  // 写报告
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(REPORTS_DIR, `maintenance-${day}.json`),
      JSON.stringify(report, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(REPORTS_DIR, 'maintenance-latest.json'), JSON.stringify(report, null, 2), 'utf8');
    fs.appendFileSync(
      path.join(REPORTS_DIR, 'maintenance.log'),
      `[${report.startedAt}] 自检完成: ${report.summary.passed}/${report.summary.total} 通过${report.issues.length ? `，问题: ${report.issues.join(' | ')}` : ''}\n`,
      'utf8',
    );
  } catch (e) {
    console.error('写自检报告失败:', e.message);
  }
  console.log(
    `🔧 [自检] ${report.summary.passed}/${report.summary.total} 项通过` +
      (report.issues.length ? ` | 问题: ${report.issues.join(' | ')}` : ' | 全部正常 ✓'),
  );
  return report;
}

// 自检调度：每日 02:00–03:00 窗口执行一次（本地服务运行期间生效；
// 服务关闭期间由 Windows 计划任务 register-maintenance.bat 兜底；Vercel 环境不启用）
if (!NO_MAINTAIN && !MAINTAIN_ONCE && !IS_VERCEL) {
  let lastMaintainDay = '';
  setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === 2 && lastMaintainDay !== day) {
      lastMaintainDay = day;
      console.log(`🔧 [自检] 进入每日 02:00–03:00 维护窗口，开始自检...`);
      runMaintenance().catch((e) => console.error('[自检] 执行失败:', e.message));
    }
  }, 60_000);
  console.log('🔧 每日 02:00–03:00 自检调度已开启（--no-maintain 可关闭）');
}

// ───────────── 9. 静态托管（生产模式：单端口整站） ─────────────
const DIST_DIR = path.join(__dirname, '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (fs.existsSync(DIST_DIR)) {
  // gzip 预压缩资源优先（vite-plugin-compression 产物）
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    const enc = (req.headers['accept-encoding'] || '').includes('gzip');
    if (!enc) return next();
    const file = path.join(DIST_DIR, req.path);
    if (fs.existsSync(`${file}.gz`)) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      return res.sendFile(`${file}.gz`);
    }
    next();
  });
  app.use(express.static(DIST_DIR));
  // SPA 路由回退（/stock/MSFT、/backtest、/assistant 等前端路由）
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// 404 兜底（API 未命中）
app.use('/api', (req, res) => {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` });
});

// ───────────── 导出 / 启动 ─────────────
// 通用模式：
//   · Vercel Serverless：api/index.js import 本模块并导出 app（require.main 为打包入口，不会触发 listen）
//   · 本地直接运行：node server/index.cjs → require.main === module → 监听端口
//   · 自检模式：node server/index.cjs --maintain-once → 执行一次自检后退出
if (require.main === module) {
  if (MAINTAIN_ONCE) {
    // 仅执行一次自检后退出（供 Windows 计划任务使用）
    runMaintenance()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error('[自检] 执行失败:', e.message);
        process.exit(1);
      });
  } else {
    app.listen(PORT, () => {
      // 本机局域网地址列表（服务默认监听所有网卡，手机/平板可访问）
      const nets = os.networkInterfaces();
      const addrs = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
        }
      }
      console.log(`🚀 ${APP_NAME} 已启动: http://127.0.0.1:${PORT}  (v${APP_VERSION})`);
      console.log(`   - 本机打开:   http://127.0.0.1:${PORT}/`);
      if (addrs.length) {
        console.log(`   - 局域网打开: http://${addrs[0]}:${PORT}/（手机/其他电脑同一 WiFi 下可访问）`);
      }
      console.log(`   - 整站页面:   http://127.0.0.1:${PORT}/`);
      console.log(`   - 实时报价:   http://127.0.0.1:${PORT}/api/quote/sh600519`);
      console.log(`   - 历史K线:    http://127.0.0.1:${PORT}/api/history/sh600519`);
      console.log(`   - 分钟K线:    http://127.0.0.1:${PORT}/api/mkline/sh600519?period=m5`);
      console.log(`   - 大盘指数:   http://127.0.0.1:${PORT}/api/indices`);
      console.log(`   - 策略回测:   http://127.0.0.1:${PORT}/api/backtest?symbol=AAPL`);
      console.log(`   - AI问答:     http://127.0.0.1:${PORT}/api/qa?q=分析AAPL`);
      console.log(`   - 搜索:       http://127.0.0.1:${PORT}/api/search/茅台`);
      console.log(`   - 健康检查:   http://127.0.0.1:${PORT}/api/health`);
      console.log(`   - 自检:       node server/index.cjs --maintain-once`);
      if (!fs.existsSync(DIST_DIR)) {
        console.warn('⚠️ 未检测到 dist/ 前端产物：请先运行 npm run build（或 npm start 一键构建启动）');
      }
    });
  }
}

// 导出 Express 应用（Vercel / ESM 包装复用）
module.exports = app;
// 兼容 esbuild 打包（@vercel/node）：CJS→ESM 互操作需要 default 命名导出
module.exports.default = app;
