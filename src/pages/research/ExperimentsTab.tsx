import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as echarts from 'echarts';
import { researchApi, type ExperimentRecord } from '../../api/dataService';
import { theme } from '../../lib/theme';
import { MAX_COMPARE, recKey, nextSelection, diffParams } from '../../../shared/experiments.mjs';

// ─────────────────────────────────────────────────────────────
// 实验对比页（/experiments）
//   · 顶部筛选条：数量上限 / 标的代码 / 策略
//   · 实验列表（新在前），逐行指标 + 多选对比（≤4）
//   · 参数差异表：只高亮取值不同的参数行，取值相同折叠成一行汇总
//   · 指标对比图：ECharts 分组柱状图（totalReturn / annualized / maxDrawdownPct / sharpe），sharpe 为 null 画成缺失
//   · 复现入口：跳转 /backtest 并带上 symbol / strategy / params 做非破坏性预填
//   · 状态完整：加载中 / 空数据 / 接口失败 / 移动端窄屏
// ─────────────────────────────────────────────────────────────

const LIMIT_OPTIONS = [20, 50, 100, 200];
const STRATEGY_OPTIONS: { key: string; name: string }[] = [
  { key: 'ma', name: 'MA 双均线' },
  { key: 'rsi', name: 'RSI 超买超卖' },
  { key: 'buyhold', name: '买入持有' },
];
const strategyName = (k: string) => STRATEGY_OPTIONS.find((s) => s.key === k)?.name || k;

/** 收益类指标的涨红跌绿配色（A 股惯例：红涨绿跌） */
const pctColorOf = (v: number | null | undefined) =>
  v === null || v === undefined ? '#94a3b8' : v > 0 ? '#ef4444' : v < 0 ? '#22c55e' : '#94a3b8';

/** 每个对比实验分配一个稳定区分色（与主题强调色系一致） */
const COMPARE_COLORS = ['#60a5fa', '#38bdf8', '#a78bfa', '#f59e0b'];

export default function ExperimentsTab() {
  const navigate = useNavigate();

  // ── 筛选条件 ──
  const [limit, setLimit] = useState<number>(50);
  const [symbolInput, setSymbolInput] = useState('');
  const [symbol, setSymbol] = useState(''); // 生效态（点击查询/回车才更新，避免逐字拉取）
  const [strategy, setStrategy] = useState('');

  // ── 数据态 ──
  const [list, setList] = useState<ExperimentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ── 多选对比 ──
  const [selected, setSelected] = useState<string[]>([]);
  const [compareWarn, setCompareWarn] = useState('');

  // ── 窄屏检测（移动端布局） ──
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 720 : false,
  );

  // 拉取实验列表
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await researchApi.experiments(limit, symbol.trim() || undefined, strategy || undefined);
      setList(r.experiments || []);
      // 拉取后清理已不存在于列表中的勾选（避免悬空选择）
      const keys = new Set((r.experiments || []).map(recKey));
      setSelected((prev) => prev.filter((k) => keys.has(k)));
    } catch (e: any) {
      setError(e?.message || '加载实验列表失败');
      setList([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // 依赖筛选条件变化重新拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, symbol, strategy]);

  // 窄屏监听
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 勾选切换：核心判定已抽到 shared/experiments.mjs（node:test 锁边界），
  // 此处只做 state 更新——行为与原实现逐行等价（上限拦截仍为可见提示，非静默）。
  const toggleSelect = (e: ExperimentRecord) => {
    const { next, warn } = nextSelection(selected, e);
    setSelected(next);
    setCompareWarn(warn);
  };

  // 已选实验（保持列表顺序，新在前）
  const selectedRecords = useMemo(
    () => list.filter((e) => selected.includes(recKey(e))),
    [list, selected],
  );

  return (
    <>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px', color: '#f1f5f9' }}>🧪 实验对比</h2>
        <p style={{ fontSize: 13, color: theme.color.textMuted, margin: '0 0 18px' }}>
          跨实验比对回测参数、数据区间与核心指标。至多勾选 4 条实验做并排对比——看清「这次改动到底动了什么」。
        </p>

        {/* ── 筛选条 ── */}
        <section
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            padding: 16,
            backgroundColor: '#111827',
            borderRadius: 14,
            border: '1px solid #1e293b',
            marginBottom: 18,
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: theme.color.textMuted }}>
            数量上限
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              style={{ ...theme.input, minWidth: 110 }}
            >
              {LIMIT_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: theme.color.textMuted }}>
            标的代码（如 sh600519 / AAPL）
            <input
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSymbol(symbolInput); }}
              placeholder="留空 = 全部标的"
              style={{ ...theme.input, width: isNarrow ? '100%' : 220 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: theme.color.textMuted }}>
            策略
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              style={{ ...theme.input, minWidth: 150 }}
            >
              <option value="">全部</option>
              {STRATEGY_OPTIONS.map((s) => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() => setSymbol(symbolInput)}
            disabled={loading}
            style={{
              padding: '9px 20px',
              fontSize: 13,
              fontWeight: 700,
              color: '#fff',
              backgroundColor: loading ? '#475569' : theme.color.primaryDeep,
              border: 'none',
              borderRadius: 8,
              cursor: loading ? 'default' : 'pointer',
            }}
          >
            {loading ? '加载中…' : '查询'}
          </button>
          <span style={{ fontSize: 12, color: theme.color.textFaint, marginLeft: 'auto' }}>
            已选 {selected.length}/{MAX_COMPARE} 条对比
          </span>
        </section>

        {/* 多选上限提示（明确可见，非静默） */}
        {compareWarn && (
          <div
            style={{
              padding: '12px 16px',
              backgroundColor: 'rgba(245,158,11,0.1)',
              borderRadius: 12,
              border: '1px solid rgba(245,158,11,0.4)',
              color: '#fbbf24',
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            ⚠️ {compareWarn}
          </div>
        )}

        {/* ── 加载中 ── */}
        {loading && (
          <div style={{ padding: 40, textAlign: 'center', color: theme.color.textMuted, fontSize: 14 }}>
            ⏳ 正在加载实验记录…
          </div>
        )}

        {/* ── 接口失败 ── */}
        {!loading && error && (
          <div
            style={{
              padding: 24,
              backgroundColor: 'rgba(239,68,68,0.08)',
              borderRadius: 12,
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171',
              fontSize: 14,
              marginBottom: 16,
            }}
          >
            ✗ 接口失败：{error}
            <div style={{ marginTop: 10 }}>
              <button
                onClick={load}
                style={{ padding: '7px 16px', fontSize: 13, color: '#fff', backgroundColor: '#2563eb', border: 'none', borderRadius: 8, cursor: 'pointer' }}
              >
                重试
              </button>
            </div>
          </div>
        )}

        {/* ── 空数据 ── */}
        {!loading && !error && list.length === 0 && (
          <div
            style={{
              textAlign: 'center',
              color: theme.color.textMuted,
              padding: 48,
              backgroundColor: 'rgba(13,19,34,0.6)',
              borderRadius: 12,
              border: '1px dashed #1e293b',
            }}
          >
            📭 还没有任何实验记录，先去跑一次回测。
            <div style={{ marginTop: 16 }}>
              <button
                onClick={() => navigate('/backtest')}
                style={{ padding: '9px 20px', fontSize: 13, fontWeight: 700, color: '#fff', backgroundColor: theme.color.primaryDeep, border: 'none', borderRadius: 8, cursor: 'pointer' }}
              >
                ➡️ 前往策略回测
              </button>
            </div>
          </div>
        )}

        {/* ── 实验列表 ── */}
        {!loading && !error && list.length > 0 && (
          <section style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid #1e293b', backgroundColor: '#111827' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12, minWidth: 920 }}>
              <thead>
                <tr style={{ color: theme.color.textFaint, textAlign: 'left' }}>
                  <th style={thS}>对比</th>
                  <th style={thS}>时间</th>
                  <th style={thS}>标的</th>
                  <th style={thS}>策略</th>
                  <th style={thS}>数据区间 / 根数</th>
                  <th style={thS}>期末净值</th>
                  <th style={thS}>总收益</th>
                  <th style={thS}>年化</th>
                  <th style={thS}>最大回撤</th>
                  <th style={thS}>夏普</th>
                  <th style={thS}>笔数</th>
                  <th style={thS}>胜率</th>
                  <th style={thS}>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((e) => {
                  const checked = selected.includes(recKey(e));
                  const m = e.metrics || {};
                  const rg = e.range;
                  return (
                    <tr key={recKey(e)} style={{ borderTop: '1px solid #1e293b', backgroundColor: checked ? 'rgba(96,165,250,0.06)' : 'transparent' }}>
                      <td style={tdS}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelect(e)}
                          aria-label={`对比 ${e.symbol} ${e.strategy}`}
                          style={{ width: 16, height: 16, accentColor: theme.color.primary, cursor: 'pointer' }}
                        />
                      </td>
                      <td style={tdS}>{new Date(e.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                      <td style={tdS}>{e.symbol}</td>
                      <td style={tdS}>{strategyName(e.strategy)}</td>
                      <td style={{ ...tdS, color: theme.color.textFaint }}>
                        {rg ? `${rg.start.slice(0, 10)} ~ ${rg.end.slice(0, 10)} · ${rg.bars}根` : '—'}
                      </td>
                      <td style={tdS}>{typeof m.finalValue === 'number' ? m.finalValue.toLocaleString('zh-CN') : '—'}</td>
                      <td style={{ ...tdS, color: pctColorOf(m.totalReturn) }}>{typeof m.totalReturn === 'number' ? `${m.totalReturn}%` : '—'}</td>
                      <td style={{ ...tdS, color: pctColorOf(m.annualized) }}>{typeof m.annualized === 'number' ? `${m.annualized}%` : '—'}</td>
                      <td style={{ ...tdS, color: '#f59e0b' }}>{typeof m.maxDrawdownPct === 'number' ? `${m.maxDrawdownPct}%` : '—'}</td>
                      <td style={tdS}>{m.sharpe == null ? '缺失' : m.sharpe}</td>
                      <td style={tdS}>{typeof m.tradeCount === 'number' ? m.tradeCount : '—'}</td>
                      <td style={tdS}>{typeof m.winRate === 'number' ? `${m.winRate}%` : '—'}</td>
                      <td style={tdS}>
                        <button
                          onClick={() => {
                            const repParams = e.params || {};
                            const repQ = new URLSearchParams({ symbol: e.symbol, strategy: e.strategy });
                            repQ.set('params', JSON.stringify(repParams));
                            // range 可能为 null：非 null 才带 count（= 数据区间根数）
                            if (e.range && typeof e.range.bars === 'number') repQ.set('count', String(e.range.bars));
                            // slippage 存在才带
                            if (repParams && typeof (repParams as Record<string, unknown>).slippage === 'number') {
                              repQ.set('slippage', String((repParams as Record<string, number>).slippage));
                            }
                            navigate(`/backtest?${repQ.toString()}`);
                          }}
                          title="将带入 symbol / strategy / fast / slow / capital / count / slippage；limitPct、market 由后端按标的自动判定。"
                          style={{ padding: '5px 10px', fontSize: 11, color: theme.color.primary, backgroundColor: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' }}
                        >
                          带参数去回测
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        {/* ── 对比区（参数差异表 + 指标对比图） ── */}
        {selectedRecords.length >= 2 ? (
          <ComparePanel records={selectedRecords} />
        ) : (
          !loading &&
          !error &&
          list.length > 0 && (
            <div
              style={{
                marginTop: 18,
                padding: '20px 24px',
                backgroundColor: 'rgba(13,19,34,0.6)',
                borderRadius: 12,
                border: '1px dashed #1e293b',
                color: theme.color.textMuted,
                fontSize: 13,
              }}
            >
              🔍 勾选至少 2 条实验即可查看「参数差异表」与「指标对比图」。当前已选 {selectedRecords.length} 条。
            </div>
          )
        )}

        <p style={{ textAlign: 'center', color: theme.color.textFaint, fontSize: 12, marginTop: 22 }}>
          📊 实验数据由每次回测自动留痕，仅供研究参考 · 历史表现不代表未来收益
        </p>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 对比面板：参数差异表 + 指标对比图
// ─────────────────────────────────────────────────────────────
function ComparePanel({ records }: { records: ExperimentRecord[] }) {
  // 参数差异判定：逻辑已抽到 shared/experiments.mjs（node:test 锁边界）
  const { differing, identical } = useMemo(() => diffParams(records), [records]);

  return (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* 参数差异表 */}
      <section style={{ padding: 18, backgroundColor: '#111827', borderRadius: 14, border: '1px solid #1e293b' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px', color: '#f1f5f9' }}>
          🔬 参数差异表
          <span style={{ fontSize: 12, color: theme.color.textMuted, fontWeight: 400, marginLeft: 8 }}>
            （{differing.length} 项不同 / {identical.length} 项一致）
          </span>
        </h2>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12, minWidth: 520 }}>
            <thead>
              <tr style={{ color: theme.color.textFaint, textAlign: 'left' }}>
                <th style={thS}>参数</th>
                {records.map((r, i) => (
                  <th key={recKey(r)} style={thS}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: COMPARE_COLORS[i], marginRight: 6 }} />
                    实验{i + 1} · {r.symbol}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* 取值不同的参数：逐行高亮展示 */}
              {differing.map((k) => (
                <tr key={k} style={{ borderTop: '1px solid #1e293b', backgroundColor: 'rgba(245,158,11,0.06)' }}>
                  <td style={{ ...tdS, color: '#fbbf24', fontWeight: 600 }}>{k}</td>
                  {records.map((r) => {
                    const v = (r.params || {})[k];
                    return (
                      <td key={recKey(r)} style={{ ...tdS, color: v === undefined ? theme.color.textFaint : '#e2e8f0' }}>
                        {v === undefined ? '—' : v}
                      </td>
                    );
                  })}
                </tr>
              ))}

              {/* 取值相同的参数：折叠成一行汇总 */}
              {identical.length > 0 && (
                <tr style={{ borderTop: '1px solid #1e293b' }}>
                  <td style={{ ...tdS, color: theme.color.textMuted, fontWeight: 600 }}>
                    其余 {identical.length} 项参数一致
                  </td>
                  <td colSpan={records.length} style={{ ...tdS, color: theme.color.textFaint }}>
                    {identical.map((it) => `${it.key}=${it.value}`).join(' · ')}
                  </td>
                </tr>
              )}

              {differing.length === 0 && identical.length === 0 && (
                <tr>
                  <td colSpan={records.length + 1} style={{ ...tdS, color: theme.color.textFaint }}>
                    所选实验无任何记录参数。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* range 维度对比（params/metrics/range 三维度之一） */}
        <div style={{ marginTop: 14, fontSize: 12, color: theme.color.textMuted }}>
          <span style={{ color: '#fbbf24', fontWeight: 600 }}>数据区间</span>
          ：
          {records.map((r, i) => (
            <span key={recKey(r)} style={{ marginRight: 14 }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: COMPARE_COLORS[i], marginRight: 5 }} />
              实验{i + 1}：{r.range ? `${r.range.start.slice(0, 10)} ~ ${r.range.end.slice(0, 10)}（${r.range.bars}根）` : '—'}
            </span>
          ))}
        </div>
      </section>

      {/* 指标对比图 */}
      <section style={{ padding: 18, backgroundColor: '#111827', borderRadius: 14, border: '1px solid #1e293b' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px', color: '#f1f5f9' }}>
          📊 指标对比图
          <span style={{ fontSize: 12, color: theme.color.textMuted, fontWeight: 400, marginLeft: 8 }}>
            上方：百分比指标（总收益 / 年化 / 最大回撤）；下方：无量纲指标（夏普）
          </span>
        </h2>
        <MetricCompareChart records={records} />
      </section>

      {/* 净值归一化叠加图（与指标柱状图并列，互不影响） */}
      <section style={{ padding: 18, backgroundColor: '#111827', borderRadius: 14, border: '1px solid #1e293b' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 12px', color: '#f1f5f9' }}>
          📈 净值归一化叠加图
          <span style={{ fontSize: 12, color: theme.color.textMuted, fontWeight: 400, marginLeft: 8 }}>
            各实验起点归一化 1.0（不同 capital 可横向对比）
          </span>
        </h2>
        <EquityOverlayChart records={records} />
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 净值归一化叠加图（ECharts 折线：每条按自身首点归一化为 1.0）
//   · 用 time 轴：各实验日期未必对齐，time 轴允许每条线独立按 [日期, 归一化净值] 落点，
//     无需在 category 轴上强行对齐 x 刻度（更稳，避免错位/截断）
//   · 仅纳入带 equityThumb 的已选实验；无缩略曲线的历史记录给出明确提示，不画空图不报错
// ─────────────────────────────────────────────────────────────
function EquityOverlayChart({ records }: { records: ExperimentRecord[] }) {
  const hasThumb = (r: ExperimentRecord) => Array.isArray(r.equityThumb) && r.equityThumb.length > 0;
  const withThumb = useMemo(() => records.filter(hasThumb), [records]);
  const withoutCount = records.length - withThumb.length;

  const chartRef = useRef<HTMLDivElement>(null);
  const chartInst = useRef<echarts.ECharts | null>(null);
  const resizeHandler = useRef<(() => void) | null>(null);

  useEffect(() => {
    const cleanup = () => {
      if (resizeHandler.current) {
        window.removeEventListener('resize', resizeHandler.current);
        resizeHandler.current = null;
      }
      chartInst.current?.dispose();
      chartInst.current = null;
    };
    // 无缩略曲线：不渲染图表（上方已有明确提示），清理并返回
    if (!chartRef.current || withThumb.length === 0) {
      cleanup();
      return;
    }
    cleanup();
    const chart = echarts.init(chartRef.current);
    chartInst.current = chart;
    const handleResize = () => chart.resize();
    resizeHandler.current = handleResize;
    window.addEventListener('resize', handleResize);

    const series = withThumb.map((r, i) => {
      const thumb = r.equityThumb!;
      const base = thumb[0].v;
      return {
        name: `实验${i + 1} · ${r.symbol}`,
        type: 'line' as const,
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 1.6, color: COMPARE_COLORS[i] },
        data: thumb.map((p) => [p.d, base ? p.v / base : 0]),
      };
    });

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(13, 19, 34, 0.92)',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 12 },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(3) : String(v)),
      },
      legend: {
        top: 0,
        left: 'center',
        data: series.map((s) => s.name),
        textStyle: { color: '#94a3b8', fontSize: 11 },
        itemWidth: 12,
        itemHeight: 12,
      },
      grid: { left: '3%', right: '3%', top: 44, bottom: '6%', containLabel: true },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: '#334155' } },
        axisLabel: { fontSize: 10, color: '#64748b' },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: '归一化净值 (起点=1.0)',
        nameTextStyle: { color: '#64748b', fontSize: 10 },
        axisLine: { show: false },
        axisLabel: { fontSize: 10, color: '#64748b' },
        splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' } },
      },
      series,
    });
    return cleanup;
  }, [withThumb]);

  return (
    <div>
      {withoutCount > 0 && (
        <div
          style={{
            padding: '10px 14px',
            marginBottom: 12,
            backgroundColor: 'rgba(245,158,11,0.08)',
            borderRadius: 10,
            border: '1px solid rgba(245,158,11,0.3)',
            color: '#fbbf24',
            fontSize: 12,
          }}
        >
          ⚠️ 另有 {withoutCount} 条所选实验记录为历史数据、无缩略净值曲线，未计入本图。
        </div>
      )}
      {withThumb.length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: 'center',
            backgroundColor: 'rgba(13,19,34,0.6)',
            borderRadius: 12,
            border: '1px dashed #1e293b',
            color: theme.color.textMuted,
            fontSize: 13,
          }}
        >
          📭 所选实验均无缩略净值曲线（历史记录），暂无可叠加的净值数据。
        </div>
      ) : (
        <div
          ref={chartRef}
          style={{ width: '100%', height: 300, borderRadius: 12, border: '1px solid #1e293b', backgroundColor: '#0d1322', padding: 4 }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 指标对比图（ECharts 分组柱状图，按量纲分面：上=百分比指标，下=夏普）
// ─────────────────────────────────────────────────────────────
const METRIC_DEFS: { key: string; label: string; unit: string }[] = [
  { key: 'totalReturn', label: '总收益', unit: '%' },
  { key: 'annualized', label: '年化', unit: '%' },
  { key: 'maxDrawdownPct', label: '最大回撤', unit: '%' },
  { key: 'sharpe', label: '夏普', unit: '' },
];

/** 百分比类指标（单根 y 轴，单独成上子图） */
const PCT_METRICS = METRIC_DEFS.filter((d) => d.unit === '%');
const SHARPE_DEF = METRIC_DEFS.find((d) => d.key === 'sharpe')!;

function MetricCompareChart({ records }: { records: ExperimentRecord[] }) {
  const pctRef = useRef<HTMLDivElement>(null);
  const sharpeRef = useRef<HTMLDivElement>(null);
  const pctInst = useRef<echarts.ECharts | null>(null);
  const sharpeInst = useRef<echarts.ECharts | null>(null);
  const resizeHandler = useRef<(() => void) | null>(null);

  useEffect(() => {
    const cleanup = () => {
      if (resizeHandler.current) {
        window.removeEventListener('resize', resizeHandler.current);
        resizeHandler.current = null;
      }
      pctInst.current?.dispose();
      pctInst.current = null;
      sharpeInst.current?.dispose();
      sharpeInst.current = null;
    };
    const elPct = pctRef.current;
    const elSharpe = sharpeRef.current;
    if (!elPct || !elSharpe || records.length === 0) {
      cleanup();
      return;
    }
    cleanup();
    const pctChart = echarts.init(elPct);
    pctInst.current = pctChart;
    const sharpeChart = echarts.init(elSharpe);
    sharpeInst.current = sharpeChart;
    const handleResize = () => {
      pctChart.resize();
      sharpeChart.resize();
    };
    resizeHandler.current = handleResize;
    window.addEventListener('resize', handleResize);

    const tooltipBase = {
      backgroundColor: 'rgba(13, 19, 34, 0.92)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      axisPointer: { type: 'shadow' as const },
    };
    const legendBase = {
      top: 0,
      left: 'center',
      textStyle: { color: '#94a3b8', fontSize: 11 },
      itemWidth: 12,
      itemHeight: 12,
    };
    const gridBase = { left: '3%', right: '3%', top: 44, bottom: '6%', containLabel: true };

    // ── 上子图：百分比指标（总收益 / 年化 / 最大回撤） ──
    const pctCategories = PCT_METRICS.map((d) => d.label);
    const pctSeries = records.map((r, i) => ({
      name: `实验${i + 1} · ${r.symbol}`,
      type: 'bar' as const,
      data: PCT_METRICS.map((d) => {
        const v = (r.metrics || {})[d.key];
        // 缺失值必须显示为缺口（null），绝不能当 0
        return typeof v === 'number' ? Number(v.toFixed(2)) : null;
      }),
      itemStyle: { color: COMPARE_COLORS[i], borderRadius: [4, 4, 0, 0] },
      barMaxWidth: 38,
    }));
    pctChart.setOption({
      tooltip: {
        trigger: 'axis',
        ...tooltipBase,
        // 单位按「该立柱所属指标」取（dataIndex 指向 PCT_METRICS），而非实验序号
        formatter: (params: any) => {
          if (!params || !params.length) return '';
          const idx = params[0].dataIndex as number;
          const unit = PCT_METRICS[idx]?.unit ?? '';
          const name = PCT_METRICS[idx]?.label ?? '';
          const lines = params.map((p: any) => {
            const v = p.value;
            const valStr = v == null ? '缺失' : `${v}${unit}`;
            return `${p.marker}${p.seriesName}：${valStr}`;
          });
          return `${name}<br/>${lines.join('<br/>')}`;
        },
      },
      legend: { ...legendBase },
      grid: { ...gridBase },
      xAxis: {
        type: 'category',
        data: pctCategories,
        axisLine: { lineStyle: { color: '#334155' } },
        axisLabel: { fontSize: 11, color: '#94a3b8' },
      },
      yAxis: {
        type: 'value',
        name: '百分比 (%)',
        nameTextStyle: { color: '#64748b', fontSize: 10 },
        axisLine: { show: false },
        // 按量纲真实格式化：y 轴刻度带 % 后缀
        axisLabel: { fontSize: 10, color: '#64748b', formatter: (v: number) => `${v}%` },
        splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' } },
      },
      series: pctSeries,
    });

    // ── 下子图：夏普（无量纲，独立 y 轴） ──
    const hasSharpe = records.some((r) => typeof (r.metrics || {}).sharpe === 'number');
    if (!hasSharpe) {
      // 所选实验全部无夏普数据：显示明确提示，不画空图
      sharpeChart.setOption({
        title: {
          text: '所选实验均无夏普数据',
          left: 'center',
          top: 'center',
          textStyle: { color: '#64748b', fontSize: 14, fontWeight: 400 },
        },
        xAxis: { type: 'category', show: false, data: [SHARPE_DEF.label] },
        yAxis: { type: 'value', show: false },
        series: [{ type: 'bar', data: [] }],
      });
    } else {
      const sharpeSeries = records.map((r, i) => {
        const raw = (r.metrics || {}).sharpe;
        const v = typeof raw === 'number' ? Number(raw.toFixed(2)) : null;
        return {
          name: `实验${i + 1} · ${r.symbol}`,
          type: 'bar' as const,
          data: [v],
          itemStyle: { color: COMPARE_COLORS[i], borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 38,
        };
      });
      sharpeChart.setOption({
        tooltip: {
          trigger: 'axis',
          ...tooltipBase,
          formatter: (params: any) => {
            if (!params || !params.length) return '';
            const lines = params.map((p: any) => {
              const v = p.value;
              const valStr = v == null ? '缺失' : `${v}`;
              return `${p.marker}${p.seriesName}：${valStr}`;
            });
            return `${SHARPE_DEF.label}<br/>${lines.join('<br/>')}`;
          },
        },
        legend: { ...legendBase },
        grid: { ...gridBase },
        xAxis: {
          type: 'category',
          data: [SHARPE_DEF.label],
          axisLine: { lineStyle: { color: '#334155' } },
          axisLabel: { fontSize: 11, color: '#94a3b8' },
        },
        yAxis: {
          type: 'value',
          name: '无量纲',
          nameTextStyle: { color: '#64748b', fontSize: 10 },
          axisLine: { show: false },
          axisLabel: { fontSize: 10, color: '#64748b' },
          splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' } },
        },
        series: sharpeSeries,
      });
    }
    return cleanup;
  }, [records]);

  return (
    <>
      <div
        ref={pctRef}
        style={{ width: '100%', height: 260, borderRadius: 12, border: '1px solid #1e293b', backgroundColor: '#0d1322', padding: 4 }}
      />
      <div
        ref={sharpeRef}
        style={{ width: '100%', height: 260, marginTop: 12, borderRadius: 12, border: '1px solid #1e293b', backgroundColor: '#0d1322', padding: 4 }}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────
const thS: React.CSSProperties = {
  padding: '9px 10px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  borderBottom: '1px solid #1e293b',
};
const tdS: React.CSSProperties = {
  padding: '9px 10px',
  color: '#94a3b8',
  whiteSpace: 'nowrap',
};
