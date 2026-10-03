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
        @keyframes pq-flow1 { 0% { transform: translateX(-30%) } 100% { transform: translateX(130%) } }
        @keyframes pq-flow2 { 0% { transform: translateX(130%) } 100% { transform: translateX(-30%) } }
        /* 全局输入框 focus 反馈（可读性/交互细节：聚焦即亮边+柔光晕） */
        input:focus, textarea:focus, select:focus {
          border-color: rgba(96,165,250,0.6) !important;
          box-shadow: 0 0 0 3px rgba(37,99,235,0.16);
          outline: none;
        }
        /* 滚动条与深色主题融合 */
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(96,165,250,0.18); border-radius: 5px; border: 2px solid transparent; background-clip: content-box; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(96,165,250,0.32); border: 2px solid transparent; background-clip: content-box; }
      `}</style>

      {/* 数据流线条 ×2（1px 流光，青→品红双色渐变——呼应画布的激光数据流） */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, top: '31%', height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(34,211,238,0.3) 28%, rgba(232,121,249,0.32) 55%, rgba(34,211,238,0.14) 78%, transparent)',
          animation: 'pq-flow1 38s linear infinite',
        }}
      />
      <div
        style={{
          position: 'absolute', left: 0, right: 0, top: '67%', height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(232,121,249,0.2) 32%, rgba(34,211,238,0.28) 58%, rgba(232,121,249,0.1) 80%, transparent)',
          animation: 'pq-flow2 52s linear infinite',
        }}
      />

      {/* 深空基底（中性近黑——让极光光斑成为唯一色彩来源，层次对比最大化） */}
      <div
        style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(168deg, #05070c 0%, #080b12 42%, #0b0f1a 68%, #06080d 100%)',
        }}
      />

      {/* 极光光斑 ×4（青主 / 品红对角 / 蓝辅助 / 琥珀微暖——对齐参考画布的青左品右全息分布） */}
      <div
        style={{
          position: 'absolute', width: 920, height: 660, left: '-14%', top: '-22%', borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(34,211,238,0.4), transparent 72%)',
          filter: 'blur(58px)', animation: 'pq-aur1 26s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute', width: 820, height: 600, right: '-12%', bottom: '-20%', borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(232,121,249,0.26), transparent 72%)',
          filter: 'blur(64px)', animation: 'pq-aur2 34s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute', width: 560, height: 460, left: '40%', top: '26%', borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(37,99,235,0.26), transparent 72%)',
          filter: 'blur(70px)', animation: 'pq-aur3 40s ease-in-out infinite',
        }}
      />
      {/* 品红高光（右上，呼应画布 K 线图的品红侧光） */}
      <div
        style={{
          position: 'absolute', width: 460, height: 380, right: '6%', top: '-10%', borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(232,121,249,0.12), transparent 70%)',
          filter: 'blur(66px)', animation: 'pq-aur3 44s ease-in-out infinite reverse',
        }}
      />

      {/* 顶部聚光（中央高光——把视线聚焦到首屏内容，制造"舞台灯"纵深） */}
      <div
        style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(90% 55% at 50% -8%, rgba(34,211,238,0.16), transparent 60%)',
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
