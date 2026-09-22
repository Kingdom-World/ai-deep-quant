// ─────────────────────────────────────────────────────────────
// 功能介绍页（/features）
//   目标：让新用户 3 分钟看懂"这个平台有什么、每样东西怎么用"。
//   内容原则：只写真实存在的功能与交互（与各页面实际能力一一对应），
//   不写营销话术；每条都给入口路径，可直达。
//   适配：桌面双列卡片网格，窄屏（<720px）单列。
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { theme } from '../lib/theme';

interface FeatureItem {
  name: string;
  path: string;
  icon: string;
  desc: string;
  usage: string[];
}

interface FeatureGroup {
  group: string;
  items: FeatureItem[];
}

const GROUPS: FeatureGroup[] = [
  {
    group: '行情与选股',
    items: [
      {
        name: '首页',
        path: '/',
        icon: '🏠',
        desc: '市场概况、我的收藏、今日观察与全部功能的入口中心。',
        usage: ['进入即览市场概况', '在功能中心点击卡片直达各功能页', '收藏标的后在首页集中跟踪'],
      },
      {
        name: '全市场选股',
        path: '/screener',
        icon: '🔍',
        desc: '全市场筛选：内置多套快照选股策略与市场温度计，按条件筛出候选标的。',
        usage: ['选择选股策略与筛选条件', '查看结果列表与市场温度计', '点击标的进入个股详情进一步研究'],
      },
      {
        name: '因子分析',
        path: '/analyze',
        icon: '🧮',
        desc: '对单只标的做五因子量化评分，多维度汇总为直观判断。',
        usage: ['搜索或选择标的', '查看五因子评分构成', '结合个股详情页交叉验证'],
      },
    ],
  },
  {
    group: '策略与回测',
    items: [
      {
        name: '策略回测',
        path: '/backtest',
        icon: '📈',
        desc: 'MA 双均线 / RSI / 买入持有等策略回测，输出收益、年化、最大回撤、夏普、索提诺、卡玛等指标，净值曲线附交易买卖点标记。',
        usage: ['选择标的、策略与参数区间', '运行回测并查看指标卡与净值曲线', '每次回测自动留痕，可在「实验对比」中复现'],
      },
      {
        name: '研究中心',
        path: '/research',
        icon: '🧪',
        desc: '四 Tab 研究链路：横截面回测（动量/反转组合）→ 一致性与对账（回测 vs 模拟盘）→ 实验对比（横向比较与复现）→ 因子稳健性（逐年稳定性判定）。',
        usage: [
          'Tab1 选择因子与参数运行横截面回测',
          'Tab2 查看熔断状态与账实对账，Tab3 勾选多条实验横向对比',
          'Tab4 查看各因子逐年超额分布与稳健性判定',
        ],
      },
    ],
  },
  {
    group: '交易与风控',
    items: [
      {
        name: '量化看板',
        path: '/stock/sh600519',
        icon: '📊',
        desc: '个股详情：K 线、均线系统、MACD、形态分析与分钟图副指标，URL 参数驱动可直达任意标的。',
        usage: ['从搜索或选股结果进入个股', '切换周期与副图指标', '结合形态分析辅助判断'],
      },
      {
        name: '模拟交易',
        path: '/paper',
        icon: '💼',
        desc: '虚拟资金 + 真实行情撮合，支持自动策略；内置回撤熔断（L1 禁开仓 / L2 锁定）与账实对账，风控语义与回测口径一致。',
        usage: ['初始化模拟账户后下单或启用自动策略', '查看持仓、挂单冻结与成交明细', '触发熔断时按页面引导手动解锁'],
      },
    ],
  },
  {
    group: 'AI 能力',
    items: [
      {
        name: 'Agent 团队',
        path: '/agents',
        icon: '🤖',
        desc: '13 角色、五阶段流水线：数据收集（四分析师并行）→ 多空辩论 → 交易决策 → 风险评估 → 风险主管终审，输出结构化报告。',
        usage: ['输入标的发起分析', '逐阶段查看各角色的分析与辩论过程', '在历史报告中回看与对比'],
      },
      {
        name: 'Agent 研究',
        path: '/agent-research',
        icon: '🔬',
        desc: '用一句话提问，Alpha 技术分析师自主调用 K 线 / 回测 / 参数稳健性工具取证后给出结论；每步工具调用带数据指纹，全程可追溯。',
        usage: ['输入自然语言研究问题', '查看工具调用轨迹与数据指纹', '结论旁的「工具原始数据」为规则引擎直出，数值以它为准'],
      },
      {
        name: 'AI 助手',
        path: '/assistant',
        icon: '💬',
        desc: '个股解读、推荐逻辑说明与平台使用指南的问答入口。',
        usage: ['选择标的或直接提问', '查看解读与指南回复'],
      },
    ],
  },
  {
    group: '资讯',
    items: [
      {
        name: '资讯中心',
        path: '/news',
        icon: '📰',
        desc: '近三天公开资讯、公告与个股新闻聚合。',
        usage: ['浏览最新列表', '按标的查看相关新闻与公告'],
      },
    ],
  },
];

const Card = ({ item }: { item: FeatureItem }) => (
  <div
    style={{
      backgroundColor: 'rgba(15,23,42,0.72)',
      border: '1px solid rgba(51,65,85,0.7)',
      borderRadius: 14,
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 18 }}>{item.icon}</span>
      <span style={{ fontSize: 14.5, fontWeight: 700, color: '#f1f5f9' }}>{item.name}</span>
      <span style={{ fontSize: 11, color: theme.color.textFaint, marginLeft: 'auto' }}>{item.path}</span>
    </div>
    <div style={{ fontSize: 12.5, color: theme.color.textMuted, lineHeight: 1.8 }}>{item.desc}</div>
    <div style={{ fontSize: 12, color: theme.color.text, lineHeight: 1.9 }}>
      <span style={{ color: theme.color.textFaint }}>使用方式：</span>
      <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {item.usage.map((u, i) => (
          <li key={i}>{u}</li>
        ))}
      </ol>
    </div>
    <Link
      to={item.path}
      style={{ fontSize: 12, color: '#60a5fa', fontWeight: 600, textDecoration: 'none', marginTop: 'auto' }}
    >
      前往 {item.name} →
    </Link>
  </div>
);

export default function FeaturePage() {
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 720 : false,
  );
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div style={{ ...theme.page, position: 'relative' }}>
      <div style={isNarrow ? theme.pageWrapNarrow : theme.pageWrap}>
        <h1 style={{ fontSize: 22, fontWeight: 900, color: '#f1f5f9', margin: '0 0 8px' }}>功能介绍</h1>
        <p style={{ fontSize: 13, color: theme.color.textMuted, margin: '0 0 6px', lineHeight: 1.85 }}>
          平台全部功能的用途说明与使用方式。所有数据仅供学术研究演示，不构成投资建议。
        </p>
        <p style={{ fontSize: 12, color: theme.color.textFaint, margin: '0 0 24px', lineHeight: 1.85 }}>
          快速上手路径建议：<strong style={{ color: theme.color.textMuted }}>选股 → 策略回测 → 研究中心</strong>
          （验证与对比）→ <strong style={{ color: theme.color.textMuted }}>模拟交易</strong>
          （纸上验证）→ <strong style={{ color: theme.color.textMuted }}>Agent 研究</strong>（让 AI 帮你取证）。
        </p>

        {GROUPS.map((g) => (
          <div key={g.group} style={{ marginBottom: 26 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#f1f5f9', margin: '0 0 12px', paddingLeft: 10, borderLeft: `3px solid ${theme.color.primary}` }}>
              {g.group}
            </h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: isNarrow ? '1fr' : 'repeat(auto-fill, minmax(340px, 1fr))',
                gap: 14,
              }}
            >
              {g.items.map((item) => (
                <Card key={item.path} item={item} />
              ))}
            </div>
          </div>
        ))}

        <div
          style={{
            marginTop: 8,
            padding: '13px 16px',
            fontSize: 12,
            lineHeight: 1.85,
            color: theme.color.textFaint,
            backgroundColor: 'rgba(17,24,39,0.5)',
            border: `1px solid ${theme.color.border}`,
            borderRadius: 10,
          }}
        >
          <strong style={{ color: theme.color.textMuted }}>口径与边界：</strong>
          平台所有数字遵循统一口径（分项费率、滑点、复权、PIT 时点数据），详见「研究中心」页脚的方法论卡片。
          行情来自公开接口（主源失败自动回退并显式标注）；财务为 PIT 时点库。所有输出仅供学术研究演示。
        </div>
      </div>
    </div>
  );
}
