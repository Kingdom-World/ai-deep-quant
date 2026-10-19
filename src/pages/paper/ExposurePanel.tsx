// ─────────────────────────────────────────────────────────────
// 组合因子暴露面板（P4 · PortfolioPilot 的前端出口）
//
// 设计取舍：
//   · **按需加载**（点击才请求），不进 10s 轮询 —— 每次要取持仓 + 20 只基准的 K 线，
//     塞进轮询既拖慢页面也浪费算力。
//   · 独立组件而非塞进 PaperTradingPage：主页面已 700+ 行。
//   · 口径与 get_factor_exposure 工具同源（都走 server/paper/exposure.cjs），
//     避免"AI 说一套、页面显示另一套"。
//
// 🔴 展示纪律：
//   · 因子值是**小数**⇒ 展示乘 100
//   · 相对暴露用 **pp（百分点）**，不是 %
//   · 覆盖率 < 100% 时必须显式提示（否则用户会把"部分标的算不出"当成全量结论）
//   · 复权降级必须显式
// ─────────────────────────────────────────────────────────────
import { useCallback, useState } from 'react';
import { paperApi, type PaperExposure } from '../../api/paper';

const CARD: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: '12px',
  padding: '16px',
};

const pct = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—';

/** 相对暴露：两个百分数之差 ⇒ 用百分点 pp，避免与"比值"混淆 */
const pp = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp`;

export default function ExposurePanel() {
  const [data, setData] = useState<PaperExposure | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await paperApi.getExposure();
      if (!r.ok) {
        setErr(r.error || '暴露计算失败');
        setData(null);
      } else {
        setData(r);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '请求失败');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const benchOf = (factor: string) =>
    data?.benchmark?.ok ? data.benchmark.factors.find((b) => b.factor === factor && b.ok) : undefined;

  return (
    <div style={CARD}>
      <div style={{ fontWeight: 700, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: 8 }}>
        🎯 因子暴露
        <button
          type="button"
          onClick={load}
          disabled={loading}
          style={{
            marginLeft: 'auto', padding: '5px 12px', borderRadius: '8px', cursor: loading ? 'wait' : 'pointer',
            background: loading ? '#334155' : '#1d4ed8', color: '#fff', border: 'none',
            fontSize: '12px', fontWeight: 600,
          }}
        >
          {loading ? '计算中…' : data ? '重新计算' : '计算暴露'}
        </button>
      </div>
      <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '10px' }}>
        按持仓市值加权各标的的因子值。需要取行情，故不随页面自动刷新。
      </div>

      {err && <div style={{ fontSize: '13px', color: '#f87171' }}>{err}</div>}

      {!data && !err && !loading && (
        <div style={{ fontSize: '13px', color: '#64748b' }}>点击「计算暴露」查看组合在动量/反转等因子上的暴露。</div>
      )}

      {data && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ color: '#64748b', fontSize: '12px' }}>
                <th style={{ textAlign: 'left', padding: '6px 4px' }}>因子</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>组合暴露</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>基准（中位数）</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>相对</th>
                <th style={{ textAlign: 'right', padding: '6px 4px' }}>覆盖</th>
              </tr>
            </thead>
            <tbody>
              {data.factors.map((f) => {
                const b = benchOf(f.factor);
                const rel = b && f.exposure !== null ? f.exposure - b.median : null;
                return (
                  <tr key={f.factor} style={{ borderTop: '1px solid #1e293b' }}>
                    <td style={{ padding: '7px 4px', color: '#e2e8f0', fontWeight: 600 }}>{f.factor}</td>
                    <td style={{ textAlign: 'right', padding: '7px 4px', color: f.ok ? (f.exposure! >= 0 ? '#f87171' : '#4ade80') : '#64748b' }}>
                      {f.ok ? pct(f.exposure) : '—'}
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 4px', color: '#94a3b8' }}>
                      {b ? `${pct(b.median)}（n=${b.count}）` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 4px', color: rel === null ? '#64748b' : rel >= 0 ? '#f87171' : '#4ade80' }}>
                      {rel === null ? '—' : pp(rel)}
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 4px', color: f.coverage >= 0.9999 ? '#64748b' : '#fbbf24' }}>
                      {f.coverage >= 0.9999 ? '全覆盖' : `${(f.coverage * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 覆盖率不足：必须解释"为什么"与"谁被剔除" */}
          {data.factors.some((f) => f.ok && f.failed > 0) && (
            <div style={{ marginTop: '10px', fontSize: '12px', color: '#fbbf24', lineHeight: 1.7 }}>
              部分标的的因子值算不出，已**从加权中剔除**（不按 0 计，否则暴露会被稀释）：
              {data.factors
                .filter((f) => f.ok && f.failed > 0)
                .map((f) => (
                  <div key={f.factor}>
                    · {f.factor}：{f.contributions.filter((c) => c.value === null).map((c) => `${c.symbol}（${c.skip || '未知原因'}）`).join('；')}
                  </div>
                ))}
            </div>
          )}

          {data.adjFallbackSymbols && data.adjFallbackSymbols.length > 0 && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: '#fbbf24' }}>
              ⚠️ 价格口径降级：{data.adjFallbackSymbols.join('、')} 未取到复权因子、用原始收盘价计算。
            </div>
          )}

          {data.benchmark && !data.benchmark.ok && (
            <div style={{ marginTop: '8px', fontSize: '12px', color: '#64748b' }}>
              基准不可用（{data.benchmark.error || '未知原因'}）—— 上表「相对」列为空。
            </div>
          )}

          <div style={{ marginTop: '10px', fontSize: '11px', color: '#475569', lineHeight: 1.7 }}>
            口径：因子值为小数（0.1439 = 14.39%）；相对暴露用百分点 pp；rev 类在引擎内已取负（= −mom）；
            基准为全市场等距抽样 20 只的中位数。以上为事实陈述，不构成调仓建议。
          </div>
        </>
      )}
    </div>
  );
}
