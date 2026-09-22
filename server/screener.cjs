// ─────────────────────────────────────────────────────────────
// 全市场选股引擎 + 市场温度计（融合自 tick-stock-panel/TSP 选股思路）
//   · 数据：东方财富 push2 clist 全 A 快照（5286 只，100 条/页并发分页）
//     字段：f12代码 f14名称 f2现价 f3涨幅 f5成交量 f6成交额 f8换手 f10量比
//           f15高 f16低 f18开 f20总市值 f100行业
//   · 60 秒缓存 + lastGood 10 分钟兜底（复用 sectors.cjs 的高可用模式）
//   · 策略全部基于实时快照字段（无需历史 K 线，规避批量拉历史的限流问题）
// ─────────────────────────────────────────────────────────────
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

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

// ═══════════════ 腾讯批量行情（首选源，2026-09-22 新增）═══════════════
//
//  为什么加它：东财对**境外 IP 不响应**。实测（同一 Vercel 函数、同一时刻）：
//    腾讯源 0.159s 回 200 ／ 东财源 8s 超时（改 hkg1 前是 502）
//  选股与市场温度计都依赖"全市场快照"，故改为「腾讯批量行情 + 本地全A清单」。
//  腾讯没有"列出全部股票"的接口 ⇒ 清单随代码部署（server/a-share-list.json）。
//
//  🔴 字段下标（0-based）**已用不变量验证**，不是肉眼核对的：
//     · 现价必须落在 [最低, 最高] 之间
//     · 涨跌% 必须与 price/prevClose-1 自洽（容差 0.02）
//     · 市值量级必须对得上（茅台≈1.57万亿、工行总市值≈2.89万亿）
//     映射错一位就会产出「看起来完全正常、其实完全错误」的数字，
//     —— 本项目最忌讳这个（数值可信是根基），故必须靠不变量而非肉眼。
//     验证脚本：.tmpdir/tencent-probe.cjs（36 项断言全过）
const T = {
  name: 1, price: 3, prevClose: 4, open: 5, volume: 6,
  pct: 32, high: 33, low: 34,
  amountWan: 37, turnover: 38,   // 成交额（万元）· 换手率 %
  floatCapYi: 44, totalCapYi: 45, // 流通/总市值（亿元）
  volRatio: 49,                   // 量比
};

const LIST_FILE = path.join(__dirname, 'a-share-list.json');
let listCache = null;
/** 全A清单（代码 + 行业）。行业腾讯不给，只能来自这里；名称腾讯随行情带回，故不存。 */
function readAStockList() {
  if (listCache) return listCache;
  try {
    listCache = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  } catch (e) {
    listCache = [];
    console.warn('[Screener] 全A清单读取失败（选股将无数据）:', e.message);
  }
  return listCache;
}

/**
 * 纯解析：把腾讯返回的 GBK 文本解析成行情行（**不碰网络，可单测**）。
 *   抽出来单独测试的原因：这套 0-based 下标一旦错位，产出的数字
 *   「看起来完全正常、其实完全错误」—— 靠肉眼 review 抓不住，只能靠不变量断言锁住。
 * @param text  腾讯响应文本（已由 GBK 解码）
 * @param indMap 代码 → 行业（腾讯不给行业，只能外部注入）
 */
function parseTencent(text, indMap = new Map()) {
  const out = [];
  for (const line of String(text || '').split(';')) {
    const m = line.match(/v_([a-z]{2})(\d{6})="([^"]*)"/);
    if (!m) continue;
    const f = m[3].split('~');
    const num = (i) => {
      const v = Number(f[i]);
      return Number.isFinite(v) ? v : null;
    };
    const price = num(T.price);
    if (price == null || price <= 0) continue; // 停牌 / 无效行
    out.push({
      // code 用**纯 6 位数字**，与东财口径一致 —— 下游 limitPctOf(code) 与
      // 前端 /stock/:code 导航都依赖这个格式，换了就会静默出错。
      code: m[2],
      name: f[T.name] || '',
      price,
      pct: num(T.pct) ?? 0,
      volume: num(T.volume) ?? 0,
      amount: (num(T.amountWan) ?? 0) * 1e4, // 万元 → 元
      turnover: num(T.turnover) ?? 0, // %
      volRatio: num(T.volRatio) ?? 0,
      high: num(T.high) ?? price,
      low: num(T.low) ?? price,
      open: num(T.open) ?? num(T.prevClose) ?? price,
      mktCap: (num(T.totalCapYi) ?? 0) * 1e8, // 亿元 → 元（与东财 f20 同口径）
      industry: indMap.get(m[1] + m[2]) || '—',
    });
  }
  return out;
}

/** 单批拉取（腾讯允许一次查多只；返回 GBK，须按 GBK 解码） */
async function fetchTencentBatch(codes, indMap) {
  const res = await axios.get(`https://qt.gtimg.cn/q=${codes.join(',')}`, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 12000,
    responseType: 'arraybuffer',
  });
  return parseTencent(iconv.decode(Buffer.from(res.data), 'gbk'), indMap);
}

/** 并发拉全市场：80 只/批 + 4 并发 + 40ms 间隔（58 批约 5 秒，可塞进 30s 上限） */
async function fetchAllSnapshotTencent() {
  const list = readAStockList();
  if (list.length < 1000) throw new Error(`全A清单过小（${list.length} 条）—— 检查 server/a-share-list.json`);
  const indMap = new Map(list.map((x) => [x.code, x.industry]));
  const codes = list.map((x) => x.code);
  const BATCH = 80;
  const batches = [];
  for (let i = 0; i < codes.length; i += BATCH) batches.push(codes.slice(i, i + BATCH));

  const rows = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const b = batches[cursor++];
      try {
        rows.push(...(await fetchTencentBatch(b, indMap)));
      } catch {
        /* 单批失败跳过，不阻塞整体（与东财路径同一策略） */
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return rows;
}

// ═══════════════ 东财（备用源，保留：本机/局域网仍可用）═══════════════
/** 并发分页拉全市场（concurrency 4 + 120ms 限速，避免触发东财封禁） */
async function fetchAllSnapshotEastmoney() {
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

/** 数据源调度：**腾讯优先**，行数不足或抛错时回落东财（本机/局域网仍走东财可用） */
let lastSource = 'tencent';
async function fetchAllSnapshot() {
  const attempts = [
    { name: 'tencent', fn: fetchAllSnapshotTencent },
    { name: 'eastmoney', fn: fetchAllSnapshotEastmoney },
  ];
  const errs = [];
  for (const a of attempts) {
    try {
      const rows = await a.fn();
      if (rows.length >= 1000) {
        lastSource = a.name;
        return rows;
      }
      errs.push(`${a.name}: 行数过少(${rows.length})`);
    } catch (e) {
      errs.push(`${a.name}: ${e.message}`);
    }
  }
  // 全部失败时**显式报错**（不静默返回空数组 —— 那会被前端读成"没有命中"）
  throw new Error('所有数据源均失败 → ' + errs.join(' | '));
}

/** 带缓存的全市场快照（60s TTL + 10min stale 兜底） */
async function snapshot() {
  const c = cache.get('all');
  if (c && Date.now() - c.ts < 60_000) return c.data;
  try {
    const rows = await fetchAllSnapshot();
    if (rows.length < 1000) throw new Error('快照行数异常: ' + rows.length);
    const data = { rows, ts: Date.now(), via: lastSource };
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

module.exports = { getMood, runScreener, STRATEGIES, snapshot, parseTencent };
