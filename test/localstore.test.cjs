// ─────────────────────────────────────────────────────────────
// 本地日历 / 本地归档读取层单元测试（Baostock 同步管线的 Node 侧消费）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── 日历：本地交易日集合优先，覆盖范围外回退硬编码表 ──
const tmpCal = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-local-'));
const calFile = path.join(tmpCal, 'calendar.json');
// 假日历：覆盖 2026-10-01 ~ 2026-10-12，且故意把硬编码表中休市的 10-02 标为交易日（验证优先级）
fs.writeFileSync(
  calFile,
  JSON.stringify({ tradingDays: ['2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09'] }),
);
process.env.CALENDAR_LOCAL_FILE = calFile;
const { isCnTradingDay, isCnHoliday, nextCnTradingDay } = require('../server/calendar.cjs');

test('Baostock 本地日历：覆盖范围内以交易日集合为准（可覆盖硬编码表）', () => {
  assert.equal(isCnTradingDay('2026-10-02'), true, '集合内标为交易日 → 以集合为准');
  assert.equal(isCnTradingDay('2026-10-01'), false, '工作日不在集合 → 休市');
  assert.equal(isCnTradingDay('2026-10-10'), false, '周末不在集合 → 休市');
  assert.equal(isCnHoliday('2026-10-01'), true);
  assert.equal(isCnHoliday('2026-10-02'), false);
});

test('覆盖范围外回退硬编码节假日表', () => {
  // 2026-09-25（中秋，硬编码表含）在本地日历范围（10 月）之外
  assert.equal(isCnTradingDay('2026-09-25'), false);
  assert.equal(isCnTradingDay('2026-09-24'), true);
});

test('nextCnTradingDay：跳过周末与休市日', () => {
  assert.equal(nextCnTradingDay('2026-10-07'), '2026-10-09'); // 跳过 10-08（不在假集合）
  assert.equal(nextCnTradingDay('2026-10-09'), '2026-10-12'); // 下一周（假集合中 10-12 之后无数据 → 覆盖范围外回退）
});

// ── 本地归档读取层 ──
const tmpHist = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-local-'));
process.env.LOCAL_HISTORY_DIR = tmpHist;
const localstore = require('../server/localstore.cjs');

test('getLocalKline：读取归档、按 count 截尾、坏数据过滤', () => {
  fs.writeFileSync(
    path.join(tmpHist, 'sh600519.json'),
    JSON.stringify({
      code: 'sh600519',
      rows: [
        { date: '2026-01-01', open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
        { date: '2026-01-02', open: 10.5, high: 11, low: 10, close: 10.8, volume: 120 },
        { date: '2026-01-05', open: 10.8, high: 11.2, low: 10.7, close: 11, volume: 130 },
        { date: 'bad', open: 1, high: 1, low: 1, close: NaN, volume: 0 }, // 坏行应被过滤
      ],
    }),
  );
  const rows = localstore.getLocalKline('sh600519', 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-01-02', '应取最后 count 根');
  assert.equal(rows[1].close, 11);
  assert.ok(!rows.some((r) => !Number.isFinite(r.close)), 'NaN close 的坏行被过滤');
});

test('getLocalKline：无归档返回 null（调用方继续走上游），不抛错', () => {
  assert.equal(localstore.getLocalKline('sz999999', 100), null);
});

test('localArchiveInfo：统计归档文件数', () => {
  assert.equal(localstore.localArchiveInfo().count, 1);
});
