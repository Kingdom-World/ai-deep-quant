// ─────────────────────────────────────────────────────────────
// 归档新鲜度披露（2026-10-30）
//
// 这两类断言都要锁住：
//   1. **披露本身**：陈旧票必须被数出来并给出 warning（否则等于没做）
//   2. **不剔除**：陈旧票仍在 universe 里参与计算（universeSize 不减）
//      —— 这是本次刻意的设计约束。若哪天有人"顺手"把陈旧票过滤掉，
//         净值与历史结论就失去可比性，必须让这条断言变红。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crosssect = require('../server/crosssect.cjs');

/** 造一个确定性 universe：dates 为连续字符串，价格为线性（只为让截面可算，不追求可交易） */
function buildUniverse(n, days, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  const dates = Array.from({ length: days }, (_, i) => `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`);
  // ⚠️ 必须落在实际生成的代码序列里（曾写成 sh600099，与 sh6001xx 序列不交集 ⇒ 永远测不到陈旧）
  const staleCode = `sh6001${String(opts.staleIdx ?? 0).padStart(2, '0')}`;
  for (let k = 0; k < n; k++) {
    const code = `sh6001${String(k).padStart(2, '0')}`;
    const isStale = opts.staleLastIndex !== undefined && code === staleCode;
    const useDates = isStale ? dates.slice(0, opts.staleLastIndex + 1) : dates;
    const rows = useDates.map((d, t) => {
      const px = +(50 + k + t * 0.1).toFixed(4);
      return { date: d, open: px, close: px, high: px, low: px, volume: 1000 };
    });
    fs.writeFileSync(
      path.join(dir, `${code}.json`),
      JSON.stringify({ code, adjust: 'none+factor', rows, factors: [] }),
    );
  }
  return { dir, dates, staleCode, total: n };
}

function withUniverse(uni, fn) {
  const prev = process.env.LOCAL_HISTORY_DIR;
  const prevReload = process.env.CROSSSECT_RELOAD;
  process.env.LOCAL_HISTORY_DIR = uni.dir;
  process.env.CROSSSECT_RELOAD = '1';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LOCAL_HISTORY_DIR;
    else process.env.LOCAL_HISTORY_DIR = prev;
    if (prevReload === undefined) delete process.env.CROSSSECT_RELOAD;
    else process.env.CROSSSECT_RELOAD = prevReload;
    fs.rmSync(uni.dir, { recursive: true, force: true });
  }
}

test('computeFreshness：纯函数口径（陈旧/严重/排序/轴外日期）', () => {
  const dates = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
  const last = dates[29];
  const r = (d) => [{ date: d, open: 1, close: 1, high: 1, low: 1, volume: 1 }];

  const f = crosssect.computeFreshness(
    new Map([
      ['a', r(last)],
      ['b', r(last)],
      ['stale', r(dates[22])], // lag 7 > 5
      ['severe', r(dates[3])], // lag 26 > 20
    ]),
    dates,
    last,
  );
  assert.equal(f.staleCount, 2, '落后 >5 交易日的应计 2 只');
  assert.equal(f.severeCount, 1, '落后 >20 交易日的应计 1 只');
  assert.equal(f.staleRatio, 0.5);
  assert.equal(f.worst[0].code, 'severe', '最旧的排在最前');
  assert.equal(f.worst[0].lagDays, 26, '按交易日计，不是自然日');
  assert.match(f.warning, /数据陈旧提示/);
  assert.match(f.warning, /未剔除/, 'warning 必须声明未剔除，避免读者误以为结论已清洗');

  // 全新 ⇒ 不告警
  const fresh = crosssect.computeFreshness(new Map([['a', r(last)]]), dates, last);
  assert.equal(fresh.staleCount, 0);
  assert.equal(fresh.warning, null);

  // 最后日期不在轴上（早于回测起点）⇒ 按整段轴长计为严重陈旧
  const off = crosssect.computeFreshness(new Map([['old', r('2020-01-02')]]), dates, last);
  assert.equal(off.severeCount, 1);
  assert.equal(off.worst[0].lagDays, 30);
});

test('runCrossBacktest：陈旧票被披露，但**不被剔除**（universeSize 不减）', () => {
  const N = 31;
  const DAYS = 160;
  const uni = buildUniverse(N, DAYS, { staleLastIndex: 100 }); // 那只票少 59 天

  withUniverse(uni, () => {
    const r = crosssect.runCrossBacktest({
      factor: 'mom20',
      topN: 20,
      rebalanceEvery: 20,
      capital: 100000,
      endDate: uni.dates[DAYS - 1],
    });
    assert.ok(!r.error, '不应报错：' + r.error);

    // ① 必须披露
    assert.ok(r.dataFreshness, '结果必须带 dataFreshness');
    assert.equal(r.dataFreshness.staleCount, 1, '应识别出 1 只陈旧票');
    assert.equal(r.dataFreshness.worst[0].code, uni.staleCode);
    assert.ok(r.dataFreshness.worst[0].lagDays > 5);
    assert.match(r.dataFreshness.warning, /数据陈旧提示/);

    // ② 不能被"顺手剔除"：陈旧票仍在 universe 里
    assert.equal(r.universeSize, N, '陈旧票不得被剔除，universeSize 必须保持全量');
    assert.equal(r.dataFreshness.universeSize, N);
    assert.equal(r.dataFreshness.staleRatio, +(1 / N).toFixed(4));

    // ③ 原有数值字段仍在（披露是纯新增，不改变既有输出）
    assert.equal(typeof r.totalReturn, 'number');
    assert.equal(typeof r.fills, 'number');
    assert.ok(r.range && r.range.end);
  });
});

test('layerAnalysis：同样带 dataFreshness', () => {
  const N = 20;
  const DAYS = 160;
  const uni = buildUniverse(N, DAYS, { staleLastIndex: 120 });

  withUniverse(uni, () => {
    const ly = crosssect.layerAnalysis({
      factor: 'mom20',
      layers: 5,
      rebalanceEvery: 20,
      endDate: uni.dates[DAYS - 1],
    });
    assert.ok(!ly.error, '不应报错：' + ly.error);
    assert.ok(ly.dataFreshness, '分层结果也必须带 dataFreshness');
    assert.equal(ly.dataFreshness.staleCount, 1);
    assert.match(ly.dataFreshness.warning, /数据陈旧提示/);
  });
});
