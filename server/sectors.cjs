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

/**
 * 带**总预算**的上游请求。
 *
 * 🔴 为什么必须是"总预算"而不是"每轮超时"：
 *   原实现是 `for (i<3) { push2(6s) → push2delay(6s); sleep(400) }`，
 *   最坏 3×(6+6+0.4) ≈ **37 秒**，而运行环境对单次请求有明确上限（30 秒）⇒
 *   请求**总在返回自己的错误之前被平台掐断**，表现为 504 而非
 *   `{ok:false,error:'板块数据源暂不可用'}`。即"优雅报错"被写成了"必然超时"。
 *   ⚠️ 通用原则：**上游重试预算必须显著小于运行环境的请求上限**。
 *
 * 现值：单次 3.5 秒、总预算 9 秒 ⇒ 最坏约 10.5 秒、典型（两域名都失败）约 7 秒，
 * 稳在平台上限之内，保证控制流能走到自己的错误分支。
 */
const UPSTREAM_TIMEOUT_MS = 3500;
const UPSTREAM_TOTAL_BUDGET_MS = 9000;

async function getJSON(url) {
  const started = Date.now();
  const urls = url.includes('push2.eastmoney.com')
    ? [url, url.replace('push2.eastmoney.com', 'push2delay.eastmoney.com')]
    : [url];
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    for (const u of urls) {
      if (Date.now() - started > UPSTREAM_TOTAL_BUDGET_MS) {
        throw lastErr ?? new Error('上游超时预算用尽');
      }
      try {
        const res = await axios.get(u, {
          headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
          timeout: UPSTREAM_TIMEOUT_MS,
        });
        return res.data;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr ?? new Error('上游不可达');
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

// ═══════════ 板块数据源：新浪（主）→ 腾讯（备）（2026-09-22 换源）═══════════
//
//  为什么换：**东财从当前运行环境不可达**（实测：选股 502/超时；板块接口挂满 30 秒）。
//
//  两个替代源已实测可用：
//    · **新浪** `MoneyFlow.ssl_bkzj_bk` —— 一个接口同时给「板块涨跌幅 + 主力净流入 + 领涨股」，
//      200ms 级响应，正好覆盖面板所需的全部字段。
//    · **腾讯** `mktHs/rank` —— 给「板块涨跌幅 + 领涨股」，**腾讯已验证从线上可达**（优势），
//      但**没有资金流数据** ⇒ 作备用，此时资金流字段回落为 null。
//
//  ⚠️ 两家板块分类口径不同（腾讯是申万式"电视广播Ⅱ"，新浪含"融资融券"等），
//     故**绝不逐条拼接**：只在主源整体失败时**整体切换**到备用源，避免出现两套命名混排。
let lastBoardSource = 'sina';

/**
 * 板块类型 → 新浪 fenlei。**取值经实测确认（2026-09-22），不可想当然**：
 *     fenlei=1 → `gn_*`     概念板块（融资融券 / 参股金融 / 创新药 …）
 *     fenlei=2 → `hangye_*` 行业板块（医药制造业 / 计算机应用服务业 …）
 *     fenlei=3 → `hs300` 等**指数**，**不是地域板块**
 * ⇒ **地域暂无新浪映射**：宁可不给，也不能把"指数"当"地域"显示
 *   （口径标错比缺数据更糟 —— 数字看着正常、含义却是错的，没人会去怀疑它）。
 */
const SINA_FENLEI = { concept: 1, industry: 2 };

/**
 * 取板块行，**归一化成东财形状**：
 *   f12 代码 · f14 名称 · f3 涨跌幅 · f62 主力净流入 · f128 领涨股 · f136 领涨股涨幅
 * 这样 getFlow/getCards 里的映射代码**一行都不用改** —— 换源风险最小化。
 * （数值口径也一并对齐：新浪的 changeratio 是小数，须 ×100 才是百分点。）
 */
async function fetchBoardRows(type, limit) {
  // ① 新浪（主）—— **仅当该类型有实测确认过的 fenlei 映射**时才用
  try {
    const fenlei = SINA_FENLEI[type];
    if (!fenlei) throw new Error(`新浪无「${type}」类型的确认映射，跳过`);
    const res = await axios.get(
      `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk?page=1&num=${limit}&sort=netamount&asc=0&fenlei=${fenlei}`,
      { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' }, timeout: UPSTREAM_TIMEOUT_MS },
    );
    const arr = Array.isArray(res.data) ? res.data : [];
    const rows = arr.map((d) => ({
      f12: d.category ?? '',
      f14: d.name ?? '',
      f3: Number.isFinite(Number(d.avg_changeratio)) ? Number(d.avg_changeratio) * 100 : null,
      f62: Number.isFinite(Number(d.netamount)) ? Number(d.netamount) : null, // 主力净流入（元）
      f128: d.ts_name ?? '',
      f136: Number.isFinite(Number(d.ts_changeratio)) ? Number(d.ts_changeratio) * 100 : null,
    }));
    if (rows.length) {
      lastBoardSource = 'sina';
      return rows;
    }
  } catch (e) {
    console.warn('[Sectors] 新浪板块源失败，回落腾讯:', e.message);
  }
  // ② 腾讯（备；无资金流 ⇒ f62 置 null，前端会显式标注"资金流暂不可用"）
  //    ⚠️ 腾讯该接口给出的是**行业口径**的板块（申万式"电视广播Ⅱ/教育"），
  //    故**不能**用它兜底「地域板块」—— 那会把行业数据标成地域（静默口径错）。
  if (type === 'region') {
    throw new Error('地域板块：现有两个数据源均无确认映射，宁缺毋滥（不拿行业数据冒充）');
  }
  const res2 = await axios.get(
    `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank?l=${Math.max(limit, 20)}&p=1&t=01/averatio&o=0`,
    { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }, timeout: UPSTREAM_TIMEOUT_MS },
  );
  const list = res2.data?.data ?? [];
  const rows2 = list.map((d) => ({
    f12: d.bd_code ?? '',
    f14: d.bd_name ?? '',
    f3: Number.isFinite(Number(d.bd_zdf)) ? Number(d.bd_zdf) : null,
    f62: null,
    f128: d.nzg_name ?? '',
    f136: Number.isFinite(Number(d.nzg_zdf)) ? Number(d.nzg_zdf) : null,
  }));
  if (rows2.length) lastBoardSource = 'tencent';
  return rows2;
}

/** 板块主力净流入排行（按主力净流入降序） */
function getFlow(type = 'industry') {
  const fs_ = TYPE_MAP[type] ?? TYPE_MAP.industry;
  return cached(`flow:${fs_}`, 30_000, async () => {
    const diff = await fetchBoardRows(type, 100);
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
    const diff = await fetchBoardRows(type, limit);
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
    // 分时 sparkline 只有东财提供；换源后不再发起（省掉一次必然失败的上游调用，spark 置 null）
    if (lastBoardSource !== 'eastmoney') {
      return { typeName: TYPE_NAME[type] ?? type, updatedAt: new Date().toISOString(), cards: rows };
    }
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
