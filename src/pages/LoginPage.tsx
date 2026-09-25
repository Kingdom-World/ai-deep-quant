// ─────────────────────────────────────────────────────────────
// 登录 / 注册页 v3（深空极光 · 行情脉冲 · 玻璃质感）
//   · MeshGradient WebGL 流体渐变着色器（鼠标交互 · Stripe 级视觉）
//   · 渐变描边毛玻璃卡片（光束扫过）+ HUD 角标 + 特性跑马灯
//   · 由 App 路由守卫调用：未登录时整屏渲染本页，登录成功后进入平台
// ─────────────────────────────────────────────────────────────
import { useState } from 'react';
import MeshGradient from '../components/MeshGradient';
import BrandMark from '../components/BrandMark';
import { authApi } from '../api/dataService';

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: '13px 16px',
  fontSize: '14px',
  color: '#f1f5f9',
  backgroundColor: 'rgba(255,255,255,0.045)',
  border: '1px solid rgba(148,163,184,0.28)',
  borderRadius: '10px',
  outline: 'none',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  transition: 'border-color .2s, box-shadow .2s, background .2s',
};



const FEATURES = ['实时行情撮合', '五因子评分', '策略回测', '模拟交易', '形态识别', '智能问答'];

export default function LoginPage({ onLogin }: { onLogin: (username: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invite, setInvite] = useState('');
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
      const r = mode === 'login' ? await authApi.login(u, password) : await authApi.register(u, password, invite.trim());
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
        background: 'transparent',
        color: '#e2e8f0',
        fontFamily: "-apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
      }}
    >
      <style>{`
        @keyframes pq-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-18px) } }
        @keyframes pq-shake { 0%,100% { transform: translateX(0) } 20%,60% { transform: translateX(-8px) } 40%,80% { transform: translateX(8px) } }
        @keyframes pq-ticker { 0% { transform: translateX(0) } 100% { transform: translateX(-50%) } }
        @keyframes pq-pulse { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
        .pq-input:focus { border-color: #7dd3fc !important; background: rgba(255,255,255,0.07) !important; box-shadow: 0 0 0 3px rgba(96,165,250,0.16), 0 0 28px rgba(56,189,248,0.14) !important; }
      `}</style>

      <MeshGradient />

      {/* 企业级去框化表单：直接与背景融为一体 */}
      <div
        style={{
          position: 'relative',
          width: 380,
          maxWidth: '92vw',
          padding: '0 8px',
          animation: shake ? 'pq-shake .45s ease' : undefined,
        }}
      >
        {/* 品牌区 */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ width: 74, margin: '0 auto 20px' }}>
            <BrandMark
              size={74}
              radius={18}
              shadow="0 10px 36px rgba(37,99,235,0.45), inset 0 1px 0 rgba(255,255,255,0.25)"
            />
          </div>
          <div
            style={{
              fontSize: 46, fontWeight: 800, letterSpacing: 6,
              background: 'linear-gradient(180deg, #f8fafc 20%, #bfdbfe 72%, #93c5fd)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              filter: 'drop-shadow(0 0 26px rgba(96,165,250,0.35))',
            }}
          >
            AI 深度量化
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 10, letterSpacing: 4, fontFamily: 'Consolas, monospace' }}>
            DEEP QUANT SYSTEM · v2.0
          </div>
        </div>

        {/* 登录 / 注册（下划线指示，去框化） */}
        <div style={{ display: 'flex', gap: 30, marginBottom: 26, justifyContent: 'center' }}>
          {(['login', 'register'] as const).map((m) => (
            <div
              key={m}
              onClick={() => { setMode(m); setError(null); }}
              style={{
                padding: '6px 2px 10px', fontSize: 15, cursor: 'pointer',
                color: mode === m ? '#f1f5f9' : '#7c8aa0',
                fontWeight: mode === m ? 700 : 400,
                borderBottom: mode === m ? '2px solid #60a5fa' : '2px solid transparent',
                textShadow: mode === m ? '0 0 24px rgba(96,165,250,0.45)' : 'none',
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
          {mode === 'register' && (
            <input
              className="pq-input" style={inputStyle} value={invite}
              onChange={(e) => setInvite(e.target.value)} placeholder="邀请码（向管理员索取；未开启则留空）"
            />
          )}
          {error && (
            <div style={{ fontSize: 13, color: '#f87171', backgroundColor: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.22)', borderRadius: 10, padding: '9px 12px', backdropFilter: 'blur(6px)' }}>
              ⚠️ {error}
            </div>
          )}
          <button
            style={{
              marginTop: 4,
              padding: '14px 0', fontSize: 15, fontWeight: 700, color: '#fff',
              background: 'linear-gradient(135deg, #1d4ed8, #3b82f6 60%, #60a5fa)',
              border: 'none', borderRadius: 10, cursor: busy ? 'wait' : 'pointer',
              boxShadow: '0 10px 32px rgba(37,99,235,0.45)', letterSpacing: 6, opacity: busy ? 0.7 : 1,
            }}
            onClick={submit}
          >
            {busy ? '处理中…' : mode === 'login' ? '进入平台' : '创建账号'}
          </button>
        </div>

        <div style={{ marginTop: 22, fontSize: 11, color: '#5b6b85', textAlign: 'center', lineHeight: 1.7 }}>
          会话保留 7 天 · 数据来源：新浪/腾讯（实时行情）· 东方财富（板块/财务/资讯）
          <br />
          本平台为学术研究演示项目，不构成任何投资建议
          <br />
          提问内容可能由 AI 服务处理，请勿输入个人敏感信息
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
