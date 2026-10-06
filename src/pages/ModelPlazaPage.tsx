// ─────────────────────────────────────────────────────────────
// 模型广场（Phase 2 · 模型分享 v1）
//
//   三个 tab，对应后端三个列表端点：
//     · 公开示例 —— 匿名可读（端点在公开白名单内，不带 Cookie、可边缘缓存）
//     · 圈内共享 —— 需登录（未登录 401，页面显式提示而非显示空列表）
//     · 待审核   —— **仅管理员**；用"能否读到待审队列"探测身份，403 就隐藏该 tab
//
//   🔴 分享的闭环在这一页：**看 → 导入**。导入即用分享物里的声明式 Model JSON
//      存进自己的模型库（走既有保存接口，仍经服务端权威校验）。
//      分享物**不含任何代码**，所以导入不需要沙箱执行 —— 这是"分享=声明式"的红利。
//
//   🔴 措辞纪律：待审 tab 里明确写"**过审前不会出现在公开广场**"，
//      否则作者会以为提交完就上架了。
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react';
import { theme } from '../lib/theme';
import { modelsApi } from '../api/models';
import type { ModelSpec, ShareSummary, ShareView } from '../api/models';
import { ShareControls, VisibilityBadge } from './studio/ShareControls';

const MONO = 'var(--zone-mono, Consolas, monospace)';
const SURFACE = 'var(--zone-surface, #0e1218)';
const SURFACE2 = 'var(--zone-surface-2, #131822)';
const LINE = 'var(--zone-line, #222a36)';
const RADIUS = 'var(--zone-radius, 10px)';

const TABS = [
  { key: 'public', label: '公开示例' },
  { key: 'circle', label: '圈内共享' },
  { key: 'pending', label: '待审核' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const BTN: React.CSSProperties = {
  ...theme.input,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
  color: theme.color.textMuted,
  background: SURFACE2,
  borderColor: LINE,
  whiteSpace: 'nowrap',
};

export default function ModelPlazaPage() {
  const [tab, setTab] = useState<TabKey>('public');
  const [items, setItems] = useState<ShareSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShareView | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 管理员探测：读得到待审队列就是 admin（403 ⇒ 不是）。不在前端硬编码角色。
  useEffect(() => {
    let alive = true;
    modelsApi.share
      .reviewQueue(1)
      .then((r) => alive && setIsAdmin(!!r.ok))
      .catch(() => alive && setIsAdmin(false));
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async (t: TabKey) => {
    setLoading(true);
    setErr(null);
    setOpenId(null);
    setDetail(null);
    setMsg(null);
    try {
      const r =
        t === 'public' ? await modelsApi.share.publicList(100)
          : t === 'circle' ? await modelsApi.share.circleList(100)
            : await modelsApi.share.reviewQueue(100);
      if (!r.ok) {
        setErr(r.error || '读取失败');
        setItems(null);
        return;
      }
      setItems(r.items || []);
    } catch (e) {
      // 圈内/待审未登录会 401 —— 必须显式区分，不能显示成"暂无模型"
      const m = e instanceof Error ? e.message : String(e);
      setErr(
        m.includes('401') || m.includes('未登录')
          ? '该列表需要登录后查看。公开示例无需登录，可先看「公开示例」。'
          : m,
      );
      setItems(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  const open = useCallback(async (it: ShareSummary) => {
    if (openId === it.id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(it.id);
    setDetail(null);
    setDetailErr(null);
    setMsg(null);
    try {
      // 公开示例走 publicDetail（与身份无关、可缓存）；其余走 shared（服务端判可见性）
      const r = tab === 'public' ? await modelsApi.share.publicDetail(it.id) : await modelsApi.share.shared(it.id);
      if (!r.ok) {
        setDetailErr(r.error || '读取分享物失败');
        return;
      }
      setDetail(r.view);
    } catch (e) {
      setDetailErr(e instanceof Error ? e.message : String(e));
    }
  }, [openId, tab]);

  const importIt = useCallback(async (view: ShareView) => {
    setMsg(null);
    try {
      // 分享物是声明式 Model JSON；保存仍走服务端权威校验（不合规会带 issues 回来）
      const r = await modelsApi.save(view.model as unknown as ModelSpec);
      if (!r.ok) {
        setMsg(`导入失败：${r.error || '未知原因'}`);
        return;
      }
      setMsg(`已导入到你的模型库（${r.id}）——可在「模型工坊」里载入、编辑并回测。`);
    } catch (e) {
      setMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  return (
    <div style={{ minHeight: '100vh', color: theme.color.text }}>
      <div style={theme.pageWrap}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: '#f1f5f9' }}>模型广场</div>
          <div style={{ fontSize: 12, color: theme.color.textFaint, marginTop: 4 }}>
            分享物是**声明式 Model JSON + 报告**，不含任何代码；导入后仍经服务端权威校验。
          </div>
        </div>

        {/* Tab */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {TABS.filter((t) => t.key !== 'pending' || isAdmin).map((t) => (
            <button
              key={t.key}
              type="button"
              style={{
                ...BTN,
                background: tab === t.key ? theme.color.primaryDeep : SURFACE2,
                color: tab === t.key ? '#fff' : theme.color.textMuted,
                borderColor: tab === t.key ? theme.color.primary : LINE,
              }}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.key === 'pending' && <span style={{ marginLeft: 4, fontSize: 11 }}>（管理员）</span>}
            </button>
          ))}
        </div>

        {tab === 'pending' && (
          <div
            style={{
              background: SURFACE,
              border: `1px solid ${LINE}`,
              borderLeft: `2px solid ${theme.color.warn}`,
              borderRadius: RADIUS,
              padding: '8px 12px',
              marginBottom: 12,
              fontSize: 12,
              color: theme.color.textMuted,
              lineHeight: 1.7,
            }}
          >
            🔴 <b>过审前不会出现在公开广场</b>：此刻它仍只对作者本人可见（或圈内，取决于申请前的档位）。
            通过后才成为公开示例；驳回则保持原档位不变，并把你的理由回传给作者。
          </div>
        )}

        {err && (
          <div style={{ background: SURFACE, border: `1px solid ${theme.color.warn}`, borderRadius: RADIUS, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12.5, color: theme.color.textMuted, lineHeight: 1.8 }}>{err}</div>
          </div>
        )}

        {loading && <div style={{ fontSize: 12, color: theme.color.textFaint, padding: '8px 0' }}>读取中…</div>}

        {!loading && items && items.length === 0 && (
          <div style={{ fontSize: 12, color: theme.color.textFaint, padding: '8px 0' }}>
            {tab === 'public' ? '还没有公开示例。可在「模型工坊」里把自己的模型申请公开。'
              : tab === 'circle' ? '圈内还没有共享的模型。'
                : '待审队列为空。'}
          </div>
        )}

        {(items || []).map((it) => (
          <div key={it.id} style={{ background: SURFACE, border: `1px solid ${LINE}`, borderRadius: RADIUS, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13.5 }}>{it.name}</strong>
              <span style={{ fontSize: 11.5, color: theme.color.textFaint }}>作者：{it.author || '匿名用户'}</span>
              <span style={{ flex: 1 }} />
              <VisibilityBadge visibility={it.visibility} reviewState={it.reviewState} factorCount={it.factorCount} />
            </div>
            <div style={{ fontSize: 11, color: theme.color.textFaint, fontFamily: MONO, marginTop: 4 }}>
              {it.modelHash ? `${it.modelHash.slice(0, 10)} · ` : ''}
              {it.publishedAt ? `上架 ${String(it.publishedAt).slice(0, 10)}` : `更新 ${String(it.updatedAt || '').slice(0, 10)}`}
            </div>
            {it.reviewState === 'rejected' && it.reviewNote && (
              <div style={{ fontSize: 11.5, color: theme.color.up, marginTop: 4 }}>驳回理由：{it.reviewNote}</div>
            )}

            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" style={BTN} onClick={() => void open(it)}>
                {openId === it.id ? '收起' : '查看分享物'}
              </button>
              {tab === 'pending' && (
                <div style={{ flex: 1, minWidth: 260 }}>
                  <ShareControls
                    id={it.id}
                    visibility={it.visibility}
                    reviewState={it.reviewState}
                    isOwner={false}
                    isAdmin
                    onChanged={() => void load('pending')}
                  />
                </div>
              )}
            </div>

            {openId === it.id && (
              <div style={{ marginTop: 10, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
                {detailErr && <div style={{ fontSize: 12, color: theme.color.up }}>{detailErr}</div>}
                {!detail && !detailErr && <div style={{ fontSize: 12, color: theme.color.textFaint }}>读取中…</div>}
                {detail && (
                  <div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                      <button type="button" style={{ ...BTN, color: '#fff', background: theme.color.primaryDeep, borderColor: theme.color.primary }} onClick={() => void importIt(detail)}>
                        导入到我的模型库
                      </button>
                      <span style={{ fontSize: 11, color: theme.color.textFaint }}>
                        导入后可载入、编辑并回测 —— 不会自动执行
                      </span>
                    </div>
                    {msg && (
                      <div
                        style={{
                          fontSize: 11.5,
                          marginBottom: 8,
                          color: msg.includes('失败') ? theme.color.up : theme.color.down,
                          lineHeight: 1.7,
                        }}
                      >
                        {msg}
                      </div>
                    )}
                    <pre
                      style={{
                        margin: 0,
                        padding: 10,
                        background: SURFACE2,
                        border: `1px solid ${LINE}`,
                        borderRadius: 8,
                        fontFamily: MONO,
                        fontSize: 11,
                        color: theme.color.textMuted,
                        maxHeight: 320,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }}
                    >
                      {JSON.stringify(detail.model, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
