import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getDataSourceStatus,
  getHistory,
  getIndices,
  getQuote,
  getRecommendations,
} from '../api/dataService';
import { DataSourceIndicator } from '../components/DataSourceIndicator';
import {
  getFavorites,
  addFavorite as addFavoriteEntry,
  removeFavorite as removeFavoriteEntry,
} from '../lib/favorites';
import {
  analyzeStockPotential,
  detectMarket,
  marketLabel,
  pctColor,
  type IndexData,
  type Market,
  type RecommendItem,
} from '../lib/stock';
import {
  formatPercent,
  formatPrice,
  marketToCurrency,
} from '../utils/formatters';
import { useQuantStore } from '../store/quantStore';

/** 大盘指数轮询间隔（与个股看板一致：每 10 秒） */
const INDEX_REFRESH_MS = 10_000;

/** 大盘指数初始占位（价格与涨跌幅加载后填充；代码带交易所前缀，点击可进详情） */
const INITIAL_INDICES: IndexData[] = [
  { symbol: 'sh000001', name: '上证指数', price: null, changePercent: null },
  { symbol: 'sh000300', name: '沪深300', price: null, changePercent: null },
  { symbol: 'sz399001', name: '深证成指', price: null, changePercent: null },
  { symbol: 'INX', name: '标普500', price: null, changePercent: null },
  { symbol: 'IXIC', name: '纳斯达克', price: null, changePercent: null },
  { symbol: 'DJI', name: '道琼斯', price: null, changePercent: null },
];

/** 统一指数代码形态（sh000001/000001/INX/usINX → 000001/inx） */
const normalizeSymbol = (s: string) => s.replace(/^(sh|sz|hk|us)/i, '').toLowerCase();

/** 今日推荐数量（每天固定 6 支） */
const RECOMMEND_COUNT = 6;

interface FavoriteItem {
  symbol: string;
  market: Market;
  name: string;
  price: number | null;
  changePercent: number | null;
  score: number | null;
  rating: string;
}

/** 功能入口配置 */
const FEATURES = [
  {
    icon: '📊',
    title: '量化看板',
    desc: '进入实时行情看板，K线/均线/MACD/形态分析',
    path: '/stock/MSFT',
    ready: true,
  },
  {
    icon: '🤖',
    title: 'AI 潜力分析',
    desc: '输入任意股票代码，AI 多因子算法评估上涨潜力',
    path: '/analyze',
    ready: true,
  },
  {
    icon: '📈',
    title: '策略回测',
    desc: 'MA双均线/RSI/买入持有策略历史回测，收益曲线与风险指标',
    path: '/backtest',
    ready: true,
  },
  {
    icon: '💬',
    title: 'AI 智能助手',
    desc: '站内 AI 问答：个股解读、选股推荐、使用指南',
    path: '/assistant',
    ready: true,
  },
];

export default function HomePage() {
  const navigate = useNavigate();
  // 大盘指数（每 10 秒轮询刷新）
  const [indices, setIndices] = useState<IndexData[]>(INITIAL_INDICES);
  const [indicesLoading, setIndicesLoading] = useState(true);
  const [indicesError, setIndicesError] = useState<string | null>(null);
  const [indicesUpdatedAt, setIndicesUpdatedAt] = useState<string>('');
  // 今日推荐（AI 评分选出 6 支）
  const [recommends, setRecommends] = useState<RecommendItem[]>([]);
  const [recLoading, setRecLoading] = useState(true);
  const [recError, setRecError] = useState<string | null>(null);
  // 我的收藏（localStorage 持久化，可增删）
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [favLoading, setFavLoading] = useState(false);
  const [favInput, setFavInput] = useState('');
  const [favMsg, setFavMsg] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  // 数据源状态（独立后端）
  const [dsStatus] = useState(getDataSourceStatus());
  // 全局 store（大盘指数写入，供跨页共享）
  const storeSetIndices = useQuantStore((s) => s.setIndices);
  const storeSetIndicesUpdatedAt = useQuantStore((s) => s.setIndicesUpdatedAt);
  // 防止组件卸载后 setState（轮询异步返回）
  const aliveRef = useRef(true);

  // 加载收藏（共享 localStorage 模块）
  const loadFavorites = useCallback(async () => {
    try {
      const list = getFavorites();
      if (list.length === 0) {
        setFavorites([]);
        return;
      }
      setFavLoading(true);
      const items: FavoriteItem[] = [];
      // 并发获取每只收藏股票的数据与 AI 评分（独立后端数据）
      await Promise.all(
        list.map(async (f) => {
          try {
            const [rows, quote] = await Promise.all([
              getHistory(f.symbol, f.market, 'day', 300, true),
              getQuote(f.symbol, f.market, true),
            ]);
            const points = rows.map((r) => ({
              date: r.date,
              open: r.open,
              close: r.close,
              high: r.high,
              low: r.low,
              volume: r.volume,
            }));
            const report = analyzeStockPotential(f.symbol, points, {
              price: quote.price,
              changePercent: quote.changePercent ?? 0,
            });
            items.push({
              symbol: f.symbol,
              market: f.market,
              name: quote.name || f.name || f.symbol,
              price: quote.price,
              changePercent: quote.changePercent,
              score: report?.total ?? null,
              rating: report?.rating ?? '数据不足',
            });
          } catch (e) {
            console.error(`收藏数据加载失败 ${f.symbol}:`, e);
            items.push({
              symbol: f.symbol,
              market: f.market,
              name: f.name ?? f.symbol,
              price: null,
              changePercent: null,
              score: null,
              rating: '数据获取失败',
            });
          }
        }),
      );
      if (aliveRef.current) setFavorites(items);
    } catch (e) {
      console.error('收藏加载失败:', e);
      setFavorites([]);
    } finally {
      if (aliveRef.current) setFavLoading(false);
    }
  }, []);

  // 添加收藏
  const addFavorite = async () => {
    const sym = favInput.trim().toUpperCase();
    if (!sym) {
      setFavMsg('请输入股票代码');
      return;
    }
    const market = detectMarket(sym);
    const list = getFavorites();
    if (list.some((f) => f.symbol === sym)) {
      setFavMsg(`「${sym}」已在收藏中`);
      return;
    }
    // 尝试获取名称（统一数据服务）
    let name = sym;
    try {
      const q = await getQuote(sym, market, true);
      if (q.name) name = q.name;
    } catch {
      /* 名称获取失败不影响收藏 */
    }
    addFavoriteEntry({ symbol: sym, market, name });
    setFavInput('');
    setFavMsg(`已收藏「${sym}」(${marketLabel(market)})`);
    await loadFavorites();
  };

  // 删除收藏（五角星取消）
  const removeFavorite = (symbol: string) => {
    removeFavoriteEntry(symbol);
    setFavorites((prev) => prev.filter((f) => f.symbol !== symbol));
    setFavMsg(`已取消收藏「${symbol}」`);
  };

  // 大盘指数：初始加载 + 每 10 秒轮询 + 页面不可见时暂停（走统一数据服务）
  useEffect(() => {
    aliveRef.current = true;

    const refreshIndices = async (isInitial = false) => {
      try {
        // 独立后端数据源；轮询强制刷新绕过缓存
        const data = await getIndices(isInitial ? false : true);
        if (!aliveRef.current) return;
        setIndices((prev) => {
          const updated = prev.map((item) => {
            // 兼容 symbol 形态：sh000001 / 000001 / INX / usINX 等
            const next = data.find((d) => normalizeSymbol(d.symbol) === normalizeSymbol(item.symbol));
            if (!next) return item;
            return {
              symbol: item.symbol,
              name: next.name || item.name,
              price: next.price > 0 ? next.price : null,
              changePercent: next.changePercent ?? null,
            };
          });
          // 写入全局 store
          storeSetIndices(updated);
          return updated;
        });
        const ts = new Date().toLocaleTimeString();
        setIndicesUpdatedAt(ts);
        storeSetIndicesUpdatedAt(ts);
        setIndicesError(null);
      } catch (err: any) {
        console.error('大盘指数刷新失败:', err);
        if (!aliveRef.current) return;
        setIndicesError(err?.message || '获取失败');
      } finally {
        if (aliveRef.current && isInitial) setIndicesLoading(false);
      }
    };

    refreshIndices(true);
    const timer: number | undefined = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshIndices(false);
    }, INDEX_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshIndices(false);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      aliveRef.current = false;
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [storeSetIndices, storeSetIndicesUpdatedAt]);

  // 今日推荐：AI 算法评分选出 6 支（独立后端数据）
  useEffect(() => {
    (async () => {
      try {
        const rec = await getRecommendations(
          (await import('../lib/stock')).STOCK_POOL,
          RECOMMEND_COUNT,
        );
        if (!aliveRef.current) return;
        setRecommends(rec);
        setRecError(null);
      } catch (err: any) {
        console.error('AI 推荐失败:', err);
        if (!aliveRef.current) return;
        setRecError(`AI 推荐失败: ${err?.message || '未知错误'}`);
      } finally {
        if (aliveRef.current) setRecLoading(false);
      }
    })();
    loadFavorites();
  }, [loadFavorites]);

  const handleSearch = () => {
    const sym = searchInput.trim().toUpperCase();
    if (!sym) return;
    navigate(`/stock/${sym}`);
  };

  const gotoDetail = (symbol: string) => {
    navigate(`/stock/${symbol}`);
  };

  const renderRow = (
    item: {
      symbol: string;
      market: Market;
      name: string;
      price: number | null;
      changePercent: number | null;
      score: number | null;
      rating: string;
    },
    extra?: React.ReactNode,
  ) => {
    const cur = marketToCurrency(item.market);
    const scoreColor =
      item.score === null
        ? '#64748b'
        : item.score >= 80
          ? '#ef4444'
          : item.score >= 65
            ? '#f59e0b'
            : item.score >= 45
              ? '#94a3b8'
              : '#22c55e';
    return (
      <div
        key={item.symbol}
        onClick={() => gotoDetail(item.symbol)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '12px 16px',
          backgroundColor: '#111827',
          borderRadius: '10px',
          border: '1px solid #1e293b',
          cursor: 'pointer',
          transition: 'all 0.15s',
          flexWrap: 'wrap',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = '#3b82f6';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = '#1e293b';
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '150px' }}>
          <span style={{ fontSize: '15px', fontWeight: '700', color: '#f1f5f9' }}>
            {item.symbol}
          </span>
          <span
            style={{
              fontSize: '11px',
              color: '#64748b',
              backgroundColor: '#1e293b',
              padding: '2px 8px',
              borderRadius: '999px',
            }}
          >
            {marketLabel(item.market)}
          </span>
        </div>
        <div style={{ fontSize: '13px', color: '#94a3b8', flex: '1 1 120px', minWidth: '90px' }}>
          {item.name}
        </div>
        <div
          style={{
            minWidth: '100px',
            textAlign: 'right',
            fontSize: '16px',
            fontWeight: '700',
            color: '#f8fafc',
          }}
        >
          {item.price === null ? '--' : formatPrice(item.price, cur)}
        </div>
        <div
          style={{
            minWidth: '90px',
            textAlign: 'right',
            fontSize: '14px',
            fontWeight: '600',
            color: pctColor(item.changePercent),
          }}
        >
          {item.changePercent === null ? '--' : formatPercent(item.changePercent)}
        </div>
        {item.score !== null && (
          <div style={{ minWidth: '110px', textAlign: 'right' }}>
            <span
              style={{
                fontSize: '12px',
                fontWeight: '700',
                color: scoreColor,
                backgroundColor: 'rgba(255,255,255,0.04)',
                padding: '3px 10px',
                borderRadius: '999px',
                border: `1px solid ${scoreColor}33`,
              }}
            >
              🤖 {item.score}分 · {item.rating}
            </span>
          </div>
        )}
        {extra}
      </div>
    );
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#0a0e17',
        color: '#e2e8f0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* ── 顶部导航栏 ── */}
      <nav
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          padding: '14px 32px',
          backgroundColor: 'rgba(10, 14, 23, 0.85)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #1e293b',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '26px' }}>🤖</span>
          <span
            style={{
              fontSize: '19px',
              fontWeight: '700',
              color: '#f1f5f9',
              letterSpacing: '0.3px',
            }}
          >
            AI深度量化
          </span>
          <span
            style={{
              fontSize: '11px',
              color: '#94a3b8',
              backgroundColor: '#1e293b',
              padding: '2px 8px',
              borderRadius: '999px',
              border: '1px solid #334155',
            }}
          >
            Deep Quant
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', fontSize: '14px' }}>
          <span style={{ color: '#60a5fa', fontWeight: '600' }}>首页</span>
          <span
            style={{ color: '#94a3b8', cursor: 'pointer' }}
            onClick={() => navigate('/analyze')}
          >
            AI 潜力分析
          </span>
          <span
            style={{ color: '#94a3b8', cursor: 'pointer' }}
            onClick={() => navigate('/backtest')}
          >
            策略回测
          </span>
          <span
            style={{ color: '#94a3b8', cursor: 'pointer' }}
            onClick={() => navigate('/assistant')}
          >
            AI 助手
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            placeholder="输入股票代码 (如 AAPL, 600519)"
            style={{
              width: '200px',
              padding: '9px 14px',
              fontSize: '13px',
              color: '#e2e8f0',
              backgroundColor: '#111827',
              border: '1px solid #334155',
              borderRadius: '8px',
              outline: 'none',
            }}
          />
          <button
            onClick={() => navigate('/stock/MSFT')}
            style={{
              padding: '9px 18px',
              fontSize: '13px',
              fontWeight: '600',
              color: '#ffffff',
              backgroundColor: '#2563eb',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            🔍 量化看板
          </button>
          <DataSourceIndicator />
        </div>
      </nav>

      {/* ── 主体 ── */}
      <main style={{ maxWidth: '1080px', margin: '0 auto', padding: '28px 24px 48px' }}>
        {/* Hero 标语 */}
        <section style={{ textAlign: 'center', margin: '10px 0 36px' }}>
          <h1 style={{ fontSize: '34px', fontWeight: '700', margin: '0 0 10px', color: '#f8fafc' }}>
            AI深度量化 · 数据驱动 量化决策
          </h1>
          <p style={{ fontSize: '15px', color: '#94a3b8', margin: 0 }}>
            真实市场数据 · AI 多因子选股 · 策略回测 · 每 10 秒自动更新
          </p>
        </section>

        {/* ── 市场概况 ── */}
        <section style={{ marginBottom: '36px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
            }}
          >
            <h2
              style={{ fontSize: '20px', fontWeight: '600', margin: '0 0 16px', color: '#f1f5f9' }}
            >
              📈 市场概况
            </h2>
            {indicesUpdatedAt && (
              <span style={{ fontSize: '12px', color: '#475569', marginBottom: '16px' }}>
                ● 每 {INDEX_REFRESH_MS / 1000} 秒自动刷新 · 更新于 {indicesUpdatedAt}
              </span>
            )}
          </div>

          <div style={{ marginBottom: '24px' }}>
            <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '10px' }}>
              大盘指数
              {indicesError && (
                <span style={{ marginLeft: '8px', color: '#f87171' }}>
                  (刷新失败，展示最近一次数据)
                </span>
              )}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: '12px',
              }}
            >
              {indices.map((q) => (
                <div
                  key={q.symbol}
                  onClick={() => navigate(`/stock/${q.symbol}`)}
                  title="点击查看指数详情"
                  style={{
                    padding: '14px 16px',
                    backgroundColor: '#111827',
                    borderRadius: '12px',
                    border: '1px solid #1e293b',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.borderColor = '#3b82f6';
                    (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.borderColor = '#1e293b';
                    (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
                  }}
                >
                  <div style={{ fontSize: '13px', color: '#94a3b8' }}>{q.name}</div>
                  {indicesLoading && q.price === null ? (
                    <div style={{ fontSize: '16px', color: '#64748b', marginTop: '8px' }}>
                      加载中...
                    </div>
                  ) : q.price === null ? (
                    <div style={{ fontSize: '16px', color: '#64748b', marginTop: '8px' }}>
                      暂无数据
                    </div>
                  ) : (
                    <>
                      <div
                        style={{
                          fontSize: '20px',
                          fontWeight: '700',
                          color: '#f1f5f9',
                          marginTop: '4px',
                        }}
                      >
                        {q.price.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                      <div
                        style={{
                          fontSize: '13px',
                          fontWeight: '600',
                          color: pctColor(q.changePercent),
                        }}
                      >
                        {q.changePercent === null ? '--' : formatPercent(q.changePercent)}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── 我的收藏（可增删，localStorage 持久化） ── */}
        <section style={{ marginBottom: '36px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
            }}
          >
            <h2
              style={{ fontSize: '20px', fontWeight: '600', margin: '0 0 16px', color: '#f1f5f9' }}
            >
              ⭐ 我的收藏
            </h2>
            <span style={{ fontSize: '12px', color: '#475569', marginBottom: '16px' }}>
              收藏的股票会保存在本地浏览器
            </span>
          </div>

          {/* 添加收藏 */}
          <div
            style={{
              display: 'flex',
              gap: '8px',
              marginBottom: '12px',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <input
              value={favInput}
              onChange={(e) => setFavInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addFavorite();
              }}
              placeholder="输入代码添加收藏 (如 TSLA, 300750, 03690)"
              style={{
                flex: '1 1 260px',
                maxWidth: '320px',
                padding: '9px 14px',
                fontSize: '13px',
                color: '#e2e8f0',
                backgroundColor: '#111827',
                border: '1px solid #334155',
                borderRadius: '8px',
                outline: 'none',
              }}
            />
            <button
              onClick={addFavorite}
              style={{
                padding: '9px 18px',
                fontSize: '13px',
                fontWeight: '600',
                color: '#ffffff',
                backgroundColor: '#2563eb',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
              }}
            >
              ➕ 添加收藏
            </button>
            {favMsg && <span style={{ fontSize: '12px', color: '#60a5fa' }}>{favMsg}</span>}
          </div>

          {favLoading && (
            <div style={{ textAlign: 'center', color: '#64748b', padding: '24px 0' }}>
              ⏳ 正在加载收藏数据...
            </div>
          )}
          {!favLoading && favorites.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                color: '#64748b',
                padding: '28px',
                backgroundColor: '#0d1322',
                borderRadius: '12px',
                border: '1px dashed #1e293b',
              }}
            >
              📌 暂无收藏，使用上方输入框添加你关注的股票（支持美股/A股/港股）
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {favorites.map((f) =>
              renderRow(
                f,
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFavorite(f.symbol);
                  }}
                  title="取消收藏"
                  style={{
                    padding: '4px 12px',
                    fontSize: '14px',
                    color: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  ★
                </button>,
              ),
            )}
          </div>
        </section>

        {/* ── 今日推荐（AI 算法每日 6 支） ── */}
        <section style={{ marginBottom: '36px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
            }}
          >
            <h2
              style={{ fontSize: '20px', fontWeight: '600', margin: '0 0 16px', color: '#f1f5f9' }}
            >
              🤖 今日推荐 · AI 潜力评分
            </h2>
            <span style={{ fontSize: '12px', color: '#475569', marginBottom: '16px' }}>
              基于趋势/动量/量能/波动/位置五因子模型，每日从股票池选出 {RECOMMEND_COUNT} 支
            </span>
          </div>

          {recLoading && (
            <div style={{ textAlign: 'center', color: '#64748b', padding: '32px 0' }}>
              <span className="dsh-spin" style={{ marginRight: '8px' }}>
                ⏳
              </span>
              AI 正在评估股票池潜力，请稍候...
            </div>
          )}
          {recError && (
            <div
              style={{
                textAlign: 'center',
                color: '#f87171',
                padding: '20px',
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                borderRadius: '12px',
                border: '1px solid rgba(239, 68, 68, 0.3)',
              }}
            >
              ⚠️ {recError}
              <button
                onClick={() => window.location.reload()}
                style={{
                  marginLeft: '12px',
                  padding: '6px 16px',
                  fontSize: '13px',
                  color: '#fff',
                  backgroundColor: '#2563eb',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                }}
              >
                🔄 重试
              </button>
            </div>
          )}
          {!recLoading && !recError && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {recommends.map((r) =>
                renderRow({
                  symbol: r.symbol,
                  market: r.market,
                  name: r.name,
                  price: r.price,
                  changePercent: r.changePercent,
                  score: r.score,
                  rating: r.rating,
                }),
              )}
              {recommends.length === 0 && (
                <div style={{ textAlign: 'center', color: '#64748b', padding: '24px' }}>
                  暂无推荐结果，请稍后重试
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── 功能区 ── */}
        <section style={{ marginBottom: '36px' }}>
          <h2 style={{ fontSize: '20px', fontWeight: '600', margin: '0 0 16px', color: '#f1f5f9' }}>
            🛠️ 功能中心
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '14px',
            }}
          >
            {FEATURES.map((f) => (
              <div
                key={f.title}
                onClick={() => f.ready && navigate(f.path)}
                style={{
                  padding: '22px',
                  backgroundColor: '#111827',
                  borderRadius: '14px',
                  border: '1px solid #1e293b',
                  cursor: f.ready ? 'pointer' : 'default',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  if (f.ready) {
                    (e.currentTarget as HTMLDivElement).style.borderColor = '#3b82f6';
                  }
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.borderColor = '#1e293b';
                }}
              >
                <div style={{ fontSize: '28px' }}>{f.icon}</div>
                <div
                  style={{
                    fontSize: '16px',
                    fontWeight: '700',
                    color: '#f1f5f9',
                    marginTop: '10px',
                  }}
                >
                  {f.title}
                  {!f.ready && (
                    <span
                      style={{
                        marginLeft: '8px',
                        fontSize: '11px',
                        color: '#f59e0b',
                        backgroundColor: 'rgba(245, 158, 11, 0.12)',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        border: '1px solid rgba(245, 158, 11, 0.3)',
                      }}
                    >
                      即将上线
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: '13px',
                    color: '#94a3b8',
                    marginTop: '6px',
                    lineHeight: '1.6',
                  }}
                >
                  {f.desc}
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* ── 数据源状态条 ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
          flexWrap: 'wrap',
          padding: '14px 24px',
          borderTop: '1px solid #1e293b',
          backgroundColor: '#0d1322',
          fontSize: '12px',
          color: '#94a3b8',
        }}
      >
        <span>
          数据源：<b style={{ color: '#22c55e' }}>AI深度量化数据服务</b>
          <span style={{ color: '#475569' }}>（新浪 / 腾讯公开数据，无需 API Key）</span>
        </span>
        <span style={{ color: '#475569' }}>|</span>
        <span>
          数据服务：
          <b style={{ color: dsStatus.primaryHealthy ? '#22c55e' : '#f59e0b' }}>
            {dsStatus.primaryHealthy ? '运行中' : '未启动'}
          </b>
          <span style={{ color: '#475569' }}>（启动: npm start，单端口 3001）</span>
        </span>
        <span style={{ color: '#475569' }}>|</span>
        <span>缓存 {dsStatus.cacheSize} 项</span>
      </div>

      {/* ── 页脚 ── */}
      <footer
        style={{
          textAlign: 'center',
          padding: '24px',
          borderTop: '1px solid #1e293b',
          color: '#475569',
          fontSize: '12px',
          backgroundColor: '#0d1322',
        }}
      >
        📊 数据仅供参考，不构成投资建议 · 数据来源: 新浪/腾讯公开行情 · AI深度量化 独立量化平台
      </footer>
    </div>
  );
}
