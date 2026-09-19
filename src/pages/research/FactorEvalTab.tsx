// ─────────────────────────────────────────────────────────────
// 因子稳健性评估页（S3）——回答一个问题：这个因子到底能不能用？
//
//   单看全区间收益会被**路径依赖**放大。本项目实测：
//     rev60 全区间超额 +253.49pp，但逐年 6 正 5 负、平均 -0.82pp。
//   即「全区间漂亮」与「逐年稳定」之间**没有必然关系**。
//   本页把两者并排呈现，并据此给出**可判定**的结论。
//
//   ⚠️ 本页的用途是**否定**不可靠的因子，而不是推荐因子；不构成投资建议。
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import { theme } from '../../lib/theme';
import {
  researchApi,
  type CrossBacktestResult,
  type FactorEvalItem,
  type FactorEvalResult,
  type FactorVerdict,
  type LayerAnalysisResult,
} from '../../api/dataService';

const VERDICT_STYLE: Record<FactorVerdict, { bg: string; fg: string }> = {
  稳健: { bg: 'rgba(56,189,248,0.16)', fg: '#38bdf8' },
  边缘: { bg: 'rgba(245,158,11,0.16)', fg: '#f59e0b' },
  不稳定: { bg: 'rgba(148,163,184,0.16)', fg: '#94a3b8' },
};

/** A 股习惯：正为红、负为绿 */
const numColor = (v?: number) =>
  v === undefined ? theme.color.textFaint : v >= 0 ? theme.color.up : theme.color.down;
const fmtPp = (v?: number) => (v === undefined ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}pp`);

function VerdictBadge({ verdict }: { verdict: FactorVerdict }) {
  const s = VERDICT_STYLE[verdict];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 10px',
        fontSize: 12,
        fontWeight: 700,
        color: s.fg,
        backgroundColor: s.bg,
        border: `1px solid ${s.fg}55`,
        borderRadius: 6,
        whiteSpace: 'nowrap',
      }}
    >
      {verdict}
    </span>
  );
}

function FactorRow({ item }: { item: FactorEvalItem }) {
  // 联合类型收窄：有 error 字段即视为不可用
  const full = 'error' in item.full ? null : item.full;
  const st = item.stability;
  return (
    <tr style={{ borderTop: `1px solid ${theme.color.border}` }}>
      <td style={{ padding: '11px 14px', color: '#f1f5f9', fontWeight: 600 }}>{item.factor}</td>
      <td style={{ padding: '11px 14px', color: numColor(full?.excess), fontWeight: 600 }}>
        {full ? fmtPp(full.excess) : '--'}
      </td>
      <td style={{ padding: '11px 14px', color: theme.color.textMuted }}>
        {full ? `${full.maxDrawdownPct}%` : '--'}
      </td>
      <td style={{ padding: '11px 14px', color: theme.color.text }}>
        {st.posYears} / {st.totalYears}
      </td>
      <td style={{ padding: '11px 14px', color: numColor(st.avgExcess), fontWeight: 600 }}>
        {fmtPp(st.avgExcess)}
      </td>
      <td style={{ padding: '11px 14px', color: theme.color.textMuted }}>{st.stdExcess}pp</td>
      <td style={{ padding: '11px 14px' }}>
        <VerdictBadge verdict={st.verdict} />
      </td>
    </tr>
  );
}

/** 单因子逐年超额条形图：中线为零轴，正向右（红）负向左（绿） */
function YearStrip({ item }: { item: FactorEvalItem }) {
  const rows = item.byYear.filter((y) => Number.isFinite(y.excess));
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((y) => Math.abs(y.excess ?? 0)));
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>{item.factor}</span>
        <VerdictBadge verdict={item.stability.verdict} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {rows.map((y) => {
          const v = y.excess ?? 0;
          return (
            <div key={y.year} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 44, fontSize: 11, color: theme.color.textFaint }}>{y.year}</span>
              <div
                style={{
                  flex: 1,
                  height: 13,
                  position: 'relative',
                  backgroundColor: 'rgba(148,163,184,0.07)',
                  borderRadius: 3,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    width: `${Math.min(50, (Math.abs(v) / max) * 50)}%`,
                    transform: v >= 0 ? 'none' : 'translateX(-100%)',
                    height: '100%',
                    backgroundColor: numColor(v),
                    borderRadius: 3,
                    opacity: 0.75,
                  }}
                />
              </div>
              <span style={{ width: 60, textAlign: 'right', fontSize: 11, color: numColor(v) }}>
                {fmtPp(v)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryBanner({ data }: { data: FactorEvalResult }) {
  const total = data.factors.length;
  const unstable = data.factors.filter((f) => f.stability.verdict === '不稳定').length;
  const allUnstable = total > 0 && unstable === total;
  return (
    <div
      style={{
        ...theme.card,
        borderLeft: `3px solid ${allUnstable ? theme.color.warn : theme.color.accent}`,
        marginBottom: 18,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>
        {allUnstable
          ? `本次评估的 ${total} 个因子全部判定为「不稳定」`
          : `${total} 个因子中，${unstable} 个判定为「不稳定」`}
      </div>
      <div style={{ fontSize: 13, color: theme.color.textMuted, lineHeight: 1.85 }}>
        评估区间 {data.params.yearFrom}–{data.params.yearTo}（逐年）· topN={data.params.topN} · 调仓间隔{' '}
        {data.params.rebalanceEvery} 个交易日。
        <br />
        「不稳定」意味着：该因子的全区间超额
        <strong style={{ color: theme.color.warn }}>无法在逐年尺度上重现</strong>
        ，通常由路径依赖或选美偏差造成，
        <strong style={{ color: '#f1f5f9' }}>不应作为「策略有效」的证据</strong>。
      </div>
    </div>
  );
}

/** 分层柱状图：横向柱，层号固定「1 = 因子值最高」，颜色按收益正负（A股：红正绿负） */
function LayerBarChart({ data, metric }: { data: LayerAnalysisResult; metric: 'annualizedPct' | 'meanPeriodRetPct' }) {
  const rows = data.layers ?? [];
  if (!rows.length) return null;
  // 周期数少时年化会被极端放大（如 1 期年化 = 单期收益 × 252/interval），故展示期均更稳
  const vals = rows.map((r) => r[metric] ?? 0);
  const max = Math.max(0.01, ...vals.map((v) => Math.abs(v)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map((r) => {
        const v = r[metric] ?? 0;
        const w = (Math.abs(v) / max) * 100;
        return (
          <div key={r.layer} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                width: 132,
                fontSize: 11.5,
                color: r.layer === 1 || r.layer === rows.length ? '#cbd5e1' : theme.color.textMuted,
                fontWeight: r.layer === 1 || r.layer === rows.length ? 600 : 400,
                flexShrink: 0,
              }}
            >
              {r.label}
            </span>
            <div
              style={{
                flex: 1,
                height: 16,
                position: 'relative',
                backgroundColor: 'rgba(148,163,184,0.07)',
                borderRadius: 3,
                minWidth: 40,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  width: `${Math.min(50, w / 2)}%`,
                  transform: v >= 0 ? 'none' : 'translateX(-100%)',
                  height: '100%',
                  backgroundColor: numColor(v),
                  borderRadius: 3,
                  opacity: 0.8,
                }}
              />
            </div>
            <span
              style={{
                width: 76,
                textAlign: 'right',
                fontSize: 11.5,
                color: numColor(v),
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {metric === 'meanPeriodRetPct' ? `${v.toFixed(4)}%` : `${v.toFixed(2)}%`}
            </span>
            <span style={{ width: 52, textAlign: 'right', fontSize: 11, color: theme.color.textFaint }}>
              {r.periods} 期
            </span>
            <span
              style={{ width: 74, textAlign: 'right', fontSize: 11, color: theme.color.textFaint, fontVariantNumeric: 'tabular-nums' }}
              title="年化收益——期数少时会放大单期收益，仅供参考"
            >
              年化 {r.annualizedPct.toFixed(1)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 分层回测面板（M2.1 消费端）。
 * 核心判据用 `mono.strategyAligned`（后端已按 mom/rev 分判），**不看 ρ 的裸符号**——
 * 层号语义固定 1=因子值最高，rev* 的正确单调性 ρ 反而是正的。
 */
function LayerPanel({ data, loading, err, onReload }: {
  data: LayerAnalysisResult | null;
  loading: boolean;
  err: string;
  onReload: () => void;
}) {
  if (loading) {
    return (
      <div style={{ ...theme.card, textAlign: 'center', padding: '30px 16px', color: theme.color.textMuted, fontSize: 13 }}>
        正在做分层回测（全池按因子排序等分，逐层等权）…
      </div>
    );
  }
  if (err) {
    return (
      <div style={{ ...theme.card, borderLeft: `3px solid ${theme.color.down}` }}>
        <div style={{ fontWeight: 700, marginBottom: 6, color: theme.color.text }}>分层回测失败</div>
        <div style={{ fontSize: 13, color: theme.color.textMuted }}>{err}</div>
        <button
          onClick={onReload}
          style={{
            marginTop: 12, padding: '7px 16px', fontSize: 13, color: '#0a0e17',
            backgroundColor: theme.color.primary, border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600,
          }}
        >
          重试
        </button>
      </div>
    );
  }
  if (!data) return null;
  if (data.error) {
    return (
      <div style={{ ...theme.card, borderLeft: `3px solid ${theme.color.warn}`, fontSize: 13, color: theme.color.textMuted }}>
        分层回测不可用：{data.error}
      </div>
    );
  }

  const rows = data.layers ?? [];
  const mono = data.mono;
  const aligned = mono?.strategyAligned === true;
  const monoOk = mono?.monotonic === true;
  // 三态判定：单调+一致 / 单调+相反 / **方向不定（null，不可判）** / 非单调。
  // 「方向不定」必须与「相反」分开显示——前者是"算不出方向"，后者是"算出来是反的"，
  // 混为一谈会让用户以为表达式一定有问题。
  const uncertain = mono?.strategyAligned === null;
  const verdictTone = uncertain
    ? { fg: theme.color.textMuted, label: '方向不定（不可判是否与策略一致）' }
    : !monoOk
      ? { fg: theme.color.warn, label: '非单调（有效性可能只在极值端）' }
      : aligned
        ? { fg: theme.color.accent, label: '单调且与策略方向一致' }
        : { fg: theme.color.down, label: '单调但与策略方向相反' };

  return (
    <div style={{ ...theme.card, marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
          分层回测 · {data.factor}
        </span>
        <span
          style={{
            fontSize: 11.5, fontWeight: 700, color: verdictTone.fg,
            padding: '3px 9px', borderRadius: 6,
            backgroundColor: `${verdictTone.fg}22`, border: `1px solid ${verdictTone.fg}55`,
          }}
        >
          {verdictTone.label}
        </span>
        {data.isReversal !== undefined && (
          <span style={{ fontSize: 11, color: theme.color.textFaint }}>
            因子族：{data.isReversal ? '反转（rev*）' : '动量（mom*）'}
          </span>
        )}
      </div>

      <div style={{ fontSize: 12, color: theme.color.textFaint, lineHeight: 1.85, marginBottom: 14 }}>
        把全池（{data.universeSize} 只）按因子值排序等分为 {rows.length} 层，
        每层等权、每 {data.rebalanceEvery} 个交易日再平衡。
        <br />
        Spearman ρ = {mono?.spearman === null || mono?.spearman === undefined ? '不可计算' : mono.spearman.toFixed(4)}
        （阈值 {mono?.threshold}）· 第1层−第{rows.length}层 期均差{' '}
        <strong style={{ color: numColor(mono?.longShortSpreadPct) }}>
          {mono?.longShortSpreadPct === undefined
            ? '--'
            : `${mono.longShortSpreadPct >= 0 ? '+' : ''}${mono.longShortSpreadPct.toFixed(4)}pp`}
        </strong>
        （正负号读法：A股红涨绿跌）。
      </div>

      <LayerBarChart data={data} metric="meanPeriodRetPct" />
      <div style={{ fontSize: 11, color: theme.color.textFaint, marginTop: 6, marginBottom: 14 }}>
        上图为<strong style={{ color: theme.color.textMuted }}>期均收益</strong>（去量纲，跨期数可比）。已省略年化——期数较少时年化会把单期收益放大数倍，易误读。
      </div>

      {mono?.strategyNote && (
        <div
          style={{
            padding: '10px 13px', fontSize: 12, lineHeight: 1.8, borderRadius: 8,
            color: theme.color.textMuted,
            backgroundColor: 'rgba(17,24,39,0.6)',
            border: `1px solid ${verdictTone.fg}44`,
          }}
        >
          <strong style={{ color: verdictTone.fg }}>结论：</strong>
          {mono.strategyNote}。{mono.interpretation}。
          {mono.factorDirection && (
            <>
              <br />
              因子层面的方向（与策略无关）：{mono.factorDirection}。
            </>
          )}
        </div>
      )}

      <div style={{ fontSize: 11, color: theme.color.textFaint, marginTop: 12, lineHeight: 1.8 }}>
        ⚠️ 口径：{data.layerBasis}
        <strong style={{ color: theme.color.warn }}>本图收益与上表「全区间超额」不可直接比较。</strong>
        {data.note}
      </div>
    </div>
  );
}

/** IC 显著性面板（M2.2 消费端） */
function ICPanel({ data }: { data: CrossBacktestResult }) {
  const ic = data.ic;
  if (!ic) return null;
  // degraded = 「不可检验」（如 IC 方差为 0 → t 无定义），与「不显著」是两回事，必须分开说。
  if (ic.degraded) {
    return (
      <div style={{ ...theme.card, borderLeft: `3px solid ${theme.color.warn}`, marginBottom: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9', marginBottom: 6 }}>
          IC 显著性检验 · {data.factor}
        </div>
        <div style={{ fontSize: 13, color: theme.color.textMuted, lineHeight: 1.85 }}>
          <strong style={{ color: theme.color.warn }}>不可检验</strong>（≠ 不显著）：
          {ic.degradeReason ?? '样本不足以估计波动与显著性'}。
          <br />
          已记录 IC 期数 {ic.n} 期，IC 均值{' '}
          {ic.icMean === null || ic.icMean === undefined ? '--' : ic.icMean.toFixed(6)}。
        </div>
      </div>
    );
  }

  const sig = ic.significant2;
  const tone = sig ? (ic.icMean !== null && ic.icMean !== undefined && ic.icMean >= 0 ? theme.color.up : theme.color.down) : theme.color.textMuted;
  const tStr = ic.t !== null && ic.t !== undefined ? ic.t.toFixed(4) : '--';
  const pStr = ic.p !== null && ic.p !== undefined ? (ic.p < 1e-6 ? '<1e-6' : ic.p.toFixed(6)) : '--';

  return (
    <div style={{ ...theme.card, marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
          IC 显著性检验 · {data.factor}
        </span>
        <span
          style={{
            fontSize: 11.5, fontWeight: 700, color: tone,
            padding: '3px 9px', borderRadius: 6,
            backgroundColor: `${tone}22`, border: `1px solid ${tone}55`,
          }}
        >
          {sig ? '5% 水平显著' : '不显著'}
        </span>
        <span style={{ fontSize: 11, color: theme.color.textFaint }}>
          Rank IC（Spearman）· {ic.n} 期
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 10, marginBottom: 12 }}>
        {[
          { k: 'IC 均值', v: ic.icMean === null || ic.icMean === undefined ? '--' : ic.icMean.toFixed(6), c: numColor(ic.icMean ?? undefined) },
          { k: 'IC 标准差', v: ic.icStd === null || ic.icStd === undefined ? '--' : ic.icStd.toFixed(6), c: theme.color.text },
          { k: 'ICIR', v: ic.icir === null || ic.icir === undefined ? '--' : ic.icir.toFixed(4), c: numColor(ic.icir ?? undefined) },
          { k: 'IC > 0 占比', v: ic.icPositiveRate === null || ic.icPositiveRate === undefined ? '--' : `${(ic.icPositiveRate * 100).toFixed(1)}%`, c: theme.color.text },
          { k: 't 统计量', v: tStr, c: tone },
          { k: 'p 值', v: pStr, c: tone },
        ].map((it) => (
          <div
            key={it.k}
            style={{
              padding: '9px 11px', borderRadius: 8,
              backgroundColor: 'rgba(15,22,36,0.7)', border: `1px solid ${theme.color.border}`,
            }}
          >
            <div style={{ fontSize: 10.5, color: theme.color.textFaint, marginBottom: 4 }}>{it.k}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: it.c, fontVariantNumeric: 'tabular-nums' }}>{it.v}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11.5, color: theme.color.textFaint, lineHeight: 1.85 }}>
        Newey-West 稳健标准误 <strong style={{ color: theme.color.textMuted }}>{ic.se?.toFixed(6) ?? '--'}</strong>
        （滞后 {ic.neweyWestLag} 阶）vs 独立同分布假设 <strong style={{ color: theme.color.textMuted }}>{ic.seIid?.toFixed(6) ?? '--'}</strong>。
        {ic.se !== null && ic.se !== undefined && ic.seIid !== null && ic.seIid !== undefined && (
          <>
            {' '}两者差异即
            <strong style={{ color: theme.color.textMuted }}>
              {((ic.se / ic.seIid - 1) * 100).toFixed(1)}%
            </strong>
            ——IC 序列存在自相关，独立同分布假设会低估或高估显著性。
          </>
        )}
        <br />
        {ic.basis}
      </div>
    </div>
  );
}

export default function FactorEvalTab() {
  const [data, setData] = useState<FactorEvalResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // ── M2：分层回测 + IC 显著性（独立加载，互不阻塞主表的逐年评估）──
  // 分层用与主表一致的 topN 语境（rebalanceEvery=20）；factor 固定 mom20 作为示范口径，
  // 与 crossBacktest 的默认因子保持一致，便于三处结论交叉印证。
  const [layerData, setLayerData] = useState<LayerAnalysisResult | null>(null);
  const [layerLoading, setLayerLoading] = useState(true);
  const [layerErr, setLayerErr] = useState('');
  const [icData, setIcData] = useState<CrossBacktestResult | null>(null);

  const loadLayers = async () => {
    setLayerLoading(true);
    setLayerErr('');
    try {
      setLayerData(await researchApi.factorLayers({ factor: 'mom20', layers: 5, rebalanceEvery: 20 }));
    } catch (e: unknown) {
      setLayerErr(e instanceof Error ? e.message : '分层回测失败');
    } finally {
      setLayerLoading(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      setData(await researchApi.factorEval({ topN: 20, rebalanceEvery: 20 }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '因子评估失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void loadLayers();
    // IC 数据随净值回测一并取回（同一请求已含 ic 块，无需单独接口）
    researchApi
      .crossBacktest({ factor: 'mom20', topN: 20, rebalanceEvery: 20, capital: 100000 })
      .then(setIcData)
      .catch(() => setIcData(null)); // IC 属增强信息，失败静默降级为不显示，不影响主表
  }, []);

  return (
    <>
      <div>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: '#f1f5f9', margin: '0 0 10px' }}>
          因子稳健性评估
        </h2>
        <p style={{ fontSize: 13, color: theme.color.textMuted, margin: '0 0 8px', lineHeight: 1.85 }}>
          单看全区间收益会被<strong style={{ color: theme.color.warn }}>路径依赖</strong>
          放大：一个因子可以在全区间跑出高额超额，却在逐年尺度上毫无 alpha。
          本页对每个因子同时给出「全区间」与「逐年」两组结果，并据此判定稳健性。
        </p>
        <p style={{ fontSize: 12, color: theme.color.textFaint, margin: '0 0 22px', lineHeight: 1.85 }}>
          判定规则（量化）：正超额年份占比 ≥ 70% 且平均超额为正 → 稳健；≥ 50% 且为正 → 边缘；其余 → 不稳定。
          <strong style={{ color: theme.color.textMuted }}>两项为「与」关系</strong>
          ——占比再高，只要平均超额 ≤ 0 即判不稳定。
        </p>

        {loading && (
          <div style={{ ...theme.card, textAlign: 'center', padding: '48px 16px', color: theme.color.textMuted }}>
            <div style={{ fontSize: 14, marginBottom: 8 }}>正在评估（逐年多区间回测，约需 8 秒）…</div>
            <div style={{ fontSize: 12, color: theme.color.textFaint }}>
              计算量 = 因子数 ×（1 个全区间 + 若干年度区间）
            </div>
          </div>
        )}

        {err && !loading && (
          <div style={{ ...theme.card, borderLeft: `3px solid ${theme.color.down}`, color: theme.color.text }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>评估失败</div>
            <div style={{ fontSize: 13, color: theme.color.textMuted }}>{err}</div>
            <button
              onClick={() => void load()}
              style={{
                marginTop: 12,
                padding: '7px 16px',
                fontSize: 13,
                color: '#0a0e17',
                backgroundColor: theme.color.primary,
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              重试
            </button>
          </div>
        )}

        {data && !loading && (
          <>
            <SummaryBanner data={data} />

            {icData && <ICPanel data={icData} />}

            <LayerPanel data={layerData} loading={layerLoading} err={layerErr} onReload={() => void loadLayers()} />

            {data.invalidFactors.length > 0 && (
              <div style={{ fontSize: 12, color: theme.color.warn, marginBottom: 14 }}>
                已忽略无效因子：{data.invalidFactors.join('、')}（可用：{data.availableFactors.join('、')}）
              </div>
            )}

            <div style={{ ...theme.card, padding: 0, overflow: 'hidden', marginBottom: 22 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ backgroundColor: 'rgba(30,41,59,0.5)' }}>
                    {['因子', '全区间超额', '最大回撤', '逐年正超额', '平均超额', '超额波动', '判定'].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: 'left',
                          padding: '11px 14px',
                          color: theme.color.textMuted,
                          fontWeight: 500,
                          fontSize: 12,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.factors.map((f) => (
                    <FactorRow key={f.factor} item={f} />
                  ))}
                </tbody>
              </table>
            </div>

            <h2 style={{ fontSize: 17, fontWeight: 600, color: '#f1f5f9', margin: '0 0 6px' }}>
              逐年超额分布
            </h2>
            <p style={{ fontSize: 12, color: theme.color.textFaint, margin: '0 0 16px' }}>
              中线为零轴：向右（红）为正超额、向左（绿）为负超额。逐年分布若时正时负，即为「不稳定」的直接证据。
            </p>
            <div style={{ ...theme.card }}>
              {data.factors.map((f) => (
                <YearStrip key={f.factor} item={f} />
              ))}
            </div>

            <div
              style={{
                marginTop: 22,
                padding: '14px 16px',
                fontSize: 12,
                lineHeight: 1.85,
                color: theme.color.textFaint,
                backgroundColor: 'rgba(17,24,39,0.5)',
                border: `1px solid ${theme.color.border}`,
                borderRadius: 10,
              }}
            >
              <strong style={{ color: theme.color.textMuted }}>免责声明：</strong>
              {data.disclaimer}
              <br />
              评估基于本地归档的不复权价 + 复权因子（前复权、归一化到区间首日），
              成交与估值同口径，涨跌停按不复权真实价判定；
              未处理退市股，可能存在幸存者偏差。
            </div>
          </>
        )}
      </div>
    </>
  );
}
