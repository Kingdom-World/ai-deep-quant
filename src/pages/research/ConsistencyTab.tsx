// ─────────────────────────────────────────────────────────────
// 研究中心 · Tab2 一致性与对账（原 ResearchPage 的 RiskAndReconcile + ConsistencyPanel 搬移）
//
//   ⚠️ 两个组件是**两个独立数据源**（paperAccount/reconcile vs consistency），
//   仅因主题同属「可信度验证」而纵向排列于同一 Tab——勿进一步混数据（红队 Q1 裁决）。
//
//   搬移后新增（红队"作者没想到的"第 4 条）：empty-state 强化——
//   未登录 / 无运行中策略时给出明确引导文案，避免用户把空态误判为 bug。
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react';
import { researchApi, type ConsistencyEntry } from '../../api/dataService';
import { card, sectionTitle, sectionSub, input, btn, btnGhost, Metric, pctColorOf } from './shared';

function RiskAndReconcile() {
  const [acc, setAcc] = useState<Awaited<ReturnType<typeof researchApi.paperAccount>> | null>(null);
  const [rec, setRec] = useState<{ ok: boolean; issues: string[]; checkedAt: string } | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([researchApi.paperAccount(), researchApi.reconcile()]);
      setAcc(a);
      setRec(r);
    } catch {
      /* 未登录/服务未启动时静默——下方空态给出引导 */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const unlock = async () => {
    setUnlocking(true);
    try {
      const r = await researchApi.unlock();
      setMsg(r.message || '已解锁');
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setUnlocking(false);
    }
  };

  const dd = acc?.drawdownPct ?? null;
  const ddColor = (acc?.ddLevel ?? 0) >= 2 ? '#ef4444' : (acc?.ddLevel ?? 0) >= 1 ? '#f59e0b' : '#22c55e';

  return (
    <div style={card}>
      <div style={sectionTitle}>账户风险与对账</div>
      <div style={sectionSub}>
        回撤熔断以净值高水位为基准（L1 ≥10% 禁开仓，L2 ≥15% 锁定）；对账校验账本与挂单冻结的账实一致。
      </div>
      {!acc ? (
        // 空态强化（红队建议）：明确说清"为什么是空的"与"怎么让它不空"
        <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>
          未登录或后端服务未启动——这里会显示模拟盘的熔断状态、当前回撤与账实对账结果。
          <br />
          登录后刷新即可；数据来自模拟盘账户，需先在「模拟交易」页初始化账户。
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Metric name="总资产" value={`¥${acc.totalAssets.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`} />
            <Metric name="可用现金" value={`¥${(acc.availableCash ?? acc.cash).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`} />
            {acc.reservedCash ? <Metric name="挂单冻结" value={`¥${acc.reservedCash.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`} color="#f59e0b" /> : null}
            <Metric name="当前回撤" value={`${dd ?? 0}%`} color={ddColor} />
            <Metric name="熔断级别" value={`L${acc.ddLevel ?? 0}`} color={ddColor} />
          </div>
          {(acc.ddLevel ?? 0) > 0 && (
            <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, backgroundColor: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', fontSize: 12, color: '#fbbf24' }}>
              {(acc.ddLevel ?? 0) >= 2
                ? '账户已锁定：仅可卖出减仓。确认接受当前回撤后可解锁（以当前净值为新基准）。'
                : '已触发 L1 熔断：禁止新开仓，卖出减仓不受影响。净值回升自动降级。'}
              <button onClick={unlock} disabled={unlocking} style={{ ...btn, marginLeft: 12, padding: '5px 14px', backgroundColor: 'rgba(245,158,11,0.2)' }}>
                {unlocking ? '解锁中…' : '手动解锁'}
              </button>
              {msg && <span style={{ marginLeft: 8 }}>{msg}</span>}
            </div>
          )}
          <div style={{ marginTop: 12, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#64748b' }}>账实对账（{rec ? new Date(rec.checkedAt).toLocaleTimeString('zh-CN') : '—'}）：</span>
            {rec ? (
              rec.ok ? (
                <span style={{ color: '#22c55e' }}>✓ 账实一致</span>
              ) : (
                <span style={{ color: '#ef4444' }}>✗ {rec.issues.length} 项不符：{rec.issues.slice(0, 3).join('；')}</span>
              )
            ) : (
              <span style={{ color: '#64748b' }}>加载中…</span>
            )}
            <button onClick={load} style={{ ...btnGhost, padding: '3px 10px', fontSize: 11 }}>刷新</button>
          </div>
        </>
      )}
    </div>
  );
}

function ConsistencyPanel() {
  const [windowDays, setWindowDays] = useState(30);
  const [data, setData] = useState<Awaited<ReturnType<typeof researchApi.consistency>> | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (days = windowDays) => {
      setLoading(true);
      setErr('');
      try {
        setData(await researchApi.consistency(days));
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [windowDays],
  );

  useEffect(() => {
    load(windowDays);
  }, [load, windowDays]);

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={sectionTitle}>一致性报告 · 回测 vs 模拟盘</div>
          <div style={sectionSub}>同参数、同费率、同滑点口径下的三指标差异——闭环可信度的直接证据。</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} style={{ ...input, width: 110 }}>
            <option value={30}>近 30 日</option>
            <option value={60}>近 60 日</option>
            <option value={90}>近 90 日</option>
          </select>
          <button onClick={() => load()} style={{ ...btnGhost, padding: '6px 14px', fontSize: 12 }}>{loading ? '加载中…' : '刷新'}</button>
        </div>
      </div>
      {err && <div style={{ fontSize: 12, color: '#ef4444' }}>✗ {err}</div>}
      {data && data.strategies.length === 0 && (
        <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>
          还没有运行中的策略——到「模拟交易」页启动一个自动策略，产生成交后这里会出现三指标对比。
        </div>
      )}
      {data?.strategies.map((s: ConsistencyEntry) => (
        <div key={s.strategyId} style={{ marginTop: 12, padding: '12px 14px', backgroundColor: 'rgba(13,19,34,0.6)', borderRadius: 10, border: '1px solid rgba(51,65,85,0.6)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>
              {s.symbol} · {s.type} {s.status !== 'running' ? `（${s.status}）` : ''}
            </span>
            {s.decay && (
              <span style={{ fontSize: 11, color: '#fbbf24', backgroundColor: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 6, padding: '2px 8px' }}>
                ⚠ 衰减信号：{s.decay}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
            <Metric name="模拟盘净盈亏" value={`¥${s.paper.realized.toLocaleString('zh-CN')}`} color={pctColorOf(s.paper.realized)} />
            <Metric name="平仓笔数" value={s.paper.closedTrades} />
            <Metric name="模拟盘费率" value={`${s.paper.feeRatePct}%`} />
            {s.deltas ? (
              <>
                <Metric name="收益差(pp)" value={s.deltas.returnDiffPct} color={pctColorOf(s.deltas.returnDiffPct)} />
                <Metric name="笔数差" value={s.deltas.tradeCountDiff} />
                <Metric name="费率差(pp)" value={s.deltas.feeRateDiffPct} />
              </>
            ) : (
              <Metric name="回测对比" value={s.backtest.skipped ? '无对应口径' : '数据不足'} color="#64748b" />
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: '#64748b' }}>
            成本归因：净已实现 ¥{s.costAttribution.netRealized.toLocaleString('zh-CN')} = 价差毛盈亏 ¥{s.costAttribution.grossPricePnl.toLocaleString('zh-CN')} − 成本 ¥{s.costAttribution.costs.toLocaleString('zh-CN')}
            {s.paper.winRate !== null && ` · 胜率 ${s.paper.winRate}%`}
          </div>
        </div>
      ))}
      {data && data.strategyCount > 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: '#475569' }}>
          生成于 {new Date(data.generatedAt).toLocaleString('zh-CN')} · 衰减信号 {data.decayCount} 个 · 每日自检同时落盘 reports/consistency-latest.json
        </div>
      )}
    </div>
  );
}

export default function ConsistencyTab() {
  return (
    <>
      <RiskAndReconcile />
      <ConsistencyPanel />
    </>
  );
}
