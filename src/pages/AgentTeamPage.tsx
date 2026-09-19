// ─────────────────────────────────────────────────────────────
// Agent 团队页（/agents）：面板 + 历史报告列表
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import { fmtDateTime } from '../lib/time';
import { Link, useNavigate } from 'react-router-dom';
import TopNav from '../components/TopNav';
import AgentTeamPanel from '../components/AgentTeamPanel';
import { theme } from '../lib/theme';
import { agentsApi } from '../api/dataService';

const CARD = {
  backgroundColor: 'rgba(17,24,39,0.6)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(96,165,250,0.16)',
  borderRadius: '12px',
  padding: '14px 16px',
} as const;

const MODE_NAMES: Record<string, string> = {
  full: '完整分析',
  quick: '快速分析',
  debate: '辩论模式',
  risk: '风险诊断',
  single: '单点调用',
};

const DECISION_COLOR: Record<string, string> = {
  BUY: '#ef4444',
  SELL: '#22c55e',
  HOLD: '#facc15',
  观望: '#94a3b8',
  '降级·分批试探': '#f59e0b',
  '——': '#94a3b8',
};

export default function AgentTeamPage() {
  const navigate = useNavigate();
  const [history, setHistory] = useState<{ id: string; symbol: string; name?: string; mode: string; decision: string; ranAt: string }[]>([]);

  useEffect(() => {
    agentsApi
      .list()
      .then((r) => setHistory(r.list ?? []))
      .catch(() => {});
  }, []);

  const removeReport = async (id: string, symbol: string) => {
    if (!window.confirm(`确定删除报告 ${id}（${symbol}）？删除后不可恢复。`)) return;
    try {
      const r = await agentsApi.remove(id);
      if (!r.ok) throw new Error(r.error || '删除失败');
      setHistory((prev) => prev.filter((h) => h.id !== id));
    } catch (e) {
      window.alert((e as Error).message);
    }
  };

  return (
    <div style={{ ...theme.page }}>
      <TopNav />
      <div style={{ padding: '20px 24px 44px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0 4px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '20px', margin: 0 }}>🤖 Agent 团队股票分析</h1>
        <span style={{ fontSize: '12px', color: '#f59e0b', fontWeight: 600 }}>学术研究演示 · 不构成投资建议</span>
      </div>
      <p style={{ fontSize: '12.5px', color: '#64748b', margin: '4px 0 16px', maxWidth: 960, lineHeight: 1.8 }}>
        五阶段流水线：数据收集（技术 / 基本面 / 公告与新闻 / 情绪 四分析师并行）→ 多空辩论（两轮，研究主管强制给出 BUY / SELL / HOLD）→
        交易决策（场景推演 + 风险回报比审核）→ 风险评估（激进 / 保守 / 中性三视角辩论）→ 风险主管终审。
        财务 / 公告 / 资金流 / 融资融券数据来自东方财富公开接口，未覆盖的市场与数据自动降级为价格行为代理并明确标注。
      </p>
      <div>
        {/* P3-P4：Agent 研究入口（导航收敛后由此进入） */}
        <div
          style={{
            ...CARD,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginBottom: 16,
            fontSize: 12.5,
            color: '#94a3b8',
          }}
        >
          <span style={{ fontWeight: 700, color: '#f1f5f9' }}>🔬 Agent 研究</span>
          <span>用一句话提问，Alpha 技术分析师会自主调用 K 线 / 回测 / 参数稳健性工具取证后给出结论（每步带数据指纹）。</span>
          <Link to="/agent-research" style={{ color: '#60a5fa', fontWeight: 600, whiteSpace: 'nowrap' }}>
            进入 Agent 研究 →
          </Link>
        </div>

        <AgentTeamPanel defaultSymbol="sh600519" />

        {/* 历史报告 */}
        <div style={{ ...CARD, marginTop: 16 }}>
          <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '10px' }}>🗂️ 历史报告</div>
          {history.length === 0 ? (
            <div style={{ fontSize: '12.5px', color: '#475569' }}>暂无历史报告——运行一次分析后，这里会保留每次团队运行的完整报告链接。</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.map((h) => (
                <div
                  key={h.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12.5, backgroundColor: 'rgba(13,19,34,0.7)', borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }}
                  onClick={() => navigate(`/agents/report/${h.id}`)}
                >
                  <span style={{ color: DECISION_COLOR[h.decision] ?? '#e2e8f0', fontWeight: 800, width: 90 }}>{h.decision}</span>
                  <span style={{ color: '#e2e8f0' }}>{h.symbol}{h.name ? `（${h.name}）` : ''}</span>
                  <span style={{ color: '#64748b' }}>{MODE_NAMES[h.mode] ?? h.mode}</span>
                  <span style={{ marginLeft: 'auto', color: '#475569' }}>{fmtDateTime(h.ranAt)}</span>
                  <span style={{ color: '#60a5fa' }}>查看报告 →</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeReport(h.id, h.symbol);
                    }}
                    title="删除此报告"
                    style={{ padding: '3px 10px', fontSize: 11, color: '#f87171', backgroundColor: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 6, cursor: 'pointer' }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
