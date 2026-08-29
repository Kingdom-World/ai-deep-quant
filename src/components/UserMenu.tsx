// ─────────────────────────────────────────────────────────────
// 用户菜单：显示当前登录用户 + 退出登录
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import { authApi } from '../api/dataService';

export default function UserMenu() {
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    authApi
      .me()
      .then((m) => setUsername(m.ok ? m.username : null))
      .catch(() => setUsername(null));
  }, []);

  if (!username) return null;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          backgroundColor: 'rgba(96,165,250,0.1)',
          border: '1px solid rgba(96,165,250,0.3)',
          borderRadius: '999px',
          color: '#93c5fd',
        }}
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
        {username}
      </span>
      <button
        style={{
          padding: '6px 12px',
          fontSize: '12px',
          color: '#94a3b8',
          backgroundColor: 'transparent',
          border: '1px solid #334155',
          borderRadius: '8px',
          cursor: 'pointer',
        }}
        onClick={async () => {
          await authApi.logout().catch(() => undefined);
          window.location.reload();
        }}
      >
        退出
      </button>
    </span>
  );
}
