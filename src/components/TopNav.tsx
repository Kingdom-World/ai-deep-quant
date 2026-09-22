// ─────────────────────────────────────────────────────────────
// 全站统一顶部导航
//   · 品牌 + 功能页签（当前页高亮）+ 全局股票搜索（联想）+ 用户菜单
//   · 统一所有页面的导航与搜索入口，保证全站导航一致
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { searchSymbol } from '../api/dataService';
import { theme } from '../lib/theme';
import BrandMark from './BrandMark';
import UserMenu from './UserMenu';

const NAV_ITEMS = [
  { path: '/', label: '首页' },
  { path: '/screener', label: '选股' },
  { path: '/analyze', label: '因子分析' },
  { path: '/backtest', label: '策略回测' },
  // match 前缀：/research 下含 5 个子页签（/research/consistency 等）。
  // 缺 match 时需 pathname 精确等于 '/research'，进子页签就匹配不到 → 指示器回落首页。
  { path: '/research', label: '研究中心', match: '/research' },
  { path: '/stock/sh600519', label: '量化看板', match: '/stock' },
  { path: '/paper', label: '模拟交易' },
  { path: '/agents', label: 'Agent 团队' },
  { path: '/assistant', label: 'AI 助手' },
  { path: '/news', label: '资讯' },
  { path: '/features', label: '功能介绍' },
];

export default function TopNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [kw, setKw] = useState('');
  // 窄屏（≤520px）：收紧导航内边距与间距。
  //  为什么：375px 视口实测导航内容 408px（溢出 33px），把用户菜单挤出屏幕 ⇒ 不可点。
  //  导航项本身已有"收进更多▾"的自适应，缺的是**容器级**的收缩。
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 520px)');
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const [sug, setSug] = useState<{ name: string; code: string; market: string }[]>([]);
  const [sugOpen, setSugOpen] = useState(false);
  const suggestTimer = useRef<number | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  // ── 滑动指示器（性能约定）──
  //   动画只动 transform/width（transform 走合成层，不触发 layout/paint）；
  //   测量为事件驱动（激活变化 / resize(passive) / 字体就绪），无 requestAnimationFrame 常驻循环——
  //   即使页签数量继续增加，静止时也是零开销。
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLSpanElement>());
  const [ind, setInd] = useState<{ x: number; w: number; on: boolean }>({ x: 0, w: 0, on: false });

  const activeKey =
    NAV_ITEMS.find((it) =>
      it.match ? location.pathname.startsWith(it.match) : location.pathname === it.path,
    )?.path ?? '/';

  const measure = useCallback(() => {
    const el = tabRefs.current.get(activeKey);
    if (el) setInd({ x: el.offsetLeft, w: el.offsetWidth, on: true });
    else setInd((s) => ({ ...s, on: false })); // 激活项被收进「更多」→ 指示器隐藏
  }, [activeKey]);

  useEffect(() => {
    measure();
    // 字体加载完成会改变文本宽度，就绪后重测一次
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(measure).catch(() => {});
    }
  }, [measure]);

  useEffect(() => {
    window.addEventListener('resize', measure, { passive: true });
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // 移动端：激活页签横向滚入可视区中央（桌面容器无滚动时等效于无操作）
  useEffect(() => {
    const box = scrollRef.current;
    const el = tabRefs.current.get(activeKey);
    if (box && el) {
      box.scrollTo({
        left: el.offsetLeft - box.clientWidth / 2 + el.offsetWidth / 2,
        behavior: 'smooth',
      });
    }
  }, [activeKey]);

  // ── 自适应溢出收纳（用户截图反馈：11 项时「功能介绍」被截断）──
  //   每次渲染后检查页签区是否溢出：溢出则把末尾项收进「更多 ▾」下拉，逐格收敛；
  //   放回需留 >0.6 项宽余量（按平均项宽估算），防止"放回→溢出→收回"震荡。
  //   由此 NAV_ITEMS 随便加项，布局永不再截断。
  const [visibleCount, setVisibleCount] = useState(NAV_ITEMS.length);
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePos, setMorePos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const visibleItems = NAV_ITEMS.slice(0, visibleCount);
    const overflow = box.scrollWidth > box.clientWidth + 1;
    if (overflow && visibleCount > 1) {
      setVisibleCount(visibleCount - 1);
      return;
    }
    if (!overflow && visibleCount < NAV_ITEMS.length) {
      const avg = visibleItems.length ? box.scrollWidth / visibleItems.length : 100;
      if (box.clientWidth - box.scrollWidth > avg * 0.6) setVisibleCount(visibleCount + 1);
    }
  });

  // 点击外部关闭「更多」下拉
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const hiddenItems = NAV_ITEMS.slice(visibleCount);
  const activeHidden = hiddenItems.some((it) =>
    it.match ? location.pathname.startsWith(it.match) : location.pathname === it.path,
  );

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

  // 回车：有联想结果优先取第一条（自然语言关键词也能直达个股）；无结果再按原文跳转
  const goBest = () => {
    const k = kw.trim();
    if (!k) return;
    go(sug.length > 0 ? sug[0].code : k);
  };

  return (
    <>
      {/* 顶部分层（用户 2026-09-19 反馈：不应整块固定）：
          · **合规声明条** —— 全站必须始终可见（合规要求），故唯一固定；
          · **导航栏** —— 常规文档流，随页面滚动。导航是高频操作入口，
            长期占据首屏高度会挤压内容区，且与「只有声明该固定」的直觉不符。
          声明条与导航是兄弟节点，故用两个占位：声明条 fixed 需等高 spacer，
          导航回归文档流后不再需要占位（原实现整块 fixed + 92px spacer）。 */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          textAlign: 'center',
          padding: '8px 16px',
          fontSize: '12px',
          color: '#f59e0b',
          backgroundColor: 'rgba(20,16,8,0.96)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
        }}
      >
        📚 本平台为学术研究项目，数据仅供参考，不构成投资建议
      </div>
      {/* 占位：仅补声明条高度（8+8 padding + 约 17 行高 ≈ 33px） */}
      <div style={{ height: 34 }} aria-hidden />

      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: narrow ? '10px' : '20px',
          padding: narrow ? '0 12px' : '0 28px',
          height: '58px',
          backgroundColor: 'rgba(10,14,23,0.88)',
          borderBottom: '1px solid rgba(96,165,250,0.14)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
        }}
        className="pq-topnav"
      >
      <style>{`
        .pq-topnav-scroll { overflow-x: auto; scrollbar-width: none; }
        .pq-topnav-scroll::-webkit-scrollbar { display: none; }
        .pq-tab {
          padding: 7px 13px; font-size: 13px; border-radius: 8px; cursor: pointer;
          white-space: nowrap; flex-shrink: 0;
          color: #94a3b8; border: 1px solid transparent;
          transition: color .18s ease, background-color .18s ease, border-color .18s ease;
        }
        .pq-tab:hover { color: #e2e8f0; background-color: rgba(96,165,250,0.08); }
        .pq-tab-active { color: #60a5fa; font-weight: 700; background-color: rgba(96,165,250,0.1); border-color: rgba(96,165,250,0.3); }
      `}</style>

      {/* 品牌 */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', flexShrink: 0 }}
        onClick={() => navigate('/')}
      >
        <BrandMark size={32} radius={9} shadow="0 4px 14px rgba(37,99,235,0.45)" />
        <span style={{ fontSize: 15, fontWeight: 800, color: '#f1f5f9', letterSpacing: 1, whiteSpace: 'nowrap' }}>
          AI深度量化
        </span>
      </div>

      {/* 页签（窄屏横向滚动，永不换行；底部滑动指示器跟随激活项） */}
      <div
        ref={scrollRef}
        className="pq-topnav-scroll"
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '4px', flex: 1, minWidth: 0 }}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            height: 2,
            width: ind.w,
            transform: `translateX(${ind.x}px)`,
            backgroundColor: '#60a5fa',
            borderRadius: 2,
            opacity: ind.on ? 1 : 0,
            pointerEvents: 'none',
            willChange: 'transform',
            transition:
              'transform .3s cubic-bezier(.22,.61,.36,1), width .3s cubic-bezier(.22,.61,.36,1), opacity .2s ease',
          }}
        />
        {NAV_ITEMS.slice(0, visibleCount).map((item) => {
          const active = item.match ? location.pathname.startsWith(item.match) : location.pathname === item.path;
          return (
            <span
              key={item.path}
              ref={(el) => {
                if (el) tabRefs.current.set(item.path, el);
                else tabRefs.current.delete(item.path);
              }}
              onClick={() => navigate(item.path)}
              className={`pq-tab${active ? ' pq-tab-active' : ''}`}
            >
              {item.label}
            </span>
          );
        })}
        {hiddenItems.length > 0 && (
          <div ref={moreRef} style={{ position: 'relative', flexShrink: 0 }}>
            <span
              onClick={(e) => {
                // 面板用 fixed 坐标定位：脱离页签滚动容器的 overflow 裁剪，保证「更多」在任何位置都能完整展开
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMorePos({ top: rect.bottom + 10, right: window.innerWidth - rect.right });
                setMoreOpen((o) => !o);
              }}
              className={`pq-tab${activeHidden ? ' pq-tab-active' : ''}`}
            >
              更多 ▾
            </span>
            {moreOpen && (
              <div
                style={{
                  position: 'fixed',
                  top: morePos.top,
                  right: morePos.right,
                  backgroundColor: '#111827',
                  border: '1px solid #334155',
                  borderRadius: 10,
                  boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
                  zIndex: 200,
                  minWidth: 160,
                  overflow: 'hidden',
                  padding: '4px 0',
                }}
              >
                {hiddenItems.map((item) => {
                  const active = item.match
                    ? location.pathname.startsWith(item.match)
                    : location.pathname === item.path;
                  return (
                    <div
                      key={item.path}
                      onClick={() => {
                        navigate(item.path);
                        setMoreOpen(false);
                      }}
                      style={{
                        padding: '9px 14px',
                        fontSize: 13,
                        cursor: 'pointer',
                        color: active ? '#60a5fa' : theme.color.textMuted,
                        fontWeight: active ? 700 : 400,
                        backgroundColor: active ? 'rgba(96,165,250,0.1)' : 'transparent',
                      }}
                    >
                      {item.label}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 全局搜索（窄屏收窄但不换行） */}
      <div ref={boxRef} style={{ position: 'relative', width: 'clamp(150px, 16vw, 230px)', flexShrink: 0 }}>
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') goBest();
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
              zIndex: 20,
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
    </>
  );
}
