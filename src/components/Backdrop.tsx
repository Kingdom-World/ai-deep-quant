// ─────────────────────────────────────────────────────────────
// 全站统一背景层「深空极光」：所有主页面共用（App 挂载一次，fixed 定位）
//   层次：深空基底 → 极光光斑（缓慢漂移呼吸）→ 细网格（径向渐隐）→ 噪点颗粒 → 边缘暗角
//   设计意图：用大面积低饱和光晕与胶片颗粒营造"终端暗房"质感，替代扁平纯色底
//   性能：纯 CSS 动画（transform/opacity 合成层），无 canvas、无每帧重排
// ─────────────────────────────────────────────────────────────
export default function Backdrop() {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: -1, overflow: 'hidden', pointerEvents: 'none' }}>
      <style>{`
        @keyframes pq-aur1 { 0%,100% { transform: translate(0,0) scale(1); opacity: .85 } 50% { transform: translate(9%, 7%) scale(1.18); opacity: 1 } }
        @keyframes pq-aur2 { 0%,100% { transform: translate(0,0) scale(1.05); opacity: .7 } 50% { transform: translate(-8%, -9%) scale(1.22); opacity: .95 } }
        @keyframes pq-aur3 { 0%,100% { transform: translate(0,0) scale(1); opacity: .5 } 50% { transform: translate(6%, -8%) scale(1.15); opacity: .8 } }
      `}</style>

      {/* 深空基底 */}
      <div
        style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(168deg, #05080f 0%, #0a0f1a 42%, #0d1424 68%, #080c15 100%)',
        }}
      />

      {/* 极光光斑 ×3（深蓝 / 青 / 紫罗兰，呼吸漂移） */}
      <div
        style={{
          position: 'absolute', width: 860, height: 620, left: '-14%', top: '-22%', borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(37,99,235,0.22), transparent 72%)',
          filter: 'blur(58px)', animation: 'pq-aur1 26s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute', width: 780, height: 560, right: '-12%', bottom: '-20%', borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(14,165,233,0.17), transparent 72%)',
          filter: 'blur(64px)', animation: 'pq-aur2 34s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute', width: 520, height: 420, left: '42%', top: '30%', borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(124,58,237,0.13), transparent 72%)',
          filter: 'blur(70px)', animation: 'pq-aur3 40s ease-in-out infinite',
        }}
      />

      {/* 细网格（顶部径向渐隐，弱化存在感只留质感） */}
      <div
        style={{
          position: 'absolute', inset: 0,
          backgroundImage:
            'linear-gradient(rgba(148,163,184,0.032) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.032) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse at 50% 0%, black 8%, transparent 68%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 0%, black 8%, transparent 68%)',
        }}
      />

      {/* 噪点颗粒（SVG feTurbulence，胶片质感） */}
      <div
        style={{
          position: 'absolute', inset: 0, opacity: 0.05,
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />

      {/* 边缘暗角（聚焦中心内容） */}
      <div
        style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(125% 95% at 50% 38%, transparent 58%, rgba(2,4,10,0.5) 100%)',
        }}
      />
    </div>
  );
}
