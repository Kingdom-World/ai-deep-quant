// ─────────────────────────────────────────────────────────────
// 全市场选股引擎 + 市场温度计（融合自 tick-stock-panel/TSP 选股思路）
//   · 数据：东方财富 push2 clist 全 A 快照（5286 只，100 条/页并发分页）
//     字段：f12代码 f14名称 f2现价 f3涨幅 f5成交量 f6成交额 f8换手 f10量比
//           f15高 f16低 f18开 f20总市值 f100行业
//   · 60 秒缓存 + lastGood 10 分钟兜底（复用 sectors.cjs 的高可用模式）
//   · 策略全部基于实时快照字段（无需历史 K 线，规避批量拉历史的限流问题）
// ─────────────────────────────────────────────────────────────
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const FIELDS = 'f12,f14,f2,f3,f5,f6,f8,f10,f15,f16,f18,f20,f100';
// 沪深京全 A：深主板+创业板+沪主板+科创板+北交所
const FS_ALL_A = 'm:0+t:6,m:0+t:80,m:1+t:2,m:0+t:81+s:2048';

const cache = new Map();
const lastGood = new Map();

/** 域名亲和：记住本次会话可用的 push2 域名（主域被限流时自动落到 push2delay 并直连） */
let hostAffinity = 'push2.eastmoney.com';

/** 单页拉取（100 条/页，东财当前硬上限；主域失败立即切备用域） */
async function fetchPage(pn) {
  const hosts = hostAffinity === 'push2.eastmoney.com'
    ? ['push2.eastmoney.com', 'push2delay.eastmoney.com']
    : ['push2delay.eastmoney.com', 'push2.eastmoney.com'];
  let lastErr = null;
  for (const host of hosts) {
    try {
      const res = await axios.get(
        `https://${host}/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f6&fs=${FS_ALL_A}&fields=${FIELDS}`,
        { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout: 8000 },
      );
      hostAffinity = host;
      return { rows: res.data?.data?.diff ?? [], total: res.data?.data?.total ?? 0 };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 并发分页拉全市场（concurrency 4 + 120ms 限速，避免触发东财封禁） */
async function fetchAllSnapshot() {
  const first = await fetchPage(1);
  const pages = Math.ceil(first.total / 100);
  const rows = [...first.rows];
  let cursor = 2;
  const worker = async () => {
    while (cursor <= pages) {
      const pn = cursor++;
      try {
        const p = await fetchPage(pn);
        rows.push(...p.rows);
      } catch {
        /* 单页失败跳过，不阻塞整体 */
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, pages - 1)) }, worker));
  return rows
    .filter((d) => Number.isFinite(d.f2) && Number.isFinite(d.f3))
    .map((d) => ({
      code: String(d.f12),
      name: d.f14 ?? '',
      price: d.f2,
      pct: d.f3,
      volume: Number.isFinite(d.f5) ? d.f5 : 0,
      amount: Number.isFinite(d.f6) ? d.f6 : 0,
      turnover: Number.isFinite(d.f8) ? d.f8 : 0, // 换手率 %
      volRatio: Number.isFinite(d.f10) ? d.f10 : 0, // 量比
      high: Number.isFinite(d.f15) ? d.f15 : d.f2,
      low: Number.isFinite(d.f16) ? d.f16 : d.f2,
      open: Number.isFinite(d.f18) ? d.f18 : d.f2,
      mktCap: Number.isFinite(d.f20) ? d.f20 : 0, // 总市值（元）
      industry: d.f100 ?? '—',
    }));
}

/** 带缓存的全市场快照（60s TTL + 10min stale 兜底） */
async function snapshot() {
  const c = cache.get('all');
  if (c && Date.now() - c.ts < 60_000) return c.data;
  try {
    const rows = await fetchAllSnapshot();
    if (rows.length < 1000) throw new Error('快照行数异常: ' + rows.length);
    const data = { rows, ts: Date.now(), via: hostAffinity };
    cache.set('all', { ts: Date.now(), data });
    lastGood.set('all', { ts: Date.now(), data });
    return data;
  } catch (e) {
    const g = lastGood.get('all');
    if (g && Date.now() - g.ts < 10 * 60_000) return { ...g.data, stale: true };
    throw e;
  }
}

/** 涨停幅度线：主板 10% / 创业科创 20% / 北交所 30% */
function limitPctOf(code) {
  if (code.startsWith('30') || code.startsWith('68')) return 20;
  if (code.startsWith('92') || code.startsWith('83') || code.startsWith('87') || code.startsWith('43')) return 30;
  return 10;
}

/** 市场温度计：涨跌家数 / 涨停跌停 / 成交额 / 行业热度 */
async function getMood() {
  const { rows, ts, stale } = await snapshot();
  let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0, totalAmount = 0;
  const industryMap = new Map(); // 行业 → { sum, n, up }
  for (const r of rows) {
    if (r.pct > 0) up++;
    else if (r.pct < 0) down++;
    else flat++;
    const lim = limitPctOf(r.code);
    if (r.pct >= lim - 0.3) limitUp++;
    if (r.pct <= -(lim - 0.3)) limitDown++;
    totalAmount += r.amount;
    const ind = industryMap.get(r.industry) ?? { sum: 0, n: 0, up: 0 };
    ind.sum += r.pct; ind.n++;
    if (r.pct > 0) ind.up++;
    industryMap.set(r.industry, ind);
  }
  const industries = [...industryMap.entries()]
    .filter(([k]) => k && k !== '—')
    .map(([name, v]) => ({ name, avgPct: +(v.sum / v.n).toFixed(2), upRatio: v.n ? +(v.up / v.n).toFixed(2) : 0, count: v.n }))
    .sort((a, b) => b.avgPct - a.avgPct);
  // 情绪分 0-100：上涨占比 55% + 涨停热度 30% + 跌停惩罚 15%
  const upRatio = rows.length ? up / rows.length : 0;
  const score = Math.max(0, Math.min(100, Math.round(upRatio * 55 + Math.min(limitUp / 80, 1) * 30 + (1 - Math.min(limitDown / 40, 1)) * 15)));
  return {
    ok: true, ts, stale: Boolean(stale), total: rows.length,
    up, down, flat, limitUp, limitDown,
    totalAmount: +totalAmount.toFixed(0),
    score, industries: industries.slice(0, 8), coldest: industries.slice(-3).reverse(),
  };
}

const STRATEGIES = {
  // 量比突增：资金关注度骤升且尚未封板
  volumeSurge: { name: '量比突增', desc: '量比≥3 · 红盘未封板 · 成交额≥1亿', fn: (r) => r.volRatio >= 3 && r.pct > 0 && r.pct < limitPctOf(r.code) - 0.5 && r.amount >= 1e8 },
  // 放量上攻：温和放量强势上行
  volumePrice: { name: '放量上攻', desc: '量比≥1.5 · 涨幅≥2% · 成交额≥2亿', fn: (r) => r.volRatio >= 1.5 && r.pct >= 2 && r.pct < limitPctOf(r.code) - 0.5 && r.amount >= 2e8 },
  // 涨停梯队：已封板或触及涨停
  limitUp: { name: '涨停梯队', desc: '当日涨停（含触及）', fn: (r) => r.pct >= limitPctOf(r.code) - 0.3 },
  // 尾盘强势：收在全天高位附近
  nearHigh: { name: '贴近日内高点', desc: '现价≥日内高点99.5% · 涨幅≥4%', fn: (r) => r.pct >= 4 && r.price >= r.high * 0.995 },
  // 低开高走：承接有力
  lowOpenHigh: { name: '低开高走', desc: '现价高于开盘≥3% · 收红', fn: (r) => r.pct > 0 && r.open > 0 && r.price >= r.open * 1.03 },
  // 深度回调：当日超跌（博反弹观察池）
  deepPullback: { name: '深度回调', desc: '当日跌幅≥5%（风险观察）', fn: (r) => r.pct <= -5 },
  // 高换手活跃股
  highTurnover: { name: '高换手活跃', desc: '换手≥10% · 成交额≥3亿', fn: (r) => r.turnover >= 10 && r.amount >= 3e8 },
  // 大盘蓝筹异动：千亿以下大市值启动
  bigCapMove: { name: '大市值启动', desc: '市值≥300亿 · 涨幅≥2%', fn: (r) => r.mktCap >= 3e10 && r.pct >= 2 },
};

/** 执行选股：strategy=STRATEGIES 键；sort=amount|pct|volRatio|turnover */
async function runScreener(strategy = 'volumeSurge', sort = 'pct', limit = 50) {
  const def = STRATEGIES[strategy] ?? STRATEGIES.volumeSurge;
  const { rows, ts, stale } = await snapshot();
  const hit = rows.filter(def.fn);
  const sortKey = { amount: 'amount', pct: 'pct', volRatio: 'volRatio', turnover: 'turnover' }[sort] ?? 'pct';
  hit.sort((a, b) => b[sortKey] - a[sortKey]);
  return {
    ok: true, ts, stale: Boolean(stale),
    strategy, strategyName: def.name, desc: def.desc,
    scanned: rows.length, matched: hit.length,
    rows: hit.slice(0, limit),
  };
}

module.exports = { getMood, runScreener, STRATEGIES, snapshot };
