'use strict';
// ─────────────────────────────────────────────────────────────
// 模拟交易域路由（Provider 网关拆分 · 第二刀）
//   · /api/paper/*（15 条：account/order/cancel/reset/unlock/reconcile/
//     consistency/strategies×3/logs/alerts×4）+ /api/agents/daily-review
//     （物理穿插于本块，随块迁移；语义归属第三刀再理）
//   · 含系统级胶水：broker/strategies init、告警与自选池加载、5s 撮合循环
//     （IS_VERCEL/MAINTAIN_ONCE 门控）、/api/paper 门禁中间件（whenReady/
//     refreshIfStale/惰性撮合）——注册时序与原宿主完全一致。
// 行为零变化拆分：路由体与胶水自 index.cjs 原样迁移，仅依赖改为显式注入。
// broker/strategies/alerts/watchlist 的 require 留守宿主（其他域仍在引用）。
// ─────────────────────────────────────────────────────────────

/** 注册模拟交易域路由（须在 knowledge/screener/watchlist 等域之前调用，保持原注册顺序） */
function registerPaperRoutes(app, deps) {
  const { broker, strategies, alerts, watchlist, getQuoteInternal, fetchDailyRows, toTencentCode, IS_VERCEL, MAINTAIN_ONCE, axios, UA, sectors } = deps;

// ───────────── 8b. 模拟交易（paper trading，要求 #1） ─────────────
const wrapQuote = (symbol) => getQuoteInternal(toTencentCode(symbol), symbol);
broker.init({ getQuote: wrapQuote });
strategies.init({
  getQuote: wrapQuote,
  fetchDailyRows: (symbol, count) => fetchDailyRows(toTencentCode(symbol), count),
});

// 价格告警系统初始化
alerts.load();
watchlist.load();

// 撮合循环 5s / 策略评估循环（Vercel Serverless 与 --maintain-once 不启动）
if (!IS_VERCEL && !MAINTAIN_ONCE) {
  // 重入保护：单轮撮合可能因上游行情慢而超过 5s，重叠执行会让同一挂单被重复撮合。
  // broker.runMatcher 内部亦有守卫，这里是第二道闸（并保护紧随其后的告警检查）。
  let tickRunning = false;
  setInterval(async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      await broker.runMatcher();
      // 告警检查：收集全部用户的告警标的（告警按登录用户名分账，必须全量收集，不能只查特定 uid）
      const alertSyms = [...new Set(alerts.listAll().map((a) => a.symbol))];
      if (alertSyms.length) {
        const priceMap = new Map();
        for (const sym of alertSyms) {
          const q = await getQuoteInternal(toTencentCode(sym), sym);
          if (q?.price) priceMap.set(sym, q.price);
        }
        const fired = alerts.checkAlerts(priceMap);
        for (const evt of fired) console.log(`🔔 [告警] ${evt.symbol} ${evt.condition === 'above' ? '≥' : '≤'} ${evt.triggeredPrice}`);
        if (fired.length) alerts.notifyExternal(fired); // 外发 webhook（未配置 ALERT_WEBHOOK 时为 no-op）
      }
    } catch (e) {
      // 单轮失败不得让循环静默终止：记录后等下一轮自愈
      console.error('[PaperTick] 轮询异常:', e.message);
    } finally {
      tickRunning = false;
    }
  }, 5_000).unref();
  strategies.startLoop();
}

/**
 * 托管环境下，模拟盘状态要先从数据库载入再服务请求。
 *  若不设此门禁：冷启动后第一个请求会看到"空账"并据此建新账，
 *  随后的数据库载入会把旧状态填回来 ⇒ 用户的订单/持仓被静默覆盖。
 *  失败时返回 503（显式拒绝，不假装成功）——铁律 #4。
 */
app.use('/api/paper', async (req, res, next) => {
  try {
    await broker.store.whenReady();
    const uid = broker.uidOf(req);
    // 跨实例新鲜度检查（2026-09-22 用户拍板实施方案②）：其他实例写过该 uid ⇒
    // 持账户锁把本实例内存刷新到 DB 最新版 —— 修掉"热实例陈旧读"
    // （撤单后刷新仍显示 resting 的实测现象），并压缩跨实例覆盖窗口。
    // 失败不阻断主流程（显式记录；仅可能读到上一刻的数据，下一请求会再试）。
    try {
      if (uid) await broker.withAccountLock(uid, () => broker.store.refreshIfStale(uid));
    } catch (e) {
      console.warn('[paper] 新鲜度检查失败（不阻断）:', e.message?.slice(0, 120));
    }
    // Vercel 无常驻撮合循环（下方 IS_VERCEL 跳过 setInterval）→ 惰性撮合：
    // 请求驱动补跑 GFD 到期撤销/限价单成交，per-uid 60s 节流 + 仅存在 resting 挂单才执行。
    // 必须在 refreshIfStale 之后：存在性判断依据刷新后的内存，否则会误判"无挂单"而漏跑。
    // 失败不阻断主流程（铁律 #4：降级 = 挂单晚一点撮合，与改造前行为一致；下次请求再试）。
    if (IS_VERCEL && uid) {
      try {
        await broker.maybeRunMatcher(uid);
      } catch (e) {
        console.error('[lazyMatcher] 惰性撮合失败（不阻断）:', e.message?.slice(0, 120));
      }
    }
    next();
  } catch (e) {
    res.status(503).json({ ok: false, error: `交易存储初始化失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 账户总览：现金/持仓/净值曲线/当日盈亏 */
app.get('/api/paper/account', async (req, res) => {
  try {
    res.json(await broker.accountSnapshot(broker.uidOf(req)));
  } catch (e) {
    res.status(500).json({ error: `查询账户失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 下单：{symbol, name?, side: buy|sell, type: market|limit, qty, limitPrice?} */
app.post('/api/paper/order', async (req, res) => {
  try {
    const r = await broker.placeOrder(broker.uidOf(req), req.body || {});
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ error: `下单失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 撤销挂单 */
app.post('/api/paper/order/:id/cancel', async (req, res) => {
  try {
    const r = await broker.cancelOrder(broker.uidOf(req), req.params.id);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ error: `撤单失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 重置模拟账户（回到初始资金，清空持仓/订单/净值） */
app.post('/api/paper/reset', async (req, res) => {
  try {
    const r = await broker.resetAccount(broker.uidOf(req));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: `重置失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 手动解锁回撤锁定（以当前净值为新基准重置高水位） */
app.post('/api/paper/unlock', async (req, res) => {
  try {
    const r = await broker.unlockAccount(broker.uidOf(req));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: `解锁失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 账实对账即时自查（当前用户账本） */
app.get('/api/paper/reconcile', (req, res) => {
  try {
    const uid = broker.uidOf(req);
    const { reconcileAccount } = require('../paper/reconcile.cjs');
    const issues = reconcileAccount(uid, broker.store.state);
    res.json({ ok: issues.length === 0, checkedAt: new Date().toISOString(), uid, issues });
  } catch (e) {
    res.status(500).json({ error: `对账失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 回测 vs 模拟盘一致性报告 + 策略衰减监控 + 成本归因（评审 P2-4） */
app.get('/api/paper/consistency', async (req, res) => {
  try {
    const windowDays = Math.min(Math.max(Number(req.query.windowDays) || 30, 7), 365);
    const report = await require('../paper/consistency.cjs').buildReport({
      strategies: strategies.all(),
      windowDays,
      fetchDailyRows,
      toTencentCode,
    });
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: `一致性报告失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 策略列表 / 启动 / 停止 */
app.get('/api/paper/strategies', (req, res) => res.json(strategies.list(broker.uidOf(req))));
app.post('/api/paper/strategies', (req, res) => {
  const r = strategies.start(broker.uidOf(req), req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/paper/strategies/:id/stop', (req, res) => {
  try {
    const r = strategies.stop(broker.uidOf(req), req.params.id);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) {
    res.status(500).json({ error: `停止策略失败: ${e.message?.slice(0, 80)}` });
  }
});

/** 交易日志（最近 200 条，倒序） */
app.get('/api/paper/logs', (req, res) => {
  const uid = broker.uidOf(req);
  res.json(broker.store.state.logs.filter((l) => l.uid === uid).slice(-200).reverse());
});

// ── 价格监控告警 ──
app.get('/api/paper/alerts', (req, res) => {
  const uid = broker.uidOf(req);
  res.json({ ok: true, alerts: alerts.list(uid), triggered: alerts.listTriggered(uid).reverse() });
});

app.post('/api/paper/alerts', (req, res) => {
  const { symbol, name, condition, price } = req.body || {};
  const r = alerts.add(broker.uidOf(req), { symbol, name, condition, price });
  res.status(r.ok ? 200 : 400).json(r);
});

app.delete('/api/paper/alerts/:id', (req, res) => {
  const r = alerts.remove(broker.uidOf(req), req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

app.get('/api/agents/daily-review', async (req, res) => {
  try {
    const idxRes = await axios.get('https://qt.gtimg.cn/q=sh000001,sz399001,sh000300', { headers: { 'User-Agent': UA }, timeout: 6000 });
    const indices = ['sh000001', 'sz399001', 'sh000300'].map((code) => {
      const m = idxRes.data.match(new RegExp('v_' + code + '="([^"]*)"'));
      if (!m) return null;
      const p = m[1].split('~');
      return { name: { sh000001: '上证指数', sz399001: '深证成指', sh000300: '沪深300' }[code], price: parseFloat(p[3]), chg: parseFloat(p[4]) > 0 ? +(((parseFloat(p[3]) - parseFloat(p[4])) / parseFloat(p[4])) * 100).toFixed(2) : 0 };
    }).filter(Boolean);
    const sf = await sectors.getFlow('industry');
    const cf = await sectors.getFlow('concept');
    const fmt = (v) => (Number.isFinite(v) ? (v / 1e8).toFixed(1) + ' 亿' : '--');
    const out = ['📊 AI 盘后复盘', '', '一、大盘概况', ...indices.map((d) => '  · ' + d.name + ': ' + d.price), '', '二、行业主力资金', sf ? '  净流入前3：' + sf.inflow.slice(0, 3).map((x) => x.name + ' +' + fmt(x.mainNet)).join('、') : '', sf ? '  净流出前3：' + sf.outflow.slice(0, 3).map((x) => x.name + ' ' + fmt(x.mainNet)).join('、') : '', '', '三、概念热点', cf ? '  净流入前3：' + cf.inflow.slice(0, 3).map((x) => x.name + ' +' + fmt(x.mainNet)).join('、') : '', '', '⚠️ 本复盘由程序化规则引擎自动生成，属学术研究演示，不构成任何投资建议。'];
    res.json({ ok: true, review: out.join('\n'), generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: '复盘生成失败: ' + (e.message || '').slice(0, 80) });
  }
});

app.post('/api/paper/alerts/clear-triggered', (req, res) => {
  alerts.clearTriggered(broker.uidOf(req));
  res.json({ ok: true });
});
}

module.exports = { registerPaperRoutes };
