import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as echarts from 'echarts';
import { runBacktest, type BacktestResult } from '../api/dataService';
import { detectMarket, marketLabel, pctColor } from '../lib/stock';

/** 策略配置 */
const STRATEGIES = [
  { key: 'ma', name: 'MA 双均线', desc: '快线上穿慢线买入，下穿卖出（默认 5/20）' },
  { key: 'rsi', name: 'RSI 超买超卖', desc: 'RSI 上穿 30 买入，下穿 70 卖出' },
  { key: 'buyhold', name: '买入持有', desc: '期初全仓买入，期末卖出（基准对照）' },
] as const;

type StrategyKey = (typeof STRATEGIES)[number]['key'];

export default function BacktestPage() {
  const navigate = useNavigate();
  const [symbol, setSymbol] = useState('AAPL');
  const [strategy, setStrategy] = useState<StrategyKey>('ma');
  const [fast, setFast] = useState(5);
  const [slow, setSlow] = useState(20);
  const [capital, setCapital] = useState(100000);
  const [count, setCount] = useState(500);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);

  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  // 图表实例生命周期
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = echarts.init(chartRef.current);
    chartInstance.current = chart;
    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      chart.dispose();
      chartInstance.current = null;
    };
  }, []);

  // 渲染收益曲线
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || !result || result.equity.length === 0) return;
    const dates = result.equity.map((e) => e.date);
    chart.setOption({
      title: {
        text: `收益曲线 · ${result.symbol} · ${result.range.start} ~ ${result.range.end}`,
        left: 'center',
        top: 0,
        textStyle: { fontSize: 13, fontWeight: 600, color: '#e2e8f0' },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(13, 19, 34, 0.92)',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 12 },
        valueFormatter: (v: unknown) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      },
      legend: {
        data: ['策略收益', '买入持有基准'],
        top: 24,
        left: 'center',
        textStyle: { color: '#94a3b8', fontSize: 11 },
      },
      grid: { left: '4%', right: '3%', top: '16%', bottom: '8%', containLabel: true },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: { show: false },
        axisLabel: { fontSize: 10, color: '#64748b', interval: 'auto', hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: { show: false },
        axisLabel: { fontSize: 10, color: '#64748b', formatter: (v: number) => `$${(v / 1000).toFixed(0)}k` },
        splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' } },
      },
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        {
          type: 'slider',
          top: '94%',
          height: 14,
          backgroundColor: '#0d1322',
          borderColor: '#1e293b',
          fillerColor: 'rgba(59, 130, 246, 0.18)',
          handleStyle: { color: '#3b82f6' },
          textStyle: { color: '#64748b', fontSize: 8 },
          showDetail: false,
        },
      ],
      series: [
        {
          name: '策略收益',
          type: 'line',
          data: result.equity.map((e) => e.value),
          showSymbol: false,
          smooth: true,
          lineStyle: { width: 1.6, color: '#3b82f6' },
          areaStyle: { color: 'rgba(59, 130, 246, 0.08)' },
        },
        {
          name: '买入持有基准',
          type: 'line',
          data: result.benchmark.map((e) => e.value),
          showSymbol: false,
          smooth: true,
          lineStyle: { width: 1.1, color: '#64748b', type: 'dashed' },
        },
      ],
    });
  }, [result]);

  const handleRun = async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) {
      setError('请输入股票代码');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await runBacktest({ symbol: sym, strategy, fast, slow, capital, count });
      if (r.error) throw new Error(r.error);
      setResult(r);
    } catch (e: any) {
      setError(e?.message || '回测失败');
    } finally {
      setLoading(false);
    }
  };

  const market = detectMarket(symbol || 'AAPL');

  const statCard = (label: string, value: string, color = '#f1f5f9') => (
    <div
      style={{
        flex: '1 1 150px',
        maxWidth: '200px',
        textAlign: 'center',
        padding: '12px 14px',
        backgroundColor: '#111827',
        borderRadius: '12px',
        border: '1px solid #1e293b',
      }}
    >
      <div style={{ fontSize: '12px', color: '#64748b', fontWeight: '500' }}>{label}</div>
      <div style={{ fontSize: '19px', fontWeight: '700', color, marginTop: '4px' }}>{value}</div>
    </div>
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#0a0e17',
        color: '#e2e8f0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* 顶部导航 */}
      <nav
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          padding: '14px 32px',
          backgroundColor: 'rgba(10, 14, 23, 0.85)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #1e293b',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '26px', cursor: 'pointer' }} onClick={() => navigate('/')}>
            🤖
          </span>
          <span style={{ fontSize: '19px', fontWeight: '700', color: '#f1f5f9' }}>
            AI深度量化 · 策略回测
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '14px' }}>
          <span style={{ color: '#94a3b8', cursor: 'pointer' }} onClick={() => navigate('/')}>
            🏠 首页
          </span>
          <span style={{ color: '#94a3b8', cursor: 'pointer' }} onClick={() => navigate('/analyze')}>
            AI 潜力分析
          </span>
          <span style={{ color: '#94a3b8', cursor: 'pointer' }} onClick={() => navigate('/assistant')}>
            AI 助手
          </span>
        </div>
      </nav>

      <main style={{ maxWidth: '980px', margin: '0 auto', padding: '28px 20px 48px' }}>
        {/* 参数面板 */}
        <section
          style={{
            padding: '20px',
            backgroundColor: '#111827',
            borderRadius: '14px',
            border: '1px solid #1e293b',
            marginBottom: '20px',
          }}
        >
          <h2 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 16px', color: '#f1f5f9' }}>
            ⚙️ 回测参数
          </h2>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#94a3b8' }}>
              股票代码（{marketLabel(market)}）
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRun();
                }}
                placeholder="如 AAPL / 600519 / 00700"
                style={inputStyle}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#94a3b8' }}>
              策略
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as StrategyKey)}
                style={{ ...inputStyle, minWidth: '170px' }}
              >
                {STRATEGIES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {strategy === 'ma' && (
              <>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#94a3b8' }}>
                  快线周期
                  <input
                    type="number"
                    min={2}
                    max={120}
                    value={fast}
                    onChange={(e) => setFast(Number(e.target.value))}
                    style={{ ...inputStyle, width: '80px' }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#94a3b8' }}>
                  慢线周期
                  <input
                    type="number"
                    min={3}
                    max={250}
                    value={slow}
                    onChange={(e) => setSlow(Number(e.target.value))}
                    style={{ ...inputStyle, width: '80px' }}
                  />
                </label>
              </>
            )}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#94a3b8' }}>
              初始资金 ($)
              <input
                type="number"
                min={1000}
                step={10000}
                value={capital}
                onChange={(e) => setCapital(Number(e.target.value))}
                style={{ ...inputStyle, width: '120px' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#94a3b8' }}>
              历史根数
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                style={{ ...inputStyle, width: '100px' }}
              >
                <option value={250}>250</option>
                <option value={500}>500</option>
                <option value={1000}>1000</option>
                <option value={2000}>2000</option>
              </select>
            </label>
            <button
              onClick={handleRun}
              disabled={loading}
              style={{
                padding: '10px 26px',
                fontSize: '14px',
                fontWeight: '700',
                color: '#fff',
                backgroundColor: loading ? '#475569' : '#2563eb',
                border: 'none',
                borderRadius: '8px',
                cursor: loading ? 'default' : 'pointer',
              }}
            >
              {loading ? '⏳ 回测中...' : '🚀 开始回测'}
            </button>
          </div>
          <p style={{ fontSize: '12px', color: '#475569', margin: '12px 0 0' }}>
            {STRATEGIES.find((s) => s.key === strategy)?.desc} · 含 0.1% 双边手续费 · 基于真实历史日 K
          </p>
        </section>

        {error && (
          <div
            style={{
              padding: '16px',
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              borderRadius: '12px',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#f87171',
              fontSize: '14px',
              marginBottom: '20px',
            }}
          >
            ⚠️ {error}
          </div>
        )}

        {result && (
          <>
            {/* 指标卡 */}
            <section
              style={{
                display: 'flex',
                gap: '12px',
                flexWrap: 'wrap',
                justifyContent: 'center',
                marginBottom: '20px',
              }}
            >
              {statCard('累计收益', `${result.totalReturn >= 0 ? '+' : ''}${result.totalReturn}%`, pctColor(result.totalReturn))}
              {statCard('年化收益', `${result.annualized >= 0 ? '+' : ''}${result.annualized}%`, pctColor(result.annualized))}
              {statCard('最大回撤', `-${result.maxDrawdownPct}%`, '#f59e0b')}
              {statCard('胜率', `${result.winRate}%`, result.winRate >= 50 ? '#22c55e' : '#ef4444')}
              {statCard('交易次数', `${result.tradeCount} 次`)}
              {statCard('基准(买入持有)', `${result.benchmarkReturn >= 0 ? '+' : ''}${result.benchmarkReturn}%`, '#94a3b8')}
              {statCard('期末资金', `$${result.finalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`)}
            </section>

            {/* 收益曲线 */}
            <div
              ref={chartRef}
              style={{
                width: '100%',
                height: '360px',
                borderRadius: '12px',
                border: '1px solid #1e293b',
                backgroundColor: '#111827',
                padding: '4px',
                marginBottom: '20px',
              }}
            />

            {/* 交易明细 */}
            <section
              style={{
                padding: '16px 20px',
                backgroundColor: '#111827',
                borderRadius: '14px',
                border: '1px solid #1e293b',
              }}
            >
              <h3 style={{ fontSize: '15px', fontWeight: '600', margin: '0 0 12px', color: '#f1f5f9' }}>
                📋 交易明细（最近 {result.trades.length} 笔{result.tradeCount > result.trades.length ? `，共 ${result.tradeCount} 笔` : ''}）
              </h3>
              {result.trades.length === 0 ? (
                <p style={{ color: '#64748b', fontSize: '13px', textAlign: 'center', padding: '16px 0' }}>
                  该参数下未触发交易（策略始终空仓或持仓）
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ color: '#64748b', textAlign: 'left' }}>
                        <th style={thStyle}>买入日期</th>
                        <th style={thStyle}>买入价</th>
                        <th style={thStyle}>卖出日期</th>
                        <th style={thStyle}>卖出价</th>
                        <th style={thStyle}>持有天数</th>
                        <th style={thStyle}>盈亏</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...result.trades].reverse().map((t, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #1e293b' }}>
                          <td style={tdStyle}>{t.entryDate}</td>
                          <td style={tdStyle}>${t.entryPrice.toFixed(2)}</td>
                          <td style={tdStyle}>
                            {t.exitDate}
                            {t.forced && <span style={{ color: '#64748b' }}>（期末清仓）</span>}
                          </td>
                          <td style={tdStyle}>${t.exitPrice.toFixed(2)}</td>
                          <td style={tdStyle}>{t.holdDays} 天</td>
                          <td style={{ ...tdStyle, fontWeight: '700', color: pctColor(t.pnlPct) }}>
                            {t.pnlPct >= 0 ? '+' : ''}
                            {t.pnlPct}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {!result && !loading && !error && (
          <div
            style={{
              textAlign: 'center',
              color: '#64748b',
              padding: '40px',
              backgroundColor: '#0d1322',
              borderRadius: '12px',
              border: '1px dashed #1e293b',
            }}
          >
            💡 设置参数后点击「开始回测」。示例：AAPL + MA双均线(5/20) + 10万美元 + 500 根日K。
          </div>
        )}

        <p style={{ textAlign: 'center', color: '#475569', fontSize: '12px', marginTop: '20px' }}>
          📊 回测结果仅供参考，不构成投资建议 · 历史表现不代表未来收益
        </p>
      </main>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: '13px',
  color: '#e2e8f0',
  backgroundColor: '#0d1322',
  border: '1px solid #334155',
  borderRadius: '8px',
  outline: 'none',
  width: '140px',
};

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontWeight: '500',
  borderBottom: '1px solid #1e293b',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  color: '#94a3b8',
};
