// ─────────────────────────────────────────────────────────────
// 板块数据层（东方财富 push2 公开接口）
//   · 行业/概念/地域 板块行情 + 主力净流入 + 领涨股
//   · 板块分时（卡片 sparkline 用）
//   · 内存缓存 30 秒（准实时）
// ─────────────────────────────────────────────────────────────
const axios = require('axios');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const TYPE_MAP = { industry: 'm:90+t:2', concept: 'm:90+t:3', region: 'm:90+t:1' };
const TYPE_NAME = { industry: '行业板块', concept: '概念板块', region: '地域板块' };
const cache = new Map();
const lastGood = new Map(); // 上游限流/断连时的最后有效数据（10 分钟内兜底）

async function getJSON(url) {
  // 东财接口间歇性断连/限流：重试 + push2delay 备用域名
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout: 6000 });
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

function cached(key, ttl, loader) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < ttl) return Promise.resolve(c.data);
  return (async () => {
    let data = null;
    try {
      data = await loader();
    } catch (e) {
      data = null;
    }
    if (data != null) {
      cache.set(key, { ts: Date.now(), data });
      lastGood.set(key, { ts: Date.now(), data });
      return data;
    }
    const g = lastGood.get(key);
    if (g && Date.now() - g.ts < 10 * 60_000) return { ...g.data, __stale: true };
    return null;
  })();
}

/** 板块主力净流入排行（按主力净流入降序） */
function getFlow(type = 'industry') {
  const fs_ = TYPE_MAP[type] ?? TYPE_MAP.industry;
  return cached(`flow:${fs_}`, 30_000, async () => {
    const url =
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f62` +
      `&fs=${fs_}&fields=f12,f14,f2,f3,f62,f128,f136`;
    const j = await getJSON(url);
    const diff = j?.data?.diff ?? [];
    const rows = diff
      .map((d) => ({
        code: d.f12,
        name: d.f14,
        changePct: Number.isFinite(d.f3) ? d.f3 : null,
        mainNet: Number.isFinite(d.f62) ? d.f62 : null,
        leader: d.f128 ?? '',
        leaderPct: Number.isFinite(d.f136) ? d.f136 : null,
      }))
      .filter((r) => r.mainNet != null);
    if (!rows.length) return null;
    const byIn = [...rows].sort((a, b) => b.mainNet - a.mainNet);
    const byPct = [...rows].sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999));
    return {
      typeName: TYPE_NAME[type] ?? type,
      updatedAt: new Date().toISOString(),
      inflow: byIn.slice(0, 5), // 净流入前5
      outflow: [...rows].reverse().slice(0, 5), // 净流出前5
      gainers: byPct.slice(0, 5), // 涨幅榜前5（异动感知）
      losers: byPct.slice(-5).reverse(), // 跌幅榜前5
    };
  });
}

/** 板块卡片（按涨跌幅排序，含分时 sparkline 与领涨股） */
function getCards(type = 'industry', limit = 8) {
  const fs_ = TYPE_MAP[type] ?? TYPE_MAP.industry;
  return cached(`cards:${fs_}`, 30_000, async () => {
    const url =
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${limit}&po=1&np=1&fltt=2&invt=2&fid=f3` +
      `&fs=${fs_}&fields=f12,f14,f3,f62,f128,f136`;
    const j = await getJSON(url);
    const diff = j?.data?.diff ?? [];
    const rows = diff
      .map((d) => ({
        code: d.f12,
        name: d.f14,
        changePct: Number.isFinite(d.f3) ? d.f3 : null,
        mainNet: Number.isFinite(d.f62) ? d.f62 : null,
        leader: d.f128 ?? '',
        leaderPct: Number.isFinite(d.f136) ? d.f136 : null,
        spark: null,
      }))
      .filter((r) => r.changePct != null);

    // 并行拉取每张卡的板块分时（sparkline）
    await Promise.all(
      rows.map(async (r) => {
        try {
          const t = await getJSON(
            `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=90.${r.code}` +
              `&fields1=f1,f2,f3&fields2=f51,f53&iscr=0&ndays=1`,
          );
          const trends = t?.data?.trends ?? [];
          r.spark = {
            t: trends.map((x) => x.split(',')[0].slice(11, 16)),
            p: trends.map((x) => +x.split(',')[1]),
          };
        } catch {
          r.spark = null;
        }
      }),
    );
    return { typeName: TYPE_NAME[type] ?? type, updatedAt: new Date().toISOString(), cards: rows };
  });
}

module.exports = { getFlow, getCards };
