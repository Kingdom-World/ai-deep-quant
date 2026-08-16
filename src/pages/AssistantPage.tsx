import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { askAssistant } from '../api/dataService';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  symbol?: string;
}

/** 快捷提问 */
const QUICK_QUESTIONS = ['分析 AAPL', '600519 怎么样', '今天推荐什么', '平台怎么用', '回测怎么用'];

export default function AssistantPage() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text: '🤖 你好！我是 AI深度量化 的站内智能助手（离线规则引擎，无需联网 AI）。\n\n我可以帮你：\n· 「分析 AAPL」—— 个股五因子解读\n· 「今天推荐什么」—— 股票池 AI 评分排名\n· 「平台怎么用」—— 使用指南\n· 「回测怎么用」—— 策略回测指引\n\n试试下方的快捷问题吧！',
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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
      setMessages((prev) => [...prev, { role: 'assistant', text: res.answer, symbol: res.symbol }]);
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
        minHeight: '100vh',
        backgroundColor: '#0a0e17',
        color: '#e2e8f0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 顶部导航 */}
      <nav
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          padding: '14px 32px',
          backgroundColor: 'rgba(10, 14, 23, 0.85)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #1e293b',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '26px', cursor: 'pointer' }} onClick={() => navigate('/')}>
            🤖
          </span>
          <span style={{ fontSize: '19px', fontWeight: '700', color: '#f1f5f9' }}>
            AI深度量化 · 智能助手
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '14px' }}>
          <span style={{ color: '#94a3b8', cursor: 'pointer' }} onClick={() => navigate('/')}>
            🏠 首页
          </span>
          <span style={{ color: '#94a3b8', cursor: 'pointer' }} onClick={() => navigate('/analyze')}>
            AI 潜力分析
          </span>
          <span style={{ color: '#94a3b8', cursor: 'pointer' }} onClick={() => navigate('/backtest')}>
            策略回测
          </span>
        </div>
      </nav>

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
            placeholder="问点什么？如「分析 NVDA」「今天推荐什么」"
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
