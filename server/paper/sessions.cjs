// ─────────────────────────────────────────────────────────────
// 交易时段引擎（模拟盘时间规范：与真实股市一致的时段约束）
//   · CN  A股：交易日（周一~五）集合竞价 9:15-9:25 → 连续竞价 9:30-11:30 / 13:00-15:00（北京时间）
//   · HK  港股：连续竞价 9:30-12:00 / 13:00-16:00（香港时间）
//   · US  美股：常规时段 9:30-16:00（纽约时间，自动处理夏令时）
//   · 规则：市价单只能在连续竞价时段成交；限价单随时可挂，但只在连续竞价时段撮合
//   · 节假日：CN 已接入法定节假日日历（shared/cn-holidays.json，国办发明电〔2025〕7号），
//     节假日全天不可成交/挂单；港美股节假日暂未收录
//   · PAPER_TRADE_247=1 时全部时段视为可交易（测试用，与策略引擎同一开关）
// ─────────────────────────────────────────────────────────────
const { isCnHoliday } = require('../calendar.cjs');
const TZ = { CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', US: 'America/New_York' };

/** 用时区安全的方式取某市场当前的本地时间字段（Intl 自动处理夏令时） */
function localFields(market, date = new Date()) {
  const tz = TZ[market] || TZ.CN;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const weekday = parts.weekday; // Mon/Tue/.../Sun
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // 有些 ICU 午夜输出 24
  const minute = Number(parts.minute);
  return { weekday, hour, minute, t: hour * 60 + minute };
}

/** 市场是否可成交（连续竞价时段内） */
function canFill(market, date = new Date()) {
  if (String(process.env.PAPER_TRADE_247 || '') === '1') return true;
  const { weekday, t } = localFields(market, date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  if (market === 'CN' && isCnHoliday(date)) return false; // 法定节假日全天休市（防止长假伪撮合）
  if (market === 'CN') return (t >= 570 && t < 690) || (t >= 780 && t < 900); // 9:30-11:30 / 13:00-15:00
  if (market === 'HK') return (t >= 570 && t < 720) || (t >= 780 && t < 960); // 9:30-12:00 / 13:00-16:00
  return t >= 570 && t < 960; // US 9:30-16:00
}

/** 市场是否可挂限价单（含集合竞价/午间；收盘后到次日竞价前不接受，避免跨多日陈旧挂单误解） */
function canQueue(market, date = new Date()) {
  if (String(process.env.PAPER_TRADE_247 || '') === '1') return true;
  if (canFill(market, date)) return true;
  const { weekday, t } = localFields(market, date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  if (market === 'CN' && isCnHoliday(date)) return false; // 节假日不收委托
  if (market === 'CN') return t >= 555 && t < 900; // 9:15-15:00（含集合竞价与午间）
  if (market === 'HK') return t >= 555 && t < 960; // 9:15-16:00
  return t >= 555 && t < 960; // US 9:15-16:00（简化）
}

/** 当前时段描述（拒单理由/页面提示用） */
function sessionLabel(market, date = new Date()) {
  const name = { CN: 'A股', HK: '港股', US: '美股' }[market] || market;
  if (String(process.env.PAPER_TRADE_247 || '') === '1') return `${name}（测试模式：全天可交易）`;
  if (canFill(market, date)) return `${name}交易时段`;
  const { weekday, t } = localFields(market, date);
  if (weekday === 'Sat' || weekday === 'Sun') return `${name}周末休市`;
  if (market === 'CN' && isCnHoliday(date)) return `${name}法定节假日休市`;
  if (market === 'CN') {
    if (t >= 555 && t < 570) return `${name}集合竞价时段（9:15-9:25）`;
    if (t >= 570 && t < 590) return `${name}竞价撮合时段（9:25-9:30）`;
    if (t >= 690 && t < 780) return `${name}午间休市（11:30-13:00）`;
    if (t >= 900) return `${name}已收盘`;
    return `${name}未开盘`;
  }
  if (market === 'HK') {
    if (t >= 690 && t < 780) return `${name}午间休市（12:00-13:00）`;
    if (t >= 960) return `${name}已收盘`;
    return `${name}未开盘`;
  }
  if (t >= 960 || t < 240) return `${name}已收盘`;
  return `${name}未开盘`;
}

module.exports = { canFill, canQueue, sessionLabel, localFields };
