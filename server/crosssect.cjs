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
const { spearman, summarizeIC } = require('./statstest.cjs');

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

/** 取价：adj=true 取归一化前复权价（动量/成交/估值共用）；adj=false 取不复权真实价（涨跌停判定） */
function makePriceAt(universe, rowIndex) {
  return (code, date, key, adj = false) => {
    const i = rowIndex.get(code)?.get(date);
    if (i === undefined) return null;
    const row = universe.get(code)[i];
    const field = adj ? (key === 'close' ? 'adjClose' : key === 'open' ? 'adjOpen' : key) : key;
    const v = row[field];
    return Number.isFinite(v) && v > 0 ? v : null;
  };
}

/**
 * 构建横截面公共上下文：交易日轴、日期索引、取价器、区间端点。
 * 抽出原因：分层回测（layerAnalysis）与净值回测（runCrossBacktest）必须共享**完全同一套**
 * 日期轴与取价口径，否则两者给出的「因子有效性」结论不可比——这正是 method-single-source 要防的口径分裂。
 */
function buildContext(universe, factorWin, opts = {}) {
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
  return {
    dates,
    rowIndex,
    priceAt: makePriceAt(universe, rowIndex),
    startDate: dates[factorWin + 1],
    lastDate: dates[dates.length - 1],
  };
}

/**
 * 单期因子截面：对 prevDate 计算动量，返回 [{ code, mom }]（未排序）。
 * 动量口径 = adjClose(prevDate) / adjClose(prevDate − factorWin) − 1（前复权，避免除权假跳空）。
 */
function factorCrossSection(universe, rowIndex, prevDate, factorWin) {
  const out = [];
  for (const [code, rows] of universe) {
    const i = rowIndex.get(code)?.get(prevDate);
    if (i === undefined || i < factorWin) continue;
    const c0 = rows[i - factorWin].adjClose;
    const c1 = rows[i].adjClose;
    if (Number.isFinite(c0) && Number.isFinite(c1) && c0 > 0 && c1 > 0) {
      out.push({ code, mom: c1 / c0 - 1 });
    }
  }
  return out;
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

  const ctx = buildContext(universe, factorWin, opts);
  if (ctx.error) return ctx;
  const { dates, rowIndex, priceAt, startDate, lastDate } = ctx;

  // ── IC 序列（Rank IC，逐调仓期）──
  //   定义：每个调仓期，对 T-1 日因子暴露与「T-1 → 下一调仓期 T-1」的复权收益求 Spearman 秩相关。
  //   为何用 Rank IC 而非 Pearson：动量因子存在极端值（连续涨停股），秩相关更稳健；
  //     且 Grinold & Kahn 的因子有效性框架默认以 IC 序列的均值与波动衡量。
  //   为何复用 statstest.spearman 而不自写：它是单一实现（含并列取平均秩），另写即口径分裂。
  const icSeries = []; // [{ date, ic, n }]
  const rebalIdx = [];
  for (let di = factorWin + 1; di < dates.length; di += rebalanceEvery) rebalIdx.push(di);
  for (let ri = 0; ri + 1 < rebalIdx.length; ri++) {
    const prevDate = dates[rebalIdx[ri] - 1];
    const nextDate = dates[rebalIdx[ri + 1] - 1];
    const xs = [];
    const ys = [];
    for (const c of factorCrossSection(universe, rowIndex, prevDate, factorWin)) {
      const p0 = priceAt(c.code, prevDate, 'close', true);
      const p1 = priceAt(c.code, nextDate, 'close', true);
      if (p0 === null || p1 === null) continue;
      xs.push(c.mom);
      ys.push(p1 / p0 - 1);
    }
    if (xs.length < 5) continue; // 截面样本过少，IC 无统计意义
    const r = spearman(xs, ys);
    if (Number.isFinite(r)) icSeries.push({ date: dates[rebalIdx[ri]], ic: +r.toFixed(6), n: xs.length });
  }
  const icSummary = summarizeIC(icSeries.map((x) => x.ic));

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
      const prevDate = dates[di - 1];
      // 动量用【前复权收盘价】：不复权价在除权日会出现假跳空（见文件头「价格口径」）
      const cands = factorCrossSection(universe, rowIndex, prevDate, factorWin);
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
    // ── 因子有效性（Rank IC 序列 + Newey-West 显著性）──
    //   说明：IC 衡量「因子排序」与「下期收益排序」的一致性，与上面的净值表现互为印证。
    //        净值好但 IC 不显著 = 收益可能来自少数标的的运气；IC 显著但净值差 = 执行/成本拖累。
    //   显著性用 Newey-West（HAC）而非普通 t 检验：IC 序列存在自相关（因子暴露有持续性），
    //        普通 t 检验会高估显著性。statstest 已按 L=floor(4(T/100)^(2/9)) 自动选滞后阶。
    ic: {
      series: icSeries,
      ...icSummary,
      factor,
      factorWindow: factorWin,
      basis: 'Rank IC（Spearman），T-1 因子暴露 vs 下一调仓期收益；口径与 statstest.spearman 同源',
    },
  };
}

/**
 * 分层回测（5 分层）：检验因子单调性——把全池按因子排序等分为 5 层，
 * 逐层计算等权持有收益，观察「第 1 层 → 第 5 层」是否单调。
 *
 * 为什么需要它：单看 topN 组合的净值无法区分「因子有效」与「因子只在极值端有效」。
 *   分层能看出有效性是贯穿全截面，还是只集中在头部/尾部（后者往往是数据噪声或市值效应）。
 *
 * 口径（与 runCrossBacktest 严格同源，便于交叉核对）：
 *   · 因子暴露取 T-1 收盘（前复权归一化），分层后 T 开盘等权买入，持有到下一调仓期 T-1 收盘
 *   · **不计手续费与滑点**——本函数度量的是「因子的原始预测力」，成本影响应在净值回测里体现；
 *     若此处也扣成本，会让因子本身的强弱被成本口径掩盖（两者目的不同，故口径有意分离）。
 *   · 层号约定：layer 1 = 因子值**最高**（动量口径的「最强」），layer 5 = 最低。
 *     这样 mom* 因子下 layer1 应跑赢 layer5；rev* 用同一约定则相反，便于统一阅读。
 *
 * @param opts { factor='mom20', layers=5, rebalanceEvery=20, startDate, endDate }
 */
function layerAnalysis(opts = {}) {
  const dirAbs = process.env.LOCAL_HISTORY_DIR || path.join(__dirname, '..', 'data', 'history', 'kline');
  const universe = loadUniverseCached(dirAbs, 80);
  if (universe.size < 2) {
    return { error: `本地归档不足（${universe.size} 只，至少 2 只）——先运行 Baostock 同步：python scripts/sync_baostock.py` };
  }
  const factor = FACTOR_WINDOWS[opts.factor] ? opts.factor : 'mom20';
  const factorWin = FACTOR_WINDOWS[factor];
  const layers = Math.max(2, Math.min(Number(opts.layers) || 5, 10));
  const rebalanceEvery = Math.max(1, Math.min(Number(opts.rebalanceEvery) || 20, 250));
  const isRev = REVERSAL_FACTORS.has(factor);

  const ctx = buildContext(universe, factorWin, opts);
  if (ctx.error) return ctx;
  const { dates, rowIndex, priceAt, startDate, lastDate } = ctx;

  // 每层累积「乘法收益链」（等价于每期等权再平衡的几何链接）
  const chain = Array.from({ length: layers }, () => 1);
  const layerPeriodRets = Array.from({ length: layers }, () => []);
  const rebalIdx = [];
  for (let di = factorWin + 1; di < dates.length; di += rebalanceEvery) rebalIdx.push(di);

  let periods = 0;
  const monoSeries = []; // 每期的「层号 rank vs 层收益 rank」样本，用于整体单调性
  for (let ri = 0; ri + 1 < rebalIdx.length; ri++) {
    const prevDate = dates[rebalIdx[ri] - 1];
    const nextDate = dates[rebalIdx[ri + 1] - 1];
    const cs = factorCrossSection(universe, rowIndex, prevDate, factorWin);
    if (cs.length < layers) continue;
    // 统一按动量**降序**（最强在前）——与 runCrossBacktest 的反转分支相反，
    // 但层号语义固定为「1=最强」；反转因子的单调性会自然呈现为反向，这是要观察的信息本身。
    cs.sort((a, b) => b.mom - a.mom);
    const size = Math.floor(cs.length / layers);
    if (size < 1) continue;

    const periodRets = [];
    for (let L = 0; L < layers; L++) {
      const from = L * size;
      const to = L === layers - 1 ? cs.length : (L + 1) * size; // 余数并入最后一层
      let sum = 0;
      let cnt = 0;
      for (let k = from; k < to; k++) {
        const p0 = priceAt(cs[k].code, prevDate, 'close', true);
        const p1 = priceAt(cs[k].code, nextDate, 'close', true);
        if (p0 === null || p1 === null) continue;
        sum += p1 / p0 - 1;
        cnt += 1;
      }
      const r = cnt ? sum / cnt : 0; // 等权
      periodRets.push(r);
      chain[L] *= 1 + r;
      layerPeriodRets[L].push(r);
    }
    periods += 1;
    monoSeries.push({ layers: periodRets.map((_, i) => i + 1), rets: periodRets });
  }

  if (!periods) {
    return { error: `区间内无有效调仓期（交易日 ${dates.length} 天，调仓间隔 ${rebalanceEvery}）` };
  }

  const years = Math.max((periods * rebalanceEvery) / 252, 0.25);
  const result = [];
  for (let L = 0; L < layers; L++) {
    const totalRet = chain[L] - 1;
    const annualized = (Math.pow(Math.max(chain[L], 1e-9), 1 / years) - 1) * 100;
    const rs = layerPeriodRets[L];
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    // 用样本方差（n−1）而非总体方差：与 statstest.seIid 的无偏口径一致（口径单一来源）
    const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1)) : 0;
    result.push({
      layer: L + 1,
      label: L === 0 ? `第1层（因子值最高）` : L === layers - 1 ? `第${layers}层（因子值最低）` : `第${L + 1}层`,
      totalReturnPct: +(totalRet * 100).toFixed(2),
      annualizedPct: +annualized.toFixed(2),
      // 期均收益与波动（去量纲，便于跨期数比较）
      meanPeriodRetPct: +(mean * 100).toFixed(4),
      stdPeriodRetPct: +(sd * 100).toFixed(4),
      periods: rs.length,
    });
  }

  // 单调性：各层收益（期均）与层号的 Spearman —— 完全单调时 |ρ| = 1
  const layerNos = result.map((r) => r.layer);
  const layerRets = result.map((r) => r.meanPeriodRetPct);
  const rho = spearman(layerNos, layerRets);
  // 单调方向：rho<0 表示层号越大收益越低 —— 「因子最强层」跑赢「因子最弱层」
  const monotonic = Number.isFinite(rho) && Math.abs(rho) >= 0.9;
  const longShortSpread = +(result[0].meanPeriodRetPct - result[layers - 1].meanPeriodRetPct).toFixed(4);
  // 因子方向与策略方向是否一致：
  //   mom* 策略买「最强」，期望强层收益高（rho<0 才对）
  //   rev* 策略买「最弱」，期望弱层收益高（rho>0 才对）
  //   两层含义必须分开说，否则 rev* 时会给出与策略相反的误导性结论。
  const strongWins = Number.isFinite(rho) && rho < 0;
  const alignedWithStrategy = Number.isFinite(rho) && (isRev ? rho > 0 : rho < 0);

  return {
    engine: 'crosssect-layer',
    factor,
    factorWindow: factorWin,
    isReversal: isRev,
    layers,
    rebalanceEvery,
    range: { start: startDate, end: lastDate, bars: dates.length, periods },
    universeSize: universe.size,
    layerBasis: '不计费不计滑点（度量因子原始预测力）；层内等权，每调仓期再平衡',
    note: '层号 1 = 因子值最高。层号固定不变，故 mom* 与 rev* 的 strat 方向相反：mom* 买第1层，rev* 买第N层。',
    layers: result,
    mono: {
      spearman: Number.isFinite(rho) ? +rho.toFixed(6) : null,
      monotonic,
      threshold: 0.9,
      // 因子层面的描述（与策略无关）
      factorDirection: Number.isFinite(rho)
        ? (strongWins ? '因子值越高、下期收益越高' : '因子值越高、下期收益越低')
        : null,
      // 策略层面的描述（取决于当前 factor 是动量还是反转）
      strategyAligned: alignedWithStrategy,
      strategyNote: Number.isFinite(rho)
        ? (alignedWithStrategy
            ? `因子方向与 ${factor} 策略方向一致（${isRev ? '买最弱层' : '买最强层'}），该因子在本次样本中对策略是有利的`
            : `因子方向与 ${factor} 策略方向**相反**（${isRev ? '买最弱层' : '买最强层'}），继续按此方向选股将系统性亏损`)
        : null,
      longShortSpreadPct: longShortSpread, // 第1层 − 第N层（期均收益差）
      interpretation: monotonic
        ? '分层收益呈单调分布，因子在全截面有效'
        : '分层收益非单调，因子有效性可能集中在极值端或为噪声',
    },
  };
}

module.exports = { runCrossBacktest, layerAnalysis, FACTOR_WINDOWS, REVERSAL_FACTORS };
