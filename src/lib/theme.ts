// ─────────────────────────────────────────────────────────────
// 全站设计规范（设计令牌）v2 —— 深空科技风
//   所有页面从这里取色/取字号/取间距/取背景
// ─────────────────────────────────────────────────────────────
export const theme = {
  color: {
    bg: '#080b12',
    bgRaised: '#131b2e',
    bgSunken: '#0d1322',
    border: '#263349',
    borderStrong: '#3b4a63',
    text: '#eef2f8',
    textMuted: '#a5b4cb',
    textFaint: '#7c8ba1',
    primary: '#60a5fa',
    primaryDeep: '#2563eb',
    up: '#ef4444',
    down: '#22c55e',
    warn: '#f59e0b',
    accent: '#38bdf8',
  },
  fontSize: { xs: 12, sm: 13, md: 14, lg: 16, xl: 20, xxl: 26 },
  radius: { sm: 8, md: 12, lg: 16, xl: 20 },
  spacing: (n: number) => `${n * 8}px`,
  /** 卡片通用样式（层次：边框微亮 + 顶部数据流描边 + 顶缘内高光，让卡片从深空底上"浮"起来） */
  card: {
    backgroundColor: '#131b2e',
    border: '1px solid #263349',
    borderTop: '1px solid rgba(96,165,250,0.38)',
    borderRadius: '12px',
    padding: '16px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.28), inset 0 1px 0 rgba(148,163,184,0.07)',
  },
  /** 玻璃卡片（微透 + 辉光边框 + 顶部数据流描边 + 顶缘高光） */
  glass: {
    backgroundColor: 'rgba(15,22,38,0.62)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    border: '1px solid rgba(148,183,235,0.17)',
    borderTop: '1px solid rgba(96,165,250,0.42)',
    borderRadius: '14px',
    padding: '16px',
    boxShadow: '0 10px 36px rgba(0,0,0,0.34), inset 0 1px 0 rgba(200,220,255,0.07)',
  } as const,
  /** 输入框通用样式 */
  input: {
    padding: '9px 12px',
    fontSize: '13px',
    color: '#eef2f8',
    backgroundColor: '#0d1322',
    border: '1px solid #334155',
    borderRadius: '8px',
    outline: 'none',
  },
  /** 页面容器（视觉底由全局 <Backdrop /> 深空极光层提供，此处保持透明让光斑透出） */
  page: {
    minHeight: '100vh',
    color: '#eef2f8',
    background: 'transparent',
  },
  /** 页面主容器统一规范——**全站满宽**：数据页与内容页宽度一致，切换不再跳变；
   *  长文可读性由各页/各卡内部自行约束 */
  pageWrap: {
    padding: '20px 16px 60px',
  },
  pageWrapNarrow: {
    padding: '16px 12px 48px',
  },
  /** 网格纹理叠层（放进页面容器内，absolute 定位） */
  gridOverlay: {
    position: 'absolute' as const,
    inset: 0,
    pointerEvents: 'none' as const,
    backgroundImage:
      'linear-gradient(rgba(148,163,184,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.035) 1px, transparent 1px)',
    backgroundSize: '48px 48px',
    maskImage: 'radial-gradient(ellipse at 50% 0%, black 15%, transparent 75%)',
    WebkitMaskImage: 'radial-gradient(ellipse at 50% 0%, black 15%, transparent 75%)',
  },
  /** 区块标题通用样式 */
  sectionTitle: {
    fontSize: 20,
    fontWeight: 600,
    margin: '0 0 16px',
    color: '#f8fafc',
  },
  /** CSS 动画关键帧（插入 <style> 标签用） */
  keyframes: `
    @keyframes pq-pulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
    @keyframes pq-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-14px) } }
    @keyframes pq-ticker { 0% { transform: translateX(0) } 100% { transform: translateX(-50%) } }
    @keyframes pq-shimmer { 0% { background-position: -200% 0 } 100% { background-position: 200% 0 } }
  `,
} as const;
