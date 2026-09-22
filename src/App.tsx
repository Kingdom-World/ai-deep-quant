import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import Backdrop from './components/Backdrop';
import BrandMark from './components/BrandMark';
import { authApi } from './api/dataService';
import HomePage from './pages/HomePage';
import StockDetailPage from './pages/StockDetailPage';
import AnalyzePage from './pages/AnalyzePage';
import BacktestPage from './pages/BacktestPage';
import ScreenerPage from './pages/ScreenerPage';
import ResearchCenterPage from './pages/ResearchCenterPage';
import AgentResearchPage from './pages/AgentResearchPage';
import FeaturePage from './pages/FeaturePage';
import AssistantPage from './pages/AssistantPage';
import PaperTradingPage from './pages/PaperTradingPage';
import AgentTeamPage from './pages/AgentTeamPage';
import AgentReportPage from './pages/AgentReportPage';
import NewsPage from './pages/NewsPage';
import LoginPage from './pages/LoginPage';

/**
 * AI深度量化 路由：
 * - `/`              → 主页（市场概况 / 我的收藏 / 今日观察 / 功能中心）
 * - `/stock/:symbol` → 个股详情页（K线/均线/MACD/形态分析 + 分钟副图，URL 参数驱动）
 * - `/analyze`       → 量化因子分析页（五因子评分）
 * - `/backtest`      → 策略回测页（MA双均线/RSI/买入持有）
 * - `/screener`      → 全市场选股页（8 快照策略 + 市场温度计，融合 TSP）
 * - `/research`      → 研究工作台（横截面回测/一致性报告/实验历史/对账/方法论）
 * - `/experiments`    → 实验对比页（跨实验参数差异 / 指标对比 / 参数复现）
 * - `/assistant`     → AI 智能助手页（个股解读/推荐/指南）
 * - `/news`          → 资讯中心（近三天公开资讯/公告/个股新闻）
 * - `/paper`         → 模拟交易页（虚拟资金/真实行情撮合/自动策略）
 * 认证：应用级守卫——未登录整屏渲染登录页；会话由后端 HttpOnly Cookie 维护（7 天）。
 * 每个页面由 ErrorBoundary 包裹，局部错误不导致整站崩溃。
 */

/** 会话检查期间的启动屏 */
function Splash() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        background: 'linear-gradient(160deg, #070b14, #0b1220)',
        color: '#60a5fa',
      }}
    >
      <BrandMark size={56} radius={13} shadow="0 0 34px rgba(56,189,248,0.35)" />
      <div style={{ fontSize: 14, letterSpacing: 4, color: '#64748b' }}>正在进入 AI 深度量化…</div>
    </div>
  );
}

/** 切页自动回到顶部：react-router 切换路由时**不会**自动滚动，
 *  浏览器会保留上一页的滚动位置——用户切到新页面时视口停在半截，
 *  表现为「页面抖动 / 尺寸不一 / 顶上不对」的真正根源（用户反馈 2026-09-17）。 */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function App() {
  const [authState, setAuthState] = useState<'checking' | 'in' | 'out'>('checking');

  useEffect(() => {
    authApi
      .me()
      // ⚠️ 必须同时看 authEnabled（2026-09-21 线上死锁修复）：
      //    公网部署未配置 SITE_PASSWORD ⇒ 后端 AUTH_ENABLED=false，
      //    /api/* 全开、也**不会创建任何账号**；若这里只用 `ok` 判定，
      //    前端会把整站挡在登录页后，而登录永远不可能成功 —— 站点彻底不可用。
      //    判据改为「有会话」或「后端根本没开鉴权」。
      .then((m) => setAuthState(m.ok || m.authEnabled === false ? 'in' : 'out'))
      .catch(() => setAuthState('out'));
  }, []);

  if (authState === 'checking') return <Splash />;
  if (authState === 'out') return <LoginPage onLogin={() => setAuthState('in')} />;

  return (
    <>
      <Backdrop />
      <BrowserRouter>
        <ScrollToTop />
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/stock/:symbol" element={<StockDetailPage />} />
            <Route path="/analyze" element={<AnalyzePage />} />
            <Route path="/backtest" element={<BacktestPage />} />
            <Route path="/screener" element={<ScreenerPage />} />
            <Route path="/research" element={<ResearchCenterPage tab="cross" />} />
            <Route path="/research/consistency" element={<ResearchCenterPage tab="consistency" />} />
            <Route path="/research/experiments" element={<ResearchCenterPage tab="experiments" />} />
            <Route path="/research/factors" element={<ResearchCenterPage tab="factors" />} />
            <Route path="/research/knowledge" element={<ResearchCenterPage tab="knowledge" />} />
            {/* 旧路由兼容（红队 R-D：SPA 内用 <Navigate replace>，非真 301） */}
            <Route path="/experiments" element={<Navigate to="/research/experiments" replace />} />
            <Route path="/factor-eval" element={<Navigate to="/research/factors" replace />} />
            <Route path="/agent-research" element={<AgentResearchPage />} />
            <Route path="/features" element={<FeaturePage />} />
            <Route path="/assistant" element={<AssistantPage />} />
            <Route path="/news" element={<NewsPage />} />
            <Route path="/paper" element={<PaperTradingPage />} />
            <Route path="/agents" element={<AgentTeamPage />} />
            <Route path="/agents/report/:id" element={<AgentReportPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </BrowserRouter>
    </>
  );
}

export default App;
