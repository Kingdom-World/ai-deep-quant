// ─────────────────────────────────────────────────────────────
// 横截面回测引擎单元测试（评审 P2-5）
//   合成宇宙：A 强势上涨 / B 横盘 / C 下跌——动量因子应持续持有 A
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCrossBacktest, layerAnalysis } = require('../server/crosssect.cjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-'));
process.env.LOCAL_HISTORY_DIR = tmpDir;

function writeStock(code, closes) {
  const rows = closes.map((c, i) => ({
    date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: +(c * 0.999).toFixed(4),
    close: c,
    high: c * 1.01,
    low: c * 0.99,
    volume: 1000,
  }));
  fs.writeFileSync(path.join(tmpDir, `${code}.json`), JSON.stringify({ code, adjust: 'none+factor', rows, factors: [] }));
}

// 90 根：A 10→20（强）、B 恒 10、C 10→5（弱）——满足引擎 ≥80 根的入池门槛
const up = Array.from({ length: 90 }, (_, i) => +(10 + i * (10 / 89)).toFixed(4));
const flat = Array.from({ length: 90 }, () => 10);
const down = Array.from({ length: 90 }, (_, i) => +(10 - i * (5 / 89)).toFixed(4));
writeStock('sh600001', up);
writeStock('sz000002', flat);
writeStock('sh600003', down);

test('动量 top1 应持有强势标的，收益为正', () => {
  const r = runCrossBacktest({ factor: 'mom20', topN: 1, rebalanceEvery: 5, capital: 1_000_000 });
  assert.ok(!r.error, r.error);
  assert.equal(r.universeSize, 3);
  assert.ok(r.totalReturn > 20, `totalReturn=${r.totalReturn}（A 涨约 100%，半仓以上应 >20%）`);
  assert.ok(r.rebalances >= 10);
  assert.ok(r.fills > 0);
  assert.ok(r.totalFees > 0 && r.feeRatePct > 0 && r.feeRatePct < 0.5);
  assert.ok(r.equity.length > 0 && r.equity[r.equity.length - 1].value > 1_000_000);
});

test('top3 等权：结果确定性（两次运行一致）', () => {
  const a = runCrossBacktest({ factor: 'mom60', topN: 3, rebalanceEvery: 10 });
  const b = runCrossBacktest({ factor: 'mom60', topN: 3, rebalanceEvery: 10 });
  assert.equal(a.finalValue, b.finalValue);
  assert.equal(a.fills, b.fills);
  assert.ok(a.totalReturn >= b.totalReturn - 1e-9);
});

test('数据不足返回明确错误', () => {
  process.env.LOCAL_HISTORY_DIR = path.join(tmpDir, 'empty');
  const r = runCrossBacktest({});
  assert.ok(r.error && r.error.includes('本地归档不足'));
  assert.ok(r.error.includes('sync_baostock'), '错误信息应指引同步命令');
  process.env.LOCAL_HISTORY_DIR = tmpDir;
});

// ─────────────────────────────────────────────────────────────
// M2-2.1 / M2-2.2：分层回测（layerAnalysis）与 IC 序列
// ─────────────────────────────────────────────────────────────
//   合成宇宙说明：3 只标的（A 强涨 / B 横盘 / C 下跌）不足以分 5 层，
//   故另建一个 10 只的宇宙，收益与动量**负相关**——这样能同时验证：
//   ① 分层结果单调（Spearman = ±1）
//   ② 方向判定正确（因子值越高收益越低 → mom* 策略未被因子支持）
function buildLayeredUniverse() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-layer-'));
  // 10 只：第 i 只日涨幅递增 i*0.02% —— 前期涨幅越大的，后期收益越高（动量方向为正）
  for (let i = 0; i < 10; i++) {
    const rate = i * 0.0002; // 0, 0.02%, ..., 0.18% 每日
    const closes = Array.from({ length: 120 }, (_, t) => +(100 * (1 + rate) ** t).toFixed(4));
    const rows = closes.map((c, t) => ({
      date: `2026-${String(Math.floor(t / 28) + 1).padStart(2, '0')}-${String((t % 28) + 1).padStart(2, '0')}`,
      open: c,
      close: c,
      high: c,
      low: c,
      volume: 1000,
    }));
    fs.writeFileSync(
      path.join(dir, `sh6001${String(i).padStart(2, '0')}.json`),
      JSON.stringify({ code: `sh6001${String(i).padStart(2, '0')}`, adjust: 'none+factor', rows, factors: [] }),
    );
  }
  return dir;
}

test('layerAnalysis：5 分层返回完整结构', () => {
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = buildLayeredUniverse();
  try {
    const r = layerAnalysis({ factor: 'mom20', layers: 5, rebalanceEvery: 20 });
    assert.ok(!r.error, r.error);
    assert.equal(r.layers.length, 5, '应返回 5 层');
    assert.equal(r.engine, 'crosssect-layer');
    assert.ok(r.range.periods > 0, '应有有效调仓期');
    for (const L of r.layers) {
      assert.ok(Number.isFinite(L.annualizedPct), `第${L.layer}层年化应为数值`);
      assert.ok(Number.isFinite(L.meanPeriodRetPct));
      assert.ok(L.periods > 0);
    }
    // 层号顺序必须是 1..N
    assert.deepEqual(r.layers.map((x) => x.layer), [1, 2, 3, 4, 5]);
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
  }
});

test('layerAnalysis：层标签为因子中性措辞（不写死"最强/最弱"）', () => {
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = buildLayeredUniverse();
  try {
    const r = layerAnalysis({ factor: 'mom20' });
    assert.match(r.layers[0].label, /因子值最高/, '首层应为「因子值最高」');
    assert.match(r.layers[4].label, /因子值最低/, '末层应为「因子值最低」');
    assert.ok(!/最强|最弱/.test(r.layers[0].label), '不应使用只对动量成立的「最强」措辞');
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
  }
});

test('layerAnalysis：构造的单调宇宙应产出 |rho| = 1 且标记 monotonic', () => {
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = buildLayeredUniverse();
  try {
    const r = layerAnalysis({ factor: 'mom20', layers: 5, rebalanceEvery: 20 });
    assert.ok(!r.error, r.error);
    assert.equal(Math.abs(r.mono.spearman), 1, `合成宇宙完全单调，rhos=${r.mono.spearman}`);
    assert.equal(r.mono.monotonic, true);
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
  }
});

test('layerAnalysis：mom* 与 rev* 的因子方向描述一致，但策略对齐结论相反', () => {
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = buildLayeredUniverse();
  try {
    const mom = layerAnalysis({ factor: 'mom20', layers: 5 });
    const rev = layerAnalysis({ factor: 'rev20', layers: 5 });
    // 因子方向是同一批数据的客观属性，两者必须一致
    assert.equal(mom.mono.factorDirection, rev.mono.factorDirection, '因子方向不应随策略口径变化');
    // 但「与策略方向是否一致」必须相反：动量买最强、反转买最弱
    assert.notEqual(mom.mono.strategyAligned, rev.mono.strategyAligned, '两种策略的对齐结论应相反');
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
  }
});

test('layerAnalysis：区间过短返回可读错误而非崩溃', () => {
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = buildLayeredUniverse();
  try {
    const r = layerAnalysis({ factor: 'mom20', startDate: '2026-04-01', endDate: '2026-04-10' });
    assert.ok(r.error && r.error.includes('交易日不足'), `实际：${JSON.stringify(r).slice(0, 120)}`);
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
  }
});

test('layerAnalysis：不计费不计滑点（layerBasis 明示，且与净值回测口径有意分离）', () => {
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = buildLayeredUniverse();
  try {
    const r = layerAnalysis({ factor: 'mom20' });
    assert.match(r.layerBasis, /不计费/, '必须显式声明不计费，否则与净值回测数字会被误当成可比');
    assert.match(r.layerBasis, /不计滑点/);
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
  }
});

test('IC 序列：结构完整且与 statstest 口径同源', () => {
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = buildLayeredUniverse();
  try {
    const r = runCrossBacktest({ factor: 'mom20', topN: 6, rebalanceEvery: 20 });
    assert.ok(!r.error, r.error);
    assert.ok(r.ic, '应返回 ic 字段');
    assert.ok(Array.isArray(r.ic.series));
    assert.ok(r.ic.series.length > 0, '应有 IC 序列');
    for (const s of r.ic.series) {
      assert.ok(typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date));
      assert.ok(s.ic >= -1.000001 && s.ic <= 1.000001, `IC 必在 [−1,1]，实际 ${s.ic}`);
      assert.ok(s.n >= 5, '截面样本应 ≥5');
    }
    // 汇总字段齐全
    for (const k of ['n', 'icMean', 'icStd', 'icir', 'icPositiveRate', 't', 'p', 'se', 'neweyWestLag']) {
      assert.ok(k in r.ic, `缺少汇总字段 ${k}`);
    }
    assert.equal(r.ic.n, r.ic.series.length);
    assert.match(r.ic.basis, /Spearman/, '应声明为 Rank IC 口径');
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
  }
});

test('IC 序列：合成单调宇宙的 IC 恒定——t 统计量应显式标注不可检验', () => {
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = buildLayeredUniverse();
  try {
    const r = runCrossBacktest({ factor: 'mom20', topN: 6, rebalanceEvery: 20 });
    assert.ok(!r.error, r.error);
    // 该宇宙每期 IC 恒为 1（收益严格按动量排序）→ 方差 0 → t 统计量无定义。
    // 关键：这是「不可检验」而非「不显著」，必须由 degraded + degradeReason 明确区分，
    // 否则调用方会把"算不出来"误读成"因子无效"（铁律 #4：降级必须显式）。
    assert.equal(r.ic.icMean, 1, '合成宇宙每期 IC 应为 1');
    assert.equal(r.ic.icStd, 0);
    assert.equal(r.ic.t, null, '零方差下 t 应为 null 而非 0');
    assert.equal(r.ic.icir, null, '零方差下 ICIR 应为 null 而非 Infinity');
    assert.equal(r.ic.degraded, true, '零方差必须标记 degraded');
    assert.match(r.ic.degradeReason, /方差为 0/, `降级原因应说明零方差，实际：${r.ic.degradeReason}`);
    assert.equal(r.ic.significant2, false, '不可检验时不应误报显著');
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
  }
});

test('IC 序列：有波动的序列应给出可检验的 t/p', () => {
  // ⚠️ 本用例需要**真实归档**（合成宇宙的 IC 要么恒定、要么期数不足），
  //   而文件开头已把 LOCAL_HISTORY_DIR 指向合成 tmpDir，故此处必须显式切到真实目录。
  //   原实现写 `process.env.LOCAL_HISTORY_DIR = prev`（prev 即当前值）——
  //   这是自赋值空操作，用例实际仍跑在 tmpDir 上；且若 prev 为 undefined，
  //   Node 会把 env 写成字符串 "undefined"，成为更隐蔽的污染。两处一并修正。
  const realDir = path.join(__dirname, '..', 'data', 'history', 'kline');
  if (!fs.existsSync(realDir)) {
    // 归档缺失时明确跳过，而不是伪装成通过（铁律 #4：降级必须可见）
    console.log(`  [skip] 真实归档不存在（${realDir}），本用例跳过`);
    return;
  }
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = realDir;
  try {
    const r = runCrossBacktest({ factor: 'mom20', topN: 5, rebalanceEvery: 20 });
    assert.ok(!r.error, '真实归档应可用：' + r.error);
    assert.ok(r.ic.n > 20, `真实数据 IC 期数应较多，实际 ${r.ic.n}`);
    assert.ok(Number.isFinite(r.ic.t), `t 应为有限数，实际 ${r.ic.t}`);
    assert.ok(Number.isFinite(r.ic.p) && r.ic.p > 0 && r.ic.p <= 1, `p 应在 (0,1]，实际 ${r.ic.p}`);
    assert.ok(r.ic.neweyWestLag >= 1, 'Newey-West 滞后阶应 ≥1');
    assert.ok(r.ic.icStd > 0, '真实数据 IC 应有波动');
  } finally {
    if (prev === undefined) delete process.env.LOCAL_HISTORY_DIR;
    else process.env.LOCAL_HISTORY_DIR = prev;
  }
});

test('IC 与分层方向自洽：IC>0 时首层（因子最高）收益应高于末层', () => {
  const prev = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = buildLayeredUniverse();
  try {
    const bt = runCrossBacktest({ factor: 'mom20', topN: 6, rebalanceEvery: 20 });
    const la = layerAnalysis({ factor: 'mom20', layers: 5, rebalanceEvery: 20 });
    assert.ok(!bt.error && !la.error);
    if (bt.ic.icMean > 0) {
      // IC 为正 ⇒ 因子值越高收益越高 ⇒ 首层期均 > 末层期均（rho<0）
      assert.ok(la.layers[0].meanPeriodRetPct > la.layers[4].meanPeriodRetPct, 'IC>0 应首层跑赢末层');
      assert.ok(la.mono.spearman < 0, `应 rho<0，实际 ${la.mono.spearman}`);
    } else {
      assert.ok(la.layers[0].meanPeriodRetPct < la.layers[4].meanPeriodRetPct, 'IC<0 应末层跑赢首层');
      assert.ok(la.mono.spearman > 0, `应 rho>0，实际 ${la.mono.spearman}`);
    }
  } finally {
    process.env.LOCAL_HISTORY_DIR = prev;
  }
});
