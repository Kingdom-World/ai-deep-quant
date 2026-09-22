// ─────────────────────────────────────────────────────────────
// 用户菜单：显示当前登录用户 + 修改密码 + 退出登录
//   · 头像胶囊点击弹出菜单；修改密码为站内弹窗（验证旧密码，uid 不变）
//   · 改密成功后会话令牌仍有效，无需重新登录
// ─────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react';
import { authApi } from '../api/dataService';
import { theme } from '../lib/theme';
import InviteManagerModal from './InviteManagerModal';

const MENU_BTN = {
  width: '100%',
  textAlign: 'left' as const,
  padding: '9px 14px',
  fontSize: 13,
  color: theme.color.text,
  backgroundColor: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

const INPUT = {
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: '10px 12px',
  fontSize: 13,
  color: theme.color.text,
  backgroundColor: theme.color.bgSunken,
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: 8,
  outline: 'none' as const,
};

function ChangePasswordModal({ username, onClose }: { username: string; onClose: () => void }) {
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!oldPwd || !newPwd) return setError('请填写旧密码和新密码');
    if (newPwd.length < 6 || newPwd.length > 64) return setError('新密码长度需为 6-64 位');
    if (newPwd !== confirmPwd) return setError('两次输入的新密码不一致');
    setBusy(true);
    setError(null);
    try {
      const r = await authApi.changePassword(oldPwd, newPwd);
      if (!r.ok) throw new Error(r.error || '修改失败，请重试');
      setDone(true);
      window.setTimeout(onClose, 1800);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(4,8,16,0.66)', backdropFilter: 'blur(4px)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
        style={{ ...theme.glass, width: 360, maxWidth: '92vw', padding: '22px 22px 18px' }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: theme.color.text, marginBottom: 4 }}>修改密码</div>
        <div style={{ fontSize: 12, color: theme.color.textFaint, marginBottom: 16 }}>账号：{username} · 改密后无需重新登录</div>
        {done ? (
          <div style={{ padding: '14px 0 8px', textAlign: 'center', fontSize: 14, color: '#4ade80' }}>✓ 密码已更新，下次登录请使用新密码</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            <input type="password" style={INPUT} value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} placeholder="旧密码" autoFocus />
            <input type="password" style={INPUT} value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder="新密码（6-64 位）" />
            <input type="password" style={INPUT} value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} placeholder="确认新密码" />
            {error && (
              <div style={{ fontSize: 12.5, color: '#f87171', backgroundColor: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.22)', borderRadius: 8, padding: '8px 11px' }}>
                ⚠️ {error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
              <button onClick={onClose} style={{ flex: 1, padding: '10px 0', fontSize: 13, color: theme.color.textMuted, backgroundColor: 'transparent', border: `1px solid ${theme.color.borderStrong}`, borderRadius: 8, cursor: 'pointer' }}>
                取消
              </button>
              <button onClick={submit} disabled={busy} style={{ flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg, #1d4ed8, #3b82f6)', border: 'none', borderRadius: 8, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1 }}>
                {busy ? '提交中…' : '确认修改'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function UserMenu() {
  const [username, setUsername] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    authApi
      .me()
      .then((m) => {
        setUsername(m.ok ? m.username : null);
        setIsAdmin(!!m.isAdmin);
      })
      .catch(() => setUsername(null));
  }, []);

  // 点击菜单外部关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // 窄屏检测：手机上把用户胶囊收缩为「头像圆点」。
  //  为什么：完整胶囊（头像+用户名+管理员徽章+▼）实测宽 146px，
  //  在 375px 视口下从 x=362 起被挤出屏幕 ⇒ 用户菜单（含邀请码管理入口）**不可达**。
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 690px)');
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  if (!username) return null;

  return (
    <span ref={boxRef} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', position: 'relative' }}>
      {/* 头像胶囊（点击展开菜单） */}
      <span
        onClick={() => setMenuOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          backgroundColor: 'rgba(96,165,250,0.1)',
          border: '1px solid rgba(96,165,250,0.3)',
          borderRadius: '999px',
          color: '#93c5fd',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        title="账号菜单"
      >
        <span
          style={{
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #2563eb, #60a5fa)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '11px',
            color: '#fff',
          }}
        >
          {username.slice(0, 1).toUpperCase()}
        </span>
        {/* 窄屏（≤690px）只显示头像圆点 —— 完整胶囊实测宽 146px，
            在 375px 视口下从 x=362 起被挤出屏幕，导致用户菜单不可达 */}
        {!narrow && (
          <>
            {username}
            {isAdmin && (
              <span style={{ fontSize: 9, color: '#fbbf24', backgroundColor: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4, padding: '0 5px' }}>
                管理员
              </span>
            )}
            <span style={{ fontSize: 9, color: '#64748b', transform: menuOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>▼</span>
          </>
        )}
      </span>

      {/* 下拉菜单 */}
      {menuOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: 150,
            padding: '6px',
            backgroundColor: 'rgba(13,19,34,0.97)',
            border: `1px solid ${theme.color.borderStrong}`,
            borderRadius: 10,
            boxShadow: '0 14px 38px rgba(0,0,0,0.55)',
            zIndex: 200,
          }}
        >
          <div style={{ padding: '7px 14px', fontSize: 11, color: theme.color.textFaint, borderBottom: `1px solid ${theme.color.border}`, marginBottom: 4 }}>
            已登录：{username}
          </div>
          {/* 邀请码管理：仅管理员可见（后端 /api/auth/invites 同样会校验，前端只是不显示入口） */}
          {isAdmin && (
            <button
              style={{ ...MENU_BTN, borderRadius: 7 }}
              onClick={() => {
                setMenuOpen(false);
                setInviteOpen(true);
              }}
            >
              🎫 邀请码管理
            </button>
          )}
          <button
            style={{ ...MENU_BTN, borderRadius: 7 }}
            onClick={() => {
              setMenuOpen(false);
              setPwdOpen(true);
            }}
          >
            🔑 修改密码
          </button>
          <button
            style={{ ...MENU_BTN, borderRadius: 7, color: '#94a3b8' }}
            onClick={async () => {
              setMenuOpen(false);
              await authApi.logout().catch(() => undefined);
              window.location.reload();
            }}
          >
            ↩ 退出登录
          </button>
        </div>
      )}

      {pwdOpen && <ChangePasswordModal username={username} onClose={() => setPwdOpen(false)} />}
      {inviteOpen && <InviteManagerModal onClose={() => setInviteOpen(false)} />}
    </span>
  );
}
