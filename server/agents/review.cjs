// ─────────────────────────────────────────────────────────────
// AI 盘后复盘生成器
//   · 输入：大盘指数 + 行业/概念板块资金流（由调用方注入）
//   · 输出：结构化文字复盘报告
// ─────────────────────────────────────────────────────────────

function generate({ indices, sectorFlow, conceptFlow }) {
  const fmt = (v) => (Number.isFinite(v) ? (v / 1e8).toFixed(1) + ' 亿' : '--');
  const lines = [
    '📊 AI 盘后复盘（程序化生成）',
    '',
    '一、大盘概况',
    ...(indices ?? []).map((d) => `  · ${d.name}: ${d.price}（${d.chg >= 0 ? '+' : ''}${d.chg}%）`),
    '',
    '二、行业主力资金',
    sectorFlow
      ? `  净流入前3：${sectorFlow.inflow.slice(0, 3).map((x) => `${x.name} +${fmt(x.mainNet)}`).join('、')}`
      : '  数据暂不可用',
    sectorFlow
      ? `  净流出前3：${sectorFlow.outflow.slice(0, 3).map((x) => `${x.name} ${fmt(x.mainNet)}`).join('、')}`
      : '',
    '',
    '三、概念热点',
    conceptFlow
      ? `  净流入前3：${conceptFlow.inflow.slice(0, 3).map((x) => `${x.name} +${fmt(x.mainNet)}`).join('、')}`
      : '',
    '',
    '四、Agent 团队视角',
    '  基于以上数据，四名分析师（技术/基本面/公告/情绪）可分别出具报告，',
    '  多空辩论后给出方向判断。详见 Agent 团队页面。',
    '',
    '⚠️ 本复盘由程序化规则引擎自动生成，属学术研究演示，不构成任何投资建议。',
  ];
  return lines.join('\n');
}

module.exports = { generate };
