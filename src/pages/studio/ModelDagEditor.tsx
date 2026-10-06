// ─────────────────────────────────────────────────────────────
// ModelDagEditor —— 建模页「DAG 轨」（Phase 2 · 可编辑 DAG）
//
//   🔴 视觉语汇复用 `components/WorkflowDag.tsx`（纯 SVG 手绘、圆角节点、
//      hover title、列间箭头、零图表库），但**不改它**：那是 Agent trace 的
//      只读列泳道视图（只被 AgentTeamPanel 用），数据源与 Model JSON 不同构。
//
//   🔴 本组件**不推演结构**：图与可编辑字段全部来自 shared/modeldag.mjs 的
//      `buildDag`（含 `node.fields` 清单），点击节点后按清单渲染编辑器。
//      组件里只有"怎么显示"，没有"什么能改"——后者是单一源的职责。
//
//   🔴 编辑一律走 `applyEdit`（纯函数 + 内联边界检查），失败**显式报错**，
//      不静默吞掉、不做乐观更新。
//
//   🔴 编辑产物仍是**声明式 Model JSON**，交回页面后复用既有 save/validate
//      路径 —— 本组件不新增任何后端契约。
// ─────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react';
import { theme } from '../../lib/theme';
import { buildDag, applyEdit, PRESET_FACTORS } from '../../../shared/modeldag.mjs';
import type { DagEdit } from '../../../shared/modeldag.mjs';

const MONO = 'var(--zone-mono, Consolas, monospace)';
const LINE = 'var(--zone-line, #222a36)';
const SURFACE2 = 'var(--zone-surface-2, #131822)';

/** 泳道定义（顺序 = 数据流向）；空列自动跳过，不画 */
const COLUMNS = [
  { kind: 'data', title: '① 数据源' },
  { kind: 'factor', title: '② 因子' },
  { kind: 'transform', title: '③ 预处理' },
  { kind: 'filter', title: '④ 过滤' },
  { kind: 'combine', title: '⑤ 组合' },
  { kind: 'backtest', title: '⑥ 回测' },
] as const;

const NODE_W = 148;
const NODE_H = 46;
const GAP_Y = 8;
const COL_GAP = 54;

const KIND_COLOR = {
  data: '#94a3b8',
  factor: '#60a5fa',
  transform: '#a78bfa',
  filter: '#f59e0b',
  combine: '#22d3ee',
  backtest: '#34d399',
} as const;

const BTN: React.CSSProperties = {
  ...theme.input,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
  color: theme.color.textMuted,
  background: SURFACE2,
  borderColor: LINE,
  whiteSpace: 'nowrap',
};
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  ...BTN,
  color: primary ? '#fff' : theme.color.textMuted,
  background: primary ? theme.color.primaryDeep : SURFACE2,
  borderColor: primary ? theme.color.primary : LINE,
  opacity: disabled ? 0.45 : 1,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

export default function ModelDagEditor({
  model,
  onChange,
  disabled,
}: {
  model: unknown;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const graph = useMemo(() => buildDag(model), [model]);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** 所有编辑走单一入口：失败显式报错，成功交回页面 */
  const run = (edit: DagEdit) => {
    if (disabled) return;
    const r = applyEdit(model, edit);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setErr(null);
    onChange(r.model as Record<string, unknown>);
  };

  // ── 布局：按 kind 分列（泳道），列内纵向排布 ──
  const cols = COLUMNS.map((c) => ({ ...c, nodes: graph.nodes.filter((n) => n.kind === c.kind) })).filter(
    (c) => c.nodes.length > 0,
  );
  const maxRows = Math.max(...cols.map((c) => c.nodes.length), 1);
  const height = maxRows * (NODE_H + GAP_Y) + 40;
  const width = Math.max(cols.length * (NODE_W + COL_GAP) + 16, 720);
  const posOf = new Map<string, { x: number; y: number }>();
  cols.forEach((c, ci) => {
    const x = 8 + ci * (NODE_W + COL_GAP);
    const colH = c.nodes.length * (NODE_H + GAP_Y) - GAP_Y;
    c.nodes.forEach((n, ri) => {
      posOf.set(n.id, { x, y: (height - 26 - colH) / 2 + 26 + ri * (NODE_H + GAP_Y) });
    });
  });

  const selNode = graph.nodes.find((n) => n.id === sel) || null;
  // "还能加哪些因子"由单一源给出（不在组件里重算已占用列表）
  const addable = PRESET_FACTORS.filter((e) => !graph.stats.usedExprs.includes(e));

  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* ── 左：图 ── */}
      <div style={{ flex: '1 1 520px', minWidth: 0 }}>
        <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto' }}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            style={{ minWidth: 640, display: 'block' }}
            role="img"
            aria-label="模型 DAG 结构图"
          >
            <defs>
              <marker id="mde-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                <path d="M0,0 L7,3 L0,6 Z" fill="#475569" />
              </marker>
            </defs>
            {cols.map((c, ci) => (
              <text key={'t' + ci} x={8 + ci * (NODE_W + COL_GAP) + NODE_W / 2} y={15} textAnchor="middle" fontSize={11.5} fill="#93c5fd" fontWeight={700}>
                {c.title}
              </text>
            ))}
            {/* 边：起点右缘 → 终点左缘（用实测坐标，不假设等距） */}
            {graph.edges.map((e, i) => {
              const a = posOf.get(e.from);
              const b = posOf.get(e.to);
              if (!a || !b) return null; // 悬空边不画（buildDag 已保证不产生）
              return (
                <line
                  key={i}
                  x1={a.x + NODE_W}
                  y1={a.y + NODE_H / 2}
                  x2={b.x - 4}
                  y2={b.y + NODE_H / 2}
                  stroke="#475569"
                  strokeWidth={1.4}
                  markerEnd="url(#mde-arrow)"
                />
              );
            })}
            {/* 节点 */}
            {cols.flatMap((c) =>
              c.nodes.map((n) => {
                const p = posOf.get(n.id)!;
                const on = sel === n.id;
                const color = KIND_COLOR[n.kind];
                return (
                  <g key={n.id} onClick={() => setSel(on ? null : n.id)} style={{ cursor: 'pointer' }}>
                    <title>{`${n.title}${n.sub ? '：' + n.sub : ''}`}</title>
                    <rect
                      x={p.x}
                      y={p.y}
                      width={NODE_W}
                      height={NODE_H}
                      rx={9}
                      fill={on ? '#16233a' : '#0d1322'}
                      stroke={color}
                      strokeOpacity={on ? 1 : 0.5}
                      strokeWidth={on ? 2 : 1.3}
                    />
                    <text x={p.x + 10} y={p.y + 18} fontSize={11.5} fill="#e2e8f0" fontWeight={700}>
                      {n.title.length > 14 ? n.title.slice(0, 14) + '…' : n.title}
                    </text>
                    <text x={p.x + 10} y={p.y + 35} fontSize={10} fill={color}>
                      {n.sub.length > 18 ? n.sub.slice(0, 18) + '…' : n.sub}
                    </text>
                  </g>
                );
              }),
            )}
          </svg>
        </div>
        <div style={{ fontSize: 11, color: theme.color.textFaint, padding: '4px 2px 0', lineHeight: 1.7 }}>
          点节点可编辑 · 图是 Model JSON 的<b>可视化编辑面</b>，产物仍是声明式 Model JSON
          （无自由连线：规范是固定 schema，拖不出可存储的图）
        </div>
        <div style={{ fontSize: 11, color: theme.color.textFaint, padding: '2px 2px 0' }}>
          {graph.stats.factors} 因子 · {graph.stats.transforms} 预处理 · {graph.stats.filters} 过滤 ·{' '}
          {graph.stats.rebalance} · {graph.stats.groups} 组
          {graph.stats.equalWeight ? ' · 当前等权' : ''}
        </div>
      </div>

      {/* ── 右：编辑区（按节点字段清单渲染，组件不猜字段）── */}
      <div style={{ flex: '0 1 320px', minWidth: 260, background: SURFACE2, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
        {!selNode && <div style={{ fontSize: 11.5, color: theme.color.textFaint, lineHeight: 1.7 }}>← 点左侧任一节点开始编辑</div>}

        {selNode && selNode.kind === 'factor' && selNode.addable && (
          <div>
            <div style={{ fontSize: 12.5, color: theme.color.text, fontWeight: 700, marginBottom: 4 }}>添加因子</div>
            <div style={{ fontSize: 11, color: theme.color.textFaint, marginBottom: 8, lineHeight: 1.6 }}>
              可选项取自规范白名单（<span style={{ fontFamily: MONO }}>{addable.length}</span> 个未使用）；
              上限 <span style={{ fontFamily: MONO }}>{graph.stats.factors}/8</span>
            </div>
            {addable.length === 0 ? (
              <div style={{ fontSize: 11.5, color: theme.color.textFaint }}>所有预置因子都已使用</div>
            ) : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {addable.map((e) => (
                  <button key={e} type="button" style={btn(true, disabled)} disabled={disabled} onClick={() => run({ type: 'addFactor', expr: e })}>
                    + {e}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {selNode && selNode.kind === 'factor' && !selNode.addable && (
          <div>
            <div style={{ fontSize: 12.5, color: theme.color.text, fontWeight: 700, marginBottom: 8 }}>{selNode.title}</div>
            {selNode.fields.map((f, i) => {
              if (f.kind === 'weight') {
                return (
                  <label key={i} style={{ display: 'block', fontSize: 11.5, color: theme.color.textMuted, marginBottom: 8 }}>
                    <div style={{ marginBottom: 3 }}>权重（0 ~ {f.max}）</div>
                    <input
                      type="number"
                      style={{ ...theme.input, width: '100%', fontFamily: MONO }}
                      value={f.value}
                      min={f.min}
                      max={f.max}
                      disabled={disabled}
                      onChange={(e) => run({ type: 'setFactorWeight', id: selNode.id, value: e.target.value })}
                    />
                  </label>
                );
              }
              if (f.kind === 'direction') {
                return (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11.5, color: theme.color.textMuted, marginBottom: 3 }}>方向</div>
                    <div style={{ display: 'flex', gap: 5 }}>
                      {([['auto', '自动'], [1, '正向'], [-1, '反向']] as const).map(([v, label]) => (
                        <button
                          key={String(v)}
                          type="button"
                          style={btn(f.value === v, disabled)}
                          disabled={disabled}
                          onClick={() => run({ type: 'setFactorDirection', id: selNode.id, value: v })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 10.5, color: theme.color.textFaint, marginTop: 3, lineHeight: 1.6 }}>
                      「自动」= 省略 direction 字段，由规范按因子名推导（改名会跟随）
                    </div>
                  </div>
                );
              }
              return null;
            })}
            {selNode.removable && (
              <button type="button" style={{ ...btn(), color: theme.color.up }} disabled={disabled} onClick={() => run({ type: 'removeFactor', id: selNode.id })}>
                删除该因子
              </button>
            )}
          </div>
        )}

        {selNode && (selNode.kind === 'transform' || selNode.kind === 'filter') && (
          <div>
            <div style={{ fontSize: 12.5, color: theme.color.text, fontWeight: 700, marginBottom: 4 }}>{selNode.title}</div>
            <div style={{ fontSize: 11, color: theme.color.textFaint, marginBottom: 8, lineHeight: 1.6 }}>{selNode.sub}</div>
            <button
              type="button"
              style={{ ...btn(), color: theme.color.up }}
              disabled={disabled}
              onClick={() => run({ type: selNode.kind === 'transform' ? 'removeTransform' : 'removeFilter', index: Number(selNode.id.split(':')[1]) })}
            >
              停用（从模型移除）
            </button>
            <div style={{ fontSize: 10.5, color: theme.color.textFaint, marginTop: 6, lineHeight: 1.6 }}>
              停用即从 Model JSON 移除该条；重新添加会用默认参数（不恢复原值）
            </div>
          </div>
        )}

        {selNode && selNode.kind === 'backtest' && (
          <div>
            <div style={{ fontSize: 12.5, color: theme.color.text, fontWeight: 700, marginBottom: 8 }}>回测参数</div>
            {selNode.fields.map((f, i) => {
              if (f.kind === 'select' && f.path.endsWith('rebalance')) {
                return (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11.5, color: theme.color.textMuted, marginBottom: 3 }}>调仓周期</div>
                    <div style={{ display: 'flex', gap: 5 }}>
                      {f.options.map((o) => (
                        <button key={o} type="button" style={btn(f.value === o, disabled)} disabled={disabled} onClick={() => run({ type: 'setBacktest', key: 'rebalance', value: o })}>
                          {o}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }
              if (f.kind === 'number') {
                return (
                  <label key={i} style={{ display: 'block', fontSize: 11.5, color: theme.color.textMuted, marginBottom: 8 }}>
                    <div style={{ marginBottom: 3 }}>{f.unit || '数值'}（{f.min} ~ {f.max}）</div>
                    <input
                      type="number"
                      style={{ ...theme.input, width: '100%', fontFamily: MONO }}
                      value={f.value}
                      min={f.min}
                      max={f.max}
                      disabled={disabled}
                      onChange={(e) => run({ type: 'setBacktest', key: 'groups', value: e.target.value })}
                    />
                  </label>
                );
              }
              if (f.kind === 'select' && f.path.endsWith('fees')) {
                return (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11.5, color: theme.color.textMuted, marginBottom: 3 }}>交易费用</div>
                    <div style={{ display: 'flex', gap: 5 }}>
                      {f.options.map((o) => (
                        <button key={o} type="button" style={btn(f.value === o, disabled)} disabled={disabled} onClick={() => run({ type: 'setBacktest', key: 'fees', value: o })}>
                          {o === 'on' ? '计入' : '不计'}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }
              return null;
            })}
          </div>
        )}

        {(selNode?.kind === 'data' || selNode?.kind === 'combine') && (
          <div>
            <div style={{ fontSize: 12.5, color: theme.color.text, fontWeight: 700, marginBottom: 4 }}>{selNode.title}</div>
            <div style={{ fontSize: 11, color: theme.color.textFaint, lineHeight: 1.7 }}>
              {selNode.kind === 'data'
                ? '股票池由 universe 决定，改动请走表单轨（当前规范仅支持核心池）。'
                : `组合方式固定为 ${selNode.sub}（规范只支持加权求和）。权重在左侧因子节点上调整。`}
            </div>
          </div>
        )}

        {err && (
          <div style={{ marginTop: 10, fontSize: 11.5, color: theme.color.up, lineHeight: 1.6 }}>{err}</div>
        )}
      </div>
    </div>
  );
}
