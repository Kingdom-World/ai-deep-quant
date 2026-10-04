// ─────────────────────────────────────────────────────────────
// PipelineView —— 模型结构只读视图（「改 → 看见」的最小闭环）
//
//   为什么必须常驻：原页面只有「改 → 校验」，权重调 0.3 还是 0.5 没有任何反馈，
//   等于盲调。把**当前草稿**实时渲染成流水线结构，用户改一下就能看见结构变化，
//   不必先跑回测（公网也跑不了）。
//
//   ⚠️ 这是**只读渲染**，不构成执行计划的第二真相源：
//      真正可审计的 plan 仍由服务端 run 返回、原样回显在结果区。
//      本视图只用于"看着调"。
// ─────────────────────────────────────────────────────────────
import type { ModelSpec } from '../../api';
import { theme } from '../../lib/theme';

const MONO = 'var(--zone-mono, Consolas, monospace)';

const chip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  borderRadius: 6,
  border: `1px solid var(--zone-line, ${theme.color.border})`,
  background: 'var(--zone-surface-2, rgba(19,24,34,.7))',
  color: theme.color.text,
  fontSize: 12,
  fontFamily: MONO,
  lineHeight: 1.5,
};

function Stage({ title, count, children }: { title: string; count?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ position: 'relative', paddingLeft: 16, paddingBottom: 12 }}>
      {/* 竖向流程线 */}
      <div
        style={{
          position: 'absolute',
          left: 3,
          top: 12,
          bottom: 0,
          width: 1,
          background: 'var(--zone-line, #222a36)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 5,
          width: 7,
          height: 7,
          borderRadius: 4,
          background: theme.color.accent,
          boxShadow: `0 0 0 3px var(--zone-surface, #0e1218)`,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: theme.color.text }}>{title}</span>
        {count !== undefined && (
          <span style={{ fontSize: 11.5, color: theme.color.textFaint, fontFamily: MONO }}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

const empty = (text: string) => <div style={{ fontSize: 12, color: theme.color.textFaint }}>{text}</div>;

export default function PipelineView({ model, topN }: { model: ModelSpec; topN: string }) {
  const factors = model.factors || [];
  const transforms = model.transforms || [];
  const filters = model.filters || [];
  const backtest = model.backtest;

  const totalWeight = factors.reduce((s, f) => s + (Number.isFinite(Number(f.weight)) ? Number(f.weight) : 0), 0);

  return (
    <div style={{ paddingTop: 2 }}>
      <Stage title="因子层" count={`${factors.length} 个 · 权重合计 ${Number.isFinite(totalWeight) ? totalWeight.toFixed(2) : '—'}`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {factors.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={chip}>{f.expr || '(空)'}</span>
              <span style={{ fontSize: 11.5, color: theme.color.textFaint, fontFamily: MONO }}>
                w={Number.isFinite(Number(f.weight)) ? Number(f.weight) : 1}
              </span>
              <span
                style={{
                  fontSize: 11.5,
                  color: f.direction === -1 ? theme.color.down : theme.color.up,
                  fontFamily: MONO,
                }}
              >
                {f.direction === -1 ? '↓ 反向' : '↑ 正向'}
              </span>
            </div>
          ))}
        </div>
      </Stage>

      <Stage title="截面预处理" count={transforms.length ? `按序 ${transforms.length} 步` : '未配置'}>
        {transforms.length === 0
          ? empty('未配置（原始因子直接进入合成）')
          : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {transforms.map((t, i) => {
                const args = (t.args || {}) as { method?: string; n?: number };
                const argText =
                  t.type === 'winsorize'
                    ? `(${args.method || 'mad'}${args.n === undefined ? '' : `, ${args.n}`})`
                    : '';
                return (
                  <span key={i} style={chip}>
                    <span style={{ color: theme.color.accent }}>{i + 1}</span>
                    {`${t.type}${argText}`}
                  </span>
                );
              })}
            </div>
          )}
      </Stage>

      <Stage title="过滤器" count={filters.length ? `${filters.length} 条` : '未配置'}>
        {filters.length === 0
          ? empty('未配置（全部候选样本参与排序）')
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {filters.map((f, i) => {
                const ff = f as unknown as { field: string; min?: number; max?: number };
                const parts: string[] = [];
                if (ff.min !== undefined) parts.push(`≥ ${ff.min}`);
                if (ff.max !== undefined) parts.push(`≤ ${ff.max}`);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={chip}>{ff.field}</span>
                    <span style={{ fontSize: 11.5, color: theme.color.textMuted, fontFamily: MONO }}>
                      {parts.join(' 且 ') || '(无边界)'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
      </Stage>

      <Stage title="合成与调仓">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          <span style={chip}>weighted_sum</span>
          <span style={{ fontSize: 11.5, color: theme.color.textFaint, alignSelf: 'center' }}>→</span>
          <span style={chip}>topN {topN || '—'}</span>
          <span style={chip}>{backtest?.rebalance || 'monthly'}</span>
          <span style={chip}>{backtest?.groups ?? 5} 分组</span>
          <span style={chip}>{backtest?.fees === false ? '不计费' : '含手续费'}</span>
        </div>
      </Stage>

      <div
        style={{
          marginTop: 2,
          fontSize: 11.5,
          color: theme.color.textFaint,
          lineHeight: 1.7,
        }}
      >
        综合分越高越强；因子方向决定「值越大越看好 / 越不看好」。
      </div>
    </div>
  );
}
