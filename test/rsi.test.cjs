// ─────────────────────────────────────────────────────────────
// RSI 单一实现测试（S6）
//   目的：锁死「Wilder 标准口径」与「唯一实现源」两件事。
//   历史背景：项目曾有 4 套各自为政、且**均非行业标准**的 RSI（均为简单均值），
//     故本测试特别包含一条**防回归**断言——若 Wilder 与简单均值算出相同结果，
//     说明实现被退回旧口径，必须立即失败。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { wilderRsiSeries, wilderRsiLast } = require('../shared/rsi.mjs');
const { rsiSeries } = require('../server/quant.cjs');

/** 确定性伪随机序列（避免测试不稳定） */
function mkSeries(len = 120, seed = 42) {
  const out = [];
  let x = seed;
  for (let i = 0; i < len; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(50 + (x / 2147483648) * 20);
  }
  return out;
}

/** 旧口径（简单均值），仅用于「防回归」对比 */
function smaRsiLast(closes, n = 14) {
  let g = 0;
  let l = 0;
  for (let j = closes.length - n; j < closes.length; j += 1) {
    const d = closes[j] - closes[j - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / n / (l / n));
}

test('单调上涨 → RSI 100；单调下跌 → RSI 0', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const down = Array.from({ length: 40 }, (_, i) => 100 - i);
  assert.equal(wilderRsiLast(up, 14), 100);
  assert.equal(wilderRsiLast(down, 14), 0);
});

test('前 n 位为 null，其余为有效值，长度与输入一致', () => {
  const closes = mkSeries(40);
  const s = wilderRsiSeries(closes, 14);
  assert.equal(s.length, 40);
  assert.ok(s.slice(0, 14).every((x) => x === null), '前 14 位应为 null');
  assert.ok(s.slice(14).every((x) => Number.isFinite(x)), '第 15 位起应有值');
});

test('数据不足时返回全 null / null（不得抛错）', () => {
  assert.ok(wilderRsiSeries([1, 2, 3], 14).every((x) => x === null));
  assert.equal(wilderRsiLast([1, 2, 3], 14), null);
  assert.equal(wilderRsiLast([], 14), null);
});

test('值域必须落在 [0, 100]', () => {
  const s = wilderRsiSeries(mkSeries(300, 7), 14).filter((x) => x !== null);
  assert.ok(s.length > 200);
  assert.ok(s.every((v) => v >= 0 && v <= 100), '出现越界值');
});

test('【防回归】Wilder 与旧「简单均值」口径必须给出不同结果', () => {
  const closes = mkSeries(200, 99);
  const w = wilderRsiLast(closes, 14);
  const s = smaRsiLast(closes, 14);
  assert.ok(
    Math.abs(w - s) > 0.5,
    `Wilder=${w?.toFixed(4)} 与简单均值=${s.toFixed(4)} 过于接近 —— 疑退回旧口径`,
  );
});

test('【单一实现】quant.cjs 的 rsiSeries 必须就是 shared 的实现（引用相等）', () => {
  assert.equal(rsiSeries, wilderRsiSeries, 'quant.cjs 应直接复用 shared/rsi.mjs 而非自带一份');
});
