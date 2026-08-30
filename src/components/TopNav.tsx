// ─────────────────────────────────────────────────────────────
// 全站统一顶部导航（六个页面共用）
//   · 品牌 + 五个页签（当前页高亮）+ 全局股票搜索（联想）+ 用户菜单
//   · 替换原先六份手写头部，保证全站导航一致
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { searchSymbol } from '../api/dataService';
import { theme } from '../lib/theme';
import UserMenu from './UserMenu';

const NAV_ITEMS = [
  { path: '/', label: '首页' },
  { path: '/analyze', label: '因子分析' },
  { path: '/backtest', label: '策略回测' },
  { path: '/paper', label: '模拟交易' },
  { path: '/agents', label: 'Agent 团队' },
  { path: '/assistant', label: 'AI 助手' },
];

export default function TopNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [kw, setKw] = useState('');
  const [sug, setSug] = useState<{ name: string; code: string; market: string }[]>([]);
  const [sugOpen, setSugOpen] = useState(false);
  const suggestTimer = useRef<number | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  // 全局搜索联想（300ms 防抖）
  useEffect(() => {
    const kwTrim = kw.trim();
    if (kwTrim.length < 2) {
      setSug([]);
      return;
    }
    suggestTimer.current = window.setTimeout(async () => {
      try {
        const list = await searchSymbol(kwTrim);
        setSug(list.slice(0, 6));
        setSugOpen(true);
      } catch {
        setSug([]);
      }
    }, 300);
    return () => window.clearTimeout(suggestTimer.current);
  }, [kw]);

  // 点击外部关闭联想
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setSugOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const go = (code: string) => {
    setSugOpen(false);
    setKw('');
    navigate(`/stock/${code}`);
  };

  return (
    <nav
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        gap: '20px',
        padding: '0 28px',
        height: '58px',
        backgroundColor: 'rgba(10,14,23,0.88)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        borderBottom: '1px solid rgba(96,165,250,0.14)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
      }}
    >
      {/* 品牌 */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', flexShrink: 0 }}
        onClick={() => navigate('/')}
      >
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: 'linear-gradient(135deg, #1d4ed8, #60a5fa)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            boxShadow: '0 4px 14px rgba(37,99,235,0.45)',
          }}
        >
          📊
        </span>
        <span style={{ fontSize: 15, fontWeight: 800, color: '#f1f5f9', letterSpacing: 1 }}>
          AI深度量化
        </span>
      </div>

      {/* 页签 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
        {NAV_ITEMS.map((item) => {
          const active = location.pathname === item.path;
          return (
            <span
              key={item.path}
              onClick={() => navigate(item.path)}
              style={{
                padding: '7px 14px',
                fontSize: 13,
                borderRadius: 8,
                cursor: 'pointer',
                color: active ? '#60a5fa' : theme.color.textMuted,
                fontWeight: active ? 700 : 400,
                backgroundColor: active ? 'rgba(96,165,250,0.1)' : 'transparent',
                border: active ? '1px solid rgba(96,165,250,0.3)' : '1px solid transparent',
                transition: 'all .15s',
              }}
            >
              {item.label}
            </span>
          );
        })}
      </div>

      {/* 全局搜索 */}
      <div ref={boxRef} style={{ position: 'relative', width: 230 }}>
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && kw.trim()) go(kw.trim());
          }}
          placeholder="搜索股票（AAPL / 600519 / 茅台）"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 12px',
            fontSize: 12,
            color: theme.color.text,
            backgroundColor: 'rgba(13,19,34,0.8)',
            border: '1px solid rgba(51,65,85,0.8)',
            borderRadius: 8,
            outline: 'none',
          }}
        />
        {sugOpen && sug.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 40,
              left: 0,
              right: 0,
              backgroundColor: '#111827',
              border: '1px solid #334155',
              borderRadius: 10,
              overflow: 'hidden',
              boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
            }}
          >
            {sug.map((s) => (
              <div
                key={`${s.market}-${s.code}`}
                style={{
                  padding: '8px 12px',
                  fontSize: 13,
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
                onClick={() => go(s.code)}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = '#1e293b';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
                }}
              >
                <span>{s.name}</span>
                <span style={{ color: theme.color.textFaint }}>{s.code}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 用户菜单 */}
      <UserMenu />
    </nav>
  );
}
