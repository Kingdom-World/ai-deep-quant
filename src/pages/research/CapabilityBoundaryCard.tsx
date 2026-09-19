// ─────────────────────────────────────────────────────────────
// 研究中心 · 能力边界与路线图（M1-1.6，对应验收 G4 名实校准）
//
//   为什么必须有这张卡（而非"以后再说"）：
//   本模块叫「研究中心」，但评估结论是它**目前实质是回测与验证中心**——
//   研发环（自造因子/策略）与知识环（口径与文献出处）此前缺失。
//   页头若不说明这一点，页面就在用名字许诺它做不到的事：
//     · 对外汇报/答辩时会被问"你们的知识库在哪"而无言以对；
//     · 用的人会把"能回测"误当"能研究"，把有限的验证能力当成全流程能力。
//   因此这张卡主动声明边界——**诚实是最低成本的信用**。
//
//   卡片随阶段推进更新（M1 已完成项标 ✓），与云端计划书同源同口径。
// ─────────────────────────────────────────────────────────────
import { useState } from 'react';
import { card, sectionTitle, sectionSub, btnGhost } from './shared';

type State = 'done' | 'partial' | 'todo';

const MARK: Record<State, { icon: string; color: string }> = {
  done: { icon: '✓', color: '#22c55e' },
  partial: { icon: '△', color: '#f59e0b' },
  todo: { icon: '✗', color: '#ef4444' },
};

/** 能力现状（与云端计划书「一、现状与问题分析」同源；阶段完成后更新 state 与 note） */
const CAPS: { name: string; state: State; note: string }[] = [
  { name: '回测与验证', state: 'done', note: '实验留痕 · 四要素指纹 · 复现承诺 · 等权基准' },
  { name: '参数稳健性', state: 'done', note: '孤峰判据 · 样本外验证 · 成本敏感度（三防）' },
  { name: '数据管理', state: 'done', note: 'PIT 财务（按披露日只增不改）· 归档每日同步 · 官方 pctChg 裁决' },
  { name: '知识层', state: 'done', note: '本 Tab：39 条带出处条目 + 检索接口 + Agent 可引用' },
  { name: '验证深度', state: 'partial', note: '缺分层回测、IC/IR 与显著性检验——因子只有"赚不赚"没有"是否显著"' },
  { name: '研发能力', state: 'todo', note: '策略硬编码（ma/rsi/buyhold/combo），尚不能自造因子/策略——研究最核心的创造环节' },
];

/**
 * LLM 能力三档（L1 落地，非计划书原定范围）
 *   诚实边界：T2/T3 都不解决 Serverless 30 秒上限 → 只有 single(1 步) 能跑，
 *   quick(7)/debate(10)/risk(10)/full(15) 在 Vercel 上均超时，必须本机版。
 */
const TIERS: { key: string; name: string; who: string; state: State }[] = [
  { key: 'T1', name: '规则引擎', who: '无需 LLM，服务端纯计算；所有用户可用', state: 'done' },
  { key: 'T2', name: '自配 API', who: '你的 Key，浏览器直连供应商，不经本站；所有用户可用', state: 'done' },
  { key: 'T3', name: '平台 LLM', who: '平台预置模型，消耗平台额度；仅管理员可用', state: 'done' },
];

/** 路线图（与云端计划书「三、改进措施」一致） */
const ROADMAP: { phase: string; title: string; goal: string; state: State }[] = [
  { phase: 'M1', title: '知识库 + 名实校准', goal: '结构化条目 + 检索 + Agent 引用 + 本卡', state: 'done' },
  { phase: 'L1', title: 'LLM 能力三档（前置项）', goal: '规则引擎 / 自配 API / 平台 LLM 分层，算力与风险对齐', state: 'done' },
  { phase: 'M2', title: '验证深度', goal: '5 层分层回测 + 单调性 · IC/IR · Newey-West 显著性检验', state: 'todo' },
  { phase: 'M3', title: '策略研发', goal: '因子表达式沙箱（白名单算子 + 递归下降 AST，绝不用 eval）', state: 'todo' },
];

export default function CapabilityBoundaryCard() {
  const [open, setOpen] = useState(false);
  // 达标数 = 研究能力 + LLM 三档（三档全部落地，故计入总数）
  const total = CAPS.length + TIERS.length;
  const doneCount = CAPS.filter((c) => c.state === 'done').length + TIERS.filter((t) => t.state === 'done').length;

  return (
    <div style={{ ...card, borderColor: 'rgba(96,165,250,0.35)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={sectionTitle}>能力边界与路线图</div>
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

          <div style={{ fontSize: 12, color: '#94a3b8', margin: '16px 0 8px' }}>LLM 能力三档</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {TIERS.map((t) => {
              const m = MARK[t.state];
              return (
                <div key={t.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', backgroundColor: 'rgba(13,19,34,0.6)', borderRadius: 8, border: `1px solid ${m.color}33` }}>
                  <span style={{ color: m.color, fontWeight: 900, fontSize: 14, lineHeight: '20px', width: 14, textAlign: 'center' }}>{m.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>
                      {t.key} · {t.name}
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7, marginTop: 2 }}>{t.who}</div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: '#64748b', lineHeight: 1.8 }}>
            三档的划分依据是<b style={{ color: '#94a3b8' }}>谁出算力、谁担风险</b>对齐到同一方：T1 无需算力，
            T2 用户自担，T3 平台自担故仅管理员。T2 为单角色分析，不参与多角色流水线，也不调用工具。
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: '#64748b', lineHeight: 1.8 }}>
            ⚠️ 三档都不解决 Serverless 的 30 秒函数上限：只有 single（1 步）可在 Vercel 跑通，
            quick（7 步）/ debate（10 步）/ risk（10 步）/ full（15 步）需使用本机版。
          </div>

          <div style={{ fontSize: 12, color: '#94a3b8', margin: '16px 0 8px' }}>路线图</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {ROADMAP.map((r) => {
              const m = MARK[r.state];
              return (
                <div key={r.phase} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', backgroundColor: 'rgba(13,19,34,0.6)', borderRadius: 8, border: `1px solid ${m.color}33` }}>
                  <span style={{ color: m.color, fontWeight: 900, fontSize: 14, lineHeight: '20px', width: 14, textAlign: 'center' }}>{m.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>
                      {r.phase} · {r.title}
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7, marginTop: 2 }}>{r.goal}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 14, fontSize: 11, color: '#64748b', lineHeight: 1.8 }}>
            说明：本卡与《「研究中心」能力补齐改进计划书》同源。阶段完成后本卡与计划书同步更新——
            两处口径若不一致，视为缺陷。
          </div>
        </div>
      )}
    </div>
  );
}
