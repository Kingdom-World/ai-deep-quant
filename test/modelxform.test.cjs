// ─────────────────────────────────────────────────────────────
// 截面预处理算子测试（Phase 1 模型工坊）
//   重点：① 每个算子的取数规则逐位固定（口径不许含糊）；
//         ② 缺失值透传不参与统计；③ 不改写入参；
//         ④ 与规范白名单的一致性锁。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');

const xf = require('../server/modelxform.cjs');
const ms = require('../shared/modelspec.cjs');

const rows = (...vals) => vals.map((v, i) => ({ code: `s${i + 1}`, mom: v }));
const vals = (out) => out.map((r) => r.mom);

test('锁：SUPPORTED 与 modelspec.TRANSFORM_TYPES 完全一致', () => {
  assert.deepStrictEqual([...xf.SUPPORTED].sort(), Object.keys(ms.TRANSFORM_TYPES).sort());
});

test('zscore：均值→0、样本标准差→1（n−1 口径）', () => {
  const out = xf.zscore(rows(1, 2, 3, 4, 5));
  const v = vals(out);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  assert.ok(Math.abs(mean) < 1e-9, `均值应为 0，实际 ${mean}`);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
  assert.ok(Math.abs(sd - 1) < 1e-9, `样本标准差应为 1，实际 ${sd}`);
});

test('zscore：std=0 时全部置 0（不产生 Infinity/NaN）', () => {
  const out = xf.zscore(rows(7, 7, 7));
  assert.deepStrictEqual(vals(out), [0, 0, 0]);
});

test('zscore：缺失值透传，不参与统计（且分母为 n−1 样本标准差）', () => {
  const out = xf.zscore(rows(1, null, 3));
  assert.strictEqual(out[1].mom, null, '缺失值应保持缺失');
  // 仅用 {1,3} 计算：mean=2；样本标准差 = √(((1−2)²+(3−2)²)/(2−1)) = √2
  const mean = 2;
  const sd = Math.sqrt(2);
  assert.ok(Math.abs(out[0].mom - (1 - mean) / sd) < 1e-9, `实际 ${out[0].mom}`);
  assert.ok(Math.abs(out[2].mom - (3 - mean) / sd) < 1e-9, `实际 ${out[2].mom}`);
});

test('rank：最小 0、最大 1、单调不减', () => {
  const out = vals(xf.rank(rows(30, 10, 20)));
  assert.strictEqual(out[1], 0); // 10 最小
  assert.strictEqual(out[0], 1); // 30 最大
  assert.ok(out[2] > out[1] && out[2] < out[0]);
});

test('rank：并列取平均秩（与 Spearman 并列口径一致）', () => {
  // 值 5,5,7 → 秩应为 0.5/3? 平均秩=(0+1)/2=0.5 → 0.5/2=0.25
  const out = vals(xf.rank(rows(5, 5, 7)));
  assert.strictEqual(out[0], out[1], '并列应同秩');
  assert.ok(Math.abs(out[0] - 0.25) < 1e-9, `实际 ${out[0]}`);
  assert.strictEqual(out[2], 1);
});

test('winsorize(pct)：按双侧分位截断', () => {
  // n=40 → 每侧 20% 分位。值 0..9，20% 分位 = 1.8，80% 分位 = 7.2
  const out = vals(xf.winsorize(rows(0, 1, 2, 3, 4, 5, 6, 7, 8, 9), { method: 'pct', n: 40 }));
  assert.strictEqual(out[0], 1.8, `下界应截到 20% 分位，实际 ${out[0]}`);
  assert.strictEqual(out[9], 7.2, `上界应截到 80% 分位，实际 ${out[9]}`);
  assert.strictEqual(out[5], 5, '中间值不应被改动');
});

test('winsorize(mad)：以 median ± n×1.4826×MAD 截断（期望值由定义式推导）', () => {
  const src = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
  // 定义式逐步推导（偶数个数的中位数取中间两数均值，这是易错点，故在测试里显式写出）
  const med = (5 + 6) / 2; // 5.5
  const devs = src.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = (devs[4] + devs[5]) / 2; // 2.5
  const hi = med + 3 * 1.4826 * mad; // 5.5 + 11.1195 = 16.6195
  const lo = med - 3 * 1.4826 * mad;

  const out = vals(xf.winsorize(rows(...src), { method: 'mad', n: 3 }));
  assert.ok(Math.abs(out[9] - hi) < 1e-9, `极端值应截到 ${hi}，实际 ${out[9]}`);
  assert.strictEqual(out[0], 1, '未越界值不应被改动');
  assert.ok(lo < 1, '本例下界低于最小值，不应发生下侧截断');
});

test('winsorize(mad)：n 越大界越宽（单调性自检）', () => {
  const src = rows(1, 2, 3, 4, 5, 6, 7, 8, 9, 100);
  const a = vals(xf.winsorize(src, { method: 'mad', n: 1 }))[9];
  const b = vals(xf.winsorize(src, { method: 'mad', n: 3 }))[9];
  assert.ok(a < b, `n=1 的界(${a}) 应窄于 n=3 的界(${b})`);
});

test('winsorize(mad)：MAD=0（大量相同值）时不做截断，避免压平整段', () => {
  const src = rows(5, 5, 5, 5, 5);
  const out = xf.winsorize(src, { method: 'mad', n: 3 });
  assert.deepStrictEqual(vals(out), [5, 5, 5, 5, 5]);
});

test('fill_missing：以截面非缺失均值填充；全缺失时保持缺失', () => {
  const out = xf.fillMissing(rows(2, null, 4));
  assert.strictEqual(out[1].mom, 3);
  const allNull = xf.fillMissing(rows(null, null));
  assert.deepStrictEqual(vals(allNull), [null, null], '全缺失时不得凭空造数');
});

test('applyTransforms：按声明顺序生效（顺序即语义）', () => {
  const src = rows(1, 2, 3, 100);
  const a = xf.applyTransforms(src, [{ type: 'winsorize', args: { method: 'mad', n: 3 } }, { type: 'zscore' }]);
  const b = xf.applyTransforms(src, [{ type: 'zscore' }, { type: 'winsorize', args: { method: 'mad', n: 3 } }]);
  assert.notDeepStrictEqual(vals(a), vals(b), '不同顺序应产生不同结果');
});

test('applyTransforms：不改写入参（纯函数）', () => {
  const src = rows(1, 2, 3);
  const snapshot = JSON.stringify(src);
  xf.applyTransforms(src, [{ type: 'zscore' }, { type: 'rank' }]);
  assert.strictEqual(JSON.stringify(src), snapshot, '入参不应被修改');
});

test('applyTransforms：未知算子显式抛错（不静默跳过）', () => {
  assert.throws(() => xf.applyTransforms(rows(1, 2), [{ type: 'pca' }]), /未知预处理算子/);
});

test('applyTransforms：空流水线原样返回（仍为新数组）', () => {
  const src = rows(1, 2);
  const out = xf.applyTransforms(src, []);
  assert.deepStrictEqual(out, src);
  assert.notStrictEqual(out, src);
});
