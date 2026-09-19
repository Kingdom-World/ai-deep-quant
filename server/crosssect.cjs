// ─────────────────────────────────────────────────────────────
// 多标的横截面回测引擎（评审 P2-5）：消费 Baostock 本地归档
//   · 流程：每个调仓日，按动量因子对全池排名（T 日收盘），T+1 开盘等权调入调出
//   · 口径与单标的回测一致：fees.cjs 分项费率 + 100 股整手 + 滑点（默认 0.1%）
//   · 已知简化（诚实声明）：
//     - 已持有且仍在目标内的标的不再调平衡（减少换手）
//     - 等权目标值按上一交易日净值计算
//     - 期末按最后收盘价强平（计价惯例，不加滑点）
//   · 数据：data/history/kline/*.json（不复权价 + 复权因子 factors），ENV LOCAL_HISTORY_DIR 可覆盖（测试）
//
//   ── 价格口径（2026-09-14 修正 · S5）────────────────────────────────
//   · **动量、成交、估值三者统一使用【归一化前复权价】**：
//       adj(t) = raw(t) × fore(t) / fore(该股票首行日期)
//     为何必须统一：除权（如 10 送 10）会让不复权价腰斩。若只用复权价算动量、却用不复权价估值，
//     持仓市值会在除权日「假腰斩」——那是账本本身出错，不只是信号出错。
//     为何要归一化：原始 fore 以「最新交易日」为 1，会随每日同步整体重算；
//     除以首行因子后基准固定，既不随最新日滚动，又与原始价同量级（整手/资金约束才有意义）。
//   · 因子字段用 fore 而非 back：实测 3 标的 × 2842 交易日，fore 平均偏差全部为 0.0000；
//     back 在 sz000001 2020-12-31 有 16.94 的致命异常（back 由 119.96 骤降至 99.79，而 fore 不变、当日亦无除权）。
//   · 因子应用规则：取「最后一个 date ≤ t 的因子」——实测该规则偏差 0.0000，而「date < t」为 0.0571。
//   · 涨跌停守卫用【不复权真实价】：交易所规则按真实价计算，且 limitPrices 的「四舍五入到分」只对真实价有意义。
//     实现复用 paper/matcher.cjs 的 limitPrices（单一实现，禁止另写）。
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { calcFees, marketOf } = require('./paper/fees.cjs');
const { limitPrices } = require('./paper/matcher.cjs');

//   因子族：
//     mom*  动量——买过去 N 日涨幅**最大**的（追涨）
//     rev*  反转——买过去 N 日跌幅**最大**的（抄底）
//   提供反转口径是为了能在同一引擎内对照「A 股短期到底是动量有效还是反转有效」，
//   而不是只凭一个方向的失败就断定因子族不可用。
const FACTOR_WINDOWS = { mom20: 20, mom60: 60, mom120: 120, rev20: 20, rev60: 60, rev120: 120 };
const REVERSAL_FACTORS = new Set(['rev20', 'rev60', 'rev120']);

/**
 * 为每行预计算【归一化前复权】的开盘/收盘价（动量、成交与估值共用同一口径）
 *   规则：factorAt = 最后一个 date ≤ t 的因子（实测口径，见文件头「价格口径」）
 *   归一化：ratio = fore(t) / fore(该股票首行日期)
 *     —— 使复权价与原始价同量级（整手/资金约束才有意义），
 *        且不随「最新交易日」滚动（原始 fore 以最新日为 1，会随时间整体重算）。
 *   字段：用 fore 而非 back —— back 在 sz000001 2020-12-31 有 16.94 的致命异常。
 *   复杂度：O(n + m) 游标推进，不做逐行全量查找（守热路径铁律）。
 */
function withAdjustedPrices(rows, factors) {
  const list = Array.isArray(factors)
    ? [...factors].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    : [];
  const foreAt = (date) => {
    let f = null;
    for (const it of list) if (it.date <= date) f = it;
    return f;
  };
  const first = rows.length ? foreAt(rows[0].date) : null;
  const base = first && Number.isFinite(first.fore) && first.fore > 0 ? first.fore : null;

  let k = 0;
  let cur = null;
  for (const r of rows) {
    while (k < list.length && list[k].date <= r.date) {
      cur = list[k];
      k += 1;
    }
    if (cur && Number.isFinite(cur.fore) && cur.fore > 0) {
      const ratio = base ? cur.fore / base : cur.fore;
      r.adjClose = +(r.close * ratio).toFixed(6);
      r.adjOpen = +(r.open * ratio).toFixed(6);
    } else {
      r.adjClose = r.close;
      r.adjOpen = r.open;
      r.adjFallback = true;
    }
  }
  return rows;
}

function loadUniverse(dir, minRows) {
  const universe = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return universe;
  }
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const rows = (doc.rows || []).filter(
        (r) => r.date && Number.isFinite(r.close) && Number.isFinite(r.open) && r.close > 0 && r.open > 0,
      );
      if (rows.length >= minRows) {
        universe.set(doc.code || f.replace('.json', ''), withAdjustedPrices(rows, doc.factors));
      }
    } catch { /* 坏文件跳过 */ }
  }
  return universe;
}

// ── 归档内存缓存（S3 · 因子评估的性能前提）──
//   多因子 × 多年份评估需连续调用 runCrossBacktest 数十次，
//   若每次重读 209 个 JSON（约 41MB），接口会慢到不可用（实测单次约 1.15s，72 次即 80s+）。
//   归档由计划任务每日 06:00 同步一次，故进程内缓存是安全的；
//   10 分钟 TTL 兜底，另可用 env CROSSSECT_RELOAD=1 强制重载。
const CACHE_TTL_MS = 10 * 60 * 1000;
let _universeCache = null; // { dir, at, universe }

function loadUniverseCached(dir, minRows) {
  const now = Date.now();
  if (
    _universeCache &&
    _universeCache.dir === dir &&
    now - _universeCache.at < CACHE_TTL_MS &&
    process.env.CROSSSECT_RELOAD !== '1'
  ) {
    return _universeCache.universe;
  }
  const universe = loadUniverse(dir, minRows);
  _universeCache = { dir, at: now, universe };
  return universe;
}

function stdMetrics(equity, capital, bars) {
  const finalValue = equity.length ? equity[equity.length - 1].value : capital;
  const totalReturn = (finalValue / capital - 1) * 100;
  const years = Math.max(bars / 252, 0.25);
  const annualized = (Math.pow(Math.max(finalValue / capital, 1e-9), 1 / years) - 1) * 100;
  const rets = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i].value / equity[i - 1].value - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const std = rets.length ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) : 0;
  const annualVol = std * Math.sqrt(252) * 100;
  const sharpe = annualVol > 0 ? +((annualized - 2) / annualVol).toFixed(2) : null;
  let peak = capital;
  let maxDD = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.value);
    maxDD = Math.max(maxDD, (peak - e.value) / peak);
  }
  return { finalValue: +finalValue.toFixed(2), totalReturn: +totalReturn.toFixed(2), annualized: +annualized.toFixed(2), maxDrawdownPct: +(maxDD * 100).toFixed(2), sharpe };
}

/**
 * 横截面回测
 * @param opts { factor='mom20', topN=5, rebalanceEvery=20, capital=1000000, slippage=0.001 }
 */
function runCrossBacktest(opts = {}) {
  const dirAbs = process.env.LOCAL_HISTORY_DIR || path.join(__dirname, '..', 'data', 'history', 'kline');
  const universe = loadUniverseCached(dirAbs, 80);
  if (universe.size < 2) {
    return { error: `本地归档不足（${universe.size} 只，至少 2 只）——先运行 Baostock 同步：python scripts/sync_baostock.py` };
  }
  const factor = FACTOR_WINDOWS[opts.factor] ? opts.factor : 'mom20';
  const factorWin = FACTOR_WINDOWS[factor];
  const topN = Math.max(1, Math.min(Number(opts.topN) || 5, 20));
  const rebalanceEvery = Math.max(1, Math.min(Number(opts.rebalanceEvery) || 20, 250));
  const capital = Math.max(Number(opts.capital) || 1_000_000, 10_000);
  const slippage = Math.min(Math.max(Number(opts.slippage ?? 0.001), 0), 0.05);

  // 统一交易日轴（归档日期并集，升序）与 per-stock 日期索引
  const dateSet = new Set();
  for (const rows of universe.values()) for (const r of rows) dateSet.add(r.date);
  // 可选区间裁剪（样本外验证用）：归档日期为 YYYY-MM-DD，字典序即时序
  const allDates = [...dateSet].sort();
  const dates =
    opts.startDate || opts.endDate
      ? allDates.filter(
          (d) => (!opts.startDate || d >= opts.startDate) && (!opts.endDate || d <= opts.endDate),
        )
      : allDates;
  if (dates.length < factorWin + 2) {
    return {
      error: `区间内交易日不足（${dates.length} 天，至少需 ${factorWin + 2} 天）——请放宽 startDate / endDate`,
    };
  }
  const rowIndex = new Map();
  for (const [code, rows] of universe) {
    const m = new Map();
    rows.forEach((r, i) => m.set(r.date, i));
    rowIndex.set(code, m);
  }
  /** 取价：adj=true 取归一化前复权价（动量/成交/估值共用）；adj=false 取不复权真实价（涨跌停判定） */
  const priceAt = (code, date, key, adj = false) => {
    const i = rowIndex.get(code)?.get(date);
    if (i === undefined) return null;
    const row = universe.get(code)[i];
    const field = adj ? (key === 'close' ? 'adjClose' : key === 'open' ? 'adjOpen' : key) : key;
    const v = row[field];
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  // ── 等权买入持有基准 ──
  //   用途：横截面策略是在池内「选 topN」，必须有「不选股、全池等权持有」的对照才有解释力。
  //        否则 −78% 这样的数字无从判断是策略差、还是整个池子这段时间都差。
  //   口径：起点与策略同区间（dates[factorWin+1]），价格同用归一化前复权价。
  //   停牌/无数据日以前一可得复权价代入，避免权重漂移。
  const startDate = dates[factorWin + 1];
  const benchState = new Map(); // code → { base, last }
  for (const [code, rows] of universe) {
    const bi = rowIndex.get(code)?.get(startDate);
    if (bi === undefined) continue;
    const bp = rows[bi].adjClose;
    if (Number.isFinite(bp) && bp > 0) benchState.set(code, { base: bp, last: bp });
  }
  const benchmark = [];

  let cash = capital;
  const holdings = new Map(); // code → {qty, avgCost}
  const equity = [];
  let totalFees = 0;
  let turnover = 0;
  let fills = 0;
  let rebalances = 0;
  let peak = capital;
  let maxDD = 0;
  let blockedLimitUp = 0; // 开盘涨停无法买入的次数
  let blockedLimitDown = 0; // 开盘跌停无法卖出的次数
  let adjFallbackCodes = 0; // 无复权因子覆盖的标的数（动量退化为不复权口径）
  for (const rows of universe.values()) if (rows.some((r) => r.adjFallback)) adjFallbackCodes += 1;

  for (let di = factorWin + 1; di < dates.length; di++) {
    const date = dates[di];

    if ((di - factorWin - 1) % rebalanceEvery === 0) {
      rebalances += 1;
      // 因子排名：T-1 日收盘（无前视），T 日开盘执行
      const cands = [];
      const prevDate = dates[di - 1];
      for (const [code, rows] of universe) {
        const i = rowIndex.get(code).get(prevDate);
        if (i === undefined || i < factorWin) continue;
        // 动量用【前复权收盘价】：不复权价在除权日会出现假跳空（见文件头「价格口径」）
        const c0 = rows[i - factorWin].adjClose;
        const c1 = rows[i].adjClose;
        if (c0 > 0) cands.push({ code, mom: c1 / c0 - 1 });
      }
      // 动量买最强（降序）；反转买最弱（升序）
      cands.sort((a, b) => (REVERSAL_FACTORS.has(factor) ? a.mom - b.mom : b.mom - a.mom));
      const target = cands.slice(0, topN).map((c) => c.code);
      const targetSet = new Set(target);

      // 1) 调出：卖出不在目标内的持仓（T 日开盘 ×(1−滑点)）
      //    涨跌停守卫复用 matcher.limitPrices（单一实现，禁止另写）；触板不做假成交
      const prevCloseOf = (code) => priceAt(code, prevDate, 'close');
      for (const code of [...holdings.keys()]) {
        if (targetSet.has(code)) continue;
        const rawOpen = priceAt(code, date, 'open'); // 涨跌停判定用不复权真实价（交易所规则；分位舍入仅对真实价有意义）
        if (rawOpen === null) continue;
        if (marketOf(code) === 'CN') {
          const lp = limitPrices(code, null, prevCloseOf(code));
          if (lp && rawOpen <= lp.lower) {
            blockedLimitDown += 1; // 开盘跌停卖不出，持仓保留至下一调仓日
            continue;
          }
        }
        const px = priceAt(code, date, 'open', true); // 成交价用复权口径（与估值同源）
        if (px === null) continue;
        const h = holdings.get(code);
        const value = h.qty * px;
        const fee = calcFees('CN', 'sell', value).total;
        cash += value - fee;
        totalFees += fee;
        turnover += value;
        fills += 1;
        holdings.delete(code);
      }

      // 2) 调入：等权买入空缺（目标值 = 上一交易日净值 / topN）
      const baseEquity = equity.length ? equity[equity.length - 1].value : capital;
      const perName = baseEquity / Math.max(1, target.length); // target 是数组（.size 是 undefined 的经典笔误）
      for (const code of target) {
        if (holdings.has(code)) continue; // 已持有的不调平衡（简化，减少换手）
        const rawOpen = priceAt(code, date, 'open'); // 涨跌停判定用不复权真实价
        if (rawOpen === null) continue;
        if (marketOf(code) === 'CN') {
          const lp = limitPrices(code, null, prevCloseOf(code));
          if (lp && rawOpen >= lp.upper) {
            blockedLimitUp += 1; // 开盘涨停买不进，本次跳过
            continue;
          }
        }
        const px = priceAt(code, date, 'open', true); // 成交价用复权口径（与估值同源）
        if (px === null) continue;
        let qty = Math.floor(perName / (px * 100)) * 100;
        while (qty > 0) {
          const cost = qty * px * (1 + slippage) + calcFees('CN', 'buy', qty * px * (1 + slippage)).total;
          if (cash >= cost) break;
          qty -= 100;
        }
        if (qty <= 0) continue;
        const execPx = +(px * (1 + slippage)).toFixed(4);
        const value = qty * execPx;
        const fee = calcFees('CN', 'buy', value).total;
        cash = +(cash - value - fee).toFixed(2);
        totalFees += fee;
        turnover += value;
        fills += 1;
        holdings.set(code, { qty, avgCost: execPx });
      }
    }

    // 逐日估值
    let mv = 0;
    for (const [code, h] of holdings) {
      const px = priceAt(code, date, 'close', true); // 估值用复权价，避免除权日持仓市值「假腰斩」
      mv += h.qty * (px === null ? h.avgCost : px);
    }
    const total = +(cash + mv).toFixed(2);
    equity.push({ date, value: total });
    peak = Math.max(peak, total);
    maxDD = Math.max(maxDD, (peak - total) / peak);

    // 等权基准逐日估值（停牌日以前一可得复权价代入）
    let bSum = 0;
    let bCnt = 0;
    for (const [code, st] of benchState) {
      const bi = rowIndex.get(code)?.get(date);
      if (bi !== undefined) {
        const bp = universe.get(code)[bi].adjClose;
        if (Number.isFinite(bp) && bp > 0) st.last = bp;
      }
      if (st.last > 0) {
        bSum += st.last / st.base;
        bCnt += 1;
      }
    }
    benchmark.push({ date, value: bCnt ? +(capital * (bSum / bCnt)).toFixed(2) : capital });
  }

  // 期末强平（最后收盘价，计价惯例不加滑点）
  const lastDate = dates[dates.length - 1];
  for (const [code, h] of holdings) {
    const px = priceAt(code, lastDate, 'close', true);
    if (px === null) continue;
    const v = h.qty * px;
    const fee = calcFees('CN', 'sell', v).total;
    cash += v - fee;
    totalFees += fee;
    turnover += v;
  }
  const finalEquity = [...equity, { date: lastDate, value: +cash.toFixed(2) }];

  return {
    engine: 'crosssect',
    factor,
    factorWindow: factorWin,
    topN,
    rebalanceEvery,
    universeSize: universe.size,
    capital,
    slippage,
    range: { start: startDate, end: lastDate, bars: equity.length },
    rebalances,
    fills,
    blockedLimitUp,
    blockedLimitDown,
    // 口径自述（诚实标注，便于核查与复现）
    priceBasis: {
      momentum: 'qfq(fore)', // 动量：归一化前复权收盘价
      execution: 'qfq(fore)', // 成交与估值：同口径（三者统一后账本才自洽）
      limitGuard: 'raw', // 涨跌停判定：不复权真实价（交易所规则）
      universeWithAdjFallback: adjFallbackCodes, // 含无因子覆盖行的标的数（动量在这些行退化为不复权）
      stLimitNote: '归档未含股票名，ST 股 5% 限幅无法识别，守卫按 10% 判定（偏松）',
    },
    totalFees: +totalFees.toFixed(2),
    turnover: +turnover.toFixed(2),
    feeRatePct: turnover > 0 ? +((totalFees / turnover) * 100).toFixed(3) : 0,
    ...stdMetrics(finalEquity, capital, equity.length),
    // 等权买入持有基准（全池、同区间、同复权口径）：用于判断策略是否跑赢「什么都不选」
    benchmarkReturn: benchmark.length
      ? +((benchmark[benchmark.length - 1].value / capital - 1) * 100).toFixed(2)
      : null,
    benchmarkUniverse: benchState.size,
    benchmark: benchmark.filter((_, i) => i % 5 === 0 || i === benchmark.length - 1),
    equity: finalEquity.filter((_, i) => i % 5 === 0 || i === finalEquity.length - 1), // 抽稀返回
  };
}

module.exports = { runCrossBacktest, FACTOR_WINDOWS, REVERSAL_FACTORS };
