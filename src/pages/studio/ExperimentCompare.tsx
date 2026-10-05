// ─────────────────────────────────────────────────────────────
// ExperimentCompare —— 实验留痕与对比（Phase 1 第六刀 · 中栏「实验轨」）
//
//   三条设计约束（都是被踩过之后定下的）：
//     1. 勾选/上限逻辑**不在本组件里实现** —— 直接复用 shared/experiments.cjs
//        的 nextSelection/diffParams/paramKeyUnion（纯函数、有 node:test 锁）。
//        前端再写一份 = 必然与后端/测试分叉。
//     2. 比较键用 `id`（稳定），而 shared 的 recKey 取 `e.ts` —— 故用 `{ ts: row.id }`
//        适配后传入。⚠️ 不是为了绕过类型，而是因为 id 才是服务端主键（compare 接口收 ids）。
//     3. 记录是**不可变**的：本组件只读 + 删除，不提供"编辑实验"。
//        「载入模型」走的是快照（modelSnapshot），载入后是新草稿，不修改原记录。
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react';
import {
  modelsApi,
  type ModelExperimentDoc,
  type ModelExperimentRow,
  type ModelSpec,
} from '../../api';
import { theme } from '../../lib/theme';
import { MAX_COMPARE, diffParams, nextSelection } from '../../../shared/experiments.mjs';

const MONO = 'var(--zone-mono, Consolas, monospace)';
const SURFACE2 = 'var(--zone-surface-2, #131822)';
const LINE = 'var(--zone-line, #222a36)';

const fmtPct = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)}%` : '—';
const fmtNum = (v: number | null | undefined, d = 2) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
/** 涨红跌绿（国内惯例） */
const pctColor = (v: number | null | undefined) =>
  typeof v !== 'number' || !Number.isFinite(v) ? theme.color.textMuted : v >= 0 ? theme.color.up : theme.color.down;

/** 迷你净值曲线（降采样点 {d,v}；纯 SVG，无图表库） */
function Spark({ points, color }: { points?: { d: string; v: number }[]; color: string }) {
  if (!points || points.length < 2) return null;
  const vals = points.map((p) => p.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 100;
  const H = 24;
  const step = W / (points.length - 1);
  const pts = points.map((p, i) => `${(i * step).toFixed(2)},${(H - ((p.v - min) / span) * H).toFixed(2)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="净值曲线缩略">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}

const th: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 11.5,
  color: theme.color.textFaint,
  borderBottom: `1px solid ${LINE}`,
  textAlign: 'left',
  whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 12,
  color: theme.color.text,
  borderBottom: `1px solid ${LINE}`,
  fontFamily: MONO,
  whiteSpace: 'nowrap',
};

export default function ExperimentCompare({
  refreshToken,
  onLoadModel,
  onSelectionChange,
}: {
  refreshToken: number;
  onLoadModel: (model: ModelSpec) => void;
  /**
   * 上报当前**已取回完整记录**的实验（取消对比则上报空数组）。
   * 用途：研究包要把选中的实验记录一并带走（此前它们只活在本组件的局部状态里）。
   */
  onSelectionChange?: (docs: ModelExperimentDoc[]) => void;
}) {
  const [rows, setRows] = useState<ModelExperimentRow[]>([]);
  const [quota, setQuota] = useState({ count: 0, quota: 0 });
  /** 对比上限：以服务端下发的为准（其单一源同样是 shared/experiments.cjs） */
  const [maxCompare, setMaxCompare] = useState(MAX_COMPARE);
  const [selected, setSelected] = useState<string[]>([]);
  const [docs, setDocs] = useState<ModelExperimentDoc[] | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await modelsApi.experiments.list(200);
      setRows(r.items || []);
      setQuota({ count: r.count ?? 0, quota: r.quota ?? 0 });
      if (typeof r.maxCompare === 'number' && r.maxCompare > 0) setMaxCompare(r.maxCompare);
      // 已选中的记录若已被删除，从选择集中剔除（避免拿死 id 去 compare）
      setSelected((prev) => prev.filter((id) => (r.items || []).some((x) => x.id === id)));
    } catch (e) {
      setMsg({ kind: 'err', text: `实验列表读取失败：${(e as Error).message}` });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  const toggle = (row: ModelExperimentRow) => {
    // 用 id 作为比较键（服务端主键）——shared 的 recKey 取 ts，故以 { ts: id } 适配
    const { next, warn } = nextSelection(selected, { ts: row.id });
    setSelected(next);
    setMsg(warn ? { kind: 'warn', text: warn } : null);
  };

  const doCompare = async () => {
    if (selected.length < 2) {
      setMsg({ kind: 'warn', text: '至少勾选 2 条实验才能对比' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await modelsApi.experiments.compare(selected);
      setDocs(r.items || []);
      onSelectionChange?.(r.items || []);
      if ((r.items || []).length < r.requested) {
        setMsg({
          kind: 'warn',
          text: `请求 ${r.requested} 条，只取回 ${(r.items || []).length} 条（可能已被删除或不属于本人）`,
        });
      }
    } catch (e) {
      setMsg({ kind: 'err', text: `对比失败：${(e as Error).message}` });
      setDocs(null);
      onSelectionChange?.([]);
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async (id: string) => {
    setBusy(true);
    try {
      const r = await modelsApi.experiments.remove(id);
      if (!r.ok || !r.removed) setMsg({ kind: 'err', text: r.error || '删除失败' });
      else {
        setMsg({ kind: 'ok', text: '已删除该实验记录' });
        setDocs(null);
        await reload();
      }
    } catch (e) {
      setMsg({ kind: 'err', text: `删除失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const loadModel = async (id: string, name: string) => {
    setBusy(true);
    try {
      const r = await modelsApi.experiments.get(id);
      const snap = r.experiment?.modelSnapshot;
      if (!snap) {
        setMsg({ kind: 'err', text: '该记录没有模型快照（历史数据），无法载入' });
        return;
      }
      onLoadModel(snap);
      setMsg({ kind: 'ok', text: `已载入「${name}」当时的模型定义（当前实验记录未被修改）` });
    } catch (e) {
      setMsg({ kind: 'err', text: `载入失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const btn = (disabled = false): React.CSSProperties => ({
    ...theme.input,
    padding: '4px 9px',
    fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer',
    color: theme.color.textMuted,
    background: SURFACE2,
    borderColor: LINE,
    opacity: disabled ? 0.45 : 1,
  });

  const diff = docs && docs.length >= 2 ? diffParams(docs) : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: theme.color.textFaint, lineHeight: 1.7 }}>
          每次回测自动留痕（不可变）。勾选 2~{maxCompare} 条做对比；
          <span style={{ color: theme.color.textMuted }}> {quota.count}/{quota.quota}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: selected.length ? theme.color.accent : theme.color.textFaint, fontFamily: MONO }}>
            已选 {selected.length}
          </span>
          <button type="button" style={btn(busy || selected.length < 2)} disabled={busy || selected.length < 2} onClick={() => void doCompare()}>
            {busy ? '处理中…' : '对比'}
          </button>
          <button type="button" style={btn(busy || !selected.length)} disabled={busy || !selected.length} onClick={() => { setSelected([]); setDocs(null); setMsg(null); }}>
            清空
          </button>
        </div>
      </div>

      {msg && (
        <div
          style={{
            marginBottom: 8,
            fontSize: 12,
            color: msg.kind === 'err' ? theme.color.up : msg.kind === 'ok' ? theme.color.down : theme.color.warn,
          }}
        >
          {msg.text}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: theme.color.textMuted, lineHeight: 1.75 }}>
          暂无实验记录。跑一次回测就会自动留痕（本地版可用；公网不执行回测，故公网此处为空 —— 可导出模型到本地跑）。
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 34 }} />
                <th style={th}>时间</th>
                <th style={th}>模型</th>
                <th style={{ ...th, textAlign: 'right' }}>总收益</th>
                <th style={{ ...th, textAlign: 'right' }}>超额</th>
                <th style={{ ...th, textAlign: 'right' }}>回撤</th>
                <th style={{ ...th, textAlign: 'right' }}>夏普</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const on = selected.includes(r.id);
                return (
                  <tr key={r.id} style={{ background: on ? 'rgba(34,211,238,.07)' : 'transparent' }}>
                    <td style={td}>
                      <input type="checkbox" checked={on} onChange={() => toggle(r)} aria-label={`选择实验 ${r.modelName}`} />
                    </td>
                    <td style={{ ...td, fontFamily: MONO, color: theme.color.textMuted }}>{String(r.ts).slice(5, 16).replace('T', ' ')}</td>
                    <td style={{ ...td, fontFamily: 'inherit' }}>{r.modelName || '(未命名)'}</td>
                    <td style={{ ...td, textAlign: 'right', color: pctColor(r.totalReturn) }}>{fmtPct(r.totalReturn)}</td>
                    <td style={{ ...td, textAlign: 'right', color: pctColor(r.excessReturn) }}>{fmtPct(r.excessReturn)}</td>
                    <td style={{ ...td, textAlign: 'right', color: theme.color.warn }}>{fmtPct(r.maxDrawdownPct)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtNum(r.sharpe)}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <button type="button" style={btn(busy)} disabled={busy} onClick={() => void loadModel(r.id, r.modelName)}>载入模型</button>
                        <button type="button" style={btn(busy)} disabled={busy} onClick={() => void doRemove(r.id)}>删除</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {docs && docs.length >= 2 && diff && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: theme.color.text, marginBottom: 8 }}>
            对比结果（{docs.length} 条 · 最多 {maxCompare} 条）
          </div>

          {/* 指标对比 */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>指标</th>
                  {docs.map((d) => (
                    <th key={d.id} style={{ ...th, textAlign: 'right' }}>
                      {d.modelName || '(未命名)'}
                      <div style={{ fontSize: 10.5, color: theme.color.textFaint, fontFamily: MONO, fontWeight: 400 }}>
                        {String(d.ts).slice(5, 16).replace('T', ' ')}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([
                  ['总收益', (d) => fmtPct(d.metrics.totalReturn), (d) => pctColor(d.metrics.totalReturn)],
                  ['年化', (d) => fmtPct(d.metrics.annualized), (d) => pctColor(d.metrics.annualized)],
                  ['等权基准', (d) => fmtPct(d.metrics.benchmarkReturn), (d) => pctColor(d.metrics.benchmarkReturn)],
                  ['超额收益', (d) => fmtPct(d.metrics.excessReturn), (d) => pctColor(d.metrics.excessReturn)],
                  ['最大回撤', (d) => fmtPct(d.metrics.maxDrawdownPct), () => theme.color.warn],
                  ['夏普', (d) => fmtNum(d.metrics.sharpe), () => theme.color.text],
                  ['IC 均值', (d) => fmtNum(d.metrics.icMean, 4), () => theme.color.text],
                  ['ICIR', (d) => fmtNum(d.metrics.icir, 3), () => theme.color.text],
                  ['调仓 / 成交', (d) => `${fmtNum(d.metrics.rebalances, 0)} / ${fmtNum(d.metrics.fills, 0)}`, () => theme.color.text],
                  ['手续费', (d) => fmtNum(d.metrics.totalFees, 0), () => theme.color.text],
                  ['区间', (d) => (d.range ? `${d.range.start}~${d.range.end}` : '—'), () => theme.color.textMuted],
                  ['股票池', (d) => fmtNum(d.universeSize, 0), () => theme.color.textMuted],
                ] as [string, (d: ModelExperimentDoc) => string, (d: ModelExperimentDoc) => string][]).map(([label, fmt, colorOf]) => (
                  <tr key={label}>
                    <td style={{ ...td, fontFamily: 'inherit', color: theme.color.textMuted }}>{label}</td>
                    {docs.map((d) => (
                      <td key={d.id} style={{ ...td, textAlign: 'right', color: colorOf(d) }}>{fmt(d)}</td>
                    ))}
                  </tr>
                ))}
                {/* 净值曲线（降采样缩略） */}
                <tr>
                  <td style={{ ...td, fontFamily: 'inherit', color: theme.color.textMuted }}>净值</td>
                  {docs.map((d) => (
                    <td key={d.id} style={{ ...td, padding: '4px 8px' }}>
                      <Spark points={d.equityThumb} color={pctColor(d.metrics.totalReturn)} />
                    </td>
                  ))}
                </tr>
                {/* 身份：指纹/哈希不同 ⇒ 本来就该不同结果，不能当"同一实验"看 */}
                <tr>
                  <td style={{ ...td, fontFamily: 'inherit', color: theme.color.textMuted }}>模型哈希</td>
                  {docs.map((d) => (
                    <td key={d.id} style={{ ...td, fontSize: 11, color: theme.color.textFaint }}>
                      {d.modelHash ? `${d.modelHash.slice(0, 12)}…` : '—'}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td style={{ ...td, fontFamily: 'inherit', color: theme.color.textMuted }}>实验指纹</td>
                  {docs.map((d) => (
                    <td key={d.id} style={{ ...td, fontSize: 11, color: theme.color.textFaint }}>
                      {d.fingerprint ? `${d.fingerprint.slice(0, 12)}…` : '—'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {/* 参数差异：只列"取值不同"的键 */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12.5, color: theme.color.textMuted, marginBottom: 6 }}>
              参数差异（只列取值不同的项 · 判据来自 shared/experiments.cjs）
            </div>
            {diff.differing.length === 0 ? (
              <div style={{ fontSize: 12, color: theme.color.textFaint }}>
                全部参数一致 —— 差异只来自数据窗口/参数以外的因素（同参数应给同结果，否则需查数据变动）。
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {diff.differing.map((k) => (
                      <tr key={k}>
                        <td style={{ ...td, fontFamily: 'inherit', color: theme.color.accent, width: 110 }}>{k}</td>
                        {docs.map((d) => (
                          <td key={d.id} style={{ ...td, fontSize: 11.5 }}>
                            {d.params?.[k] === undefined ? '—' : String(d.params[k])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {diff.identical.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', fontSize: 11.5, color: theme.color.textFaint }}>
                  一致的参数（{diff.identical.length} 项）
                </summary>
                <div style={{ marginTop: 6, fontSize: 11.5, color: theme.color.textFaint, fontFamily: MONO, lineHeight: 1.8 }}>
                  {diff.identical.map((x) => `${x.key} = ${JSON.stringify(x.value)}`).join(' · ')}
                </div>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
