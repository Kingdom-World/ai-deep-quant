import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TopNav from '../components/TopNav';
import { getMarketStatus, useMinuteTick } from '../lib/marketHours';
import { setVisibilityInterval } from '../lib/polling';
import SectorMarketPanel from '../components/SectorMarketPanel';
import {
  getHistory,
  getIndices,
  getLastComputedAt,
  getQuotesBatch,
  getQuote,
  getRecommendations,
  moodApi,
  watchlistApi,
  type MarketMood,
  type UnifiedQuote,
} from '../api/dataService';
import { BACKEND_MODE } from '../config';
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
import { theme } from '../lib/theme';

/** 迷你走势线（纯 SVG，无 ECharts 开销） */
function Sparkline({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const w = 110;
  const h = 34;
  const d = points
    .map((p, i) => `${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((p - min) / range) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** 评分环（SVG 圆环进度） */
function ScoreRing({ score, color }: { score: number; color: string }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(score, 100) / 100);
  return (
    <svg width="38" height="38" style={{ display: 'block' }}>
      <circle cx="19" cy="19" r={r} stroke="#1e293b" strokeWidth="4" fill="none" />
      <circle
        cx="19" cy="19" r={r} stroke={color} strokeWidth="4" fill="none" strokeLinecap="round"
        strokeDasharray={c.toFixed(1)} strokeDashoffset={off.toFixed(1)} transform="rotate(-90 19 19)"
      />
      <text x="19" y="23" textAnchor="middle" fontSize="11" fontWeight="700" fill={color}>
        {score}
      </text>
    </svg>
  );
}

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

/** 今日观察数量（每天固定 6 支） */
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
    icon: '🧮',
    title: '量化因子分析',
    desc: '输入任意股票代码，五因子模型量化评估市场状态',
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
    icon: '💰',
    title: '模拟交易',
    desc: '100万虚拟资金真实行情撮合，市价/限价单与自动策略',
    path: '/paper',
    ready: true,
  },
  {
    icon: '🤖',
    title: 'Agent 团队',
    desc: '主理人调度多Agent流水线：数据收集/多空辩论/风险评估，输出研究结论',
    path: '/agents',
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
  useMinuteTick(30000); // 状态徽章时钟兜底
  // 大盘指数（每 10 秒轮询刷新）
  const [indices, setIndices] = useState<IndexData[]>(INITIAL_INDICES);
  const [indicesLoading, setIndicesLoading] = useState(true);
  const [indicesError, setIndicesError] = useState<string | null>(null);
  const [indicesUpdatedAt, setIndicesUpdatedAt] = useState<string>('');
  // 今日观察（因子评分选出 6 支）
  const [recommends, setRecommends] = useState<RecommendItem[]>([]);
  const [recLoading, setRecLoading] = useState(true);
  const [recError, setRecError] = useState<string | null>(null);
  /** 本次评分时间（python 模式来自后端每日 16:00 定时快照） */
  const [scoreTime, setScoreTime] = useState<string | null>(null);
  // 我的收藏（服务端持久化，可增删；localStorage 作迁移与离线回退）
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [favLoading, setFavLoading] = useState(false);
  const [favInput, setFavInput] = useState('');
  const [favMsg, setFavMsg] = useState<string | null>(null);
  // 市场温度计（融合 TSP：涨跌家数/涨停跌停/情绪分/领涨行业）
  const [mood, setMood] = useState<MarketMood | null>(null);
  // 指数迷你走势（30 日收盘，供卡片 sparkline）
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  // 全局 store（大盘指数写入，供跨页共享）
  const storeSetIndices = useQuantStore((s) => s.setIndices);
  const storeSetIndicesUpdatedAt = useQuantStore((s) => s.setIndicesUpdatedAt);
  // 防止组件卸载后 setState（轮询异步返回）
  const aliveRef = useRef(true);

  // 加载收藏（服务端持久化为主：跨设备同步；localStorage 仅作首次迁移与离线回退）
  const loadFavorites = useCallback(async () => {
    try {
      let base: { symbol: string; name: string }[] = [];
      let usedServer = false;
      try {
        const r = await watchlistApi.list();
        if (r.ok) {
          usedServer = true;
          base = r.items.map((w) => ({ symbol: w.symbol.toUpperCase(), name: w.name }));
        }
      } catch {
        /* 后端不可用时回退 localStorage */
      }
      // 首次迁移：服务端为空且本地有收藏 → 全量推送到服务端
      if (usedServer && base.length === 0) {
        const localList = getFavorites();
        await Promise.all(localList.map((f) => watchlistApi.add({ symbol: f.symbol, name: f.name }).catch(() => {})));
      }
      if (!usedServer) {
        base = getFavorites().map((f) => ({ symbol: f.symbol, name: f.name || f.symbol }));
      }
      if (base.length === 0) {
        if (aliveRef.current) setFavorites([]);
        return;
      }
      const list = base.map((b) => ({ symbol: b.symbol, market: detectMarket(b.symbol), name: b.name }));
      setFavLoading(true);
      const items: FavoriteItem[] = [];
      // python 后端模式：批量报价一次聚合（单用户限流 10 次/分钟，需节约请求）
      const pyBatch = new Map<string, UnifiedQuote>();
      if (BACKEND_MODE === 'python') {
        const qs = await getQuotesBatch(list.map((f) => f.symbol), 'CN', true);
        qs.forEach((q) => pyBatch.set(q.symbol.toUpperCase(), q));
      }
      // 并发获取每只收藏股票的数据与 AI 评分（独立后端数据）
      await Promise.all(
        list.map(async (f) => {
          try {
            const rows = await getHistory(f.symbol, f.market, 'day', 300, true);
            const quote =
              BACKEND_MODE === 'python'
                ? pyBatch.get(f.symbol.toUpperCase())
                : await getQuote(f.symbol, f.market, true);
            const points = rows.map((r) => ({
              date: r.date,
              open: r.open,
              close: r.close,
              high: r.high,
              low: r.low,
              volume: r.volume,
            }));
            const report = analyzeStockPotential(f.symbol, points, {
              price: quote?.price ?? points[points.length - 1]?.close ?? 0,
              changePercent: quote?.changePercent ?? 0,
            });
            items.push({
              symbol: f.symbol,
              market: f.market,
              name: quote?.name || f.name || f.symbol,
              price: quote?.price ?? null,
              changePercent: quote?.changePercent ?? null,
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
    watchlistApi.add({ symbol: sym, name }).catch(() => {}); // 服务端同步（失败不影响本地收藏）
    setFavInput('');
    setFavMsg(`已收藏「${sym}」(${marketLabel(market)})`);
    await loadFavorites();
  };

  // 删除收藏（五角星取消，本地 + 服务端同步）
  const removeFavorite = (symbol: string) => {
    removeFavoriteEntry(symbol);
    watchlistApi.remove(symbol).catch(() => {});
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

  // 今日观察：因子评分算法选出 6 支（独立后端数据）
  useEffect(() => {
    (async () => {
      try {
        const rec = await getRecommendations(
          (await import('../lib/stock')).STOCK_POOL,
          RECOMMEND_COUNT,
        );
        if (!aliveRef.current) return;
        setRecommends(rec);
        // 评分时间：python 模式取后端每日快照时间；node 模式取本次计算时间
        setScoreTime(
          getLastComputedAt() ??
            new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }),
        );
        setRecError(null);
      } catch (err: any) {
        console.error('因子评分加载失败:', err);
        if (!aliveRef.current) return;
        setRecError(`因子评分加载失败: ${err?.message || '未知错误'}`);
      } finally {
        if (aliveRef.current) setRecLoading(false);
      }
    })();
    loadFavorites();
  }, [loadFavorites]);

  // 市场温度计：30 秒轮询
  useEffect(() => {
    const load = () =>
      moodApi
        .get()
        .then((m) => {
          if (aliveRef.current) setMood(m);
        })
        .catch(() => {});
    load();
    const stopPolling = setVisibilityInterval(load, 30000);
    return () => stopPolling();
  }, []);

  // 拉取指数迷你走势（一次即可，getHistory 自带 5 分钟缓存）
  useEffect(() => {
    if (indicesLoading || Object.keys(sparks).length > 0) return;
    let alive = true;
    (async () => {
      const out: Record<string, number[]> = {};
      await Promise.all(
        indices.map(async (q) => {
          if (q.price === null) return;
          try {
            const rows = await getHistory(q.symbol, detectMarket(q.symbol), 'day', 30);
            if (rows.length) out[q.symbol] = rows.map((r) => r.close);
          } catch {
            /* 缺图不影响主流程 */
          }
        }),
      );
      if (alive && Object.keys(out).length) setSparks(out);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicesLoading]);

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
              🧮 {item.score}分 · {item.rating}
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
        ...theme.page,
        position: 'relative',
        // overflow: clip 与 hidden 裁剪效果相同，但**不创建滚动容器**——
        // 原先的 hidden 会让 sticky 导航在首页失效（祖先带 overflow 即失效的 CSS 规则）
        overflow: 'clip',
        color: '#e2e8f0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* ── 顶部导航栏（全站统一；顶部声明条由 TopNav 内置，全站每页可见） ── */}
      <TopNav />

      {/* 全站动画关键帧 + 网格纹理 */}
      <style>{`
        @keyframes pq-ticker { 0% { transform: translateX(0) } 100% { transform: translateX(-50%) } }
        @keyframes pq-glow { 0%,100% { box-shadow: 0 0 20px rgba(37,99,235,0.15) } 50% { box-shadow: 0 0 40px rgba(37,99,235,0.3) } }
        @keyframes pq-shimmer { 0% { background-position: -200% 0 } 100% { background-position: 200% 0 } }
      `}</style>
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: 'linear-gradient(rgba(148,163,184,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.03) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
        maskImage: 'radial-gradient(ellipse at 50% 0%, black 15%, transparent 70%)',
        WebkitMaskImage: 'radial-gradient(ellipse at 50% 0%, black 15%, transparent 70%)',
      }} />

      {/* ── 指数跑马灯 ── */}
      {indices.some((q) => q.price !== null) && (
        <div style={{ overflow: 'hidden', borderBottom: '1px solid #1e293b', backgroundColor: 'rgba(10,14,23,0.72)' }}>
          <div style={{ display: 'flex', gap: '44px', width: 'max-content', padding: '7px 0', animation: 'pq-ticker 32s linear infinite' }}>
            {[...indices, ...indices].map((q, i) => (
              <span
                key={i}
                style={{ fontSize: 12, fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap', color: '#94a3b8', cursor: 'pointer' }}
                onClick={() => navigate(`/stock/${q.symbol}`)}
              >
                {q.name}{' '}
                <span style={{ color: '#f1f5f9' }}>{q.price !== null ? q.price.toFixed(2) : '--'}</span>{' '}
                <span style={{ color: pctColor(q.changePercent) }}>
                  {(q.changePercent ?? 0) >= 0 ? '▲' : '▼'} {Math.abs(q.changePercent ?? 0).toFixed(2)}%
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── 主体 ── */}
      <main style={{ padding: '28px 24px 48px' }}>
        {/* Hero 标语 */}
        <section style={{ textAlign: 'center', margin: '14px 0 40px', position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
            {['实时行情', '多因子评分', '策略回测', '模拟撮合', 'Agent 团队'].map((tag) => (
              <span key={tag} style={{
                fontSize: 11, color: '#64748b', backgroundColor: 'rgba(96,165,250,0.06)',
                border: '1px solid rgba(96,165,250,0.15)', borderRadius: 999, padding: '3px 12px',
                fontFamily: 'Consolas, monospace', letterSpacing: '0.5px',
              }}>{tag}</span>
            ))}
          </div>
          <h1
            style={{
              fontSize: '36px',
              fontWeight: 800,
              margin: '0 0 12px',
              letterSpacing: '1.5px',
              background: 'linear-gradient(90deg, #f8fafc 15%, #93c5fd 50%, #38bdf8 85%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            AI深度量化
          </h1>
          <p style={{ fontSize: 14, color: '#64748b', margin: '0 0 6px', letterSpacing: '2px', fontFamily: 'Consolas, monospace' }}>
            DATA-DRIVEN QUANTITATIVE RESEARCH
          </p>
          <p style={{ fontSize: '14px', color: '#94a3b8', margin: 0 }}>
            真实市场数据 · 多因子量化分析 · 策略回测 · 模拟撮合 · 每 10 秒自动更新
          </p>
        </section>

        {/* ── 市场温度计（融合 TSP 市场情绪模块） ── */}
        {mood && (
          <section style={{ marginBottom: '28px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '18px',
                flexWrap: 'wrap',
                padding: '12px 18px',
                backgroundColor: 'rgba(17,24,39,0.6)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                border: '1px solid rgba(96,165,250,0.16)',
                borderRadius: '12px',
                fontSize: 13,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 11, color: '#64748b', letterSpacing: 1 }}>市场情绪</span>
                <b style={{ fontSize: 22, color: mood.score >= 60 ? '#ef4444' : mood.score >= 45 ? '#e2e8f0' : '#60a5fa' }}>{mood.score}</b>
                <span style={{ fontSize: 11, color: '#64748b' }}>
                  {mood.score >= 75 ? '过热' : mood.score >= 60 ? '偏暖' : mood.score >= 45 ? '中性' : mood.score >= 30 ? '偏冷' : '冰点'}
                </span>
              </span>
              <span style={{ color: '#ef4444' }}>▲ {mood.up}</span>
              <span style={{ color: '#22c55e' }}>▼ {mood.down}</span>
              <span style={{ color: '#f87171' }}>涨停 {mood.limitUp}</span>
              <span style={{ color: '#4ade80' }}>跌停 {mood.limitDown}</span>
              <span style={{ color: '#94a3b8' }}>成交 {(mood.totalAmount / 1e12).toFixed(2)} 万亿</span>
              <span style={{ flex: 1 }} />
              <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {mood.industries.slice(0, 4).map((i) => (
                  <span
                    key={i.name}
                    style={{ fontSize: 12, padding: '2px 9px', borderRadius: 999, backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#fca5a5', cursor: 'pointer' }}
                    onClick={() => navigate('/screener')}
                    title="前往选股页查看"
                  >
                    {i.name} +{i.avgPct}%
                  </span>
                ))}
                <button
                  onClick={() => navigate('/screener')}
                  style={{ fontSize: 12, padding: '3px 11px', color: '#93c5fd', backgroundColor: 'transparent', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 999, cursor: 'pointer' }}
                >
                  去选股 →
                </button>
              </span>
            </div>
          </section>
        )}

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
              {(() => {
                const st = getMarketStatus('CN');
                return (
                  <span
                    title={st.detail}
                    style={{
                      marginLeft: '10px',
                      fontSize: '12px',
                      fontWeight: 500,
                      color: st.open ? '#ef4444' : '#94a3b8',
                      backgroundColor: 'rgba(255,255,255,0.04)',
                      padding: '2px 10px',
                      borderRadius: '999px',
                      verticalAlign: 'middle',
                    }}
                  >
                    {st.open ? '🔴' : '⚪'} A股{st.label}
                  </span>
                );
              })()}
            </h2>
            <span
              style={{
                fontSize: '11px',
                color: '#64748b',
                backgroundColor: '#111827',
                border: '1px solid #1e293b',
                padding: '3px 10px',
                borderRadius: '999px',
              }}
            >
              {BACKEND_MODE === 'python'
                ? '数据源：Baostock（历史K线）· 新浪/腾讯（实时行情）· 东方财富（板块/资金/财务）'
                : '数据源：新浪/腾讯公开接口（行情）· 东方财富公开接口（板块/资金/财务/公告/新闻）'}
            </span>
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
              {indices.map((q) => {
                const chg = q.changePercent ?? 0;
                const spark = sparks[q.symbol];
                return (
                  <div
                    key={q.symbol}
                    onClick={() => navigate(`/stock/${q.symbol}`)}
                    title="点击查看指数详情"
                    style={{
                      padding: '14px 16px',
                      backgroundColor: 'rgba(17,24,39,0.6)',
                      backdropFilter: 'blur(10px)',
                      borderRadius: '12px',
                      border: '1px solid rgba(96,165,250,0.16)',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLDivElement).style.borderColor = '#3b82f6';
                      (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
                      (e.currentTarget as HTMLDivElement).style.boxShadow = '0 8px 24px rgba(37,99,235,0.25)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(96,165,250,0.16)';
                      (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
                      (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
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
                        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: '2px', gap: '6px' }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: pctColor(chg) }}>
                            {formatPercent(chg)}
                          </span>
                          {spark && spark.length > 1 && (
                            <Sparkline points={spark} color={chg >= 0 ? '#ef4444' : '#22c55e'} />
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── 板块与资金 ── */}
        <section style={{ marginBottom: '36px' }}>
          <h2 style={{ fontSize: '20px', fontWeight: '600', margin: '0 0 16px', color: '#f1f5f9' }}>
            🧭 板块与资金
            <span style={{ fontSize: '12px', color: '#64748b', marginLeft: 10, fontWeight: 400 }}>数据来自东方财富公开接口 · 30 秒缓存</span>
          </h2>
          <SectorMarketPanel />
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
              收藏云端同步至账号，换设备登录即见（首访自动迁移本地收藏）
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

        {/* ── 今日观察（因子评分每日 6 支） ── */}
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
              📊 今日观察 · 量化因子评分
            </h2>
            <span style={{ fontSize: '12px', color: '#475569', marginBottom: '16px' }}>
              基于趋势/动量/量能/波动/位置五因子模型，每日自动量化评分
              {scoreTime && (
                <span
                  style={{
                    marginLeft: '8px',
                    color: '#60a5fa',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    padding: '2px 10px',
                    borderRadius: '999px',
                    fontSize: '11px',
                  }}
                >
                  ⏱ 评分时间 {scoreTime}
                </span>
              )}
            </span>
          </div>

          {recLoading && (
            <div style={{ textAlign: 'center', color: '#64748b', padding: '32px 0' }}>
              <span className="dsh-spin" style={{ marginRight: '8px' }}>
                ⏳
              </span>
              正在计算股票池因子评分，请稍候...
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
                renderRow(
                  {
                    symbol: r.symbol,
                    market: r.market,
                    name: r.name,
                    price: r.price,
                    changePercent: r.changePercent,
                    score: r.score,
                    rating: r.rating,
                  },
                  r.score !== null ? (
                    <div key={`${r.symbol}-ring`} style={{ minWidth: '46px' }}>
                      <ScoreRing
                        score={r.score}
                        color={
                          r.score >= 80 ? '#ef4444' : r.score >= 65 ? '#f59e0b' : r.score >= 45 ? '#60a5fa' : '#94a3b8'
                        }
                      />
                    </div>
                  ) : null,
                ),
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
                    (e.currentTarget as HTMLDivElement).style.boxShadow = '0 10px 30px rgba(37,99,235,0.3)';
                    (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-3px)';
                  }
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.borderColor = '#1e293b';
                  (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                  (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
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

      {/* ── 页脚免责声明 ── */}
      <footer
        style={{
          textAlign: 'center',
          fontSize: '12px',
          color: '#94a3b8',
          borderTop: '1px solid #334155',
          padding: '16px 24px 24px',
          marginTop: '24px',
          backgroundColor: '#0d1322',
          lineHeight: '1.8',
        }}
      >
        <p style={{ margin: '0 0 6px' }}>
          ⚠️ 本平台为<b>学生学术研究演示</b>，数据来源于公开财经网站（新浪/腾讯/东方财富），
          <b>不构成任何投资建议</b>，亦不涉及荐股、预测及实盘交易。
        </p>
        <p style={{ margin: '0 0 6px' }}>
          📊 数据源：Baostock（历史K线，版权归 Baostock 所有）· 新浪/腾讯公开接口（实时行情）· 东方财富公开接口（板块资金/财务/公告/新闻）·
          仅用于历史回测展示 · 请勿据此操作
        </p>
        <p style={{ margin: '0 0 6px', fontSize: '11px', color: '#64748b' }}>
          🌐 当前为公网演示版，国内部分网络可能无法访问，请使用代理或后续等待自定义域名上线。
        </p>
        <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
          © 2026 AI深度量化 · 仅供学习参考
        </p>
      </footer>
    </div>
  );
}
