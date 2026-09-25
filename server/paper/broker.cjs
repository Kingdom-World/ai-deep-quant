// ─────────────────────────────────────────────────────────────
// 模拟交易引擎中枢：订单生命周期 / 持仓与现金账本 / 净值快照 / 撮合循环
//   · 通过 init({ getQuote }) 注入行情函数（复用主服务的行情缓存，避免循环依赖）
//   · 挂单冻结（评审 P1-4）：限价买单按「限价×数量+买入费」冻结现金（acc.reservedCash），
//     限价卖单冻结持仓股数（pos.reservedQty）——挂单不再虚占资金/持仓；
//     冻结额为估算上限，成交按实际价扣款并释放差额；撤单/过期/拒单全额释放
//   · GFD 当日有效（评审 P1-4）：限价挂单 validUntil=当日（盘中/集合竞价挂出）
//     或次一交易日（闭市挂出=隔夜委托），过期由撮合循环自动撤销
// ─────────────────────────────────────────────────────────────
const { PaperStore } = require('./store.cjs');
const { fillMarketOrder, tryFillLimitOrder, nowISO, priceLimitPct } = require('./matcher.cjs');
const { preTradeCheck } = require('./risk.cjs');
const { calcFees, marketOf } = require('./fees.cjs');
const { canFill, canQueue, sessionLabel } = require('./sessions.cjs');
const { nextCnTradingDay } = require('../calendar.cjs');
const alerts = require('./alerts.cjs'); // 熔断等系统级通知复用告警外发通道

const store = new PaperStore();

// ── 账户级串行队列（并发安全的关键）────────────────────────────
// 下单 / 撤单 / 撮合循环都是「读账户 → await 行情 → 写账户」的三段式结构，
// 中间一旦插入别的操作就会互相覆盖检查结果，产生两类真实事故：
//   · 风控 TOCTOU：两个并发买单都基于旧持仓做限额判断 → 双双通过 → 突破单标的 30% 上限
//   · 撤单被成交：撮合循环 await 行情期间用户撤单，回来后仍按旧快照 execFill
// 解决方式：把同一 uid 的所有写操作串到一条 promise 链上，从根上消除交错。
const accountLocks = new Map(); // uid -> Promise（该账户队列尾）
function withAccountLock(uid, fn) {
  const prev = accountLocks.get(uid) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  const tail = run.catch(() => {});
  accountLocks.set(uid, tail);
  tail.then(() => {
    if (accountLocks.get(uid) === tail) accountLocks.delete(uid); // 队列空闲即释放，防 Map 无界增长
  });
  return run;
}

/** 北京交易日日期（YYYY-MM-DD）：T+1 解锁与当日盈亏日切都必须按北京日历，不能按 UTC */
function cnToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

let getQuote = null; // async (code) => { price, name, ... } | null

function init({ getQuote: fn }) {
  getQuote = fn;
}

function uidOf(req) {
  // 认证系统接管后按登录用户名分账（多用户数据隔离）。
  // 未启用站点密码时（AUTH_ENABLED=false）没有登录态，此时按来源 IP 分账：
  //   否则局域网内所有设备会共用同一个 'default' 账本——A 设备的持仓/委托会被 B 设备看到并操作。
  if (req?.user?.username) return req.user.username;
  if (req?.authUser) return req.authUser;
  const ip = req?.ip;
  return ip ? `ip:${ip}` : 'default';
}

function logEvent(uid, msg) {
  store.state.logs.push({ t: nowISO(), uid, msg: String(msg).slice(0, 300) });
  if (store.state.logs.length > 500) store.state.logs.splice(0, store.state.logs.length - 500);
}

/** 拉取最新价（失败返回 null） */
async function latestPrice(symbol) {
  if (!getQuote) return null;
  try {
    const q = await getQuote(symbol, symbol);
    return q && Number.isFinite(q.price) ? q : null;
  } catch {
    return null;
  }
}

/** 释放订单冻结（撤单/过期/成交/拒单后调用；幂等，字段清零防重复释放） */
function releaseOrderReservation(uid, order) {
  if (!order.reservedCash && !order.reservedQty) return;
  const acc = store.state.accounts[uid];
  if (order.reservedCash && acc) {
    acc.reservedCash = +Math.max(0, (acc.reservedCash || 0) - order.reservedCash).toFixed(2);
  }
  if (order.reservedQty) {
    const pos = (store.state.positions[uid] || []).find((p) => p.symbol === order.symbol);
    if (pos) pos.reservedQty = +Math.max(0, (pos.reservedQty || 0) - order.reservedQty).toFixed(4);
  }
  order.reservedCash = 0;
  order.reservedQty = 0;
}

/** 成交后账本变更：现金、持仓、当日盈亏（卖出时计入已实现盈亏）；无论成败都释放本单冻结 */
function applyFill(uid, order, price) {
  const ok = applyFillInner(uid, order, price);
  releaseOrderReservation(uid, order);
  return ok;
}

function applyFillInner(uid, order, price) {
  const acc = store.ensureAccount(uid);
  const positions = store.state.positions[uid];
  const fees = order.fees || { total: 0 };
  const value = order.qty * price;

  if (order.side === 'buy') {
    const cost = value + fees.total;
    if (acc.cash < cost) {
      order.status = 'rejected';
      order.reason = `成交时资金不足（需 ${cost.toFixed(2)}，可用 ${acc.cash.toFixed(2)}）`;
      return false;
    }
    acc.cash = +(acc.cash - cost).toFixed(2);
    let pos = positions.find((p) => p.symbol === order.symbol);
    if (!pos) {
      pos = {
        symbol: order.symbol,
        name: order.name,
        market: marketOf(order.symbol),
        qty: 0,
        avgCost: 0,
        feeAccum: 0, // 已计入持仓成本的买入费用累计（卖出时按比例分摊到已实现盈亏）
        todayBoughtQty: 0,
        todayBoughtDate: cnToday(),
        todayBuyCount: 0,
      };
      positions.push(pos);
    }
    const newQty = pos.qty + order.qty;
    pos.avgCost = +((pos.avgCost * pos.qty + value) / newQty).toFixed(4);
    pos.qty = newQty;
    pos.feeAccum = +((pos.feeAccum || 0) + fees.total).toFixed(2);
    pos.name = pos.name || order.name;
    const today = cnToday();
    if (pos.todayBoughtDate !== today) {
      pos.todayBoughtDate = today;
      pos.todayBoughtQty = 0;
      pos.todayBuyCount = 0;
    }
    pos.todayBoughtQty += order.qty;
    pos.todayBuyCount += 1;
  } else {
    const pos = positions.find((p) => p.symbol === order.symbol);
    if (!pos || pos.qty < order.qty) {
      order.status = 'rejected';
      order.reason = '持仓不足，卖出拒绝';
      return false;
    }
    // 成交瞬间 T+1 复核（按成交日北京日期）：堵住"隔夜挂单当日盘中仍锁定"的口子。
    // 冻结股数中属于本单的部分不计入他人占用（reservedOther），否则挂单会被自己的冻结卡死。
    if (marketOf(order.symbol) === 'CN') {
      const today = cnToday();
      const locked = pos.todayBoughtDate === today ? pos.todayBoughtQty || 0 : 0;
      const reservedOther = Math.max(0, (pos.reservedQty || 0) - (order.reservedQty || 0));
      if (order.qty > pos.qty - locked - reservedOther) {
        order.status = 'rejected';
        order.reason = `A股 T+1 规则：今日买入的 ${locked} 股当日不可卖出，当前可卖 ${Math.max(0, pos.qty - locked)} 股，卖出拒绝`;
        return false;
      }
    }
    const proceeds = value - fees.total;
    acc.cash = +(acc.cash + proceeds).toFixed(2);
    // 已实现盈亏 = 卖出净收入 − 对应持仓成本 − 分摊到本次卖出的「买入费用」
    //   原实现只扣卖出费、未计买入时的佣金/过户费，导致已实现盈亏系统性偏高。
    const heldQty = pos.qty;
    const buyFeeShare = heldQty > 0 ? (pos.feeAccum || 0) * (order.qty / heldQty) : 0;
    const realized = (price - pos.avgCost) * order.qty - fees.total - buyFeeShare;
    // 归因戳：价差毛盈亏 / 卖出费 / 买入费分摊 / 净已实现——一致性报告与成本归因依赖
    order.pricePnl = +((price - pos.avgCost) * order.qty).toFixed(2);
    order.realized = +realized.toFixed(2);
    order.buyFeeShare = +buyFeeShare.toFixed(2);
    pos.feeAccum = +Math.max(0, (pos.feeAccum || 0) - buyFeeShare).toFixed(2);
    const today = cnToday();
    store.state.dailyPnl[uid][today] = +((store.state.dailyPnl[uid][today] || 0) + realized).toFixed(2);
    pos.qty -= order.qty;
    if (pos.qty <= 0) positions.splice(positions.indexOf(pos), 1);
  }
  return true;
}

// priceLimitPct 已下沉至 matcher.cjs（市价撮合与挂单轮询也需要涨跌停守卫，单一实现）

/** 下单入口：账户串行化 → 时段 → 风控 → 建单 → 立即撮合（市价）/ 挂单（限价） */
function placeOrder(uid, payload) {
  return withAccountLock(uid, () => placeOrderInner(uid, payload));
}

async function placeOrderInner(uid, { symbol, name, side, type, qty, limitPrice, src }) {
  symbol = String(symbol || '').trim();
  side = String(side) === 'sell' ? 'sell' : 'buy';
  type = String(type) === 'limit' ? 'limit' : 'market';
  qty = Math.floor(Number(qty) || 0);
  limitPrice = Number(limitPrice) || 0;

  const acc = store.ensureAccount(uid);
  if (!symbol) return { ok: false, error: '缺少股票代码' };
  if (qty <= 0) return { ok: false, error: '数量必须为正整数' };
  if (type === 'limit' && limitPrice <= 0) return { ok: false, error: '限价单必须提供有效价格' };

  const quote = await latestPrice(symbol);
  const positions = store.state.positions[uid];
  const market = marketOf(symbol);

  const reject = async (reason) => {
    const order = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      uid, symbol, name: name || quote?.name || symbol, side, type, qty,
      limitPrice: type === 'limit' ? limitPrice : null,
      estimatePrice: quote?.price || null,
      status: 'rejected', reason, fills: [], createdAt: nowISO(),
    };
    store.state.orders[uid].unshift(order);
    if (store.state.orders[uid].length > 300) store.state.orders[uid].length = 300;
    const persist = await store.persistUid(uid);
    logEvent(uid, `拒单 ${side} ${symbol} ×${qty}: ${reason}`);
    return { ok: false, error: reason, order, persisted: persist.persisted };
  };

  // ── 交易时段约束（与真实股市一致）──
  // 市价单：仅连续竞价时段可成交；限价单：随时可挂（等价券商隔夜委托），撮合引擎只在连续竞价时段成交
  if (type === 'market' && !canFill(market)) {
    return reject(`${sessionLabel(market)}，市价单无法成交；可改用限价单挂单（隔夜委托），进入连续竞价时段后自动撮合`);
  }

  // ── A股 T+1：当日买入的股份当日不可卖出 ──
  // 仅对「当前时段可能成交」的委托校验；闭市/午间下的限价卖单属于隔夜委托，成交在次日（T+1 已解锁），
  // 与真实券商一致允许挂出；成交瞬间 applyFill 会按成交日的北京日期再校验一次，堵住"午间挂单当日午后成交"的口子。
  if (side === 'sell' && market === 'CN' && canFill(market)) {
    const pos = positions.find((p) => p.symbol === symbol);
    if (pos) {
      const today = cnToday();
      const locked = pos.todayBoughtDate === today ? pos.todayBoughtQty || 0 : 0;
      // 可卖 = 持仓 − T+1 锁定 − 其它挂单已冻结（防止重复冻结同一批股份）
      const sellable = pos.qty - locked - (pos.reservedQty || 0);
      if (qty > sellable) {
        return reject(
          sellable <= 0
            ? `A股 T+1 规则：该股 ${pos.todayBoughtDate === today ? '今日' : ''}买入的 ${locked} 股当日不可卖出，当前可卖 0 股`
            : `A股 T+1 规则：今日买入的 ${locked} 股不可卖出，当前可卖 ${sellable} 股（委托 ${qty} 股超出）`,
        );
      }
    }
  }

  // ── A股涨跌停校验：限价超出前一收盘价的涨跌停板即为无效委托 ──
  if (type === 'limit' && market === 'CN' && quote?.prevClose) {
    const pct = priceLimitPct(symbol, name || quote?.name);
    const upper = +(quote.prevClose * (1 + pct / 100)).toFixed(2);
    const lower = +(quote.prevClose * (1 - pct / 100)).toFixed(2);
    if (side === 'buy' && limitPrice > upper) {
      return reject(`买入限价 ${limitPrice} 超出涨停价 ${upper}（${quote.prevClose} × ${1 + pct / 100}），委托无效`);
    }
    if (side === 'sell' && limitPrice < lower) {
      return reject(`卖出限价 ${limitPrice} 低于跌停价 ${lower}（${quote.prevClose} × ${1 - pct / 100}），委托无效`);
    }
  }

  const order = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    uid,
    symbol,
    name: name || quote?.name || symbol,
    side,
    type,
    qty,
    limitPrice: type === 'limit' ? limitPrice : null,
    estimatePrice: quote?.price || null,
    src: String(src || '').slice(0, 40), // 策略归因标记（策略引擎下单时传入，人工下单为空）
    status: 'pending',
    reason: '',
    fills: [],
    createdAt: nowISO(),
  };

  // 风控前置校验（用最新行情估算总资产；现金按「扣除挂单冻结后的可用额」口径）
  const availCash = +(acc.cash - (acc.reservedCash || 0)).toFixed(2);
  const latestPrices = {};
  for (const p of positions) {
    const q = await latestPrice(p.symbol);
    latestPrices[p.symbol] = q?.price || p.avgCost;
  }

  // ── 回撤熔断（评审 P2-2）：以账户净值高水位为基准的两级事中风控 ──
  //   L1（回撤 ≥ PAPER_DD_HALT，默认 10%）：禁止新开仓（买入拒绝），卖出减仓放行
  //   L2（回撤 ≥ PAPER_DD_LOCK，默认 15%）：账户锁定（riskLocked），仅可卖出，需手动解锁
  //   PAPER_RISK_OFF=1 可整体停用。解除方式：净值回升自动降级，或 POST /api/paper/unlock 重置基准。
  if (String(process.env.PAPER_RISK_OFF || '') !== '1') {
    const marketValue = positions.reduce((s, p) => s + p.qty * (latestPrices[p.symbol] || p.avgCost), 0);
    const totalAssets = +(availCash + marketValue).toFixed(2);
    const halt = Math.max(Number(process.env.PAPER_DD_HALT) || 0.10, 0.01);
    const lock = Math.max(Number(process.env.PAPER_DD_LOCK) || 0.15, halt + 0.01);
    const peak = Math.max(acc.peakAssets || totalAssets, totalAssets);
    acc.peakAssets = +peak.toFixed(2);
    const dd = peak > 0 ? 1 - totalAssets / peak : 0;
    const level = dd >= lock ? 2 : dd >= halt ? 1 : 0;
    if (level > (acc.ddLevel || 0)) {
      const msg = `[AI量化平台] 回撤熔断 L${level}\n账户 ${uid} 净值 ${totalAssets}，距高水位 ${acc.peakAssets} 回撤 ${(dd * 100).toFixed(1)}%` +
        (level === 2 ? '，账户已锁定（仅可卖出减仓）' : '，禁止新开仓');
      logEvent(uid, `回撤熔断 L${level}：净值 ${totalAssets} / 高水位 ${acc.peakAssets}（回撤 ${(dd * 100).toFixed(1)}%）`);
      alerts.sendExternalMessage(msg); // fire-and-forget
    } else if (level < (acc.ddLevel || 0)) {
      logEvent(uid, `回撤回落至 L${level}（当前 ${(dd * 100).toFixed(1)}%）`);
    }
    acc.ddLevel = level;
    acc.riskLocked = level >= 2;
    if (side === 'buy' && level >= 1) {
      return reject(
        `回撤熔断 L${level}：账户距高水位回撤 ${(dd * 100).toFixed(1)}%，禁止新开仓` +
          '（可卖出减仓；净值回升自动降级，或 POST /api/paper/unlock 重置基准）',
      );
    }
  }

  const risk = preTradeCheck({ order, account: { ...acc, cash: availCash }, positions, latestPrices });
  if (!risk.ok) {
    order.status = 'rejected';
    order.reason = risk.reason;
    store.state.orders[uid].unshift(order);
    const persist = await store.persistUid(uid);
    logEvent(uid, `拒单 ${side} ${symbol} ×${qty}: ${risk.reason}`);
    return { ok: false, error: risk.reason, order, persisted: persist.persisted };
  }

  // 立即撮合
  if (type === 'market') {
    fillMarketOrder(order, quote || {});
    if (order.status === 'filled' && !applyFill(uid, order, order.avgFillPrice)) {
      // applyFill 内部已把状态改为 rejected 并写明原因
    }
  } else {
    // 时段门禁：非连续竞价时段限价单只挂不撮（防止闭市时按陈旧行情立即成交）
    if (canFill(market)) {
      tryFillLimitOrder(order, quote || {});
    }
    if (order.status === 'filled') {
      applyFill(uid, order, order.avgFillPrice);
    } else {
      order.status = 'resting';
      // GFD 当日有效：盘中/集合竞价挂出→当日到期；闭市挂出=隔夜委托→次一交易日到期（跳过节假日）
      order.validUntil = canQueue(market) ? cnToday() : nextCnTradingDay(cnToday());
      // 冻结：买单按限价+买入费估算冻结现金（上限口径，成交按实际价结算）；卖单冻结持仓股数
      if (order.side === 'buy') {
        const reserve = +(order.qty * order.limitPrice + calcFees(market, 'buy', order.qty * order.limitPrice).total).toFixed(2);
        const avail = +(acc.cash - (acc.reservedCash || 0)).toFixed(2);
        if (avail < reserve) {
          order.status = 'rejected';
          order.reason = `挂单需冻结 ${reserve.toFixed(2)}，可用 ${avail.toFixed(2)}（其余挂单已占用），委托拒绝`;
        } else {
          acc.reservedCash = +((acc.reservedCash || 0) + reserve).toFixed(2);
          order.reservedCash = reserve;
        }
      } else {
        const pos = positions.find((p) => p.symbol === order.symbol);
        if (pos) {
          pos.reservedQty = +((pos.reservedQty || 0) + order.qty).toFixed(4);
          order.reservedQty = order.qty;
        }
      }
      if (order.status === 'resting') {
        logEvent(uid, `挂单 ${side} ${symbol} ×${qty} @ 限价 ${limitPrice}（${order.validUntil} 前有效）`);
      }
    }
  }

  store.state.orders[uid].unshift(order);
  if (store.state.orders[uid].length > 300) store.state.orders[uid].length = 300;
  const persist = await store.persistUid(uid); // 响应返回前已落库（Vercel 冻结不再丢挂单）
  if (order.status === 'filled') {
    logEvent(uid, `成交 ${side} ${symbol} ×${qty} @ ${order.avgFillPrice}（费 ${order.fees.total}）`);
  } else if (order.status === 'rejected') {
    logEvent(uid, `拒单 ${side} ${symbol} ×${qty}: ${order.reason}`);
  }
  return { ok: order.status !== 'rejected', order, persisted: persist.persisted };
}

/** 取消挂单（走账户队列，避免与撮合循环的 await 窗口交错 → 撤单后仍被成交） */
function cancelOrder(uid, orderId) {
  return withAccountLock(uid, async () => {
    const order = store.state.orders[uid].find((o) => o.id === orderId);
    if (!order) return { ok: false, error: '订单不存在' };
    if (order.status !== 'resting' && order.status !== 'pending') {
      return { ok: false, error: `当前状态 ${order.status} 不可撤销` };
    }
    releaseOrderReservation(uid, order); // 撤单即释放冻结的资金/持仓
    order.status = 'canceled';
    order.filledAt = nowISO();
    const persist = await store.persistUid(uid);
    logEvent(uid, `撤单 ${order.side} ${order.symbol} ×${order.qty}`);
    return { ok: true, persisted: persist.persisted };
  });
}

/** 重置模拟账户（走账户队列，避免与在途撮合交错） */
function resetAccount(uid) {
  return withAccountLock(uid, async () => {
    store.reset(uid);
    await store.persistUid(uid); // reset 内部已 save 本地文件；此处再同步落库（并清 DB 旧镜像语义见 store.reset）
    logEvent(uid, '模拟账户已重置');
    return { ok: true, message: '模拟账户已重置为初始资金' };
  });
}

/** 手动解锁回撤锁定：以当前净值为新基准重置高水位（用户确认接受回撤后调用） */
function unlockAccount(uid) {
  return withAccountLock(uid, async () => {
    const acc = store.ensureAccount(uid);
    const positions = store.state.positions[uid] || [];
    let marketValue = 0;
    for (const p of positions) {
      const q = await latestPrice(p.symbol);
      marketValue += p.qty * (q?.price || p.avgCost);
    }
    const total = +(acc.cash - (acc.reservedCash || 0) + marketValue).toFixed(2);
    acc.peakAssets = total;
    acc.riskLocked = false;
    acc.ddLevel = 0;
    const persist = await store.persistUid(uid); // 风控状态变更必须落盘（旧实现漏落，重启回滚）
    logEvent(uid, `手动解锁：回撤基准重置为当前净值 ${total}`);
    return { ok: true, message: `已解锁，回撤基准重置为当前净值 ${total}`, peakAssets: total, persisted: persist.persisted };
  });
}

/** 撮合循环：每 5s 重试挂单；每 60s 记录净值快照
 *  重入保护：单次 runMatcher 可能因上游行情慢而超过 5s，若下一个 tick 并发进入，
 *  同一 resting 订单会被两个循环同时撮合 → 重复成交/重复扣款。此处直接丢弃重叠的那一轮。 */
let tickCount = 0;
let matcherRunning = false;
/** 撮合：不传 targetUid 跑全部账户（本地 5s 循环）；传 targetUid 只跑该账户
 *  （Vercel 惰性撮合：请求驱动 + per-uid 节流，见 index.cjs maybeRunMatcher）。
 *  变更（成交/到期撤销/净值快照）在锁内同步落库（persistUid），响应前持久化。 */
async function runMatcher(targetUid) {
  if (matcherRunning) return { skipped: true, reason: '上一轮撮合尚未结束' };
  matcherRunning = true;
  tickCount += 1;
  const tick = tickCount;
  try {
    const uids = targetUid ? [targetUid] : Object.keys(store.state.accounts);
    for (const uid of uids) {
      if (!store.state.accounts[uid]) continue; // 账户不存在（未开户）→ 跳过
      // 每个账户内部串行：撮合与用户下单/撤单不会交错
      await withAccountLock(uid, async () => {
        let changed = false;
        const resting = store.state.orders[uid].filter((o) => o.status === 'resting');
        for (const order of resting) {
          if (order.status !== 'resting') continue; // 快照后已被撤单/成交
          // GFD 到期自动撤销（先于时段门禁：避免长假期间过期单堆积到开市才处理）
          if (order.validUntil && cnToday() > order.validUntil) {
            releaseOrderReservation(uid, order);
            order.status = 'canceled';
            order.reason = 'GFD：当日有效委托到期，自动撤销';
            order.filledAt = nowISO();
            logEvent(uid, `挂单过期撤销 ${order.side} ${order.symbol} ×${order.qty}（${order.validUntil} 到期）`);
            changed = true;
            continue;
          }
          // 时段门禁：挂单只在对应市场的连续竞价时段撮合（与真实交易所一致）
          if (!canFill(marketOf(order.symbol))) continue;
          const quote = await latestPrice(order.symbol);
          if (!quote) continue;
          if (order.status !== 'resting') continue; // await 行情期间状态已变更 → 放弃本轮
          const before = order.status;
          tryFillLimitOrder(order, quote);
          if (order.status === 'filled' && before !== 'filled') {
            if (applyFill(uid, order, order.avgFillPrice)) {
              logEvent(uid, `挂单成交 ${order.side} ${order.symbol} ×${order.qty} @ ${order.avgFillPrice}`);
              changed = true;
            }
          }
        }

        // 净值快照（每 12 个 tick ≈ 60s）
        if (tick % 12 === 0) {
          const acc = store.state.accounts[uid];
          const positions = store.state.positions[uid];
          let marketValue = 0;
          for (const p of positions) {
            const q = await latestPrice(p.symbol);
            marketValue += p.qty * (q?.price || p.avgCost);
          }
          const total = +(acc.cash + marketValue).toFixed(2);
          const eq = store.state.equity[uid];
          const last = eq[eq.length - 1];
          // 变化即记录；无变化时每 10 分钟保活一条，避免休市期间净值曲线"看起来断了"
          const stale = !last || Date.now() - new Date(last.t).getTime() > 10 * 60_000;
          if (!last || last.total !== total || stale) {
            eq.push({ t: nowISO(), total, cash: +acc.cash.toFixed(2), marketValue: +marketValue.toFixed(2) });
            if (eq.length > 5000) eq.splice(0, eq.length - 5000);
            changed = true;
          }
        }
        // 🔴 锁内同步落库（仅变更时写）：写点在锁内 ⇒ refreshIfStale 语义成立；
        //    无变更零写放大。失败时 persistUid 内部显式降级（重试队列），不中断撮合。
        if (changed) await store.persistUid(uid);
      });
    }
    store.save();
    return { ok: true }; // 供 maybeRunMatcher 区分"真正跑过"与"被重入守卫跳过"
  } catch (e) {
    console.error('[PaperBroker] 撮合循环异常:', e.message);
    return { ok: false, error: e.message };
  } finally {
    matcherRunning = false;
  }
}

/** 惰性撮合节流（per-uid）：Vercel 无常驻撮合循环，靠请求驱动补跑 */
const lazyMatcherLastRun = new Map();
const LAZY_MATCHER_MIN_INTERVAL_MS = 60_000;

/** 惰性撮合入口（仅 Vercel 门禁调用，见 index.cjs /api/paper）：
 *  距上次真正运行 >60s 且本实例内存存在 resting 挂单才跑 runMatcher(uid)；无挂单零成本跳过。
 *  ⚠️ 前提：调用方必须先完成 store.refreshIfStale(uid)（门禁统一做）——
 *  存在性判断依据的是刷新后的内存，否则会误判"无挂单"而跳过。
 *  runMatcher 内部自带 matcherRunning 重入守卫 + per-uid 账户锁，此处无需再加锁。 */
async function maybeRunMatcher(uid) {
  const now = Date.now();
  const last = lazyMatcherLastRun.get(uid) || 0;
  if (now - last < LAZY_MATCHER_MIN_INTERVAL_MS) {
    return { skipped: true, reason: '节流窗口内（60s）' };
  }
  const orders = store.state.orders[uid];
  if (!orders || !orders.some((o) => o.status === 'resting')) {
    return { skipped: true, reason: '无 resting 挂单' };
  }
  const r = await runMatcher(uid);
  if (!r.skipped) lazyMatcherLastRun.set(uid, now); // 真正跑过才计入节流；被重入守卫挡下时下个请求立刻再试
  return { ok: true, ...r };
}

/** 账户快照（前端展示） */
async function accountSnapshot(uid) {
  const acc = store.ensureAccount(uid);
  const positions = [];
  let marketValue = 0;
  for (const p of store.state.positions[uid]) {
    const q = await latestPrice(p.symbol);
    const price = q?.price || p.avgCost;
    const value = +(p.qty * price).toFixed(2);
    marketValue += value;
    const today = cnToday();
    const locked = p.market === 'CN' && p.todayBoughtDate === today ? p.todayBoughtQty || 0 : 0;
    positions.push({
      ...p,
      lastPrice: price,
      marketValue: value,
      sellableQty: Math.max(0, p.qty - locked - (p.reservedQty || 0)), // 可卖 = 持仓 − T+1 锁定 − 挂单冻结
      t1Locked: locked,
      reservedQty: p.reservedQty || 0,
      unrealizedPnl: +((price - p.avgCost) * p.qty).toFixed(2),
      unrealizedPct: +(((price - p.avgCost) / p.avgCost) * 100).toFixed(2),
    });
  }
  marketValue = +marketValue.toFixed(2);
  const total = +(acc.cash + marketValue).toFixed(2);
  const today = cnToday();
  const totalPnl = +(total - acc.initialCapital).toFixed(2);
  return {
    uid,
    cash: +acc.cash.toFixed(2),
    availableCash: +(acc.cash - (acc.reservedCash || 0)).toFixed(2), // 可用现金 = 现金 − 挂单冻结
    reservedCash: +(acc.reservedCash || 0).toFixed(2),
    initialCapital: acc.initialCapital,
    marketValue,
    totalAssets: total,
    totalPnl,
    totalPnlPct: +((totalPnl / acc.initialCapital) * 100).toFixed(2),
    todayPnl: +(store.state.dailyPnl[uid][today] || 0).toFixed(2),
    peakAssets: +(acc.peakAssets || total).toFixed(2),
    drawdownPct: acc.peakAssets ? +Math.max(0, (1 - total / acc.peakAssets) * 100).toFixed(2) : 0,
    riskLocked: !!acc.riskLocked,
    ddLevel: acc.ddLevel || 0,
    positions,
    orders: store.state.orders[uid].slice(0, 100),
    equity: store.state.equity[uid].slice(-500),
  };
}

module.exports = { init, placeOrder, cancelOrder, resetAccount, unlockAccount, withAccountLock, runMatcher, maybeRunMatcher, accountSnapshot, logEvent, store, uidOf };
