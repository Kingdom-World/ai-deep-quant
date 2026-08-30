// ─────────────────────────────────────────────────────────────
// 手续费引擎（要求：佣金万2.5、印花税千1、最低 5 元）
//   · A股：佣金 = max(成交额 × 0.025%, 5元)，印花税 = 卖出成交额 × 0.1%
//   · 港/美股：简化为同等佣金（币种按账户计价），印花税 0；如需精确可扩展 SCHEDULES
// ─────────────────────────────────────────────────────────────
const SCHEDULES = {
  CN: { commissionRate: 0.00025, commissionMin: 5, stampTaxRate: 0.001, stampTaxOnSellOnly: true },
  HK: { commissionRate: 0.00025, commissionMin: 5, stampTaxRate: 0, stampTaxOnSellOnly: true },
  US: { commissionRate: 0.00025, commissionMin: 5, stampTaxRate: 0, stampTaxOnSellOnly: true },
};

/** @param {'CN'|'HK'|'US'} market @param {'buy'|'sell'} side @param {number} value 成交金额 */
function calcFees(market, side, value) {
  const s = SCHEDULES[market] || SCHEDULES.CN;
  const commission = Math.max(value * s.commissionRate, s.commissionMin);
  const stampTax = side === 'sell' && s.stampTaxOnSellOnly ? value * s.stampTaxRate : 0;
  return {
    commission: +commission.toFixed(2),
    stampTax: +stampTax.toFixed(2),
    total: +(commission + stampTax).toFixed(2),
  };
}

function marketOf(symbol) {
  const s = String(symbol).toLowerCase();
  if (/^(sh|sz|bj)/.test(s)) return 'CN';
  if (/^hk/.test(s)) return 'HK';
  return 'US';
}

module.exports = { calcFees, marketOf, SCHEDULES };
