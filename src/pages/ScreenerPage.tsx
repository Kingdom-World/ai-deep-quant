// ─────────────────────────────────────────────────────────────
// 选股页（/screener）—— 融合 tick-stock-panel/TSP 选股引擎思路
//   · 市场温度计横幅：涨跌家数/涨停跌停/情绪分/领涨行业（30 秒轮询）
//   · 8 个快照策略一键选股（量比突增/涨停梯队/放量上攻…）
//   · 结果表：点行跳量化看板，点行业筛同行业
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  screenerApi,
  moodApi,
  type ScreenerResult,
  type MarketMood,
  type ScreenerStrategy,
} from '../api/dataService';
import { pctColor } from '../lib/stock';
import { theme } from '../lib/theme';
import { setVisibilityInterval } from '../lib/polling';
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

const fmtYi = (v: number) => (v >= 1e8 ? (v / 1e8).toFixed(1) + ' 亿' : v >= 1e4 ? (v / 1e4).toFixed(0) + ' 万' : String(v));
const fmtCap = (v: number) => (v >= 1e12 ? (v / 1e12).toFixed(2) + ' 万亿' : v >= 1e8 ? (v / 1e8).toFixed(0) + ' 亿' : '—');

/** 情绪分色：冰点蓝 → 中性灰 → 过热红 */
function moodColor(score: number) {
  if (score >= 70) return '#ef4444';
  if (score >= 45) return '#e2e8f0';
  return '#60a5fa';
}

function moodLabel(score: number) {
  if (score >= 75) return '过热';
  if (score >= 60) return '偏暖';
  if (score >= 45) return '中性';
  if (score >= 30) return '偏冷';
  return '冰点';
}

export default function ScreenerPage() {
  const navigate = useNavigate();
  const [strategies, setStrategies] = useState<ScreenerStrategy[]>([]);
  const [strategy, setStrategy] = useState('volumeSurge');
  const [result, setResult] = useState<ScreenerResult | null>(null);
  const [mood, setMood] = useState<MarketMood | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [industryFilter, setIndustryFilter] = useState<string>('');

  useEffect(() => {
    screenerApi.strategies().then((r) => setStrategies(r.strategies ?? [])).catch(() => {});
  }, []);

  const loadMood = useCallback(() => {
    moodApi.get().then(setMood).catch(() => {});
  }, []);

  const run = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      setResult(await screenerApi.run(key));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    run(strategy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy]);

  useEffect(() => {
    loadMood();
    const stopPolling = setVisibilityInterval(loadMood, 30000);
    return () => stopPolling();
  }, [loadMood]);

  const rows = (result?.rows ?? []).filter((r) => !industryFilter || r.industry === industryFilter);
  const cur = strategies.find((s) => s.key === strategy);

  return (
    <div style={{ ...theme.page }}>
      <TopNav />
      <div style={{ padding: '20px 24px' }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0 14px' }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>🔍 全市场选股</h1>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          实时快照扫描全 A（东财公开数据 · 60 秒缓存）· 结果仅供研究，不构成投资建议
        </span>
      </div>

      {/* ── 市场温度计 ── */}
      <div style={{ ...CARD, marginBottom: 14, display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
        {mood ? (
          <>
            <div style={{ textAlign: 'center', minWidth: 96 }}>
              <div style={{ fontSize: 11, color: '#64748b', letterSpacing: 1 }}>市场情绪</div>
              <div style={{ fontSize: 30, fontWeight: 800, color: moodColor(mood.score) }}>{mood.score}</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>{moodLabel(mood.score)}{mood.stale ? ' · 缓存' : ''}</div>
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
              <span style={{ color: '#ef4444' }}>▲ 上涨 <b>{mood.up}</b></span>
              <span style={{ color: '#22c55e' }}>▼ 下跌 <b>{mood.down}</b></span>
              <span style={{ color: '#64748b' }}>平 {mood.flat}</span>
              <span style={{ color: '#f87171' }}>涨停 <b>{mood.limitUp}</b></span>
              <span style={{ color: '#4ade80' }}>跌停 <b>{mood.limitDown}</b></span>
              <span style={{ color: '#94a3b8' }}>总成交 {fmtYi(mood.totalAmount)}</span>
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>领涨行业</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {mood.industries.slice(0, 5).map((i) => (
                  <span key={i.name} style={{ fontSize: 12, padding: '3px 9px', borderRadius: 999, backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#fca5a5', cursor: 'pointer' }} title={`平均涨幅 ${i.avgPct}% · 上涨占比 ${(i.upRatio * 100).toFixed(0)}%`}>
                    {i.name} <b>{i.avgPct > 0 ? '+' : ''}{i.avgPct}%</b>
                  </span>
                ))}
                {mood.coldest.slice(0, 2).map((i) => (
                  <span key={i.name} style={{ fontSize: 12, padding: '3px 9px', borderRadius: 999, backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', color: '#86efac' }}>
                    {i.name} <b>{i.avgPct}%</b>
                  </span>
                ))}
              </div>
            </div>
          </>
        ) : (
          <span style={{ color: '#64748b', fontSize: 13 }}>市场温度计加载中…</span>
        )}
      </div>

      {/* ── 策略选择 ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {strategies.map((s) => (
          <button
            key={s.key}
            title={s.desc}
            onClick={() => setStrategy(s.key)}
            style={{
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              color: strategy === s.key ? '#fff' : '#93c5fd',
              backgroundColor: strategy === s.key ? '#2563eb' : 'rgba(96,165,250,0.08)',
              border: `1px solid ${strategy === s.key ? '#2563eb' : 'rgba(96,165,250,0.3)'}`,
              borderRadius: 999,
              cursor: 'pointer',
            }}
          >
            {s.name}
          </button>
        ))}
      </div>
      {cur && (
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
          当前策略：<b style={{ color: '#93c5fd' }}>{cur.name}</b> —— {cur.desc}
        </div>
      )}

      {error && <div style={{ ...CARD, borderColor: '#7f1d1d', color: '#f87171', marginBottom: 12 }}>⚠️ {error}</div>}

      {/* ── 结果表 ── */}
      <div style={CARD}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <span style={{ fontWeight: 700 }}>
            {result ? `命中 ${result.matched} / ${result.scanned} 只（展示前 ${rows.length}）` : '扫描中…'}
          </span>
          {industryFilter && (
            <button style={{ padding: '3px 10px', fontSize: 12, color: '#93c5fd', backgroundColor: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 999, cursor: 'pointer' }} onClick={() => setIndustryFilter('')}>
              行业：{industryFilter} ✕
            </button>
          )}
          {loading && <span style={{ fontSize: 12, color: '#64748b' }}>扫描中…</span>}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: '#64748b', fontSize: 12 }}>
              {['代码', '名称', '现价', '涨幅', '换手%', '量比', '成交额', '市值', '行业'].map((h) => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.code}
                style={{ borderTop: '1px solid #1e293b', cursor: 'pointer' }}
                onClick={() => navigate(`/stock/${r.code}`)}
                title="打开量化看板"
              >
                <td style={{ padding: '7px 8px', fontFamily: 'Consolas, monospace', color: '#93c5fd' }}>{r.code}</td>
                <td style={{ padding: '7px 8px', color: '#e2e8f0', fontWeight: 600 }}>{r.name}</td>
                <td style={{ padding: '7px 8px' }}>{r.price.toFixed(2)}</td>
                <td style={{ padding: '7px 8px', color: pctColor(r.pct), fontWeight: 700 }}>
                  {r.pct > 0 ? '+' : ''}{r.pct.toFixed(2)}%
                </td>
                <td style={{ padding: '7px 8px', color: r.turnover >= 10 ? '#facc15' : '#94a3b8' }}>{r.turnover.toFixed(1)}</td>
                <td style={{ padding: '7px 8px', color: r.volRatio >= 3 ? '#facc15' : '#94a3b8' }}>{r.volRatio.toFixed(1)}</td>
                <td style={{ padding: '7px 8px', color: '#94a3b8' }}>{fmtYi(r.amount)}</td>
                <td style={{ padding: '7px 8px', color: '#64748b' }}>{fmtCap(r.mktCap)}</td>
                <td
                  style={{ padding: '7px 8px', color: '#64748b', cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); setIndustryFilter(r.industry); }}
                  title="点击筛选同行业"
                >
                  {r.industry}
                </td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td colSpan={9} style={{ padding: '18px 8px', color: '#475569', textAlign: 'center' }}>当前策略暂无命中（快照约 60 秒刷新，可稍后重试或换策略）</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16, fontSize: 12, color: '#475569', lineHeight: 1.8 }}>
        ⚠️ 免责声明：选股结果由程序基于公开行情快照按固定规则筛选，属学术研究演示，不构成任何投资建议；快照数据有延迟，筛选口径不含历史K线验证，据此操作、风险自负。
      </div>
      </div>
    </div>
  );
  }
