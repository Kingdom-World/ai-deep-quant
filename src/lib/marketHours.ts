// ─────────────────────────────────────────────────────────────
// 交易时段判断（前端展示用）：按北京时间计算
//   · 让"数据没变"在休市日有明确解释，而不是看起来像故障
//   · 与后端 server/paper/strategies.cjs 的 isMarketOpen 口径一致（近似值）
//   · CN 法定节假日与后端共用同一份数据（shared/cn-holidays.json）
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import cnHolidays from '../../shared/cn-holidays.json';

export type MarketCode = 'CN' | 'HK' | 'US';

/** 北京日期字符串（YYYY-MM-DD）：beijingNow 已把时间戳平移为北京时间，直接取本地字段即可 */
function beijingDateString(bj: Date): string {
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())}`;
}

/** CN 是否为法定节假日（数据与后端 server/calendar.cjs 同源） */
function isCnHoliday(bj: Date): boolean {
  const s = beijingDateString(bj);
  const list = (cnHolidays.years as Record<string, string[]>)[s.slice(0, 4)];
  return Array.isArray(list) && list.includes(s.slice(5));
}

export interface MarketStatus {
  /** 当前是否处于可交易时段 */
  open: boolean;
  /** 状态短语：交易中 / 午间休市 / 未开盘 / 已收盘 / 周末休市 */
  label: string;
  /** 给用户的一句话解释 */
  detail: string;
}

/** 当前北京时间（不受本机时区影响） */
function beijingNow(now: Date): Date {
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60_000);
}

/**
 * 分钟级时钟兜底：即使轮询静默失败（无状态更新、页面不重渲染），
 * 状态徽章也会每 30 秒强制重算一次，保证"周末休市/交易中"永不挂错。
 */
export function useMinuteTick(ms = 30_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return tick;
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

  if (market === 'CN' && isCnHoliday(bj)) {
    return {
      open: false,
      label: '节假日休市',
      detail: '今天是法定节假日，A股休市，行情数据停留在最近一个交易日的收盘状态',
    };
  }

  if (market === 'CN') {
    if (mins < 555) return { open: false, label: '未开盘', detail: 'A股尚未开盘，早盘 9:15 开始（当前数据为上一交易日收盘价）' };
    if (mins >= 555 && mins < 700) return { open: true, label: '交易中', detail: 'A股上午盘（9:15-11:35）' };
    if (mins >= 700 && mins < 775) return { open: false, label: '午间休市', detail: 'A股午间休市（11:40-13:00）' };
    if (mins >= 775 && mins <= 905) return { open: true, label: '交易中', detail: 'A股下午盘（13:00-15:05）' };
    return { open: false, label: '已收盘', detail: 'A股今日已收盘，数据为最近交易日收盘价' };
  }
  if (market === 'HK') {
    if (mins < 555) return { open: false, label: '未开盘', detail: '港股尚未开盘（9:30 开始）' };
    if (mins >= 555 && mins < 720) return { open: true, label: '交易中', detail: '港股上午盘（9:30-12:00）' };
    if (mins >= 720 && mins < 780) return { open: false, label: '午间休市', detail: '港股午间休市（12:00-13:00）' };
    if (mins >= 780 && mins <= 970) return { open: true, label: '交易中', detail: '港股下午盘（13:00-16:10）' };
    return { open: false, label: '已收盘', detail: '港股已收盘，数据为最近交易日收盘价' };
  }
  // 美股：北京时间约 21:25 - 次日 04:05（简化处理，未细分夏令时）
  if (mins >= 1285 || mins <= 245) return { open: true, label: '交易中', detail: '美股夜间交易时段（北京时间）' };
  if (mins < 555) return { open: false, label: '已收盘', detail: '美股已收盘，数据为最近交易日收盘价' };
  return { open: false, label: '盘前', detail: '美股盘前时段（北京时间夜间开盘）' };
}

/** 状态徽章的颜色：交易中=红(开盘活跃)，休市=灰 */
export function statusColor(status: MarketStatus): string {
  return status.open ? '#ef4444' : '#94a3b8';
}
