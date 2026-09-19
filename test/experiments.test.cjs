// ─────────────────────────────────────────────────────────────
// 实验管理单元测试（v2：equityThumb / rawSymbol / 归一化筛选 / 读取侧防御）
//   ⚠ 重建说明：本文件曾在双 Agent 并行写入冲突中被截断为 0 字节（2026-09-14 01:53），
//   由实现方 B 依据协商记录与既有用例全文重建；重建后覆盖 v2 验收点 A10-A12/A15。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-test-')), 'experiments.jsonl');
process.env.EXPERIMENTS_FILE = tmpFile;
const experiments = require('../server/experiments.cjs');

/** 无 equity 的回测结果（ret 加到 finalValue 上以便断言区分） */
const fakeResult = (symbol, ret = 0) => ({
  symbol,
  strategy: 'ma',
  params: { fast: 5, slow: 20, capital: 100000, slippage: 0.001, limitPct: 10, market: 'CN' },
  range: { start: '2020-01-01', end: '2026-09-11', bars: 1600 },
  finalValue: 100000 + ret,
  totalReturn: ret / 1000,
  annualized: 5,
  maxDrawdownPct: 12.5,
  sharpe: 0.8,
  sortino: 1.1,
  calmar: 0.4,
  tradeCount: 6,
  winRate: 50,
  benchmarkReturn: 30,
  blockedLimitUp: 1,
  blockedLimitDown: 0,
});

/** 带 equity 净值曲线的回测结果：value = 1000+i，finalValue 与末点严格自洽 */
const equityResult = (symbol, bars) => {
  const r = fakeResult(symbol, 0);
  r.finalValue = 1000 + bars - 1;
  r.equity = Array.from({ length: bars }, (_, i) => ({
    date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    value: 1000 + i,
  }));
  return r;
};

const lastLine = () => {
  const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
};

test('record + list：追加读取往返，新在前', () => {
  assert.equal(experiments.record(fakeResult('sh600519', 1000)), true);
  assert.equal(experiments.record(fakeResult('sz300750', 2000)), true);
  const list = experiments.list(10);
  assert.equal(list.length, 2);
  assert.equal(list[0].symbol, 'sz300750', '最新在前');
  assert.equal(list[1].params.slippage, 0.001);
  assert.equal(list[1].metrics.blockedLimitUp, 1);
  assert.ok(list[1].ts);
  assert.equal(list[0].rawSymbol, 'sz300750', 'rawSymbol 保留原始输入');
  assert.equal(list[1].symbol, 'sh600519', 'symbol 已归一化');
});

test('list 过滤：symbol / strategy', () => {
  assert.equal(experiments.list(10, { symbol: 'sh600519' }).length, 1);
  assert.equal(experiments.list(10, { strategy: 'ma' }).length, 2);
  assert.equal(experiments.list(10, { symbol: 'sz999999' }).length, 0);
});

test('record：error 结果与空对象不入库', () => {
  assert.equal(experiments.record({ error: '历史数据不足' }), false);
  assert.equal(experiments.record(null), false);
  assert.equal(experiments.list(10).length, 2);
});

test('损坏行跳过不抛错', () => {
  fs.appendFileSync(tmpFile, '{broken json\n', 'utf8');
  assert.equal(experiments.list(10).length, 2);
});

test('equityThumb 降采样：200 点 → 60 点，首点=原首点，末点=finalValue', () => {
  const r = equityResult('sh600519', 200); // equity 末点 value = 1199 = finalValue
  assert.equal(experiments.record(r), true);
  const rec = lastLine();
  assert.ok(Array.isArray(rec.equityThumb), '应写入 equityThumb');
  assert.equal(rec.equityThumb.length, 60, '恰为 60 点');
  assert.equal(rec.equityThumb[0].d, r.equity[0].date);
  assert.equal(rec.equityThumb[0].v, r.equity[0].value, '首点=原首点');
  assert.equal(rec.equityThumb[59].d, r.equity[199].date);
  assert.equal(rec.equityThumb[59].v, rec.metrics.finalValue, '末点=finalValue（自洽）');
});

test('点数不足 60 时全存（30 点 → 30 点）且末点自洽', () => {
  const r = equityResult('sz000001', 30); // 末点 value = 1029 = finalValue
  assert.equal(experiments.record(r), true);
  const rec = lastLine();
  assert.ok(Array.isArray(rec.equityThumb));
  assert.equal(rec.equityThumb.length, 30, '不足 60 全存');
  assert.equal(rec.equityThumb[0].v, r.equity[0].value);
  assert.equal(rec.equityThumb[29].v, rec.metrics.finalValue, '末点自洽');
});

test('归一化筛选：裸 600519 记录可被 sh600519 搜到（A12）', () => {
  const r = { ...fakeResult('600519', 0) }; // 裸码写入
  assert.equal(experiments.record(r), true);
  const rec = lastLine();
  assert.equal(rec.symbol, 'sh600519', '写入时归一化为腾讯码');
  assert.equal(rec.rawSymbol, '600519', 'rawSymbol 保留裸码');
  const found = experiments.list(50, { symbol: '600519' }); // 裸码筛选也能命中
  assert.equal(found.filter((x) => x.rawSymbol === '600519').length, 1);
});

test('读取侧防御：thumb 长度 >200 或非数组 → list() 忽略该字段（v2 护栏 4）', () => {
  // 防御对象是「存量脏行」：record() 恒产出合法 thumb，须直接向文件追加脏 JSON 绕过写入侧
  const mkDirty = (symbol, thumb) => {
    const base = experiments.toRecord(equityResult(symbol, 30));
    base.equityThumb = thumb;
    fs.appendFileSync(tmpFile, JSON.stringify(base) + '\n', 'utf8');
  };
  mkDirty('sh600001', Array.from({ length: 201 }, (_, i) => ({ d: '2026-01-01', v: i })));
  mkDirty('sh600002', 'dirty');

  const got1 = experiments.list(10, { symbol: 'sh600001' });
  assert.equal(got1.length, 1);
  assert.equal('equityThumb' in got1[0], false, '>200 点的 thumb 应被忽略');
  const got2 = experiments.list(10, { symbol: 'sh600002' });
  assert.equal(got2.length, 1);
  assert.equal('equityThumb' in got2[0], false, '非数组 thumb 应被忽略');
});

test('无 equity 时不写 equityThumb 字段（不写 null）', () => {
  const r = fakeResult('hk00700', 50); // 无 equity
  delete r.equity;
  assert.equal(experiments.record(r), true);
  const rec = lastLine();
  assert.equal(rec.symbol, 'hk00700', 'hk 5位码归一化');
  assert.equal('equityThumb' in rec, false, '不应存在 equityThumb 字段');
  assert.equal(rec.rawSymbol, 'hk00700');
});
