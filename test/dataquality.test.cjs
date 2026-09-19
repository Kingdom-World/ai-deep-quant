// ─────────────────────────────────────────────────────────────
// 数据质量三断言单元测试（评审 P1-5）
//   缺日检测依赖真实交易日历（data/calendar.json，Baostock 同步 2025-2027）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { checkKlines, findMissingDays } = require('../server/dataquality.cjs');

const okRow = (date, close = 10, extra = {}) => ({
  date,
  open: close - 0.1,
  high: close + 0.2,
  low: close - 0.2,
  close,
  volume: 1000,
  ...extra,
});

test('正常序列通过三断言', () => {
  const rows = [
    okRow('2026-09-07', 10, { pctChg: 1.2 }),
    okRow('2026-09-08', 10.1, { pctChg: 1.0 }),
    okRow('2026-09-09', 10.0, { pctChg: -0.99 }),
  ];
  assert.deepEqual(checkKlines(rows, { symbol: 'X' }), []);
});

test('OHLC 有效性：high < max(open,close) 与非正价格被抓出', () => {
  const rows = [
    okRow('2026-09-07', 10),
    { date: '2026-09-08', open: 10, high: 9.5, low: 9, close: 10.2, volume: 100 }, // high < close
    { date: '2026-09-09', open: 0, high: 10, low: 9, close: 10, volume: 100 }, // open=0
  ];
  const issues = checkKlines(rows, { symbol: 'X' });
  assert.equal(issues.filter((i) => i.code === 'ohlc').length, 2);
});

test('涨跌幅越界：优先用官方 pctChg（不复权序列除权日不误报）', () => {
  // 除权日：close 从 20 → 9.5（-52.5%），但官方 pctChg=-0.9（除权后真实跌幅仅 0.9%）
  const rows = [
    okRow('2026-09-07', 20, { pctChg: 0.5 }),
    okRow('2026-09-08', 9.5, { pctChg: -0.9 }), // 比值口径会算出 -52.5%，pctChg 口径正确放行
  ];
  assert.deepEqual(checkKlines(rows, { symbol: 'X' }), []);
});

test('涨跌幅越界：无 pctChg 时用比值口径（复权序列），跳变被抓出', () => {
  const rows = [
    okRow('2026-09-07', 10),
    okRow('2026-09-08', 15), // +50%
  ];
  const issues = checkKlines(rows, { symbol: 'X' });
  assert.equal(issues.filter((i) => i.code === 'pct').length, 1);
  assert.ok(issues[0].detail.includes('50.00%'));
});

test('交易日缺口：跳过周二被按日历抓出', () => {
  // 2026-09-07(周一) 09-08(周二) 09-09(周三) 09-11(周五)——缺 09-08？此处构造缺 09-08 与 09-10
  const rows = [
    okRow('2026-09-07'),
    okRow('2026-09-09'), // 缺 09-08（周二，交易日）
    okRow('2026-09-11'), // 缺 09-10（周四，交易日）
  ];
  const missing = findMissingDays(rows);
  assert.deepEqual(missing, ['2026-09-08', '2026-09-10']);
});

test('交易日缺口：周末与节假日不算缺失', () => {
  const rows = [okRow('2026-09-11'), okRow('2026-09-14')]; // 周五 → 周一，中间是周末
  assert.deepEqual(findMissingDays(rows), []);
});

test('空序列与单根序列不误报', () => {
  assert.deepEqual(findMissingDays([]), []);
  assert.deepEqual(findMissingDays([okRow('2026-09-11')]), []);
  assert.deepEqual(findMissingDays(null), []);
  assert.equal(checkKlines([], { symbol: 'X' }).length, 1);
});
