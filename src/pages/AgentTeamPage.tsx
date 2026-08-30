// ─────────────────────────────────────────────────────────────
// Agent 团队股票分析（独立功能页 /agents）
//   主理人调度制五阶段流水线：数据收集 → 多空辩论 → 交易决策 → 风险评估 → 终审
// ─────────────────────────────────────────────────────────────
import TopNav from '../components/TopNav';
import AgentTeamPanel from '../components/AgentTeamPanel';
import { theme } from '../lib/theme';

export default function AgentTeamPage() {
  return (
    <div style={{ ...theme.page, padding: '20px 24px 44px' }}>
      <TopNav />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0 4px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '20px', margin: 0 }}>🤖 Agent 团队股票分析</h1>
        <span style={{ fontSize: '12px', color: '#f59e0b', fontWeight: 600 }}>学术研究演示 · 不构成投资建议</span>
      </div>
      <p style={{ fontSize: '12.5px', color: '#64748b', margin: '4px 0 16px', maxWidth: 960, lineHeight: 1.8 }}>
        五阶段流水线：数据收集（技术 / 基本面 / 公告 / 情绪 四分析师并行）→ 多空辩论（研究主管强制给出 BUY / SELL / HOLD）→
        交易决策（风险回报比审核）→ 风险评估（激进 / 保守 / 中性三视角）→ 风险主管终审。
        财务 / 公告 / 资金数据来自东方财富公开接口，未覆盖的市场与数据自动降级为价格行为代理并明确标注。
      </p>
      <div style={{ maxWidth: 1120 }}>
        <AgentTeamPanel defaultSymbol="sh600519" />
      </div>
    </div>
  );
}
