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
import { researchApi, type FactorEvalItem, type FactorEvalResult, type FactorVerdict } from '../../api/dataService';

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

export default function FactorEvalTab() {
  const [data, setData] = useState<FactorEvalResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

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
