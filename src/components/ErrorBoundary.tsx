import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 出错时的回退 UI（默认友好提示） */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * 错误边界：捕获子树渲染错误，防止整个页面崩溃。
 * 用法：<ErrorBoundary><StockDetailPage /></ErrorBoundary>
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || '未知错误' };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 上报/打印错误（生产环境可接入监控）
    console.error('[ErrorBoundary] 捕获错误:', error, info.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, message: '' });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          style={{
            minHeight: '100vh',
            backgroundColor: '#0a0e17',
            color: '#e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ padding: '40px', textAlign: 'center', maxWidth: '520px' }}>
            <div style={{ fontSize: '40px', marginBottom: '12px' }}>⚠️</div>
            <h2 style={{ color: '#f87171', margin: '0 0 12px' }}>页面出现异常</h2>
            <p style={{ color: '#94a3b8', margin: '0 0 20px', fontSize: '14px' }}>
              {this.state.message || '渲染过程中发生错误'}
            </p>
            <button
              onClick={this.handleReset}
              style={{
                padding: '10px 28px',
                backgroundColor: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              🔄 重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
