// ─────────────────────────────────────────────────────────────
// 登录 / 注册页 v2（深色玻璃拟态 · 高科技风）
//   · 粒子网络 canvas 背景（节点连线动画）+ 光晕 + 扫描线
//   · 渐变描边毛玻璃卡片 + HUD 角标 + 特性跑马灯
//   · 由 App 路由守卫调用：未登录时整屏渲染本页，登录成功后进入平台
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react';
import { authApi } from '../api/dataService';

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: '13px 16px',
  fontSize: '14px',
  color: '#e2e8f0',
  backgroundColor: 'rgba(13,19,34,0.7)',
  border: '1px solid rgba(100,116,139,0.35)',
  borderRadius: '12px',
  outline: 'none',
  transition: 'border-color .2s, box-shadow .2s',
};

/** 粒子网络背景：节点缓慢漂移，近距离节点连线（量化网络的视觉隐喻） */
function ParticleCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    const N = 72;
    const pts = Array.from({ length: N }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.45,
      vy: (Math.random() - 0.5) * 0.45,
    }));
    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
      }
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = pts[i];
          const b = pts[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < 132) {
            ctx.strokeStyle = `rgba(96,165,250,${((1 - dist / 132) * 0.28).toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      ctx.fillStyle = 'rgba(147,197,253,0.75)';
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} style={{ position: 'absolute', inset: 0 }} />;
}

/** HUD 四角括号 */
function Corners() {
  const base = { position: 'absolute' as const, width: 18, height: 18, borderColor: 'rgba(96,165,250,0.65)', borderStyle: 'solid' as const };
  return (
    <>
      <div style={{ ...base, top: -1, left: -1, borderWidth: '2px 0 0 2px', borderTopLeftRadius: 20 }} />
      <div style={{ ...base, top: -1, right: -1, borderWidth: '2px 2px 0 0', borderTopRightRadius: 20 }} />
      <div style={{ ...base, bottom: -1, left: -1, borderWidth: '0 0 2px 2px', borderBottomLeftRadius: 20 }} />
      <div style={{ ...base, bottom: -1, right: -1, borderWidth: '0 2px 2px 0', borderBottomRightRadius: 20 }} />
    </>
  );
}

const FEATURES = ['实时行情撮合', '五因子评分', '策略回测', '模拟交易', '形态识别', '智能问答'];

export default function LoginPage({ onLogin }: { onLogin: (username: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);

  const fail = (text: string) => {
    setError(text);
    setShake(true);
    window.setTimeout(() => setShake(false), 500);
  };

  const submit = async () => {
    if (busy) return;
    const u = username.trim();
    if (!u || !password) return fail('请输入用户名和密码');
    if (mode === 'register' && password !== confirm) return fail('两次输入的密码不一致');
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'login' ? await authApi.login(u, password) : await authApi.register(u, password);
      if (!r.ok) return fail(r.error || '操作失败，请重试');
      onLogin(r.username || u);
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background:
          'radial-gradient(1000px 520px at 15% -10%, rgba(37,99,235,0.30), transparent 60%),' +
          'radial-gradient(900px 500px at 110% 110%, rgba(14,165,233,0.20), transparent 55%),' +
          'linear-gradient(160deg, #070b14 0%, #0b1220 45%, #070b14 100%)',
        color: '#e2e8f0',
        fontFamily: "-apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
      }}
    >
      <style>{`
        @keyframes pq-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-18px) } }
        @keyframes pq-aurora1 { 0%,100% { transform: translate(-6%,-4%) rotate(0deg) scale(1); filter: blur(70px) hue-rotate(0deg) } 33% { transform: translate(9%,9%) rotate(24deg) scale(1.22); filter: blur(84px) hue-rotate(28deg) } 66% { transform: translate(-8%,12%) rotate(-16deg) scale(1.08); filter: blur(76px) hue-rotate(-18deg) } }
        @keyframes pq-aurora2 { 0%,100% { transform: translate(4%,6%) rotate(0deg) scale(1.05); filter: blur(90px) hue-rotate(0deg) } 50% { transform: translate(-10%,-10%) rotate(-22deg) scale(1.2); filter: blur(100px) hue-rotate(35deg) } }
        @keyframes pq-shake { 0%,100% { transform: translateX(0) } 20%,60% { transform: translateX(-8px) } 40%,80% { transform: translateX(8px) } }
        @keyframes pq-scan { 0% { transform: translateY(-120px) } 100% { transform: translateY(100vh) } }
        @keyframes pq-ticker { 0% { transform: translateX(0) } 100% { transform: translateX(-50%) } }
        @keyframes pq-pulse { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
        .pq-input:focus { border-color: #60a5fa !important; box-shadow: 0 0 0 3px rgba(96,165,250,0.18), 0 0 24px rgba(96,165,250,0.12) !important; }
      `}</style>

      <ParticleCanvas />

      {/* 极光光斑（动画漂移 + 色相旋转）与网格 */}
      <div
        style={{
          position: 'absolute', width: 380, height: 380, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(59,130,246,0.32), transparent 70%)',
          top: '5%', left: '8%', animation: 'pq-aurora1 18s ease-in-out infinite', pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute', width: 440, height: 440, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(14,165,233,0.22), transparent 70%)',
          bottom: '-8%', right: '6%', animation: 'pq-aurora2 24s ease-in-out infinite', pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute', width: 300, height: 300, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(139,92,246,0.16), transparent 70%)',
          filter: 'blur(80px)', top: '38%', left: '46%', animation: 'pq-float 11s ease-in-out infinite', pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage:
            'linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
        }}
      />
      <div
        style={{
          position: 'absolute', left: 0, right: 0, height: 120, pointerEvents: 'none',
          background: 'linear-gradient(to bottom, transparent, rgba(96,165,250,0.06), transparent)',
          animation: 'pq-scan 7s linear infinite',
        }}
      />

      {/* 毛玻璃卡片（渐变描边 + HUD 角标） */}
      <div
        style={{
          position: 'relative',
          width: 404,
          maxWidth: '92vw',
          padding: '38px 36px 26px',
          backgroundColor: 'rgba(17,24,39,0.55)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: '1px solid rgba(96,165,250,0.22)',
          borderRadius: 20,
          boxShadow: '0 24px 80px rgba(0,0,0,0.55), 0 0 60px rgba(37,99,235,0.12), inset 0 1px 0 rgba(255,255,255,0.06)',
          animation: shake ? 'pq-shake .45s ease' : undefined,
        }}
      >
        <Corners />

        {/* 品牌区 */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              width: 66, height: 66, margin: '0 auto 14px', borderRadius: 18,
              background: 'linear-gradient(135deg, #1d4ed8 0%, #3b82f6 55%, #60a5fa 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30,
              boxShadow: '0 8px 30px rgba(37,99,235,0.5), inset 0 1px 0 rgba(255,255,255,0.25)',
              animation: 'pq-pulse 3.2s ease-in-out infinite',
            }}
          >
            📊
          </div>
          <div
            style={{
              fontSize: 23, fontWeight: 800, letterSpacing: 3,
              background: 'linear-gradient(90deg, #f8fafc 30%, #93c5fd)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}
          >
            AI 深度量化
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, letterSpacing: 2, fontFamily: 'Consolas, monospace' }}>
            DEEP QUANT SYSTEM · v2.0
          </div>
        </div>

        {/* 登录 / 注册 Tab */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, backgroundColor: 'rgba(13,19,34,0.75)', borderRadius: 12, padding: 4 }}>
          {(['login', 'register'] as const).map((m) => (
            <div
              key={m}
              onClick={() => { setMode(m); setError(null); }}
              style={{
                flex: 1, textAlign: 'center', padding: '11px 0', fontSize: 14, cursor: 'pointer',
                color: mode === m ? '#fff' : '#94a3b8',
                fontWeight: mode === m ? 700 : 400,
                background: mode === m ? 'linear-gradient(135deg, rgba(37,99,235,0.9), rgba(96,165,250,0.9))' : 'transparent',
                borderRadius: 10,
                boxShadow: mode === m ? '0 4px 14px rgba(37,99,235,0.4)' : 'none',
                transition: 'all .2s',
              }}
            >
              {m === 'login' ? '登 录' : '注 册'}
            </div>
          ))}
        </div>

        {/* 表单 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}>
          <input
            className="pq-input" style={inputStyle} value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名（2-20 位中英文/数字/下划线）" autoFocus
          />
          <input
            className="pq-input" style={inputStyle} type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="密码（6-64 位）"
          />
          {mode === 'register' && (
            <input
              className="pq-input" style={inputStyle} type="password" value={confirm}
              onChange={(e) => setConfirm(e.target.value)} placeholder="确认密码"
            />
          )}
          {error && (
            <div style={{ fontSize: 13, color: '#f87171', backgroundColor: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 10, padding: '9px 12px' }}>
              ⚠️ {error}
            </div>
          )}
          <button
            style={{
              padding: '13px 0', fontSize: 15, fontWeight: 700, color: '#fff',
              background: 'linear-gradient(135deg, #1d4ed8, #3b82f6 60%, #60a5fa)',
              border: 'none', borderRadius: 12, cursor: busy ? 'wait' : 'pointer',
              boxShadow: '0 8px 24px rgba(37,99,235,0.45)', letterSpacing: 4, opacity: busy ? 0.7 : 1,
            }}
            onClick={submit}
          >
            {busy ? '处理中…' : mode === 'login' ? '进入平台' : '创建账号'}
          </button>
        </div>

        <div style={{ marginTop: 20, fontSize: 11, color: '#475569', textAlign: 'center', lineHeight: 1.7 }}>
          会话保留 7 天 · 数据来源新浪/腾讯公开行情
          <br />
          本平台为学术研究演示项目，不构成任何投资建议
        </div>
      </div>

      {/* 底部特性跑马灯 */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden',
          borderTop: '1px solid rgba(96,165,250,0.15)', backgroundColor: 'rgba(7,11,20,0.8)',
          padding: '9px 0',
        }}
      >
        <div style={{ display: 'flex', width: 'max-content', gap: 48, animation: 'pq-ticker 26s linear infinite' }}>
          {[...FEATURES, ...FEATURES, ...FEATURES].map((f, i) => (
            <span key={i} style={{ fontSize: 12, color: '#64748b', fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap' }}>
              <span style={{ color: '#60a5fa' }}>◆</span> {f}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
