// ─────────────────────────────────────────────────────────────
// Agent 工具 factor_ic 测试（M2.5）
//
//   本工具的价值全在**语义正确**，而不是"能返回数字"。
//   模型拿到工具结果后会直接用自然语言转述，一旦措辞被曲解，
//   用户就会被误导。故此处逐一锁死三条红线：
//     ① degraded=true 是「不可检验」，不得说成「无效」
//     ② strategyAligned=null 是「方向不可判」，不得说成「方向相反」
//     ③ 表达式非法/恒除零必须显式失败，不得静默给出 0
//
//   需要真实归档；缺失时打印原因跳过（不伪装通过）。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createToolbox } = require('../server/agent/toolbox.cjs');

const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);
const tb = createToolbox({});

test('factor_ic：预置因子返回 IC 统计与分层判定', async () => {
  if (!hasRealArchive) return console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
  const r = await tb.call('factor_ic', { factor: 'mom20' });
  assert.strictEqual(r.ok, true, r.summary);
  assert.ok(r.data.ic.n > 20, `IC 期数应较多，实际 ${r.data.ic.n}`);
  assert.ok(Number.isFinite(r.data.ic.t), 't 应为有限数');
  assert.ok(Number.isFinite(r.data.ic.p) && r.data.ic.p > 0 && r.data.ic.p <= 1);
  assert.ok(r.data.ic.neweyWestLag >= 1, 'Newey-West 滞后应 ≥1');
  assert.strictEqual(r.data.factorKind, 'preset');
  // 摘要必须把关键数字摆出来，供模型据实转述
  assert.match(r.summary, /IC：均值/);
  assert.match(r.summary, /Newey-West/);
});

test('factor_ic 红线①：方向判定按因子族分判，mom 与 rev 结论相反', async () => {
  if (!hasRealArchive) return console.log('  [skip] 真实归档不存在');
  const m = await tb.call('factor_ic', { factor: 'mom20' });
  const v = await tb.call('factor_ic', { factor: 'rev20' });
  assert.strictEqual(m.data.layer.strategyAligned, false, 'mom20 应与策略方向相反');
  assert.strictEqual(v.data.layer.strategyAligned, true, 'rev20 应与策略方向一致');
  // 同一 rho，结论必须相反——这是方向分判存在的全部意义
  assert.strictEqual(m.data.layer.spearman, v.data.layer.spearman);
  assert.match(m.summary, /相反/);
  assert.match(v.summary, /一致/);
});

test('factor_ic 红线②：方向不定必须说「不可判」，不得说「相反」', async () => {
  if (!hasRealArchive) return console.log('  [skip] 真实归档不存在');
  // mom60 - mom20 含减法，语义上是长减短（等价于反转），不可判为动量
  const r = await tb.call('factor_ic', { factor: 'mom60 - mom20' });
  assert.strictEqual(r.ok, true, r.summary);
  assert.strictEqual(r.data.layer.strategyAligned, null, '方向不定时 aligned 必须为 null');
  assert.strictEqual(r.data.layer.directionUncertain, true);
  assert.match(r.summary, /方向不可判/);
  assert.doesNotMatch(r.summary, /方向相反/, '不可把「不可判」写成「相反」——两者含义完全不同');
});

test('factor_ic 红线③：非法表达式显式失败，不静默给数', async () => {
  const r = await tb.call('factor_ic', { factor: 'eval(1)' });
  assert.strictEqual(r.ok, false, '非法表达式必须失败');
  assert.match(r.summary, /表达式解析失败|无法计算/);
  assert.strictEqual(r.data, null, '失败时不得返回数据');
});

test('factor_ic：恒除零表达式同样显式失败（非"因子无效"）', async () => {
  if (!hasRealArchive) return console.log('  [skip] 真实归档不存在');
  // rev60 ≡ −mom60 → mom60 + rev60 ≡ 0 → 恒除零 → 截面全空
  const r = await tb.call('factor_ic', { factor: 'mom20 / (mom60 + rev60)' });
  assert.strictEqual(r.ok, false, '恒除零必须失败，不得返回 0 收益的"成功"');
  assert.match(r.summary, /全为空|恒零分母/);
});

test('factor_ic：自定义表达式可诊断（M3 能力对 Agent 开放）', async () => {
  if (!hasRealArchive) return console.log('  [skip] 真实归档不存在');
  const r = await tb.call('factor_ic', { factor: '-vol20' });
  assert.strictEqual(r.ok, true, r.summary);
  assert.strictEqual(r.data.factorKind, 'expr');
  assert.strictEqual(r.data.factorWindow, 20);
  assert.match(r.summary, /自定义表达式/);
});

test('factor_ic：摘要必须标注分层不计费口径（防模型当净值收益引用）', async () => {
  if (!hasRealArchive) return console.log('  [skip] 真实归档不存在');
  const r = await tb.call('factor_ic', { factor: 'mom20' });
  assert.match(r.summary, /不计费不计滑点/, '必须声明口径，否则模型会把分层收益当净值收益');
});
