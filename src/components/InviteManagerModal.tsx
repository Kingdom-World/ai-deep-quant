// ─────────────────────────────────────────────────────────────
// 邀请码管理弹窗（仅管理员）
//
//   为什么要有它：邀请码此前**只有命令行与接口、没有界面** —— 管理员得记命令、
//   拼 curl，对"给 6 位朋友发码"这种日常操作太别扭。
//
//   能力：生成（可带备注与有效天数）· 查看（含谁用了、何时用）· 吊销（保留记录）
//   入口：右上角用户名 → 下拉菜单 →「🎫 邀请码管理」（仅管理员可见该入口）
//
//   ⚠️ 状态语义（与后端一致）：
//     · 已吊销 → 不可再注册，但记录保留（可追溯"这张码曾经存在过"）
//     · 已使用 → 一码一人，绑定了使用者
//     · 已过期 → 到了 expiresAt（未设天数则永不过期，只能吊销）
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react';
import { authApi, type InviteEntry } from '../api/dataService';
import { theme } from '../lib/theme';

const INPUT = {
  boxSizing: 'border-box' as const,
  padding: '9px 11px',
  fontSize: 13,
  color: theme.color.text,
  backgroundColor: theme.color.bgSunken,
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: 8,
  outline: 'none' as const,
};

const BTN_PRIMARY = {
  padding: '9px 16px',
  fontSize: 13,
  fontWeight: 700 as const,
  color: '#fff',
  background: 'linear-gradient(135deg, #1d4ed8, #3b82f6)',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer' as const,
};

const BTN_GHOST = {
  padding: '5px 10px',
  fontSize: 12,
  color: theme.color.textMuted,
  backgroundColor: 'transparent',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: 6,
  cursor: 'pointer' as const,
};

/** 单张码的状态（三态之外再加"已过期"） */
function stateOf(c: InviteEntry): { label: string; color: string } {
  if (c.revoked) return { label: '已吊销', color: '#94a3b8' };
  if (c.usedBy) return { label: '已使用', color: '#60a5fa' };
  if (c.expiresAt && Date.parse(c.expiresAt) < Date.now()) return { label: '已过期', color: '#f59e0b' };
  return { label: '可用', color: '#4ade80' };
}

export default function InviteManagerModal({ onClose }: { onClose: () => void }) {
  const [codes, setCodes] = useState<InviteEntry[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [ttl, setTtl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authApi.listInvites();
      setCodes(r.codes || []);
      setEnabled(r.enabled !== false);
      setError(null);
    } catch (e) {
      setError((e as Error).message || '读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      const days = Number(ttl) > 0 ? Number(ttl) : undefined;
      const r = await authApi.createInvite(note.trim(), days);
      if (!r.ok || !r.entry) throw new Error(r.error || '生成失败');
      setNote('');
      setTtl('');
      setHint(`已生成 ${r.entry.code} —— 复制发给朋友，注册时填入即可`);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string) => {
    setError(null);
    setHint(null);
    try {
      const r = await authApi.revokeInvite(code);
      if (!r.ok) throw new Error(r.error || '吊销失败');
      setHint(`已吊销 ${code}`);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setHint(`已复制 ${code}`);
    } catch {
      setHint(`复制失败，请手动选中：${code}`);
    }
  };

  const unused = codes.filter((c) => !c.usedBy && !c.revoked).length;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(4,8,16,0.66)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        style={{ ...theme.glass, width: 620, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto', padding: '22px 22px 18px' }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: theme.color.text }}>邀请码管理</div>
          <div style={{ fontSize: 12, color: theme.color.textFaint }}>
            共 {codes.length} 张 · 未用 <span style={{ color: '#4ade80' }}>{unused}</span>
          </div>
        </div>
        <div style={{ fontSize: 12, color: theme.color.textFaint, marginBottom: 16 }}>
          一码一人：一张码只能注册一个账号，成功注册后自动绑定使用者；可随时吊销（保留记录便于追溯）。
        </div>

        {!enabled && (
          <div style={{ fontSize: 12.5, color: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 8, padding: '8px 11px', marginBottom: 12 }}>
            ⚠️ 后端未启用「一码一人」，注册正回落到共享邀请码（INVITE_CODE）。此处生成的码暂不生效。
          </div>
        )}

        {/* 生成区 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <input
            style={{ ...INPUT, flex: '1 1 200px' }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create();
            }}
            placeholder="备注（给谁用，便于日后核对）"
            maxLength={60}
            autoFocus
          />
          <input
            style={{ ...INPUT, width: 130 }}
            value={ttl}
            onChange={(e) => setTtl(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="有效天数（可空）"
          />
          <button onClick={create} disabled={busy} style={{ ...BTN_PRIMARY, opacity: busy ? 0.7 : 1, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? '生成中…' : '生成邀请码'}
          </button>
        </div>

        <div style={{ fontSize: 11.5, color: theme.color.textFaint, marginTop: -8, marginBottom: 14 }}>
          有效天数留空 = <b>不自动过期</b>（仍可随时吊销）
        </div>

        {hint && (
          <div style={{ fontSize: 12.5, color: '#4ade80', backgroundColor: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.22)', borderRadius: 8, padding: '8px 11px', marginBottom: 12 }}>
            ✓ {hint}
          </div>
        )}
        {error && (
          <div style={{ fontSize: 12.5, color: '#f87171', backgroundColor: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.22)', borderRadius: 8, padding: '8px 11px', marginBottom: 12 }}>
            ⚠️ {error}
          </div>
        )}

        {/* 列表 */}
        {loading ? (
          <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 13, color: theme.color.textFaint }}>读取中…</div>
        ) : codes.length === 0 ? (
          <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 13, color: theme.color.textFaint }}>
            还没有邀请码 —— 在上面填个备注，点「生成邀请码」
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '150px 66px 1fr 96px 92px', gap: 8, fontSize: 11, color: theme.color.textFaint, padding: '0 8px 4px' }}>
              <span>邀请码</span>
              <span>状态</span>
              <span>备注 / 使用者</span>
              <span>创建时间</span>
              <span />
            </div>
            {codes.map((c) => {
              const st = stateOf(c);
              return (
                <div
                  key={c.code}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '150px 66px 1fr 96px 92px',
                    gap: 8,
                    alignItems: 'center',
                    fontSize: 12.5,
                    color: theme.color.text,
                    backgroundColor: theme.color.bgSunken,
                    border: `1px solid ${theme.color.border}`,
                    borderRadius: 8,
                    padding: '8px 8px',
                  }}
                >
                  <code style={{ fontFamily: 'ui-monospace, monospace', color: c.revoked ? theme.color.textFaint : theme.color.text }}>
                    {c.code}
                  </code>
                  <span style={{ color: st.color, fontSize: 12 }}>{st.label}</span>
                  <span style={{ color: theme.color.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.note || '—'}
                    {c.usedBy ? ` · ${c.usedBy}` : ''}
                  </span>
                  <span style={{ color: theme.color.textFaint, fontSize: 11.5 }}>{c.createdAt ? c.createdAt.slice(0, 10) : '—'}</span>
                  <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button style={BTN_GHOST} onClick={() => copy(c.code)} title="复制邀请码">
                      复制
                    </button>
                    {!c.revoked && (
                      <button style={{ ...BTN_GHOST, color: '#f87171' }} onClick={() => revoke(c.code)} title="吊销（记录保留）">
                        吊销
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button style={{ ...BTN_GHOST, padding: '9px 18px', fontSize: 13 }} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
