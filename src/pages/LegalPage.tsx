// ─────────────────────────────────────────────────────────────
// 法律与合规页（/legal）
//   Phase 0-A 合规基建：免责声明 / 风险提示 / 隐私声明 / 数据来源 四节。
//   定位声明：学生学术研究演示 · 好友邀请码访问 · 免费 · 非经营。
//   内容口径与全站页脚、AI 披露一致（单一事实源为页面级声明文本，此处为完整版）。
// ─────────────────────────────────────────────────────────────
import { Link } from 'react-router-dom';
import { theme } from '../lib/theme';

const c = theme.color;

interface Section {
  id: string;
  icon: string;
  title: string;
  items: string[];
}

const SECTIONS: Section[] = [
  {
    id: 'disclaimer',
    icon: '📜',
    title: '一、免责声明',
    items: [
      '本平台为个人学习用途的学术研究演示项目，仅面向受邀好友开放，完全免费，不从事任何证券投资咨询、荐股、代客理财或收费服务。',
      '本平台提供的全部内容——包括行情展示、因子回测、AI 助手问答、Agent 团队报告、模拟盘交易——均为算法自动生成的学习研究演示，不构成任何投资建议，不代表对任何证券价格的预测或承诺。',
      'AI 助手回答与 Agent 报告由本地规则引擎与大语言模型协作生成，可能存在事实错误、逻辑缺陷或数据缺失；推理深度受限时会显式标注「降级」，请留意标注。',
      '任何用户依据本平台内容做出的投资决策，责任由其自行承担；平台作者不对由此产生的任何直接或间接损失负责。',
    ],
  },
  {
    id: 'risk',
    icon: '⚠️',
    title: '二、风险提示',
    items: [
      '数据风险：行情与资讯来自公开网络接口，可能存在延迟、缺失、错误或临时不可用；历史数据未经独立审计，仅供演示。',
      '模型风险：历史回测存在过拟合风险，历史表现不代表未来收益；回测引擎对滑点、涨跌停、退市等真实市场机制做了简化，结果与真实交易存在系统性差异。',
      '模拟盘风险：模拟盘使用虚拟资金与简化撮合模型，成交假设优于真实市场；模拟盘收益不代表任何真实账户的实际或潜在表现。',
      'AI 局限：大语言模型可能产生幻觉内容；规则引擎仅覆盖预设场景；两者输出的量化解读均应视为「供讨论的假设」而非结论。',
    ],
  },
  {
    id: 'privacy',
    icon: '🔒',
    title: '三、隐私声明',
    items: [
      '账号体系：仅凭邀请码注册，收集的信息限于用户名与密码的单向散列值，不收集手机号、邮箱等个人身份信息。',
      '登录态：使用会话 Cookie 维持登录状态，仅用于身份识别，不用于跨站追踪或广告。',
      'AI 服务：使用 AI 助手时，提问内容可能经由平台配置的第三方大模型服务处理；若使用「自带 API Key」模式，请求由浏览器直连对应服务商。请勿在对话中输入个人敏感信息。',
      '数据存储：用户产生的数据（自选股、模拟盘、研究报告等）仅存储于平台用于功能实现，不对外提供，不用于商业目的，不会出售或转售。',
      '删除权利：如需删除账号及相关数据，可联系平台管理员处理。',
    ],
  },
  {
    id: 'data',
    icon: '📊',
    title: '四、数据来源与版权',
    items: [
      '历史 K 线与 A 股清单：Baostock 公开数据接口，版权归 Baostock 所有。',
      '实时行情、选股快照与市场温度计：腾讯公开行情接口。',
      '行情辅助源与 7x24 要闻：新浪公开接口。',
      '板块资金、财务数据与新闻摘要：东方财富公开接口。',
      '上述数据版权归原发布方所有，本平台引用仅供学习研究，不用于任何商业用途；数据可能延迟或更正，请以交易所与官方披露为准。',
      '如数据来源方对本平台的使用方式持有异议，请通过管理员联系，确认后将及时调整或移除。',
    ],
  },
];

export default function LegalPage() {
  return (
    <div style={{ ...theme.page }}>
      <div style={{ ...theme.pageWrapNarrow, maxWidth: 860, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        {/* 顶部：返回 + 标题 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <Link
            to="/"
            style={{
              color: c.primary,
              fontSize: 13,
              textDecoration: 'none',
              border: `1px solid ${c.borderStrong}`,
              borderRadius: 8,
              padding: '6px 12px',
              background: c.bgSunken,
            }}
          >
            ← 返回首页
          </Link>
          <span style={{ fontSize: theme.fontSize.sm, color: c.textFaint }}>生效日期：2026-10-02 · 重大变更将在本页更新</span>
        </div>

        <h1 style={{ ...theme.sectionTitle, fontSize: 24, marginBottom: 6 }}>⚖️ 法律声明与合规信息</h1>
        <p style={{ fontSize: 13, color: c.textMuted, margin: '0 0 20px', lineHeight: 1.7 }}>
          本平台是一个<b style={{ color: c.text }}>学生学术研究演示项目</b>（免费 · 邀请码访问 · 非经营）。
          以下声明适用于平台全部页面与功能，请在使用前完整阅读。
        </p>

        {/* 四节声明 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} style={{ ...theme.card, padding: 20 }}>
              <h2 style={{ fontSize: 17, margin: '0 0 12px', color: c.text }}>
                {s.icon} {s.title}
              </h2>
              <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {s.items.map((it, i) => (
                  <li key={i} style={{ fontSize: 13, color: c.textMuted, lineHeight: 1.8 }}>
                    {it}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <p style={{ fontSize: 12, color: c.textFaint, marginTop: 20, lineHeight: 1.8, textAlign: 'center' }}>
          © 2026 AI深度量化 · 仅供学习研究 · 本页声明不构成法律意见
        </p>
      </div>
    </div>
  );
}
