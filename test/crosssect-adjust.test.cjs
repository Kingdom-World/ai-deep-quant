// ─────────────────────────────────────────────────────────────
// 横截面引擎 · 复权口径与涨跌停守卫测试（S5 验收 A5 / A6 / A11）
//   1) 除权日不得产生假动量（不复权价腰斩 ≠ 动量最差）
//   2) 开盘涨停不得被买入（涨跌停守卫）
//   3) 无复权因子的标的须在 priceBasis 中被如实计数
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCrossBacktest } = require('../server/crosssect.cjs');

const D = (i) =>
  `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;

function makeDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.LOCAL_HISTORY_DIR = d;
  return d;
}

function writeStock(dir, code, rows, factors = []) {
  fs.writeFileSync(
    path.join(dir, `${code}.json`),
    JSON.stringify({ code, adjust: 'none+factor', rows, factors }),
  );
}

test('【A5】除权日不再产生假动量：复权后强势的标的应被选中', () => {
  const dir = makeDir('crossadj-a-');

  // AUTO：第 45 根起「10 送 10」——不复权价由 20 跳到 11（-45%），但复权后是持续上涨的
  const auto = [];
  for (let i = 0; i < 90; i++) {
    const c = i >= 45 ? +(11 + (i - 45) * 0.1).toFixed(4) : 20;
    auto.push({ date: D(i), open: +(c * 0.999).toFixed(4), close: c, high: +(c * 1.01).toFixed(4), low: +(c * 0.99).toFixed(4), volume: 1000 });
  }
  // 因子：前复权型——除权前乘 0.5（使序列连续），除权后为 1
  writeStock(dir, 'sh600001', auto, [
    { date: D(0), fore: 0.5, back: 2 },
    { date: D(45), fore: 1, back: 1 },
  ]);

  // SLOW：全程横盘 10，无因子
  const slow = Array.from({ length: 90 }, (_, i) => ({
    date: D(i), open: 9.99, close: 10, high: 10.1, low: 9.9, volume: 1000,
  }));
  writeStock(dir, 'sh600002', slow, []);

  const r = runCrossBacktest({ factor: 'mom20', topN: 1, rebalanceEvery: 5, capital: 1_000_000 });
  assert.ok(!r.error, r.error);
  // 复权价：除权前 20×0.5=10 → 除权后 11~15.4，动量显著为正，应压过横盘的 SLOW
  // 若引擎改用不复权动量，AUTO 会被判为 -45% 而落选，收益将接近 0
  assert.ok(
    r.totalReturn > 5,
    `totalReturn=${r.totalReturn}（复权口径下应显著为正；不复权口径会落选，收益≈0）`,
  );
});

test('【A6】开盘涨停的标的不得被买入（涨跌停守卫）', () => {
  const dir = makeDir('crossadj-b-');

  // STRONG：动量最强，但每次开盘价都等于前收×1.1（开盘即涨停）
  const strong = [];
  let prev = 10;
  for (let i = 0; i < 90; i++) {
    const open = i === 0 ? 10 : +(prev * 1.1).toFixed(2);
    const close = +(prev * 1.02).toFixed(2);
    strong.push({
      date: D(i), open, close,
      high: Math.max(open, close), low: +(Math.min(open, close) * 0.99).toFixed(4), volume: 1000,
    });
    prev = close;
  }
  writeStock(dir, 'sh600001', strong, []);

  const flat = Array.from({ length: 90 }, (_, i) => ({
    date: D(i), open: 9.99, close: 10, high: 10.1, low: 9.9, volume: 1000,
  }));
  writeStock(dir, 'sh600002', flat, []);

  const r = runCrossBacktest({ factor: 'mom20', topN: 2, rebalanceEvery: 5, capital: 1_000_000 });
  assert.ok(!r.error, r.error);
  assert.ok(
    r.blockedLimitUp > 0,
    `blockedLimitUp=${r.blockedLimitUp}（开盘价 ≥ 前收×1.1 应被 limitPrices 拦下）`,
  );
});

test('【A6-反向】正常行情下涨跌停守卫不得误伤', () => {
  const dir = makeDir('crossadj-b2-');
  for (const [code, drift] of [['sh600001', 0.1], ['sh600002', -0.05]]) {
    const rows = Array.from({ length: 90 }, (_, i) => {
      const c = +(10 + i * drift).toFixed(4);
      return { date: D(i), open: +(c * 0.999).toFixed(4), close: c, high: +(c * 1.005).toFixed(4), low: +(c * 0.995).toFixed(4), volume: 1000 };
    });
    writeStock(dir, code, rows, []);
  }
  const r = runCrossBacktest({ factor: 'mom20', topN: 1, rebalanceEvery: 5, capital: 1_000_000 });
  assert.ok(!r.error, r.error);
  assert.equal(r.blockedLimitUp, 0, '平稳行情不应触发涨停守卫');
  assert.equal(r.blockedLimitDown, 0, '平稳行情不应触发跌停守卫');
  assert.ok(r.fills > 0, '应正常成交');
});

test('【A11】无复权因子的标的须在 priceBasis 中如实计数并自述口径', () => {
  const dir = makeDir('crossadj-c-');
  for (let k = 0; k < 3; k++) {
    const rows = Array.from({ length: 90 }, (_, i) => ({
      date: D(i), open: 9.99, close: +(10 + i * 0.01).toFixed(4), high: 10.2, low: 9.8, volume: 1000,
    }));
    writeStock(dir, `sh60000${k + 1}`, rows, []);
  }
  const r = runCrossBacktest({ factor: 'mom20', topN: 1, rebalanceEvery: 10 });
  assert.ok(!r.error, r.error);
  assert.equal(r.priceBasis.universeWithAdjFallback, 3, '无因子标的三只都应被计入回退数');
  assert.equal(r.priceBasis.momentum, 'qfq(fore)', '动量口径须自述为前复权');
  assert.equal(r.priceBasis.execution, 'qfq(fore)', '成交与估值须与动量同口径（三者统一才自洽）');
  assert.equal(r.priceBasis.limitGuard, 'raw', '涨跌停判定须自述为不复权真实价');
});

test('【S3-基准】等权买入持有基准应正确反映全池平均', () => {
  const dir = makeDir('crossadj-d-');
  // A：10 → 20（+100%）；B：恒 10（0%）
  for (const [code, end] of [
    ['sh600001', 20],
    ['sh600002', 10],
  ]) {
    const rows = Array.from({ length: 90 }, (_, i) => {
      const c = +(10 + ((end - 10) * i) / 89).toFixed(6);
      return { date: D(i), open: c, close: c, high: c, low: c, volume: 1000 };
    });
    writeStock(dir, code, rows, []);
  }
  const r = runCrossBacktest({ factor: 'mom20', topN: 1, rebalanceEvery: 20, capital: 1_000_000 });
  assert.ok(!r.error, r.error);
  assert.equal(r.benchmarkUniverse, 2, '两只标的都应进入基准池');

  // 起点为 dates[21]：A 价 = 10 + 10×21/89 = 12.3596，末价 20 → ratio 1.6182；B ratio 1
  // 基准收益 = (1.6182 + 1) / 2 − 1 = 30.91%
  const expected = (20 / (10 + (10 * 21) / 89) + 1) / 2 - 1;
  assert.ok(
    Math.abs(r.benchmarkReturn - expected * 100) < 0.5,
    `benchmarkReturn=${r.benchmarkReturn}，期望≈${(expected * 100).toFixed(2)}`,
  );

  const lastB = r.benchmark[r.benchmark.length - 1].value;
  assert.ok(
    Math.abs(lastB - 1_000_000 * (1 + r.benchmarkReturn / 100)) < 150,
    `基准末点 ${lastB} 应与 benchmarkReturn 自洽`,
  );
});

test('【因子族】反转因子应买最弱标的，方向与动量相反', () => {
  const dir = makeDir('crossadj-e-');
  // A：10 → 20（强）；B：10 → 5（弱）
  for (const [code, end] of [
    ['sh600001', 20],
    ['sh600002', 5],
  ]) {
    const rows = Array.from({ length: 90 }, (_, i) => {
      const c = +(10 + ((end - 10) * i) / 89).toFixed(6);
      return { date: D(i), open: c, close: c, high: c, low: c, volume: 1000 };
    });
    writeStock(dir, code, rows, []);
  }
  const opts = { topN: 1, rebalanceEvery: 20, capital: 1_000_000 };
  const mom = runCrossBacktest({ ...opts, factor: 'mom20' });
  const rev = runCrossBacktest({ ...opts, factor: 'rev20' });
  assert.ok(!mom.error && !rev.error);
  assert.ok(mom.totalReturn > 0, `动量应选中上涨的 A，totalReturn=${mom.totalReturn}`);
  assert.ok(rev.totalReturn < 0, `反转应选中下跌的 B，totalReturn=${rev.totalReturn}`);
  assert.equal(mom.benchmarkReturn, rev.benchmarkReturn, '同窗口因子区间相同，基准应一致');
});
