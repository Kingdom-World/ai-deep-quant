import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as echarts from 'echarts';
import { theme } from '../lib/theme';
import { useIsNarrow } from '../lib/useIsNarrow';
import { setVisibilityInterval } from '../lib/polling';
import { wilderRsiSeries } from '../../shared/rsi.mjs';
import {
  clearCache,
  getHistoryWithMeta,
  getMinuteKline,
  getMinuteSeries,
  getPeriodPolicy,
  getQuote,
  getTicks,
  feedApi,
  newsApi,
  type NewsItem,
  type PeriodPolicy,
  type TickData,
} from '../api/dataService';
import {
  aggregateData,
  aggregatePoints,
  analyzeStockPotential,
  calcMACD,
  calcMA,
  calcMASeries,
  calcPeriodChange,
  calcRSI,
  detectMarket,
  detectPatterns,
  formatVolume,
  friendlyError,
  HISTORY_COUNT,
  marketLabel,
  MINUTE_PERIODS,
  pctColor,
  PERIODS,
  periodTickLabel,
  POLL_INTERVAL,
  REALTIME_MAX_POINTS,
  stripMarketPrefix,
  UP_COLOR,
  DOWN_COLOR,
  type KlinePoint,
  type Market,
  type MinutePeriod,
  type Period,
} from '../lib/stock';
import { isFavorite, toggleFavorite } from '../lib/favorites';
import { getMarketStatus } from '../lib/marketHours';
import { useQuantStore } from '../store/quantStore';
import {
  formatPercent,
  marketToCurrency,
  type Currency,
} from '../utils/formatters';

/** MA 均线配置（主图叠加） */
const MA_PERIODS = [5, 10, 20, 60, 120, 250];

/**
 * RSI 序列（副图指标切换用）
 *   口径：**Wilder 标准**——直接引用唯一实现源 shared/rsi.mjs（前端不再自带一份）
 *   历史：此处原为自实现的「窗口简单均值」，与另外三处各写各的；S6 起全部收敛。
 */
const rsiSeriesCalc = wilderRsiSeries;

/** KDJ 序列（9,3,3） */
function kdjSeriesCalc(klines: { high: number; low: number; close: number }[], n = 9) {
  const K: number[] = [];
  const D: number[] = [];
  const J: number[] = [];
  let k = 50;
  let d = 50;
  for (let i = 0; i < klines.length; i++) {
    const seg = klines.slice(Math.max(0, i - n + 1), i + 1);
    const hh = Math.max(...seg.map((x) => x.high));
    const ll = Math.min(...seg.map((x) => x.low));
    const rsv = hh === ll ? 50 : ((klines[i].close - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    K.push(+k.toFixed(2));
    D.push(+d.toFixed(2));
    J.push(+(3 * k - 2 * d).toFixed(2));
  }
  return { K, D, J };
}
const MA_COLORS = ['#f59e0b', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#f97316'];

/** 形态标注颜色 */
const PATTERN_COLORS: Record<string, string> = {
  'head-shoulders': '#f87171',
  'double-bottom': '#34d399',
  breakout: '#60a5fa',
  breakdown: '#fb923c',
};

export default function StockDetailPage() {
  const navigate = useNavigate();
  // 全局状态：同步当前股票（供跨页共享）
  const setSymbol = useQuantStore((s) => s.setSymbol);
  // URL 参数驱动：/stock/:symbol
  const { symbol: routeSymbol } = useParams<{ symbol: string }>();
  const symbol = (routeSymbol || 'MSFT').toUpperCase();
  const market: Market = detectMarket(symbol);
  const currency: Currency = marketToCurrency(market);
  const CURRENCY = currency === 'USD' ? '$' : currency === 'HKD' ? 'HK$' : '¥';
  /** 展示用代码（剥离 sh/sz/hk/us 前缀） */
  const displaySymbol = stripMarketPrefix(symbol);

  // 同步到全局 store
  useEffect(() => {
    setSymbol(symbol, market);
  }, [symbol, market, setSymbol]);

  // 主图（K 线）ref
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  // 实时走势图 ref —— 独立 ECharts 实例
  const realtimeChartRef = useRef<HTMLDivElement>(null);
  const realtimeChartInstance = useRef<echarts.ECharts | null>(null);

  // 分钟副图 ref —— 独立 ECharts 实例
  const minuteChartRef = useRef<HTMLDivElement>(null);
  const minuteChartInstance = useRef<echarts.ECharts | null>(null);

  // 整合后的图表外层容器：主K + 短期K 同一卡片内上下排布，共享缩放与十字光标
  const chartGroupRef = useRef<HTMLDivElement>(null);

  // ── 搜索状态：输入框 / 搜索中 ──
  const [inputValue, setInputValue] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // 股票名称（详情页标题显示名称 + 代码）
  const [stockName, setStockName] = useState<string>('');
  // 收藏状态（五角星）
  const [fav, setFav] = useState<boolean>(() => isFavorite(symbol));

  // 状态管理（原有）
  const [priceHistory, setPriceHistory] = useState<number[]>([]);
  const [latestPrice, setLatestPrice] = useState<number | null>(null);
  const [book, setBook] = useState<{
    bids: { price: number; qty: number }[];
    asks: { price: number; qty: number }[];
    quoteTime: string | null;
  } | null>(null);
  const [changePercent, setChangePercent] = useState<number | null>(null);
  const [rangeChange, setRangeChange] = useState<number | null>(null);
  const [updateTime, setUpdateTime] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const narrow = useIsNarrow(); // 手机上把摘要栅格换成 2 列并允许收缩，避免右侧数值被裁掉
  const [error, setError] = useState<string | null>(null);

  // 状态管理（多维度变化）
  const [todayChange, setTodayChange] = useState<number | null>(null);
  const [weekChange, setWeekChange] = useState<number | null>(null);
  const [monthChange, setMonthChange] = useState<number | null>(null);
  const [ytdChange, setYtdChange] = useState<number | null>(null);

  // 状态管理（技术指标）
  const [ma5, setMa5] = useState<number | null>(null);
  const [ma10, setMa10] = useState<number | null>(null);
  const [ma20, setMa20] = useState<number | null>(null);
  const [rsi14, setRsi14] = useState<number | null>(null);

  // 状态管理（成交量 / 统计）
  const [stats, setStats] = useState<{
    startDate: string;
    endDate: string;
    high: number;
    low: number;
    avg: number;
  } | null>(null);

  // ── 主图周期与聚合 ──
  const [selectedPeriod, setSelectedPeriod] = useState<Period>('day');
  const [aggregatedData, setAggregatedData] = useState<number[]>([]);
  /** 完整历史日线（聚合的数据源，仅获取一次） */
  const [allPoints, setAllPoints] = useState<KlinePoint[]>([]);
  /** 周期切换提示（如：新股暂无季线/年线数据） */
  const [periodNotice, setPeriodNotice] = useState<string | null>(null);
  /** 后端周期可用性策略（新上市股票自动适配；未加载时回退本地跨度计算） */
  const [periodPolicy, setPeriodPolicy] = useState<PeriodPolicy | null>(null);
  const currentSymbolRef = useRef(symbol);
  useEffect(() => {
    currentSymbolRef.current = symbol;
  }, [symbol]);

  /** 历史数据覆盖跨度（天）：用于季线/年线数据量校验（后端策略未加载时的回退） */
  /** 副图指标切换（同花顺式）：MACD / RSI / KDJ */
  const [subIndicator, setSubIndicator] = useState<'MACD' | 'RSI' | 'KDJ'>('MACD');
  const historySpanDays = useMemo(() => {
    const first = allPoints[0]?.date;
    const last = allPoints[allPoints.length - 1]?.date;
    if (!first || !last) return 0;
    return (Date.parse(last) - Date.parse(first)) / 86400000;
  }, [allPoints]);

  /** 周期是否可用：优先采用后端策略（自动适配新上市股票），失败回退本地跨度计算 */
  const isPeriodAvailable = (period: Period): boolean => {
    if (period !== 'quarter' && period !== 'year') return true;
    if (periodPolicy) return periodPolicy.periods[period] === true;
    return period === 'quarter' ? historySpanDays >= 365 : historySpanDays >= 1000;
  };

  /** 数据覆盖天数（后端策略优先） */
  const coverageDays = periodPolicy?.coverageDays ?? Math.round(historySpanDays);

  /**
   * 周期选择（含数据量校验）：
   * 季线/年线需要足够长的历史跨度；数据不足时按钮置灰，点击给出提示（参考主流行情软件做法）
   */
  const handlePeriodSelect = (period: Period) => {
    setPeriodNotice(null);
    if (!isPeriodAvailable(period)) {
      setPeriodNotice(
        period === 'quarter'
          ? `📌 历史数据约 ${Math.max(1, Math.round(coverageDays / 30))} 个月，不足 1 年，暂无足够季度K线数据`
          : `📌 历史数据约 ${Math.max(1, Math.round(coverageDays / 365))} 年，不足 3 年，暂无足够年度K线数据`,
      );
      return;
    }
    setSelectedPeriod(period);
  };

  // ── 实时走势（分时历史 + 实时跟踪） ──
  /** 当日分时全量（分钟粒度，进入页面即完整拉取，供前20分钟/前2小时展示；date 为交易日） */
  const [minuteTrace, setMinuteTrace] = useState<{ date?: string; time: string; price: number }[]>([]);
  /** 实时高频点（10 秒轮询追加，供实时跟踪模式） */
  const [liveTrace, setLiveTrace] = useState<number[]>([]);
  /** 实时走势窗口模式：20m=前20分钟 / 2h=前2小时 / live=实时跟踪 */
  const [traceMode, setTraceMode] = useState<'20m' | '2h' | 'live'>('20m');
  /** 时间窗口真实起止（以当前时间为基准向前推，供说明文字展示；fallback=非交易时段兜底） */
  const [traceWindow, setTraceWindow] = useState<{
    start: string;
    end: string;
    fallback?: boolean;
  } | null>(null);

  // ── 分钟副图（1/5/15/30 分钟 K 线） ──
  const [minutePeriod, setMinutePeriod] = useState<MinutePeriod>('5');
  // 分笔成交（东财逐笔，仅 A 股；交易时段 10s 自动刷新）
  const isCNStock = detectMarket(symbol) === 'CN';
  const session = getMarketStatus(detectMarket(symbol));
  // 复权模式（仅 A 股可切换；默认前复权）
  const [adjustMode, setAdjustMode] = useState<'qfq' | 'hfq' | 'none'>('qfq');
  const ADJUST_LABEL: Record<string, string> = { qfq: '前复权', hfq: '后复权', none: '不复权' };
  // 后端返回的实际复权口径（主源失败回退新浪不复权时与所选不一致，必须显式提示，禁止静默降级）
  const [actualAdjust, setActualAdjust] = useState<string | null>(null);
  const formatAdjust = (s: string) => {
    const base = s.startsWith('qfq') ? '前复权' : s.startsWith('hfq') ? '后复权' : s.startsWith('none') ? '不复权' : s;
    return s.includes('备用') ? `${base}（备用源）` : base;
  };
  const [ticks, setTicks] = useState<TickData[] | null>(null);
  const [ticksErr, setTicksErr] = useState<string | null>(null);
  const [showAllTicks, setShowAllTicks] = useState(false);

  useEffect(() => {
    if (!isCNStock) {
      setTicks(null);
      setTicksErr(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await getTicks(symbol);
        if (!alive) return;
        if (r.ok) {
          setTicks(r.ticks);
          setTicksErr(null);
        } else {
          setTicksErr(r.error || '获取失败');
        }
      } catch (e) {
        if (alive) setTicksErr((e as Error).message);
      }
    };
    load();
    const stopPolling = setVisibilityInterval(load, 15000);
    return () => {
      alive = false;
      stopPolling();
    };
  }, [symbol, isCNStock]);

  const [minutePoints, setMinutePoints] = useState<KlinePoint[]>([]);

  /** 清空全部展示数据（切换股票时调用，避免新旧数据混合） */
  const resetDashboard = () => {
    setPriceHistory([]);
    setAllPoints([]);
    setMinutePoints([]);
    setMinuteTrace([]);
    setLiveTrace([]);
    setPeriodNotice(null);
    setPeriodPolicy(null);
    setAggregatedData([]);
    setLatestPrice(null);
    setChangePercent(null);
    setRangeChange(null);
    setTodayChange(null);
    setWeekChange(null);
    setMonthChange(null);
    setYtdChange(null);
    setMa5(null);
    setMa10(null);
    setMa20(null);
    setRsi14(null);
    setStats(null);
    setUpdateTime('');
    setStockName('');
    setError(null);
    // 切换股票时清空数据服务缓存，强制获取新股票数据
    clearCache();
    // 清空三个图表的旧内容
    chartInstance.current?.clear();
    realtimeChartInstance.current?.clear();
    minuteChartInstance.current?.clear();
  };

  // 1. 获取历史日线数据（用于初始化图表 + 计算全部量化指标）
  const fetchHistoricalData = async (sym: string, m: Market) => {
    try {
      // 走统一数据服务（独立后端，带缓存）；请求 2400 根支撑 MA250/季线(30根)/年线(10根)（约 9 年）
      const { klines: rows, adjust: adjustActual } = await getHistoryWithMeta(sym, m, 'day', 2400, false, adjustMode);
      if (currentSymbolRef.current === sym) setActualAdjust(adjustActual);
      const points: KlinePoint[] = rows.map((r) => ({
        date: r.date,
        open: r.open,
        close: r.close,
        high: r.high,
        low: r.low,
        volume: r.volume,
      }));

      if (!points || points.length === 0) {
        throw new Error('未获取到历史数据，请检查股票代码是否正确');
      }

      // 完整历史（聚合数据源，供周期切换使用）
      setAllPoints(points);

      // 后端周期可用性策略（异步加载，自动适配新上市股票；失败时前端回退本地计算）
      getPeriodPolicy(sym)
        .then((p) => {
          if (currentSymbolRef.current === sym) setPeriodPolicy(p);
        })
        .catch(() => {
          /* 策略获取失败不影响主流程 */
        });

      // 图表窗口数据：最近 HISTORY_COUNT 个交易日（技术指标/统计用）
      const chartPoints = points.slice(-HISTORY_COUNT);
      const prices = chartPoints.map((p) => p.close);
      const latest = prices[prices.length - 1];

      setPriceHistory(prices);
      setLatestPrice(latest);
      const range = parseFloat((((latest - prices[0]) / prices[0]) * 100).toFixed(2));
      setRangeChange(range);
      setUpdateTime(new Date().toLocaleString());
      setLoading(false);
      setError(null);
      setIsSearching(false);

      // 多维度价格变化（基于完整历史窗口，不足则 null → '--'）
      setTodayChange(calcPeriodChange(points, latest, 'today'));
      setWeekChange(calcPeriodChange(points, latest, 'week'));
      setMonthChange(calcPeriodChange(points, latest, 'month'));
      setYtdChange(calcPeriodChange(points, latest, 'ytd'));

      // 技术指标（基于最近 30 个收盘价）
      setMa5(calcMA(prices, 5));
      setMa10(calcMA(prices, 10));
      setMa20(calcMA(prices, 20));
      setRsi14(calcRSI(prices, 14));

      // 数据统计概览（基于最近 30 个交易日）
      const highs = chartPoints.map((p) => p.high ?? 0);
      const lows = chartPoints.map((p) => p.low ?? 0);
      setStats({
        startDate: chartPoints[0].date,
        endDate: chartPoints[chartPoints.length - 1].date,
        high: Math.max(...highs),
        low: Math.min(...lows),
        avg: parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)),
      });

      // ── 实时走势初始化：拉取当日分时全量（前20分钟/前2小时模式进入页面即可完整展示），
      //    分时不可用则回退为最近 2 个真实收盘价起步，并自动切换到实时跟踪模式 ──
      const minute = await getMinuteSeries(sym, m).catch(() => []);
      if (minute.length > 0) {
        setMinuteTrace(minute);
        setLiveTrace(minute.slice(-2).map((p) => p.price));
      } else {
        setLiveTrace(prices.length >= 2 ? prices.slice(-2) : []);
        setTraceMode('live');
      }

      // 历史数据就绪后立即拉一次实时报价（避免等待首个 10 秒窗口；实时数据强制刷新绕过缓存）
      try {
        const quote = await getQuote(sym, m, true);
        setBook(quote.bids && quote.asks ? { bids: quote.bids, asks: quote.asks, quoteTime: quote.quoteTime ?? null } : null);
        const chg = quote.changePercent ?? 0;
        const open = quote.open ?? 0;
        setLatestPrice(quote.price);
        setChangePercent(parseFloat(chg.toFixed(2)));
        setTodayChange(
          open > 0 ? parseFloat((((quote.price - open) / open) * 100).toFixed(2)) : null,
        );
        setUpdateTime(new Date().toLocaleString());
        setStockName(quote.name ?? '');
        // 追加一个实时点
        setLiveTrace((prev) => [...prev, quote.price].slice(-REALTIME_MAX_POINTS));
      } catch {
        /* 实时报价失败不阻塞历史展示 */
      }
    } catch (err: any) {
      setError(friendlyError(sym, err));
      setLoading(false);
      setIsSearching(false);
      console.error(err);
    }
  };

  // 2. 获取实时报价（用于轮询更新，保留原逻辑 + 实时走势追加）
  const fetchRealtimeQuote = async (sym: string, m: Market) => {
    try {
      const quote = await getQuote(sym, m, true); // 实时轮询强制刷新，绕过缓存
      setBook(quote.bids && quote.asks ? { bids: quote.bids, asks: quote.asks, quoteTime: quote.quoteTime ?? null } : null);
      const chg = quote.changePercent ?? 0;
      const open = quote.open ?? 0;

      setLatestPrice(quote.price);
      setChangePercent(parseFloat(chg.toFixed(2)));
      setUpdateTime(new Date().toLocaleString());
      if (quote.name) setStockName(quote.name);

      // 更新价格历史（滑动窗口，保留最近 30 个点）
      setPriceHistory((prev) => {
        const next = [...prev, quote.price];
        return next.slice(-HISTORY_COUNT);
      });

      // 今日变化（实时价 vs 今日开盘）
      if (open > 0) {
        setTodayChange(parseFloat((((quote.price - open) / open) * 100).toFixed(2)));
      }

      // ── 实时走势追加最新价格（实时跟踪模式高频点，最多保留 120 个点） ──
      setLiveTrace((prev) => {
        const next = [...prev, quote.price];
        return next.slice(-REALTIME_MAX_POINTS);
      });
    } catch (err: any) {
      console.error('获取实时报价失败:', err?.message);
      // 不显示错误，避免频繁闪烁
    }
  };

  // 3. 搜索：导航到新股票的详情页（URL 驱动 → 自动触发加载）
  const handleSearch = () => {
    const raw = inputValue.trim().toUpperCase();
    if (!raw) {
      setError('请输入股票代码');
      return;
    }
    setInputValue('');
    if (raw === symbol) return; // 同一股票无需重复加载
    navigate(`/stock/${raw}`);
  };

  // 收藏切换（五角星）
  const handleToggleFavorite = () => {
    const next = toggleFavorite({ symbol, market, name: stockName || symbol });
    setFav(next);
  };

  // 4. 初始化主图（K 线，历史数据就绪后创建一次）
  useEffect(() => {
    if (loading || !chartRef.current || allPoints.length === 0) return;
    if (chartInstance.current) return;

    const chart = echarts.init(chartRef.current);
    chartInstance.current = chart;

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.dispose();
      chartInstance.current = null;
    };
  }, [loading]);

  // 5. 初始化实时走势图（独立实例，历史数据就绪后创建）
  useEffect(() => {
    if (loading || !realtimeChartRef.current) return;
    if (realtimeChartInstance.current) return;

    const chart = echarts.init(realtimeChartRef.current);
    realtimeChartInstance.current = chart;

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.dispose();
      realtimeChartInstance.current = null;
    };
  }, [loading]);

  // 6. 初始化分钟副图（独立实例）
  useEffect(() => {
    if (loading || !minuteChartRef.current) return;
    if (minuteChartInstance.current) return;

    const chart = echarts.init(minuteChartRef.current);
    minuteChartInstance.current = chart;

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.dispose();
      minuteChartInstance.current = null;
    };
  }, [loading]);

  // 7. 主图与短期副图刻意保持「完全独立」：
  //    两图时间域粒度不同（日线 vs 分钟线），若做联动同步，十字光标每移动一次
  //    都要跨实例 dispatch dataZoom 重算，会造成明显卡顿。
  //    因此各自独立缩放 / 独立十字光标，互不影响。

  // 8. 整合容器尺寸响应：监听外层容器变化驱动两张图各自 resize（仅尺寸，不联动数据）
  useEffect(() => {
    const el = chartGroupRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      chartInstance.current?.resize();
      minuteChartInstance.current?.resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  // 7. 聚合数据缓存（useMemo：数据/周期不变时不重复计算）
  const chartData = useMemo(() => {
    if (allPoints.length === 0) return null;
    const agg = aggregatePoints(allPoints, selectedPeriod);
    const closes = agg.map((p) => p.close);
    return {
      agg,
      closes,
      labels: agg.map((p) => periodTickLabel(p.date, selectedPeriod)),
      klineData: agg.map((p) => [p.open, p.close, p.low, p.high]),
      maSeries: MA_PERIODS.map((period, idx) => ({
        name: `MA${period}`,
        type: 'line' as const,
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: calcMASeries(closes, period),
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.2, color: MA_COLORS[idx] },
        itemStyle: { color: MA_COLORS[idx] },
      })),
      macd: calcMACD(closes),
      rsi: rsiSeriesCalc(closes),
      kdj: kdjSeriesCalc(agg),
      patterns: detectPatterns(agg),
    };
  }, [allPoints, selectedPeriod]);

  // 8. 主图数据更新：K 线蜡烛图 + MA 均线 + 成交量 + MACD + 形态标注
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || loading || allPoints.length === 0) return;
    if (!chartData) return;

    const { agg, labels, klineData, maSeries, macd, rsi, kdj, patterns } = chartData;
    const periodInfo = PERIODS.find((p) => p.key === selectedPeriod);

    // 供 UI 展示当前周期的聚合点数（aggregateData 为收盘价数组）
    setAggregatedData(aggregateData(allPoints, selectedPeriod));

    // 形态标注（markPoint 叠加在 K 线主图上）
    const patternMarks = patterns.map((p) => ({
      name: p.name,
      coord: [p.index, p.price] as [number, number],
      value: p.name,
      itemStyle: { color: PATTERN_COLORS[p.type] ?? '#94a3b8' },
      label: {
        formatter: p.name,
        fontSize: 11,
        fontWeight: 'bold' as const,
        color: '#0a0e17',
        backgroundColor: PATTERN_COLORS[p.type] ?? '#94a3b8',
        padding: [2, 6],
        borderRadius: 4,
      },
    }));

    chart.setOption({
      title: {
        text: `📈 ${displaySymbol} ${periodInfo?.title ?? '日线'} K线 · ${ADJUST_LABEL[adjustMode] ?? '前复权'}`,
        left: 'center',
        top: 0,
        textStyle: { fontSize: 14, fontWeight: 600, color: '#e2e8f0' },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        // 约束浮层在图表容器内，避免光标靠近边缘时浮层被推出页面而被裁剪
        confine: true,
        // 限制宽度让超长的均线/指标行自动折行，浮层更紧凑、更好摆放
        extraCssText: 'max-width: min(360px, 90vw); white-space: normal;',
        backgroundColor: 'rgba(10, 15, 26, 0.94)',
        borderColor: 'rgba(96,165,250,0.35)',
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: '#e2e8f0', fontSize: 12 },
        formatter: (params: any) => {
          const list = Array.isArray(params) ? params : [params];
          const candle = list.find((p: any) => p.seriesType === 'candlestick');
          const bar = list.find((p: any) => p.seriesType === 'bar');
          const idx = candle?.dataIndex ?? bar?.dataIndex ?? 0;
          const p = agg[idx];
          if (!p) return '';
          const prev = idx > 0 ? agg[idx - 1].close : p.open;
          const chgAmt = p.close - prev;
          const chgPct = prev > 0 ? (chgAmt / prev) * 100 : 0;
          const chgColor = chgAmt >= 0 ? UP_COLOR : DOWN_COLOR;
          const dim = (k: string) => `<span style="color:#7c8aa0">${k}</span>`;
          let html = `<div style="min-width:172px">`;
          html += `<div style="font-weight:700;margin-bottom:5px">${displaySymbol} <span style="color:#7c8aa0;font-weight:400">${p.date}</span></div>`;
          html += `<div>${dim('开')} ${CURRENCY}${p.open.toFixed(2)}　${dim('高')} <span style="color:${UP_COLOR}">${CURRENCY}${p.high.toFixed(2)}</span></div>`;
          html += `<div>${dim('低')} <span style="color:${DOWN_COLOR}">${CURRENCY}${p.low.toFixed(2)}</span>　${dim('收')} <b style="color:${chgColor}">${CURRENCY}${p.close.toFixed(2)}</b></div>`;
          html += `<div>${dim('涨跌')} <b style="color:${chgColor}">${chgAmt >= 0 ? '+' : ''}${chgAmt.toFixed(2)}（${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%）</b></div>`;
          if (bar) html += `<div>${dim('成交量')} ${formatVolume(Number(bar.value))}</div>`;
          const maVals = MA_PERIODS.map((period, i) => {
            const v = (chartData.maSeries[i]?.data ?? [])[idx];
            return Number.isFinite(Number(v)) ? `<span style="color:${MA_COLORS[i]}">MA${period} ${Number(v).toFixed(2)}</span>` : '';
          }).filter(Boolean).join('　');
          if (maVals) html += `<div style="margin-top:4px">${maVals}</div>`;
          const subParts: string[] = [];
          const difP = list.find((s: any) => s.seriesName === 'DIF');
          const deaP = list.find((s: any) => s.seriesName === 'DEA');
          const macdP = list.find((s: any) => s.seriesName === 'MACD柱');
          if (difP && Number.isFinite(Number(difP.value))) {
            subParts.push(`<span style="color:#f59e0b">DIF ${Number(difP.value).toFixed(3)}</span>`, `<span style="color:#3b82f6">DEA ${Number(deaP?.value ?? 0).toFixed(3)}</span>`, `<span style="color:${Number(macdP?.value ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR}">MACD ${Number(macdP?.value ?? 0).toFixed(3)}</span>`);
          }
          const rsiP = list.find((s: any) => s.seriesName === 'RSI14');
          if (rsiP && Number.isFinite(Number(rsiP.value))) subParts.push(`<span style="color:#a78bfa">RSI14 ${Number(rsiP.value).toFixed(1)}</span>`);
          const kP = list.find((s: any) => s.seriesName === 'K');
          if (kP && Number.isFinite(Number(kP.value))) {
            subParts.push(`<span style="color:#f59e0b">K ${Number(kP.value).toFixed(1)}</span>`, `<span style="color:#3b82f6">D ${Number(list.find((s: any) => s.seriesName === 'D')?.value ?? 0).toFixed(1)}</span>`, `<span style="color:#22c55e">J ${Number(list.find((s: any) => s.seriesName === 'J')?.value ?? 0).toFixed(1)}</span>`);
          }
          if (subParts.length) html += `<div style="margin-top:4px">${subParts.join('　')}</div>`;
          const mark = patterns.find((pt) => pt.index === idx);
          if (mark) html += `<div style="margin-top:4px">🔔 ${mark.name}: ${mark.note}</div>`;
          html += `</div>`;
          return html;
        },
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: { backgroundColor: '#1e293b', color: '#e2e8f0', fontSize: 10 },
      },
      legend: {
        data: [
          ...MA_PERIODS.map((p) => `MA${p}`),
          '成交量',
          ...(subIndicator === 'MACD' ? ['DIF', 'DEA'] : subIndicator === 'RSI' ? ['RSI14'] : ['K', 'D', 'J']),
        ],
        top: 22,
        left: 'center',
        textStyle: { color: '#94a3b8', fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
      grid: [
        { left: '3%', right: '4%', top: '10%', height: '51%', containLabel: true },
        { left: '3%', right: '4%', top: '63%', height: '13%', containLabel: true },
        { left: '3%', right: '4%', top: '78%', height: '15%', containLabel: true },
      ],
      xAxis: [
        {
          type: 'category',
          data: labels,
          gridIndex: 0,
          axisLine: { show: false },
          axisLabel: { fontSize: 10, color: '#64748b', interval: 'auto' },
        },
        {
          type: 'category',
          data: labels,
          gridIndex: 1,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
        },
        {
          type: 'category',
          data: labels,
          gridIndex: 2,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
        },
      ],
      yAxis: [
        {
          type: 'value',
          gridIndex: 0,
          scale: true,
          axisLine: { show: false },
          axisLabel: { formatter: `${CURRENCY}{value}`, fontSize: 10, color: '#64748b' },
          splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' as const } },
          // 十字光标价格读数（TradingView 式轴标签）
          axisPointer: { label: { show: true, backgroundColor: '#1e293b', color: '#e2e8f0', fontSize: 10, formatter: (p: any) => `${CURRENCY}${Number(p.value).toFixed(2)}` } },
        },
        {
          type: 'value',
          gridIndex: 1,
          axisLine: { show: false },
          axisLabel: { formatter: (v: number) => formatVolume(v), fontSize: 9, color: '#475569' },
          splitLine: { show: false },
        },
        {
          type: 'value',
          gridIndex: 2,
          axisLine: { show: false },
          axisLabel: { fontSize: 9, color: '#475569' },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2], start: agg.length > 120 ? Math.max(0, 100 - (120 / agg.length) * 100) : 0, end: 100 },
        {
          type: 'slider',
          xAxisIndex: [0, 1, 2],
          start: agg.length > 120 ? Math.max(0, 100 - (120 / agg.length) * 100) : 0,
          end: 100,
          top: '95.5%',
          height: 14,
          backgroundColor: '#0d1322',
          borderColor: '#1e293b',
          fillerColor: 'rgba(59, 130, 246, 0.2)',
          handleStyle: { color: '#3b82f6' },
          textStyle: { color: '#64748b', fontSize: 9 },
        },
      ],
      series: [
        {
          name: 'K线',
          type: 'candlestick',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: klineData,
          itemStyle: {
            color: UP_COLOR, // 阳线（涨）
            color0: DOWN_COLOR, // 阴线（跌）
            borderColor: UP_COLOR,
            borderColor0: DOWN_COLOR,
          },
          // 最新价虚线标线（右侧价签，随数据刷新）
          markLine: (() => {
            const lastClose = agg[agg.length - 1]?.close;
            if (!Number.isFinite(lastClose as number)) return { data: [] };
            return {
              silent: true,
              symbol: 'none',
              lineStyle: { color: '#38bdf8', type: 'dashed' as const, width: 1, opacity: 0.75 },
              label: {
                show: true,
                position: 'insideEndTop' as const,
                formatter: `${CURRENCY}${Number(lastClose).toFixed(2)}`,
                color: '#7dd3fc',
                fontSize: 10,
                fontWeight: 700 as const,
              },
              data: [{ yAxis: lastClose }],
            };
          })(),
          markPoint: {
            data: patternMarks,
            symbol: 'pin',
            symbolSize: 46,
          },
        },
        ...maSeries,
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: agg.map((p) => ({
            value: p.volume,
            itemStyle: {
              color: p.change >= 0 ? 'rgba(239, 68, 68, 0.55)' : 'rgba(34, 197, 94, 0.55)',
            },
          })),
          barWidth: '60%',
        },
        ...(subIndicator === 'MACD'
          ? [
              {
                name: 'DIF',
                type: 'line',
                xAxisIndex: 2,
                yAxisIndex: 2,
                data: macd.dif,
                showSymbol: false,
                smooth: true,
                lineStyle: { width: 1.2, color: '#f59e0b' },
                itemStyle: { color: '#f59e0b' },
              },
              {
                name: 'DEA',
                type: 'line',
                xAxisIndex: 2,
                yAxisIndex: 2,
                data: macd.dea,
                showSymbol: false,
                smooth: true,
                lineStyle: { width: 1.2, color: '#3b82f6' },
                itemStyle: { color: '#3b82f6' },
              },
              {
                name: 'MACD柱',
                type: 'bar',
                xAxisIndex: 2,
                yAxisIndex: 2,
                data: macd.macd.map((v) => ({
                  value: v,
                  itemStyle: {
                    color: v !== null && v >= 0 ? 'rgba(239, 68, 68, 0.7)' : 'rgba(34, 197, 94, 0.7)',
                  },
                })),
                barWidth: '60%',
              },
            ]
          : subIndicator === 'RSI'
            ? [
                {
                  name: 'RSI14',
                  type: 'line',
                  xAxisIndex: 2,
                  yAxisIndex: 2,
                  data: rsi,
                  showSymbol: false,
                  smooth: true,
                  lineStyle: { width: 1.4, color: '#a78bfa' },
                  itemStyle: { color: '#a78bfa' },
                  markLine: {
                    silent: true,
                    symbol: 'none',
                    label: { show: false },
                    lineStyle: { color: '#475569', type: 'dashed' as const },
                    data: [{ yAxis: 70 }, { yAxis: 30 }],
                  },
                },
              ]
            : [
                { name: 'K', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: kdj.K, showSymbol: false, smooth: true, lineStyle: { width: 1.3, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' } },
                { name: 'D', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: kdj.D, showSymbol: false, smooth: true, lineStyle: { width: 1.3, color: '#3b82f6' }, itemStyle: { color: '#3b82f6' } },
                { name: 'J', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: kdj.J, showSymbol: false, smooth: true, lineStyle: { width: 1.1, color: '#22c55e' }, itemStyle: { color: '#22c55e' } },
              ]),
      ],
      },
      true);
  }, [allPoints, selectedPeriod, changePercent, loading, symbol, market, subIndicator]);

  // 9. 分钟副图数据源：按选中分钟周期拉取真实分钟 K 线（120分由数据服务自动聚合）
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    getMinuteKline(symbol, market, minutePeriod)
      .then((pts) => {
        if (!cancelled) setMinutePoints(pts);
      })
      .catch(() => {
        if (!cancelled) setMinutePoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, [minutePeriod, symbol, market, loading]);

  // 10. 分钟副图渲染（K 线 + MA5/10/20 + 成交量 + 最新价标线 + 缩放）
  useEffect(() => {
    const chart = minuteChartInstance.current;
    if (!chart || loading) return;

    const pts = minutePoints;
    if (pts.length === 0) {
      chart.clear();
      return;
    }
    const closes = pts.map((p) => p.close);
    // 多日数据标签：MM-DD HH:mm；单日数据标签：HH:mm
    const multiDay = pts.length > 1 && pts[0].date.slice(0, 10) !== pts[pts.length - 1].date.slice(0, 10);
    const labels = pts.map((p) => (multiDay ? `${p.date.slice(5, 10)} ${p.date.slice(11, 16)}` : p.date.slice(11, 16)));
    const klineData = pts.map((p) => [p.open, p.close, p.low, p.high]);
    const lastClose = closes[closes.length - 1];
    const periodTitle = MINUTE_PERIODS.find((p) => p.key === minutePeriod)?.title ?? '分钟';
    const upNow = pts.length > 1 ? lastClose >= pts[0].close : true;

    chart.setOption({
      backgroundColor: 'transparent',
      title: {
        text: `⚡ ${displaySymbol} ${periodTitle} K线 · 共 ${pts.length} 根 · ${pts[0].date.slice(0, 10)} ~ ${pts[pts.length - 1].date.slice(0, 10)}`,
        left: 'center',
        top: 0,
        textStyle: { fontSize: 12, fontWeight: 600, color: '#94a3b8' },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        // 同主图：限制在容器内并按宽度折行，保证浮层完整可见
        confine: true,
        extraCssText: 'max-width: min(320px, 90vw); white-space: normal;',
        backgroundColor: 'rgba(13, 19, 34, 0.92)',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 12 },
        formatter: (params: any) => {
          const list = Array.isArray(params) ? params : [params];
          const candle = list.find((p: any) => p.seriesType === 'candlestick');
          const idx = candle?.dataIndex ?? 0;
          const p = pts[idx];
          if (!p) return '';
          const chg = p.open > 0 ? ((p.close - p.open) / p.open) * 100 : 0;
          return [
            `<b>${displaySymbol} · ${p.date}</b>`,
            `开: ${CURRENCY}${p.open.toFixed(2)}  收: ${CURRENCY}${p.close.toFixed(2)} <span style="color:${chg >= 0 ? UP_COLOR : DOWN_COLOR}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>`,
            `高: ${CURRENCY}${p.high.toFixed(2)}  低: ${CURRENCY}${p.low.toFixed(2)}`,
            `量: ${formatVolume(p.volume)}`,
          ].join('<br/>');
        },
      },
      legend: {
        data: ['MA5', 'MA10', 'MA20'],
        top: 20,
        left: 'center',
        textStyle: { color: '#94a3b8', fontSize: 10 },
        itemWidth: 12,
        itemHeight: 6,
      },
      grid: [
        { left: '4%', right: '4%', top: '16%', height: '54%', containLabel: true },
        { left: '4%', right: '4%', top: '76%', height: '13%', containLabel: true },
      ],
      xAxis: [
        {
          type: 'category',
          data: labels,
          gridIndex: 0,
          boundaryGap: true,
          axisLine: { show: false },
          axisLabel: { fontSize: 9, color: '#64748b', interval: 'auto', hideOverlap: true },
        },
        {
          type: 'category',
          data: labels,
          gridIndex: 1,
          boundaryGap: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
        },
      ],
      yAxis: [
        {
          type: 'value',
          gridIndex: 0,
          scale: true,
          axisLine: { show: false },
          axisLabel: { formatter: `${CURRENCY}{value}`, fontSize: 9, color: '#64748b' },
          splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' as const } },
        },
        {
          type: 'value',
          gridIndex: 1,
          axisLine: { show: false },
          axisLabel: { formatter: (v: number) => formatVolume(v), fontSize: 8, color: '#475569' },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
        {
          type: 'slider',
          xAxisIndex: [0, 1],
          top: '93%',
          height: 14,
          backgroundColor: '#0d1322',
          borderColor: '#1e293b',
          fillerColor: 'rgba(14, 165, 233, 0.18)',
          handleStyle: { color: '#0ea5e9' },
          textStyle: { color: '#64748b', fontSize: 8 },
          showDetail: false,
        },
      ],
      series: [
        {
          name: 'K线',
          type: 'candlestick',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: klineData,
          itemStyle: {
            color: UP_COLOR,
            color0: DOWN_COLOR,
            borderColor: UP_COLOR,
            borderColor0: DOWN_COLOR,
          },
          markLine: {
            silent: true,
            symbol: 'none',
            label: {
              formatter: `最新 ${CURRENCY}${lastClose.toFixed(2)}`,
              position: 'insideEndTop',
              fontSize: 9,
              color: upNow ? UP_COLOR : DOWN_COLOR,
            },
            lineStyle: { color: upNow ? UP_COLOR : DOWN_COLOR, type: 'dashed', width: 1 },
            data: [{ yAxis: lastClose }],
          },
        },
        {
          name: 'MA5',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: calcMASeries(closes, 5),
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.1, color: '#f59e0b' },
        },
        {
          name: 'MA10',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: calcMASeries(closes, 10),
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.1, color: '#3b82f6' },
        },
        {
          name: 'MA20',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: calcMASeries(closes, 20),
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.1, color: '#a855f7' },
        },
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: pts.map((p) => ({
            value: p.volume,
            itemStyle: {
              color: p.close >= p.open ? 'rgba(239, 68, 68, 0.55)' : 'rgba(34, 197, 94, 0.55)',
            },
          })),
          barWidth: '60%',
        },
      ],
    });
  }, [minutePoints, minutePeriod, loading, symbol, market]);

  // 11. 实时走势图数据更新（分时历史 + 实时跟踪，支持 前20分钟/前2小时/实时跟踪 三模式）
  useEffect(() => {
    const chart = realtimeChartInstance.current;
    if (!chart || loading) return;

    // 时间工具：HH:mm <-> 当日分钟数
    const toMin = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const fmtMin = (v: number) =>
      `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;

    // 模式数据源：
    //   · 20m/2h —— 以【当前真实时间】为基准向前推 20 分钟/2 小时制图
    //               （数据时间已统一为北京时间；盘中窗口内为实时交易数据，
    //                 非交易时段窗口内无数据时兜底展示最近交易数据并提示）
    //   · live   —— 10 秒高频实时点（滚动窗口）
    let data: number[];
    let labels: string[] = [];
    let windowStart: string;
    let windowEnd: string;
    let fallback = false;
    if (traceMode === 'live') {
      data = liveTrace;
    } else {
      const windowMin = traceMode === '2h' ? 120 : 20;
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const pad = (v: number) => String(v).padStart(2, '0');
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const startMin = nowMin - windowMin;
      // 按当前时间窗口过滤（仅同一交易日 + 时间落在 [当前-窗口, 当前]）
      const inWindow = minuteTrace.filter((p) => {
        if ((p.date ?? today) !== today) return false;
        const m = toMin(p.time);
        return m >= startMin && m <= nowMin;
      });
      if (inWindow.length > 0) {
        data = inWindow.map((p) => p.price);
        labels = inWindow.map((p) => p.time);
        windowStart = fmtMin(startMin);
        windowEnd = fmtMin(nowMin);
        // 尾部拼接最新实时价（时间=当前）
        if (latestPrice !== null && Number.isFinite(latestPrice)) {
          const nowT = fmtMin(now.getHours() * 60 + now.getMinutes());
          data = [...data, latestPrice];
          labels = [...labels, nowT];
        }
      } else {
        // 非交易时段兜底：展示最近 windowMin 个交易数据点（轴按数据真实时间）
        fallback = true;
        const base = minuteTrace.slice(-windowMin);
        data = base.map((p) => p.price);
        labels = base.map((p) => p.time);
        windowStart = labels[0] ?? '';
        windowEnd = labels[labels.length - 1] ?? '';
      }
      setTraceWindow({ start: windowStart, end: windowEnd, fallback });
    }
    const first = data[0];
    const lastV = data[data.length - 1];
    const changePct =
      first !== undefined && lastV !== undefined && first > 0
        ? ((lastV - first) / first) * 100
        : 0;
    const upNow = changePct >= 0;
    const showTimeAxis = traceMode !== 'live';
    const axisInterval =
      labels.length > 12 ? Math.max(0, Math.ceil(labels.length / 6) - 1) : 0;

    chart.setOption({
      grid: { left: 8, right: 8, top: 12, bottom: showTimeAxis ? 18 : 6 },
      tooltip: {
        trigger: 'axis',
        // 分时图浮层同样限制在容器内，避免溢出页面
        confine: true,
        extraCssText: 'max-width: min(280px, 90vw); white-space: normal;',
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : params;
          if (!p) return '';
          const t = showTimeAxis && labels[p.dataIndex] ? labels[p.dataIndex] : new Date().toLocaleTimeString();
          return `${displaySymbol} 实时走势（${traceMode === '20m' ? '前20分钟' : traceMode === '2h' ? '前2小时' : '实时跟踪'}）<br/>时间: ${t}<br/>价格: ${CURRENCY}${Number(p.value).toFixed(2)}`;
        },
      },
      xAxis: {
        type: 'category',
        show: showTimeAxis,
        data: showTimeAxis ? labels : data.map((_, i) => i),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 9, color: '#64748b', interval: axisInterval, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        show: false,
        scale: true,
      },
      series: [
        {
          name: '实时价',
          type: 'line',
          data,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: upNow ? UP_COLOR : DOWN_COLOR, width: 2 },
          areaStyle: {
            color: upNow ? 'rgba(239, 68, 68, 0.08)' : 'rgba(34, 197, 94, 0.08)',
          },
        },
      ],
    });
  }, [minuteTrace, liveTrace, traceMode, latestPrice, loading, symbol, market]);

  // 12. 数据加载主流程 + 启动实时轮询（URL 参数变化时自动重载，保留 10 秒轮询机制）
  useEffect(() => {
    resetDashboard();
    setIsSearching(true);
    setLoading(true);
    setFav(isFavorite(symbol)); // 同步当前股票的收藏状态

    fetchHistoricalData(symbol, market);
    // eslint-disable-next-line react-hooks/exhaustive-deps

    const stopPolling = setVisibilityInterval(() => {
      fetchRealtimeQuote(symbol, market);
    }, POLL_INTERVAL);

    return () => stopPolling();
  }, [symbol, market, adjustMode]);

  // 13. 辅助函数
  const formatCurrency = (value: number | null) => {
    if (value === null) return '--';
    return `${CURRENCY}${value.toFixed(2)}`;
  };

  /** RSI 配色：>70 超买红，<30 超卖绿，其余正常 */
  const rsiColor = (value: number | null) => {
    if (value === null) return '#64748b';
    if (value > 70) return UP_COLOR;
    if (value < 30) return DOWN_COLOR;
    return '#94a3b8';
  };

  // 个股资讯：经服务端匹配引擎打分后按相关度返回，只展示高置信部分
  const [stockNews, setStockNews] = useState<NewsItem[]>([]);
  const [stockNewsName, setStockNewsName] = useState<string>('');
  useEffect(() => {
    let alive = true;
    setStockNews([]);
    newsApi
      .get('stock', displaySymbol, 20)
      .then((r) => {
        if (!alive) return;
        setStockNewsName(r.stockName || '');
        setStockNews((r.items || []).filter((x) => (x.matchScore ?? 0) >= 0.7).slice(0, 6));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [displaySymbol]);

  // 东方财富数据面板（资金流/财务/估值），服务端带缓存
  const [feed, setFeed] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    setFeed(null);
    feedApi
      .get(displaySymbol)
      .then((f) => {
        if (alive) setFeed(f);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [displaySymbol]);

  // ── 价格横幅派生值（最后一根日 K 的 OHLCV）与五因子评分 ──
  const lastBar = allPoints.length ? allPoints[allPoints.length - 1] : null;
  const prevClose = allPoints.length > 1 ? allPoints[allPoints.length - 2].close : null;
  const dailyCloses = useMemo(() => allPoints.map((p) => p.close), [allPoints]);
  const factorScore = useMemo(() => {
    if (allPoints.length < 60) return null;
    try {
      return analyzeStockPotential(symbol, allPoints, {
        price: latestPrice ?? allPoints[allPoints.length - 1]?.close ?? 0,
        changePercent: changePercent ?? 0,
      });
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, allPoints, latestPrice]);

  // ── 深色主题通用样式 ──
  const cardStyle: React.CSSProperties = {
    backgroundColor: 'rgba(17,24,39,0.6)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    borderRadius: '12px',
    border: '1px solid rgba(96,165,250,0.16)',
    boxShadow: '0 10px 36px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)',
  };

  // 信息面板卡片：在 CSS 多列容器中禁止跨列拆分，并统一底部间距
  const panelCardStyle: React.CSSProperties = {
    ...cardStyle,
    breakInside: 'avoid',
    marginBottom: '16px',
    width: '100%',
  };

  // 14. 渲染
  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          backgroundColor: '#0a0e17',
          color: '#94a3b8',
        }}
      >
        <div style={{ fontSize: '26px', marginBottom: '12px' }}>⏳</div>
        <div style={{ fontSize: '16px' }}>正在加载 {displaySymbol} 数据...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          minHeight: '100vh',
          backgroundColor: '#0a0e17',
          color: '#e2e8f0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ padding: '40px', textAlign: 'center', maxWidth: '600px' }}>
          <h2 style={{ color: '#f87171', marginTop: 0 }}>⚠️ 数据加载失败</h2>
          <p style={{ color: '#94a3b8', margin: '16px 0' }}>{error}</p>
          <p style={{ fontSize: '14px', color: '#64748b', marginBottom: '20px' }}>
            请检查：
            <br />
            1. 网络连接是否正常（可能需要科学上网）
            <br />
            2. 股票代码是否正确（当前: {displaySymbol}，识别市场: {marketLabel(market)}）
            <br />
            3. 或在上方搜索框重新输入其他代码
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '12px' }}>
            <button
              onClick={() => {
                setError(null);
                setLoading(true);
                fetchHistoricalData(symbol, market);
              }}
              style={{
                padding: '10px 28px',
                backgroundColor: '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              🔄 重试
            </button>
            <button
              onClick={() => navigate('/')}
              style={{
                padding: '10px 28px',
                backgroundColor: '#1e293b',
                color: '#e2e8f0',
                border: '1px solid #334155',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              🏠 返回主页
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
                ...theme.page,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* 顶部导航已提升为 App 内全局单例（见 App.tsx） */}

      {/* ── 顶部：导航栏 + 搜索框 ── */}
      {/* 顶部导航（全站统一） */}

      {/* 页面标题行 + 工具条（搜索 / 收藏） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
          padding: '18px 28px 0',
        }}
      >
        <h1 style={{ fontSize: '19px', fontWeight: '700', margin: 0, color: '#f1f5f9' }}>
          {displaySymbol}
          {stockName && (
            <span
              style={{
                marginLeft: '10px',
                fontSize: '14px',
                fontWeight: '500',
                color: '#94a3b8',
                backgroundColor: '#1e293b',
                padding: '2px 10px',
                borderRadius: '999px',
              }}
            >
              {stockName}
            </span>
          )}
        </h1>
        <span style={{ color: '#64748b', fontSize: '12px' }}>
          {marketLabel(market)} · 每 {POLL_INTERVAL / 1000} 秒自动更新 · 数据来源: 独立数据服务 (新浪/腾讯)
        </span>
        <span style={{ flex: 1 }} />
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSearch();
          }}
          placeholder="输入股票代码 (如 AAPL, NVDA, 600519)"
          style={{
            border: '1px solid #334155',
            outline: 'none',
            background: '#111827',
            fontSize: '13px',
            color: '#e2e8f0',
            width: '210px',
            padding: '8px 12px',
            borderRadius: '8px',
          }}
        />
        <button
          onClick={handleSearch}
          disabled={isSearching}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: '600',
            color: '#ffffff',
            backgroundColor: isSearching ? '#475569' : '#2563eb',
            border: 'none',
            borderRadius: '8px',
            cursor: isSearching ? 'default' : 'pointer',
            transition: 'all 0.2s',
          }}
        >
          {isSearching ? (
            <>
              <span className="dsh-spin">⏳</span> 搜索中
            </>
          ) : (
            <>🔍 搜索</>
          )}
        </button>
        <button
          onClick={handleToggleFavorite}
          title={fav ? '取消收藏' : '收藏该股票'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '8px 12px',
            fontSize: '13px',
            fontWeight: '600',
            color: fav ? '#f59e0b' : '#94a3b8',
            backgroundColor: fav ? 'rgba(245, 158, 11, 0.12)' : '#111827',
            border: fav ? '1px solid rgba(245, 158, 11, 0.4)' : '1px solid #334155',
            borderRadius: '8px',
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
        >
          {fav ? '★ 已收藏' : '☆ 收藏'}
        </button>
      </div>

      <main style={{ padding: '24px 20px 32px' }}>
        {/* ── 价格横幅（同花顺式）：现价大字 + 关键指标横排 ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '26px',
            flexWrap: 'wrap',
            marginBottom: '14px',
            padding: '14px 20px',
            ...cardStyle,
          }}
        >
          <div style={{ minWidth: '160px' }}>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: 2 }}>
              最新价{updateTime ? ` · ${updateTime}` : ''}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span
                style={{
                  fontSize: '30px',
                  fontWeight: 800,
                  color: pctColor(changePercent),
                  fontFamily: 'Consolas, monospace',
                }}
              >
                {formatCurrency(latestPrice)}
              </span>
              <span style={{ fontSize: '18px', fontWeight: 700, color: pctColor(changePercent) }}>
                {formatPercent(changePercent)}
              </span>
            </div>
          </div>
          {/* 窄屏换 2 列并允许收缩：3 列定宽在手机上会溢出，右列（最高/近30日）被裁掉 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))',
              gap: '8px 16px',
              fontSize: '13px',
            }}
          >
            {[
              { label: '今开', value: lastBar ? formatCurrency(lastBar.open) : '--', color: '#e2e8f0' },
              { label: '昨收', value: prevClose ? formatCurrency(prevClose) : '--', color: '#e2e8f0' },
              { label: '最高', value: lastBar ? formatCurrency(lastBar.high) : '--', color: '#ef4444' },
              { label: '最低', value: lastBar ? formatCurrency(lastBar.low) : '--', color: '#22c55e' },
              { label: '成交量', value: lastBar?.volume != null ? formatVolume(lastBar.volume) : '--', color: '#e2e8f0' },
              { label: `近${HISTORY_COUNT}日`, value: formatPercent(rangeChange), color: pctColor(rangeChange) },
            ].map((it) => (
              <div key={it.label} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <span style={{ color: '#64748b', marginRight: 8 }}>{it.label}</span>
                <span style={{ color: it.color, fontWeight: 600, fontFamily: 'Consolas, monospace' }}>{it.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── 阶段涨跌幅摘要 ── */}
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
          {[
            { label: '今日', value: todayChange },
            { label: '本周', value: weekChange },
            { label: '本月', value: monthChange },
            { label: '年初至今', value: ytdChange },
          ].map((item) => {
            const v = item.value;
            return (
              <div
                key={item.label}
                style={{
                  flex: '1 1 140px',
                  textAlign: 'center',
                  padding: '10px 14px',
                  backgroundColor: v === null ? 'rgba(100,116,139,0.12)' : v >= 0 ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)',
                  borderRadius: '10px',
                  border: `1px solid ${v === null ? '#1e293b' : v >= 0 ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`,
                }}
              >
                <span style={{ fontSize: '12px', color: '#94a3b8', marginRight: 8 }}>{item.label}</span>
                <span style={{ fontSize: '16px', fontWeight: 700, color: pctColor(v) }}>{formatPercent(v)}</span>
              </div>
            );
          })}
        </div>

        {/* ── 两栏信息面板：CSS 多列按内容高度自动均衡，
             避免某一栏明显偏短导致页面下方出现大块空白 ── */}
        <div
          style={{
            columnCount: 2,
            columnWidth: '340px',
            columnGap: '16px',
            marginBottom: '16px',
          }}
        >
          <div
            style={{
              position: 'relative',
              marginBottom: '16px',
              borderRadius: '12px',
              border: '1px solid #1e293b',
              backgroundColor: '#111827',
              overflow: 'hidden',
              breakInside: 'avoid',
              width: '100%',
            }}
          >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              flexWrap: 'wrap',
              padding: '10px 12px 0',
            }}
          >
            <div
              style={{
                fontSize: '12px',
                color: '#60a5fa',
                fontWeight: '600',
                backgroundColor: 'rgba(59, 130, 246, 0.12)',
                padding: '3px 10px',
                borderRadius: '999px',
                border: '1px solid rgba(59, 130, 246, 0.3)',
              }}
            >
              ● 实时走势
            </div>
            {/* 窗口模式选择：前20分钟 / 前2小时 / 实时跟踪 */}
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              {(
                [
                  { key: '20m', label: '前20分钟' },
                  { key: '2h', label: '前2小时' },
                  { key: 'live', label: '实时跟踪' },
                ] as const
              ).map((m) => {
                const active = traceMode === m.key;
                return (
                  <button
                    key={m.key}
                    onClick={() => setTraceMode(m.key)}
                    style={{
                      padding: '3px 12px',
                      fontSize: '12px',
                      fontWeight: active ? '700' : '500',
                      color: active ? '#ffffff' : '#94a3b8',
                      backgroundColor: active ? '#0ea5e9' : '#1e293b',
                      border: active ? '1px solid #0ea5e9' : '1px solid #334155',
                      borderRadius: '999px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div
            style={{
              fontSize: '11px',
              color: '#64748b',
              padding: '8px 12px 0',
            }}
          >
            {traceMode === '20m' &&
              (traceWindow
                ? traceWindow.fallback
                  ? `🌙 当前时段无交易数据 · 最近 20 分钟交易数据（${traceWindow.start} ~ ${traceWindow.end}）`
                  : `⏱ 以当前时间 ${traceWindow.end} 为基准向前 20 分钟（${traceWindow.start} ~ ${traceWindow.end}）· 真实时间轴 · 尾部实时更新`
                : '正在获取分时数据...')}
            {traceMode === '2h' &&
              (traceWindow
                ? traceWindow.fallback
                  ? `🌙 当前时段无交易数据 · 最近 2 小时交易数据（${traceWindow.start} ~ ${traceWindow.end}）`
                  : `⏱ 以当前时间 ${traceWindow.end} 为基准向前 2 小时（${traceWindow.start} ~ ${traceWindow.end}）· 真实时间轴 · 尾部实时更新`
                : '正在获取分时数据...')}
            {traceMode === 'live' &&
              (liveTrace.length > 0
                ? `每 ${POLL_INTERVAL / 1000} 秒实时跟踪 · 当前 ${liveTrace.length} 个点（约 ${Math.round((liveTrace.length * POLL_INTERVAL) / 60000)} 分钟滚动窗口）`
                : '正在获取分时数据...')}
          </div>
          <div
            ref={realtimeChartRef}
            style={{
              width: '100%',
              height: '160px',
              padding: '4px',
            }}
          />
        </div>

        {/* ── 副图指标切换 ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '8px',
          }}
        >
          <span style={{ fontSize: '12px', color: '#64748b', marginRight: 4 }}>副图指标</span>
          {(['MACD', 'RSI', 'KDJ'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSubIndicator(s)}
              style={{
                padding: '5px 16px',
                fontSize: '12px',
                fontWeight: subIndicator === s ? '700' : '500',
                color: subIndicator === s ? '#ffffff' : '#94a3b8',
                backgroundColor: subIndicator === s ? '#0891b2' : '#1e293b',
                border: subIndicator === s ? '1px solid #0891b2' : '1px solid #334155',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* ── 复权切换（仅 A 股） + 周期切换按钮 + 主图（K线） ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '8px',
            marginBottom: '8px',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {isCNStock && (
            <>
              <span style={{ fontSize: '12px', color: '#64748b', marginRight: 4 }}>复权</span>
              {(['qfq', 'hfq', 'none'] as const).map((a) => (
                <button
                  key={a}
                  onClick={() => setAdjustMode(a)}
                  title={a === 'qfq' ? '以前最新价为基准向后调整历史价格（主流看盘口径）' : a === 'hfq' ? '以历史真实价格为基准向前调整（适合量化回测保持连续性）' : '交易所原始价格（分红除权日有跳空）'}
                  style={{
                    padding: '5px 13px',
                    fontSize: '12px',
                    fontWeight: adjustMode === a ? '700' : '500',
                    color: adjustMode === a ? '#ffffff' : '#94a3b8',
                    backgroundColor: adjustMode === a ? '#7c3aed' : '#1e293b',
                    border: adjustMode === a ? '1px solid #7c3aed' : '1px solid #334155',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all .15s',
                  }}
                >
                  {ADJUST_LABEL[a]}
                </button>
              ))}
              <span style={{ width: 1, height: 18, backgroundColor: '#334155', margin: '0 6px' }} />
              {actualAdjust && !actualAdjust.startsWith(adjustMode) && (
                <span
                  style={{ fontSize: '12px', color: '#f59e0b', marginRight: 6 }}
                  title="主行情源暂不可用，已回退备用数据源；除权除息日会出现假跳空，指标与涨跌幅可能与所选口径不一致"
                >
                  ⚠ 实际口径：{formatAdjust(actualAdjust)}
                </span>
              )}
            </>
          )}
          {PERIODS.map((p) => {
            const active = selectedPeriod === p.key;
            // 季线/年线：后端周期策略判定数据不足时按钮置灰（点击仍提示原因）
            const insufficient = !isPeriodAvailable(p.key);
              return (
              <button
                key={p.key}
                onClick={() => handlePeriodSelect(p.key)}
                title={insufficient ? '历史数据不足' : undefined}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  fontWeight: active ? '700' : '500',
                  color: active ? '#ffffff' : insufficient ? '#475569' : '#94a3b8',
                  backgroundColor: active ? '#2563eb' : insufficient ? '#0d1322' : '#1e293b',
                  border: active
                    ? '1px solid #2563eb'
                    : insufficient
                      ? '1px dashed #334155'
                      : '1px solid #334155',
                  borderRadius: '8px',
                  cursor: insufficient && !active ? 'not-allowed' : 'pointer',
                  opacity: insufficient && !active ? 0.65 : 1,
                  transition: 'all 0.2s',
                }}
              >
                {p.label}
                {insufficient && !active && <span style={{ marginLeft: '4px', fontSize: '10px' }}>·数据不足</span>}
              </button>
            );
          })}
        </div>
        {periodNotice && (
          <div
            style={{
              textAlign: 'center',
              fontSize: '12px',
              color: '#f59e0b',
              backgroundColor: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              borderRadius: '8px',
              padding: '8px 14px',
              margin: '0 auto 12px',
              maxWidth: '520px',
            }}
          >
            {periodNotice}
          </div>
        )}
        <p
          style={{
            textAlign: 'center',
            color: '#64748b',
            fontSize: '12px',
            margin: '0 0 12px',
          }}
        >
          当前 {PERIODS.find((p) => p.key === selectedPeriod)?.title ?? '日线'}：共{' '}
          <b>{aggregatedData.length}</b> 个周期数据点 · 横轴刻度：每格 =
          {PERIODS.find((p) => p.key === selectedPeriod)?.tick ?? '1个交易日'}
        </p>

        {/* 整合后的图表区：主K线 + 短期K线 同一卡片内上下排布
            · 主图占 ~62%，短期副图占剩余空间，中间以切换条分隔
            · 共享缩放比例与十字光标联动（见 useEffect 7） */}
        <div
          ref={chartGroupRef}
          style={{
            width: '100%',
            height: 'clamp(640px, 72vh, 920px)',
            borderRadius: '12px',
            border: '1px solid #1e293b',
            backgroundColor: '#111827',
            padding: '6px',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          {/* 主图（K线 + 成交量 + MACD/RSI/KDJ） */}
          <div
            ref={chartRef}
            style={{ width: '100%', flex: '0 0 62%', minHeight: 0 }}
          />
          {/* 短期副图切换条：周期 + 根数 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 6px',
              borderTop: '1px dashed #1e293b',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>短期副图</span>
            {MINUTE_PERIODS.map((p) => {
              const active = minutePeriod === p.key;
              return (
                <button
                  key={p.key}
                  onClick={() => setMinutePeriod(p.key)}
                  style={{
                    padding: '3px 10px',
                    fontSize: '12px',
                    fontWeight: active ? '700' : '500',
                    color: active ? '#ffffff' : '#94a3b8',
                    backgroundColor: active ? '#0ea5e9' : '#1e293b',
                    border: active ? '1px solid #0ea5e9' : '1px solid #334155',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  {p.label}
                </button>
              );
            })}
            <span style={{ fontSize: 11, color: '#475569' }}>
              {minutePoints.length > 0 ? `共 ${minutePoints.length} 根` : ''}
            </span>
          </div>
          {/* 短期K线（1/5/15/30/60/120 分钟） */}
          <div
            ref={minuteChartRef}
            style={{ width: '100%', flex: '1 1 auto', minHeight: 0 }}
          />
        </div>

          {/* 五因子评分（移入左栏，平衡双栏高度） */}
            {/* 五因子评分 */}
            <div style={{ ...panelCardStyle, padding: '14px 16px' }}>
              <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>🧮 五因子评分</div>
              {factorScore ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <svg width="56" height="56" style={{ flexShrink: 0 }}>
                    <circle cx="28" cy="28" r="22" stroke="#1e293b" strokeWidth="5" fill="none" />
                    <circle
                      cx="28"
                      cy="28"
                      r="22"
                      stroke={
                        factorScore.total >= 80
                          ? '#ef4444'
                          : factorScore.total >= 65
                            ? '#f59e0b'
                            : factorScore.total >= 45
                              ? '#60a5fa'
                              : '#94a3b8'
                      }
                      strokeWidth="5"
                      fill="none"
                      strokeLinecap="round"
                      strokeDasharray={(2 * Math.PI * 22).toFixed(1)}
                      strokeDashoffset={(2 * Math.PI * 22 * (1 - Math.min(factorScore.total, 100) / 100)).toFixed(1)}
                      transform="rotate(-90 28 28)"
                    />
                    <text x="28" y="32" textAnchor="middle" fontSize="13" fontWeight="700" fill="#e2e8f0">
                      {factorScore.total}
                    </text>
                  </svg>
                  <div style={{ fontSize: '12px', lineHeight: 1.7 }}>
                    <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '15px' }}>{factorScore.rating}</div>
                    <div style={{ color: '#64748b' }}>五因子综合评估</div>
                    <span style={{ color: '#60a5fa', cursor: 'pointer' }} onClick={() => navigate(`/analyze?symbol=${displaySymbol}`) }>
                      查看完整分析 →
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: '#475569' }}>历史数据不足，暂无法评分</div>
              )}
            </div>


            {/* 资金与基本面（东方财富公开数据） */}
            {feed && (feed.moneyFlow || feed.fundamentals || feed.valuation) && (
              <div style={{ ...panelCardStyle, padding: '14px 16px' }}>
                <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '8px' }}>💰 资金与基本面</div>
                {feed.moneyFlow && (
                  <div style={{ fontSize: '12.5px', marginBottom: 10, lineHeight: 1.8 }}>
                    <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 2 }}>主力资金（近 10 日）</div>
                    <div>
                      5日 <b style={{ color: feed.moneyFlow.sum5 >= 0 ? '#ef4444' : '#22c55e', fontFamily: 'Consolas,monospace' }}>
                        {(feed.moneyFlow.sum5 / 1e8).toFixed(2)} 亿
                      </b>
                      {' · '}10日{' '}
                      <b style={{ color: feed.moneyFlow.sum10 >= 0 ? '#ef4444' : '#22c55e', fontFamily: 'Consolas,monospace' }}>
                        {(feed.moneyFlow.sum10 / 1e8).toFixed(2)} 亿
                      </b>
                    </div>
                    <div style={{ color: '#64748b', fontSize: 11.5 }}>
                      {feed.moneyFlow.streak > 0
                        ? `连续净流入 ${feed.moneyFlow.streak} 日`
                        : feed.moneyFlow.streak < 0
                          ? `连续净流出 ${-feed.moneyFlow.streak} 日`
                          : ''}
                    </div>
                  </div>
                )}
                {feed.fundamentals && (
                  <div style={{ fontSize: '12.5px', lineHeight: 1.9 }}>
                    <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 2 }}>财务快照（{feed.fundamentals.reportDate}）</div>
                    {[
                      ['加权ROE', feed.fundamentals.roe != null ? `${feed.fundamentals.roe.toFixed(1)}%` : '--'],
                      ['每股收益', feed.fundamentals.eps != null ? feed.fundamentals.eps.toFixed(2) : '--'],
                      ['毛利率', feed.fundamentals.grossMargin != null ? `${feed.fundamentals.grossMargin.toFixed(1)}%` : '--'],
                      ['净利同比', feed.fundamentals.profitYoY != null ? `${feed.fundamentals.profitYoY > 0 ? '+' : ''}${feed.fundamentals.profitYoY.toFixed(1)}%` : '--'],
                      ['负债率', feed.fundamentals.debt != null ? `${feed.fundamentals.debt.toFixed(1)}%` : '--'],
                    ].map(([l, v]) => (
                      <div key={l} style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#94a3b8' }}>{l}</span>
                        <span style={{ color: '#e2e8f0', fontFamily: 'Consolas,monospace' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )}
                {feed.valuation && (
                  <div style={{ fontSize: '12.5px', marginTop: 8, color: '#e2e8f0' }}>
                    <span style={{ color: '#94a3b8', marginRight: 6 }}>估值</span>
                    PE {feed.valuation.pe != null ? feed.valuation.pe.toFixed(1) : '--'} · PB{' '}
                    {feed.valuation.pb != null ? feed.valuation.pb.toFixed(2) : '--'}
                    {feed.valuation.marketCap != null ? ` · 总市值 ${(feed.valuation.marketCap / 1e8).toFixed(0)} 亿` : ''}
                  </div>
                )}
              </div>
            )}

            {(stockNews.length > 0 || feed?.announcements?.length) ? (
              <div style={{ ...panelCardStyle, padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: '14px' }}>📰 近三天相关资讯</div>
                  <a href={`/news?type=stock&symbol=${encodeURIComponent(displaySymbol)}`} style={{ color: '#60a5fa', fontSize: 12, textDecoration: 'none' }}>
                    查看全部 →
                  </a>
                </div>
                {stockNews.length > 0 ? (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {stockNews.map((n) => (
                      <div key={n.id} style={{ paddingBottom: 8, borderBottom: '1px solid #1e293b' }}>
                        <a href={n.url} target="_blank" rel="noreferrer" style={{ color: '#e2e8f0', fontSize: 12.5, lineHeight: 1.6, textDecoration: 'none' }}>
                          {n.title}
                        </a>
                        <div style={{ marginTop: 4, color: '#64748b', fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ color: '#6ee7b7' }}>置信 {((n.matchScore ?? 0) * 100).toFixed(0)}</span>
                          {n.matchReason ? <span>{n.matchReason}</span> : null}
                          <span>{n.media}</span>
                          <span>{String(n.publishedAt || '').slice(5, 16).replace('T', ' ')}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div style={{ marginTop: 8, color: '#64748b', fontSize: 11.5, lineHeight: 1.7 }}>
                  公告 {feed?.announcements?.length ?? 0} 条 · 高置信资讯 {stockNews.length} 条{stockNewsName ? `（${stockNewsName}）` : ''}；以原文为准
                </div>
              </div>
            ) : null}


          {/* 五档盘口 */}
            <div style={{ ...panelCardStyle, padding: '14px 16px' }}>
              <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '8px' }}>
                📊 五档盘口{book?.quoteTime ? <span style={{ fontSize: 11, color: '#64748b' }}> · {book.quoteTime}</span> : null}
              </div>
              {book && book.bids.length > 0 && book.asks.length > 0 ? (
                (() => {
                  const maxQ = Math.max(...book.bids.map((b) => b.qty), ...book.asks.map((a) => a.qty), 1);
                  const Row = ({ label, lvl, color }: { label: string; lvl: { price: number; qty: number }; color: string }) => (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '2px 0' }}>
                      <span style={{ width: 28, color: '#64748b' }}>{label}</span>
                      <span style={{ width: 70, textAlign: 'right', color, fontFamily: 'Consolas, monospace', fontWeight: 600 }}>{lvl.price.toFixed(2)}</span>
                      <div style={{ flex: 1, height: 9, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${(lvl.qty / maxQ) * 100}%`, height: '100%', backgroundColor: color, opacity: 0.35 }} />
                      </div>
                      <span style={{ width: 60, textAlign: 'right', color: '#94a3b8' }}>{lvl.qty.toLocaleString()}</span>
                    </div>
                  );
                  return (
                    <>
                      {[...book.asks].slice(0, 5).reverse().map((a, i) => (
                        <Row key={`a${i}`} label={`卖${5 - i}`} lvl={a} color="#22c55e" />
                      ))}
                      <div
                        style={{
                          display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#64748b',
                          padding: '4px 0', borderTop: '1px dashed #1e293b', borderBottom: '1px dashed #1e293b', margin: '4px 0',
                        }}
                      >
                        <span>最新</span>
                        <span style={{ color: '#f1f5f9', fontFamily: 'Consolas, monospace', fontWeight: 700 }}>{formatCurrency(latestPrice)}</span>
                        <span>{formatPercent(changePercent)}</span>
                      </div>
                      {book.bids.slice(0, 5).map((b, i) => (
                        <Row key={`b${i}`} label={`买${i + 1}`} lvl={b} color="#ef4444" />
                      ))}
                    </>
                  );
                })()
              ) : (
                <div style={{ fontSize: '12px', color: '#475569' }}>该市场暂无五档盘口数据</div>
              )}
            </div>

            {/* 分笔成交（逐笔，仅 A 股） */}
            <div style={{ ...panelCardStyle, padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontWeight: 700, fontSize: '14px' }}>📄 分笔成交</div>
                {ticks && ticks.length > 0 && (
                  <span style={{ fontSize: 10.5, color: '#475569' }}>东财逐笔 · {ticks.length} 笔{session.open ? ' · 15s 自动刷新' : ' · 休市中，数据为最近交易日'}</span>
                )}
              </div>
              {!isCNStock ? (
                <div style={{ fontSize: '12px', color: '#475569' }}>分笔成交仅支持 A 股（当前为{marketLabel(market)}市场）</div>
              ) : ticksErr ? (
                <div style={{ fontSize: '12px', color: '#f87171' }}>⚠️ {ticksErr}</div>
              ) : !ticks ? (
                <div style={{ fontSize: '12px', color: '#475569' }}>加载逐笔数据中…</div>
              ) : ticks.length === 0 ? (
                <div style={{ fontSize: '12px', color: '#475569' }}>暂无逐笔数据（非交易日或停牌）</div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, fontSize: 10.5, color: '#475569', padding: '2px 4px 6px', borderBottom: '1px solid #1e293b' }}>
                    <span style={{ width: 58 }}>时间</span>
                    <span style={{ width: 64, textAlign: 'right' }}>成交价</span>
                    <span style={{ width: 44, textAlign: 'right' }}>变动</span>
                    <span style={{ width: 52, textAlign: 'right' }}>手数</span>
                    <span style={{ width: 26, textAlign: 'center' }}>性质</span>
                  </div>
                  <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {(showAllTicks ? ticks : ticks.slice(0, 80)).map((t, i) => {
                      const big = t.vol >= 300;
                      return (
                        <div
                          key={i}
                          style={{
                            display: 'flex', gap: 8, fontSize: 11.5, padding: '2.5px 4px', borderRadius: 4,
                            fontFamily: 'Consolas, monospace',
                            backgroundColor: big ? 'rgba(245,158,11,0.07)' : i % 2 ? 'rgba(148,163,184,0.03)' : 'transparent',
                          }}
                          title={big ? `大单 ${t.vol} 手` : undefined}
                        >
                          <span style={{ width: 58, color: '#64748b' }}>{t.time}</span>
                          <span style={{ width: 64, textAlign: 'right', color: t.chg >= 0 ? '#ef4444' : '#22c55e' }}>{t.price.toFixed(2)}</span>
                          <span style={{ width: 44, textAlign: 'right', color: '#64748b' }}>{t.chg > 0 ? '+' : ''}{t.chg}</span>
                          <span style={{ width: 52, textAlign: 'right', color: big ? '#f59e0b' : '#cbd5e1', fontWeight: big ? 700 : 400 }}>{t.vol}</span>
                          <span
                            style={{
                              width: 26, textAlign: 'center', fontWeight: 700, borderRadius: 4, fontSize: 10.5,
                              color: t.type === 'B' ? '#ef4444' : t.type === 'S' ? '#22c55e' : '#94a3b8',
                              backgroundColor: t.type === 'B' ? 'rgba(239,68,68,0.1)' : t.type === 'S' ? 'rgba(34,197,94,0.1)' : 'transparent',
                            }}
                          >
                            {t.type === 'B' ? 'B' : t.type === 'S' ? 'S' : '—'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {ticks.length > 80 && (
                    <button
                      onClick={() => setShowAllTicks((v) => !v)}
                      style={{ marginTop: 8, width: '100%', padding: '6px 0', fontSize: 11.5, color: '#93c5fd', backgroundColor: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)', borderRadius: 8, cursor: 'pointer' }}
                    >
                      {showAllTicks ? '收起，仅显示最近 80 笔' : `展开全部 ${ticks.length} 笔`}
                    </button>
                  )}
                  <div style={{ marginTop: 8, fontSize: 10, color: '#475569', lineHeight: 1.6 }}>
                    <span style={{ color: '#ef4444' }}>B</span> 买盘主动成交 · <span style={{ color: '#22c55e' }}>S</span> 卖盘主动成交 · 黄底 = 单笔 ≥ 300 手大单
                  </div>
                </>
              )}
            </div>

            {/* 关键均线 */}
            <div style={{ ...panelCardStyle, padding: '14px 16px' }}>
              <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '8px' }}>📐 关键均线（日）</div>
              {[5, 10, 20, 60].map((n) => {
                const v = calcMA(dailyCloses, n);
                return (
                  <div
                    key={n}
                    style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #1e293b', fontSize: '13px' }}
                  >
                    <span style={{ color: '#94a3b8' }}>MA{n}</span>
                    <span
                      style={{
                        color: v != null && latestPrice != null ? (latestPrice >= v ? '#ef4444' : '#22c55e') : '#e2e8f0',
                        fontFamily: 'Consolas, monospace',
                      }}
                    >
                      {v != null ? v.toFixed(2) : '--'}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* 模拟交易直达 */}
            <div style={{ ...panelCardStyle, padding: '14px 16px' }}>
              <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>💰 模拟交易直达</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  style={{
                    flex: 1, padding: '10px 0', fontSize: '13px', fontWeight: 700, color: '#fff',
                    backgroundColor: '#16a34a', border: 'none', borderRadius: '8px', cursor: 'pointer',
                  }}
                  onClick={() => navigate(`/paper?symbol=${displaySymbol}&side=buy`)}
                >
                  买入
                </button>
                <button
                  style={{
                    flex: 1, padding: '10px 0', fontSize: '13px', fontWeight: 700, color: '#fff',
                    backgroundColor: '#dc2626', border: 'none', borderRadius: '8px', cursor: 'pointer',
                  }}
                  onClick={() => navigate(`/paper?symbol=${displaySymbol}&side=sell`)}
                >
                  卖出
                </button>
              </div>
              <div style={{ fontSize: '11px', color: '#475569', marginTop: '8px' }}>
                跳转模拟盘并自动填入 {displaySymbol}
              </div>
            </div>
        </div>

        {/* ── 技术指标面板 ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '16px',
            marginTop: '16px',
            marginBottom: '24px',
            flexWrap: 'wrap',
          }}
        >
          {[
            { title: 'MA5 · 短期趋势', value: formatCurrency(ma5), color: '#e2e8f0' },
            { title: 'MA10 · 中期趋势', value: formatCurrency(ma10), color: '#e2e8f0' },
            { title: 'MA20 · 长期趋势', value: formatCurrency(ma20), color: '#e2e8f0' },
            {
              title: `RSI(14) · ${rsi14 === null ? '' : rsi14 > 70 ? '超买' : rsi14 < 30 ? '超卖' : '正常'}`,
              value: rsi14 === null ? '--' : rsi14.toFixed(1),
              color: rsiColor(rsi14),
            },
          ].map((item) => (
            <div
              key={item.title}
              style={{
                flex: '1 1 150px',
                maxWidth: '190px',
                textAlign: 'center',
                padding: '12px 14px',
                ...cardStyle,
              }}
            >
              <div style={{ fontSize: '12px', color: '#64748b', fontWeight: '500' }}>
                {item.title}
              </div>
              <div
                style={{ fontSize: '18px', fontWeight: '700', color: item.color, marginTop: '2px' }}
              >
                {item.value}
              </div>
            </div>
          ))}
        </div>

        {/* ── 数据统计概览 ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '24px',
            flexWrap: 'wrap',
            padding: '12px 16px',
            backgroundColor: '#0d1322',
            borderRadius: '10px',
            border: '1px solid #1e293b',
            fontSize: '13px',
            color: '#94a3b8',
            marginBottom: '16px',
          }}
        >
          <span>
            📅 数据范围:{' '}
            <b style={{ color: '#e2e8f0' }}>
              {stats ? `${stats.startDate} ~ ${stats.endDate}` : '--'}
            </b>
          </span>
          <span>
            🗓️ 总交易日: <b style={{ color: '#e2e8f0' }}>{priceHistory.length} 天</b>
          </span>
          <span>
            🔺 最高: <b style={{ color: UP_COLOR }}>{formatCurrency(stats?.high ?? null)}</b>
          </span>
          <span>
            🔻 最低: <b style={{ color: DOWN_COLOR }}>{formatCurrency(stats?.low ?? null)}</b>
          </span>
          <span>
            ⚖️ 平均价: <b style={{ color: '#e2e8f0' }}>{formatCurrency(stats?.avg ?? null)}</b>
          </span>
        </div>

        {/* ── 页脚免责声明 ── */}
        <footer
          style={{
            textAlign: 'center',
            fontSize: '12px',
            color: '#94a3b8',
            borderTop: '1px solid #334155',
            padding: '16px 24px 24px',
            marginTop: '24px',
            lineHeight: '1.8',
          }}
        >
          <p style={{ margin: '0 0 6px' }}>
            ⚠️ 本平台为<b>学生学术研究演示</b>，数据来源于公开财经网站（新浪/腾讯），
            <b>不构成任何投资建议</b>，亦不涉及荐股、预测及实盘交易。
          </p>
          <p style={{ margin: '0 0 6px' }}>
            📊 数据源：Baostock（历史K线与全A股票清单，版权归 Baostock 所有）· 腾讯公开接口（实时行情、选股与市场温度计快照）· 新浪公开接口（实时行情）·
            东方财富公开接口（板块资金/财务/公告/新闻）· 仅用于历史回测展示 · 请勿据此操作
          </p>
          <p style={{ margin: '0 0 6px', fontSize: '11px', color: '#64748b' }}>
            🌐 公网演示版：已启用自定义域名，可直接访问。行情来自公开接口，个别数据源可能临时不可用。
          </p>
          <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
            © 2026 AI深度量化 · 仅供学习参考
          </p>
        </footer>
      </main>
    </div>
  );
}
