// ─────────────────────────────────────────────────────────────
// 研究中心 · Tab 间共享的样式常量与小部件
//   原 ResearchPage 的内联样式与小组件抽出——四个 Tab 共用，
//   避免"每个 Tab 文件里各复制一份"造成样式漂移。
// ─────────────────────────────────────────────────────────────
import type { CSSProperties } from 'react';

export const card: CSSProperties = {
  backgroundColor: 'rgba(15,23,42,0.72)',
  border: '1px solid rgba(51,65,85,0.7)',
  borderRadius: 14,
  padding: '18px 20px',
  marginBottom: 18,
};
export const sectionTitle: CSSProperties = { fontSize: 16, fontWeight: 800, color: '#f1f5f9', marginBottom: 4 };
export const sectionSub: CSSProperties = { fontSize: 12, color: '#64748b', marginBottom: 14 };
export const label: CSSProperties = { fontSize: 12, color: '#94a3b8', marginBottom: 4 };
export const input: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 13, color: '#e2e8f0',
  backgroundColor: 'rgba(13,19,34,0.85)', border: '1px solid #334155', borderRadius: 8, outline: 'none',
};
export const btn: CSSProperties = {
  padding: '8px 18px', fontSize: 13, fontWeight: 700, color: '#fff', backgroundColor: '#2563eb',
  border: 'none', borderRadius: 8, cursor: 'pointer',
};
export const btnGhost: CSSProperties = {
  ...btn, color: '#94a3b8', backgroundColor: 'transparent', border: '1px solid #334155',
};
export const metricCell: CSSProperties = {
  flex: 1, minWidth: 96, backgroundColor: 'rgba(13,19,34,0.6)', borderRadius: 10, padding: '10px 12px',
};
export const th: CSSProperties = {
  textAlign: 'left', fontSize: 11, color: '#64748b', padding: '6px 8px', borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap',
};
export const td: CSSProperties = { fontSize: 12, color: '#cbd5e1', padding: '6px 8px', borderBottom: '1px solid rgba(30,41,59,0.6)', whiteSpace: 'nowrap' };

/** A 股习惯：正为红、负为绿、零/空为灰 */
export const pctColorOf = (v: number | null | undefined) =>
  v === null || v === undefined ? '#94a3b8' : v > 0 ? '#ef4444' : v < 0 ? '#22c55e' : '#94a3b8';

export function Metric({ name, value, color }: { name: string; value: string | number; color?: string }) {
  return (
    <div style={metricCell}>
      <div style={{ fontSize: 11, color: '#64748b' }}>{name}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: color || '#e2e8f0', marginTop: 2 }}>{value}</div>
    </div>
  );
}
