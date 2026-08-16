// ─────────────────────────────────────────────────────────────
// AI深度量化 · 共享数据层
// 市场识别 / 周期定义 / 量化计算（纯函数，无网络与 SDK 依赖，
// 所有行情数据均来自独立后端 server/index.cjs）
// ─────────────────────────────────────────────────────────────

export type Market = 'US' | 'CN' | 'HK';

/** 技术指标/统计使用的最近交易日窗口 */
export const HISTORY_COUNT = 30;
/** 实时轮询间隔（毫秒） */
export const POLL_INTERVAL = 10_000;
/** 实时小图最多保留点数（120 × 10s ≈ 20 分钟窗口） */
export const REALTIME_MAX_POINTS = 120;

/** 货币符号（按市场动态切换） */
export const currencyFor = (m: Market) => (m === 'US' ? '$' : m === 'HK' ? 'HK$' : '¥');

/**
 * 市场自动识别（支持带交易所前缀的代码）：
 * - `sh`/`sz` 前缀 → A股指数/个股（如 sh000001 上证指数）
 * - `hk` 前缀     → 港股
 * - `us` 前缀     → 美股
 * - 6 位纯数字    → A股（如 600519、002230）
 * - 5 位纯数字    → 港股（如 00700，含前导 0）
 * - 字母组合      → 美股（如 MSFT、AAPL）
 */
export const detectMarket = (symbol: string): Market => {
  const s = symbol.trim().toLowerCase();
  if (s.startsWith('sh') || s.startsWith('sz')) return 'CN';
  if (s.startsWith('hk')) return 'HK';
  if (s.startsWith('us')) return 'US';
  if (/^\d{6}$/.test(symbol)) return 'CN';
  if (/^\d{5}$/.test(symbol)) return 'HK';
  return 'US';
};

/**
 * 剥离交易所前缀，返回裸代码（sh000001 -> 000001，usMSFT -> MSFT）。
 * 用于显示与腾讯代码拼接。
 */
export const stripMarketPrefix = (symbol: string): string => symbol.replace(/^(sh|sz|hk|us)/i, '');

export const marketLabel = (m: Market) => (m === 'US' ? '美股' : m === 'HK' ? '港股' : 'A股');

// 涨跌配色：中国习惯红涨绿跌
export const UP_COLOR = '#ef4444';
export const DOWN_COLOR = '#22c55e';

export interface KlinePoint {
  /** 交易日期 YYYY-MM-DD（分钟 K 为 YYYY-MM-DD HH:mm） */
  date: string;
  /** 开盘价 */
  open: number;
  /** 收盘价 */
  close: number;
  /** 最高价 */
  high: number;
  /** 最低价 */
  low: number;
  /** 成交量 */
  volume: number;
}

/**
 * 主图周期（仅中长周期；分钟周期在短期副图提供）。
 * 日/3日/周/月/季/年 基于日线聚合。
 */
export type Period = 'day' | '3day' | 'week' | 'month' | 'quarter' | 'year';

/** 主图周期配置：按钮文案 / 图表标题 / 聚合点数上限 / 横轴刻度格式 */
export const PERIODS: { key: Period; label: string; title: string; limit: number; tick: string }[] =
  [
    { key: 'day', label: '日', title: '日线', limit: 250, tick: 'MM-DD' },
    { key: '3day', label: '3日', title: '3日线', limit: 60, tick: 'MM-DD' },
    { key: 'week', label: '周', title: '周线', limit: 60, tick: 'MM-DD(周)' },
    { key: 'month', label: '月', title: '月线', limit: 60, tick: 'YYYY-MM' },
    { key: 'quarter', label: '季', title: '季线', limit: 20, tick: 'YYYY-Qn' },
    { key: 'year', label: '年', title: '年线', limit: 10, tick: 'YYYY' },
  ];

/** 分钟级周期（短期副图专用） */
export type MinutePeriod = '1' | '5' | '15' | '30' | '60' | '120';

/** 分钟副图周期配置 */
export const MINUTE_PERIODS: { key: MinutePeriod; label: string; title: string; limit: number }[] =
  [
    { key: '1', label: '1分', title: '1分钟', limit: 240 },
    { key: '5', label: '5分', title: '5分钟', limit: 240 },
    { key: '15', label: '15分', title: '15分钟', limit: 240 },
    { key: '30', label: '30分', title: '30分钟', limit: 240 },
    { key: '60', label: '60分', title: '60分钟', limit: 240 },
    { key: '120', label: '120分', title: '120分钟', limit: 240 },
  ];

/** 聚合后的数据点（供主图 K 线 + 成交量柱使用） */
export interface AggregatedPoint {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  /** 涨跌额（决定成交量柱颜色） */
  change: number;
}

export type PeriodKey = 'today' | 'week' | 'month' | 'ytd';

/** 大盘指数条目（主页市场概况用） */
export interface IndexData {
  /** 指数代码 */
  symbol: string;
  /** 指数名称 */
  name: string;
  /** 最新点位；获取失败为 null */
  price: number | null;
  /** 涨跌幅%；获取失败为 null */
  changePercent: number | null;
}

/** 将底层错误转为友好提示 */
export function friendlyError(symbol: string, err: any): string {
  const msg = err?.message || '';
  if (/fetch failed|network|超时|timeout/i.test(msg)) {
    return `请求失败（网络异常），请稍后重试：${symbol}`;
  }
  if (/未返回|no rows|暂无数据|empty/i.test(msg)) {
    return `该股票暂无数据：${symbol}`;
  }
  return `未找到该股票，请检查代码是否正确：${symbol}`;
}

// ─────────────────────────────────────────────────────────────
// 量化计算函数（纯前端，无额外 API）
// ─────────────────────────────────────────────────────────────

/** 日期工具：Date -> YYYY-MM-DD */
export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** 日期工具：YYYY-MM-DD（或带时间 YYYY-MM-DD HH:mm）-> Date（本地时区） */
export function parseDate(s: string): Date {
  const datePart = String(s).slice(0, 10); // 兼容 "2026-08-14 00:00"
  const [y, m, d] = datePart.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * 周期分组 key：
 * - week   : 所在周的周一日期（周一为一周起点，代表完整交易周）
 * - month  : YYYY-MM（自然月）
 * - quarter: YYYY-Qn（自然季）
 * - year   : YYYY（自然年）
 * - day/3day 周期不分组（滑窗处理）
 */
function periodGroupKey(date: string, period: Period): string {
  if (period === 'week') {
    const d = parseDate(date);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return fmtDate(monday);
  }
  if (period === 'month') return date.slice(0, 7);
  if (period === 'quarter') {
    const q = Math.floor((parseInt(date.slice(5, 7), 10) - 1) / 3) + 1;
    return `${date.slice(0, 4)}-Q${q}`;
  }
  if (period === 'year') return date.slice(0, 4);
  return date;
}

/**
 * 将一组 K 线聚合为单个周期 K 线（专业行情软件标准）：
 * - open   = 组内第一个交易日的开盘价
 * - close  = 组内最后一个交易日的收盘价
 * - high   = 组内所有交易日最高价的最大值
 * - low    = 组内所有交易日最低价的最小值
 * - volume = 组内所有交易日成交量之和
 * - date   = 组内最后一个交易日
 */
function mergeGroup(group: KlinePoint[]): AggregatedPoint {
  const first = group[0];
  const last = group[group.length - 1];
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const p of group) {
    if (p.high > high) high = p.high;
    if (p.low < low) low = p.low;
    volume += p.volume ?? 0;
  }
  return {
    date: last.date,
    open: first.open,
    close: last.close,
    high,
    low,
    volume,
    change: last.close - first.open,
  };
}

/** 将单根 K 线转为聚合点（day 周期直接透传） */
function toAggPoint(p: KlinePoint): AggregatedPoint {
  return {
    date: p.date,
    open: p.open,
    close: p.close,
    high: p.high,
    low: p.low,
    volume: p.volume ?? 0,
    change: (p.close ?? 0) - (p.open ?? 0),
  };
}

/**
 * 数据聚合函数：按周期对日 K 聚合，返回聚合点数组（时间升序）。
 * - day    : 原始 K 线，最近 limit 根
 * - 3day   : 每 3 根聚合为一根（正确 OHLCV 聚合）
 * - week   : 每周聚合为一根（周一为一周起点，取当周完整 OHLCV）
 * - month  : 每月聚合为一根（自然月）
 * - quarter: 每季聚合为一根（自然季）
 * - year   : 每年聚合为一根（自然年）
 */
export function aggregatePoints(data: KlinePoint[], period: Period): AggregatedPoint[] {
  if (!data || data.length === 0) return [];
  const limit = PERIODS.find((p) => p.key === period)?.limit ?? 60;

  // 日线：直接透传原始 K 线
  if (period === 'day') {
    return data.slice(-limit).map(toAggPoint);
  }

  // 3day：每 3 根聚合为一根
  if (period === '3day') {
    const groupSize = 3;
    const sliced = data.slice(-limit * groupSize);
    const out: AggregatedPoint[] = [];
    for (let i = sliced.length; i > 0; i -= groupSize) {
      const grp = sliced.slice(Math.max(0, i - groupSize), i);
      out.unshift(mergeGroup(grp));
    }
    return out;
  }

  // week / month / quarter / year：按周期 key 分组，每组完整聚合 OHLCV
  const groups = new Map<string, KlinePoint[]>();
  for (const p of data) {
    const key = periodGroupKey(p.date, period);
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.values()].slice(-limit).map(mergeGroup);
}

/** 数据聚合函数（供状态使用）：返回聚合后的收盘价数组 */
export function aggregateData(data: KlinePoint[], period: Period): number[] {
  return aggregatePoints(data, period).map((p) => p.close);
}

/**
 * 计算周期变化：基准日（或其后的首个交易日）开盘价 → 最新价 的涨跌幅
 * - today：最新一根 K 线的开盘价
 * - week ：最新交易日所在周的周一
 * - month：最新交易日所在月的 1 日
 * - ytd  ：最新交易日所在年的 1 月 1 日
 * 历史数据不足时返回 null（UI 显示 --）
 */
export function calcPeriodChange(
  data: KlinePoint[],
  latestPrice: number,
  period: PeriodKey,
): number | null {
  const last = data[data.length - 1];
  if (!last || latestPrice == null || !Number.isFinite(latestPrice)) return null;

  // eslint-disable-next-line no-useless-assignment -- 初始 null 用于类型收窄，分支全覆盖
  let baseOpen: number | null = null;

  if (period === 'today') {
    baseOpen = last.open;
  } else {
    const ref = parseDate(last.date);
    let target: Date;
    if (period === 'week') {
      target = new Date(ref);
      target.setDate(ref.getDate() - ((ref.getDay() + 6) % 7)); // 回退到本周一
    } else if (period === 'month') {
      target = new Date(ref.getFullYear(), ref.getMonth(), 1);
    } else {
      target = new Date(ref.getFullYear(), 0, 1);
    }
    const t = fmtDate(target);
    // 基准日当天或之后的首个交易日（处理节假日休市）
    const p = data.find((x) => x.date >= t);
    baseOpen = p?.open ?? null;
  }

  if (baseOpen == null || baseOpen <= 0) return null;
  return parseFloat((((latestPrice - baseOpen) / baseOpen) * 100).toFixed(2));
}

/** 计算 N 日均线（基于最近 N 个收盘价）；数据不足返回 null */
export function calcMA(prices: number[], period: number): number | null {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const avg = slice.reduce((a, b) => a + b, 0) / period;
  return parseFloat(avg.toFixed(2));
}

/**
 * 计算 RSI（相对强弱指数，Wilder 简化平均法）
 * RSI = 100 - 100 / (1 + RS)，RS = 平均上涨幅度 / 平均下跌幅度
 * 数据不足 period+1 个收盘价时返回 null
 */
export function calcRSI(prices: number[], period = 14): number | null {
  if (prices.length < period + 1) return null;
  const closes = prices.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

/** 成交量人性化格式：亿 / 万 */
export function formatVolume(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(Math.round(v));
}

/** 格式化日期为 MM-DD 短标签 */
export const shortDate = (d: string) => d.slice(5);

/** 涨跌幅着色 */
export const pctColor = (value: number | null) => {
  if (value === null) return '#64748b';
  return value >= 0 ? UP_COLOR : DOWN_COLOR;
};

/** 涨跌幅格式化（带符号） */
export const formatPercent = (value: number | null) => {
  if (value === null) return '--';
  return `${value >= 0 ? '+' : ''}${value}%`;
};

// ─────────────────────────────────────────────────────────────
// 技术指标：MACD
// ─────────────────────────────────────────────────────────────

export interface MacdResult {
  /** DIF 快线 */
  dif: (number | null)[];
  /** DEA 慢线 */
  dea: (number | null)[];
  /** MACD 柱（2 × (DIF - DEA)，红绿柱） */
  macd: (number | null)[];
}

/** EMA 计算（指数移动平均） */
function calcEMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (ema === null) {
      ema = values[i];
    } else {
      ema = values[i] * k + ema * (1 - k);
    }
    out.push(Number.isFinite(ema) ? ema : null);
  }
  return out;
}

/**
 * 计算 MACD（12/26/9）
 * DIF = EMA(12) - EMA(26)；DEA = EMA(DIF, 9)；MACD 柱 = 2 × (DIF - DEA)
 */
export function calcMACD(closes: number[]): MacdResult {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const dif: (number | null)[] = closes.map((_, i) => {
    if (ema12[i] === null || ema26[i] === null) return null;
    return ema12[i]! - ema26[i]!;
  });
  const difValues = dif.filter((v): v is number => v !== null);
  const difEma = calcEMA(difValues, 9);
  let di = 0;
  const dea = dif.map((v) => {
    if (v === null) return null;
    const d = difEma[di] ?? null;
    di += 1;
    return d;
  });
  const macd = closes.map((_, i) => {
    if (dif[i] === null || dea[i] === null) return null;
    return 2 * (dif[i]! - dea[i]!);
  });
  return { dif, dea, macd };
}

/** 计算 MA 序列（每个位置的 N 日均线；不足 N 的位置为 null） */
export function calcMASeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i + 1 < period) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    out.push(parseFloat((sum / period).toFixed(2)));
  }
  return out;
}

/**
 * 按周期格式化 K 线横轴刻度标签：
 * - day/3day  : MM-DD（每格 = 1 个交易日）
 * - week      : MM-DD 周（每格 = 1 个完整交易周，标签为该周最后交易日）
 * - month     : YYYY-MM（每格 = 1 个自然月）
 * - quarter   : YYYY-Qn（每格 = 1 个自然季）
 * - year      : YYYY（每格 = 1 个自然年）
 */
export function periodTickLabel(date: string, period: Period): string {
  switch (period) {
    case 'month':
      return date.slice(0, 7);
    case 'quarter': {
      const q = Math.floor((parseInt(date.slice(5, 7), 10) - 1) / 3) + 1;
      return `${date.slice(0, 4)}-Q${q}`;
    }
    case 'year':
      return date.slice(0, 4);
    case 'week':
      return `${date.slice(5)} 周`;
    default:
      return date.slice(5); // MM-DD
  }
}

// ─────────────────────────────────────────────────────────────
// 关键形态识别（头肩顶 / 双底 / 突破 / 破位）
// ─────────────────────────────────────────────────────────────

export type PatternType = 'head-shoulders' | 'double-bottom' | 'breakout' | 'breakdown';

export interface PatternMark {
  type: PatternType;
  /** 形态名称 */
  name: string;
  /** 关键位置（数据索引，基于传入序列） */
  index: number;
  /** 参考价格 */
  price: number;
  /** 说明文字 */
  note: string;
}

interface PatternPoint {
  date: string;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 识别关键形态（基于日 K 序列，返回标注数组）：
 * - 突破 breakout：收盘价突破近 20 日最高价（且放量）
 * - 破位 breakdown：收盘价跌破近 20 日最低价
 * - 双底 double-bottom：两相近低点 + 突破颈线
 * - 头肩顶 head-shoulders：三峰形态 + 跌破颈线
 * 仅对最近 LOOKBACK 根 K 线检测，避免标注过旧形态。
 */
export function detectPatterns(points: PatternPoint[], lookback = 60): PatternMark[] {
  if (!points || points.length < 30) return [];
  const marks: PatternMark[] = [];
  const window = points.slice(-lookback);
  const n = window.length;

  // ── 突破 / 破位（最近一根 K 线） ──
  const last = window[n - 1];
  const prior20 = window.slice(-21, -1);
  if (prior20.length >= 10) {
    const high20 = Math.max(...prior20.map((p) => p.high));
    const low20 = Math.min(...prior20.map((p) => p.low));
    const avgVol5 =
      window.slice(-6, -1).reduce((a, p) => a + p.volume, 0) /
      Math.max(1, window.slice(-6, -1).length);

    if (last.close > high20) {
      const volSurge = avgVol5 > 0 && last.volume > avgVol5 * 1.3;
      marks.push({
        type: 'breakout',
        name: '突破',
        index: n - 1,
        price: last.close,
        note: volSurge ? '放量突破前高，趋势转强' : '突破前高，关注量能确认',
      });
    }
    if (last.close < low20) {
      marks.push({
        type: 'breakdown',
        name: '破位',
        index: n - 1,
        price: last.close,
        note: '跌破近期低点，趋势转弱',
      });
    }
  }

  // ── 局部极值扫描（找峰 / 谷） ──
  const peaks: number[] = [];
  const troughs: number[] = [];
  for (let i = 3; i < n - 3; i++) {
    const isPeak =
      window[i].high >= window[i - 1].high &&
      window[i].high >= window[i - 2].high &&
      window[i].high >= window[i + 1].high &&
      window[i].high >= window[i + 2].high;
    const isTrough =
      window[i].low <= window[i - 1].low &&
      window[i].low <= window[i - 2].low &&
      window[i].low <= window[i + 1].low &&
      window[i].low <= window[i + 2].low;
    if (isPeak) peaks.push(i);
    if (isTrough) troughs.push(i);
  }

  // ── 双底（最近两组相近低点 + 突破颈线） ──
  if (troughs.length >= 2) {
    const t1 = troughs[troughs.length - 2];
    const t2 = troughs[troughs.length - 1];
    if (t2 > t1 && t2 - t1 >= 4 && t2 - t1 <= 40) {
      const low1 = window[t1].low;
      const low2 = window[t2].low;
      const diff = Math.abs(low1 - low2) / Math.max(low1, low2);
      if (diff < 0.06) {
        // 颈线 = 两低点之间的最高点
        const neck = Math.max(...window.slice(t1, t2 + 1).map((p) => p.high));
        if (last.close > neck) {
          marks.push({
            type: 'double-bottom',
            name: '双底',
            index: t2,
            price: low2,
            note: `双底形成于 ${window[t1].date} / ${window[t2].date}，已突破颈线`,
          });
        }
      }
    }
  }

  // ── 头肩顶（三峰 + 跌破颈线） ──
  if (peaks.length >= 3) {
    const p1 = peaks[peaks.length - 3];
    const p2 = peaks[peaks.length - 2];
    const p3 = peaks[peaks.length - 1];
    if (p1 < p2 && p2 < p3 && p3 - p1 <= 60) {
      const h1 = window[p1].high;
      const h2 = window[p2].high;
      const h3 = window[p3].high;
      // 头最高，两肩接近
      if (h2 > h1 && h2 > h3 && Math.abs(h1 - h3) / Math.max(h1, h3) < 0.1) {
        // 颈线 = 两肩之间的最低点
        const neck = Math.min(...window.slice(p1, p3 + 1).map((p) => p.low));
        if (last.close < neck) {
          marks.push({
            type: 'head-shoulders',
            name: '头肩顶',
            index: p3,
            price: h2,
            note: `头肩顶形成（${window[p1].date} ~ ${window[p3].date}），已跌破颈线`,
          });
        }
      }
    }
  }

  // 排序：时间靠后的优先
  marks.sort((a, b) => b.index - a.index);
  return marks;
}

// ─────────────────────────────────────────────────────────────
// AI 潜力评分算法（多因子打分 0-100）
// ─────────────────────────────────────────────────────────────

export interface PotentialFactor {
  name: string;
  score: number;
  max: number;
  reason: string;
}

export interface PotentialReport {
  symbol: string;
  total: number;
  rating: string;
  ratingColor: string;
  factors: PotentialFactor[];
  summary: string;
}

/** 评分等级 */
function ratingOf(total: number): { rating: string; color: string } {
  if (total >= 80) return { rating: '强烈关注', color: '#ef4444' };
  if (total >= 65) return { rating: '关注', color: '#f59e0b' };
  if (total >= 45) return { rating: '中性', color: '#94a3b8' };
  return { rating: '谨慎', color: '#22c55e' };
}

/**
 * AI 潜力评分：基于历史日 K + 实时报价的多因子打分。
 * 因子：趋势（30）、动量（25）、量能（15）、波动（15）、位置（15）。
 */
export function analyzeStockPotential(
  symbol: string,
  points: KlinePoint[],
  quote: { price: number; changePercent: number } | null,
): PotentialReport | null {
  if (!points || points.length < 60) return null;
  const closes = points.map((p) => p.close);
  const latest = quote?.price ?? closes[closes.length - 1];
  const factors: PotentialFactor[] = [];
  const reasons: string[] = [];

  // ── 趋势因子（30 分） ──
  {
    let score = 0;
    const reasonsF: string[] = [];
    const ma5 = calcMA(closes, 5);
    const ma20 = calcMA(closes, 20);
    const ma60 = calcMA(closes, 60);
    if (ma5 !== null && ma20 !== null && ma60 !== null) {
      if (ma5 > ma20 && ma20 > ma60) {
        score += 14;
        reasonsF.push('MA5>MA20>MA60 多头排列');
      } else if (ma5 < ma20 && ma20 < ma60) {
        score += 4;
        reasonsF.push('均线空头排列');
      } else {
        score += 8;
        reasonsF.push('均线纠缠，趋势未明');
      }
      if (latest > ma20) {
        score += 8;
        reasonsF.push('价格站上 MA20');
      } else {
        score += 2;
        reasonsF.push('价格位于 MA20 下方');
      }
      // MA20 斜率
      const ma20Prev = calcMA(closes.slice(0, -5), 20);
      if (ma20Prev !== null && ma20 > ma20Prev * 1.005) {
        score += 8;
        reasonsF.push('MA20 向上倾斜');
      } else if (ma20Prev !== null && ma20 < ma20Prev * 0.995) {
        score += 2;
        reasonsF.push('MA20 向下倾斜');
      } else {
        score += 5;
      }
    } else {
      score += 10;
      reasonsF.push('历史数据不足，趋势评分保守');
    }
    factors.push({
      name: '趋势',
      score: Math.min(score, 30),
      max: 30,
      reason: reasonsF.join('；'),
    });
  }

  // ── 动量因子（25 分） ──
  {
    let score = 0;
    const reasonsF: string[] = [];
    const rsi = calcRSI(closes, 14);
    if (rsi !== null) {
      if (rsi >= 50 && rsi <= 70) {
        score += 10;
        reasonsF.push(`RSI=${rsi} 强势区间`);
      } else if (rsi > 70) {
        score += 5;
        reasonsF.push(`RSI=${rsi} 超买，注意回调`);
      } else if (rsi < 30) {
        score += 5;
        reasonsF.push(`RSI=${rsi} 超卖，或有反弹`);
      } else {
        score += 4;
        reasonsF.push(`RSI=${rsi} 中性`);
      }
    }
    const ret20 = (latest / closes[Math.max(0, closes.length - 21)] - 1) * 100;
    if (ret20 >= 5 && ret20 <= 25) {
      score += 10;
      reasonsF.push(`近20日涨幅 ${ret20.toFixed(1)}%，动量健康`);
    } else if (ret20 > 25) {
      score += 4;
      reasonsF.push(`近20日涨幅 ${ret20.toFixed(1)}%，短期涨幅过大`);
    } else if (ret20 < -10) {
      score += 4;
      reasonsF.push(`近20日跌幅 ${ret20.toFixed(1)}%，超跌`);
    } else {
      score += 6;
      reasonsF.push(`近20日涨幅 ${ret20.toFixed(1)}%`);
    }
    // MACD 金叉
    const macd = calcMACD(closes.slice(-60));
    const lastDif = macd.dif[macd.dif.length - 1];
    const lastDea = macd.dea[macd.dea.length - 1];
    const prevDif = macd.dif[macd.dif.length - 2];
    const prevDea = macd.dea[macd.dea.length - 2];
    if (
      lastDif !== null &&
      lastDea !== null &&
      prevDif !== null &&
      prevDea !== null &&
      prevDif <= prevDea &&
      lastDif > lastDea
    ) {
      score += 5;
      reasonsF.push('MACD 近期金叉');
    } else if (lastDif !== null && lastDea !== null && lastDif > lastDea) {
      score += 3;
      reasonsF.push('MACD 多头区域');
    }
    factors.push({
      name: '动量',
      score: Math.min(score, 25),
      max: 25,
      reason: reasonsF.join('；'),
    });
  }

  // ── 量能因子（15 分） ──
  {
    let score = 0;
    const reasonsF: string[] = [];
    const vols = points.map((p) => p.volume ?? 0);
    if (vols.length >= 25) {
      const avg5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const avg20 =
        vols.slice(-20, -5).reduce((a, b) => a + b, 0) / Math.max(1, vols.slice(-20, -5).length);
      const ratio = avg20 > 0 ? avg5 / avg20 : 1;
      if (ratio > 1.3) {
        score += 12;
        reasonsF.push(`量比 ${ratio.toFixed(2)}，近期放量`);
      } else if (ratio > 1.0) {
        score += 8;
        reasonsF.push(`量比 ${ratio.toFixed(2)}，量能温和`);
      } else {
        score += 4;
        reasonsF.push(`量比 ${ratio.toFixed(2)}，量能萎缩`);
      }
    } else {
      score += 6;
      reasonsF.push('成交量数据不足');
    }
    factors.push({
      name: '量能',
      score: Math.min(score, 15),
      max: 15,
      reason: reasonsF.join('；'),
    });
  }

  // ── 波动因子（15 分，适中为佳） ──
  {
    let score = 0;
    const reasonsF: string[] = [];
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    }
    if (rets.length >= 20) {
      const recent = rets.slice(-20);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const variance = recent.reduce((a, b) => a + (b - avg) * (b - avg), 0) / recent.length;
      const volPct = Math.sqrt(variance) * 100; // 日波动率 %
      if (volPct >= 1 && volPct <= 3.5) {
        score += 12;
        reasonsF.push(`日波动率 ${volPct.toFixed(2)}%，波动适中`);
      } else if (volPct < 1) {
        score += 8;
        reasonsF.push(`日波动率 ${volPct.toFixed(2)}%，波动偏低`);
      } else {
        score += 5;
        reasonsF.push(`日波动率 ${volPct.toFixed(2)}%，波动偏大`);
      }
    } else {
      score += 7;
      reasonsF.push('波动数据不足');
    }
    factors.push({
      name: '波动',
      score: Math.min(score, 15),
      max: 15,
      reason: reasonsF.join('；'),
    });
  }

  // ── 位置因子（15 分） ──
  {
    let score = 0;
    const reasonsF: string[] = [];
    const high52 = Math.max(...points.slice(-250).map((p) => p.high));
    const low52 = Math.min(...points.slice(-250).map((p) => p.low));
    if (high52 > 0 && low52 > 0) {
      const distHigh = ((high52 - latest) / high52) * 100;
      const distLow = ((latest - low52) / low52) * 100;
      if (distHigh < 10) {
        score += 10;
        reasonsF.push(`距52周高点仅 ${distHigh.toFixed(1)}%，强势位置`);
      } else if (distHigh < 25) {
        score += 7;
        reasonsF.push(`距52周高点 ${distHigh.toFixed(1)}%`);
      } else {
        score += 4;
        reasonsF.push(`距52周高点 ${distHigh.toFixed(1)}%，位置偏低`);
      }
      if (distLow < 15) {
        score += 5;
        reasonsF.push(`距52周低点 ${distLow.toFixed(1)}%，支撑较近`);
      } else {
        score += 2;
      }
    } else {
      score += 7;
    }
    factors.push({
      name: '位置',
      score: Math.min(score, 15),
      max: 15,
      reason: reasonsF.join('；'),
    });
  }

  const total = factors.reduce((a, f) => a + f.score, 0);
  const { rating, color } = ratingOf(total);
  reasons.push(
    `综合评分 ${total}/100，评级：${rating}。${factors
      .map((f) => `${f.name} ${f.score}/${f.max}`)
      .join('，')}。`,
  );
  return {
    symbol,
    total,
    rating,
    ratingColor: color,
    factors,
    summary: reasons.join(''),
  };
}

// ─────────────────────────────────────────────────────────────
// 每日推荐股票池（AI 评分选出）
// ─────────────────────────────────────────────────────────────

/** 推荐股票池：美股 + A股 + 港股混合，供 AI 算法评分筛选 */
export const STOCK_POOL: { symbol: string; market: Market; name: string }[] = [
  { symbol: 'MSFT', market: 'US', name: '微软' },
  { symbol: 'NVDA', market: 'US', name: '英伟达' },
  { symbol: 'AAPL', market: 'US', name: '苹果' },
  { symbol: 'GOOGL', market: 'US', name: '谷歌-A' },
  { symbol: 'TSLA', market: 'US', name: '特斯拉' },
  { symbol: 'AMZN', market: 'US', name: '亚马逊' },
  { symbol: 'META', market: 'US', name: 'Meta' },
  { symbol: 'AMD', market: 'US', name: '超威半导体' },
  { symbol: 'NFLX', market: 'US', name: '奈飞' },
  { symbol: 'AVGO', market: 'US', name: '博通' },
  { symbol: '600519', market: 'CN', name: '贵州茅台' },
  { symbol: '000001', market: 'CN', name: '平安银行' },
  { symbol: '002230', market: 'CN', name: '科大讯飞' },
  { symbol: '300750', market: 'CN', name: '宁德时代' },
  { symbol: '601318', market: 'CN', name: '中国平安' },
  { symbol: '00700', market: 'HK', name: '腾讯控股' },
  { symbol: '09988', market: 'HK', name: '阿里巴巴-W' },
  { symbol: '03690', market: 'HK', name: '美团-W' },
  { symbol: '01810', market: 'HK', name: '小米集团-W' },
  { symbol: '00941', market: 'HK', name: '中国移动' },
];

/** 推荐结果 */
export interface RecommendItem {
  symbol: string;
  market: Market;
  name: string;
  price: number;
  changePercent: number;
  /** AI 潜力评分 */
  score: number;
  rating: string;
}
