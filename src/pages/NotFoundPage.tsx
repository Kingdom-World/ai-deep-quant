// ─────────────────────────────────────────────────────────────
// 未找到页（404）
//
// 🔴 为什么补这个（2026-10-13 R1 阶段）：
//   原实现 `path="*"` 直接 `<Navigate to="/" replace />` —— 未知路径**静默跳回首页**。
//   问题是：用户的 URL 被改掉、没有任何提示，他会以为"我点错了"或"网站坏了"，
//   而实际上他可能只是收藏了一个已改名的旧地址（本项目恰好有过路由迁移：
//   /experiments → /research/experiments、/factor-eval → /research/factors）。
//
//   ⇢ 404 页的价值不是"好看"，而是**把静默失败变成可理解的状态**：
//     明确告知"这个地址不存在" + 回显用户实际访问的路径（便于自查拼写）
//     + 给出高频出口（回首页 / 去研究中心的几个常用 Tab / 返回上一页）。
//
//   ⚠️ 行为边界（本页不做什么）：
//     · **不返回 HTTP 404 状态码** —— 静态托管下由后端 SPA 回退统一返回 index.html(200)，
//       要改需要动 server 静态层。本项目是邀请制私人平台、无 SEO 需求，
//       故不改（改了会波及所有前端路由的托管路径，收益为零）。
//     · **不做自动跳转** —— 自动跳转正是本页要消除的行为。
//     · 旧路由的 `Navigate` 兼容保留在 App.tsx，不进本页（那是"已知的旧地址"，
//       与"未知地址"是两件事）。
//
//   样式：沿用 theme 令牌 + 内联风格，与 LegalPage 等静态页一致。
//   不引入新的 CSS 方案 —— 样式体系收敛属 R2 阶段，此处只做加法。
// ─────────────────────────────────────────────────────────────
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { theme } from '../lib/theme';

const c = theme.color;

/** 高频出口：按功能区组织（与 zones.ts 的分区语义一致）
 *  ⚠️ 刻意**不指向具体个股** —— 硬编码某只股票（如 sh600519）会假设用户关心它，
 *     且代码退市/改名后链接即失效。这里只放中性的功能入口。 */
const EXITS: { to: string; label: string; desc: string }[] = [
  { to: '/', label: '首页', desc: '市场概况与收藏' },
  { to: '/features', label: '功能总览', desc: '全部模块一览' },
  { to: '/research', label: '研究中心', desc: '横截面与因子评估' },
  { to: '/paper', label: '模拟交易', desc: '虚拟资金与策略' },
];

export default function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: 'clamp(24px, 6vh, 64px) 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing(3),
      }}
    >
      <section style={{ ...theme.card, textAlign: 'center' }}>
        <div
          style={{
            fontSize: 44,
            lineHeight: 1,
            fontWeight: 700,
            color: c.primary,
            letterSpacing: '0.04em',
            marginBottom: theme.spacing(1.5),
          }}
        >
          404
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: theme.fontSize.xl,
            color: c.text,
            fontWeight: 600,
          }}
        >
          没有这个页面
        </h1>
        <p
          style={{
            margin: `${theme.spacing(1)} 0 0`,
            fontSize: theme.fontSize.md,
            color: c.textMuted,
            lineHeight: 1.7,
          }}
        >
          该地址在本站不存在。可能是拼写有误、链接已失效，或页面地址发生过调整。
        </p>

        {/* 回显实际访问的路径 —— 让用户能自己核对是不是打错了 */}
        <div
          style={{
            marginTop: theme.spacing(2),
            padding: '10px 12px',
            backgroundColor: c.bgSunken,
            border: `1px solid ${c.border}`,
            borderRadius: theme.radius.sm,
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: theme.fontSize.sm,
            color: c.textFaint,
            wordBreak: 'break-all',
            textAlign: 'left',
          }}
        >
          <span style={{ color: c.textMuted }}>你访问的地址：</span>
          {location.pathname}
          {location.search || ''}
        </div>

        <div
          style={{
            display: 'flex',
            gap: theme.spacing(1.5),
            justifyContent: 'center',
            flexWrap: 'wrap',
            marginTop: theme.spacing(2.5),
          }}
        >
          <Link
            to="/"
            style={{
              padding: '9px 18px',
              borderRadius: theme.radius.sm,
              backgroundColor: c.primaryDeep,
              color: '#fff',
              fontSize: theme.fontSize.md,
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            回到首页
          </Link>
          <button
            type="button"
            onClick={() => navigate(-1)}
            style={{
              padding: '9px 18px',
              borderRadius: theme.radius.sm,
              backgroundColor: 'transparent',
              border: `1px solid ${c.borderStrong}`,
              color: c.textMuted,
              fontSize: theme.fontSize.md,
              cursor: 'pointer',
            }}
          >
            返回上一页
          </button>
        </div>
      </section>

      <section>
        <h2
          style={{
            margin: `0 0 ${theme.spacing(1.5)}`,
            fontSize: theme.fontSize.sm,
            color: c.textFaint,
            fontWeight: 500,
            letterSpacing: '0.03em',
          }}
        >
          你可能想找
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: theme.spacing(1.5),
          }}
        >
          {EXITS.map((it) => (
            <Link
              key={it.to}
              to={it.to}
              style={{
                ...theme.card,
                padding: '12px 14px',
                textDecoration: 'none',
                display: 'block',
              }}
            >
              <div style={{ fontSize: theme.fontSize.md, color: c.text, fontWeight: 500 }}>
                {it.label}
              </div>
              <div style={{ fontSize: theme.fontSize.xs, color: c.textFaint, marginTop: 4 }}>
                {it.desc}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
