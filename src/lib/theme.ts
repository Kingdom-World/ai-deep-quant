// ─────────────────────────────────────────────────────────────
// 全站设计规范（设计令牌）v2 —— 深空科技风
//   所有页面从这里取色/取字号/取间距/取背景
// ─────────────────────────────────────────────────────────────
export const theme = {
  color: {
    bg: '#0a0e17',
    bgRaised: '#111827',
    bgSunken: '#0d1322',
    border: '#1e293b',
    borderStrong: '#334155',
    text: '#e2e8f0',
    textMuted: '#94a3b8',
    textFaint: '#64748b',
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
  /** 卡片通用样式 */
  card: {
    backgroundColor: '#111827',
    border: '1px solid #1e293b',
    borderRadius: '12px',
    padding: '16px',
  },
  /** 玻璃卡片（微透 + 辉光边框） */
  glass: {
    backgroundColor: 'rgba(17,24,39,0.55)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    border: '1px solid rgba(96,165,250,0.14)',
    borderRadius: '14px',
    padding: '16px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04)',
  } as const,
  /** 输入框通用样式 */
  input: {
    padding: '9px 12px',
    fontSize: '13px',
    color: '#e2e8f0',
    backgroundColor: '#0d1322',
    border: '1px solid #334155',
    borderRadius: '8px',
    outline: 'none',
  },
  /** 深空渐变页面底（全站统一） */
  page: {
    minHeight: '100vh',
    color: '#e2e8f0',
    background: [
      'radial-gradient(1000px 500px at 10% -5%, rgba(37,99,235,0.14), transparent 60%)',
      'radial-gradient(800px 400px at 105% 15%, rgba(14,165,233,0.10), transparent 55%)',
      'radial-gradient(600px 400px at 50% 110%, rgba(59,130,246,0.08), transparent 50%)',
      'linear-gradient(165deg, #060a12 0%, #0a0f1a 40%, #0c1220 70%, #0a0e17 100%)',
    ].join(','),
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
    color: '#f1f5f9',
  },
  /** CSS 动画关键帧（插入 <style> 标签用） */
  keyframes: `
    @keyframes pq-pulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
    @keyframes pq-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-14px) } }
    @keyframes pq-ticker { 0% { transform: translateX(0) } 100% { transform: translateX(-50%) } }
    @keyframes pq-shimmer { 0% { background-position: -200% 0 } 100% { background-position: 200% 0 } }
  `,
} as const;
