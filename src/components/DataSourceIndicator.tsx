import { useEffect, useState } from 'react';
import { checkBridgeHealth, getDataSourceStatus } from '../api/dataService';

interface Status {
  current: string;
  primary: string;
  primaryHealthy: boolean;
  primaryConfigured: boolean;
  cacheSize: number;
}

export const DataSourceIndicator = () => {
  const [status, setStatus] = useState<Status>(getDataSourceStatus());
  const [bridgeOk, setBridgeOk] = useState<boolean | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setStatus(getDataSourceStatus());
      checkBridgeHealth().then((h) => setBridgeOk(h.ok));
    }, 10000);
    checkBridgeHealth().then((h) => setBridgeOk(h.ok));
    return () => clearInterval(interval);
  }, []);

  const color = bridgeOk === null ? '#94a3b8' : bridgeOk ? '#22c55e' : '#ef4444';
  const label =
    bridgeOk === null
      ? '● AI深度量化数据服务 (连接中...)'
      : bridgeOk
        ? '● AI深度量化数据服务'
        : '● 数据服务 (未启动)';

  return (
    <div
      title="数据来源: AI深度量化独立数据服务（新浪/腾讯公开数据源，无需 API Key）。请确保已启动 npm start"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '12px',
        color: '#94a3b8',
        padding: '4px 12px',
        borderRadius: '20px',
        backgroundColor: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.08)',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: color,
          animation: bridgeOk ? 'dsh-pulse 2s infinite' : 'none',
        }}
      />
      <span>{label}</span>
      <span style={{ fontSize: '10px', color: '#64748b', fontWeight: 500 }}>主:AI深度量化服务</span>
      <span style={{ fontSize: '10px', color: '#64748b' }}>(缓存 {status.cacheSize})</span>
      <style>{`
        @keyframes dsh-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
};
