// ─────────────────────────────────────────────────────────────
// 交易时段判断（前端展示用）：按北京时间计算
//   · 让"数据没变"在休市日有明确解释，而不是看起来像故障
//   · 与后端 server/paper/strategies.cjs 的 isMarketOpen 口径一致（近似值）
// ─────────────────────────────────────────────────────────────
export type MarketCode = 'CN' | 'HK' | 'US';

export interface MarketStatus {
  /** 当前是否处于可交易时段 */
  open: boolean;
  /** 状态短语：交易中 / 午间休市 / 已收盘 / 周末休市 */
  label: string;
  /** 给用户的一句话解释 */
  detail: string;
}

/** 当前北京时间（不受本机时区影响） */
function beijingNow(now: Date): Date {
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60_000);
}

export function getMarketStatus(market: MarketCode, now: Date = new Date()): MarketStatus {
  const bj = beijingNow(now);
  const day = bj.getDay();
  const mins = bj.getHours() * 60 + bj.getMinutes();

  if (day === 0 || day === 6) {
    return {
      open: false,
      label: '周末休市',
      detail: '今天是周末，市场休市，行情数据停留在最近一个交易日的收盘状态（属正常现象，周一开盘自动恢复）',
    };
  }

  if (market === 'CN') {
    if (mins >= 555 && mins < 700) return { open: true, label: '交易中', detail: 'A股上午盘（9:15-11:35）' };
    if (mins >= 700 && mins < 775) return { open: false, label: '午间休市', detail: 'A股午间休市（11:40-13:00）' };
    if (mins >= 775 && mins <= 905) return { open: true, label: '交易中', detail: 'A股下午盘（13:00-15:05）' };
    return { open: false, label: '已收盘', detail: 'A股今日已收盘，数据为最近交易日收盘价' };
  }
  if (market === 'HK') {
    if (mins >= 555 && mins < 720) return { open: true, label: '交易中', detail: '港股上午盘（9:15-12:00）' };
    if (mins >= 720 && mins < 780) return { open: false, label: '午间休市', detail: '港股午间休市（12:00-13:00）' };
    if (mins >= 780 && mins <= 970) return { open: true, label: '交易中', detail: '港股下午盘（13:00-16:10）' };
    return { open: false, label: '已收盘', detail: '港股已收盘，数据为最近交易日收盘价' };
  }
  // 美股：北京时间约 21:25 - 次日 04:05（简化处理，未细分夏令时）
  if (mins >= 1285 || mins <= 245) return { open: true, label: '交易中', detail: '美股夜间交易时段（北京时间）' };
  return { open: false, label: '已收盘', detail: '美股已收盘，数据为最近交易日收盘价' };
}

/** 状态徽章的颜色：交易中=红(开盘活跃)，休市=灰 */
export function statusColor(status: MarketStatus): string {
  return status.open ? '#ef4444' : '#94a3b8';
}
