// ─────────────────────────────────────────────────────────────
// Agent 团队分析面板（主理人调度制 · 五阶段流水线可视化）
//   · 供首页 / 量化因子分析页复用
//   · 13 角色由免费云端大模型分饰（记忆隔离，信息经主理人中转），异步任务轮询进度
//   · 合规声明：LLM + 规则引擎协作的学术研究演示，非投资建议
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { agentsApi, type AgentTrace } from '../api/dataService';

const CARD = {
  backgroundColor: 'rgba(17,24,39,0.6)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(96,165,250,0.16)',
  borderRadius: '12px',
  padding: '14px 16px',
} as const;

const MODES = [
  { key: 'full', name: '完整分析', desc: '五阶段全方位评估' },
  { key: 'quick', name: '快速分析', desc: '技术+基本面+交易员' },
  { key: 'debate', name: '辩论模式', desc: '多空辩论后出裁决' },
  { key: 'risk', name: '风险诊断', desc: '持仓后风控（可填成本价）' },
  { key: 'single', name: '单点调用', desc: '只跑某一类分析师' },
];

const AGENTS = [
  { key: 'tech', name: '技术分析师' },
  { key: 'fundamental', name: '基本面分析师' },
  { key: 'news', name: '新闻分析师' },
  { key: 'sentiment', name: '情绪分析师' },
];

const BIAS_CHIP: Record<string, { text: string; color: string }> = {
  bullish: { text: '偏多', color: '#ef4444' },
  bearish: { text: '偏空', color: '#22c55e' },
  neutral: { text: '中性', color: '#94a3b8' },
};

const VERDICT_COLOR: Record<string, string> = {
  BUY: '#ef4444',
  SELL: '#22c55e',
  HOLD: '#facc15',
  观望: '#94a3b8',
  '降级·分批试探': '#f59e0b',
  '——': '#94a3b8',
};

function AgentCard({ a }: { a: any }) {
  const chip = BIAS_CHIP[a.bias ?? 'neutral'] ?? BIAS_CHIP.neutral;
  return (
    <div style={{ ...CARD, padding: '12px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: '13px', color: '#93c5fd' }}>{a.name}</span>
        {a.bias && (
          <span style={{ fontSize: '11px', color: chip.color, border: `1px solid ${chip.color}55`, borderRadius: 999, padding: '1px 8px' }}>
            {chip.text}
          </span>
        )}
      </div>
      <div style={{ fontSize: '11px', color: '#64748b', marginBottom: 8 }}>{a.role}</div>
      <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {(a.findings ?? []).map((f: string, i: number) => (
          <li key={i} style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: 1.6 }}>{f}</li>
        ))}
      </ul>
      {a.confidence != null && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '10px', color: '#475569' }}>置信度</span>
          <div style={{ flex: 1, height: 4, backgroundColor: '#1e293b', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(a.confidence, 100)}%`, height: '100%', background: 'linear-gradient(90deg,#2563eb,#60a5fa)' }} />
          </div>
          <span style={{ fontSize: '10px', color: '#64748b' }}>{a.confidence}</span>
        </div>
      )}
      {(a.limitations ?? []).length > 0 && (
        <div style={{ marginTop: 6, fontSize: '10.5px', color: '#f59e0b', opacity: 0.85, lineHeight: 1.5 }}>
          ⚠ 局限：{(a.limitations ?? []).join('；')}
        </div>
      )}
    </div>
  );
}

export default function AgentTeamPanel({ defaultSymbol = 'AAPL', compact = false }: { defaultSymbol?: string; compact?: boolean }) {
  const navigate = useNavigate();
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [mode, setMode] = useState('full');
  const [agent, setAgent] = useState('tech');
  const [entryPrice, setEntryPrice] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ step: number; total: number; stage: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<AgentTrace | null>(null);
  const pollTimer = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);

  // 卸载时停掉轮询链并清掉在途定时器。
  // 原实现只在 promise 的 finally 里 clearTimeout，且轮询链自身会继续 setTimeout，
  // 组件卸载后仍会持续请求接口并对已卸载组件 setState（请求浪费 + React 告警）。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(pollTimer.current);
    };
  }, []);

  const run = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setTrace(null);
    setProgress({ step: 0, total: 15, stage: '任务已受理，正在准备数据' });
    try {
      const r = await agentsApi.analyze({
        symbol: symbol.trim(),
        mode,
        ...(mode === 'single' ? { agent } : {}),
        ...(mode === 'risk' && entryPrice ? { entryPrice: Number(entryPrice) } : {}),
      });
      if (!r.ok) throw new Error(r.error || '分析失败');
      // 同步返回（云端模型未配置时的规则引擎路径）
      if ((r as any).stages) {
        setTrace(r);
        setProgress(null);
        setLoading(false);
        return;
      }
      // 异步任务：轮询进度（13 角色 LLM 流水线约 2-4 分钟）
      const jobId = (r as any).jobId as string;
      await new Promise<void>((resolve, reject) => {
        const poll = async () => {
          if (!mountedRef.current) {
            resolve(); // 组件已卸载：终止轮询
            return;
          }
          try {
            const j = await agentsApi.job(jobId);
            if (!mountedRef.current) {
              resolve();
              return;
            }
            if (!j.ok) throw new Error('任务查询失败');
            if (j.status === 'running') {
              setProgress({ step: j.step ?? 0, total: j.total ?? 15, stage: j.stage ?? '' });
              pollTimer.current = window.setTimeout(poll, 2500);
              return;
            }
            if (j.status === 'error') throw new Error(j.error || '分析失败');
            if (j.trace) {
              setTrace(j.trace);
              resolve();
              return;
            }
            throw new Error('任务完成但缺少报告');
          } catch (e) {
            reject(e);
          }
        };
        pollTimer.current = window.setTimeout(poll, 1500);
      });
      if (mountedRef.current) setProgress(null);
    } catch (e) {
      if (mountedRef.current) {
        setError((e as Error).message);
        setTrace(null);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setProgress(null);
      }
      window.clearTimeout(pollTimer.current);
    }
  };

  const stages = (trace?.stages ?? {}) as any;
  const final = trace?.final as any;
  const vColor = final ? (VERDICT_COLOR[final.decision] ?? '#94a3b8') : '#94a3b8';
  // 降级可观测：后端已把「哪些角色由规则引擎兜底」汇总进 trace.degraded
  const degraded = (trace?.degraded ?? (stages?.orchestration as any)?.degraded) as
    | { degraded?: boolean; llm?: number; rule?: number; total?: number; seats?: string[]; reason?: string }
    | undefined;

  return (
    <div>
      {/* ── 鲜明脱敏声明 ── */}
      <div
        style={{
          border: '1px solid rgba(245,158,11,0.4)',
          backgroundColor: 'rgba(245,158,11,0.08)',
          borderRadius: '10px',
          padding: '10px 14px',
          marginBottom: '14px',
          fontSize: '12.5px',
          color: '#fbbf24',
          lineHeight: 1.7,
          fontWeight: 600,
        }}
      >
        ⚠️ 合规声明（请务必阅读）：本功能由 <b>AI 多角色协作</b>自动生成，所有报告 / 辩论 / 结论均为算法生成的<b>学术研究演示</b>，
        <b>不构成任何投资建议</b>，不代表任何真实机构观点；数据缺失的情形会使用代理指标并已在报告中标注局限。请勿据此进行任何真实交易。
      </div>

      {/* ── 控制台 ── */}
      <div style={{ ...CARD, marginBottom: '14px' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="股票代码（AAPL / 600519 / 00700）"
            style={{ flex: '1 1 180px', padding: '9px 12px', fontSize: '13px', color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8, outline: 'none' }}
          />
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            style={{ padding: '9px 10px', fontSize: '13px', color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8, outline: 'none' }}
          >
            {MODES.map((m) => (
              <option key={m.key} value={m.key}>{m.name}</option>
            ))}
          </select>
          {mode === 'single' && (
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              style={{ padding: '9px 10px', fontSize: '13px', color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8, outline: 'none' }}
            >
              {AGENTS.map((a) => (
                <option key={a.key} value={a.key}>{a.name}</option>
              ))}
            </select>
          )}
          {mode === 'risk' && (
            <input
              value={entryPrice}
              onChange={(e) => setEntryPrice(e.target.value)}
              placeholder="持仓成本价（可选）"
              style={{ width: 140, padding: '9px 12px', fontSize: '13px', color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8, outline: 'none' }}
            />
          )}
          <button
            onClick={run}
            disabled={loading}
            style={{ padding: '9px 20px', fontSize: '13px', fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,#1d4ed8,#60a5fa)', border: 'none', borderRadius: 8, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.7 : 1 }}
          >
            {loading ? '团队协作中…' : '🚀 召集团队'}
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: '11px', color: '#64748b' }}>
          {MODES.find((m) => m.key === mode)?.desc} · 多视角交叉验证 · 研究主管强制给出 BUY / SELL / HOLD 结论
        </div>
      </div>

      {error && (
        <div style={{ ...CARD, borderColor: '#7f1d1d', color: '#f87171', marginBottom: 14 }}>✗ {error}</div>
      )}

      {loading && (
        <div style={{ ...CARD, textAlign: 'center', color: '#93c5fd', padding: '28px' }}>
          <div style={{ fontSize: 20, marginBottom: 8 }}>🤖 AI 分析团队协作中…</div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
            {progress?.stage || '正在调度'}（{progress ? `${progress.step}/${progress.total}` : '…'}）
          </div>
          <div style={{ height: 6, backgroundColor: 'rgba(96,165,250,0.12)', borderRadius: 999, overflow: 'hidden', maxWidth: 420, margin: '0 auto' }}>
            <div
              style={{
                height: '100%',
                width: `${progress ? Math.round((progress.step / Math.max(progress.total, 1)) * 100) : 4}%`,
                background: 'linear-gradient(90deg,#1d4ed8,#60a5fa)',
                borderRadius: 999,
                transition: 'width 0.6s ease',
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: '#475569', marginTop: 10 }}>完整分析约 2-4 分钟，请勿关闭页面</div>
        </div>
      )}

      {/* ── 结果渲染 ── */}
      {trace && !loading && final && (
        <div>
          {/* 最终决策横幅 */}
          <div
            style={{
              ...CARD,
              marginBottom: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              flexWrap: 'wrap',
              border: `1px solid ${vColor}66`,
            }}
          >
            <div>
              <div style={{ fontSize: 11, color: '#64748b', letterSpacing: 1 }}>研究结论 · 非投资建议</div>
              <div style={{ fontSize: 30, fontWeight: 800, color: vColor }}>{final.decision}</div>
            </div>
            <div style={{ flex: 1, minWidth: 220, fontSize: '12.5px', color: '#cbd5e1', lineHeight: 1.7 }}>{final.note}</div>
            {final.teamScore != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 800, color: '#93c5fd', fontFamily: 'Consolas, monospace' }}>{final.teamScore}</div>
                <div style={{ fontSize: 10, color: '#64748b' }}>团队研究评分</div>
              </div>
            )}
          </div>

          {/* ── 降级提示（关键可观测性）：不能让规则引擎产出被误读为大模型分析 ── */}
          {degraded?.degraded && (
            <div
              style={{
                ...CARD,
                marginBottom: 14,
                border: '1px solid rgba(245,158,11,0.45)',
                backgroundColor: 'rgba(245,158,11,0.08)',
                color: '#fbbf24',
                fontSize: 12,
                lineHeight: 1.7,
              }}
            >
              ⚠️ <b>本次分析存在降级</b>：
              {degraded.total ? ` ${degraded.rule ?? 0}/${degraded.total} 个角色` : ' 部分角色'}由本地规则引擎产出（未走云端大模型）。
              {degraded.seats?.length ? ` 降级角色：${degraded.seats.join('、')}。` : ''}
              {degraded.reason ? ` ${degraded.reason}。` : ''}
              降级多因免费模型额度限流触发，结论请谨慎参考。
            </div>
          )}

          {trace.reportId && (
            <button
              onClick={() => navigate(`/agents/report/${trace.reportId}`)}
              style={{ width: '100%', marginTop: 10, padding: '10px 0', fontSize: '13px', fontWeight: 700, color: '#93c5fd', backgroundColor: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.35)', borderRadius: 10, cursor: 'pointer' }}
            >
              📄 查看完整研究报告（全部 Agent 全文 · 两轮辩论 · 场景推演）
            </button>
          )}

          {/* 调度中枢 */}
          <div style={{ ...CARD, marginBottom: 14, textAlign: 'center', padding: '12px' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#93c5fd' }}>🎛️ 调度中枢</span>
            <span style={{ fontSize: 11.5, color: '#64748b', marginLeft: 10 }}>
              统一调度各分析师 · 汇总证据 · 编制最终报告
            </span>
          </div>

          {/* 第一阶段 */}
          {stages.collect && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
                {stages.collect.title}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
                {(stages.collect.agents ?? []).map((a: any, i: number) => (
                  <AgentCard key={i} a={a} />
                ))}
              </div>
              {stages.collect.digest && (
                <div style={{ ...CARD, marginTop: 10, fontSize: '12px', color: '#94a3b8' }}>
                  📮 <b style={{ color: '#93c5fd' }}>证据汇总</b>：
                  偏多 {stages.collect.digest.votes?.bullish ?? 0} 票 / 偏空 {stages.collect.digest.votes?.bearish ?? 0} 票 / 中性 {stages.collect.digest.votes?.neutral ?? 0} 票
                  · 加权评分 <b style={{ color: '#e2e8f0' }}>{stages.collect.digest.weightedBias}</b>
                </div>
              )}
            </div>
          )}

          {/* 第二阶段 辩论 */}
          {stages.debate?.chief && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
                {stages.debate.title}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 10 }}>
                {stages.debate.bull && (
                  <div style={{ ...CARD, borderTop: '2px solid #ef4444' }}>
                    <div style={{ fontWeight: 700, fontSize: '13px', color: '#fca5a5', marginBottom: 6 }}>{stages.debate.bull.name}</div>
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {(stages.debate.bull.arguments ?? []).map((x: string, i: number) => (
                        <li key={i} style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: 1.6 }}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {stages.debate.bear && (
                  <div style={{ ...CARD, borderTop: '2px solid #22c55e' }}>
                    <div style={{ fontWeight: 700, fontSize: '13px', color: '#86efac', marginBottom: 6 }}>{stages.debate.bear.name}</div>
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {(stages.debate.bear.arguments ?? []).map((x: string, i: number) => (
                        <li key={i} style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: 1.6 }}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <div style={{ ...CARD, marginTop: 10, display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ fontWeight: 700, fontSize: '13px', color: '#93c5fd' }}>{stages.debate.chief.name}</span>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    color: VERDICT_COLOR[stages.debate.chief.verdict] ?? '#e2e8f0',
                    border: `1px solid ${VERDICT_COLOR[stages.debate.chief.verdict] ?? '#e2e8f0'}66`,
                    borderRadius: 8,
                    padding: '2px 10px',
                  }}
                >
                  {stages.debate.chief.verdict}
                </span>
                <span style={{ fontSize: '12px', color: '#cbd5e1', flex: 1 }}>{stages.debate.chief.reason}</span>
              </div>
            </div>
          )}

          {/* 第三阶段 交易决策 */}
          {stages.trade && (
            <div style={{ ...CARD, marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: '13px', color: '#93c5fd' }}>{stages.trade.name}</span>
                {stages.trade.approved ? (
                  <>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>入场 <b style={{ color: '#e2e8f0', fontFamily: 'Consolas,monospace' }}>{stages.trade.entry}</b></span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>目标 <b style={{ color: '#ef4444', fontFamily: 'Consolas,monospace' }}>{stages.trade.target}</b></span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>止损 <b style={{ color: '#22c55e', fontFamily: 'Consolas,monospace' }}>{stages.trade.stop}</b></span>
                    <span style={{ fontSize: 12, color: stages.trade.rr >= 1 ? '#4ade80' : '#f87171' }}>风险回报比 1:{stages.trade.rr}</span>
                  </>
                ) : null}
                <span style={{ fontSize: 12, color: stages.trade.approved ? '#4ade80' : '#facc15', marginLeft: 'auto' }}>{stages.trade.note}</span>
              </div>
            </div>
          )}

          {/* 第四/五阶段 风险 */}
          {stages.risk?.chief && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>第四阶段 · 风险评估（三视角）→ 第五阶段 · 风险主管终审</div>
              <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'repeat(3, 1fr)', gap: 10 }}>
                {[stages.risk.aggressive, stages.risk.conservative, stages.risk.neutral].map((r: any, i: number) => (
                  <div key={i} style={{ ...CARD, padding: '12px 14px' }}>
                    <div style={{ fontWeight: 700, fontSize: '12.5px', color: '#93c5fd' }}>{r.name}</div>
                    <div style={{ fontSize: '10.5px', color: '#64748b', fontStyle: 'italic', margin: '4px 0 6px' }}>{r.stance}</div>
                    <div style={{ fontSize: '12px', color: '#cbd5e1', lineHeight: 1.6 }}>{r.opinion ?? r.plan}</div>
                  </div>
                ))}
              </div>
              <div style={{ ...CARD, marginTop: 10, border: '1px solid rgba(96,165,250,0.35)' }}>
                <span style={{ fontWeight: 700, fontSize: '13px', color: '#93c5fd' }}>{stages.risk.chief.name}</span>
                <span style={{ fontSize: 15, fontWeight: 800, color: VERDICT_COLOR[stages.risk.chief.decision] ?? '#e2e8f0', margin: '0 12px' }}>
                  {stages.risk.chief.decision}
                </span>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>建议仓位：{stages.risk.chief.sizing}</span>
                <div style={{ fontSize: '12px', color: '#cbd5e1', marginTop: 6 }}>{stages.risk.chief.notes}</div>
              </div>
            </div>
          )}

          <div style={{ fontSize: '11px', color: '#475569', textAlign: 'center', padding: '4px 0 10px', lineHeight: 1.7 }}>
            {trace.disclaimer}
          </div>
        </div>
      )}
    </div>
  );
}
