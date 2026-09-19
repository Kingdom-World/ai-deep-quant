// ─────────────────────────────────────────────────────────────
// Agent 团队报告详情页（/agents/report/:id）
//   完整渲染一次分析运行的全部内容：每位 Agent 的全文报告、
//   两轮多空辩论、场景推演、风险辩论与终审。
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fmtDateTime } from '../lib/time';
import TopNav from '../components/TopNav';
import { theme } from '../lib/theme';
import { agentsApi, type AgentTrace } from '../api/dataService';

const CARD = {
  backgroundColor: 'rgba(17,24,39,0.6)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(96,165,250,0.16)',
  borderRadius: '12px',
  padding: '16px 18px',
} as const;

const VERDICT_COLOR: Record<string, string> = {
  BUY: '#ef4444',
  SELL: '#22c55e',
  HOLD: '#facc15',
  观望: '#94a3b8',
  '降级·分批试探': '#f59e0b',
  '——': '#94a3b8',
};

/** 极简 markdown 渲染（## 标题 / - 列表 / 普通行） */
function renderMd(text: string) {
  const lines = String(text || '').split('\n');
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = (key: string) => {
    if (list.length) {
      out.push(
        <ul key={key} style={{ margin: '4px 0', paddingLeft: 18 }}>
          {list.map((x, i) => (
            <li key={i} style={{ fontSize: '12.5px', color: '#cbd5e1', lineHeight: 1.7 }}>{x}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  lines.forEach((line, i) => {
    if (line.startsWith('## ')) {
      flush(`l${i}`);
      out.push(
        <div key={`h${i}`} style={{ fontSize: '13px', fontWeight: 700, color: '#93c5fd', margin: '10px 0 4px' }}>
          {line.slice(3)}
        </div>,
      );
    } else if (line.startsWith('- ')) {
      list.push(line.slice(2));
    } else if (line.trim()) {
      flush(`l${i}`);
      out.push(
        <div key={`p${i}`} style={{ fontSize: '12.5px', color: '#cbd5e1', lineHeight: 1.7 }}>
          {line}
        </div>,
      );
    }
  });
  flush('end');
  return out;
}

const BIAS_CHIP: Record<string, { text: string; color: string }> = {
  bullish: { text: '偏多', color: '#ef4444' },
  bearish: { text: '偏空', color: '#22c55e' },
  neutral: { text: '中性', color: '#94a3b8' },
};

export default function AgentReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [trace, setTrace] = useState<AgentTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agentsApi
      .report(id ?? '')
      .then((r) => {
        if (!r.ok) throw new Error('报告不存在或已过期');
        setTrace(r.report);
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);

  if (error) {
    return (
      <div style={{ ...theme.page }}>
        <TopNav />
        <div style={{ padding: 24 }}>
        <div style={{ ...CARD, marginTop: 24, color: '#f87171' }}>✗ {error}</div>
        </div>
      </div>
    );
  }
  if (!trace) {
    return (
      <div style={{ ...theme.page, color: '#64748b' }}>
        <TopNav />
        <div style={{ padding: 24 }}>加载报告中…</div>
      </div>
    );
  }

  const stages = (trace.stages ?? {}) as any;
  const final = trace.final as any;
  const vColor = VERDICT_COLOR[final?.decision] ?? '#94a3b8';
  const debate = stages.debate ?? {};

  return (
    <div style={{ ...theme.page }}>
      <TopNav />
      <div style={{ padding: '20px 24px 44px' }}>
      <div>
        {/* 文档头 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0 4px', flexWrap: 'wrap' }}>
          <span style={{ cursor: 'pointer', color: '#60a5fa', fontWeight: 700, fontSize: 15 }} onClick={() => navigate('/agents')}>
            ← Agent 团队
          </span>
          <h1 style={{ fontSize: 19, margin: 0 }}>
            📄 团队研究报告 · {trace.symbol}
            {trace.name ? <span style={{ fontSize: 13, color: '#94a3b8', marginLeft: 8 }}>{trace.name}</span> : null}
          </h1>
          <button
            onClick={async () => {
              if (!window.confirm(`确定删除报告 ${id}？删除后不可恢复。`)) return;
              try {
                const r = await agentsApi.remove(id ?? '');
                if (!r.ok) throw new Error(r.error || '删除失败');
                navigate('/agents');
              } catch (e) {
                window.alert((e as Error).message);
              }
            }}
            style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 12, color: '#f87171', backgroundColor: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, cursor: 'pointer' }}
          >
            🗑 删除此报告
          </button>
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>
          模式 {trace.mode} · 生成于 {fmtDateTime(trace.ranAt)} · 报告编号 {trace.reportId}
        </div>

        {/* 合规声明 */}
        <div
          style={{
            border: '1px solid rgba(245,158,11,0.4)',
            backgroundColor: 'rgba(245,158,11,0.08)',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 16,
            fontSize: 12.5,
            color: '#fbbf24',
            lineHeight: 1.7,
            fontWeight: 600,
          }}
        >
          ⚠️ 合规声明：本报告由 <b>AI 多角色协作</b>自动生成，属学术研究演示，<b>不构成任何投资建议</b>；数据来自公开行情、东方财富公开接口与新浪滚动要闻，未覆盖项已标注降级。
        </div>

        {/* AI 参与度：让「是否真的调用了云端大模型」可见。
            以前这块信息只在后端 trace 里，界面看不到，导致团队静默退化成纯规则引擎时
            用户仍以为报告是 AI 产出的——这里把它显式暴露出来。 */}
        {(() => {
          const roster = trace.llmRoster || [];
          if (!roster.length) return null;
          const llmCount = roster.filter((r) => r.engine === 'llm').length;
          const ruleCount = roster.length - llmCount;
          const allRule = llmCount === 0;
          return (
            <div style={{ ...CARD, marginBottom: 16, border: `1px solid ${allRule ? 'rgba(248,113,113,0.4)' : 'rgba(96,165,250,0.22)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: allRule ? '#f87171' : '#e2e8f0' }}>
                  {allRule ? '⚠️ 本次分析未接入云端大模型' : '🛰️ AI 参与度'}
                </div>
                <div style={{ fontSize: 12.5, color: allRule ? '#f87171' : '#93c5fd', fontFamily: 'Consolas, monospace', fontWeight: 700 }}>
                  {llmCount}/{roster.length} 个角色由大模型产出
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {roster.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, flexWrap: 'wrap' }}>
                    <span style={{ width: 62, color: r.engine === 'llm' ? '#6ee7b7' : '#94a3b8' }}>{r.engine === 'llm' ? '🛰️ AI' : '⚙️ 规则'}</span>
                    <span style={{ flex: 1, minWidth: 150, color: '#cbd5e1' }}>{r.seat}</span>
                    <span style={{ color: '#64748b', fontFamily: 'Consolas, monospace' }}>{r.model}</span>
                  </div>
                ))}
              </div>
              {allRule && (
                <div style={{ marginTop: 8, fontSize: 11.5, color: '#fbbf24', lineHeight: 1.7 }}>
                  可能原因：云端模型未配置 / 免费额度被限流 / 网络不可达。此时结论由本地规则引擎给出，推理深度低于 AI 版本。
                </div>
              )}
              {!allRule && ruleCount > 0 && (
                <div style={{ marginTop: 8, fontSize: 11.5, color: '#fbbf24', lineHeight: 1.7 }}>
                  本次有 {ruleCount} 个角色由规则引擎兜底（免费额度限流时常见），这些角色的论述深度低于 AI 版本，
                  请以上方逐角色的引擎标注为准。
                </div>
              )}
            </div>
          );
        })()}

        {/* 最终结论 */}
        <div style={{ ...CARD, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', border: `1px solid ${vColor}66` }}>
          <div>
            <div style={{ fontSize: 11, color: '#64748b', letterSpacing: 1 }}>研究结论 · 非投资建议</div>
            <div style={{ fontSize: 30, fontWeight: 800, color: vColor }}>{final?.decision}</div>
          </div>
          <div style={{ flex: 1, minWidth: 220, fontSize: '12.5px', color: '#cbd5e1', lineHeight: 1.7 }}>{final?.note}</div>
          {final?.teamScore != null && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: '#93c5fd', fontFamily: 'Consolas, monospace' }}>{final.teamScore}</div>
              <div style={{ fontSize: 10, color: '#64748b' }}>团队研究评分</div>
            </div>
          )}
        </div>

        {/* 第一阶段：全部 Agent 全文报告 */}
        {stages.collect?.agents?.map((a: any, i: number) => {
          const chip = BIAS_CHIP[a.bias ?? 'neutral'] ?? BIAS_CHIP.neutral;
          return (
            <div key={i} style={{ ...CARD, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 800, fontSize: '14px', color: '#93c5fd' }}>{a.name}</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {a.confidence != null && (
                    <span style={{ fontSize: 11, color: '#64748b' }}>置信度 {a.confidence}</span>
                  )}
                  {a.bias && (
                    <span style={{ fontSize: 11, color: chip.color, border: `1px solid ${chip.color}55`, borderRadius: 999, padding: '1px 8px' }}>
                      {chip.text}
                    </span>
                  )}
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>{a.role}</div>
              {renderMd(a.report)}
              {(a.sources ?? []).length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#475569' }}>数据来源：{a.sources.join('；')}</div>
              )}
              {(a.limitations ?? []).length > 0 && (
                <div style={{ marginTop: 4, fontSize: 11, color: '#f59e0b', opacity: 0.85 }}>⚠ 局限：{a.limitations.join('；')}</div>
              )}
            </div>
          );
        })}

        {/* 第二阶段：辩论全文 */}
        {debate.round1 && (
          <div style={{ ...CARD, marginBottom: 16 }}>
            <div style={{ fontWeight: 800, fontSize: '14px', color: '#e2e8f0', marginBottom: 10 }}>🗣️ 多空辩论（两轮）</div>
            {[debate.round1, debate.round2].map((r: any, ri: number) => (
              <div key={ri} style={{ marginBottom: ri === 0 ? 14 : 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 6 }}>第 {ri + 1} 轮</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ borderLeft: '2px solid #ef4444', paddingLeft: 10 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fca5a5' }}>{r.bull?.name}</div>
                    {(r.bull?.arguments ?? []).map((x: string, i: number) => (
                      <div key={i} style={{ fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.7 }}>· {x}</div>
                    ))}
                  </div>
                  <div style={{ borderLeft: '2px solid #22c55e', paddingLeft: 10 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#86efac' }}>{r.bear?.name}</div>
                    {(r.bear?.arguments ?? []).map((x: string, i: number) => (
                      <div key={i} style={{ fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.7 }}>· {x}</div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
            {debate.chief && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: '13px', color: '#93c5fd' }}>{debate.chief.name}</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: VERDICT_COLOR[debate.chief.verdict] ?? '#e2e8f0', border: `1px solid ${VERDICT_COLOR[debate.chief.verdict] ?? '#e2e8f0'}66`, borderRadius: 8, padding: '2px 10px' }}>
                  {debate.chief.verdict}
                </span>
                <span style={{ fontSize: 12.5, color: '#cbd5e1', flex: 1 }}>{debate.chief.reason}</span>
              </div>
            )}
          </div>
        )}

        {/* 第三阶段：交易决策 + 场景推演 */}
        {stages.trade && (
          <div style={{ ...CARD, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ fontWeight: 700, fontSize: '13px', color: '#93c5fd' }}>{stages.trade.name}</span>
              {stages.trade.approved ? (
                <>
                  <span style={{ fontSize: 12.5, color: '#94a3b8' }}>入场 <b style={{ color: '#e2e8f0', fontFamily: 'Consolas,monospace' }}>{stages.trade.entry}</b></span>
                  <span style={{ fontSize: 12.5, color: '#94a3b8' }}>目标 <b style={{ color: '#ef4444', fontFamily: 'Consolas,monospace' }}>{stages.trade.target}</b></span>
                  <span style={{ fontSize: 12.5, color: '#94a3b8' }}>止损 <b style={{ color: '#22c55e', fontFamily: 'Consolas,monospace' }}>{stages.trade.stop}</b></span>
                  <span style={{ fontSize: 12.5, color: '#4ade80' }}>风险回报比 1:{stages.trade.rr}</span>
                </>
              ) : null}
            </div>
            {stages.trade.scenarios && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                <thead>
                  <tr style={{ color: '#64748b', fontSize: 11 }}>
                    {['场景', '概率', '目标价', '预计盈亏'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stages.trade.scenarios.map((s: any) => (
                    <tr key={s.name} style={{ borderTop: '1px solid #1e293b' }}>
                      <td style={{ padding: '5px 8px' }}>{s.name}</td>
                      <td style={{ padding: '5px 8px' }}>{Math.round(s.prob * 100)}%</td>
                      <td style={{ padding: '5px 8px', fontFamily: 'Consolas,monospace' }}>{s.price}</td>
                      <td style={{ padding: '5px 8px', color: pctColor2(s.pnlPct) }}>{s.pnlPct > 0 ? '+' : ''}{s.pnlPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>{stages.trade.note}</div>
          </div>
        )}

        {/* 第四/五阶段：风险辩论与终审 */}
        {stages.risk?.chief && (
          <div style={{ ...CARD, marginBottom: 16 }}>
            <div style={{ fontWeight: 800, fontSize: '14px', color: '#e2e8f0', marginBottom: 10 }}>⚖️ 风险辩论与终审</div>
            {(stages.risk.debate ?? []).map((r: any, i: number) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 4 }}>{r.round}</div>
                {r.aggressive && (
                  <div style={{ fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.7, marginBottom: 4 }}>
                    <b style={{ color: '#fca5a5' }}>激进派：</b>{r.aggressive}
                  </div>
                )}
                {r.conservative && (
                  <div style={{ fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.7, marginBottom: 4 }}>
                    <b style={{ color: '#86efac' }}>保守派：</b>{r.conservative}
                  </div>
                )}
                {r.neutral && (
                  <div style={{ fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.7 }}>
                    <b style={{ color: '#93c5fd' }}>中性派：</b>{r.neutral}
                  </div>
                )}
              </div>
            ))}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1e293b' }}>
              <span style={{ fontWeight: 700, fontSize: '13px', color: '#93c5fd' }}>{stages.risk.chief.name}</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: VERDICT_COLOR[stages.risk.chief.decision] ?? '#e2e8f0', margin: '0 12px' }}>
                {stages.risk.chief.decision}
              </span>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>建议仓位：{stages.risk.chief.sizing}</span>
              <div style={{ fontSize: 12.5, color: '#cbd5e1', marginTop: 6 }}>{stages.risk.chief.notes}</div>
            </div>
          </div>
        )}

        <div style={{ fontSize: 11, color: '#475569', textAlign: 'center', padding: '8px 0', lineHeight: 1.7 }}>
          {trace.disclaimer}
        </div>
      </div>
      </div>
    </div>
  );
}

function pctColor2(v: number) {
  return v >= 0 ? '#ef4444' : '#22c55e';
}
