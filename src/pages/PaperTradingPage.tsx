// ─────────────────────────────────────────────────────────────
// 模拟交易页（/paper）
//   · 账户总览 + 净值曲线（10 秒轮询）
//   · 行情联动面板：点击任意代码 → 实时报价 + 分时 + 日K，按现价一键买卖
//   · 市价/限价下单（含搜索联想）、撤单、一键平仓、账户重置
//   · 自动策略（maCross / rsiReversal / gridTrading）启停
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  type UnifiedQuote,
  type UnifiedKline,
} from '../api/dataService';
import { detectMarket, pctColor } from '../lib/stock';
import { getMarketStatus } from '../lib/marketHours';
import { theme } from '../lib/theme';
import TopNav from '../components/TopNav';

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

  const equityRef = useRef<HTMLDivElement>(null);
  const equityChart = useRef<echarts.ECharts | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [acc, sts, lgs] = await Promise.all([
        paperApi.getAccount(),
        paperApi.listStrategies().catch(() => [] as PaperStrategy[]),
        paperApi.getLogs().catch(() => [] as PaperLogEntry[]),
      ]);
      setAccount(acc);
      setStrategies(sts);
      setLogs(lgs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => window.clearInterval(timer);
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
    const timer = window.setInterval(load, 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
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
        data: points.map((p) => p.t.slice(11, 16)),
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

  const stDef = STRATEGY_TYPES.find((s) => s.key === stType) ?? STRATEGY_TYPES[0];
  // 交易时段状态（随选中标的的市场变化；每次轮询重渲染时自动刷新）
  const mktStatus = getMarketStatus(detectMarket(selectedSymbol || 'sh600519'));

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
    <div style={{ ...theme.page, padding: '20px 24px' }}>
      {/* 顶部导航（全站统一） */}
      <TopNav />

      {/* 页面标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '18px 0 0' }}>
        <h1 style={{ fontSize: '20px', margin: 0 }}>💰 模拟交易</h1>
        <span style={{ fontSize: '12px', color: '#64748b' }}>
          100 万虚拟资金 · 真实行情撮合 · 佣金万2.5（最低5元）+ 卖出印花税千1 · 数据 10 秒刷新
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
            <div style={{ fontWeight: 700, marginBottom: '12px' }}>📝 下单</div>
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
              {type === 'limit' && (
                <input style={INPUT} type="number" min={0} value={limitPrice || ''} onChange={(e) => setLimitPrice(Number(e.target.value) || 0)} placeholder="限价（元）" />
              )}
              <button style={BTN(side === 'buy' ? '#16a34a' : '#dc2626')} onClick={submitOrder}>
                提交{side === 'buy' ? '买入' : '卖出'}委托
              </button>
              <div style={{ fontSize: '11px', color: '#475569' }}>
                市价单按最新行情立即成交；限价单未成交将持续挂单（每 5 秒重试）。
                点击持仓/委托里的代码可在右侧查看实时行情。
              </div>
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
        </div>

        {/* 右列：行情面板 + 净值 + 持仓 + 委托 + 日志 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* 行情联动面板 */}
          <div style={CARD}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span style={{ fontWeight: 700 }}>📡 行情面板</span>
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
                  <button style={{ ...BTN('#16a34a'), padding: '7px 14px' }} onClick={() => quickOrder('buy')}>按现价买</button>
                  <button style={{ ...BTN('#dc2626'), padding: '7px 14px' }} onClick={() => quickOrder('sell')}>按现价卖</button>
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
                    {['代码', '名称', '数量', '成本', '现价', '市值', '浮动盈亏', ''].map((h) => (
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
                      <td style={{ padding: '8px' }}>{p.avgCost}</td>
                      <td style={{ padding: '8px' }}>{p.lastPrice}</td>
                      <td style={{ padding: '8px' }}>{fmtMoney(p.marketValue)}</td>
                      <td style={{ padding: '8px', color: pctColor(p.unrealizedPnl) }}>
                        {p.unrealizedPnl >= 0 ? '+' : ''}{fmtMoney(p.unrealizedPnl)}（{p.unrealizedPct >= 0 ? '+' : ''}{p.unrealizedPct}%）
                      </td>
                      <td style={{ padding: '8px' }}>
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
            <div style={{ fontWeight: 700, marginBottom: '10px' }}>📜 委托与成交记录</div>
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
                      <span style={{ color: '#475569', marginLeft: 'auto' }}>{o.createdAt.slice(5, 16).replace('T', ' ')}</span>
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
                <div key={i}>{l.t.slice(5, 16).replace('T', ' ')} — {l.msg}</div>
              ))}
              {logs.length === 0 && <div style={{ color: '#475569' }}>暂无日志。</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
