// ─────────────────────────────────────────────────────────────
// 全站统一顶部导航
//   · 品牌 + 功能页签（当前页高亮）+ 全局股票搜索（联想）+ 用户菜单
//   · 统一所有页面的导航与搜索入口，保证全站导航一致
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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

// 🔴 模块级可见集缓存：TopNav 在每个页面组件内各自渲染（pages/* 共 13 处），
// 路由切换 = 卸载旧页（连它的 TopNav）+ 挂载新页的新 TopNav —— 组件状态全部重置。
// visibleCount 一旦重置为 11，收敛/放回会围绕新激活项重新平衡 ⇒
// 实测表现为「切换页面时其他菜单项整体位移」。缓存让可见集跨重挂载保持不变。
let vcCache: number | null = null;

export default function TopNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [kw, setKw] = useState('');
  // 窄屏（≤690px）：折叠搜索框为图标、品牌只留 logo、收紧间距。
  //  为什么是 690：桌面布局的固定宽度（品牌 137 + 常驻输入框 150 + 完整用户胶囊 146
  //  + 间距/内边距 ~116）≈ 549px，543px 视口实测页签区被压成 clientWidth=0 ——
  //  页签全部停在可视区外（"导航失效"）。690 = 549 + 页签最少可用宽度。
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 690px)');
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 声明条实测高度 → 占位符跟随：手机 webview 的字体放大一旦把声明折成两行，
  // 写死的 34px 占位会让 fixed 声明压住导航（用户 2026-09-22 手机实测）。
  // 占位高度恒等于声明条实际高度，折不折行都不会重叠。
  const decRef = useRef<HTMLDivElement>(null);
  const [decH, setDecH] = useState(34);
  useEffect(() => {
    const el = decRef.current;
    if (!el) return;
    const sync = () => setDecH(el.offsetHeight || 34);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 手机端搜索折叠：默认只显示搜索图标，点开进入「搜索模式」——输入框独占一整行，页签暂隐。
  //  为什么：搜索框原为 clamp(150px,…)+flexShrink:0 永不收缩 —— 360px 视口下页签区仅剩
  //  ~14px，「首页」「更多(N)」全部被挤出可视区（用户 2026-09-22 实测反馈）。
  const [searchOpen, setSearchOpen] = useState(false);
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
  }, [measure, searchOpen]); // searchOpen：手机搜索模式收起/恢复页签后重测指示器

  // 横向滚动收敛：把 scrollLeft 压回合法区间；内容不溢出时归零。
  const clampScroll = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const max = Math.max(0, box.scrollWidth - box.clientWidth);
    if (box.scrollLeft > max) box.scrollLeft = max;
    if (box.scrollWidth <= box.clientWidth && box.scrollLeft !== 0) box.scrollLeft = 0;
  }, []);

  useEffect(() => {
    const onResize = () => {
      measure();
      clampScroll();
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, [measure, clampScroll]);

  // 🔴 不做"激活页签滚动居中"（2026-09-22 移除）：
  //  路由切换时若激活项刚被放回/不完整可见，自动滚动会让其余菜单项整体平移
  //  （用户实测：切页时首页/更多整体偏移）。位置稳定优先——激活项在「更多」里时
  //  「更多」自身有激活高亮，位置提示已足够；残留的越界滚动仍由 clampScroll 兜底。

  // ── 自适应溢出收纳（用户截图反馈：11 项时「功能介绍」被截断）──
  //   每次渲染后检查页签区是否溢出：溢出则把末尾项收进「更多 ▾」下拉，逐格收敛；
  //   放回需留 >0.6 项宽余量（按平均项宽估算），防止"放回→溢出→收回"震荡。
  //   由此 NAV_ITEMS 随便加项，布局永不再截断。
  const [visibleCount, setVisibleCount] = useState(() =>
    vcCache == null ? NAV_ITEMS.length : Math.max(1, Math.min(vcCache, NAV_ITEMS.length)),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePos, setMorePos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const moreRef = useRef<HTMLDivElement>(null);

  // 可见集跨重挂载缓存回写
  useEffect(() => {
    vcCache = visibleCount;
  }, [visibleCount]);

  // 收起（防溢出）：仅挂载与跨断点（narrow 变化）时评估 —— 与放回对称。
  //  🔴 不随路由切换每渲染评估：任何亚像素级 sw 波动都会随机收走一个页签
  //  （实测：切到「因子分析」时「选股」被收进更多(10)，数字变宽推挤邻项）。
  //  档位内若真溢出，页签区可横向滚动（clampScroll 守护），可用性不受影响。
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let guard = 0;
    const shrink = () => {
      if (guard >= 12) return; // 防失控上限
      guard += 1;
      if (box.scrollWidth > box.clientWidth + 1) {
        setVisibleCount((v) => Math.max(1, v - 1));
        setTimeout(shrink, 80); // 等重渲染后复查
      }
    };
    shrink();
  }, [narrow]);

  // 放回（恢复被收纳项）：只在挂载与跨断点（narrow 变化，即转屏/改窗）时重平衡。
  // 🔴 切换路由绝不放回 —— 否则激活项会从「更多」插进可见集把后面的项推走
  // （用户实测：切页时菜单项整体偏移）。位置稳定优先：激活项在「更多」里时
  // 「更多」自身有激活高亮，位置提示已足够。
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    if (box.scrollWidth > box.clientWidth + 1) return;
    if (visibleCount >= NAV_ITEMS.length) return;
    const avg = visibleCount ? box.scrollWidth / visibleCount : 100;
    if (box.clientWidth - box.scrollWidth > avg * 0.6) setVisibleCount(visibleCount + 1);
  }, [narrow]);

  // 🔴 滚动收敛守卫（手机"切换页面后导航失效"的核心修复）：
  //  路由切换会把页签平滑滚动到激活项；紧随其后的溢出收纳卸载页签 ⇒ 内容变窄。
  //  桌面 Chrome 会自动回卷 scrollLeft，部分手机 webview 不会 ⇒ 剩余页签全部停在
  //  可视区外（实测：页签区整条空白、无处可点、指示器悬空）。
  //  收纳/放回的每一步都收敛一次滚动 + 重测指示器。
  useEffect(() => {
    clampScroll();
    measure();
  }, [visibleCount, measure, clampScroll]);

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
  const moreLabel = `更多${hiddenItems.length > 0 ? `(${hiddenItems.length})` : ''} ▾`;

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

  // 路由变化即退出搜索模式（跳转/选联想词后自动收起，页签区恢复）
  useEffect(() => {
    setSearchOpen(false);
  }, [location.pathname]);

  const closeSearch = () => {
    setSearchOpen(false);
    setKw('');
    setSugOpen(false);
  };

  // 搜索框渲染器：宽屏常驻与手机「搜索模式」共用同一份输入+联想结构
  const searchBox = (style: CSSProperties) => (
    <div ref={boxRef} style={style}>
      <input
        value={kw}
        autoFocus={narrow && searchOpen ? true : undefined}
        onChange={(e) => setKw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') goBest();
          if (e.key === 'Escape') closeSearch();
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
  );

  return (
    <>
      {/* 顶部分层（用户 2026-09-19 反馈：不应整块固定）：
          · **合规声明条** —— 全站必须始终可见（合规要求），故唯一固定；
          · **导航栏** —— 常规文档流，随页面滚动。导航是高频操作入口，
            长期占据首屏高度会挤压内容区，且与「只有声明该固定」的直觉不符。
          声明条与导航是兄弟节点，故用两个占位：声明条 fixed 需等高 spacer，
          导航回归文档流后不再需要占位（原实现整块 fixed + 92px spacer）。 */}
      <div
        ref={decRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          textAlign: 'center',
          padding: '8px 16px',
          fontSize: '12px',
          lineHeight: 1.35,
          color: '#f59e0b',
          backgroundColor: 'rgba(20,16,8,0.96)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
        }}
      >
        📚 本平台为学术研究项目，数据仅供参考，不构成投资建议
      </div>
      {/* 占位：高度恒等于声明条实测高度（折行也不重叠；单行时 ≈34px 与原值一致） */}
      <div style={{ height: decH }} aria-hidden />

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
        /* 🔴 激活态刻意不用 font-weight:700 —— 中文方字虽不变宽，但「更多(N) ▾」里的
           数字/箭头加粗会变宽（实测 ±2.5~10px），激活切换就会推挤相邻页签。
           激活标识已有四重：蓝字 + 底色 + 边框 + 底部滑动指示线，无需加粗。 */
        .pq-tab:hover { color: #e2e8f0; background-color: rgba(96,165,250,0.08); }
        .pq-tab-active { color: #60a5fa; background-color: rgba(96,165,250,0.1); border-color: rgba(96,165,250,0.3); }
      `}</style>

      {/* 品牌（手机端只留 logo，把宽度让给页签区；搜索模式下整块暂隐） */}
      <div
        style={{
          display: narrow && searchOpen ? 'none' : 'flex',
          alignItems: 'center',
          gap: '10px',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onClick={() => navigate('/')}
      >
        <BrandMark size={32} radius={9} shadow="0 4px 14px rgba(37,99,235,0.45)" />
        {!narrow && (
          <span style={{ fontSize: 15, fontWeight: 800, color: '#f1f5f9', letterSpacing: 1, whiteSpace: 'nowrap' }}>
            AI深度量化
          </span>
        )}
      </div>

      {/* 页签（窄屏横向滚动，永不换行；底部滑动指示器跟随激活项） */}
      <div
        ref={scrollRef}
        className="pq-topnav-scroll"
        style={{ position: 'relative', display: narrow && searchOpen ? 'none' : 'flex', alignItems: 'center', gap: '4px', flex: 1, minWidth: 0 }}
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
              data-label={item.label}
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
              data-label={moreLabel}
            >
              {/* 显示收起的数量：让用户知道"还有 N 个选项"在折叠里，而不是以为选项丢了 */}
              {moreLabel}
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

      {/* 全局搜索：宽屏常驻输入框；手机端折叠成图标，点开后输入区独占一整行（页签暂隐） */}
      {narrow && searchOpen ? (
        <>
          {searchBox({ position: 'relative', flex: 1, minWidth: 0 })}
          <span
            onClick={closeSearch}
            style={{ fontSize: 13, color: '#94a3b8', cursor: 'pointer', flexShrink: 0, userSelect: 'none' }}
          >
            取消
          </span>
        </>
      ) : narrow ? (
        <span
          onClick={() => setSearchOpen(true)}
          aria-label="搜索股票"
          title="搜索股票"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: 8,
            flexShrink: 0,
            cursor: 'pointer',
            color: '#94a3b8',
            border: '1px solid rgba(51,65,85,0.8)',
            backgroundColor: 'rgba(13,19,34,0.8)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.8-3.8" />
          </svg>
        </span>
      ) : (
        searchBox({ position: 'relative', width: 'clamp(150px, 16vw, 230px)', flexShrink: 0 })
      )}

      {/* 用户菜单 */}
      <UserMenu />
      </nav>
    </>
  );
}
