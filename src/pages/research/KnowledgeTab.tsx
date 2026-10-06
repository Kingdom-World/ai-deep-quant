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
import { useNavigate } from 'react-router-dom';
import { knowledgeApi, type KnowledgeEntry, type KnowledgeSearchMode, type KnowledgeStats, type KnowledgeCategoryCount } from '../../api';
import { card, sectionTitle, sectionSub, input, btnGhost } from './shared';

// 🔴 #70：分类色板此前只有 4 个键，知识库 2.0 新增的 principle/case/cycle
//   一律落到兜底灰 #94a3b8 —— 三层内容在 UI 上完全无区分度（不是"配色偏好"，是信息丢失）。
//   灰底白字的三层挤在一起，学生看不出这是"原理"还是"案例"。
const CATEGORY_COLOR: Record<string, string> = {
  // 教学五层：冷→暖渐变，暗示学习路径的自然推进
  term: '#60a5fa', // 术语   · 蓝
  method: '#22c55e', // 方法论 · 绿
  principle: '#c084fc', // 原理   · 紫（新增）
  case: '#fb923c', // 案例   · 橙（新增）
  cycle: '#f472b6', // 周期   · 粉（新增）
  // 平台辅助类：中性偏灰蓝，视觉上与教学层区分（"这是平台口径，不是学科内容"）
  basis: '#f59e0b',
  paper: '#a78bfa',
};

/** 教学层徽标（区别于平台辅助类 basis/paper） */
const LAYER_BADGE: Record<string, string> = {
  term: '术语',
  method: '方法',
  principle: '原理',
  case: '案例',
  cycle: '周期',
};

export default function KnowledgeTab() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [items, setItems] = useState<KnowledgeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [cats, setCats] = useState<KnowledgeCategoryCount[]>([]);
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
    // 草稿数显式外露：内容欠账有多少条是"看得见的待办量"，不该只藏在后端 stats 里
    const src = `已发布 ${stats.published}/${stats.total} 条均带出处`;
    const todo = stats.draft > 0 ? ` · 草稿待审 ${stats.draft} 条` : '';
    return isFiltered ? `命中 ${total} 条 · ${src}${todo}` : `共 ${stats.published} 条 · ${src}${todo}`;
  }, [stats, total, isFiltered]);

  /**
   * 教学模型联动（§11.1「学生一键复现」）：跳模型工坊并带上模板 key。
   *
   * ⚠️ 为什么不自动落库：模板不是已存模型，直接塞进 draft 会绕过用户的建模意图
   *   （等于替他决定"新建一个叫 XX 的模型"）。故只带 key 过去，工坊侧按 key 选中模板，
   *   由用户确认后再落地。
   * ⚠️ 模板 key 与 shared/modelspec 的 MODEL_TEMPLATES 一致（测试锁着这条），
   *   所以这里不需要再做映射表 —— 多一张映射表就多一处会漂移的地方。
   */
  const openTeachingModel = useCallback(
    (tm: string, title: string) => {
      navigate(`/models?template=${encodeURIComponent(tm)}&from=knowledge&title=${encodeURIComponent(title)}`);
    },
    [navigate],
  );

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

        {/* 分类过滤
            🔴 数字用 c.count（已发布），与 search 严格一致（#68）。
               另把 draft 作为淡显后缀：既点得出来，也把待办量摆在明面上，
               而不是让"数字偏大"或"完全看不见草稿"二选一。 */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <CatChip active={category === ''} onClick={() => setCategory('')} color="#94a3b8" label="全部" count={stats?.published} />
          {cats.map((c) => (
            <CatChip
              key={c.key}
              active={category === c.key}
              onClick={() => setCategory(c.key)}
              color={CATEGORY_COLOR[c.key] || '#94a3b8'}
              label={c.label}
              count={c.count}
              draft={c.draft}
            />
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
          onOpenTeachingModel={openTeachingModel}
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

function CatChip({ active, onClick, label, count, color, draft }: { active: boolean; onClick: () => void; label: string; count?: number; color: string; draft?: number }) {
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
      {/* 草稿后缀：淡显，不喧宾夺主，但点得出来的数字永远只算已发布 */}
      {!!draft && draft > 0 && (
        <span style={{ opacity: 0.6, marginLeft: 3, fontSize: 10 }} title={`另有 ${draft} 条草稿待补出处，暂不进入检索`}>
          +{draft}稿
        </span>
      )}
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
  onOpenTeachingModel,
}: {
  entry: KnowledgeEntry;
  relatedMap: Record<string, KnowledgeEntry>;
  expandedMap: Record<string, boolean>;
  relatedErr?: string;
  onToggleRelated: () => void;
  onOpenRelated: (ids: string[]) => void;
  onOpenTeachingModel?: (templateKey: string, title: string) => void;
}) {
  const color = CATEGORY_COLOR[entry.category] || '#94a3b8';
  // 展开态按**卡片自身 id** 读（与 openRelated 的写入键一致，2026-09-19 修正错位）
  const showRelated = !!expandedMap[entry.id];
  const rel = entry.related.map((id) => relatedMap[id]).filter(Boolean);

  // ⚠️ 后端对缺失字段给的是**空串**而不是 undefined，所以下面的判空一律用 truthiness，
  //   写成 `!== undefined` 会让存量条目的空 div 全部渲染出来。
  //   存量 49 条只有 body —— 它们会只渲染正文，结构化区块整段消失（这才是正确的降级）。

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 11, color, border: `1px solid ${color}55`, backgroundColor: `${color}18`, borderRadius: 4, padding: '1px 6px' }}>
          {entry.categoryLabel}
        </span>
        {/* 教学层徽标：让"这是 Learn 路径的一环"与"这是平台口径/文献"在视觉上分开 */}
        {entry.isTeachingLayer && LAYER_BADGE[entry.category] && (
          <span style={{ fontSize: 10, color: '#94a3b8', border: '1px dashed #334155', borderRadius: 4, padding: '1px 6px' }}>
            教学层 · {LAYER_BADGE[entry.category]}
          </span>
        )}
        <span style={{ fontSize: 15, fontWeight: 800, color: '#f1f5f9' }}>{entry.title}</span>
        {entry.score > 0 && (
          <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>
            命中：{entry.matched.join(' / ')}
          </span>
        )}
      </div>

      {/* 摘要：结构化条目的导语（比正文更短、更像"一句话结论"） */}
      {entry.summary && (
        <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.85, fontWeight: 600, marginBottom: 10, paddingLeft: 9, borderLeft: `2px solid ${color}` }}>
          {entry.summary}
        </div>
      )}

      {/* 正文：无摘要的存量条目直接起排（不出现"只有导语没内容"的空档） */}
      <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>{entry.body}</div>

      {/* 公式：等宽块 + 左侧刻线，视觉上与散文正文区分（这是可复算的东西，不是叙述） */}
      {entry.formula && (
        <div
          style={{
            marginTop: 10,
            padding: '9px 12px',
            backgroundColor: 'rgba(15,23,42,0.75)',
            border: '1px solid rgba(51,65,85,0.7)',
            borderLeft: '3px solid #22c55e',
            borderRadius: 6,
            fontSize: 12,
            color: '#86efac',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            lineHeight: 1.8,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <span style={{ color: '#475569', fontFamily: 'inherit', marginRight: 6 }}>公式</span>
          {entry.formula}
        </div>
      )}

      {/* 适用场景 + 局限：两者成对出现，因为"什么时候能用"和"什么时候不能用"必须一起看 */}
      {(entry.applicability || entry.limitations) && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {entry.applicability && (
            <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.8 }}>
              <span style={{ color: '#60a5fa', fontWeight: 700, marginRight: 6 }}>适用</span>
              {entry.applicability}
            </div>
          )}
          {/* 局限用警示色：本平台口径是「降级/边界必须显式」，局限属于同一类信息 */}
          {entry.limitations && (
            <div
              style={{
                fontSize: 12,
                color: '#fcd34d',
                lineHeight: 1.8,
                padding: '7px 10px',
                backgroundColor: 'rgba(245,158,11,0.07)',
                border: '1px solid rgba(245,158,11,0.24)',
                borderRadius: 6,
              }}
            >
              <span style={{ fontWeight: 700, marginRight: 6 }}>局限</span>
              {entry.limitations}
            </div>
          )}
        </div>
      )}

      {/* 教学模型入口（§11.1「学生一键复现」）
          🔴 teachingNote 必须与 teachingModel 同时渲染：只给一个按钮而不说"观察什么"，
             等于把一个语义不明的黑箱丢给学生 —— 这正是 #69 清理掉的假链接。 */}
      {(entry.teachingModel || entry.teachingNote) && (
        <div
          style={{
            marginTop: 10,
            padding: '9px 12px',
            backgroundColor: entry.teachingModel ? 'rgba(34,197,94,0.07)' : 'rgba(148,163,184,0.06)',
            border: `1px solid ${entry.teachingModel ? 'rgba(34,197,94,0.26)' : 'rgba(100,116,139,0.3)'}`,
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: entry.teachingNote ? 6 : 0 }}>
            <span style={{ color: entry.teachingModel ? '#4ade80' : '#94a3b8', fontWeight: 700 }}>
              {entry.teachingModel ? '教学模型' : '教学说明'}
            </span>
            {entry.teachingModel && (
              <>
                <code style={{ fontSize: 11, color: '#86efac', backgroundColor: 'rgba(34,197,94,0.12)', borderRadius: 4, padding: '1px 6px' }}>
                  {entry.teachingModel}
                </code>
                {onOpenTeachingModel && (
                  <button
                    onClick={() => onOpenTeachingModel(entry.teachingModel as string, entry.title)}
                    style={{ ...btnGhost, padding: '3px 10px', fontSize: 11, marginLeft: 'auto' }}
                  >
                    在模型工坊打开 ▸
                  </button>
                )}
              </>
            )}
          </div>
          {entry.teachingNote && <div style={{ color: '#cbd5e1' }}>{entry.teachingNote}</div>}
        </div>
      )}

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
