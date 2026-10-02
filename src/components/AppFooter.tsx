// ─────────────────────────────────────────────────────────────
// 全站页脚（App 级全局单例，位于 Routes 之后）
//   Phase 0-A 合规基建：一行风险提示 + /legal 完整声明入口。
//   此前免责声明是页面级（HomePage / StockDetailPage 各自渲染一份），
//   其余页面裸奔——提升为全局后全站 16 个路由统一覆盖，且不再重复。
//   注意：不含布局测量逻辑，无 transition，静态渲染零开销。
// ─────────────────────────────────────────────────────────────
import { Link } from 'react-router-dom';

export default function AppFooter() {
  return (
    <footer
      style={{
        textAlign: 'center',
        fontSize: '12px',
        color: '#94a3b8',
        borderTop: '1px solid #1e293b',
        padding: '16px 24px 24px',
        marginTop: '24px',
        lineHeight: '1.8',
      }}
    >
      <p style={{ margin: '0 0 6px' }}>
        ⚠️ 本平台为<b style={{ color: '#e2e8f0' }}>学生学术研究演示</b>，数据来源于公开财经网站（新浪/腾讯/东方财富），
        <b style={{ color: '#e2e8f0' }}>不构成任何投资建议</b>，亦不涉及荐股、预测及实盘交易。AI 生成内容仅供学习研究。
      </p>
      <p style={{ margin: '0 0 6px' }}>
        <Link to="/legal" style={{ color: '#60a5fa', textDecoration: 'none' }}>
          📜 完整免责声明 · 风险提示 · 隐私与数据来源 →
        </Link>
      </p>
      <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>© 2026 AI深度量化 · 仅供学习参考</p>
    </footer>
  );
}
