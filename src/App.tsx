import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import HomePage from './pages/HomePage';
import StockDetailPage from './pages/StockDetailPage';
import AnalyzePage from './pages/AnalyzePage';
import BacktestPage from './pages/BacktestPage';
import AssistantPage from './pages/AssistantPage';

/**
 * AI深度量化 路由：
 * - `/`              → 主页（市场概况 / 我的收藏 / AI 今日推荐 / 功能中心）
 * - `/stock/:symbol` → 个股详情页（K线/均线/MACD/形态分析 + 分钟副图，URL 参数驱动）
 * - `/analyze`       → AI 潜力分析页（多因子评分）
 * - `/backtest`      → 策略回测页（MA双均线/RSI/买入持有）
 * - `/assistant`     → AI 智能助手页（个股解读/推荐/指南）
 * 每个页面由 ErrorBoundary 包裹，局部错误不导致整站崩溃。
 */
function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/stock/:symbol" element={<StockDetailPage />} />
          <Route path="/analyze" element={<AnalyzePage />} />
          <Route path="/backtest" element={<BacktestPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
