// ─────────────────────────────────────────────────────────────
// 首页「板块与资金」面板：行业/概念/地域 三Tab
//   · 主力净流入条形图（红入绿出，对标国内行情软件）
//   · 板块卡片（涨幅 + 分时 sparkline + 领涨股）
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { apiGet } from '../api/dataService';
import { theme } from '../lib/theme';

const TABS = [
  { key: 'industry', name: '行业板块' },
  { key: 'concept', name: '概念板块' },
  { key: 'region', name: '地域板块' },
];


function Sparkline({ p }: { p: number[] }) {
  if (p.length < 2) return null;
  const min = Math.min(...p);
  const max = Math.max(...p);
  const range = max - min || 1;
  const d = p.map((v, i) => `${((i / (p.length - 1)) * 100).toFixed(1)},${(30 - ((v - min) / range) * 30).toFixed(1)}`).join(' ');
  const up = p[p.length - 1] >= p[0];
  return (
    <svg width="100%" height="32" viewBox="0 0 100 32" preserveAspectRatio="none" style={{ display: 'block' }}>
      <polyline points={d} fill="none" stroke={up ? '#ef4444' : '#22c55e'} strokeWidth="1.6" />
    </svg>
  );
}

export default function SectorMarketPanel() {
  const [tab, setTab] = useState('industry');
  const [flow, setFlow] = useState<any>(null);
  const [cards, setCards] = useState<any>(null);
  const [err, setErr] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(false);
    Promise.all([
      apiGet<any>(`/sectors/flow?type=${tab}`).catch(() => null),
      apiGet<any>(`/sectors/cards?type=${tab}`).catch(() => null),
    ]).then(([f, c]) => {
      if (!alive) return;
      setFlow(f?.ok ? f : null);
      setCards(c?.ok ? c : null);
      if (!f?.ok && !c?.ok) setErr(true);
    });
    return () => {
      alive = false;
    };
  }, [tab]);

  useEffect(() => {
    if (!chartRef.current || !flow) return;
    if (!chart.current) chart.current = echarts.init(chartRef.current);
    const rows = [...(flow.inflow ?? []), ...(flow.outflow ?? [])].reverse();
    chart.current.setOption({
      backgroundColor: 'transparent',
      grid: { left: 76, right: 60, top: 8, bottom: 22 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', axisLabel: { color: '#475569', fontSize: 10, formatter: (v: number) => (v / 1e8).toFixed(0) + '亿' }, splitLine: { lineStyle: { color: '#1e293b' } } },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.name),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#cbd5e1', fontSize: 11 },
      },
      series: [
        {
          type: 'bar',
          data: rows.map((r) => ({
            value: +(r.mainNet / 1e8).toFixed(2),
            itemStyle: { color: r.mainNet >= 0 ? '#ef4444' : '#22c55e', borderRadius: 3 },
          })),
          barWidth: '55%',
          label: {
            show: true,
            position: 'right',
            color: '#94a3b8',
            fontSize: 10,
            formatter: (p: any) => (p.value >= 0 ? '+' : '') + p.value + ' 亿',
          },
        },
      ],
    });
    chart.current.resize();
  }, [flow]);

  useEffect(() => {
    const onResize = () => chart.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  return (
    <div>
      {/* Tab */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '6px 16px',
              fontSize: '13px',
              fontWeight: tab === t.key ? 700 : 500,
              color: tab === t.key ? '#fff' : '#94a3b8',
              backgroundColor: tab === t.key ? '#2563eb' : '#1e293b',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            {t.name}
          </button>
        ))}
      </div>

      {err ? (
        <div style={{ ...theme.card, color: '#f87171', fontSize: 13 }}>板块数据源暂时不可用，稍后自动恢复。</div>
      ) : !flow ? (
        <div style={{ ...theme.card, color: '#64748b', fontSize: 13, marginBottom: 14 }}>板块数据加载中…</div>
      ) : (
        <>
          {/* 主力净流入条形图 */}
          <div style={{ ...theme.glass, borderRadius: 14, padding: '12px 8px 6px 8px', marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: '#94a3b8', padding: '0 10px 4px' }}>
              主力净流入排行 · 单位：亿元 · 更新 {String(flow.updatedAt).slice(11, 19)}
              <span style={{ color: '#ef4444' }}> ■净流入</span>
              <span style={{ color: '#22c55e', marginLeft: 8 }}>■净流出</span>
            </div>
            <div ref={chartRef} style={{ height: '240px' }} />
          </div>

          {/* 板块卡片 */}
          {cards?.cards?.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
              {cards.cards.map((c: any) => (
                <div key={c.code} style={{ ...theme.glass, borderRadius: 12, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#f1f5f9' }}>{c.name}</span>
                    <span style={{ fontSize: 15, fontWeight: 800, color: (c.changePct ?? 0) >= 0 ? '#ef4444' : '#22c55e' }}>
                      {(c.changePct ?? 0) >= 0 ? '+' : ''}
                      {c.changePct?.toFixed(2)}%
                    </span>
                  </div>
                  {c.spark?.p?.length > 1 && <div style={{ margin: '8px 0 4px' }}><Sparkline p={c.spark.p} /></div>}
                  <div style={{ fontSize: 11.5, color: '#64748b' }}>
                    领涨：<span style={{ color: '#cbd5e1' }}>{c.leader}</span>
                    {c.leaderPct != null && <span style={{ color: (c.leaderPct ?? 0) >= 0 ? '#ef4444' : '#22c55e' }}> +{c.leaderPct.toFixed(1)}%</span>}
                    {c.mainNet != null && <span style={{ float: 'right' }}>主力 {c.mainNet >= 0 ? '+' : ''}{(c.mainNet / 1e8).toFixed(1)} 亿</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
