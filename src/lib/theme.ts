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
} as const;
