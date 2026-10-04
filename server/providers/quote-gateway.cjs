'use strict';
// ─────────────────────────────────────────────────────────────
// 行情数据 Provider 网关 v1（第四刀 · 行情域）
//   · 封装 quote / history / mkline / minute / indices / search / period-policy
//     的数据获取、多源优先级链、解析、缓存与显式降级标注。
//   · 所有对外方法返回可直接 res.json 的数据对象；失败时抛出 Error，由路由层
//     映射为 HTTP 状态码（保持与原 index.cjs 一致）。
//   · 内部 API getQuoteInternal / fetchDailyRows 供其他域（回测/参数扫描/QA/Agent）使用。
//   · 本模块不 import server/index.cjs，所有外部依赖（axios/iconv/IS_VERCEL/localstore/
//     toTencentCode）由宿主显式注入，避免循环引用。
// 行为零变化：函数体从 index.cjs 原样迁移，仅依赖改为注入、缓存隔离到本网关。
// ─────────────────────────────────────────────────────────────

/** 创建行情 Provider 网关实例 */
function createQuoteGateway(deps) {
  const { axios, iconv, IS_VERCEL, localstore, toTencentCode } = deps;

  // ───────────── 内存缓存 ─────────────
  const cache = new Map();
  const TTL = {
    quote: 5_000,      // 实时报价 5 秒
    history: 300_000,  // 历史数据 5 分钟
    indices: 5_000,
    search: 60_000,
    mkline: 60_000,    // 分钟K线 1 分钟
  };
  function getCached(key, ttlMs) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
    return null;
  }
  function setCache(key, data) {
    cache.set(key, { data, ts: Date.now() });
  }
  // 缓存兜底清理：过期超 5 分钟即删 + 总量裁剪，防长期运行内存无界增长
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.ts > 300_000) cache.delete(k);
    if (cache.size > 2000) {
      for (const k of Array.from(cache.keys()).slice(0, cache.size - 2000)) cache.delete(k);
    }
  }, 60_000).unref();

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

    // 五档盘口（仅 A 股）：腾讯字段 9-18 = 买一~买五价/量（手），19-28 = 卖一~卖五价/量；30 = 行情时间
    let bids = null;
    let asks = null;
    let quoteTime = null;
    if (isCN && parts.length > 30) {
      const bidsRaw = [];
      const asksRaw = [];
      for (let i = 0; i < 5; i++) {
        const bp = num(parts[9 + i * 2]);
        const bv = num(parts[10 + i * 2]);
        const ap = num(parts[19 + i * 2]);
        const av = num(parts[20 + i * 2]);
        if (bp != null && bv != null) bidsRaw.push({ price: bp, qty: bv * 100 });
        if (ap != null && av != null) asksRaw.push({ price: ap, qty: av * 100 });
      }
      bids = bidsRaw.sort((a, b) => b.price - a.price);
      asks = asksRaw.sort((a, b) => a.price - b.price);
      quoteTime = parts[30] && /^\d{14}$/.test(parts[30])
        ? `${parts[30].slice(8, 10)}:${parts[30].slice(10, 12)}:${parts[30].slice(12, 14)}`
        : null;
    }

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
      bids,
      asks,
      quoteTime,
    };
  }

  /** 获取腾讯行情文本；美股自动探测交易所后缀（usAAPL → usAAPL.OQ / usAAPL.N） */
  async function fetchTencentQuoteText(code) {
    const headers = { 'User-Agent': UA, Referer: 'https://finance.qq.com' };
    let text = await fetchText(`https://qt.gtimg.cn/q=${code}`, headers);
    const isEmpty = new RegExp(`v_${code}=""`).test(text);
    if (/^us/i.test(code) && isEmpty) {
      for (const suffix of ['.OQ', '.N', '.A']) {
        const candidate = `${code}${suffix}`;
        try {
          const t = await fetchText(`https://qt.gtimg.cn/q=${candidate}`, headers);
          if (t && !new RegExp(`v_${candidate}=""`).test(t)) return t;
        } catch {
          /* 尝试下一个后缀 */
        }
      }
    }
    return text;
  }

  /** 内部报价获取（复用缓存；失败返回 null，不抛错） */
  async function getQuoteInternal(code, symbol) {
    const cacheKey = `quote:${code}`;
    const cached = getCached(cacheKey, TTL.quote);
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

  /** 对外报价接口（路由层使用）：命中缓存直接返回；无价格抛 404；异常抛 500 */
  async function fetchQuote(symbol) {
    const code = toTencentCode(symbol);
    const cacheKey = `quote:${code}`;
    const cached = getCached(cacheKey, TTL.quote);
    if (cached) return cached;

    const text = await fetchTencentQuoteText(code);
    const quote = parseTencentQuote(text, symbol);
    if (!quote || !quote.price) {
      const err = new Error(`未获取到 ${symbol} 的实时报价`);
      err.status = 404;
      throw err;
    }
    setCache(cacheKey, quote);
    return quote;
  }

  // ───────────── 2. 历史 K 线 ─────────────
  /** 解析腾讯 K 线 JSON：{data:{code:{day:[[date,open,close,high,low,vol],...]}}} */
  function parseTencentKlines(json, symbol, unit = 'day', adjust = 'qfq') {
    const data = json?.data?.[symbol];
    if (!data) return [];
    // 腾讯按复权模式返回不同数据键：qfqday / hfqday / day（不复权）
    const rows = (adjust !== 'none' ? data?.[`${adjust}${unit}`] : null) || data?.[`qfq${unit}`] || data?.[unit] || [];
    // A股成交量单位为手（×100 = 股），与 Baostock 等源统一为股
    const isCN = /^(sh|sz)/.test(String(symbol).toLowerCase());
    return rows.map((r) => ({
      date: String(r[0]).slice(0, 10),
      open: num(r[1]),
      close: num(r[2]),
      high: num(r[3]),
      low: num(r[4]),
      volume: isCN ? (num(r[5]) ?? 0) * 100 : num(r[5]),
    }));
  }

  /** 获取日 K 原始行（美股自动探测交易所后缀；供 history/backtest/qa/Agent 复用） */
  async function fetchDailyRows(code, count = 500, adjust = 'qfq') {
    // 腾讯/新浪日K单次上限 2000 根，超限会导致接口返回空
    const c = Math.min(Number(count) || 500, 2000);
    const candidates = /^us/i.test(code) ? [`${code}.OQ`, `${code}.N`, code] : [code];
    let best = [];
    for (const cand of candidates) {
      try {
        if (adjust === 'none') {
          // 不复权走 kline/kline 端点（单次可给 2000 根）
          const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${cand},day,,,${c}`;
          const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
          const json = JSON.parse(text);
          if (json.code !== 0) continue;
          const rows = parseTencentKlines(json, cand, 'day', adjust);
          if (rows.length > 2) {
            best = rows;
            break;
          }
        } else {
          // 前复权/后复权：fqkline 单次上限 640 根 → 分页向前抓取（最多 4 页 ≈ 7.5 年）
          let collected = [];
          let end = '';
          for (let page = 0; page < 4 && collected.length < c; page++) {
            const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${cand},day,,${end},${Math.min(c - collected.length, 640)},${adjust}`;
            const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
            const json = JSON.parse(text);
            if (json.code !== 0) break;
            const rows = parseTencentKlines(json, cand, 'day', adjust);
            const seen = new Set(collected.map((r) => r.date));
            const fresh = rows.filter((r) => !seen.has(r.date));
            if (!fresh.length) break;
            collected = [...fresh, ...collected].sort((a, b) => a.date.localeCompare(b.date));
            end = collected[0].date; // 下一页以当前最早日期为终点向前翻
          }
          if (collected.length > 2) {
            best = collected;
            break;
          }
        }
      } catch {
        /* 尝试下一个候选 */
      }
    }
    // 新浪长历史补充：仅用于不复权模式（新浪为不复权口径，混入会破坏前/后复权连续性）
    if (best.length < 800 && adjust === 'none' && /^(sh|sz)/i.test(code) && c > 800) {
      try {
        const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=240&ma=no&datalen=${c}`;
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

  /** 周期可用性策略（后端按数据覆盖动态生成，新上市股票自动适配） */
  async function fetchPeriodPolicy(symbol) {
    const code = toTencentCode(symbol);
    const cacheKey = `period-policy:${code}`;
    const cached = getCached(cacheKey, TTL.history);
    if (cached) return cached;

    const klines = await fetchDailyRows(code, 2400);
    if (!klines.length) throw new Error('K 线数据为空');
    const first = klines[0].date;
    const last = klines[klines.length - 1].date;
    const spanDays = (Date.parse(last) - Date.parse(first)) / 86400000;
    const policy = {
      symbol,
      source: 'baostock-or-tencent',
      dataStart: first,
      dataEnd: last,
      barCount: klines.length,
      coverageDays: Math.round(spanDays),
      // 周期可用性：季线需 ≥1 年数据，年线需 ≥3 年数据（参考主流软件，数据不足置灰提示）
      periods: {
        day: true,
        '3day': true,
        week: true,
        month: true,
        quarter: spanDays >= 365,
        year: spanDays >= 1000,
      },
      recommended: spanDays < 365 ? 'day' : spanDays < 1000 ? 'month' : 'year',
    };
    setCache(cacheKey, policy);
    return policy;
  }

  /** 对外历史 K 线接口：含源优先级链、新浪兜底、本地归档兜底、美股指数快照兜底 */
  async function fetchHistory(symbol, frequency, count, adjust) {
    const code = toTencentCode(symbol);
    const freq = frequency || '1d';
    const cnt = Math.min(Number(count) || 500, 2000);
    const adj = ['qfq', 'hfq', 'none'].includes(String(adjust)) ? String(adjust) : 'qfq';
    const cacheKey = `history:${code}:${freq}:${cnt}:${adj}`;
    const cached = getCached(cacheKey, TTL.history);
    if (cached) return cached;

    // 周期映射：1d/1w/1M → 腾讯 unit
    const unitMap = { '1d': 'day', '1w': 'week', '1M': 'month' };
    const unit = unitMap[freq] || 'day';

    try {
      const klines = await fetchDailyRows(code, cnt, adj);
      if (!klines.length) throw new Error('K 线数据为空');
      // 周/月线：后端直接请求对应 unit，避免前端聚合
      let out = klines;
      if (unit === 'week' || unit === 'month') {
        const cand = /^us/i.test(code) ? `${code}.OQ` : code;
        try {
          const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${cand},${unit},,,${cnt}${adj === 'none' ? '' : ',' + adj}`;
          const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
          const json = JSON.parse(text);
          const rows = parseTencentKlines(json, cand, unit, adj);
          if (rows.length > 1) out = rows;
        } catch {
          /* 保留日线回退 */
        }
      }
      const result = { symbol: code, frequency: freq, adjust: adj, klines: out };
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      // 备用：新浪日 K
      try {
        const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=240&ma=no&datalen=${cnt}`;
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
        const result = { symbol: code, frequency: freq, adjust: adj === 'none' ? 'none' : 'none(备用源)', klines };
        setCache(cacheKey, result);
        return result;
      } catch (e2) {
        // 本地归档兜底（Baostock 每日同步）：上游全挂时返回本地不复权数据，显式标注来源与口径（禁止静默降级）
        if (unit === 'day') {
          const local = localstore.getLocalKline(code, cnt);
          if (local && local.length) {
            const result = {
              symbol: code,
              frequency: freq,
              adjust: adj === 'none' ? 'none' : 'none(本地归档)',
              source: 'local-archive',
              stale: true,
              klines: local,
            };
            setCache(cacheKey, result);
            return result;
          }
        }
        // 美股指数专属兜底：腾讯对指数不支持复权历史（fqkline/kline 均只返回最新 1 根），
        // 新浪 CN 接口不覆盖美股 ⇒ 无本地归档时上游"全败"其实是数据源固有缺失，不是瞬时故障。
        // 降级为"最新交易日快照 K 线"（1 根）并显式标注 degraded，而不是 500 ——
        // 前端 sparkline/卡片对 1 根数据的处理已兼容，500 反而会让首页持续刷错误请求。
        if (unit === 'day' && /^us(INX|IXIC|DJI)$/i.test(code)) {
          try {
            const cand = `${code}.OQ`;
            const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${cand},day,,,5,qfq`;
            const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
            const json = JSON.parse(text);
            const rows = parseTencentKlines(json, cand, 'day', adj);
            if (rows.length) {
              const result = {
                symbol: code,
                frequency: freq,
                adjust: 'none(指数快照)',
                source: 'tencent-index-snapshot',
                stale: true,
                degraded: '美股指数暂无免费历史K线数据源（腾讯指数仅提供最新交易日），已降级为快照数据',
                klines: rows,
              };
              setCache(cacheKey, result);
              return result;
            }
          } catch { /* 快照也失败则走下方抛错 */ }
        }
        throw new Error(`获取历史数据失败: ${e2.message?.slice(0, 80)}`);
      }
    }
  }

  // ───────────── 3. 分钟 K 线 ─────────────
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

  /**
   * GET /api/mkline/:symbol?period=m5&count=320
   * 真实分钟 K 线（多日）：
   *   - A股/指数：腾讯 mkline（m1/m5/m15/m30/m60）
   *   - 美股：新浪 US_MinKService（type=1/5/15/30/60）
   *   - 港股：腾讯当日分时聚合
   */
  async function fetchMkline(symbol, period, count) {
    const code = toTencentCode(symbol);
    const rawPeriod = String(period || 'm5').replace(/^m/, '');
    const valid = ['1', '5', '15', '30', '60'];
    const step = valid.includes(rawPeriod) ? Number(rawPeriod) : 5;
    const cnt = Math.min(Number(count) || 320, 800);
    const cacheKey = `mkline:${code}:${step}:${cnt}`; // 必须含 count：120 分(640) 与 60 分(320) 同键会串味
    const cached = getCached(cacheKey, TTL.mkline);
    if (cached) return cached;

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
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
      const json = JSON.parse(text);
      const base = parseTencentMinuteKlines(json, code);
      klines = aggregateMinuteKlines(base, step);
      source = 'tencent-minute';
    } else {
      // ── A股：腾讯 mkline ──
      const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${code},m${step},,${cnt}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
      const json = JSON.parse(text);
      klines = parseTencentMkline(json, code, `m${step}`);
      source = 'tencent-mkline';
    }
    if (!klines.length) {
      // 新股/北交所兜底：mkline 无数据时用当日分时聚合生成分钟 K（如 920288 上市首日）
      try {
        const mUrl = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
        const mText = await fetchText(mUrl, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
        const mJson = JSON.parse(mText);
        const bjDate = mJson?.data?.[code]?.data?.date;
        const bjDay = bjDate ? `${bjDate.slice(0, 4)}-${bjDate.slice(4, 6)}-${bjDate.slice(6, 8)}` : null;
        const pts = parseTencentMinute(mJson, code)
          .map((p) => ({
            date: `${bjDay ?? ''} ${p.time}`,
            open: p.price, close: p.price, high: p.price, low: p.price, volume: p.volume,
          }))
          .filter((p) => p.date.trim() !== '');
        if (pts.length) {
          klines = aggregateMinuteKlines(pts, step);
          source = 'tencent-minute-agg';
        }
      } catch { /* 兜底失败保持空 */ }
    }
    if (!klines.length) throw new Error('分钟 K 线数据为空');
    const result = { symbol: code, period: `m${step}`, source, klines: klines.slice(-cnt) };
    setCache(cacheKey, result);
    return result;
  }

  // ───────────── 4. 当日分时 ─────────────
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

  async function fetchMinute(symbol) {
    const code = toTencentCode(symbol);
    const cacheKey = `minute:${code}`;
    const cached = getCached(cacheKey, TTL.quote);
    if (cached) return cached;

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
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.qq.com' });
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
    return result;
  }

  // ───────────── 5. 大盘指数 ─────────────
  const INDEX_CODES = ['sh000001', 'sh000300', 'sz399001', 'usINX', 'usIXIC', 'usDJI'];
  const INDEX_NAMES = {
    sh000001: '上证指数',
    sh000300: '沪深300',
    sz399001: '深证成指',
    usINX: '标普500',
    usIXIC: '纳斯达克',
    usDJI: '道琼斯',
  };

  async function fetchIndices() {
    const cacheKey = 'indices';
    const cached = getCached(cacheKey, TTL.indices);
    if (cached) return cached;

    const text = await fetchText(`https://qt.gtimg.cn/q=${INDEX_CODES.join(',')}`, {
      'User-Agent': UA,
      Referer: 'https://finance.qq.com',
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
    return items;
  }

  // ───────────── 6. 搜索 ─────────────
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

  async function searchSymbol(keyword) {
    const cacheKey = `search:${keyword}`;
    const cached = getCached(cacheKey, TTL.search);
    if (cached) return cached;

    const items = [];

    // 源 1：新浪 sugest（沪深港美主流代码）
    try {
      const url = `https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(keyword)}`;
      const text = await fetchText(url, { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' });
      items.push(...parseSinaSearch(text));
    } catch { /* 新浪失败继续东财 */ }

    // 源 2：东财 suggest（兜底：覆盖北交所 920/43/83/87/88 等新浪缺失的代码段；名称=代码的弱结果也尝试补全）
    const isWeakName = (it) => it.name === it.code || /^(sh|sz|bj)\d{5,6}$/.test(it.name); // 名称是"交易所前缀+代码"=无效名称
    if (items.length === 0 || items.every(isWeakName)) {
      items.length = 0; // 清空"名称=代码"的弱结果，用东财补全名称
      try {
        const emUrl = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8`;
        const em = (await axios.get(emUrl, { headers: { 'User-Agent': UA, Referer: 'https://www.eastmoney.com/' }, timeout: 6000 })).data;
        const list = em?.QuotationCodeTable?.Data ?? [];
        for (const d of list) {
          if (!d.Code) continue;
          const secid = String(d.QuoteID || '');
          const market = /^0\.|^1\./.test(secid) ? 'CN' : 'US';
          items.push({ name: d.Name, code: String(d.Code), market });
        }
      } catch { /* 东财也失败则走代码直填兜底 */ }
    }

    const upper = keyword.trim().toUpperCase();
    const isCodeLike = /^[A-Z0-9.]{1,10}$/.test(upper);
    if (isCodeLike) {
      const direct = US_FALLBACK[upper];
      if (direct) {
        items.length = 0;
        items.push({ name: direct, code: upper, market: 'US' });
      } else if (/^\d{6}$/.test(upper)) {
        if (items.length === 0) items.push({ name: upper, code: upper, market: 'CN' }); // 已有结果（如东财补全）不覆盖
      } else if (/^\d{5}$/.test(upper)) {
        if (items.length === 0) items.push({ name: upper, code: upper, market: 'HK' });
      } else if (/^[A-Z]{1,6}$/.test(upper) && items.every((it) => it.code.toUpperCase() !== upper)) {
        items.push({ name: upper, code: upper, market: 'US' });
      }
    }
    setCache(cacheKey, items);
    return items;
  }

  return {
    fetchQuote,
    fetchHistory,
    fetchPeriodPolicy,
    fetchMkline,
    fetchMinute,
    fetchIndices,
    searchSymbol,
    getQuoteInternal,
    fetchDailyRows,
  };
}

module.exports = { createQuoteGateway };
