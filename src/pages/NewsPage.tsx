import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { newsApi, newsHealthApi, type NewsItem, type NewsResponse, type NewsHealth } from '../api/dataService';
import { theme } from '../lib/theme';

const TABS: { key: NewsResponse['type']; label: string }[] = [
  { key: 'market', label: '市场要闻' },
  { key: 'official', label: '公告' },
  { key: 'stock', label: '个股资讯' },
];

const formatTime = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : value || '--';
};

/** 匹配置信度样式：越高越醒目，便于一眼分辨硬新闻与泛行业内容 */
const LEVEL_STYLE: Record<string, { color: string; bg: string; border: string; label: string }> = {
  high: { color: '#6ee7b7', bg: 'rgba(16,185,129,.12)', border: 'rgba(16,185,129,.32)', label: '高置信' },
  medium: { color: '#fcd34d', bg: 'rgba(245,158,11,.1)', border: 'rgba(245,158,11,.3)', label: '中置信' },
  low: { color: '#cbd5e1', bg: 'rgba(148,163,184,.1)', border: 'rgba(148,163,184,.26)', label: '弱相关' },
};

function MatchBadge({ item }: { item: NewsItem }) {
  if (typeof item.matchScore !== 'number') return null;
  const style = LEVEL_STYLE[item.matchLevel || 'low'] || LEVEL_STYLE.low;
  return (
    <span
      title={item.matchReason || ''}
      style={{ fontSize: 11, color: style.color, background: style.bg, border: `1px solid ${style.border}`, borderRadius: 5, padding: '2px 6px', whiteSpace: 'nowrap' }}
    >
      {style.label} {(item.matchScore * 100).toFixed(0)}
      {item.matchReason ? ` · ${item.matchReason}` : ''}
    </span>
  );
}

function NewsRow({ item }: { item: NewsItem }) {
  return (
    <article style={{ padding: '16px 0', borderBottom: `1px solid ${theme.color.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 7 }}>
        <span style={{ fontSize: 11, color: item.sourceType === 'official' ? '#fbbf24' : '#93c5fd', border: `1px solid ${item.sourceType === 'official' ? 'rgba(251,191,36,.35)' : 'rgba(147,197,253,.35)'}`, borderRadius: 5, padding: '2px 6px' }}>
          {item.category === 'official' ? '公告聚合' : '公开资讯'}
        </span>
        <MatchBadge item={item} />
        <span style={{ fontSize: 12, color: theme.color.textFaint }}>{item.media}</span>
        <span style={{ fontSize: 12, color: theme.color.textFaint }}>发布时间 {formatTime(item.publishedAt)}</span>
      </div>
      <a href={item.url} target="_blank" rel="noreferrer" style={{ color: theme.color.text, fontSize: 15, fontWeight: 650, lineHeight: 1.55, textDecoration: 'none' }}>
        {item.title}
      </a>
      {item.snippet && <p style={{ margin: '7px 0 0', color: theme.color.textMuted, fontSize: 13, lineHeight: 1.65 }}>{item.snippet}</p>}
      <div style={{ marginTop: 8, color: theme.color.textFaint, fontSize: 11 }}>抓取时间 {formatTime(item.fetchedAt)} · 原文链接</div>
    </article>
  );
}

export default function NewsPage() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<NewsResponse['type']>((params.get('type') as NewsResponse['type']) || 'market');
  const [symbol, setSymbol] = useState(params.get('symbol') || '');
  const [data, setData] = useState<NewsResponse | null>(null);
  const [health, setHealth] = useState<NewsHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showWeak, setShowWeak] = useState(false);

  const load = useCallback(async (showRefresh = false) => {
    if (tab !== 'market' && !symbol.trim()) {
      setData(null);
      setLoading(false);
      return;
    }
    showRefresh ? setRefreshing(true) : setLoading(true);
    try {
      const result = await newsApi.get(tab, symbol.trim() || undefined, tab === 'market' ? 200 : 60);
      setData(result);
    } catch (e) {
      setData({ ok: false, type: tab, symbol: symbol.trim() || null, items: [], fetchedAt: new Date().toISOString(), retentionHours: 72, error: (e as Error).message });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [symbol, tab]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    newsHealthApi
      .get()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const switchTab = (next: NewsResponse['type']) => {
    setTab(next);
    setShowWeak(false);
    setParams((prev) => { prev.set('type', next); if (symbol.trim()) prev.set('symbol', symbol.trim()); return prev; });
  };

  // 个股资讯按置信度分层：硬新闻置顶，泛行业/板块相关内容折叠
  const { strong, weak, sourceSummary } = useMemo(() => {
    const items = data?.items || [];
    const strongRows: NewsItem[] = [];
    const weakRows: NewsItem[] = [];
    for (const it of items) {
      if (tab === 'stock' && typeof it.matchScore === 'number' && it.matchScore < 0.7) weakRows.push(it);
      else strongRows.push(it);
    }
    const counts: Record<string, number> = {};
    for (const it of items) {
      const key = it.source || it.media || '其他';
      counts[key] = (counts[key] || 0) + 1;
    }
    return { strong: strongRows, weak: weakRows, sourceSummary: counts };
  }, [data, tab]);

  const title = useMemo(() => (tab === 'market' ? '市场要闻' : tab === 'official' ? `${symbol || '--'} 公告` : `${data?.stockName || symbol || '--'} 个股资讯`), [data, symbol, tab]);

  const degradedSources = health ? Object.entries(health.sources || {}).filter(([, v]) => v.degraded).map(([k]) => k) : [];

  return (
    <div style={{ ...theme.page, minHeight: '100vh', paddingBottom: 48 }}>
      <main style={{ padding: '24px 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
          <div>
            <div style={{ color: '#60a5fa', fontSize: 11, letterSpacing: 2, fontFamily: 'Consolas, monospace', marginBottom: 7 }}>MARKET INTELLIGENCE</div>
            <h1 style={{ margin: 0, color: theme.color.text, fontSize: 26 }}>资讯中心</h1>
            <p style={{ margin: '8px 0 0', color: theme.color.textMuted, fontSize: 13 }}>多源聚合 · 个股资讯经匹配引擎按相关度排序 · 近三天 · 原文直达</p>
          </div>
          <button type="button" onClick={() => void load(true)} disabled={loading || refreshing} style={{ ...theme.input, color: '#dbeafe', cursor: loading || refreshing ? 'wait' : 'pointer', borderColor: 'rgba(96,165,250,.4)' }}>
            {refreshing ? '刷新中…' : '刷新资讯'}
          </button>
        </div>

        <section style={{ ...theme.glass, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {TABS.map((item) => <button key={item.key} type="button" onClick={() => switchTab(item.key)} style={{ ...theme.input, color: tab === item.key ? '#fff' : theme.color.textMuted, background: tab === item.key ? 'rgba(37,99,235,.75)' : theme.color.bgSunken, borderColor: tab === item.key ? '#60a5fa' : theme.color.border }}>{item.label}</button>)}
          </div>
          {tab !== 'market' && <form onSubmit={(e) => { e.preventDefault(); setParams((prev) => { if (symbol.trim()) prev.set('symbol', symbol.trim()); return prev; }); void load(true); }} style={{ display: 'flex', gap: 8, maxWidth: 520 }}>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="输入 A 股代码，例如 600519 或 sh600519" style={{ ...theme.input, flex: 1 }} />
            <button type="submit" style={{ ...theme.input, color: '#fff', background: theme.color.primaryDeep, borderColor: theme.color.primary }}>查询</button>
          </form>}
          {data?.items?.length ? (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: tab !== 'market' ? 12 : 0, color: theme.color.textFaint, fontSize: 12 }}>
              <span>共 {data.items.length} 条</span>
              {tab === 'stock' && <span>· 高置信 {strong.length} 条</span>}
              <span>· 来源 {Object.entries(sourceSummary).map(([k, v]) => `${k} ${v}`).join(' / ')}</span>
              {health?.tdxChannel && <span>· 通达信行情通道 {health.tdxChannel.available ? '正常' : '不可用'}</span>}
            </div>
          ) : null}
          {degradedSources.length > 0 && (
            <div style={{ marginTop: 10, padding: '7px 10px', color: '#fbbf24', background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.22)', borderRadius: 8, fontSize: 12 }}>
              部分数据源暂时不可用，已自动降级到其他来源：{degradedSources.join('、')}
            </div>
          )}
        </section>

        <section style={theme.glass}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 style={{ ...theme.sectionTitle, margin: 0 }}>{title}</h2>
            <span style={{ color: theme.color.textFaint, fontSize: 12 }}>只保留最近 72 小时</span>
          </div>
          {data?.stale && <div style={{ marginTop: 12, padding: '8px 10px', color: '#fbbf24', background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.22)', borderRadius: 8, fontSize: 12 }}>{data.error || '上游暂不可用，当前展示本地近三天快照'}</div>}
          {data?.sourceNote && <div style={{ marginTop: 10, color: theme.color.textFaint, fontSize: 12 }}>{data.sourceNote}</div>}
          {loading ? (
            <div style={{ padding: '44px 0', textAlign: 'center', color: theme.color.textMuted }}>正在获取近三天资讯…</div>
          ) : !data?.items.length ? (
            <div style={{ padding: '44px 0', textAlign: 'center', color: theme.color.textMuted }}>
              {tab === 'market' ? '暂无市场资讯' : '请输入有效股票代码，或当前暂无相关内容'}
              {data?.error && <div style={{ marginTop: 6, fontSize: 12, color: '#fbbf24' }}>{data.error}</div>}
              {data?.error && <button type="button" data-marker="news-empty-retry" onClick={() => void load(true)} style={{ ...theme.input, marginTop: 10, color: '#93c5fd', cursor: 'pointer' }}>重试</button>}
            </div>
          ) : (
            <>
              {strong.map((item) => <NewsRow key={item.id} item={item} />)}
              {weak.length > 0 && (
                <div style={{ paddingTop: 16 }}>
                  <button type="button" onClick={() => setShowWeak((v) => !v)} style={{ ...theme.input, color: theme.color.textMuted, cursor: 'pointer', borderColor: theme.color.border }}>
                    {showWeak ? '收起' : `展开`}相关度较低内容（{weak.length} 条）
                  </button>
                  {showWeak && <div style={{ marginTop: 4 }}>{weak.map((item) => <NewsRow key={item.id} item={item} />)}</div>}
                </div>
              )}
            </>
          )}
          {data && <div style={{ paddingTop: 16, color: theme.color.textFaint, fontSize: 11 }}>本次抓取 {formatTime(data.fetchedAt)} · 资讯来自公开接口，页面不对标题进行 AI 改写；内容请以原文为准。</div>}
        </section>

        <p style={{ margin: '16px 2px', color: theme.color.textFaint, fontSize: 11, lineHeight: 1.7 }}>来源合规说明：公告与资讯均保留原始来源名称和链接。公开财经接口不等同于监管机构或交易所官方授权，展示内容仅供研究参考，不构成投资建议。</p>
      </main>
    </div>
  );
}
