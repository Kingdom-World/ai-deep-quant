// ─────────────────────────────────────────────────────────────
// 隔离运行时守卫单元测试（升级项 A6）
//   验证目标 M6「跨角色原文泄漏 = 0」由「约定式」升级为「强制式」：
//     · 他人原文长片段进入本角色输入 → 必须被拦截（不静默放行）
//     · 仅「主理人允许中转」的摘要字段（findings 前 2 条）→ 必须放行，不得误伤
//     · 自己角色的原文 → 不参与比对
//   运行：node --test（随 npm test 一起跑）/ 单独：node --test test/isolation-guard.test.cjs
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const {
  isolationGuard,
  findVerbatimOverlap,
  buildIsolationOriginals,
  ISOLATION_MIN_OVERLAP,
} = require('../server/agents/llm_pipeline.cjs');

// 模拟 Alpha 的完整报告（含"允许中转"的前两条 finding 与"禁止外传"的正文）
const ALPHA_FINDINGS = [
  '均线多头排列（MA5 1500.10 > MA20 1480.22 > MA60 1450.33），中期趋势向上',
  'MACD 红柱放大（柱值 0.123），动能增强',
  '趋势健康值 72/100（近20日站上MA20比例 80%）',
];
const ALPHA_REPORT = [
  '## 摘要',
  '技术面偏多，趋势健康值 72/100。',
  '## 核心发现',
  ...ALPHA_FINDINGS.map((f) => `- ${f}`),
  '## 数据快照',
  '- MACD: DIF 0.210 | DEA 0.150 | 柱 0.123',
  '- 样本: 日 K 300 根（2024-01-02 ~ 2026-09-10）',
  '## 局限',
  '- 仅基于日线行情数据，未覆盖盘中 tick 与更高维度量价结构',
].join('\n');

const ALPHA_SEAT = 'Alpha · 技术分析师';
const BULL_SEAT = 'Bull · 多头研究员';

test('findVerbatimOverlap 能定位跨阈值的逐字重合片段', () => {
  const chunk = ALPHA_REPORT.slice(30, 130); // 取原文中 100 字符的连续片段
  const text = `前缀内容。${chunk}后缀内容`;
  const hit = findVerbatimOverlap(text, ALPHA_REPORT);
  assert.ok(hit.length >= ISOLATION_MIN_OVERLAP, `应检出 ≥${ISOLATION_MIN_OVERLAP} 字符重合，实际 ${hit.length}`);
  assert.ok(ALPHA_REPORT.includes(hit), '检出的片段必须逐字来自原文');
});

test('隔离守卫：他人原文长片段必须被拦截（M6 强制式）', () => {
  const leak = `【对手原文（不该出现）】\n${ALPHA_REPORT.slice(0, 200)}`;
  const g = isolationGuard(leak, { selfName: BULL_SEAT, originals: [{ seat: ALPHA_SEAT, report: ALPHA_REPORT }] });
  assert.strictEqual(g.ok, false, '含他人原文长片段时必须判定违规');
  assert.strictEqual(g.violations.length, 1);
  assert.strictEqual(g.violations[0].seat, ALPHA_SEAT);
  assert.ok(g.violations[0].length >= ISOLATION_MIN_OVERLAP);
});

test('隔离守卫：短摘要引述不误伤（避免过度拦截）', () => {
  const relay = '主理人中转摘要：四份调研投票 多头 3 / 空头 1，加权偏多度 0.42。';
  const g = isolationGuard(relay, { selfName: BULL_SEAT, originals: [{ seat: ALPHA_SEAT, report: ALPHA_REPORT }] });
  assert.strictEqual(g.ok, true, '不含长片段时应放行');
});

test('隔离守卫：自己角色的原文不参与比对', () => {
  const g = isolationGuard(ALPHA_REPORT, { selfName: ALPHA_SEAT, originals: [{ seat: ALPHA_SEAT, report: ALPHA_REPORT }] });
  assert.strictEqual(g.ok, true, 'selfName 匹配时不应判定违规');
});

test('buildIsolationOriginals：仅剔除允许中转的 findings 前 2 条，其余正文仍属禁传', () => {
  const originals = buildIsolationOriginals([{ seat: ALPHA_SEAT, report: ALPHA_REPORT, findings: ALPHA_FINDINGS }]);
  assert.strictEqual(originals.length, 1);
  const stripped = originals[0].report;
  // 允许中转的前两条 finding 已从比对基线中剔除
  assert.ok(!stripped.includes(ALPHA_FINDINGS[0]), '允许中转的 finding#1 不应出现在比对基线中');
  assert.ok(!stripped.includes(ALPHA_FINDINGS[1]), '允许中转的 finding#2 不应出现在比对基线中');
  // 禁止外传的正文仍然保留在比对基线中
  assert.ok(stripped.includes('## 数据快照'), '禁止外传的正文必须保留在比对基线中');
  assert.ok(stripped.includes(ALPHA_FINDINGS[2]), '未被中转的 finding#3 必须保留在比对基线中');

  // 合法中转：仅含前两条 finding 的摘要 → 放行
  const relayed = `【主理人中转】\n- ${ALPHA_FINDINGS[0]}\n- ${ALPHA_FINDINGS[1]}`;
  const okGuard = isolationGuard(relayed, { selfName: BULL_SEAT, originals });
  assert.strictEqual(okGuard.ok, true, '合法中转账摘要必须放行');

  // 非法外传：摘要里夹带数据快照全文 → 拦截
  const leaked = `【主理人中转】\n- ${ALPHA_FINDINGS[0]}\n## 数据快照\n- MACD: DIF 0.210 | DEA 0.150 | 柱 0.123\n- 样本: 日 K 300 根（2024-01-02 ~ 2026-09-10）`;
  const badGuard = isolationGuard(leaked, { selfName: BULL_SEAT, originals });
  assert.strictEqual(badGuard.ok, false, '夹带未授权正文时必须拦截');
});
