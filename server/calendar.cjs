// ─────────────────────────────────────────────────────────────
// A 股交易日历（法定节假日休市判断）
//   · 数据优先级：data/calendar.json（Baostock query_trade_dates 每日同步，覆盖范围内以集合为准）
//                → shared/cn-holidays.json（官方 2026 硬编码表，兜底）
//   · 背景：模拟盘此前仅判断周末，法定节假日期间撮合循环与策略引擎照常运行，
//     会以停更的上一交易日价格反复伪成交，绩效被系统性污染（评审致命缺陷 #2）
//   · 全部判断按北京日历（Asia/Shanghai），与 T+1 日切口径一致
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const HOLIDAYS = require('../shared/cn-holidays.json');

const LOCAL_CAL_FILE = process.env.CALENDAR_LOCAL_FILE || path.join(__dirname, '..', 'data', 'calendar.json');

let localCal = null; // { mtime, set: Set<'YYYY-MM-DD'>, min, max }

/** 加载 Baostock 同步的交易日历（mtime 变化自动重读，测试可用 CALENDAR_LOCAL_FILE 覆盖） */
function loadLocalCalendar() {
  try {
    const st = fs.statSync(LOCAL_CAL_FILE);
    if (!localCal || localCal.mtime !== st.mtimeMs) {
      const doc = JSON.parse(fs.readFileSync(LOCAL_CAL_FILE, 'utf8'));
      const days = Array.isArray(doc.tradingDays)
        ? doc.tradingDays.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
        : [];
      localCal = days.length
        ? { mtime: st.mtimeMs, set: new Set(days), min: days[0], max: days[days.length - 1] }
        : null;
    }
  } catch {
    localCal = null;
  }
  return localCal;
}

/** 北京日期字符串（YYYY-MM-DD）：T+1 解锁、当日盈亏日切、节假日判断统一用北京日历 */
function cnDateString(date = new Date()) {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** 硬编码表兜底：是否法定节假日（仅含已收录年份的工作日休市日） */
function isTableHoliday(s) {
  const list = HOLIDAYS.years[s.slice(0, 4)];
  return Array.isArray(list) && list.includes(s.slice(5));
}

function weekdayOf(s, date) {
  const d = typeof date === 'string' ? new Date(`${s}T12:00:00+08:00`) : date;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(d);
}

/**
 * 指定日期是否为 A 股法定节假日
 * @param {Date|string} date Date 对象或 'YYYY-MM-DD' 字符串（按北京日历解释）
 */
function isCnHoliday(date = new Date()) {
  const s = typeof date === 'string' ? date : cnDateString(date);
  const cal = loadLocalCalendar();
  if (cal && s >= cal.min && s <= cal.max) {
    if (weekdayOf(s, date) === 'Sat' || weekdayOf(s, date) === 'Sun') return false;
    return !cal.set.has(s); // 权威交易日集合：工作日不在集合 = 休市（调休/临时休市自动正确）
  }
  return isTableHoliday(s);
}

/** 是否为 A 股交易日（周一~五且非法定节假日；调休上班的周末仍休市） */
function isCnTradingDay(date = new Date()) {
  const s = typeof date === 'string' ? date : cnDateString(date);
  const cal = loadLocalCalendar();
  if (cal && s >= cal.min && s <= cal.max) return cal.set.has(s);
  const wd = weekdayOf(s, date);
  if (wd === 'Sat' || wd === 'Sun') return false;
  return !isTableHoliday(s);
}

/** 下一个交易日（含当日为交易日时返回当日）；用于隔夜委托的有效期推算 */
function nextCnTradingDay(s) {
  let d = typeof s === 'string' ? new Date(`${s}T12:00:00+08:00`) : new Date(s.getTime());
  for (let i = 0; i < 30; i++) {
    d = new Date(d.getTime() + 24 * 3600 * 1000);
    if (isCnTradingDay(d)) return cnDateString(d);
  }
  return null;
}

module.exports = { cnDateString, isCnHoliday, isCnTradingDay, nextCnTradingDay };
