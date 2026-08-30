import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { askAssistant, aiApi } from '../api/dataService';
import TopNav from '../components/TopNav';
import { theme } from '../lib/theme';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  symbol?: string;
  question?: string;
  type?: string;
}

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

  const loadStats = () => {
    aiApi.stats().then((s) => setAiStats(s)).catch(() => {});
  };
  useEffect(() => {
    loadStats();
  }, []);

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

  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || sending) return;
    setInput('');
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', text: q }]);
    try {
      const res = await askAssistant(q);
      setMessages((prev) => [...prev, { role: 'assistant', text: res.answer, symbol: res.symbol, question: q, type: res.type }]);
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
                  {m.text}
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
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#64748b', fontSize: '13px' }}>
              <span style={{ fontSize: '22px' }}>🤖</span>
              <span>正在分析真实行情数据，请稍候...</span>
            </div>
          )}
        </div>

        {/* 学习统计 + 教学 */}
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
