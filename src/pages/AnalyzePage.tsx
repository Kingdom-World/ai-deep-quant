import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as echarts from 'echarts';
import { getHistory, getQuote } from '../api/dataService';
import {
  analyzeStockPotential,
  detectMarket,
  friendlyError,
  marketLabel,
  type Market,
  type PotentialReport,
} from '../lib/stock';
import { marketToCurrency, type Currency } from '../utils/formatters';

/** 因子雷达图维度顺序 */
const FACTOR_ORDER = ['趋势', '动量', '量能', '波动', '位置'];

export default function AnalyzePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initSymbol = (searchParams.get('symbol') || 'MSFT').toUpperCase();

  const [symbol, setSymbol] = useState(initSymbol);
  const [inputValue, setInputValue] = useState(initSymbol);
  const [report, setReport] = useState<PotentialReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteInfo, setQuoteInfo] = useState<{
    price: number;
    changePercent: number;
    market: Market;
  } | null>(null);

  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const resizeHandler = useRef<(() => void) | null>(null);

  const market: Market = detectMarket(symbol);
  const currency: Currency = marketToCurrency(market);
  const CURRENCY = currency === 'USD' ? '$' : currency === 'HKD' ? 'HK$' : '¥';

  const runAnalysis = async (sym: string) => {
    const s = sym.trim().toUpperCase();
    if (!s) {
      setError('请输入股票代码');
      return;
    }
    setSymbol(s);
    setLoading(true);
    setError(null);
    setReport(null);
    setQuoteInfo(null);
    chartInstance.current?.clear();

    try {
      const m = detectMarket(s);
      const [rows, quote] = await Promise.all([
        getHistory(s, m, 'day', 300, true),
        getQuote(s, m, true),
      ]);
      // UnifiedKline → KlinePoint
      const points = rows.map((r) => ({
        date: r.date,
        open: r.open,
        close: r.close,
        high: r.high,
        low: r.low,
        volume: r.volume,
      }));
      if (!points || points.length === 0) {
        throw new Error('未获取到历史数据');
      }
      const rep = analyzeStockPotential(s, points, {
        price: quote.price,
        changePercent: quote.changePercent ?? 0,
      });
      if (!rep) {
        throw new Error('历史数据不足，无法完成评分（需至少 60 个交易日）');
      }
      setReport(rep);
      setQuoteInfo({ price: quote.price, changePercent: quote.changePercent ?? 0, market: m });
    } catch (err: any) {
      setError(friendlyError(s, err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initSymbol) runAnalysis(initSymbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 雷达图渲染（每次 report 变化时重建实例：
  // 图表容器为条件渲染（report 存在才挂载），换股票时 div 会卸载重建，
  // 旧实例若不销毁会指向已脱离 DOM 的 canvas，导致图形无法显示）
  useEffect(() => {
    const el = chartRef.current;
    if (!el || !report) return;
    const cleanup = () => {
      if (resizeHandler.current) {
        window.removeEventListener('resize', resizeHandler.current);
        resizeHandler.current = null;
      }
      chartInstance.current?.dispose();
      chartInstance.current = null;
    };
    cleanup(); // 重建前清理旧实例
    const chart = echarts.init(el);
    chartInstance.current = chart;
    const handleResize = () => chart.resize();
    resizeHandler.current = handleResize;
    window.addEventListener('resize', handleResize);

    const maxes = Object.fromEntries(report.factors.map((f) => [f.name, f.max]));
    chart.setOption({
      tooltip: {},
      legend: {
        data: ['因子评分'],
        textStyle: { color: '#94a3b8' },
        top: 0,
      },
      radar: {
        indicator: FACTOR_ORDER.map((name) => ({ name, max: maxes[name] ?? 30 })),
        radius: '65%',
        axisName: { color: '#94a3b8', fontSize: 12 },
        splitLine: { lineStyle: { color: '#1e293b' } },
        splitArea: { areaStyle: { color: ['#0d1322', '#111827'] } },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      series: [
        {
          type: 'radar',
          data: [
            {
              name: '因子评分',
              value: FACTOR_ORDER.map(
                (name) => report.factors.find((f) => f.name === name)?.score ?? 0,
              ),
              areaStyle: { color: 'rgba(59, 130, 246, 0.25)' },
              lineStyle: { color: '#3b82f6', width: 2 },
              itemStyle: { color: '#3b82f6' },
            },
          ],
        },
      ],
    });
    return cleanup;
  }, [report]);

  useEffect(() => {
    return () => {
      chartInstance.current?.dispose();
      chartInstance.current = null;
    };
  }, []);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span onClick={() => navigate('/')} style={{ fontSize: '24px', cursor: 'pointer' }}>
            🤖
          </span>
          <span style={{ fontSize: '18px', fontWeight: '700', color: '#f1f5f9' }}>
            量化因子分析
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runAnalysis(inputValue)}
            placeholder="输入股票代码 (如 NVDA, 600519, 00700)"
            style={{
              border: '1px solid #334155',
              outline: 'none',
              background: '#111827',
              fontSize: '13px',
              color: '#e2e8f0',
              width: '220px',
              padding: '8px 12px',
              borderRadius: '8px',
            }}
          />
          <button
            onClick={() => runAnalysis(inputValue)}
            disabled={loading}
            style={{
              padding: '8px 18px',
              fontSize: '13px',
              fontWeight: '600',
              color: '#fff',
              backgroundColor: loading ? '#475569' : '#2563eb',
              border: 'none',
              borderRadius: '8px',
              cursor: loading ? 'default' : 'pointer',
            }}
          >
            {loading ? '分析中...' : '🧮 分析'}
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
        </div>
      </nav>

      <main style={{ maxWidth: '960px', margin: '0 auto', padding: '28px 24px 48px' }}>
        <h1 style={{ fontSize: '26px', fontWeight: '700', margin: '0 0 8px', color: '#f8fafc' }}>
          🧮 五因子量化评分模型
        </h1>
        <p style={{ fontSize: '14px', color: '#94a3b8', margin: '0 0 24px', lineHeight: 1.7 }}>
          输入任意股票代码（美股 / A股 / 港股），系统基于{' '}
          <b style={{ color: '#e2e8f0' }}>趋势(30) · 动量(25) · 量能(15) · 波动(15) · 位置(15)</b>{' '}
          五因子模型进行量化打分，满分 100，并给出综合评级与因子拆解。
        </p>

        {loading && (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: '60px 0' }}>
            <div style={{ fontSize: '28px', marginBottom: '12px' }}>
              <span className="dsh-spin">⏳</span>
            </div>
            正在分析 {symbol} 的 {marketLabel(market)} 数据...
          </div>
        )}

        {error && !loading && (
          <div
            style={{
              textAlign: 'center',
              color: '#f87171',
              padding: '24px',
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              borderRadius: '12px',
              border: '1px solid rgba(239, 68, 68, 0.3)',
            }}
          >
            ⚠️ {error}
          </div>
        )}

        {report && quoteInfo && !loading && (
          <>
            {/* 总评卡片 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px',
                flexWrap: 'wrap',
                padding: '20px 24px',
                backgroundColor: '#111827',
                borderRadius: '14px',
                border: '1px solid #1e293b',
                marginBottom: '20px',
              }}
            >
              <div>
                <div style={{ fontSize: '22px', fontWeight: '700', color: '#f8fafc' }}>
                  {symbol}
                  <span
                    style={{
                      marginLeft: '10px',
                      fontSize: '12px',
                      color: '#64748b',
                      backgroundColor: '#1e293b',
                      padding: '2px 10px',
                      borderRadius: '999px',
                    }}
                  >
                    {marketLabel(quoteInfo.market)}
                  </span>
                </div>
                <div style={{ fontSize: '14px', color: '#94a3b8', marginTop: '6px' }}>
                  最新价 {CURRENCY}
                  {quoteInfo.price.toFixed(2)} ·{' '}
                  <span
                    style={{
                      color: quoteInfo.changePercent >= 0 ? '#ef4444' : '#22c55e',
                      fontWeight: 600,
                    }}
                  >
                    {quoteInfo.changePercent >= 0 ? '+' : ''}
                    {quoteInfo.changePercent.toFixed(2)}%
                  </span>
                  <span
                    style={{ marginLeft: '12px', cursor: 'pointer', color: '#60a5fa' }}
                    onClick={() => navigate(`/stock/${symbol}`)}
                  >
                    查看完整看板 →
                  </span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '13px', color: '#64748b' }}>综合评分</div>
                <div
                  style={{
                    fontSize: '42px',
                    fontWeight: '800',
                    color: report.ratingColor,
                    lineHeight: 1.1,
                  }}
                >
                  {report.total}
                  <span style={{ fontSize: '16px', color: '#64748b', fontWeight: 500 }}>/100</span>
                </div>
                <div
                  style={{
                    fontSize: '14px',
                    fontWeight: '700',
                    color: report.ratingColor,
                    backgroundColor: 'rgba(255,255,255,0.04)',
                    padding: '3px 14px',
                    borderRadius: '999px',
                    border: `1px solid ${report.ratingColor}44`,
                  }}
                >
                  {report.rating}
                </div>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(300px, 400px) 1fr',
                gap: '16px',
                marginBottom: '20px',
                flexWrap: 'wrap',
              }}
            >
              {/* 雷达图 */}
              <div
                style={{
                  backgroundColor: '#111827',
                  borderRadius: '14px',
                  border: '1px solid #1e293b',
                  padding: '12px',
                }}
              >
                <div ref={chartRef} style={{ width: '100%', height: '320px' }} />
              </div>

              {/* 因子明细 */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                {report.factors.map((f) => {
                  const pct = Math.min(100, (f.score / f.max) * 100);
                  const color =
                    f.score / f.max >= 0.7
                      ? '#ef4444'
                      : f.score / f.max >= 0.45
                        ? '#f59e0b'
                        : '#22c55e';
                  return (
                    <div
                      key={f.name}
                      style={{
                        padding: '12px 16px',
                        backgroundColor: '#111827',
                        borderRadius: '10px',
                        border: '1px solid #1e293b',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ fontSize: '14px', fontWeight: '600', color: '#e2e8f0' }}>
                          {f.name}
                          <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '6px' }}>
                            / {f.max}分
                          </span>
                        </span>
                        <span style={{ fontSize: '18px', fontWeight: '800', color }}>
                          {f.score}
                        </span>
                      </div>
                      <div
                        style={{
                          height: '6px',
                          backgroundColor: '#1e293b',
                          borderRadius: '999px',
                          marginTop: '8px',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${pct}%`,
                            backgroundColor: color,
                            borderRadius: '999px',
                            transition: 'width 0.6s',
                          }}
                        />
                      </div>
                      <div
                        style={{
                          fontSize: '12px',
                          color: '#94a3b8',
                          marginTop: '8px',
                          lineHeight: 1.6,
                        }}
                      >
                        {f.reason}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 综合摘要 */}
            <div
              style={{
                padding: '16px 20px',
                backgroundColor: '#0d1322',
                borderRadius: '12px',
                border: '1px solid #1e293b',
                fontSize: '13px',
                color: '#94a3b8',
                lineHeight: 1.8,
              }}
            >
              📋 <b style={{ color: '#e2e8f0' }}>分析摘要：</b>
              {report.summary}
              <div style={{ marginTop: '6px', color: '#475569', fontSize: '12px' }}>
                * 本评分基于历史行情数据与多因子模型计算，仅供学习参考，不构成投资建议。
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
