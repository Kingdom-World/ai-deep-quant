// ─────────────────────────────────────────────────────────────
// 每日账实对账（评审 P2-3）：事后风控闭环
//   此前平台无任何事后核对——账本损坏/冻结泄漏/订单状态残留只能靠用户肉眼发现。
//   硬不变量（必须零违反）：
//     1. 现金/持仓/成本非负；冻结不越界（reservedCash ≤ cash、reservedQty ≤ qty）
//     2. 冻结账实相符：账本冻结额 ≡ 所有 resting 挂单冻结额合计（现金与持仓分项）
//     3. 订单状态一致：filled 必有成交明细；resting 必有 GFD 有效期；
//        pending 滞留 >1h 视为异常；非 resting 订单不得仍占用冻结额
//     4. 净值快照现金项与账本一致
//   并入每日自检（runMaintenance 第 5 节）+ GET /api/paper/reconcile 即时自查。
// ─────────────────────────────────────────────────────────────

function reconcileAccount(uid, state) {
  const issues = [];
  const acc = state.accounts[uid];
  if (!acc) return issues;
  const positions = state.positions[uid] || [];

  // 1. 基本不变量
  if (!(acc.cash >= 0)) issues.push(`现金为负: ${acc.cash}`);
  if ((acc.reservedCash || 0) > acc.cash + 1e-6) {
    issues.push(`冻结现金 ${acc.reservedCash} 超过现金 ${acc.cash}`);
  }
  for (const p of positions) {
    if (!(p.qty > 0)) issues.push(`持仓数量异常 ${p.symbol}: ${p.qty}`);
    if (!(p.avgCost >= 0)) issues.push(`${p.symbol} 成本异常: ${p.avgCost}`);
    if ((p.reservedQty || 0) > p.qty + 1e-6) {
      issues.push(`${p.symbol} 冻结股数 ${p.reservedQty} 超过持仓 ${p.qty}`);
    }
  }

  // 2. 冻结账实相符（挂单合计 vs 账本）
  const orders = state.orders[uid] || [];
  const resting = orders.filter((o) => o.status === 'resting');
  const orderReservedCash = resting.reduce((s, o) => s + (o.reservedCash || 0), 0);
  if (Math.abs(orderReservedCash - (acc.reservedCash || 0)) > 0.01) {
    issues.push(`冻结现金账实不符：账本 ${acc.reservedCash || 0} vs 挂单合计 ${+orderReservedCash.toFixed(2)}`);
  }
  const reservedQtyBySym = {};
  for (const o of resting) {
    if (o.side === 'sell' && o.reservedQty) reservedQtyBySym[o.symbol] = (reservedQtyBySym[o.symbol] || 0) + o.reservedQty;
  }
  for (const p of positions) {
    if (Math.abs((reservedQtyBySym[p.symbol] || 0) - (p.reservedQty || 0)) > 1e-6) {
      issues.push(`${p.symbol} 冻结股数账实不符：账本 ${p.reservedQty || 0} vs 挂单合计 ${reservedQtyBySym[p.symbol] || 0}`);
    }
  }

  // 3. 订单状态一致性
  for (const o of orders) {
    if (o.status === 'filled' && (!o.fills || o.fills.length === 0)) {
      issues.push(`订单 ${o.id} 已成交但无成交明细`);
    }
    if (o.status === 'resting' && !o.validUntil) {
      issues.push(`挂单 ${o.id} 缺 GFD 有效期`);
    }
    if ((o.reservedCash || 0) > 0 && o.status !== 'resting') {
      issues.push(`订单 ${o.id} 状态 ${o.status} 仍占用冻结资金 ${(o.reservedCash).toFixed(2)}`);
    }
    if ((o.reservedQty || 0) > 0 && o.status !== 'resting') {
      issues.push(`订单 ${o.id} 状态 ${o.status} 仍占用冻结持仓`);
    }
    if (o.status === 'pending' && Date.now() - new Date(o.createdAt).getTime() > 3600_000) {
      issues.push(`订单 ${o.id} pending 滞留超 1 小时`);
    }
  }

  // 4. 净值快照现金项与账本一致（市值项用最新行情，与 avgCost 口径允许真实差异，不查）
  const eq = state.equity[uid] || [];
  const last = eq[eq.length - 1];
  if (last && Math.abs((last.cash || 0) - acc.cash) > 0.01) {
    issues.push(`净值快照现金(${last.cash}) 与账本(${acc.cash}) 不一致`);
  }
  return issues;
}

/** 对全部账户对账；返回 {ok, checkedAt, accounts, issueCount, issues} */
function reconcileAll(store) {
  const out = {};
  let count = 0;
  for (const uid of Object.keys(store.state.accounts || {})) {
    count += 1;
    const issues = reconcileAccount(uid, store.state);
    if (issues.length) out[uid] = issues;
  }
  const issueCount = Object.values(out).reduce((s, a) => s + a.length, 0);
  return {
    ok: issueCount === 0,
    checkedAt: new Date().toISOString(),
    accounts: count,
    issueCount,
    issues: out,
  };
}

module.exports = { reconcileAccount, reconcileAll };
