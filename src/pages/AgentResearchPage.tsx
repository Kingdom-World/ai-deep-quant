// ─────────────────────────────────────────────────────────────
// Agent 研究页（P5 报告层）
//   把 P3/P4 的能力呈现给用户：自然语言提问 → Alpha + 工具循环 → 结论。
//
//   本页的核心设计 = **数值保真的可视化**（P3 实测教训的落地）：
//     模型 final 复述的数字不可靠（工具返回约 -75%，模型说 0%），
//     所以「模型结论」与「工具原始数据」**并列展示、各占一卡**——
//     结论卡底部明确提示"关键数值以工具原始数据为准"，让用户自己核对。
// ─────────────────────────────────────────────────────────────
import { useState } from 'react';
import TopNav from '../components/TopNav';
import { theme } from '../lib/theme';
import {
  agentApi,
  type AgentResearchResult,
  type AgentToolData,
  type AgentTraceEntry,
} from '../api/dataService';

const KV = ({ k, v }: { k: string; v: unknown }) => (
  <div style={{ display: 'flex', gap: 10, fontSize: 12, lineHeight: 1.9 }}>
    <span style={{ color: theme.color.textFaint, minWidth: 96, flexShrink: 0 }}>{k}</span>
    <span style={{ color: theme.color.text, wordBreak: 'break-all' }}>
      {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
    </span>
  </div>
);

const ToolDataCard = ({ item }: { item: AgentToolData }) => (
  <div style={{ ...theme.card, marginBottom: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>
        🛠 {item.tool}
        {(item.calls ?? 1) > 1 && (
          <span style={{ fontSize: 11, fontWeight: 400, color: theme.color.textFaint, marginLeft: 8 }}>
            （同参调用 {item.calls} 次，幂等校验一致，已合并展示）
          </span>
        )}
      </span>
      <span style={{ fontSize: 11, color: theme.color.textFaint }}>
        指纹 {item.fingerprint?.rowsHash ?? '--'}
      </span>
    </div>
    <KV k="参数" v={item.args} />
    {Object.entries(item.data ?? {}).map(([k, v]) => (
      <KV key={k} k={k} v={v} />
    ))}
  </div>
);

const TraceLine = ({ t, i }: { t: AgentTraceEntry; i: number }) => {
  const label = t.tool ?? t.event ?? `#${i + 1}`;
  const color = t.event === 'parseFail' || t.event === 'modelFail' ? theme.color.warn : theme.color.accent;
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', borderBottom: `1px dashed ${theme.color.border}` }}>
      <span style={{ minWidth: 26, fontSize: 12, color: theme.color.textFaint }}>{String(i + 1).padStart(2, '0')}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color }}>{label}</span>
      {t.args && (
        <span style={{ fontSize: 11, color: theme.color.textMuted, wordBreak: 'break-all' }}>
          {JSON.stringify(t.args).slice(0, 70)}
        </span>
      )}
      {t.ok === false && <span style={{ fontSize: 11, color: theme.color.down }}>失败</span>}
      {t.elapsedMs !== undefined && (
        <span style={{ marginLeft: 'auto', fontSize: 11, color: theme.color.textFaint }}>{t.elapsedMs}ms</span>
      )}
    </div>
  );
};

export default function AgentResearchPage() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AgentResearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const run = async () => {
    if (!question.trim() || loading) return;
    setLoading(true);
    setErr('');
    setResult(null);
    try {
      setResult(await agentApi.research(question.trim()));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '研究失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ ...theme.page, position: 'relative' }}>
      <style>{theme.keyframes}</style>
      <TopNav />
      <div style={theme.pageWrap}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#f1f5f9', margin: '0 0 8px' }}>Agent 研究</h1>
        <p style={{ fontSize: 13, color: theme.color.textMuted, margin: '0 0 18px', lineHeight: 1.85 }}>
          用一句话提出研究问题，Alpha（技术分析师）会自主调用 K 线 / 回测 / 参数稳健性工具取证后给出结论。
          每一步工具调用都有数据指纹，全程可追溯。
        </p>

        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="例如：帮我看看 sh600519 的双均线回测表现，并检验这组参数是否稳健"
            style={{ ...theme.input, flex: 1 }}
          />
          <button
            onClick={run}
            disabled={loading || !question.trim()}
            style={{
              padding: '9px 22px',
              fontSize: 13,
              fontWeight: 700,
              color: '#0a0e17',
              backgroundColor: loading ? theme.color.borderStrong : theme.color.primary,
              border: 'none',
              borderRadius: 8,
              cursor: loading ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {loading ? '研究中…' : '开始研究'}
          </button>
        </div>

        {loading && (
          <div style={{ ...theme.card, textAlign: 'center', padding: '44px 16px', color: theme.color.textMuted }}>
            <div style={{ fontSize: 14, marginBottom: 6 }}>Alpha 正在调用工具取证（真调云端模型，约 5-10 秒）…</div>
            <div style={{ fontSize: 12, color: theme.color.textFaint }}>每一步工具调用都会实时记录数据指纹</div>
          </div>
        )}

        {err && !loading && (
          <div style={{ ...theme.card, borderLeft: `3px solid ${theme.color.down}`, marginBottom: 18 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>研究失败</div>
            <div style={{ fontSize: 13, color: theme.color.textMuted }}>{err}</div>
            <button
              onClick={run}
              style={{ marginTop: 10, padding: '6px 16px', fontSize: 12, color: '#0a0e17', backgroundColor: theme.color.primary, border: 'none', borderRadius: 8, cursor: 'pointer' }}
            >
              重试
            </button>
          </div>
        )}

        {result && !loading && (
          <>
            {result.degraded && (
              <div style={{ ...theme.card, borderLeft: `3px solid ${theme.color.warn}`, marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: theme.color.warn, fontWeight: 700 }}>
                  ⚠ 本次研究发生了降级{result.actualModel ? `（实际由备用模型 ${result.actualModel} 完成）` : ''}
                  ，结论可靠性下降，请谨慎采信。
                </div>
              </div>
            )}

            {result.ok && result.answer ? (
              <div style={{ ...theme.card, borderLeft: `3px solid ${theme.color.accent}`, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>📋 模型结论（解读）</div>
                <div style={{ fontSize: 13, color: theme.color.text, lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>{result.answer}</div>
                <div style={{ fontSize: 11, color: theme.color.warn, marginTop: 10 }}>
                  ⚠ 以上为模型的解读文字。模型复述数字并不可靠（实测出现过明显偏差），关键数值请以下方「工具原始数据」为准。
                </div>
              </div>
            ) : (
              <div style={{ ...theme.card, borderLeft: `3px solid ${theme.color.warn}`, marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: theme.color.warn, fontWeight: 700 }}>
                  未得出最终结论（结束原因：{result.reason}）
                </div>
                {result.draft && (
                  <div style={{ fontSize: 12, color: theme.color.textMuted, marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    最后一轮草稿：{result.draft}
                  </div>
                )}
              </div>
            )}

            {result.toolData?.length > 0 && (
              <>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9', margin: '0 0 10px' }}>
                  工具原始数据（规则引擎直出 · 数值以此为准）
                </h2>
                {result.toolData.map((item, i) => (
                  <ToolDataCard key={i} item={item} />
                ))}
              </>
            )}

            {result.trace?.length > 0 && (
              <>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9', margin: '18px 0 10px' }}>
                  审计轨迹（{result.rounds} 轮）
                </h2>
                <div style={{ ...theme.card, padding: '10px 14px' }}>
                  {result.trace.map((t, i) => (
                    <TraceLine key={i} t={t} i={i} />
                  ))}
                </div>
              </>
            )}

            <div
              style={{
                marginTop: 20,
                padding: '13px 16px',
                fontSize: 12,
                lineHeight: 1.8,
                color: theme.color.textFaint,
                backgroundColor: 'rgba(17,24,39,0.5)',
                border: `1px solid ${theme.color.border}`,
                borderRadius: 10,
              }}
            >
              <strong style={{ color: theme.color.textMuted }}>免责声明：</strong>
              本页为学术研究演示。Agent 的结论由云端免费模型生成，仅基于工具返回的数据做解读，
              关键数值以工具原始数据（规则引擎直出）为准；严禁荐股，不构成任何投资建议。
            </div>
          </>
        )}
      </div>
    </div>
  );
}
