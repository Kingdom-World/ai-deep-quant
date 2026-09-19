// ─────────────────────────────────────────────────────────────
// A 股交易日历单元测试
//   数据基准：国办发明电〔2025〕7号《国务院办公厅关于2026年部分节假日安排的通知》
//   重点：堵住「长假期间模拟盘以停更价格伪成交」的缺陷（评审致命缺陷 #2）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { cnDateString, isCnHoliday, isCnTradingDay } = require('../server/calendar.cjs');
const { canFill, canQueue, sessionLabel } = require('../server/paper/sessions.cjs');

test('cnDateString 按北京日历输出（UTC 17:00 已是北京次日）', () => {
  assert.equal(cnDateString(new Date('2026-10-01T17:00:00Z')), '2026-10-02');
  assert.equal(cnDateString(new Date('2026-10-01T15:59:00Z')), '2026-10-01');
});

test('2026 全部法定节假日的工作日部分均判定为休市', () => {
  const closed = [
    '2026-01-01', '2026-01-02', // 元旦（周四/周五；周六起本就是周末）
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', // 春节（周一~周五+次周一）
    '2026-04-06', // 清明（周一）
    '2026-05-01', '2026-05-04', '2026-05-05', // 劳动节（周五+周一+周二）
    '2026-06-19', // 端午（周五）
    '2026-09-25', // 中秋（周五）
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆（周四/五/一二三）
  ];
  for (const d of closed) {
    assert.equal(isCnHoliday(d), true, `${d} 应为节假日`);
    assert.equal(isCnTradingDay(d), false, `${d} 应休市`);
  }
});

test('调休上班的周末 A 股仍休市（周末天然休市）', () => {
  // 国务院安排 2026-10-10（周六）上班，但交易所周末不交易
  assert.equal(isCnTradingDay('2026-10-10'), false);
  assert.equal(isCnTradingDay('2026-02-14'), false);
});

test('假期后首个交易日正常开市', () => {
  assert.equal(isCnTradingDay('2026-10-09'), true); // 国庆后首个周五
  assert.equal(isCnTradingDay('2026-09-14'), true); // 周一
  assert.equal(isCnHoliday('2026-10-09'), false);
});

test('sessions.canFill：节假日交易时段不再产生伪成交', () => {
  // 2026-10-01 周四 10:30（连续竞价时段内）——旧逻辑在此会判定可成交
  assert.equal(canFill('CN', new Date('2026-10-01T10:30:00+08:00')), false);
  // 假期后首个交易日的同一时刻正常
  assert.equal(canFill('CN', new Date('2026-10-09T10:30:00+08:00')), true);
});

test('sessions.canQueue：节假日不接收委托', () => {
  assert.equal(canQueue('CN', new Date('2026-10-01T09:20:00+08:00')), false);
  assert.equal(canQueue('CN', new Date('2026-10-09T09:20:00+08:00')), true);
});

test('sessionLabel：节假日返回明确标签而非"交易时段"', () => {
  const label = sessionLabel('CN', new Date('2026-10-01T10:30:00+08:00'));
  assert.ok(label.includes('节假日'), `label=${label}`);
});
