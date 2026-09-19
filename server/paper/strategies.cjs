// ─────────────────────────────────────────────────────────────
// 模拟盘策略引擎（每小时评估一次 + 启动后首个周期立即评估）
//   · maCross     双均线：快线>慢线 持有，反之清仓
//   · rsiReversal RSI 反转：超卖区上穿买入，超买区下穿卖出
//   · gridTrading 网格：价格每跌一个网格档买入 gridQty，涨一档卖出
//   · 交易时段闸门：非交易时段不评估（PAPER_TRADE_247=1 可强制 247 测试）
//   · 策略状态持久化 data/paper/strategies.json（重启不丢）
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const broker = require('./broker.cjs');
const { marketOf } = require('./fees.cjs');

const STRAT_FILE = path.join(__dirname, '..', '..', 'data', 'paper', 'strategies.json');
const EVAL_INTERVAL_MS = Math.max(Number(process.env.PAPER_EVAL_INTERVAL_MS) || 3_600_000, 60_000);

let strategies = [];
let deps = {}; // { getQuote, fetchDailyRows }

function load() {
  fs.mkdirSync(path.dirname(STRAT_FILE), { recursive: true });
  if (fs.existsSync(STRAT_FILE)) {
    try {
      strategies = JSON.parse(fs.readFileSync(STRAT_FILE, 'utf8'));
    } catch (e) {
      console.error('[Strategies] 策略文件解析失败，从空开始:', e.message);
      strategies = [];
    }
  }
}
function save() {
  try {
    const tmp = `${STRAT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(strategies), 'utf8');
    fs.renameSync(tmp, STRAT_FILE);
  } catch (e) {
    console.error('[Strategies] 持久化失败:', e.message);
  }
}

function init({ getQuote, fetchDailyRows }) {
  deps = { getQuote, fetchDailyRows };
  load();
}

// ── 指标 ──
const { wilderRsiLast } = require('../../shared/rsi.mjs');

function smaLast(closes, n) {
  if (closes.length < n) return null;
  const s = closes.slice(-n).reduce((a, b) => a + b, 0);
  return s / n;
}
/**
 * RSI —— 口径统一为 **Wilder 标准**（唯一实现见 shared/rsi.mjs）
 *   历史：此处原为本地「简单均值」实现，注释还写着"与回测口径一致"——
 *   但回测已是 Wilder（S6 起），该注释当时已成假话。现改为直接引用唯一实现源，
 *   使「模拟盘策略」与「回测」真正同口径。
 */
const rsi = wilderRsiLast;

// ── 交易时段（北京时间近似；PAPER_TRADE_247=1 跳过；CN 含法定节假日判断） ──
const { isCnHoliday } = require('../calendar.cjs');
function isMarketOpen(symbol) {
  if (process.env.PAPER_TRADE_247 === '1') return true;
  const bj = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60_000);
  const day = bj.getDay();
  const mins = bj.getHours() * 60 + bj.getMinutes();
  const m = marketOf(symbol);
  if (day === 0 || day === 6) return false;
  if (m === 'CN') return !isCnHoliday() && mins >= 555 && mins <= 905; // 09:15–15:05，法定节假日休市
  if (m === 'HK') return mins >= 555 && mins <= 970; // 09:15–16:10
  return (mins >= 1285 && mins <= 1440) || mins <= 245; // 美股约 21:25–04:05 北京时间
}

// ── combo：用户自定义条件组合（MA 状态 × RSI 温度）——评审 R2 ──
//   买入：MA 多头（maFast > maSlow）且 RSI 未过热（rsi < rsiSellAbove）；
//         requireBoth=1 时额外要求 RSI < rsiBuyBelow（回调低吸模式）。
//   卖出：MA 破位（maFast < maSlow）或 RSI 过热（rsi > rsiSellAbove）。
//   语义刻意保持"一句话可解释"——学习者的第一个自定义策略应能讲清楚每个条件。
async function evalCombo(st, price, klines) {
  const maFast = Math.max(Number(st.params.maFast) || 5, 2);
  const maSlow = Math.max(Number(st.params.maSlow) || 20, maFast + 1);
  const rsiPeriod = Math.max(Number(st.params.rsiPeriod) || 14, 2);
  const rsiSellAbove = Number(st.params.rsiSellAbove) || 70;
  const rsiBuyBelow = Number(st.params.rsiBuyBelow) || 45;
  const requireBoth = Number(st.params.requireBoth) === 1;
  const closes = klines.map((k) => k.close);
  const f = smaLast(closes, maFast);
  const s = smaLast(closes, maSlow);
  const r = rsi(closes, rsiPeriod);
  if (!f || !s || r === null) {
    st.lastSignal = '指标数据不足，跳过';
    return;
  }
  const bull = f > s;
  const overheat = r > rsiSellAbove;
  const pos = broker.store.state.positions[st.uid]?.find((p) => p.symbol === st.symbol);
  const canBuy = bull && (requireBoth ? r < rsiBuyBelow : !overheat);
  if (canBuy && !pos) {
    const qty = calcBuyQty(st.symbol, price, broker.store.ensureAccount(st.uid).cash, st.params);
    if (qty > 0) await doBuy(st, price, qty);
    else st.lastSignal = '资金不足以买入最小单位，跳过';
  } else if ((bull === false || overheat) && pos) {
    await doSell(st, price, pos.qty);
  } else {
    st.lastSignal = `MA${maFast}/${maSlow} ${bull ? '多头' : '空头'} · RSI${rsiPeriod}=${r.toFixed(1)}${overheat ? '（过热）' : ''} · ${pos ? '持有' : '空仓'}`;
  }
}

// ── 下单辅助 ──
function calcBuyQty(symbol, price, cash, params) {
  if (params.qty) return Math.max(Math.floor(Number(params.qty) || 0), 0);
  const maxPct = Math.min(Math.max(Number(process.env.PAPER_MAX_ORDER_PCT) || 0.2, 0.01), 1);
  let qty = Math.floor((cash * 0.98 * maxPct) / price);
  if (marketOf(symbol) === 'CN') qty = Math.floor(qty / 100) * 100; // A股整手
  return Math.max(qty, 0);
}

async function doBuy(st, price, qty) {
  const acc = broker.store.ensureAccount(st.uid);
  const r = await broker.placeOrder(st.uid, {
    symbol: st.symbol, name: st.name, side: 'buy', type: 'market', qty,
    src: st.id, // 策略归因标记：订单按来源策略统计（一致性报告/衰减监控依赖此字段）
  });
  st.lastSignal = `买入 ${qty} 股 @≈${price?.toFixed?.(2) || price} → ${r.ok ? '已受理' : r.error}`;
  return r;
}
async function doSell(st, price, qty) {
  const r = await broker.placeOrder(st.uid, {
    symbol: st.symbol, name: st.name, side: 'sell', type: 'market', qty,
    src: st.id,
  });
  st.lastSignal = `卖出 ${qty} 股 @≈${price?.toFixed?.(2) || price} → ${r.ok ? '已受理' : r.error}`;
  return r;
}

// ── 各策略评估 ──
async function evalMaCross(st, price, klines) {
  const fast = Math.max(Number(st.params.fast) || 5, 2);
  const slow = Math.max(Number(st.params.slow) || 20, fast + 1);
  const closes = klines.map((k) => k.close);
  const f = smaLast(closes, fast);
  const s = smaLast(closes, slow);
  if (!f || !s) {
    st.lastSignal = '均线数据不足，跳过';
    return;
  }
  const pos = broker.store.state.positions[st.uid]?.find((p) => p.symbol === st.symbol);
  if (f > s && !pos) {
    const qty = calcBuyQty(st.symbol, price, broker.store.ensureAccount(st.uid).cash, st.params);
    if (qty > 0) await doBuy(st, price, qty);
    else st.lastSignal = '资金不足以买入最小单位，跳过';
  } else if (f < s && pos) {
    await doSell(st, price, pos.qty);
  } else {
    st.lastSignal = f > s ? `多头排列（MA${fast} ${f.toFixed(2)} > MA${slow} ${s.toFixed(2)}），持有` : `空头排列（MA${fast} ${f.toFixed(2)} < MA${slow} ${s.toFixed(2)}），空仓`;
  }
}

async function evalRsi(st, price, klines) {
  const period = Math.max(Number(st.params.period) || 14, 2);
  const oversold = Number(st.params.oversold) || 30;
  const overbought = Number(st.params.overbought) || 70;
  const closes = klines.map((k) => k.close);
  const val = rsi(closes, period);
  const prev = st.state.prevRsi;
  st.state.prevRsi = val;
  if (val === null) {
    st.lastSignal = 'RSI 数据不足，跳过';
    return;
  }
  const pos = broker.store.state.positions[st.uid]?.find((p) => p.symbol === st.symbol);
  if (prev !== null && prev <= oversold && val > oversold && !pos) {
    const qty = calcBuyQty(st.symbol, price, broker.store.ensureAccount(st.uid).cash, st.params);
    if (qty > 0) await doBuy(st, price, qty);
    else st.lastSignal = '资金不足以买入最小单位，跳过';
  } else if (prev !== null && prev >= overbought && val < overbought && pos) {
    await doSell(st, price, pos.qty);
  } else {
    st.lastSignal = `RSI=${val.toFixed(1)}（前值 ${prev === null ? '--' : prev.toFixed(1)}），观望`;
  }
}

async function evalGrid(st, price) {
  const gridPct = Math.min(Math.max(Number(st.params.gridPct) || 2, 0.5), 20) / 100;
  const gridQty = Math.max(Math.floor(Number(st.params.gridQty) || 0), 1);
  if (!st.state.basePrice) {
    st.state.basePrice = price;
    st.state.level = 0;
    st.lastSignal = `网格基准价 ${price.toFixed(2)}，步长 ${(gridPct * 100).toFixed(1)}%`;
    return;
  }
  const level = Math.round(Math.log(price / st.state.basePrice) / Math.log(1 + gridPct));
  const prevLevel = st.state.level ?? 0;
  if (level === prevLevel) {
    st.lastSignal = `价位持平（档位 ${level}），观望`;
    return;
  }
  const pos = broker.store.state.positions[st.uid]?.find((p) => p.symbol === st.symbol);
  if (level < prevLevel) {
    const times = Math.min(Math.abs(level - prevLevel), 3); // 单周期最多补 3 档，防跳空巨量
    const acc = broker.store.ensureAccount(st.uid);
    const qty = st.params.qty ? gridQty : calcBuyQty(st.symbol, price, acc.cash, { qty: gridQty });
    if (qty > 0) await doBuy(st, price, qty * times);
    else st.lastSignal = '资金不足，跳过买入';
  } else if (pos) {
    const qty = Math.min(pos.qty, gridQty * Math.min(level - prevLevel, 3));
    await doSell(st, price, qty);
  } else {
    st.lastSignal = `上行至档位 ${level} 但无持仓，跳过`;
  }
  st.state.level = level;
}

// ── 主循环 ──
async function runStrategies() {
  for (const st of strategies) {
    if (st.status !== 'running') continue;
    try {
      if (!isMarketOpen(st.symbol)) {
        st.lastSignal = '非交易时段，暂停评估';
        st.lastRunAt = nowISO();
        continue;
      }
      const quote = await deps.getQuote(st.symbol, st.symbol);
      const price = quote?.price;
      if (!Number.isFinite(price) || price <= 0) {
        st.lastSignal = '无有效行情，跳过';
        st.lastRunAt = nowISO();
        continue;
      }
      if (st.type === 'gridTrading') {
        await evalGrid(st, price);
      } else {
        const count = st.type === 'maCross'
          ? Math.max(Number(st.params.slow) || 20, 60)
          : st.type === 'combo'
            ? Math.max(Number(st.params.maSlow) || 20, Number(st.params.rsiPeriod) || 14, 60)
            : 120;
        const klines = await deps.fetchDailyRows(st.symbol, count);
        if (!klines.length) {
          st.lastSignal = '历史数据为空，跳过';
        } else if (st.type === 'maCross') {
          await evalMaCross(st, price, klines);
        } else if (st.type === 'rsiReversal') {
          await evalRsi(st, price, klines);
        } else if (st.type === 'combo') {
          await evalCombo(st, price, klines);
        }
      }
      st.lastRunAt = nowISO();
      st.error = '';
      broker.logEvent(st.uid, `[策略:${st.type}] ${st.symbol} ${st.lastSignal}`);
    } catch (e) {
      st.error = String(e.message).slice(0, 200);
      broker.logEvent(st.uid, `[策略:${st.type}] ${st.symbol} 评估异常: ${st.error}`);
    }
  }
  save();
}

function nowISO() {
  return new Date().toISOString();
}

function start(uid, { type, symbol, name, params }) {
  const valid = ['maCross', 'rsiReversal', 'gridTrading', 'combo'];
  if (!valid.includes(type)) return { ok: false, error: `未知策略类型 ${type}` };
  symbol = String(symbol || '').trim();
  if (!symbol) return { ok: false, error: '缺少股票代码' };
  // 同一 symbol 同类型只允许一个运行中实例
  const dup = strategies.find((s) => s.symbol === symbol && s.type === type && s.status === 'running');
  if (dup) return { ok: false, error: '该标的同类型策略已在运行' };
  const st = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    uid,
    type,
    symbol,
    name: name || symbol,
    params: params || {},
    status: 'running',
    state: {},
    lastSignal: '已启动，等待首个评估周期',
    startedAt: nowISO(),
    lastRunAt: '',
    error: '',
  };
  strategies.unshift(st);
  if (strategies.length > 50) strategies.length = 50;
  save();
  broker.logEvent(uid, `[策略] 启动 ${type} @ ${symbol}`);
  // 异步立即评估一次，不等下一个整周期
  setImmediate(() => runStrategies().catch(() => {}));
  return { ok: true, strategy: st };
}

function stop(uid, id) {
  const st = strategies.find((s) => s.id === id && s.uid === uid);
  if (!st) return { ok: false, error: '策略不存在' };
  st.status = 'stopped';
  st.lastSignal = '已手动停止';
  save();
  broker.logEvent(st.uid, `[策略] 停止 ${st.type} @ ${st.symbol}`);
  return { ok: true };
}

function list(uid) {
  return strategies.filter((s) => s.uid === uid);
}

function all() {
  return strategies; // 全部策略（跨 uid）——一致性报告/衰减监控按 src 归因统计用
}

function startLoop() {
  setInterval(() => runStrategies().catch((e) => console.error('[Strategies] 循环异常:', e.message)), EVAL_INTERVAL_MS);
  console.log(`🤖 模拟盘策略引擎已启动（评估间隔 ${Math.round(EVAL_INTERVAL_MS / 60_000)} 分钟）`);
}

module.exports = { init, start, stop, list, all, startLoop, runStrategies };
