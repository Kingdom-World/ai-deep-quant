// ─────────────────────────────────────────────────────────────
// 全站设计规范（设计令牌）：所有页面从这里取色/取字号/取间距，
// 避免内联样式各自为政导致风格漂移。
//   · 深色科技风基调；A 股配色习惯：红涨绿跌
// ─────────────────────────────────────────────────────────────
export const theme = {
  color: {
    bg: '#0a0e17', // 页面底色
    bgRaised: '#111827', // 卡片
    bgSunken: '#0d1322', // 下沉面板（输入框/行）
    border: '#1e293b',
    borderStrong: '#334155',
    text: '#e2e8f0',
    textMuted: '#94a3b8',
    textFaint: '#64748b',
    primary: '#60a5fa',
    primaryDeep: '#2563eb',
    up: '#ef4444', // 红涨
    down: '#22c55e', // 绿跌
    warn: '#f59e0b',
  },
  fontSize: { xs: 12, sm: 13, md: 14, lg: 16, xl: 20, xxl: 26 },
  radius: { sm: 8, md: 12, lg: 16, xl: 20 },
  /** 8px 网格间距 */
  spacing: (n: number) => `${n * 8}px`,
  /** 卡片通用样式 */
  card: {
    backgroundColor: '#111827',
    border: '1px solid #1e293b',
    borderRadius: '12px',
    padding: '16px',
  },
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
  /** 高科技页面底色：深空渐变 + 双光晕 */
  page: {
    minHeight: '100vh',
    color: '#e2e8f0',
    background:
      'radial-gradient(900px 480px at 12% -8%, rgba(37,99,235,0.16), transparent 60%),' +
      'radial-gradient(820px 460px at 108% 112%, rgba(14,165,233,0.12), transparent 55%),' +
      'linear-gradient(160deg, #070b14 0%, #0b1220 45%, #0a0e17 100%)',
  },
  /** 玻璃拟态卡片（配合页面底色使用） */
  glass: {
    backgroundColor: 'rgba(17,24,39,0.6)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    border: '1px solid rgba(96,165,250,0.16)',
    borderRadius: '14px',
    padding: '16px',
    boxShadow: '0 10px 36px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)',
  },
  /** 细网格纹理（叠在页面底色上，营造终端感） */
  gridOverlay: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    backgroundImage:
      'linear-gradient(rgba(148,163,184,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.045) 1px, transparent 1px)',
    backgroundSize: '42px 42px',
    maskImage: 'radial-gradient(ellipse at 50% 0%, black 20%, transparent 78%)',
    WebkitMaskImage: 'radial-gradient(ellipse at 50% 0%, black 20%, transparent 78%)',
  },
} as const;
