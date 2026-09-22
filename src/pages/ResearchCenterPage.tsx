// ─────────────────────────────────────────────────────────────
// 研究中心（信息架构收敛）：研究工作台 / 实验对比 / 因子稳健性 三页合一
//
//   关键设计（红队对抗审查后的 v2 修订）：
//
//   ① 条件渲染，只挂载激活 Tab（红队 R-A）——
//      echarts 永远在可见容器里 init，0 尺寸风险从根上消失；
//      代价是切 Tab 会卸载子树，故对"用户跑出来的结果"做模块级缓存（见 CrossSectionTab），
//      列表类数据（实验列表 / 因子评估）幂等重拉可接受，不为其引入缓存复杂度。
//
//   ② 扁平子路由（/research[/:tab]），旧路由 /experiments、/factor-eval
//      在 App.tsx 用 <Navigate replace> 兼容（红队 R-D：SPA 无真 301）。
//
//   ③ 窄屏断点统一（红队"作者没想到的"第 5 条）——原三页只有 ExperimentsPage 有 isNarrow，
//      合并后由本页统一提供断点，四个 Tab 体验一致。
//
//   ④ Agent 研究不放 Tab4（红队 R-B：语义错位），放全局页脚 + Tab1 结果区双入口。
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { theme } from '../lib/theme';
import CrossSectionTab from './research/CrossSectionTab';
import ConsistencyTab from './research/ConsistencyTab';
import ExperimentsTab from './research/ExperimentsTab';
import FactorEvalTab from './research/FactorEvalTab';
import KnowledgeTab from './research/KnowledgeTab';
import CapabilityBoundaryCard from './research/CapabilityBoundaryCard';
import MethodCards from './research/MethodCards';

const TABS = [
  { key: '', label: '横截面回测' },
  { key: 'consistency', label: '一致性与对账' },
  { key: 'experiments', label: '实验对比' },
  { key: 'factors', label: '因子稳健性' },
  { key: 'knowledge', label: '知识库' },
];

export default function ResearchCenterPage({ tab = '' }: { tab?: string }) {
  // 统一窄屏断点（与 ExperimentsTab 原 720px 阈值一致）
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 720 : false,
  );
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div style={{ minHeight: '100vh', color: '#e2e8f0' }}>
      <div style={isNarrow ? theme.pageWrapNarrow : theme.pageWrap}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: '#f1f5f9' }}>研究中心</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
            做实验 → 验可信 → 看历史 → 评因子 → 查口径：不只有数字，还有数字背后的定义与出处。
          </div>
        </div>

        {/* 能力边界与路线图（M1：名实校准 —— 不回避"当前做不到什么"） */}
        <CapabilityBoundaryCard />

        {/* Tab 栏 */}
        <div
          style={{
            display: 'flex',
            gap: 2,
            flexWrap: isNarrow ? 'wrap' : 'nowrap',
            overflowX: 'auto',
            borderBottom: '1px solid #1e293b',
            marginBottom: 16,
          }}
        >
          {TABS.map((t) => {
            const active = t.key === tab;
            const to = t.key ? `/research/${t.key}` : '/research';
            return (
              <Link
                key={t.key || 'cross'}
                to={to}
                style={{
                  padding: isNarrow ? '7px 10px' : '9px 16px',
                  fontSize: 13,
                  whiteSpace: 'nowrap',
                  color: active ? '#60a5fa' : '#94a3b8',
                  fontWeight: active ? 700 : 400,
                  borderBottom: active ? '2px solid #60a5fa' : '2px solid transparent',
                  textDecoration: 'none',
                }}
              >
                {t.label}
              </Link>
            );
          })}
        </div>

        {/* 条件渲染：只挂载激活 Tab（红队 R-A） */}
        {tab === '' && <CrossSectionTab />}
        {tab === 'consistency' && <ConsistencyTab />}
        {tab === 'experiments' && <ExperimentsTab />}
        {tab === 'factors' && <FactorEvalTab />}
        {tab === 'knowledge' && <KnowledgeTab />}

        {/* 方法论：可折叠、默认收起（红队 R-C） */}
        <MethodCards />

        {/* 全局页脚入口（红队 R-B：Agent 研究与数据研究不同质，全局位即可达） */}
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Link to="/agent-research" style={{ color: '#60a5fa' }}>
            🔬 Agent 研究 —— 用一句话让 Alpha 自主调用工具取证并给出结论
          </Link>
        </div>
      </div>
    </div>
  );
}
