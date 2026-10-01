// ─────────────────────────────────────────────────────────────
// WorkflowDag —— Factor Forge FF1：Agent 团队流水线 DAG 可视化（只读总览）
//
//   数据源：/api/agents/analyze 的 trace（stages + final + degraded），零新增后端契约。
//   布局：横向泳道——每一列是一个阶段（collect/debate/trade/risk/final），
//         列内节点纵向排布；列间隐式数据流（按列顺序连线）。
//   着色口径（国内惯例）：BUY/偏多=红、SELL/偏空=绿、中性/观望=蓝灰；
//         节点右上角小圆点标记产出引擎：琥珀=规则引擎、蓝=LLM（trace.degraded.seats）。
//   交互：hover 原生 <title> 显示该角色完整结论第一句；详情仍看下方逐阶段文本卡。
//   纯 SVG 无依赖，不引入图表库——节点数 ≤8，手绘布局即可控且零体积成本。
// ─────────────────────────────────────────────────────────────
import { useMemo } from 'react';

type DagNode = {
  label: string;
  sub: string;
  /** 节点主色（verdict 语义色或中性） */
  color: string;
  /** 产出引擎：'rule' | 'llm' | undefined（不显示徽标） */
  engine?: 'rule' | 'llm';
  /** hover 全文 */
  tip?: string;
};
type DagColumn = { title: string; nodes: DagNode[] };

const VERDICT_COLOR: Record<string, string> = { BUY: '#ef4444', SELL: '#22c55e', HOLD: '#60a5fa', 观望: '#60a5fa', 偏多: '#ef4444', 偏空: '#22c55e' };
const NEUTRAL = '#94a3b8';
const RULE_DOT = '#f59e0b';
const LLM_DOT = '#3b82f6';

const firstLine = (s: unknown, n = 26): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** 从 stages 抽取每列节点；列的存在与否由 mode 自然决定（stages 里没有的就不画） */
function buildColumns(stages: any, final: any, ruleSeats: Set<string>): DagColumn[] {
  const cols: DagColumn[] = [];
  const engineOf = (name: string): 'rule' | 'llm' | undefined =>
    ruleSeats.size === 0 ? undefined : ruleSeats.has(String(name || '').split(' ')[0]) || ruleSeats.has(String(name || '')) ? 'rule' : 'llm';

  if (stages.collect) {
    cols.push({
      title: '① 数据收集',
      nodes: [
        ...(stages.collect.agents ?? []).map((a: any) => ({
          label: firstLine(a.name, 14),
          sub: firstLine(a.view ?? a.summary ?? a.opinion ?? '', 24),
          color: NEUTRAL,
          engine: engineOf(a.name),
          tip: a.view ?? a.summary ?? a.opinion ?? '',
        })),
      ],
    });
  }
  if (stages.debate) {
    const nodes: DagNode[] = [];
    if (stages.debate.bull) nodes.push({ label: firstLine(stages.debate.bull.name, 14), sub: `论点 ${stages.debate.bull.arguments?.length ?? 0} 条`, color: '#ef4444' });
    if (stages.debate.bear) nodes.push({ label: firstLine(stages.debate.bear.name, 14), sub: `论点 ${stages.debate.bear.arguments?.length ?? 0} 条`, color: '#22c55e' });
    if (stages.debate.chief) nodes.push({ label: firstLine(stages.debate.chief.name, 14), sub: `${stages.debate.chief.verdict} · ${firstLine(stages.debate.chief.reason, 16)}`, color: VERDICT_COLOR[stages.debate.chief.verdict] ?? NEUTRAL });
    cols.push({ title: '② 多空辩论', nodes });
  }
  if (stages.trade) {
    cols.push({
      title: '③ 交易决策',
      nodes: [{
        label: firstLine(stages.trade.name, 14),
        sub: stages.trade.approved ? `入场 ${stages.trade.entry} · 1:${stages.trade.rr}` : firstLine(stages.trade.note, 22),
        color: stages.trade.approved ? '#4ade80' : '#facc15',
      }],
    });
  }
  if (stages.risk?.chief) {
    cols.push({
      title: '④ 风险评估',
      nodes: [
        ...[stages.risk.aggressive, stages.risk.conservative, stages.risk.neutral].filter(Boolean).map((r: any) => ({
          label: firstLine(r.name, 14),
          sub: firstLine(r.stance ?? '', 22),
          color: NEUTRAL,
        })),
        { label: firstLine(stages.risk.chief.name, 14), sub: `${stages.risk.chief.decision} · ${stages.risk.chief.sizing ?? ''}`, color: VERDICT_COLOR[stages.risk.chief.decision] ?? NEUTRAL },
      ],
    });
  }
  if (final) {
    cols.push({
      title: '⑤ 终审结论',
      nodes: [{ label: `团队评分 ${final.score ?? '—'}`, sub: `${final.decision ?? ''} ${firstLine(final.note, 14)}`, color: VERDICT_COLOR[final.decision] ?? NEUTRAL }],
    });
  }
  return cols.filter((c) => c.nodes.length > 0);
}

export default function WorkflowDag({ trace }: { trace: any }) {
  const { columns } = useMemo(() => {
    const stages = trace?.stages ?? {};
    const seats: string[] = trace?.degraded?.seats ?? [];
    return { columns: buildColumns(stages, trace?.final, new Set(seats)) };
  }, [trace]);

  const allRule = trace?.llmEnabled === false;
  const W = 1060;
  const NODE_W = 142;
  const NODE_H = 42;
  const GAP_Y = 8;
  const colGap = 46;
  const width = Math.min(W, columns.reduce((s: number) => s + NODE_W + colGap, -colGap));
  const maxRows = Math.max(...columns.map((c) => c.nodes.length), 1);
  const height = maxRows * (NODE_H + GAP_Y) + 46;

  // 列 x 坐标：等分宽度
  const xs: number[] = [];
  let x = 8;
  for (let i = 0; i < columns.length; i++) {
    xs.push(x);
    x += NODE_W + (width - 16 - columns.length * NODE_W) / Math.max(columns.length - 1, 1);
  }

  if (!columns.length) return null;

  return (
    <div style={{ overflowX: 'auto', marginBottom: 16 }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: 720, display: 'block' }} role="img" aria-label="Agent 团队流水线 DAG">
        <defs>
          <marker id="ff-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 Z" fill="#475569" />
          </marker>
        </defs>
        {/* 列标题 */}
        {columns.map((c, ci) => (
          <text key={'t' + ci} x={xs[ci] + NODE_W / 2} y={16} textAnchor="middle" fontSize={11.5} fill="#93c5fd" fontWeight={700}>
            {c.title}
          </text>
        ))}
        {/* 列间连线 */}
        {columns.slice(1).map((_, ci) => (
          <line key={'e' + ci} x1={xs[ci] + NODE_W} y1={height / 2} x2={xs[ci + 1] - 4} y2={height / 2} stroke="#475569" strokeWidth={1.5} markerEnd="url(#ff-arrow)" />
        ))}
        {/* 节点 */}
        {columns.map((c, ci) =>
          c.nodes.map((n, ri) => {
            const colH = c.nodes.length * (NODE_H + GAP_Y) - GAP_Y;
            const y = (height - 46 - colH) / 2 + 30 + ri * (NODE_H + GAP_Y);
            return (
              <g key={`${ci}-${ri}`}>
                <title>{n.tip || `${n.label}：${n.sub}`}</title>
                <rect x={xs[ci]} y={y} width={NODE_W} height={NODE_H} rx={9} fill="#0d1322" stroke={n.color} strokeOpacity={0.55} strokeWidth={1.4} />
                <text x={xs[ci] + 10} y={y + 17} fontSize={11.5} fill="#e2e8f0" fontWeight={700}>
                  {n.label.length > 12 ? n.label.slice(0, 12) + '…' : n.label}
                </text>
                <text x={xs[ci] + 10} y={y + 33} fontSize={10} fill={n.color}>
                  {n.sub.length > 16 ? n.sub.slice(0, 16) + '…' : n.sub}
                </text>
                {n.engine && (
                  <>
                    <circle cx={xs[ci] + NODE_W - 9} cy={y + 9} r={4} fill={n.engine === 'rule' ? RULE_DOT : LLM_DOT} />
                    <title>{n.engine === 'rule' ? '该席位由规则引擎产出' : '该席位由 LLM 产出'}</title>
                  </>
                )}
              </g>
            );
          }),
        )}
      </svg>
      <div style={{ fontSize: 11, color: '#64748b', padding: '2px 6px 0' }}>
        {allRule
          ? '本次全部席位由本地规则引擎产出（云端大模型未配置）——琥珀点为规则引擎席位'
          : '琥珀点=规则引擎产出 · 蓝点=LLM 产出'}
      </div>
    </div>
  );
}
