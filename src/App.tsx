import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { authApi } from './api/dataService';
import HomePage from './pages/HomePage';
import StockDetailPage from './pages/StockDetailPage';
import AnalyzePage from './pages/AnalyzePage';
import BacktestPage from './pages/BacktestPage';
import AssistantPage from './pages/AssistantPage';
import PaperTradingPage from './pages/PaperTradingPage';
import AgentTeamPage from './pages/AgentTeamPage';
import AgentReportPage from './pages/AgentReportPage';
import LoginPage from './pages/LoginPage';

/**
 * AI深度量化 路由：
 * - `/`              → 主页（市场概况 / 我的收藏 / 今日观察 / 功能中心）
 * - `/stock/:symbol` → 个股详情页（K线/均线/MACD/形态分析 + 分钟副图，URL 参数驱动）
 * - `/analyze`       → 量化因子分析页（五因子评分）
 * - `/backtest`      → 策略回测页（MA双均线/RSI/买入持有）
 * - `/assistant`     → AI 智能助手页（个股解读/推荐/指南）
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
      <div style={{ fontSize: 40, animation: 'pq-float 2s ease-in-out infinite' }}>📊</div>
      <div style={{ fontSize: 14, letterSpacing: 4, color: '#64748b' }}>正在进入 AI 深度量化…</div>
    </div>
  );
}

function App() {
  const [authState, setAuthState] = useState<'checking' | 'in' | 'out'>('checking');

  useEffect(() => {
    authApi
      .me()
      .then((m) => setAuthState(m.ok ? 'in' : 'out'))
      .catch(() => setAuthState('out'));
  }, []);

  if (authState === 'checking') return <Splash />;
  if (authState === 'out') return <LoginPage onLogin={() => setAuthState('in')} />;

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/stock/:symbol" element={<StockDetailPage />} />
          <Route path="/analyze" element={<AnalyzePage />} />
          <Route path="/backtest" element={<BacktestPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="/paper" element={<PaperTradingPage />} />
          <Route path="/agents" element={<AgentTeamPage />} />
          <Route path="/agents/report/:id" element={<AgentReportPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
