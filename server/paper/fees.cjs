// ─────────────────────────────────────────────────────────────
// 手续费引擎（佣金万2.5、印花税万5、过户费0.001%、最低 5 元）
//   · A股：佣金 = max(成交额 × 0.025%, 5元)；印花税 = 卖出成交额 × 0.05%
//          （2023-08-28 起证券交易印花税减半征收，此前的千 1 为旧税率）；
//          过户费 = 成交额 × 0.001%（双边收取，沪深统一费率）
//   · 港/美股：简化为同等佣金（币种按账户计价），印花税/过户费 0；如需精确可扩展 SCHEDULES
// ─────────────────────────────────────────────────────────────
const SCHEDULES = {
  // transferFeeRate：过户费，买卖双向按成交额收取（2022-04 起沪深统一为 0.001%）
  CN: { commissionRate: 0.00025, commissionMin: 5, stampTaxRate: 0.0005, stampTaxOnSellOnly: true, transferFeeRate: 0.00001 },
  HK: { commissionRate: 0.00025, commissionMin: 5, stampTaxRate: 0, stampTaxOnSellOnly: true, transferFeeRate: 0 },
  US: { commissionRate: 0.00025, commissionMin: 5, stampTaxRate: 0, stampTaxOnSellOnly: true, transferFeeRate: 0 },
};

/** @param {'CN'|'HK'|'US'} market @param {'buy'|'sell'} side @param {number} value 成交金额 */
function calcFees(market, side, value) {
  const s = SCHEDULES[market] || SCHEDULES.CN;
  const commission = Math.max(value * s.commissionRate, s.commissionMin);
  const stampTax = side === 'sell' && s.stampTaxOnSellOnly ? value * s.stampTaxRate : 0;
  const transferFee = value * (s.transferFeeRate || 0);
  return {
    commission: +commission.toFixed(2),
    stampTax: +stampTax.toFixed(2),
    transferFee: +transferFee.toFixed(2),
    total: +(commission + stampTax + transferFee).toFixed(2),
  };
}

function marketOf(symbol) {
  const s = String(symbol).toLowerCase().trim();
  if (/^(sh|sz|bj)/.test(s)) return 'CN';
  if (/^hk/.test(s)) return 'HK';
  if (/^\d{6}$/.test(s)) return 'CN'; // 裸 6 位代码按 A 股（沪 6 / 深 0·3 / 北 92·83·87·43），此前被误归美股致 T+1 与费率失效
  return 'US';
}

module.exports = { calcFees, marketOf, SCHEDULES };
