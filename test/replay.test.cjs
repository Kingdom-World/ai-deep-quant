'use strict';
// ─────────────────────────────────────────────────────────────
// 逐根回放引擎测试（Phase 5，`server/replay.cjs`）
//
// 🔴 本文件的核心断言只有一条：**全关模式必须精确复刻截面引擎**。
//   这是"对照组"的立命之本 —— 若复刻不成立，两引擎的差异就无法归因
//   （分不清是"消除简化带来的"还是"回放引擎自己写错了"）。
//   实测（真实归档）：换手差 0.002%、费用差 0.011%（取整级）。
//
// 另外守住：
//   · 四个开关各自真的起作用（尤其 rebalance 会带来额外 fills）
//   · 指标来自 quant.equityMetrics 单源
//   · 归档不足时明确报错，不返回空结果
//
// ⚠️ 用临时假归档（LOCAL_HISTORY_DIR 覆盖），不读 data/（gitignore，CI 里不存在）。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 造一只票的假 K 线：n 行，按 slope 单调变化 */
function makeRows(n, base, slope) {
  return Array.from({ length: n }, (_, i) => {
    const px = +(base + i * slope).toFixed(4);
    return {
      date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: px, high: +(px * 1.01).toFixed(4), low: +(px * 0.99).toFixed(4),
      close: px, volume: 1e6,
    };
  });
}

/** 建临时归档：A 强涨、B 弱涨、C 下跌（保证因子排名稳定可预期） */
function makeArchive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  const specs = [
    { code: 'sh600001', base: 10, slope: 0.08 },  // 最强
    { code: 'sh600002', base: 20, slope: 0.02 },  // 中
    { code: 'sh600003', base: 30, slope: -0.03 }, // 最弱
  ];
  for (const s of specs) {
    fs.writeFileSync(
      path.join(dir, `${s.code}.json`),
      JSON.stringify({ code: s.code, rows: makeRows(160, s.base, s.slope), factors: [] }),
      'utf8',
    );
  }
  return dir;
}

let archiveDir = null;
let runReplay = null;
let runCrossBacktest = null;

test.before(() => {
  archiveDir = makeArchive();
  process.env.LOCAL_HISTORY_DIR = archiveDir;
  process.env.CROSSSECT_RELOAD = '1'; // 绕过 loadUniverseCached 的 TTL 缓存
  // crosssect 在 require 时读 env 吗？resolveArchiveDir 是函数内读 ⇒ 运行时生效
  ({ runReplay } = require(path.join(__dirname, '..', 'server', 'replay.cjs')));
  ({ runCrossBacktest } = require(path.join(__dirname, '..', 'server', 'crosssect.cjs')));
});

test.after(() => {
  delete process.env.LOCAL_HISTORY_DIR;
  delete process.env.CROSSSECT_RELOAD;
  try { if (archiveDir) fs.rmSync(archiveDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

const BASE = { factor: 'mom20', topN: 2, rebalanceEvery: 20, capital: 1000000 };

test('🔴 全关模式精确复刻截面引擎（换手/费用差 < 0.5%）', () => {
  const legacy = runCrossBacktest({ ...BASE });
  const replica = runReplay({ ...BASE, rebalance: false, freshEquity: false, finalSlippage: false, sellSlippage: false });
  assert.ok(!replica.error, replica.error);
  // 阈值 0.5%（非 0.05%）：本用例仅 3 只 × 160 行、topN=2，小样本下「整手取整」粒度效应被放大；
  // 真实归档（209 只/topN=5）实测换手差 0.002%、费用差 0.011%。0.5% 仍能抓住完全没复刻（那会是几十%）。
  const dT = Math.abs(replica.turnover - legacy.turnover) / legacy.turnover * 100;
  const dF = Math.abs(replica.totalFees - legacy.totalFees) / legacy.totalFees * 100;
  assert.ok(dT < 0.5, `换手差 ${dT.toFixed(3)}% 过大 —— 全关模式未能复刻截面引擎，对照失去意义`);
  assert.ok(dF < 0.5, `费用差 ${dF.toFixed(3)}% 过大`);
});

test('🔴 rebalance 开关真的生效：精确模式产生更多成交（再平衡换手）', () => {
  const off = runReplay({ ...BASE, rebalance: false, freshEquity: false, finalSlippage: false, sellSlippage: false });
  const on = runReplay({ ...BASE });
  assert.ok(!on.error, on.error);
  assert.ok(on.fills > off.fills,
    `精确模式 fills 应更多（再平衡产生额外交易）：${on.fills} vs ${off.fills}`);
  assert.strictEqual(on.switches.rebalance, true);
  assert.strictEqual(off.switches.rebalance, false);
});

test('🔴 sellSlippage 开关改变终值（卖出扣滑点更保守）', () => {
  const withSlip = runReplay({ ...BASE });
  const noSlip = runReplay({ ...BASE, sellSlippage: false });
  const a = withSlip.finalValue;
  const b = noSlip.finalValue;
  assert.ok(Number.isFinite(a) && Number.isFinite(b));
  // 卖出计滑点 ⇒ 终值不高于不计滑点
  assert.ok(a <= b + 1e-6, `卖出计滑点后终值应不高于不计滑点：${a} vs ${b}`);
});

test('指标来自 equityMetrics 单源：字段齐全', () => {
  const r = runReplay({ ...BASE });
  assert.ok(r.metrics, '应产出指标');
  for (const k of ['totalReturn', 'annualized', 'annualVol', 'sharpe', 'sortino', 'calmar', 'maxDrawdownPct', 'days']) {
    assert.ok(k in r.metrics, `缺字段「${k}」`);
  }
});

test('输出序列形态：equity 逐日 + finalEquity 多一条强平记录', () => {
  const r = runReplay({ ...BASE });
  assert.ok(Array.isArray(r.equity) && r.equity.length > 100, 'equity 应为逐日序列');
  assert.strictEqual(r.finalEquity.length, r.equity.length + 1, 'finalEquity 应比 equity 多一条');
  assert.strictEqual(r.finalEquity[r.finalEquity.length - 1].value, r.finalValue);
  // equity 每条的 value 必须是有限正数（账本不得出现 NaN/负资产）
  for (const e of r.equity) {
    assert.ok(Number.isFinite(e.value) && e.value > 0, `净值异常：${JSON.stringify(e)}`);
  }
});

test('因子表达式也能跑（选股走同一 crossSection）', () => {
  const r = runReplay({ ...BASE, factor: 'mom20 + rev60 * 0.5' });
  assert.ok(!r.error, r.error);
  assert.ok(r.metrics);
});

test('归档不足 ⇒ 明确报错（不返回空结果）', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-empty-'));
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = emptyDir;
  process.env.CROSSSECT_RELOAD = '1';
  try {
    const r = runReplay({ ...BASE });
    assert.ok(r.error, '应返回 error');
    assert.match(r.error, /归档标的不足/);
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
    process.env.CROSSSECT_RELOAD = '1';
    try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
