// ─────────────────────────────────────────────────────────────
// 研究中心 · 能力边界（名实校准）
//
//   为什么要有这张卡：本模块叫「研究中心」，但页头若不说明它**能做什么、不能做什么**，
//   页面就在用名字许诺它做不到的事——用的人会把"能回测"误当"能研究"。
//   因此这张卡主动声明边界：**诚实是最低成本的信用**。
//
//   ⚠️ 对外文案纪律（2026-09-22）：本卡**只描述能力本身**，不得出现
//   部署平台、运行环境、函数时限、步数、本地版等**实现细节**，
//   也不得引用内部计划书/阶段代号。项目仓库是公开的，注释同样受此约束。
// ─────────────────────────────────────────────────────────────
import { useState } from 'react';
import { card, sectionTitle, sectionSub, btnGhost } from './shared';

type State = 'done' | 'partial' | 'todo';

const MARK: Record<State, { icon: string; color: string }> = {
  done: { icon: '✓', color: '#22c55e' },
  partial: { icon: '△', color: '#f59e0b' },
  todo: { icon: '✗', color: '#ef4444' },
};

/** 能力现状（**必须与实际交付一致**——过时的"未完成"声明既是误导，也是不必要的信息外露） */
const CAPS: { name: string; state: State; note: string }[] = [
  { name: '回测与验证', state: 'done', note: '实验留痕 · 四要素指纹 · 复现承诺 · 等权基准' },
  { name: '参数稳健性', state: 'done', note: '孤峰判据 · 样本外验证 · 成本敏感度（三防）' },
  { name: '数据管理', state: 'done', note: 'PIT 财务（按披露日只增不改）· 归档每日同步 · 官方 pctChg 裁决' },
  { name: '知识层', state: 'done', note: '带出处的结构化条目 + 检索接口 + Agent 可引用' },
  { name: '验证深度', state: 'done', note: '分层回测与单调性 · IC/IR · Newey-West 显著性检验' },
  { name: '因子研发', state: 'partial', note: '因子表达式沙箱已可用（白名单算子，自造因子）；策略仍为预置（双均线/RSI/持有/网格）' },
];

/** LLM 能力三档：划分依据是"谁出算力、谁担风险"对齐到同一方 */
const TIERS: { name: string; who: string }[] = [
  { name: '规则引擎', who: '无需任何 API Key，全部由确定性规则计算；所有用户可用' },
  { name: '自配 API', who: '使用你自己的 Key，请求由浏览器直接发往供应商，不经过本站；所有用户可用' },
  { name: '平台 LLM', who: '使用平台预置模型；仅管理员可用' },
];

export default function CapabilityBoundaryCard() {
  const [open, setOpen] = useState(false);
  const doneCount = CAPS.filter((c) => c.state === 'done').length;
  const total = CAPS.length;

  return (
    <div style={{ ...card, borderColor: 'rgba(96,165,250,0.35)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={sectionTitle}>能力边界</div>
          <div style={{ ...sectionSub, marginBottom: 0 }}>
            当前 {doneCount}/{total} 项达标。这是一个研究平台，先把"做不到什么"讲清楚。
          </div>
        </div>
        <button onClick={() => setOpen(!open)} style={{ ...btnGhost, padding: '6px 14px', fontSize: 12 }}>
          {open ? '收起 ▴' : '展开看边界 ▸'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>能力现状</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {CAPS.map((c) => {
              const m = MARK[c.state];
              return (
                <div
                  key={c.name}
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'flex-start',
                    padding: '9px 12px',
                    backgroundColor: 'rgba(13,19,34,0.6)',
                    borderRadius: 8,
                    border: `1px solid ${m.color}33`,
                  }}
                >
                  <span style={{ color: m.color, fontWeight: 900, fontSize: 14, lineHeight: '20px', width: 14, textAlign: 'center' }}>{m.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7, marginTop: 2 }}>{c.note}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 12, color: '#94a3b8', margin: '16px 0 8px' }}>AI 分析三档</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {TIERS.map((t) => {
              const m = MARK.done;
              return (
                <div key={t.name} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', backgroundColor: 'rgba(13,19,34,0.6)', borderRadius: 8, border: `1px solid ${m.color}33` }}>
                  <span style={{ color: m.color, fontWeight: 900, fontSize: 14, lineHeight: '20px', width: 14, textAlign: 'center' }}>{m.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{t.name}</div>
                    <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7, marginTop: 2 }}>{t.who}</div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: '#64748b', lineHeight: 1.8 }}>
            三档的划分依据是<b style={{ color: '#94a3b8' }}>谁出算力、谁担风险</b>对齐到同一方：
            规则引擎无需算力，自配 API 由使用者自担，平台 LLM 由平台承担故仅管理员可用。
            自配 API 为单角色分析，不参与多角色流水线，也不调用工具。
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: '#64748b', lineHeight: 1.8 }}>
            ⚠️ 公网演示版仅开放**单角色**分析；多角色流水线耗时长，不在演示版提供。
            需要完整的确定性分析请使用「规则引擎」档——它不依赖任何外部模型。
          </div>
        </div>
      )}
    </div>
  );
}
