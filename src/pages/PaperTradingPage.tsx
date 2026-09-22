// ─────────────────────────────────────────────────────────────
// 模拟交易页（/paper）
//   · 账户总览 + 净值曲线（10 秒轮询）
//   · 行情联动面板：点击任意代码 → 实时报价 + 分时 + 日K，按现价一键买卖
//   · 市价/限价下单（含搜索联想）、撤单、一键平仓、账户重置
//   · 自动策略（maCross / rsiReversal / gridTrading / combo）启停
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as echarts from 'echarts';
import {
  paperApi,
  getQuote,
  getHistory,
  getMinuteSeries,
  searchSymbol,
  type PaperAccount,
  type PaperOrder,
  type PaperStrategy,
  type PaperLogEntry,
  type PaperAlert,
  type PaperTriggeredAlert,
  type UnifiedQuote,
  type UnifiedKline,
} from '../api/dataService';
import { setVisibilityInterval } from '../lib/polling';
import { detectMarket, pctColor } from '../lib/stock';
import { getMarketStatus, useMinuteTick } from '../lib/marketHours';
import { theme } from '../lib/theme';
import { fmtClock, fmtShort } from '../lib/time';

const CARD = {
  backgroundColor: 'rgba(17,24,39,0.6)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  border: '1px solid rgba(96,165,250,0.16)',
  borderRadius: '14px',
  padding: '16px',
  boxShadow: '0 10px 36px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)',
} as const;

const INPUT = {
  padding: '9px 12px',
  fontSize: '13px',
  color: '#e2e8f0',
  backgroundColor: '#0d1322',
  border: '1px solid #334155',
  borderRadius: '8px',
  outline: 'none',
} as const;

const BTN = (bg: string) => ({
  padding: '9px 16px',
  fontSize: '13px',
  fontWeight: 600,
  color: '#fff',
  backgroundColor: bg,
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
} as const);

const STRATEGY_TYPES = [
  { key: 'maCross', name: 'MA 双均线', params: ['fast', 'slow'], defaults: { fast: 5, slow: 20 } },
  { key: 'rsiReversal', name: 'RSI 反转', params: ['period', 'oversold', 'overbought'], defaults: { period: 14, oversold: 30, overbought: 70 } },
  { key: 'gridTrading', name: '网格交易', params: ['gridPct', 'gridQty'], defaults: { gridPct: 2, gridQty: 100 } },
  { key: 'combo', name: '自定义组合(MA×RSI)', params: ['maFast', 'maSlow', 'rsiPeriod', 'rsiBuyBelow', 'rsiSellAbove', 'requireBoth'], defaults: { maFast: 5, maSlow: 20, rsiPeriod: 14, rsiBuyBelow: 45, rsiSellAbove: 70, requireBoth: 0 } },
] as const;

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  filled: { text: '已成交', color: '#4ade80' },
  resting: { text: '挂单中', color: '#facc15' },
  pending: { text: '处理中', color: '#facc15' },
  canceled: { text: '已撤销', color: '#94a3b8' },
  rejected: { text: '已拒绝', color: '#f87171' },
};

const fmtMoney = (v: number, digits = 2) =>
  v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default function PaperTradingPage() {
  const navigate = useNavigate();
  useMinuteTick(30000); // 状态徽章时钟兜底
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [strategies, setStrategies] = useState<PaperStrategy[]>([]);
  const [logs, setLogs] = useState<PaperLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // 下单表单
  const [symbol, setSymbol] = useState('sh600519');
  const [name, setName] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'market' | 'limit'>('market');
  const [qty, setQty] = useState(100);
  const [limitPrice, setLimitPrice] = useState(0);

  // 支持 /paper?symbol=XXX&side=buy|sell 直达预填（个股页"模拟交易直达"入口）
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const sym = searchParams.get('symbol');
    if (sym) setSymbol(sym);
    const s = searchParams.get('side');
    if (s === 'buy' || s === 'sell') setSide(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 搜索联想
  const [suggestions, setSuggestions] = useState<{ name: string; code: string; market: string }[]>([]);
  const suggestTimer = useRef<number | undefined>(undefined);

  // 行情联动面板
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [quote, setQuote] = useState<UnifiedQuote | null>(null);
  const [minutePoints, setMinutePoints] = useState<{ time: string; price: number }[]>([]);
  const [dailyK, setDailyK] = useState<UnifiedKline[]>([]);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const intradayRef = useRef<HTMLDivElement>(null);
  const dailyRef = useRef<HTMLDivElement>(null);
  const intradayChart = useRef<echarts.ECharts | null>(null);
  const dailyChart = useRef<echarts.ECharts | null>(null);

  // 策略表单
  const [stType, setStType] = useState<string>('maCross');
  const [stSymbol, setStSymbol] = useState('sh600519');
  const [stParams, setStParams] = useState<Record<string, number>>({ ...STRATEGY_TYPES[0].defaults });

  // 价格告警（撮合循环每 5 秒检测，触发后进入 triggered 队列）
  const [alertList, setAlertList] = useState<PaperAlert[]>([]);
  const [triggeredList, setTriggeredList] = useState<PaperTriggeredAlert[]>([]);
  const [alSymbol, setAlSymbol] = useState('');
  const [alCond, setAlCond] = useState<'above' | 'below'>('above');
  const [alPrice, setAlPrice] = useState('');
  const seenTriggered = useRef<Set<string>>(new Set());
  // 告警触发提醒独立横幅（不复用 msg——10 秒轮询的告警提示会把下单反馈顶掉）
  const [alertNotice, setAlertNotice] = useState<string | null>(null);

  const equityRef = useRef<HTMLDivElement>(null);
  const equityChart = useRef<echarts.ECharts | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [acc, sts, lgs, alr] = await Promise.all([
        paperApi.getAccount(),
        paperApi.listStrategies().catch(() => [] as PaperStrategy[]),
        paperApi.getLogs().catch(() => [] as PaperLogEntry[]),
        paperApi.listAlerts().catch(() => null),
      ]);
      setAccount(acc);
      setStrategies(sts);
      setLogs(lgs);
      if (alr?.ok) {
        setAlertList(alr.alerts);
        setTriggeredList(alr.triggered);
        // 新触发的告警弹提醒（首次加载不弹，避免历史触发刷屏）
        const fresh = alr.triggered.filter((t) => !seenTriggered.current.has(t.id));
        if (fresh.length > 0 && seenTriggered.current.size > 0) {
          setAlertNotice(
            `🔔 价格告警触发：${fresh
              .map((t) => `${t.name || t.symbol} ${t.condition === 'above' ? '≥' : '≤'} ${t.price}（现价 ${t.triggeredPrice}）`)
              .join('；')}`,
          );
        }
        alr.triggered.forEach((t) => seenTriggered.current.add(t.id));
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const stopPolling = setVisibilityInterval(refresh, 10000);
    return () => stopPolling();
  }, [refresh]);

  // ── 行情面板：选中代码后拉取报价 + 分时 + 日K（10 秒轮询） ──
  useEffect(() => {
    if (!selectedSymbol) {
      setQuote(null);
      setMinutePoints([]);
      setDailyK([]);
      return;
    }
    let alive = true;
    const market = detectMarket(selectedSymbol);
    const load = async () => {
      setQuoteLoading(true);
      try {
        const [q, minute, k] = await Promise.all([
          getQuote(selectedSymbol, market, true).catch(() => null),
          getMinuteSeries(selectedSymbol, market).catch(() => []),
          getHistory(selectedSymbol, market, 'day', 120).catch(() => []),
        ]);
        if (!alive) return;
        setQuote(q);
        setMinutePoints(minute.map((p) => ({ time: p.time, price: p.price })));
        setDailyK(k);
      } finally {
        if (alive) setQuoteLoading(false);
      }
    };
    load();
    const stopPolling = setVisibilityInterval(load, 10000);
    return () => {
      alive = false;
      stopPolling();
    };
  }, [selectedSymbol]);

  // 分时图
  useEffect(() => {
    if (!intradayRef.current || minutePoints.length === 0) return;
    if (!intradayChart.current) intradayChart.current = echarts.init(intradayRef.current);
    const prices = minutePoints.map((p) => p.price);
    intradayChart.current.setOption({
      backgroundColor: 'transparent',
      grid: { left: 56, right: 12, top: 14, bottom: 22 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: minutePoints.map((p) => p.time),
        axisLine: { lineStyle: { color: '#334155' } },
        axisLabel: { color: '#64748b', fontSize: 10, interval: Math.floor(minutePoints.length / 6) },
      },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { lineStyle: { color: '#1e293b' } } },
      series: [{
        type: 'line', data: prices, symbol: 'none',
        lineStyle: { color: '#60a5fa', width: 1.5 },
        areaStyle: { color: 'rgba(96,165,250,0.08)' },
      }],
    });
    intradayChart.current.resize();
  }, [minutePoints]);

  // 日K 图（红涨绿跌）
  useEffect(() => {
    if (!dailyRef.current || dailyK.length === 0) return;
    if (!dailyChart.current) dailyChart.current = echarts.init(dailyRef.current);
    dailyChart.current.setOption({
      backgroundColor: 'transparent',
      grid: { left: 56, right: 12, top: 14, bottom: 22 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: dailyK.map((k) => k.date.slice(5)),
        axisLine: { lineStyle: { color: '#334155' } },
        axisLabel: { color: '#64748b', fontSize: 10 },
      },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { lineStyle: { color: '#1e293b' } } },
      series: [{
        type: 'candlestick',
        data: dailyK.map((k) => [k.open, k.close, k.low, k.high]),
        itemStyle: { color: '#ef4444', color0: '#22c55e', borderColor: '#ef4444', borderColor0: '#22c55e' },
      }],
    });
    dailyChart.current.resize();
  }, [dailyK]);

  // 三图生命周期（resize + 卸载释放）
  useEffect(() => {
    const onResize = () => {
      equityChart.current?.resize();
      intradayChart.current?.resize();
      dailyChart.current?.resize();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      equityChart.current?.dispose();
      intradayChart.current?.dispose();
      dailyChart.current?.dispose();
      equityChart.current = null;
      intradayChart.current = null;
      dailyChart.current = null;
    };
  }, []);

  // 净值曲线
  useEffect(() => {
    if (!equityRef.current || !account) return;
    if (!equityChart.current) equityChart.current = echarts.init(equityRef.current);
    const points = account.equity.slice(-300);
    equityChart.current.setOption({
      backgroundColor: 'transparent',
      grid: { left: 60, right: 16, top: 20, bottom: 28 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: points.map((p) => fmtClock(p.t)),
        axisLine: { lineStyle: { color: '#334155' } },
        axisLabel: { color: '#64748b', fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { color: '#64748b', fontSize: 10, formatter: (v: number) => v.toLocaleString() },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      series: [
        {
          type: 'line',
          data: points.map((p) => p.total),
          symbol: 'none',
          lineStyle: { color: '#60a5fa', width: 2 },
          areaStyle: { color: 'rgba(96,165,250,0.08)' },
        },
      ],
    });
  }, [account]);

  const act = async (fn: () => Promise<unknown>, okText: string) => {
    try {
      await fn();
      setMsg({ text: okText, ok: true });
      await refresh();
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    }
  };

  const submitOrder = () =>
    act(
      () =>
        paperApi.placeOrder({
          symbol: symbol.trim(),
          name: name.trim() || undefined,
          side,
          type,
          qty,
          ...(type === 'limit' ? { limitPrice } : {}),
        }),
      '委托已提交',
    );

  /** 行情面板内一键按现价买卖 */
  const quickOrder = (s: 'buy' | 'sell') =>
    act(
      () =>
        paperApi.placeOrder({
          symbol: selectedSymbol,
          name: quote?.name,
          side: s,
          type: 'market',
          qty: Math.max(qty, 1),
        }),
      `${s === 'buy' ? '买入' : '卖出'}委托已提交`,
    );

  // 搜索联想（300ms 防抖）
  const onSymbolInput = (v: string) => {
    setSymbol(v);
    setName('');
    window.clearTimeout(suggestTimer.current);
    const kw = v.trim();
    if (kw.length < 2) {
      setSuggestions([]);
      return;
    }
    suggestTimer.current = window.setTimeout(async () => {
      try {
        const list = await searchSymbol(kw);
        setSuggestions(list.slice(0, 6));
      } catch {
        setSuggestions([]);
      }
    }, 300);
  };

  const startStrategy = () =>
    act(
      () =>
        paperApi.startStrategy({
          type: stType,
          symbol: stSymbol.trim(),
          params: stParams,
        }),
      '策略已启动',
    );

  const addAlert = () =>
    act(
      () =>
        paperApi.addAlert({
          symbol: alSymbol.trim(),
          condition: alCond,
          price: Number(alPrice),
        }),
      '告警已创建，盘中每 5 秒检测',
    ).then(() => setAlPrice(''));

  const removeAlert = (id: string) => act(() => paperApi.removeAlert(id), '告警已删除');
  const clearTriggered = () => act(() => paperApi.clearTriggeredAlerts(), '触发记录已清除');

  const stDef = STRATEGY_TYPES.find((s) => s.key === stType) ?? STRATEGY_TYPES[0];
  // 交易时段状态（随选中标的的市场变化；每次轮询重渲染时自动刷新）
  const mktStatus = getMarketStatus(detectMarket(selectedSymbol || 'sh600519'));

  // 表单代码 → 行情面板/五档盘口联动（600ms 防抖）
  useEffect(() => {
    const t = window.setTimeout(() => {
      const s = symbol.trim();
      if (s) setSelectedSymbol(s);
    }, 600);
    return () => window.clearTimeout(t);
  }, [symbol]);

  // 快捷仓位计算：参考价 = 行情面板最新价；A 股按 100 股整手；预算限制在"单笔 ≤ 总资产 20%"风控内
  const refPrice = quote?.price ?? null;
  const isCNLot = detectMarket(symbol.trim() || 'sh600519') === 'CN';
  const lotFloor = (q: number) => Math.max(0, isCNLot ? Math.floor(q / 100) * 100 : Math.floor(q));
  const maxByRisk = account && refPrice ? lotFloor(((account.totalAssets * 0.2) * 0.98) / refPrice) : 0;

  /** 一键撤销全部挂单 */
  const cancelAll = async () => {
    const resting = (account?.orders ?? []).filter((o) => o.status === 'resting');
    if (!resting.length) return;
    for (const o of resting) {
      try {
        await paperApi.cancelOrder(o.id);
      } catch {
        /* 单笔失败继续撤下一笔 */
      }
    }
    setMsg({ text: `已撤销 ${resting.length} 笔挂单`, ok: true });
    await refresh();
  };

  // 五档盘口
  const maxLvlQty = Math.max(
    ...(quote?.bids ?? []).map((b) => b.qty),
    ...(quote?.asks ?? []).map((a) => a.qty),
    1,
  );
  const LvlRow = ({ label, lvl, color }: { label: string; lvl: { price: number; qty: number }; color: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '1.5px 0' }}>
      <span style={{ width: 26, color: '#64748b' }}>{label}</span>
      <span
        style={{ width: 66, textAlign: 'right', color, fontFamily: 'Consolas, monospace', cursor: 'pointer', fontWeight: 600 }}
        onClick={() => { setLimitPrice(lvl.price); setType('limit'); }}
        title="点击填入限价"
      >
        {lvl.price.toFixed(2)}
      </span>
      <div style={{ flex: 1, height: 8, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${(lvl.qty / maxLvlQty) * 100}%`, height: '100%', backgroundColor: color, opacity: 0.35 }} />
      </div>
      <span style={{ width: 56, textAlign: 'right', color: '#94a3b8' }}>{lvl.qty.toLocaleString()}</span>
    </div>
  );

  /** 可点击的代码标签：页内选中行情 + 保留详情页入口 */
  const CodeTag = ({ code, label }: { code: string; label?: string }) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{ color: selectedSymbol === code ? '#60a5fa' : '#93c5fd', cursor: 'pointer', fontWeight: 600 }}
        onClick={() => setSelectedSymbol(code)}
        title="点击查看实时行情"
      >
        {code}
      </span>
      <span
        style={{ color: '#475569', cursor: 'pointer', fontSize: 11 }}
        onClick={() => navigate(`/stock/${code}`)}
        title="打开量化看板详情页"
      >
        ↗
      </span>
      {label ? <span style={{ color: '#64748b' }}>{label}</span> : null}
    </span>
  );

  const stats = account
    ? [
        { label: '总资产', value: `¥${fmtMoney(account.totalAssets)}`, color: '#e2e8f0' },
        { label: '可用现金', value: `¥${fmtMoney(account.cash)}`, color: '#e2e8f0' },
        { label: '持仓市值', value: `¥${fmtMoney(account.marketValue)}`, color: '#e2e8f0' },
        {
          label: '累计盈亏',
          value: `${account.totalPnl >= 0 ? '+' : ''}${fmtMoney(account.totalPnl)}（${account.totalPnlPct >= 0 ? '+' : ''}${account.totalPnlPct}%）`,
          color: pctColor(account.totalPnl),
        },
        {
          label: '当日盈亏',
          value: `${account.todayPnl >= 0 ? '+' : ''}${fmtMoney(account.todayPnl)}`,
          color: pctColor(account.todayPnl),
        },
      ]
    : [];

  return (
    <div style={{ ...theme.page }}>
      {/* 顶部导航（全站统一） */}

      <div style={{ padding: '20px 24px' }}>
      {/* 页面标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '18px 0 0' }}>
        <h1 style={{ fontSize: '20px', margin: 0 }}>💰 模拟交易</h1>
        <span style={{ fontSize: '12px', color: '#64748b' }}>
          100 万虚拟资金 · 真实行情撮合 · 佣金万2.5（最低5元）+ 卖出印花税万5 · 数据 10 秒刷新
        </span>
        <span
          title={mktStatus.detail}
          style={{
            marginLeft: 'auto',
            fontSize: '13px',
            fontWeight: 600,
            color: mktStatus.open ? '#ef4444' : '#94a3b8',
            backgroundColor: 'rgba(255,255,255,0.04)',
            border: '1px solid #1e293b',
            padding: '4px 12px',
            borderRadius: '999px',
          }}
        >
          {mktStatus.open ? '🔴' : '⚪'} A股{mktStatus.label}
        </span>
      </div>

      {error && (
        <div style={{ ...CARD, borderColor: '#7f1d1d', marginBottom: '16px', color: '#f87171' }}>
          ⚠️ {error}
        </div>
      )}
      {msg && (
        <div
          style={{
            ...CARD,
            borderColor: msg.ok ? '#166534' : '#7f1d1d',
            marginBottom: '16px',
            color: msg.ok ? '#4ade80' : '#f87171',
          }}
        >
          {msg.ok ? '✓ ' : '✗ '}
          {msg.text}
        </div>
      )}
      {alertNotice && (
        <div
          style={{
            ...CARD,
            borderColor: '#a16207',
            marginBottom: '16px',
            color: '#facc15',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span>{alertNotice}</span>
          <button
            onClick={() => setAlertNotice(null)}
            title="知道了"
            style={{ background: 'none', border: 'none', color: '#a16207', cursor: 'pointer', fontSize: 14, padding: 0, flexShrink: 0 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* 账户总览 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        {stats.map((s) => (
          <div key={s.label} style={CARD}>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>{s.label}</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '16px', alignItems: 'start' }}>
        {/* 左列：下单 + 策略 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ ...CARD, position: 'relative' }}>
            <div style={{ fontWeight: 700, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              📝 下单
              <span
                title="虚拟资金撮合，不涉及真实货币"
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  color: '#fbbf24',
                  backgroundColor: 'rgba(251,191,36,0.1)',
                  border: '1px solid rgba(251,191,36,0.35)',
                  padding: '2px 8px',
                  borderRadius: '999px',
                }}
              >
                模拟盘 · 虚拟资金
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ position: 'relative' }}>
                <input style={{ ...INPUT, width: '100%', boxSizing: 'border-box' }} value={symbol} onChange={(e) => onSymbolInput(e.target.value)} placeholder="代码（如 sh600519 / AAPL）" />
                {suggestions.length > 0 && (
                  <div style={{ position: 'absolute', top: '42px', left: 0, right: 0, zIndex: 20, backgroundColor: '#111827', border: '1px solid #334155', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                    {suggestions.map((s) => (
                      <div
                        key={`${s.market}-${s.code}`}
                        style={{ padding: '8px 12px', fontSize: '13px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}
                        onClick={() => {
                          setSymbol(s.code);
                          setName(s.name);
                          setSuggestions([]);
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#1e293b'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
                      >
                        <span style={{ color: '#e2e8f0' }}>{s.name}</span>
                        <span style={{ color: '#64748b' }}>{s.code}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <input style={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="名称（可选）" />
              <div style={{ display: 'flex', gap: '8px' }}>
                {(['buy', 'sell'] as const).map((s) => (
                  <button
                    key={s}
                    style={{ ...BTN(side === s ? (s === 'buy' ? '#16a34a' : '#dc2626') : '#1e293b'), flex: 1 }}
                    onClick={() => setSide(s)}
                  >
                    {s === 'buy' ? '买入' : '卖出'}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {(['market', 'limit'] as const).map((t) => (
                  <button
                    key={t}
                    style={{ ...BTN(type === t ? '#2563eb' : '#1e293b'), flex: 1, fontWeight: 500 }}
                    onClick={() => setType(t)}
                  >
                    {t === 'market' ? '市价单' : '限价单'}
                  </button>
                ))}
              </div>
              <input style={INPUT} type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 0)))} placeholder="数量（股）" />
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  { label: '满额', q: maxByRisk },
                  { label: '半仓', q: Math.floor(maxByRisk / 2) },
                  { label: '1/4仓', q: Math.floor(maxByRisk / 4) },
                  { label: '100股', q: isCNLot ? 100 : 100 },
                ].map((b) => (
                  <button
                    key={b.label}
                    style={{ flex: 1, padding: '6px 0', fontSize: '11px', color: '#93c5fd', backgroundColor: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 6, cursor: 'pointer' }}
                    onClick={() => { if (b.q > 0) setQty(b.q); }}
                    disabled={!refPrice}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
              {refPrice && (
                <div style={{ fontSize: '11px', color: '#475569' }}>
                  参考价 {refPrice.toFixed(2)} · 最大可买 <b style={{ color: '#93c5fd' }}>{maxByRisk.toLocaleString()}</b> 股（单笔 ≤ 总资产20%{isCNLot ? ' · 100股整手' : ''}）
                </div>
              )}
              {type === 'limit' && (
                <input style={INPUT} type="number" min={0} value={limitPrice || ''} onChange={(e) => setLimitPrice(Number(e.target.value) || 0)} placeholder="限价（元）" />
              )}
              {!mktStatus.open && type === 'market' && refPrice && (
                <button
                  style={{
                    padding: '9px 16px',
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#fbbf24',
                    backgroundColor: 'rgba(251,191,36,0.1)',
                    border: '1px solid rgba(251,191,36,0.4)',
                    borderRadius: 8,
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setType('limit');
                    setLimitPrice(+refPrice.toFixed(2));
                  }}
                  title="以当前行情价格创建限价单（隔夜委托），进入连续竞价时段后自动撮合"
                >
                  🌙 一键转隔夜限价单（按现价 {refPrice.toFixed(2)} 挂单）
                </button>
              )}
              <button style={BTN(side === 'buy' ? '#16a34a' : '#dc2626')} onClick={submitOrder}>
                提交{side === 'buy' ? '买入' : '卖出'}委托{!mktStatus.open && type === 'limit' ? ' · 隔夜挂单' : ''}
              </button>
              {!mktStatus.open && type === 'limit' && (
                <div style={{ fontSize: 11, color: '#93c5fd', backgroundColor: 'rgba(96,165,250,0.07)', border: '1px solid rgba(96,165,250,0.25)', borderRadius: 8, padding: '6px 10px' }}>
                  🌙 隔夜委托：本单将保持挂单，进入下一连续竞价时段后按限价自动撮合；期间可随时撤单。
                </div>
              )}
              {!mktStatus.open && type === 'market' && (
                <div style={{ fontSize: 11, color: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 8, padding: '6px 10px' }}>
                  ⚪ {mktStatus.label}：市价单无法成交；可点上方按钮一键转隔夜限价单，或手动切换「限价单」并填写价格。
                </div>
              )}
              <div style={{ fontSize: '11px', color: '#475569' }}>
                市价单仅在连续竞价时段成交；限价单随时可挂（隔夜委托）、时段内每 5 秒撮合。A股 T+1：当日买入次日方可卖出；限价超出涨跌停板的委托无效。
              </div>

              {/* 五档盘口（仅 A 股提供） */}
              {quote?.bids?.length && quote?.asks?.length ? (
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b', marginBottom: 4 }}>
                    <span>五档盘口{quote.quoteTime ? ` · ${quote.quoteTime}` : ''}</span>
                    <span>点价格填限价</span>
                  </div>
                  {[...quote.asks].slice(0, 5).reverse().map((a, i) => (
                    <LvlRow key={`a${i}`} label={`卖${5 - i}`} lvl={a} color="#22c55e" />
                  ))}
                  <div
                    style={{
                      display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b',
                      padding: '3px 0', borderTop: '1px dashed #1e293b', borderBottom: '1px dashed #1e293b', margin: '3px 0',
                    }}
                  >
                    <span>最新</span>
                    <span
                      style={{ color: '#f1f5f9', fontFamily: 'Consolas, monospace', cursor: 'pointer', fontWeight: 700 }}
                      onClick={() => { setLimitPrice(quote.price); setType('limit'); }}
                      title="点击填入限价"
                    >
                      {quote.price.toFixed(2)}
                    </span>
                    <span>{mktStatus.open ? '🔴' : '⚪'}</span>
                  </div>
                  {quote.bids.slice(0, 5).map((b, i) => (
                    <LvlRow key={`b${i}`} label={`买${i + 1}`} lvl={b} color="#ef4444" />
                  ))}
                </div>
              ) : (
                quote && selectedSymbol && (
                  <div style={{ marginTop: 10, fontSize: '11px', color: '#475569' }}>
                    当前市场（{detectMarket(selectedSymbol)}）无五档盘口数据
                  </div>
                )
              )}
            </div>
          </div>

          <div style={CARD}>
            <div style={{ fontWeight: 700, marginBottom: '12px' }}>🤖 自动策略（每小时评估，仅交易时段）</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <select style={{ ...INPUT, flex: 1 }} value={stType} onChange={(e) => {
                  const t = STRATEGY_TYPES.find((s) => s.key === e.target.value) ?? STRATEGY_TYPES[0];
                  setStType(t.key);
                  setStParams({ ...t.defaults });
                }}>
                  {STRATEGY_TYPES.map((s) => (
                    <option key={s.key} value={s.key}>{s.name}</option>
                  ))}
                </select>
                <input style={{ ...INPUT, width: '130px' }} value={stSymbol} onChange={(e) => setStSymbol(e.target.value)} placeholder="标的代码" />
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {stDef.params.map((p) => (
                  <label key={p} style={{ fontSize: '11px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {p}
                    <input
                      style={{ ...INPUT, width: '70px', padding: '6px 8px' }}
                      type="number"
                      value={stParams[p] ?? ''}
                      onChange={(e) => setStParams({ ...stParams, [p]: Number(e.target.value) || 0 })}
                    />
                  </label>
                ))}
              </div>
              <button style={BTN('#2563eb')} onClick={startStrategy}>启动策略</button>
              {strategies.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {strategies.map((s) => (
                    <div key={s.id} style={{ backgroundColor: '#0d1322', border: '1px solid #1e293b', borderRadius: '8px', padding: '10px', fontSize: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600 }}>
                          {s.status === 'running' ? '🟢' : '⚪'} {s.type} · {s.symbol}
                        </span>
                        {s.status === 'running' && (
                          <button style={{ ...BTN('#334155'), padding: '4px 10px', fontSize: '11px' }} onClick={() => act(() => paperApi.stopStrategy(s.id), '策略已停止')}>
                            停止
                          </button>
                        )}
                      </div>
                      <div style={{ color: '#94a3b8', marginTop: '4px' }}>{s.lastSignal}{s.error ? `（异常：${s.error}）` : ''}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── 价格告警（tickflow 监控模块同款交互） ── */}
          <div style={CARD}>
            <div style={{ fontWeight: 700, marginBottom: '12px' }}>🔔 价格告警（撮合循环每 5 秒检测）</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input style={{ ...INPUT, flex: 1, minWidth: 0 }} value={alSymbol} onChange={(e) => setAlSymbol(e.target.value)} placeholder="代码（如 sh600519）" />
                <select style={{ ...INPUT, width: 74, padding: '9px 6px' }} value={alCond} onChange={(e) => setAlCond(e.target.value as 'above' | 'below')}>
                  <option value="above">高于</option>
                  <option value="below">低于</option>
                </select>
                <input style={{ ...INPUT, width: 84 }} type="number" min={0} value={alPrice} onChange={(e) => setAlPrice(e.target.value)} placeholder="价格" />
              </div>
              <button style={BTN('#2563eb')} onClick={addAlert} disabled={!alSymbol.trim() || !(Number(alPrice) > 0)}>
                添加告警
              </button>
              {alertList.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  {alertList.map((a) => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, backgroundColor: '#0d1322', border: '1px solid #1e293b', borderRadius: 8, padding: '6px 10px' }}>
                      <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{a.name || a.symbol}</span>
                      <span style={{ color: '#64748b' }}>{a.symbol}</span>
                      <span style={{ color: a.condition === 'above' ? '#f87171' : '#4ade80', fontFamily: 'Consolas, monospace' }}>
                        {a.condition === 'above' ? '≥' : '≤'} {a.price}
                      </span>
                      {a.triggeredAt ? <span style={{ color: '#facc15' }}>✓ 已触发</span> : <span style={{ color: '#475569' }}>监控中</span>}
                      <button style={{ ...BTN('#334155'), padding: '2px 8px', fontSize: 11, marginLeft: 'auto' }} onClick={() => removeAlert(a.id)}>
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {triggeredList.length > 0 && (
                <div style={{ borderTop: '1px dashed #1e293b', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: '#facc15' }}>
                    <span>⚡ 触发记录</span>
                    <button style={{ ...BTN('#92400e'), padding: '2px 8px', fontSize: 11 }} onClick={clearTriggered}>
                      清除
                    </button>
                  </div>
                  {triggeredList.map((t) => (
                    <div key={t.id} style={{ fontSize: 12, color: '#fca5a5', backgroundColor: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '6px 10px' }}>
                      {t.name || t.symbol} {t.condition === 'above' ? '≥' : '≤'} {t.price} → 触发价 <b>{t.triggeredPrice}</b>
                      <span style={{ color: '#64748b', marginLeft: 6 }}>{fmtShort(t.at)}</span>
                    </div>
                  ))}
                </div>
              )}
              {alertList.length === 0 && triggeredList.length === 0 && (
                <div style={{ fontSize: 11, color: '#475569' }}>
                  示例：设置「贵州茅台 高于 1350」，盘中价格到达即在页顶提醒（持久化，重启不丢）。
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右列：行情面板 + 净值 + 持仓 + 委托 + 日志 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* 行情联动面板 */}
          <div style={CARD}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                📡 行情面板
                <span
                  title="按现价买卖亦为虚拟资金模拟成交"
                  style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    color: '#fbbf24',
                    backgroundColor: 'rgba(251,191,36,0.1)',
                    border: '1px solid rgba(251,191,36,0.35)',
                    padding: '2px 8px',
                    borderRadius: '999px',
                  }}
                >
                  模拟成交
                </span>
              </span>
              {selectedSymbol && quoteLoading && <span style={{ fontSize: '11px', color: '#64748b' }}>刷新中…</span>}
            </div>
            {!selectedSymbol ? (
              <div style={{ color: '#475569', fontSize: '13px', padding: '20px 0', textAlign: 'center' }}>
                点击持仓、委托记录中的任意股票代码，在此查看实时行情（报价 / 分时 / 日K）
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '16px', fontWeight: 700 }}>
                    {quote?.name || selectedSymbol}
                    <span style={{ color: '#64748b', fontSize: '12px', marginLeft: 6 }}>{selectedSymbol}</span>
                  </span>
                  <span style={{ fontSize: '26px', fontWeight: 700, color: pctColor(quote ? quote.changePercent : null) }}>
                    {quote ? quote.price.toFixed(2) : '--'}
                  </span>
                  {quote && (
                    <span style={{ fontSize: '14px', color: pctColor(quote.changePercent) }}>
                      {(quote.changePercent ?? 0) >= 0 ? '+' : ''}{(quote.changePercent ?? 0).toFixed(2)}%
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button
                    style={{ ...BTN('#16a34a'), padding: '7px 14px', opacity: mktStatus.open ? 1 : 0.45, cursor: mktStatus.open ? 'pointer' : 'not-allowed' }}
                    onClick={() => quickOrder('buy')}
                    disabled={!mktStatus.open}
                    title={mktStatus.open ? '市价买入（虚拟资金）' : `${mktStatus.label}：非连续竞价时段，市价单无法成交`}
                  >
                    按现价买
                  </button>
                  <button
                    style={{ ...BTN('#dc2626'), padding: '7px 14px', opacity: mktStatus.open ? 1 : 0.45, cursor: mktStatus.open ? 'pointer' : 'not-allowed' }}
                    onClick={() => quickOrder('sell')}
                    disabled={!mktStatus.open}
                    title={mktStatus.open ? '市价卖出（虚拟资金）' : `${mktStatus.label}：非连续竞价时段，市价单无法成交`}
                  >
                    按现价卖
                  </button>
                  <button style={{ ...BTN('#334155'), padding: '7px 12px', fontWeight: 500 }} onClick={() => navigate(`/stock/${selectedSymbol}`)}>
                    详情 ↗
                  </button>
                </div>
                {quote && (
                  <div style={{ display: 'flex', gap: '18px', fontSize: '12px', color: '#94a3b8', margin: '10px 0 4px', flexWrap: 'wrap' }}>
                    <span>今开 {quote.open ?? '--'}</span>
                    <span>最高 <span style={{ color: '#ef4444' }}>{quote.high ?? '--'}</span></span>
                    <span>最低 <span style={{ color: '#22c55e' }}>{quote.low ?? '--'}</span></span>
                    <span>昨收 {quote.prevClose ?? '--'}</span>
                    <span>成交量 {quote.volume != null ? quote.volume.toLocaleString() : '--'}</span>
                  </div>
                )}
                {!mktStatus.open && (
                  <div
                    style={{
                      fontSize: '12px',
                      color: '#f59e0b',
                      backgroundColor: 'rgba(245,158,11,0.08)',
                      border: '1px solid rgba(245,158,11,0.25)',
                      borderRadius: '8px',
                      padding: '6px 10px',
                      margin: '8px 0',
                    }}
                  >
                    ⚪ {mktStatus.label} —— {mktStatus.detail}
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginTop: '10px' }}>
                  <div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginBottom: 4 }}>当日分时</div>
                    <div ref={intradayRef} style={{ height: '190px' }} />
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginBottom: 4 }}>日 K（近 120 日，红涨绿跌）</div>
                    <div ref={dailyRef} style={{ height: '190px' }} />
                  </div>
                </div>
              </>
            )}
          </div>

          <div style={CARD}>
            <div style={{ fontWeight: 700, marginBottom: '8px' }}>📈 净值曲线</div>
            <div ref={equityRef} style={{ height: '200px' }} />
          </div>

          <div style={CARD}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span style={{ fontWeight: 700 }}>💼 持仓（{account?.positions.length ?? 0}）</span>
              <button
                style={{ ...BTN('#7f1d1d'), padding: '6px 12px', fontSize: '11px' }}
                onClick={() => {
                  if (window.confirm('确定清空并重置模拟账户（回到 100 万初始资金）？')) {
                    act(() => paperApi.reset(), '账户已重置');
                  }
                }}
              >
                重置账户
              </button>
            </div>
            {account && account.positions.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ color: '#64748b', fontSize: '12px' }}>
                    {['代码', '名称', '数量', '可卖', '成本', '现价', '市值', '浮动盈亏', ''].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {account.positions.map((p) => (
                    <tr
                      key={p.symbol}
                      style={{ borderTop: '1px solid #1e293b', backgroundColor: selectedSymbol === p.symbol ? 'rgba(96,165,250,0.06)' : 'transparent' }}
                    >
                      <td style={{ padding: '8px' }}><CodeTag code={p.symbol} /></td>
                      <td style={{ padding: '8px' }}>{p.name}</td>
                      <td style={{ padding: '8px' }}>{p.qty}</td>
                      <td style={{ padding: '8px', color: (p.sellableQty ?? p.qty) < p.qty ? '#f59e0b' : '#94a3b8' }} title={(p.t1Locked ?? 0) > 0 ? `A股 T+1：今日买入的 ${p.t1Locked} 股当日不可卖` : undefined}>
                        {p.sellableQty ?? p.qty}{(p.t1Locked ?? 0) > 0 ? ' 🔒' : ''}
                      </td>
                      <td style={{ padding: '8px' }}>{p.avgCost}</td>
                      <td style={{ padding: '8px' }}>{p.lastPrice}</td>
                      <td style={{ padding: '8px' }}>{fmtMoney(p.marketValue)}</td>
                      <td style={{ padding: '8px', color: pctColor(p.unrealizedPnl) }}>
                        {p.unrealizedPnl >= 0 ? '+' : ''}{fmtMoney(p.unrealizedPnl)}（{p.unrealizedPct >= 0 ? '+' : ''}{p.unrealizedPct}%）
                      </td>
                      <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                        <button
                          style={{ ...BTN('#9f1239'), padding: '4px 8px', fontSize: '11px', marginRight: 4 }}
                          onClick={() => act(() => paperApi.placeOrder({ symbol: p.symbol, name: p.name, side: 'sell', type: 'market', qty: Math.max(1, Math.floor(p.qty / 2)) }), '减半卖出已提交')}
                        >
                          减半
                        </button>
                        <button
                          style={{ ...BTN('#dc2626'), padding: '4px 10px', fontSize: '11px' }}
                          onClick={() => act(() => paperApi.placeOrder({ symbol: p.symbol, name: p.name, side: 'sell', type: 'market', qty: p.qty }), '市价卖出已提交')}
                        >
                          市价清仓
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ color: '#475569', fontSize: '13px', padding: '12px 0' }}>暂无持仓——用左侧表单买入第一笔吧。</div>
            )}
          </div>

          <div style={CARD}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span style={{ fontWeight: 700 }}>📜 委托与成交记录</span>
              {(account?.orders ?? []).some((o) => o.status === 'resting') && (
                <button
                  style={{ ...BTN('#92400e'), padding: '5px 12px', fontSize: '11px' }}
                  onClick={cancelAll}
                >
                  一键撤单
                </button>
              )}
            </div>
            {account && account.orders.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '300px', overflowY: 'auto' }}>
                {account.orders.slice(0, 30).map((o: PaperOrder) => {
                  const st = STATUS_LABEL[o.status] ?? { text: o.status, color: '#94a3b8' };
                  return (
                    <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', backgroundColor: '#0d1322', borderRadius: '8px', padding: '8px 10px' }}>
                      <span style={{ color: o.side === 'buy' ? '#4ade80' : '#f87171', fontWeight: 700, width: 32 }}>{o.side === 'buy' ? '买' : '卖'}</span>
                      <span style={{ width: 110 }}><CodeTag code={o.symbol} /></span>
                      <span style={{ width: 70 }}>{o.qty} 股</span>
                      <span style={{ width: 90 }}>{o.type === 'limit' ? `限价 ${o.limitPrice}` : '市价'}</span>
                      <span style={{ width: 80 }}>{o.avgFillPrice != null ? `@ ${o.avgFillPrice}` : ''}</span>
                      <span style={{ color: st.color, width: 60 }}>{st.text}</span>
                      {o.reason && <span style={{ color: '#f87171', flex: 1 }}>{o.reason}</span>}
                      {o.status === 'resting' && (
                        <button style={{ ...BTN('#334155'), padding: '3px 10px', fontSize: '11px', marginLeft: 'auto' }} onClick={() => act(() => paperApi.cancelOrder(o.id), '已撤单')}>
                          撤单
                        </button>
                      )}
                      <span style={{ color: '#475569', marginLeft: 'auto' }}>{fmtShort(o.createdAt)}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ color: '#475569', fontSize: '13px' }}>暂无委托记录。</div>
            )}
          </div>

          <div style={CARD}>
            <div style={{ fontWeight: 700, marginBottom: '10px' }}>🧾 交易日志</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto', fontSize: '12px', color: '#94a3b8' }}>
              {logs.map((l, i) => (
                <div key={i}>{fmtShort(l.t)} — {l.msg}</div>
              ))}
              {logs.length === 0 && <div style={{ color: '#475569' }}>暂无日志。</div>}
            </div>
          </div>
        </div>
      </div>

      {/* 合规免责声明（固定展示于页面底部） */}
      <div
        style={{
          marginTop: '24px',
          padding: '12px 16px',
          fontSize: '12px',
          lineHeight: 1.8,
          color: '#64748b',
          backgroundColor: 'rgba(17,24,39,0.4)',
          border: '1px solid #1e293b',
          borderRadius: '10px',
        }}
      >
        ⚠️ 免责声明：本页面为模拟交易功能，账户内全部资金均为<b style={{ color: '#94a3b8' }}>虚拟资金</b>，不涉及任何真实货币或证券；撮合基于公开行情数据的延迟快照，成交结果不代表真实市场可成交价格。页面展示的所有数据、AI 分析与策略信号仅用于技术学习与研究，<b style={{ color: '#94a3b8' }}>不构成任何投资建议或收益承诺</b>，据此操作、风险自负。市场有风险，投资需谨慎。
      </div>
      </div>
    </div>
  );
  }
