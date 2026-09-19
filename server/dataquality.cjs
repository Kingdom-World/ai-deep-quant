// ─────────────────────────────────────────────────────────────
// 数据质量三断言（评审 P1-5）：OHLC 有效性 / 涨跌幅越界 / 交易日缺口
//   · 此前平台对数据本身零校验（无 high>=low、无缺日、无跨源对账），
//     坏数据会静默流入图表与回测。本模块供每日自检与归档同步后调用。
//   · 涨跌幅口径（关键）：不复权序列在除权除息日会有真实的巨幅跳空，
//     不能用 close/prevClose 断言——优先用行情源提供的官方 pctChg 字段
//     （Baostock 归档自带）；仅当无 pctChg（如已复权的前端序列）才用比值。
// ─────────────────────────────────────────────────────────────
const { isCnTradingDay, cnDateString } = require('./calendar.cjs');

/**
 * 校验日线序列
 * @param rows [{date, open, high, low, close, volume, pctChg?}]
 * @param opts { symbol?, pctCap?=31（涨跌幅上限%，覆盖北交所 30%+缓冲） }
 * @returns [{code:'ohlc'|'pct', detail}]，空数组=通过
 */
function checkKlines(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [{ code: 'empty', detail: 'K线为空' }];
  const { symbol = '', pctCap = 31 } = opts;
  const issues = [];
  let prev = null;
  for (const r of rows) {
    const tag = `${symbol || 'K线'} ${r.date}`;
    const { open, high, low, close } = r;
    if ([open, high, low, close].some((v) => !Number.isFinite(v) || v <= 0)) {
      issues.push({ code: 'ohlc', detail: `${tag} 存在非正/缺失价格` });
      prev = r;
      continue;
    }
    if (high < Math.max(open, close) - 1e-9) {
      issues.push({ code: 'ohlc', detail: `${tag} high(${high}) < max(open,close)` });
    }
    if (low > Math.min(open, close) + 1e-9) {
      issues.push({ code: 'ohlc', detail: `${tag} low(${low}) > min(open,close)` });
    }
    let chg = null;
    if (Number.isFinite(r.pctChg)) {
      chg = Math.abs(r.pctChg); // 官方口径：已剔除除权影响
    } else if (prev && Number.isFinite(prev.close) && prev.close > 0) {
      chg = Math.abs(close / prev.close - 1) * 100; // 复权序列口径
    }
    if (chg !== null && chg > pctCap) {
      issues.push({ code: 'pct', detail: `${tag} 涨跌幅 ${chg.toFixed(2)}% 超过 ${pctCap}% 上限` });
    }
    prev = r;
  }
  return issues;
}

/**
 * 交易日缺口检测（A 股）：在 rows 首末日期之间按交易日历找缺失
 * @returns 缺失交易日数组（最多报告 maxReport 条由调用方截取）
 */
function findMissingDays(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const dates = new Set(rows.map((r) => String(r.date).slice(0, 10)));
  const missing = [];
  const step = (s) => cnDateString(new Date(new Date(`${s}T12:00:00+08:00`).getTime() + 86400000));
  let d = String(rows[0].date).slice(0, 10);
  const end = String(rows[rows.length - 1].date).slice(0, 10);
  for (let guard = 0; d <= end && guard < 15000; guard++) {
    if (isCnTradingDay(d) && !dates.has(d)) missing.push(d);
    d = step(d);
  }
  return missing;
}

module.exports = { checkKlines, findMissingDays };
