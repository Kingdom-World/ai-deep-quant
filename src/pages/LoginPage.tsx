// ─────────────────────────────────────────────────────────────
// 登录 / 注册页（深色玻璃拟态 · 高科技风）
//   · 深蓝渐变背景 + 光晕 + 网格纹理；毛玻璃卡片；登录/注册双 Tab
//   · 由 App 路由守卫调用：未登录时整屏渲染本页，登录成功后进入平台
// ─────────────────────────────────────────────────────────────
import { useState } from 'react';
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
      const r =
        mode === 'login'
          ? await authApi.login(u, password)
          : await authApi.register(u, password);
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
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background:
          'radial-gradient(1000px 520px at 15% -10%, rgba(37,99,235,0.28), transparent 60%),' +
          'radial-gradient(900px 500px at 110% 110%, rgba(96,165,250,0.18), transparent 55%),' +
          'linear-gradient(160deg, #070b14 0%, #0b1220 45%, #070b14 100%)',
        color: '#e2e8f0',
        fontFamily:
          "-apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
      }}
    >
      {/* 关键帧动画（内联 style 无法表达 keyframes） */}
      <style>{`
        @keyframes pq-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-18px) } }
        @keyframes pq-shake { 0%,100% { transform: translateX(0) } 20%,60% { transform: translateX(-8px) } 40%,80% { transform: translateX(8px) } }
        @keyframes pq-scan { 0% { transform: translateY(-100%) } 100% { transform: translateY(100vh) } }
        .pq-input:focus { border-color: #60a5fa !important; box-shadow: 0 0 0 3px rgba(96,165,250,0.18) !important; }
        .pq-tab { flex: 1; text-align: center; padding: 11px 0; fontSize: 14px; cursor: pointer; color: #94a3b8; border-radius: 10px; transition: all .2s; }
      `}</style>

      {/* 背景装饰：光晕 / 网格 / 扫描线 */}
      <div
        style={{
          position: 'absolute', width: 340, height: 340, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(59,130,246,0.35), transparent 70%)',
          filter: 'blur(70px)', top: '8%', left: '12%', animation: 'pq-float 9s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute', width: 420, height: 420, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(14,165,233,0.22), transparent 70%)',
          filter: 'blur(90px)', bottom: '-10%', right: '8%', animation: 'pq-float 12s ease-in-out infinite reverse',
        }}
      />
      <div
        style={{
          position: 'absolute', inset: 0,
          backgroundImage:
            'linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
        }}
      />
      <div
        style={{
          position: 'absolute', left: 0, right: 0, height: '120px',
          background: 'linear-gradient(to bottom, transparent, rgba(96,165,250,0.05), transparent)',
          animation: 'pq-scan 7s linear infinite',
        }}
      />

      {/* 毛玻璃卡片 */}
      <div
        style={{
          position: 'relative',
          width: 400,
          maxWidth: '92vw',
          padding: '40px 36px 30px',
          backgroundColor: 'rgba(17,24,39,0.55)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: '1px solid rgba(96,165,250,0.18)',
          borderRadius: '20px',
          boxShadow: '0 24px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)',
          animation: shake ? 'pq-shake .45s ease' : undefined,
        }}
      >
        {/* 品牌区 */}
        <div style={{ textAlign: 'center', marginBottom: '26px' }}>
          <div
            style={{
              width: 64, height: 64, margin: '0 auto 14px', borderRadius: '18px',
              background: 'linear-gradient(135deg, #1d4ed8 0%, #3b82f6 55%, #60a5fa 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '30px',
              boxShadow: '0 8px 30px rgba(37,99,235,0.45), inset 0 1px 0 rgba(255,255,255,0.25)',
            }}
          >
            📊
          </div>
          <div style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '2px' }}>AI 深度量化</div>
          <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px', letterSpacing: '1px' }}>
            DEEP QUANT · 学术研究演示平台
          </div>
        </div>

        {/* 登录 / 注册 Tab */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', backgroundColor: 'rgba(13,19,34,0.7)', borderRadius: '12px', padding: '4px' }}>
          {(['login', 'register'] as const).map((m) => (
            <div
              key={m}
              className="pq-tab"
              style={{
                ...(mode === m
                  ? { background: 'linear-gradient(135deg, rgba(37,99,235,0.85), rgba(96,165,250,0.85))', color: '#fff', boxShadow: '0 4px 14px rgba(37,99,235,0.4)' }
                  : {}),
                fontWeight: mode === m ? 700 : 400,
              }}
              onClick={() => { setMode(m); setError(null); }}
            >
              {m === 'login' ? '登 录' : '注 册'}
            </div>
          ))}
        </div>

        {/* 表单 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}>
          <input
            className="pq-input"
            style={inputStyle}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名（2-20 位中英文/数字/下划线）"
            autoFocus
          />
          <input
            className="pq-input"
            style={inputStyle}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码（6-64 位）"
          />
          {mode === 'register' && (
            <input
              className="pq-input"
              style={inputStyle}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="确认密码"
            />
          )}

          {error && (
            <div style={{ fontSize: '13px', color: '#f87171', backgroundColor: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '10px', padding: '9px 12px' }}>
              ⚠️ {error}
            </div>
          )}

          <button
            style={{
              padding: '13px 0', fontSize: '15px', fontWeight: 700, color: '#fff',
              background: 'linear-gradient(135deg, #1d4ed8, #3b82f6 60%, #60a5fa)',
              border: 'none', borderRadius: '12px', cursor: busy ? 'wait' : 'pointer',
              boxShadow: '0 8px 24px rgba(37,99,235,0.4)', letterSpacing: '4px',
              opacity: busy ? 0.7 : 1,
            }}
            onClick={submit}
          >
            {busy ? '处理中…' : mode === 'login' ? '进入平台' : '创建账号'}
          </button>
        </div>

        <div style={{ marginTop: '22px', fontSize: '11px', color: '#475569', textAlign: 'center', lineHeight: 1.7 }}>
          登录状态保留 7 天 · 数据来源新浪/腾讯公开行情
          <br />
          本平台为学术研究演示项目，不构成任何投资建议
        </div>
      </div>
    </div>
  );
}
