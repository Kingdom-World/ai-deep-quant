// ─────────────────────────────────────────────────────────────
// Agent 团队分析面板（主理人调度制 · 五阶段流水线可视化）
//   · 供首页 / 量化因子分析页复用
//   · 13 角色由云端大模型分饰（记忆隔离，信息经主理人中转），异步任务轮询进度
//   · 能力三档（L1.5，方案书「十一」）：
//       T1 规则引擎 —— 无需任何 Key，全部用户可用（确定性计算，LLM 不参与）
//       T2 自配 API —— 用户自己的 Key，浏览器直连供应商，不经过本站服务器
//       T3 平台 LLM —— 平台预置免费模型，仅管理员；且受运行时限约束
//   · 合规声明：LLM + 规则引擎协作的学术研究演示，非投资建议
// ─────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  agentsApi,
  authApi,
  ApiError,
  type AgentTrace,
  type AgentTier,
  type AgentCapabilities,
} from '../api/dataService';
import {
  PROVIDERS,
  SUGGESTED_MODELS,
  createConfigStore,
  maskKey,
  TIER_NOTES,
} from '../../shared/llm-config.mjs';
import { buildUserMessage, callDirect, DIRECT_ERRORS } from '../../shared/llm-direct.mjs';

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

/** 档位元信息：label/副标题/配色的单一来源，避免 Tab 与回显两处文案分叉 */
const TIER_META: Record<AgentTier, { label: string; short: string; color: string }> = {
  rule: { label: '规则引擎', short: '确定性计算 · 无需 Key', color: '#94a3b8' },
  byok: { label: '自配 API', short: '你的 Key · 浏览器直连', color: '#60a5fa' },
  platform: { label: '平台 LLM', short: '预置模型 · 仅管理员', color: '#c084fc' },
};

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

/**
 * 档位标识徽章。**结果区必须回显实际档位** —— 这是「不能让规则产出被误读为
 * 大模型分析」这条铁律在 UI 层的落点（与 trace.degraded 提示配套使用）。
 */
function TierBadge({ tier, note }: { tier: AgentTier; note?: string }) {
  const m = TIER_META[tier] ?? TIER_META.rule;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: m.color,
          border: `1px solid ${m.color}66`,
          backgroundColor: `${m.color}14`,
          borderRadius: 999,
          padding: '2px 10px',
        }}
      >
        {m.label}
      </span>
      {note && <span style={{ fontSize: 11, color: '#64748b' }}>{note}</span>}
    </div>
  );
}


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

  // ── 能力档位（L1.5）──
  const [caps, setCaps] = useState<AgentCapabilities | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tier, setTier] = useState<AgentTier>('rule');
  /** 结果区回显：本次实际使用的档位（与用户当次选择分离，避免中途切档造成误读） */
  const [usedTier, setUsedTier] = useState<AgentTier | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const configStore = useMemo(() => createConfigStore(typeof localStorage !== 'undefined' ? localStorage : null), []);

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

  // 能力档位与身份：一次拉取（纯声明接口，无额度消耗）
  useEffect(() => {
    authApi
      .me()
      .then((m) => {
        if (!mountedRef.current) return;
        setIsAdmin(!!m.isAdmin);
      })
      .catch(() => {});
    agentsApi
      .capabilities()
      .then((c) => {
        if (!mountedRef.current) return;
        setCaps(c);
        // 档位默认值按可用性推导：平台档仅管理员，否则退回规则引擎
        const platformOk = c.tiers?.find((t) => t.key === 'platform')?.available;
        setTier(platformOk ? 'platform' : 'rule');
      })
      .catch(() => {});
  }, []);

  /** 平台档非管理员不可见；能力接口未就绪时按「仅规则引擎」保守渲染 */
  const visibleTiers = useMemo<AgentTier[]>(() => {
    if (!caps) return ['rule'];
    return caps.tiers.filter((t) => t.available).map((t) => t.key);
  }, [caps]);

  /** 当前档位下该模式是否可跑（公网演示版对 platform 档只放行 single） */
  const modeCheck = (m: string) => {
    if (tier !== 'platform') return { available: true as const };
    return caps?.modes?.[m] ?? { available: true as const };
  };
  const curModeBlocked = !modeCheck(mode).available;

  const run = async () => {
    if (loading) return;
    if (tier === 'byok') {
      setNotice(DIRECT_ERRORS.NO_CONFIG.replace('尚未配置 API Key，请', '请先'));
      return;
    }
    if (curModeBlocked) {
      setError(`「${MODES.find((m) => m.key === mode)?.name}」在当前运行环境不可用：${(modeCheck(mode) as any).reason || '超出运行时限'}`);
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    setTrace(null);
    setUsedTier(null);
    setProgress({ step: 0, total: 15, stage: tier === 'rule' ? '正在执行规则引擎' : '任务已受理，正在准备数据' });
    try {
      const r = await agentsApi.analyze({
        symbol: symbol.trim(),
        mode,
        // 档位随请求下传：rule 走后端规则引擎短路，platform 走后端 LLM 流水线。
        // T2(byok) 不在此路径——由下方 T2Panel 在浏览器内直连，请求不经本站。
        tier,
        ...(mode === 'single' ? { agent } : {}),
        ...(mode === 'risk' && entryPrice ? { entryPrice: Number(entryPrice) } : {}),
      });
      if (!r.ok) throw new Error(r.error || '分析失败');
      // 同步返回（规则引擎路径；后端已在响应里打 tier:'rule'）
      if ((r as any).stages) {
        setTrace(r);
        setUsedTier((r as any).tier ?? 'rule');
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
              setUsedTier((j.trace as any).tier ?? 'platform');
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
        // 403/503 是「能力边界声明」而非故障：读结构化体给出可操作指引
        const body = ApiError.bodyOf(e);
        if (body?.availableTiers?.length) {
          const names = (body.availableTiers as AgentTier[]).map((t) => TIER_META[t]?.label ?? t).join(' 或 ');
          setNotice(`本次请求的档位不可用。当前可用档位：${names}。`);
          const first = (body.availableTiers as AgentTier[]).find((t) => visibleTiers.includes(t));
          if (first && first !== tier) setTier(first);
        }
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

      {/* ── 能力档位选择（T1/T2/T3）── */}
      <div style={{ ...CARD, marginBottom: '10px', padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#93c5fd' }}>能力档位</span>
          {visibleTiers.map((t) => {
            const m = TIER_META[t];
            const active = tier === t;
            return (
              <button
                key={t}
                onClick={() => {
                  setTier(t);
                  setError(null);
                  setNotice(null);
                }}
                title={TIER_NOTES[t]}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: active ? 700 : 500,
                  color: active ? m.color : '#94a3b8',
                  backgroundColor: active ? `${m.color}18` : 'transparent',
                  border: `1px solid ${active ? `${m.color}88` : '#33415588'}`,
                  borderRadius: 8,
                  cursor: 'pointer',
                }}
              >
                {m.label}
              </button>
            );
          })}
          {caps && (
            <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>
              运行环境：{caps.runtime === 'public' ? '公网演示版' : '完整版'}
            </span>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 11.5, color: '#64748b', lineHeight: 1.65 }}>
          {TIER_META[tier].short} —— {TIER_NOTES[tier]}
        </div>
        {/* 非管理员看不到平台档，需说明原因（避免"我的界面少了东西"的困惑） */}
        {caps && !isAdmin && (
          <div style={{ marginTop: 4, fontSize: 11, color: '#475569' }}>
            「平台 LLM」档仅管理员可用（消耗平台侧额度）。
          </div>
        )}
      </div>

      {/* ── T2：自配 API 配置与直连分析 ── */}
      {tier === 'byok' && <ByokPanel store={configStore} symbol={symbol} symbolName={trace?.name} />}

      {/* ── 控制台 ── */}
      <div style={{ ...CARD, marginBottom: '14px', opacity: tier === 'byok' ? 0.92 : 1 }}>
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
            {MODES.map((m) => {
              const blocked = tier === 'platform' && !modeCheck(m.key).available;
              return (
                <option key={m.key} value={m.key} disabled={blocked}>
                  {m.name}{blocked ? '（当前环境不可用）' : ''}
                </option>
              );
            })}
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
            disabled={loading || tier === 'byok' || curModeBlocked}
            title={tier === 'byok' ? '自配 API 档请使用上方配置面板直连分析' : curModeBlocked ? '当前运行环境不支持该模式' : ''}
            style={{ padding: '9px 20px', fontSize: '13px', fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,#1d4ed8,#60a5fa)', border: 'none', borderRadius: 8, cursor: loading || tier === 'byok' || curModeBlocked ? 'not-allowed' : 'pointer', opacity: loading || tier === 'byok' || curModeBlocked ? 0.5 : 1 }}
          >
            {loading ? '团队协作中…' : '🚀 召集团队'}
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: '11px', color: '#64748b' }}>
          {tier === 'byok'
            ? '自配 API 档为单角色直连模式，请使用上方面板；下方的流水线模式不适用于该档位。'
            : curModeBlocked
              ? (modeCheck(mode) as any).reason
              : `${MODES.find((m) => m.key === mode)?.desc} · 多视角交叉验证 · 研究主管强制给出 BUY / SELL / HOLD 结论`}
        </div>
      </div>

      {error && (
        <div style={{ ...CARD, borderColor: '#7f1d1d', color: '#f87171', marginBottom: 14 }}>✗ {error}</div>
      )}
      {notice && (
        <div style={{ ...CARD, borderColor: 'rgba(96,165,250,0.45)', color: '#93c5fd', marginBottom: 14, fontSize: 12 }}>
          ℹ {notice}
        </div>
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
          {/* 实际档位回显（必须有：否则规则产出会被误读为大模型分析） */}
          {usedTier && (
            <div style={{ ...CARD, marginBottom: 10, padding: '10px 14px' }}>
              <TierBadge
                tier={usedTier}
                note={
                  usedTier === 'platform'
                    ? '本次由平台预置云端模型分饰各角色'
                    : usedTier === 'byok'
                      ? '本次由你的 API Key 直连供应商产出'
                      : '本次全部由本机规则引擎计算产出，LLM 未参与'
                }
              />
            </div>
          )}

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

// ─────────────────────────────────────────────────────────────
// T2：自配 API 面板（L1.5）
//
//   关键承诺（与 shared/llm-config.mjs / llm-direct.mjs 同口径）：
//     · Key 只存本机浏览器 localStorage，**不上传本站服务器**；
//     · 请求由浏览器**直接发往供应商**，本站不中转、不记录；
//     · 单角色单轮，不参与流水线、不做辩论、不调工具 —— 边界已写进系统提示并要求模型告知。
// ─────────────────────────────────────────────────────────────
function ByokPanel({ store, symbol, symbolName }: { store: any; symbol: string; symbolName?: string }) {
  const [provider, setProvider] = useState('zhipu');
  const [base, setBase] = useState(PROVIDERS.zhipu.base);
  const [model, setModel] = useState(SUGGESTED_MODELS.zhipu[0] ?? '');
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState<{ provider: string; model: string; masked: string } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // 读回已保存配置（**只读回掩码用于展示，不把完整 key 写进 state 之外的任何地方**）
  useEffect(() => {
    const cfg = store.load();
    if (cfg && cfg.key) {
      setProvider(cfg.provider);
      setBase(cfg.base);
      setModel(cfg.model);
      setSaved({ provider: cfg.provider, model: cfg.model, masked: maskKey(cfg.key) });
    }
  }, [store]);

  const onProvider = (p: string) => {
    setProvider(p);
    setBase((PROVIDERS as any)[p]?.base ?? '');
    const sugg = (SUGGESTED_MODELS as any)[p] ?? [];
    setModel(sugg[0] ?? '');
  };

  const save = () => {
    const r = store.save({ provider, base, model, key });
    if (!r.ok) {
      setMsg({ kind: 'err', text: r.errors.join('；') });
      return;
    }
    setSaved({ provider, model, masked: maskKey(key) });
    setKey(''); // 保存后即清空输入框，减少 key 在 DOM 中的驻留
    setMsg({ kind: 'ok', text: '已保存到本机浏览器。Key 未上传，本站服务器不持有你的 Key。' });
  };

  const clear = () => {
    store.clear();
    setSaved(null);
    setKey('');
    setModel('');
    setMsg({ kind: 'info', text: '已清除本机保存的配置。' });
  };

  const runDirect = async () => {
    if (running) return;
    const cfg = store.load();
    if (!cfg || !cfg.ok) {
      setMsg({ kind: 'err', text: DIRECT_ERRORS.NO_CONFIG });
      return;
    }
    setRunning(true);
    setResult(null);
    setMsg({ kind: 'info', text: '正在直连供应商…（请求由你的浏览器直接发出）' });
    try {
      // digest 由**平台规则引擎**算好（数值不由 LLM 产出 —— 项目铁律）
      let digest = '';
      try {
        const q = await fetch(`/api/quote/${encodeURIComponent(symbol)}`).then((r) => r.json());
        const parts: string[] = [];
        if (q?.price != null) parts.push(`最新价：${q.price}`);
        if (q?.changePercent != null) parts.push(`涨跌幅：${q.changePercent}%`);
        if (q?.prevClose != null) parts.push(`昨收：${q.prevClose}`);
        if (q?.open != null) parts.push(`今开：${q.open}`);
        if (q?.high != null && q?.low != null) parts.push(`最高/最低：${q.high}/${q.low}`);
        if (q?.volume != null) parts.push(`成交量：${q.volume}`);
        digest = parts.join('\n');
      } catch {
        digest = '';
      }
      const { rolePrompt, user } = buildUserMessage({ symbol, name: symbolName, digest });
      const r = await callDirect(cfg, user, { system: rolePrompt });
      if (!r.ok) {
        setMsg({ kind: 'err', text: (DIRECT_ERRORS as any)[r.code] || r.message });
        return;
      }
      setResult(r.content);
      setMsg({ kind: 'ok', text: `直连成功（模型 ${r.model}，耗时 ${r.elapsedMs} ms）。本次为单角色分析，未做回测与工具取证。` });
    } finally {
      setRunning(false);
    }
  };

  const sugg = (SUGGESTED_MODELS as any)[provider] ?? [];

  return (
    <div style={{ ...CARD, marginBottom: 14, border: '1px solid rgba(96,165,250,0.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#93c5fd' }}>🔑 自配 API 配置</span>
        {saved && (
          <span style={{ fontSize: 11, color: '#4ade80', border: '1px solid #4ade8055', borderRadius: 999, padding: '1px 10px' }}>
            已配置：{saved.provider} · {saved.model} · {saved.masked}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <select
          value={provider}
          onChange={(e) => onProvider(e.target.value)}
          style={{ padding: '8px 10px', fontSize: 12.5, color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8 }}
        >
          {Object.entries(PROVIDERS).map(([k, v]: any) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <input
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="接口地址（自定义端点必填）"
          style={{ flex: '1 1 240px', padding: '8px 12px', fontSize: 12.5, color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8, outline: 'none' }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="模型名"
          list="byok-models"
          style={{ flex: '1 1 220px', padding: '8px 12px', fontSize: 12.5, color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8, outline: 'none' }}
        />
        <datalist id="byok-models">
          {sugg.map((m: string) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          type="password"
          placeholder={saved ? '重新输入 Key 以覆盖（留空则保留原值）' : 'API Key（仅存本机浏览器）'}
          style={{ flex: '1 1 240px', padding: '8px 12px', fontSize: 12.5, color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8, outline: 'none' }}
        />
        <button
          onClick={save}
          style={{ padding: '8px 16px', fontSize: 12.5, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,#1d4ed8,#60a5fa)', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          保存到本机
        </button>
        {saved && (
          <button
            onClick={clear}
            style={{ padding: '8px 14px', fontSize: 12.5, color: '#f87171', backgroundColor: 'transparent', border: '1px solid #7f1d1d', borderRadius: 8, cursor: 'pointer' }}
          >
            清除配置
          </button>
        )}
      </div>

      {sugg.length > 0 && (
        <div style={{ fontSize: 11, color: '#475569', marginBottom: 8, lineHeight: 1.6 }}>
          推荐模型（仅提示，可用任意兼容 OpenAI 格式的模型）：{sugg.join(' / ')}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          onClick={runDirect}
          disabled={running || !saved}
          title={!saved ? '请先保存配置' : ''}
          style={{ padding: '9px 20px', fontSize: 13, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,#7c3aed,#a78bfa)', border: 'none', borderRadius: 8, cursor: running || !saved ? 'not-allowed' : 'pointer', opacity: running || !saved ? 0.5 : 1 }}
        >
          {running ? '直连中…' : '⚡ 直连分析（单角色）'}
        </button>
        <span style={{ fontSize: 11, color: '#475569' }}>标的：{symbol || '（未填）'}</span>
      </div>

      {msg && (
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            lineHeight: 1.7,
            color: msg.kind === 'err' ? '#f87171' : msg.kind === 'ok' ? '#4ade80' : '#93c5fd',
          }}
        >
          {msg.kind === 'err' ? '✗ ' : msg.kind === 'ok' ? '✓ ' : 'ℹ '}
          {msg.text}
        </div>
      )}

      {result && (
        <div style={{ ...CARD, marginTop: 10, backgroundColor: 'rgba(124,58,237,0.08)', border: '1px solid rgba(167,139,250,0.35)' }}>
          <TierBadge tier="byok" note="单角色 · 未做回测与工具取证" />
          <div style={{ marginTop: 8, fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>{result}</div>
        </div>
      )}
    </div>
  );
}
