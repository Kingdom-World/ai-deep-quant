import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as echarts from 'echarts';
import {
  clearCache,
  getHistory,
  getMinuteKline,
  getMinuteSeries,
  getQuote,
} from '../api/dataService';
import {
  aggregateData,
  aggregatePoints,
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
import { useQuantStore } from '../store/quantStore';
import {
  formatPercent,
  marketToCurrency,
  type Currency,
} from '../utils/formatters';

/** MA 均线配置（主图叠加） */
const MA_PERIODS = [5, 10, 20, 60, 120, 250];
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
  const [changePercent, setChangePercent] = useState<number | null>(null);
  const [rangeChange, setRangeChange] = useState<number | null>(null);
  const [updateTime, setUpdateTime] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
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

  /**
   * 周期选择（含数据量校验）：
   * 季线/年线需要足够长的历史跨度；上市较短的新股不满足时给出提示（参考主流行情软件做法）
   */
  const handlePeriodSelect = (period: Period) => {
    setPeriodNotice(null);
    if (period === 'quarter' || period === 'year') {
      const first = allPoints[0]?.date;
      const last = allPoints[allPoints.length - 1]?.date;
      let spanDays = 0;
      if (first && last) {
        spanDays = (Date.parse(last) - Date.parse(first)) / 86400000;
      }
      // 季线至少约 1 年（4 根以上），年线至少约 3 年（3 根以上）
      const minDays = period === 'quarter' ? 365 : 1000;
      if (spanDays < minDays) {
        setPeriodNotice(
          period === 'quarter'
            ? `📌 历史数据约 ${Math.max(1, Math.round(spanDays / 30))} 个月，不足 1 年，暂无足够季度K线数据`
            : `📌 历史数据约 ${Math.max(1, Math.round(spanDays / 365))} 年，不足 3 年，暂无足够年度K线数据`,
        );
        return;
      }
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
  const [minutePoints, setMinutePoints] = useState<KlinePoint[]>([]);

  /** 清空全部展示数据（切换股票时调用，避免新旧数据混合） */
  const resetDashboard = () => {
    setPriceHistory([]);
    setAllPoints([]);
    setMinutePoints([]);
    setMinuteTrace([]);
    setLiveTrace([]);
    setPeriodNotice(null);
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
      // 走统一数据服务（独立后端，带缓存）；请求 2000 根支撑 MA250/季线/年线（≈8年）
      const rows = await getHistory(sym, m, 'day', 2000);
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
      patterns: detectPatterns(agg),
    };
  }, [allPoints, selectedPeriod]);

  // 8. 主图数据更新：K 线蜡烛图 + MA 均线 + 成交量 + MACD + 形态标注
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || loading || allPoints.length === 0) return;
    if (!chartData) return;

    const { agg, labels, klineData, maSeries, macd, patterns } = chartData;
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
        text: `📈 ${displaySymbol} ${periodInfo?.title ?? '日线'} K线`,
        left: 'center',
        top: 0,
        textStyle: { fontSize: 14, fontWeight: 600, color: '#e2e8f0' },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: any) => {
          const list = Array.isArray(params) ? params : [params];
          const candle = list.find((p: any) => p.seriesType === 'candlestick');
          const bar = list.find((p: any) => p.seriesType === 'bar');
          const idx = candle?.dataIndex ?? bar?.dataIndex ?? 0;
          const p = agg[idx];
          if (!p) return '';
          let html = `${displaySymbol}<br/>日期: ${p.date}`;
          html += `<br/>开: ${CURRENCY}${p.open.toFixed(2)} | 高: ${CURRENCY}${p.high.toFixed(2)}`;
          html += `<br/>低: ${CURRENCY}${p.low.toFixed(2)} | 收: ${CURRENCY}${p.close.toFixed(2)}`;
          if (bar) html += `<br/>成交量: ${formatVolume(Number(bar.value))}`;
          const macdP = list.find((s: any) => s.seriesName === 'MACD柱');
          if (macdP && Number.isFinite(Number(macdP.value))) {
            html += `<br/>MACD柱: ${Number(macdP.value).toFixed(3)}`;
          }
          // 形态提示
          const mark = patterns.find((pt) => pt.index === idx);
          if (mark) html += `<br/>🔔 ${mark.name}: ${mark.note}`;
          return html;
        },
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
      },
      legend: {
        data: [...MA_PERIODS.map((p) => `MA${p}`), '成交量', 'DIF', 'DEA'],
        top: 22,
        left: 'center',
        textStyle: { color: '#94a3b8', fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
      grid: [
        { left: '3%', right: '4%', top: '11%', height: '44%', containLabel: true },
        { left: '3%', right: '4%', top: '60%', height: '11%', containLabel: true },
        { left: '3%', right: '4%', top: '75%', height: '12%', containLabel: true },
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
        { type: 'inside', xAxisIndex: [0, 1, 2], start: 0, end: 100 },
        {
          type: 'slider',
          xAxisIndex: [0, 1, 2],
          top: '95%',
          height: 16,
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
      ],
    });
  }, [allPoints, selectedPeriod, changePercent, loading, symbol, market]);

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
    let data: number[] = [];
    let labels: string[] = [];
    let windowStart = '';
    let windowEnd = '';
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

    const intervalId = setInterval(() => {
      fetchRealtimeQuote(symbol, market);
    }, POLL_INTERVAL);

    return () => clearInterval(intervalId);
  }, [symbol, market]);

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

  // ── 深色主题通用样式 ──
  const cardStyle: React.CSSProperties = {
    backgroundColor: '#111827',
    borderRadius: '12px',
    border: '1px solid #1e293b',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '12px',
    color: '#64748b',
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
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
        minHeight: '100vh',
        backgroundColor: '#0a0e17',
        color: '#e2e8f0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* ── 顶部提示条（学术研究定位） ── */}
      <div
        style={{
          textAlign: 'center',
          padding: '8px 16px',
          fontSize: '12px',
          color: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.08)',
          borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
        }}
      >
        📚 本平台为学术研究项目，数据仅供参考，不构成投资建议
      </div>

      {/* ── 顶部：导航栏 + 搜索框 ── */}
      <nav
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '16px',
          flexWrap: 'wrap',
          padding: '14px 28px',
          backgroundColor: 'rgba(10, 14, 23, 0.85)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #1e293b',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            onClick={() => navigate('/')}
            style={{ fontSize: '24px', cursor: 'pointer' }}
            title="返回主页"
          >
            🤖
          </span>
          <div>
            <h1 style={{ fontSize: '19px', fontWeight: '700', margin: 0, color: '#f1f5f9' }}>
              AI深度量化 · {displaySymbol}
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
            <p style={{ margin: '2px 0 0', color: '#64748b', fontSize: '12px' }}>
              {marketLabel(market)} · 每 {POLL_INTERVAL / 1000} 秒自动更新 · 数据来源: 独立数据服务 (新浪/腾讯)
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
            onClick={() => navigate('/')}
            style={{
              padding: '8px 14px',
              fontSize: '13px',
              color: '#94a3b8',
              backgroundColor: '#111827',
              border: '1px solid #334155',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            🏠 主页
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
      </nav>

      <main style={{ maxWidth: '980px', margin: '0 auto', padding: '24px 20px 32px' }}>
        {/* ── 数据卡片：基础行情 ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '40px',
            marginBottom: '16px',
            flexWrap: 'wrap',
            padding: '16px 20px',
            ...cardStyle,
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div style={labelStyle}>最新价</div>
            <div
              style={{
                fontSize: '28px',
                fontWeight: '700',
                letterSpacing: '0.5px',
                color: '#f8fafc',
              }}
            >
              {formatCurrency(latestPrice)}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={labelStyle}>当日涨跌幅</div>
            <div style={{ fontSize: '28px', fontWeight: '700', color: pctColor(changePercent) }}>
              {formatPercent(changePercent)}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={labelStyle}>近{HISTORY_COUNT}日涨幅</div>
            <div style={{ fontSize: '28px', fontWeight: '700', color: pctColor(rangeChange) }}>
              {formatPercent(rangeChange)}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={labelStyle}>最后更新</div>
            <div style={{ fontSize: '16px', fontWeight: '500', color: '#e2e8f0' }}>
              {updateTime || '--'}
            </div>
          </div>
        </div>

        {/* ── 数据卡片：价格变化摘要 ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '16px',
            marginBottom: '24px',
            flexWrap: 'wrap',
          }}
        >
          {[
            { label: '今日变化', value: todayChange },
            { label: '本周变化', value: weekChange },
            { label: '本月变化', value: monthChange },
            { label: '年初至今 (YTD)', value: ytdChange },
          ].map((item) => {
            const v = item.value;
            const bg =
              v === null
                ? 'rgba(100, 116, 139, 0.12)'
                : v >= 0
                  ? 'rgba(239, 68, 68, 0.12)'
                  : 'rgba(34, 197, 94, 0.12)';
            return (
              <div
                key={item.label}
                style={{
                  flex: '1 1 160px',
                  maxWidth: '200px',
                  textAlign: 'center',
                  padding: '12px 14px',
                  backgroundColor: bg,
                  borderRadius: '10px',
                  border: `1px solid ${v === null ? '#1e293b' : v >= 0 ? 'rgba(239, 68, 68, 0.3)' : 'rgba(34, 197, 94, 0.3)'}`,
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    color: '#94a3b8',
                    fontWeight: '500',
                    letterSpacing: '0.3px',
                  }}
                >
                  {item.label}
                </div>
                <div
                  style={{
                    fontSize: '20px',
                    fontWeight: '700',
                    color: pctColor(v),
                    marginTop: '2px',
                  }}
                >
                  {formatPercent(v)}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── 实时走势图（分时历史 + 实时跟踪，独立 ECharts 实例） ── */}
        <div
          style={{
            position: 'relative',
            marginBottom: '16px',
            borderRadius: '12px',
            border: '1px solid #1e293b',
            backgroundColor: '#111827',
            overflow: 'hidden',
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

        {/* ── 周期切换按钮 + 主图（K线） ── */}
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
          {PERIODS.map((p) => {
            const active = selectedPeriod === p.key;
            return (
              <button
                key={p.key}
                onClick={() => handlePeriodSelect(p.key)}
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  fontWeight: active ? '700' : '500',
                  color: active ? '#ffffff' : '#94a3b8',
                  backgroundColor: active ? '#2563eb' : '#1e293b',
                  border: active ? '1px solid #2563eb' : '1px solid #334155',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {p.label}
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

        {/* 主图容器（K线 + 成交量 + MACD，三 grid） */}
        <div
          ref={chartRef}
          style={{
            width: '100%',
            height: '560px',
            borderRadius: '12px',
            border: '1px solid #1e293b',
            backgroundColor: '#111827',
            padding: '4px',
          }}
        />

        {/* ── 分钟短期副图（1/5/15/30/60/120 分钟 K 线，多日真实数据） ── */}
        <div
          style={{
            marginTop: '28px',
            paddingTop: '20px',
            borderTop: '1px solid #1e293b',
            backgroundColor: 'rgba(17, 24, 39, 0.4)',
            borderRadius: '12px',
            padding: '16px 12px',
          }}
        >
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
            <span style={{ fontSize: '12px', color: '#64748b' }}>短期副图：</span>
            {MINUTE_PERIODS.map((p) => {
              const active = minutePeriod === p.key;
              return (
                <button
                  key={p.key}
                  onClick={() => setMinutePeriod(p.key)}
                  style={{
                    padding: '4px 12px',
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
            <span style={{ fontSize: '11px', color: '#475569' }}>
              {minutePoints.length > 0 ? `共 ${minutePoints.length} 根` : ''}
            </span>
          </div>
          <div
            ref={minuteChartRef}
            style={{
              width: '100%',
              height: '320px',
              borderRadius: '12px',
              border: '1px solid #1e293b',
              backgroundColor: '#111827',
              padding: '4px',
            }}
          />
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
            📊 数据源：Baostock（历史K线/技术指标，版权归 Baostock 所有）· Ashare（新浪/腾讯公开接口，实时行情）·
            仅用于历史回测展示 · 请勿据此操作
          </p>
          <p style={{ margin: '0 0 6px', fontSize: '11px', color: '#64748b' }}>
            🌐 当前为公网演示版，国内部分网络可能无法访问，请使用代理或后续等待自定义域名上线。
          </p>
          <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
            © 2026 AI深度量化 · 仅供学习参考
          </p>
        </footer>
      </main>
    </div>
  );
}
