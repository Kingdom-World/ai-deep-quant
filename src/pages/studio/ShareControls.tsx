// ─────────────────────────────────────────────────────────────
// 分享控件（Phase 2 · 模型分享 v1）—— 徽章 + 可执行动作
//
//   🔴 本组件**不推演**可见性规则：可执行动作一律由 `actionsFor(doc, actor)`
//   （shared/modelshare.mjs，与后端同一份）算出。前端只负责发 action、读回结果。
//   这样"哪些按钮该出现"只有一个权威 —— 不会出现前端多显示/少显示按钮。
//
//   🔴 徽章显示的是 `visibility`（当前生效档位），而**不是** reviewState：
//      申请公开后 visibility 仍是 private/circle（公开尚未生效），
//      若用 reviewState 显示成"公开中"会让人误以为已经上架。
// ─────────────────────────────────────────────────────────────
import { useState } from 'react';
import { theme } from '../../lib/theme';
import { modelsApi, actionsFor, REVIEW_LABELS, VISIBILITY_LABELS } from '../../api/models';
import type { ReviewState, ShareAction, Visibility } from '../../api/models';

const MONO = 'var(--zone-mono, Consolas, monospace)';
const LINE = 'var(--zone-line, #222a36)';
const SURFACE2 = 'var(--zone-surface-2, #131822)';

const TONE: Record<Visibility, string> = {
  private: theme.color.textFaint,
  circle: theme.color.primary,
  public: theme.color.down, // 涨红跌绿约定里"绿"=好，公开示例是正面状态
};

const REVIEW_TONE: Partial<Record<ReviewState, string>> = {
  pending: theme.color.warn,
  rejected: theme.color.up,
  approved: theme.color.down,
};

const BTN: React.CSSProperties = {
  ...theme.input,
  padding: '3px 8px',
  fontSize: 11.5,
  color: theme.color.textMuted,
  background: SURFACE2,
  borderColor: LINE,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

/** 可见性徽章（+ 审核态副标） */
export function VisibilityBadge({
  visibility,
  reviewState,
  factorCount,
}: {
  visibility: Visibility;
  reviewState: ReviewState;
  factorCount?: number | null;
}) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <span
        title="当前生效的可见范围"
        style={{
          fontSize: 11,
          color: TONE[visibility] || theme.color.textFaint,
          border: `1px solid ${TONE[visibility] || LINE}`,
          borderRadius: 4,
          padding: '0 5px',
          whiteSpace: 'nowrap',
        }}
      >
        {VISIBILITY_LABELS[visibility] || visibility}
      </span>
      {reviewState !== 'none' && (
        <span
          title="公开申请状态（不影响当前可见范围）"
          style={{ fontSize: 11, color: REVIEW_TONE[reviewState] || theme.color.textFaint, whiteSpace: 'nowrap' }}
        >
          {REVIEW_LABELS[reviewState] || reviewState}
        </span>
      )}
      {typeof factorCount === 'number' && (
        <span style={{ fontSize: 11, color: theme.color.textFaint, fontFamily: MONO }}>{factorCount} 因子</span>
      )}
    </span>
  );
}

/**
 * 分享动作条。
 * @param id 模型 id
 * @param visibility / reviewState 当前状态（来自列表项或详情）
 * @param isOwner / isAdmin 身份（决定可见动作）
 * @param onChanged 变更成功后回调（通常用来刷新列表）
 */
export function ShareControls({
  id,
  visibility,
  reviewState,
  isOwner,
  isAdmin,
  onChanged,
}: {
  id: string;
  visibility: Visibility;
  reviewState: ReviewState;
  isOwner: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // 单一来源：动作清单由状态机算，前端不自己 if/else 推演
  const actions = actionsFor({ visibility, reviewState }, { isOwner, isAdmin });
  if (!actions.length) return null;
  const canReject = actions.includes('reject');

  const run = async (action: ShareAction) => {
    setBusy(true);
    setErr(null);
    try {
      const r = action === 'approve' || action === 'reject'
        ? await modelsApi.share.review(id, action, note || undefined)
        : await modelsApi.share.set(id, action);
      if (!r.ok) {
        setErr(r.error || '操作失败');
        return;
      }
      setNote('');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const label = (a: ShareAction) =>
    a === 'set-private' ? '设为私有'
      : a === 'set-circle' ? '圈内共享'
        : a === 'request-public' ? '申请公开'
          : a === 'withdraw-request' ? '撤回申请'
            : a === 'approve' ? '通过'
              : '驳回';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {actions.map((a) => (
          <button key={a} type="button" style={BTN} disabled={busy} onClick={() => void run(a)}>
            {label(a)}
          </button>
        ))}
      </div>
      {canReject && (
        <input
          style={{ ...theme.input, fontSize: 11.5, padding: '3px 8px' }}
          placeholder="驳回理由（可选，会随驳回一起给作者看）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      {err && (
        <div style={{ fontSize: 11, color: theme.color.up, lineHeight: 1.6 }}>
          {err}
          {err.includes('管理员') && '（审核类动作仅管理员可执行）'}
        </div>
      )}
    </div>
  );
}
