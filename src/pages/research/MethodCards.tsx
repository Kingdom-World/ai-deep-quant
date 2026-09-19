// ─────────────────────────────────────────────────────────────
// 研究中心 · 方法论卡片（原 ResearchPage.MethodCards 搬移）
//
//   搬移后新增（红队 R-C 采纳）：**可折叠、默认收起**——
//   6 张教学卡约占一屏，常驻会把每个 Tab 的首屏信息密度稀释掉；
//   收起后保留一行入口，任何 Tab 都能展开（可达性不变，噪声消失）。
// ─────────────────────────────────────────────────────────────
import { useState } from 'react';
import { card, sectionTitle, sectionSub, btnGhost } from './shared';

const METHODS = [
  {
    t: 'Point-in-Time（时点数据）',
    d: '财务数据按「披露日 pubDate」而非报告期入库——在 8 月 15 日你只可能知道 8 月 15 日前披露的财报。平台财务快照只增不改，随时间积累成真正的 PIT 库；行情归档存「不复权价+复权因子」，先固定原始事实再按需推导。',
  },
  {
    t: '费率与滑点口径',
    d: '回测、模拟盘、横截面共用同一张费率表：佣金万2.5（最低5元）+ 印花税万5（仅卖出，2023-08-28 起现行税率）+ 过户费万0.1（双边）。回测滑点默认单边 0.1%——零滑点的回测收益是幻觉。',
  },
  {
    t: '回撤熔断语义',
    d: 'L1（回撤≥10%）：禁止新开仓，卖出减仓放行——风控只挡"加风险"，不挡"降风险"。L2（≥15%）：账户锁定需手动解锁。解锁以当前净值为新基准，意味着你"接受"了这段回撤。',
  },
  {
    t: '复权口径与假跳空',
    d: '前复权数据会随每次除权整体平移，一年前的前复权价与今天对不上；不复权数据在除权日有真实跳空。看主源失败回退备用源时，页面会显式标注实际口径——假跳空被当成真实价格是新手最常见的回测幻觉之一。',
  },
  {
    t: '数据降级必须可见',
    d: '上游行情挂掉时本地归档兜底，但响应带 source/stale 标注，页面显示实际数据来源。"静默降级"（看起来有数据其实已过期）比没数据更危险。',
  },
  {
    t: '账实一致与对账',
    d: '挂单冻结资金与持仓、撤单/GFD 过期释放、成交按实际价结算——每次改动账本都跑对账断言（现金=现金、冻结=冻结、每笔成交有明细）。对账是事后风控的底线动作。',
  },
];

export default function MethodCards() {
  const [open, setOpen] = useState(false);

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={sectionTitle}>平台方法论 · 口径即教材</div>
          <div style={sectionSub}>这个平台的所有数字都遵循以下口径——理解它们比看任何指标都重要。</div>
        </div>
        <button onClick={() => setOpen(!open)} style={{ ...btnGhost, padding: '6px 14px', fontSize: 12 }}>
          {open ? '收起 ▴' : '展开口径说明 ▸'}
        </button>
      </div>
      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginTop: 6 }}>
          {METHODS.map((m) => (
            <div key={m.t} style={{ padding: '12px 14px', backgroundColor: 'rgba(13,19,34,0.6)', borderRadius: 10, border: '1px solid rgba(51,65,85,0.6)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa', marginBottom: 6 }}>{m.t}</div>
              <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7 }}>{m.d}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
