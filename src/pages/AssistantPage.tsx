import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { askAssistant, aiApi, authApi } from '../api/dataService';
import TopNav from '../components/TopNav';
import { theme } from '../lib/theme';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  symbol?: string;
  question?: string;
  type?: string;
  engine?: string;
  reasoning?: string | null;
}

/** 轻量 markdown 渲染（标题/加粗/列表/行内代码，供气泡使用） */
function renderMdLite(text: string): React.ReactNode[] {
  const lines = String(text || '').split('\n');
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];
  const inline = (s: string, key: string): React.ReactNode[] => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return parts.map((p, i) => {
      if (p.startsWith('**') && p.endsWith('**'))
        return <strong key={key + i} style={{ color: '#f1f5f9' }}>{p.slice(2, -2)}</strong>;
      if (p.startsWith('`') && p.endsWith('`'))
        return <code key={key + i} style={{ fontFamily: 'Consolas, monospace', fontSize: '12px', color: '#93c5fd', backgroundColor: 'rgba(96,165,250,0.08)', borderRadius: 4, padding: '0 4px' }}>{p.slice(1, -1)}</code>;
      return <span key={key + i}>{p}</span>;
    });
  };
  lines.forEach((line, i) => {
    const key = 'md' + i;
    if (/^#{1,4}\s/.test(line)) {
      if (bullets.length) { out.push(<ul key={key + 'u'} style={{ margin: '4px 0', paddingLeft: 16 }}>{bullets.map((b, j) => <li key={j} style={{ fontSize: '13.5px', color: '#cbd5e1', lineHeight: 1.7 }}>{inline(b, key + j)}</li>)}</ul>); bullets = []; }
      out.push(<div key={key} style={{ fontSize: '13.5px', fontWeight: 700, color: '#93c5fd', margin: '8px 0 4px' }}>{inline(line.replace(/^#{1,4}\s/, ''), key)}</div>);
    } else if (/^[-*·]\s/.test(line)) {
      bullets.push(line.replace(/^[-*·]\s/, ''));
    } else if (/^─+$|^---+$/.test(line.trim())) {
      if (bullets.length) { out.push(<ul key={key + 'u'} style={{ margin: '4px 0', paddingLeft: 16 }}>{bullets.map((b, j) => <li key={j} style={{ fontSize: '13.5px', color: '#cbd5e1', lineHeight: 1.7 }}>{inline(b, key + j)}</li>)}</ul>); bullets = []; }
      out.push(<div key={key} style={{ borderTop: '1px solid #1e293b', margin: '6px 0' }} />);
    } else if (line.trim()) {
      if (bullets.length) { out.push(<ul key={key + 'u'} style={{ margin: '4px 0', paddingLeft: 16 }}>{bullets.map((b, j) => <li key={j} style={{ fontSize: '13.5px', color: '#cbd5e1', lineHeight: 1.7 }}>{inline(b, key + j)}</li>)}</ul>); bullets = []; }
      out.push(<div key={key} style={{ fontSize: '13.5px', color: '#cbd5e1', lineHeight: 1.7, marginBottom: 3 }}>{inline(line, key)}</div>);
    }
  });
  if (bullets.length) out.push(<ul key="tail" style={{ margin: '4px 0', paddingLeft: 16 }}>{bullets.map((b, j) => <li key={j} style={{ fontSize: '13.5px', color: '#cbd5e1', lineHeight: 1.7 }}>{inline(b, 't' + j)}</li>)}</ul>);
  return out;
}

/** 问候语 */
const GREETING_TEXT = '🤖 你好！我是 AI深度量化 的站内智能助手（离线规则引擎，无需联网 AI）。\n\n我可以帮你：\n· 「分析 AAPL」—— 个股五因子解读\n· 「今天观察什么」—— 股票池因子评分排名\n· 「平台怎么用」—— 使用指南\n· 「回测怎么用」—— 策略回测指引\n\n试试下方的快捷问题吧！';

/** 加载态思考步骤（与思考链呈现形式一致） */
const THINKING_STEPS = [
  '🧠 正在理解你的问题…',
  '📡 正在调取实时行情数据…',
  '⚖️ 正在多维度交叉验证…',
  '✍️ 正在组织回答…',
];

/** 快捷提问 */
const QUICK_QUESTIONS = ['分析 AAPL', '600519 怎么样', '今天观察什么', '平台怎么用', '回测怎么用'];

export default function AssistantPage() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text: '🤖 你好！我是 AI深度量化 的站内智能助手（离线规则引擎，无需联网 AI）。\n\n我可以帮你：\n· 「分析 AAPL」—— 个股五因子解读\n· 「今天观察什么」—— 股票池因子评分排名\n· 「平台怎么用」—— 使用指南\n· 「回测怎么用」—— 策略回测指引\n\n试试下方的快捷问题吧！',
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [aiStats, setAiStats] = useState<any>(null);
  const [fbDone, setFbDone] = useState<Record<number, 'up' | 'down'>>({});
  const [teachOpen, setTeachOpen] = useState(false);
  const [teachQ, setTeachQ] = useState('');
  const [teachA, setTeachA] = useState('');
  const [teachMsg, setTeachMsg] = useState<string | null>(null);
  const [thinkStep, setThinkStep] = useState(0);
  const [me, setMe] = useState<{ username: string | null; isAdmin?: boolean } | null>(null);

  // 会话持久化：切页/刷新不丢（sessionStorage 上限 40 条）
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('pq_ai_chat');
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr) && arr.length) setMessages(arr);
      }
    } catch { /* 忽略 */ }
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem('pq_ai_chat', JSON.stringify(messages.slice(-40)));
    } catch { /* 容量满忽略 */ }
  }, [messages]);

  const clearChat = () => {
    sessionStorage.removeItem('pq_ai_chat');
    setMessages([{ role: 'assistant', text: GREETING_TEXT }]);
    setFbDone({});
  };

  const loadStats = () => {
    if (!me?.isAdmin) return;
    aiApi.stats().then((s) => setAiStats(s)).catch(() => {});
  };
  useEffect(() => {
    authApi
      .me()
      .then((m) => setMe({ username: m.username, isAdmin: m.isAdmin }))
      .catch(() => setMe({ username: null, isAdmin: false }));
  }, []);
  useEffect(() => {
    loadStats();
  }, [me?.isAdmin]);

  const doTeach = async () => {
    if (!teachQ.trim() || !teachA.trim()) return;
    try {
      const r = await aiApi.teach({ q: teachQ.trim(), a: teachA.trim() });
      if (r.ok) {
        setTeachMsg(r.updated ? '✓ 已更新该条知识' : '✓ 已学会，以后就这么回答');
        setTeachQ('');
        setTeachA('');
        loadStats();
      } else {
        setTeachMsg('✗ ' + (r.error || '教学失败'));
      }
    } catch (e) {
      setTeachMsg('✗ ' + (e as Error).message);
    }
  };

  // 自动滚动到底部
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, sending]);

  // 思考步骤轮换（加载态与思考链呈现形式一致）
  useEffect(() => {
    if (!sending) {
      setThinkStep(0);
      return;
    }
    const t = setInterval(() => setThinkStep((i) => (i + 1) % THINKING_STEPS.length), 1600);
    return () => clearInterval(t);
  }, [sending]);

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || sending) return;
    setInput('');
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', text: q }]);
    try {
      const res = await askAssistant(q);
      setMessages((prev) => [...prev, { role: 'assistant', text: res.answer, symbol: res.symbol, question: q, type: res.type, engine: res.engine, reasoning: res.reasoning ?? null }]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: `⚠️ 服务暂时不可用：${e?.message || '请确认数据服务已启动（npm start）'}`,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{
                ...theme.page,
        color: '#e2e8f0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <style>{`@keyframes pq-pulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }`}</style>
      {/* 顶部导航（全站统一） */}
      <TopNav />

      {/* 聊天区 */}
      <main
        style={{
          flex: 1,
          width: '100%',
          maxWidth: '820px',
          margin: '0 auto',
          padding: '20px 20px 8px',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            padding: '4px 2px 12px',
          }}
        >
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div
                  style={{
                    maxWidth: '76%',
                    padding: '10px 16px',
                    backgroundColor: '#2563eb',
                    borderRadius: '14px 14px 4px 14px',
                    fontSize: '14px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} style={{ display: 'flex', justifyContent: 'flex-start', gap: '8px' }}>
                <span style={{ fontSize: '22px', alignSelf: 'flex-end' }}>🤖</span>
                <div
                  style={{
                    maxWidth: '82%',
                    padding: '10px 16px',
                    backgroundColor: '#111827',
                    border: '1px solid #1e293b',
                    borderRadius: '14px 14px 14px 4px',
                    fontSize: '14px',
                    lineHeight: '1.7',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {m.engine === 'cloud' && <span style={{ display: 'inline-block', fontSize: 10, color: '#93c5fd', border: '1px solid rgba(96,165,250,0.4)', borderRadius: 999, padding: '0 8px', marginBottom: 6 }}>🛰️ 云端专家模型</span>}
                  {m.engine === 'knowledge' && <span style={{ display: 'inline-block', fontSize: 10, color: '#fbbf24', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 999, padding: '0 8px', marginBottom: 6 }}>🧠 学习知识库</span>}
                  {m.reasoning && (
                    <details style={{ marginBottom: 8, backgroundColor: 'rgba(13,19,34,0.6)', border: '1px solid #1e293b', borderRadius: 8, padding: '6px 10px' }}>
                      <summary style={{ fontSize: 11, color: '#93c5fd', cursor: 'pointer' }}>🧠 查看模型思考链</summary>
                      <div style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'pre-wrap', lineHeight: 1.7, marginTop: 6 }}>{m.reasoning}</div>
                    </details>
                  )}
                  {renderMdLite(m.text)}
                  {m.symbol && (
                    <div style={{ marginTop: '10px' }}>
                      <button
                        onClick={() => navigate(`/stock/${m.symbol}`)}
                        style={{
                          padding: '6px 14px',
                          fontSize: '12px',
                          fontWeight: '600',
                          color: '#fff',
                          backgroundColor: '#0ea5e9',
                          border: 'none',
                          borderRadius: '8px',
                          cursor: 'pointer',
                        }}
                      >
                        📈 打开 {m.symbol} 量化看板
                      </button>
                    </div>
                  )}
                </div>
                {i > 0 && m.question && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 4, marginLeft: 34, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, color: '#475569' }}>这次回答有帮助吗？</span>
                    {(['up', 'down'] as const).map((r) => (
                      <button
                        key={r}
                        onClick={async () => {
                          if (fbDone[i]) return;
                          setFbDone((p) => ({ ...p, [i]: r }));
                          try {
                            await aiApi.feedback({ question: m.question!, answer: m.text, rating: r });
                            loadStats();
                          } catch { /* 忽略 */ }
                        }}
                        style={{
                          fontSize: 11,
                          color: fbDone[i] === r ? '#60a5fa' : '#64748b',
                          backgroundColor: 'transparent',
                          border: 'none',
                          cursor: fbDone[i] ? 'default' : 'pointer',
                        }}
                      >
                        {fbDone[i] === r ? '已反馈，谢谢' : r === 'up' ? '👍 有用' : '👎 没用'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
          {sending && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#93c5fd', fontSize: '13px' }}>
              <span style={{ fontSize: '22px', animation: 'pq-pulse 1.4s ease-in-out infinite' }}>🤖</span>
              <span>{THINKING_STEPS[thinkStep % THINKING_STEPS.length]}<span style={{ animation: 'pq-pulse 1s infinite' }}>…</span></span>
            </div>
          )}
        </div>

        {/* 会话操作 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
          <button
            onClick={clearChat}
            style={{ fontSize: 11, color: '#64748b', backgroundColor: 'transparent', border: '1px solid #334155', borderRadius: 8, padding: '4px 12px', cursor: 'pointer' }}
          >
            🗑️ 清空对话
          </button>
          <span style={{ fontSize: 10.5, color: '#475569' }}>对话在本次访问内保留（切页/刷新不丢）</span>
        </div>

        {/* 学习统计 + 教学（仅管理员可见） */}
        {me?.isAdmin && (
        <div style={{ marginTop: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#475569' }}>
            🧠 已学习 {aiStats?.knowledge ?? 0} 条知识 · 自训练 {aiStats?.trainCount ?? 0} 轮
            {aiStats?.lastNightly ? ` · 上次训练 ${String(aiStats.lastNightly.at).slice(0, 10)}` : ''}
            {aiStats?.pendingQuestions ? ` · 待学习 ${aiStats.pendingQuestions} 问` : ''}
          </span>
          <button
            onClick={() => setTeachOpen(!teachOpen)}
            style={{ fontSize: 11, color: '#93c5fd', backgroundColor: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            {teachOpen ? '收起' : '🧠 教我一招'}
          </button>
          {teachMsg && <span style={{ fontSize: 11, color: teachMsg.startsWith('✓') ? '#4ade80' : '#f87171' }}>{teachMsg}</span>}
        </div>
        {teachOpen && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '2px 0 8px' }}>
            <input
              value={teachQ}
              onChange={(e) => setTeachQ(e.target.value)}
              placeholder="问法（例：什么是五因子评分）"
              style={{ flex: '1 1 200px', padding: '8px 12px', fontSize: '12px', color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8, outline: 'none' }}
            />
            <input
              value={teachA}
              onChange={(e) => setTeachA(e.target.value)}
              placeholder="答案（我以后就照这个回答，不构成投资建议）"
              style={{ flex: '1 1 280px', padding: '8px 12px', fontSize: '12px', color: '#e2e8f0', backgroundColor: '#0d1322', border: '1px solid #334155', borderRadius: 8, outline: 'none' }}
            />
            <button
              onClick={doTeach}
              style={{ padding: '8px 16px', fontSize: '12px', fontWeight: 600, color: '#fff', backgroundColor: '#2563eb', border: 'none', borderRadius: 8, cursor: 'pointer' }}
            >
              教给它
            </button>
          </div>
        )}
        </div>
        )}

        {/* 快捷问题 */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '10px 0' }}>
          {QUICK_QUESTIONS.map((q) => (
            <button
              key={q}
              onClick={() => send(q)}
              disabled={sending}
              style={{
                padding: '6px 14px',
                fontSize: '12px',
                color: '#94a3b8',
                backgroundColor: '#111827',
                border: '1px solid #334155',
                borderRadius: '999px',
                cursor: sending ? 'default' : 'pointer',
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => {
                if (!sending) (e.currentTarget as HTMLButtonElement).style.borderColor = '#3b82f6';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#334155';
              }}
            >
              {q}
            </button>
          ))}
        </div>

        {/* 输入区 */}
        <div style={{ display: 'flex', gap: '10px', paddingBottom: '20px' }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) send();
            }}
            placeholder="问点什么？如「分析 NVDA」「今天观察什么」"
            style={{
              flex: 1,
              padding: '12px 16px',
              fontSize: '14px',
              color: '#e2e8f0',
              backgroundColor: '#111827',
              border: '1px solid #334155',
              borderRadius: '10px',
              outline: 'none',
            }}
          />
          <button
            onClick={() => send()}
            disabled={sending || !input.trim()}
            style={{
              padding: '12px 24px',
              fontSize: '14px',
              fontWeight: '700',
              color: '#fff',
              backgroundColor: sending || !input.trim() ? '#475569' : '#2563eb',
              border: 'none',
              borderRadius: '10px',
              cursor: sending || !input.trim() ? 'default' : 'pointer',
            }}
          >
            发送
          </button>
        </div>
      </main>

      <p style={{ textAlign: 'center', color: '#475569', fontSize: '12px', paddingBottom: '16px' }}>
        AI 助手为站内离线规则引擎，解读基于真实行情量化指标，仅供参考，不构成投资建议
      </p>
    </div>
  );
}
