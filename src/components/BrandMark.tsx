// ─────────────────────────────────────────────────────────────
// 全站品牌标志：深空圆角底座 + 三根递进 K 线 + 上升趋势线 + AI 信号亮点
//   与 public/favicon.svg 同源同构（改一处请同步另一处）：
//   · 导航栏 32px / 登录页 74px / 启动屏 56px 等品牌位统一用它替换 emoji
// ─────────────────────────────────────────────────────────────
export default function BrandMark({
  size = 32,
  radius,
  shadow,
  title = 'AI深度量化',
}: {
  /** 渲染尺寸（正方形边长，px） */
  size?: number;
  /** 圆角半径；默认随尺寸缩放（约边长 23%，与底座 rx=15/64 一致） */
  radius?: number;
  /** 外发光阴影（登录页大徽章用） */
  shadow?: string;
  title?: string;
}) {
  const r = radius ?? Math.round(size * 0.23);
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      style={{
        display: 'block',
        flexShrink: 0,
        borderRadius: r,
        boxShadow: shadow,
      }}
    >
      <defs>
        <linearGradient id="bmk-bg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#101b31" />
          <stop offset="1" stopColor="#0a0e17" />
        </linearGradient>
        <radialGradient id="bmk-glow" cx="0.18" cy="0.1" r="1">
          <stop offset="0" stopColor="#60a5fa" stopOpacity="0.26" />
          <stop offset="0.55" stopColor="#60a5fa" stopOpacity="0.05" />
          <stop offset="1" stopColor="#60a5fa" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="bmk-accent" x1="11" y1="47" x2="51" y2="10" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
        <linearGradient id="bmk-candle3" x1="0" y1="19" x2="0" y2="31" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7dd3fc" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
        <filter id="bmk-soft" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="1.7" />
        </filter>
      </defs>

      {/* 深空底座 */}
      <rect x="1.5" y="1.5" width="61" height="61" rx="15" fill="url(#bmk-bg)" />
      <rect x="1.5" y="1.5" width="61" height="61" rx="15" fill="url(#bmk-glow)" />

      {/* 行情网格纹理 */}
      <path d="M2 22H62 M2 42H62 M22 2V62 M42 2V62" stroke="#94a3b8" strokeOpacity="0.07" strokeWidth="1" />

      {/* K 线三兄弟：逐级抬升 */}
      <g stroke="#7dd3fc" strokeOpacity="0.66" strokeWidth="1.6" strokeLinecap="round">
        <path d="M19 33V49" />
        <path d="M31 25V41" />
        <path d="M43 15V33" />
      </g>
      <rect x="15.5" y="37" width="7" height="10" rx="2" fill="#60a5fa" fillOpacity="0.42" />
      <rect x="27.5" y="29" width="7" height="10" rx="2" fill="#3b82f6" fillOpacity="0.8" />
      <rect x="39.5" y="19" width="7" height="12" rx="2" fill="url(#bmk-candle3)" />

      {/* 上升趋势线（辉光层 + 主线层） */}
      <path
        d="M11 47L21 36L31 27L43 16.5L50.5 10.5"
        fill="none"
        stroke="#38bdf8"
        strokeOpacity="0.32"
        strokeWidth="5.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#bmk-soft)"
      />
      <path
        d="M11 47L21 36L31 27L43 16.5L50.5 10.5"
        fill="none"
        stroke="url(#bmk-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* AI 信号亮点 */}
      <circle cx="50.5" cy="10.5" r="8" fill="#38bdf8" fillOpacity="0.14" />
      <circle cx="50.5" cy="10.5" r="4.6" fill="#38bdf8" fillOpacity="0.3" />
      <circle cx="50.5" cy="10.5" r="2.4" fill="#e0f2fe" />

      {/* 星尘 */}
      <circle cx="11.5" cy="13" r="1" fill="#cbd5e1" fillOpacity="0.55" />
      <circle cx="52.5" cy="45" r="0.9" fill="#cbd5e1" fillOpacity="0.4" />

      {/* 玻璃描边 + 顶缘高光 */}
      <rect x="1.5" y="1.5" width="61" height="61" rx="15" fill="none" stroke="#60a5fa" strokeOpacity="0.33" strokeWidth="1.5" />
      <path d="M16 2.25H48" stroke="#ffffff" strokeOpacity="0.12" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
