// ─────────────────────────────────────────────────────────────
// 研究中心 · Tab5 知识库（M1-1.4）
//
//   存在的理由（对齐能力差距评估的 P1）：平台的"数字"一直可溯源（指纹/留痕/归档），
//   但"方法"不可溯源——口径出处、术语定义、方法论文献此前无处可查。
//   本 Tab 把「每条结论都能追到出处」这件事补齐：条目必带 source 字段，
//   UI 把出处放在与正文同等显眼的位置，而不是折叠在角落。
//
//   交互取舍：
//     · 搜索用 250ms 防抖——知识库是本地检索（<1ms），但避免每敲一个字打一次请求；
//     · 空查询 = 浏览模式（返回全部分类条目），首屏不像"空白页"；
//     · 分类过滤服务端做（同一接口带 category 参数），前端只切换参数；
//     · 关联口径点击后**就地展开**目标条目而非跳页——研究场景下跳页会打断思路。
// ─────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { knowledgeApi, type KnowledgeEntry, type KnowledgeSearchMode } from '../../api/dataService';
import { card, sectionTitle, sectionSub, input, btnGhost } from './shared';

const CATEGORY_COLOR: Record<string, string> = {
  term: '#60a5fa',
  basis: '#f59e0b',
  method: '#22c55e',
  paper: '#a78bfa',
};

export default function KnowledgeTab() {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [items, setItems] = useState<KnowledgeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<{ total: number; withSource: number } | null>(null);
  const [cats, setCats] = useState<{ key: string; label: string; count: number }[]>([]);
  const [mode, setMode] = useState<KnowledgeSearchMode>('browse');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  /** 关联条目就地展开：id -> 条目 */
  const [related, setRelated] = useState<Record<string, KnowledgeEntry>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [relatedErr, setRelatedErr] = useState('');
  const seq = useRef(0); // 请求序号，防乱序覆盖

  const run = useCallback(async (query: string, cat: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setErr('');
    try {
      const r = await knowledgeApi.search(query, cat || undefined, 100);
      if (mine !== seq.current) return; // 已有更新的请求，丢弃本次
      setItems(r.items);
      setTotal(r.total);
      setStats(r.stats);
      setCats(r.categories);
      setMode(r.mode || 'and');
    } catch (e) {
      if (mine !== seq.current) return;
      setErr(String((e as Error).message || e).slice(0, 120));
      setItems([]);
      setTotal(0);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // 防抖检索：250ms；分类切换立即生效（不防抖，点了就该立刻变）
  useEffect(() => {
    const t = setTimeout(() => run(q, category), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, category, run]);

  /**
   * 展开关联条目：先查缓存，缺的批量拉取。
   *
   * ⚠️ 2026-09-19 修：此前展开标记按**目标条目 id** 写入 `expanded`，
   * 而渲染判断读的是 `expanded[entry.id]`（**卡片自身 id**）——键不一致，
   * 于是 showRelated 永远为 undefined，关联区永远不出现（用户反馈"点了没反应"）。
   * 现改为按**卡片自身 id** 记录展开态，目标条目只用于 `related` 缓存。
   * 同时把静默 catch 改为可见错误：拉取失败不能假装"加载中"。
   */
  const openRelated = useCallback(
    async (ownerId: string, ids: string[]) => {
      // 先翻转展开态（键 = 卡片自身 id），让用户立刻看到响应
      setExpanded((prev) => ({ ...prev, [ownerId]: !prev[ownerId] }));

      const missing = ids.filter((id) => !related[id]);
      if (!missing.length) return;
      setRelatedErr('');
      try {
        const r = await knowledgeApi.entries(missing);
        const got = r.items ?? [];
        setRelated((prev) => {
          const next = { ...prev };
          for (const e of got) next[e.id] = e;
          return next;
        });
        // 拉到了但仍有缺口（后端缺该 id）→ 显式告知，不装作还在加载
        if (got.length < missing.length) {
          const gotIds = new Set(got.map((e) => e.id));
          const lost = missing.filter((id) => !gotIds.has(id));
          setRelatedErr(`有 ${lost.length} 条关联条目未取到（${lost.join('、')}）`);
        }
      } catch (e) {
        setRelatedErr(`关联条目拉取失败：${String((e as Error).message || e).slice(0, 80)}`);
      }
    },
    [related],
  );

  // 条数动态化（BUG#3）：有搜索词/分类过滤时显示当前命中数（total = 本次查询结果总数），
  // 无过滤时显示全库条数；出处统计恒为全库口径，不随过滤缩水。过滤为空时命中 0 条照实显示。
  const isFiltered = q.trim() !== '' || category !== '';
  const statLine = useMemo(() => {
    if (!stats) return '';
    const src = `全部带出处（${stats.withSource}/${stats.total}）`;
    return isFiltered ? `命中 ${total} 条 · ${src}` : `共 ${stats.total} 条 · ${src}`;
  }, [stats, total, isFiltered]);

  return (
    <div>
      {/* 搜索区 */}
      <div style={card}>
        <div style={sectionTitle}>知识库 · 每条结论都能追到出处</div>
        <div style={sectionSub}>
          口径出处、术语定义、方法论短文。搜索支持多词（空格分隔，需同时命中）；
          留空则浏览全部条目。{statLine && <span style={{ color: '#475569' }}>　{statLine}</span>}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            style={{ ...input, flex: '1 1 260px', minWidth: 200 }}
            placeholder="搜索：如 PIT、复权、Newey-West、涨跌停…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button style={{ ...btnGhost, padding: '7px 14px', fontSize: 12 }} onClick={() => { setQ(''); setCategory(''); }}>
            重置
          </button>
        </div>

        {/* 分类过滤 */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <CatChip active={category === ''} onClick={() => setCategory('')} color="#94a3b8" label="全部" count={stats?.total} />
          {cats.map((c) => (
            <CatChip key={c.key} active={category === c.key} onClick={() => setCategory(c.key)} color={CATEGORY_COLOR[c.key] || '#94a3b8'} label={c.label} count={c.count} />
          ))}
        </div>
      </div>

      {/* 结果区 */}
      {err && (
        <div style={{ ...card, borderColor: 'rgba(239,68,68,0.5)', color: '#f87171', fontSize: 12 }}>检索失败：{err}</div>
      )}

      {/* 降级可见：整句提问时自动放宽为关键词匹配，必须告知——不做"看起来精确"的伪装 */}
      {!loading && !err && mode === 'keyword' && items.length > 0 && (
        <div
          style={{
            marginBottom: 14,
            padding: '9px 14px',
            fontSize: 12,
            color: '#f59e0b',
            backgroundColor: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.25)',
            borderRadius: 8,
            lineHeight: 1.8,
          }}
        >
          已按<strong>关键词放宽匹配</strong>（整句提问无法逐字命中）。结果按相关度排序，命中词见每张卡片右上角——
          如需精确匹配，请改用多个独立关键词（空格分隔）。
        </div>
      )}

      {loading && !items.length && <div style={{ ...card, color: '#64748b', fontSize: 12 }}>加载中…</div>}

      {!loading && !err && !items.length && (
        <div style={{ ...card, color: '#64748b', fontSize: 12, lineHeight: 1.8 }}>
          没有匹配的条目。
          <br />
          建议：换个关键词，或点「全部」浏览 {stats?.total ?? 0} 条现有条目；也可以清空搜索框直接浏览。
        </div>
      )}

      {items.map((e) => (
        <EntryCard
          key={e.id}
          entry={e}
          relatedMap={related}
          expandedMap={expanded}
          relatedErr={relatedErr}
          onToggleRelated={() => openRelated(e.id, e.related)}
          onOpenRelated={(ids) => openRelated(e.id, ids)}
        />
      ))}

      {items.length > 0 && (
        <div style={{ fontSize: 11, color: '#475569', textAlign: 'center', padding: '4px 0 12px' }}>
          显示 {items.length} / {total} 条{category ? ` · 已过滤「${cats.find((c) => c.key === category)?.label || category}」` : ''}
        </div>
      )}
    </div>
  );
}

function CatChip({ active, onClick, label, count, color }: { active: boolean; onClick: () => void; label: string; count?: number; color: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px',
        fontSize: 12,
        borderRadius: 999,
        cursor: 'pointer',
        color: active ? '#0b1220' : '#94a3b8',
        backgroundColor: active ? color : 'transparent',
        border: `1px solid ${active ? color : '#334155'}`,
        fontWeight: active ? 700 : 400,
      }}
    >
      {label}
      {count !== undefined && <span style={{ opacity: 0.75, marginLeft: 4 }}>{count}</span>}
    </button>
  );
}

function EntryCard({
  entry,
  relatedMap,
  expandedMap,
  relatedErr,
  onToggleRelated,
  onOpenRelated,
}: {
  entry: KnowledgeEntry;
  relatedMap: Record<string, KnowledgeEntry>;
  expandedMap: Record<string, boolean>;
  relatedErr?: string;
  onToggleRelated: () => void;
  onOpenRelated: (ids: string[]) => void;
}) {
  const color = CATEGORY_COLOR[entry.category] || '#94a3b8';
  // 展开态按**卡片自身 id** 读（与 openRelated 的写入键一致，2026-09-19 修正错位）
  const showRelated = !!expandedMap[entry.id];
  const rel = entry.related.map((id) => relatedMap[id]).filter(Boolean);

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 11, color, border: `1px solid ${color}55`, backgroundColor: `${color}18`, borderRadius: 4, padding: '1px 6px' }}>
          {entry.categoryLabel}
        </span>
        <span style={{ fontSize: 15, fontWeight: 800, color: '#f1f5f9' }}>{entry.title}</span>
        {entry.score > 0 && (
          <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>
            命中：{entry.matched.join(' / ')}
          </span>
        )}
      </div>

      <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>{entry.body}</div>

      {/* 出处：与正文同等显眼——这是本平台的知识库与"随便写个说明"的区别 */}
      <div
        style={{
          marginTop: 12,
          padding: '9px 12px',
          backgroundColor: 'rgba(245,158,11,0.06)',
          border: '1px solid rgba(245,158,11,0.22)',
          borderRadius: 8,
          fontSize: 12,
          color: '#cbd5e1',
          lineHeight: 1.8,
        }}
      >
        <span style={{ color: '#f59e0b', fontWeight: 700, marginRight: 6 }}>出处</span>
        {entry.source}
      </div>

      {entry.tags.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {entry.tags.map((t) => (
            <span key={t} style={{ fontSize: 11, color: '#64748b', backgroundColor: 'rgba(30,41,59,0.7)', borderRadius: 4, padding: '1px 7px' }}>
              #{t}
            </span>
          ))}
        </div>
      )}

      {/* 关联口径：就地展开，不跳页 */}
      {entry.related.length > 0 && (
        <div style={{ marginTop: 12, borderTop: '1px solid rgba(30,41,59,0.8)', paddingTop: 10 }}>
          <button
            onClick={onToggleRelated}
            style={{ ...btnGhost, padding: '4px 10px', fontSize: 11 }}
          >
            {showRelated ? '收起关联条目 ▴' : `查看关联条目（${entry.related.length}）▸`}
          </button>
          {showRelated && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rel.length === 0 && !relatedErr && <div style={{ fontSize: 11, color: '#475569' }}>关联条目加载中…</div>}
              {relatedErr && (
                <div style={{ fontSize: 11, color: '#f87171', lineHeight: 1.7 }}>✗ {relatedErr}</div>
              )}
              {rel.map((r) => (
                <div key={r.id} style={{ padding: '9px 12px', backgroundColor: 'rgba(13,19,34,0.6)', borderRadius: 8, border: '1px solid rgba(51,65,85,0.5)' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: CATEGORY_COLOR[r.category] || '#94a3b8', marginBottom: 4 }}>
                    {r.categoryLabel} · {r.title}
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.75 }}>{r.body.slice(0, 180)}{r.body.length > 180 ? '…' : ''}</div>
                </div>
              ))}
            </div>
          )}
          {/* 保留批量入口（供未来"相关推荐"复用） */}
          <span style={{ display: 'none' }} onClick={() => onOpenRelated(entry.related)} />
        </div>
      )}
    </div>
  );
}
