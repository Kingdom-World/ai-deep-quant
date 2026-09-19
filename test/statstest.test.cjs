// ─────────────────────────────────────────────────────────────
// 统计检验单测（M2 · 2.3）
//
//   设计原则：**用可手算 / 已发表的黄金值锁死**，而不是"跑一遍看结果没报错"。
//   否则实现改了、测试跟着改，检查就失效了。
//
//   黄金值来源：
//     ① Newey-West：用 R 的 sandwich::NeweyWest 与 statsmodels cov_hac 的
//        公开示例序列（手工可复核的短序列）；
//     ② 经验滞后阶数公式 L = floor(4(T/100)^(2/9))：可手算；
//     ③ Spearman：小样本可手算秩。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const st = require('../server/statstest.cjs');

// ─────────── 基础统计量 ───────────

test('mean / variance / std：基础正确性', () => {
  assert.strictEqual(st.mean([1, 2, 3, 4, 5]), 3);
  assert.strictEqual(st.variance([1, 2, 3, 4, 5]), 2.5); // 无偏（n−1 分母）
  assert.strictEqual(+st.std([1, 2, 3, 4, 5]).toFixed(6), +Math.sqrt(2.5).toFixed(6));
});

test('mean：空数组返 NaN；单元素方差 NaN（n<2）', () => {
  assert.ok(Number.isNaN(st.mean([])));
  assert.ok(Number.isNaN(st.variance([5])));
});

// ─────────── Newey-West 滞后阶数（可手算） ───────────

test('neweyWestLag：手算校验 L = floor(4 × (T/100)^(2/9))', () => {
  // T=100 → (1)^(2/9)=1 → 4 → floor=4
  assert.strictEqual(st.neweyWestLag(100), 4);
  // T=10  → (0.1)^(2/9) ≈ 0.59949 → 4×0.59949 ≈ 2.3979 → 2
  assert.strictEqual(st.neweyWestLag(10), 2);
  // T=1000 → 10^(2/9) ≈ 1.66810 → 6.6724 → 6
  assert.strictEqual(st.neweyWestLag(1000), 6);
  // T=1 → (0.01)^(2/9) ≈ 0.35938 → 1.4375 → 1
  assert.strictEqual(st.neweyWestLag(1), 1);
  // 非正 / 非法 → 0
  assert.strictEqual(st.neweyWestLag(0), 0);
  assert.strictEqual(st.neweyWestLag(-5), 0);
  assert.strictEqual(st.neweyWestLag(NaN), 0);
});

// ─────────── Newey-West HAC 标准误 ───────────

test('seNeweyWest：L=0 必须退化为 iid 标准误（自洽性关键检查）', () => {
  const xs = [0.5, -0.3, 0.8, -0.1, 0.4, -0.6, 0.2, 0.9, -0.2, 0.3];
  const nw = st.seNeweyWest(xs, 0); // 强制 L=0
  const iid = st.seIid(xs);
  assert.ok(Math.abs(nw.se - iid) < 1e-12, `L=0 应等于 iid：NW=${nw.se} iid=${iid}`);
  assert.strictEqual(nw.lag, 0);
  assert.strictEqual(nw.degenerate, false);
});

test('seNeweyWest：正自相关序列的 HAC 标准误应大于 iid', () => {
  // ⚠️ 构造要点：必须是**正**自相关。曾用 v = 0.8v ± 0.1 的交替驱动，
  //    结果产生了振荡（负自相关），NW < iid 是正确行为，却让测试误判为失败。
  //    这里改用同号冲击的 AR(1)：x_t = 0.85·x_{t−1} + ε_t，ε 同号段推进。
  const xs = [];
  let v = 0;
  for (let i = 0; i < 80; i++) {
    const eps = Math.sin(i / 7) > 0 ? 0.1 : -0.1; // 缓慢变号 → 段内同号，形成正自相关
    v = 0.85 * v + eps;
    xs.push(v);
  }
  const nw = st.seNeweyWest(xs);
  const iid = st.seIid(xs);
  assert.ok(nw.se > iid, `正自相关时 NW 标准误应更大：NW=${nw.se.toFixed(6)} iid=${iid.toFixed(6)}`);
  assert.strictEqual(nw.degenerate, false, '正自相关序列不应触发 HAC 退化');
});

test('seNeweyWest：负自相关序列的 HAC 标准误应小于 iid', () => {
  // 交替正负 → 强负自相关
  const xs = [];
  for (let i = 0; i < 60; i++) xs.push(i % 2 === 0 ? 1 + (i % 7) * 0.01 : -1 - (i % 5) * 0.01);
  const nw = st.seNeweyWest(xs);
  const iid = st.seIid(xs);
  assert.ok(nw.se < iid, `负自相关时 NW 标准误应更小：NW=${nw.se.toFixed(6)} iid=${iid.toFixed(6)}`);
});

test('seNeweyWest：黄金值（短序列手算可复核）', () => {
  // 序列 x = [1,2,3,4,5]，T=5
  //   L = floor(4×(0.05)^(2/9))
  //     (0.05)^(2/9) = e^(ln0.05 × 2/9) = e^(-2.99573×0.22222) = e^(-0.66572) ≈ 0.51394
  //     4 × 0.51394 ≈ 2.05576 → L = 2
  const xs = [1, 2, 3, 4, 5];
  assert.strictEqual(st.neweyWestLag(5), 2, 'L 应为 2');

  // 手算（无偏分母 T−1=4，与 seIid 同源）：
  //   x̄=3，dev=[-2,-1,0,1,2]
  //   γ0 = (4+1+0+1+4)/(5−1) = 10/4 = 2.5        ← 无偏，故 L=0 时 w=g0/T=variance/T=seIid²
  //   γ1 = ((-1)(-2)+(0)(-1)+(1)(0)+(2)(1))/4 = (2+0+0+2)/4 = 1
  //   γ2 = ((0)(-2)+(1)(-1)+(2)(0))/4 = (−1)/4 = −0.25
  // 核权重 Bartlett: k_l = 1 − l/(L+1)；贡献含 T/(T−l) 小样本因子
  //   l=1: k=2/3, contrib = 2×(2/3)×(1/5)×(5/4) = 0.3333333
  //   l=2: k=1/3, contrib = 2×(1/3)×(−0.25/5)×(5/3) = −0.0555556
  //   w = 2.5/5 + 0.3333333 − 0.0555556 = 0.5 + 0.2777778 = 0.7777778
  //   SE = √0.7777778 ≈ 0.8819171
  const nw = st.seNeweyWest(xs);
  assert.strictEqual(nw.lag, 2);
  assert.ok(Math.abs(nw.weightSum - 0.7777778) < 1e-6, `weightSum 期望 0.7777778，实得 ${nw.weightSum}`);
  assert.ok(Math.abs(nw.se - 0.8819171) < 1e-6, `SE 期望 0.8819171，实得 ${nw.se}`);
});

test('seNeweyWest：HAC 方差非正定时必须显式降级（不得返回 NaN/undefined）', () => {
  // 强趋势序列会让 HAC 方差变负——这是 Newey-West 的已知局限（未做正定修正）。
  // 要求：不得静默返回 NaN/undefined，必须退化为 iid 并置 degenerate 标记
  //       （符合项目铁律「降级必须显式」，与知识条目 method-silent-fallback 一致）。
  const trend = [];
  for (let i = 0; i < 60; i++) trend.push(i * 0.1);
  const nw = st.seNeweyWest(trend);
  assert.ok(Number.isFinite(nw.se), `必须返回有限 SE，实得 ${nw.se}`);
  assert.ok(nw.se > 0, 'SE 必须为正');
  if (nw.degenerate) {
    // 降级时必须与 iid 一致，且可通过 tTestMean 让调用方看到原因
    assert.ok(Math.abs(nw.se - st.seIid(trend)) < 1e-12, '降级后应等于 iid 标准误');
    const tt = st.tTestMean(trend);
    assert.strictEqual(tt.degraded, true);
    assert.match(tt.degradeReason, /HAC 方差非正定/);
  }
});

// ─────────── t 检验 ───────────

test('tTestMean：iid 对照口径（hac:false）', () => {
  const xs = [0.1, 0.2, 0.3, 0.4, 0.5];
  const r = st.tTestMean(xs, { hac: false });
  // x̄=0.3，s=√0.025≈0.1581139，SE=s/√5≈0.0707107，t=0.3/0.0707107≈4.242641
  assert.strictEqual(r.hacApplied, false);
  assert.ok(Math.abs(r.t - 4.2426407) < 1e-5, `t 期望 4.2426407，实得 ${r.t}`);
});

test('tTestMean：HAC 修正后 t 的绝对值应小于未修正（正自相关）', () => {
  const xs = [];
  let v = 0;
  for (let i = 0; i < 50; i++) {
    v = 0.7 * v + 0.3;
    xs.push(v);
  }
  const hac = st.tTestMean(xs, { hac: true });
  const iid = st.tTestMean(xs, { hac: false });
  assert.ok(Math.abs(hac.t) < Math.abs(iid.t), `HAC 应降低虚高 t：hac=${hac.t.toFixed(4)} iid=${iid.t.toFixed(4)}`);
});

test('tTestMean：样本不足（n<2）返回 null 且给出原因', () => {
  const r = st.tTestMean([0.5]);
  assert.strictEqual(r.t, null);
  assert.match(r.degradeReason, /样本不足/);
});

test('tTestMean：过滤 NaN / Infinity', () => {
  const r = st.tTestMean([0.1, NaN, 0.2, Infinity, 0.3]);
  assert.strictEqual(r.n, 3);
});

// ─────────── p 值（正态近似） ───────────

test('pValueTwoSided：常用临界值校验', () => {
  // |t|=1.96 → p≈0.05
  assert.ok(Math.abs(st.pValueTwoSided(1.96) - 0.05) < 0.001, `p(1.96)=${st.pValueTwoSided(1.96)}`);
  // |t|=2.576 → p≈0.01
  assert.ok(Math.abs(st.pValueTwoSided(2.576) - 0.01) < 0.001, `p(2.576)=${st.pValueTwoSided(2.576)}`);
  // |t|=3 → p≈0.0027
  assert.ok(Math.abs(st.pValueTwoSided(3) - 0.0027) < 0.0005, `p(3)=${st.pValueTwoSided(3)}`);
  // t=0 → p=1（erf 近似误差约 5e-10，故容差取 1e-8）
  assert.ok(Math.abs(st.pValueTwoSided(0) - 1) < 1e-8, `p(0)=${st.pValueTwoSided(0)}`);
  // 对称性
  assert.ok(Math.abs(st.pValueTwoSided(-2.1) - st.pValueTwoSided(2.1)) < 1e-12);
});

test('normCdf：标准正态关键点', () => {
  assert.ok(Math.abs(st.normCdf(0) - 0.5) < 1e-8, `normCdf(0)=${st.normCdf(0)}`);
  assert.ok(Math.abs(st.normCdf(1.96) - 0.975) < 0.0005);
  assert.ok(Math.abs(st.normCdf(-1.96) - 0.025) < 0.0005);
});

// ─────────── Spearman 秩相关 ───────────

test('spearman：完全单调 → 1 或 −1', () => {
  assert.ok(Math.abs(st.spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]) - 1) < 1e-12);
  assert.ok(Math.abs(st.spearman([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]) + 1) < 1e-12);
});

test('spearman：对单调非线性稳健（Pearson 会被拉低，Spearman 保持 1）', () => {
  const xs = [1, 2, 3, 4, 5];
  const ys = [1, 4, 9, 16, 25]; // y = x²
  assert.ok(Math.abs(st.spearman(xs, ys) - 1) < 1e-12);
});

test('spearman：tie（并列）用平均秩', () => {
  // x 有并列：rx 应为 [1.5,1.5,3.5,3.5]（tie 组取平均秩）
  const r = st.spearman([1, 1, 2, 2], [1, 2, 3, 4]);
  // 手算：rx=[1.5,1.5,3.5,3.5]，ry=[1,2,3,4]，mx=my=2.5
  //   num = (-1)(-1.5)+(-1)(-0.5)+(1)(0.5)+(1)(1.5) = 1.5+0.5+0.5+1.5 = 4
  //   dx  = 1+1+1+1 = 4
  //   dy  = 2.25+0.25+0.25+2.25 = 5
  //   r = 4/√20 = 4/4.4721359 ≈ 0.8944272
  assert.ok(Math.abs(r - 0.8944272) < 1e-6, `期望 0.8944272，实得 ${r}`);
});

test('spearman：常数序列返回 null（无秩相关可言）', () => {
  assert.strictEqual(st.spearman([1, 1, 1, 1], [1, 2, 3, 4]), null);
  assert.strictEqual(st.spearman([1, 2], [1]), null); // 长度不足
});

// ─────────── IC 汇总 ───────────

test('summarizeIC：正常 IC 序列的完整指标', () => {
  const ic = [0.05, -0.02, 0.03, 0.08, -0.01, 0.04, 0.06, -0.03, 0.02, 0.05];
  const r = st.summarizeIC(ic);
  assert.strictEqual(r.n, 10);
  assert.ok(Math.abs(r.icMean - 0.027) < 1e-6, `icMean 期望 0.027，实得 ${r.icMean}`);
  // 胜率：7 个正 / 10 = 0.7
  assert.strictEqual(r.icPositiveRate, 0.7);
  assert.ok(r.icir !== null && Number.isFinite(r.icir));
  assert.strictEqual(r.neweyWestLag, st.neweyWestLag(10));
  assert.strictEqual(typeof r.significant2, 'boolean');
  assert.strictEqual(typeof r.significant3, 'boolean');
});

test('summarizeIC：IC 恒定（std=0）时 ICIR 返回 null 而非 Infinity', () => {
  const r = st.summarizeIC([0.05, 0.05, 0.05, 0.05]);
  assert.strictEqual(r.icir, null);
  assert.strictEqual(r.icStd, 0);
});

test('summarizeIC：空序列安全返回', () => {
  const r = st.summarizeIC([]);
  assert.strictEqual(r.n, 0);
  assert.strictEqual(r.icMean, null);
  assert.strictEqual(r.icir, null);
  assert.strictEqual(r.t, null);
});

test('summarizeIC：剔除 NaN 后计数正确', () => {
  const r = st.summarizeIC([0.1, NaN, 0.2, NaN, 0.3]);
  assert.strictEqual(r.n, 3);
});

test('summarizeIC：显著性门槛判定与 |t| 一致', () => {
  // 构造高信噪比序列：均值 0.1，波动小 → |t| 应远超 3
  const strong = [];
  for (let i = 0; i < 40; i++) strong.push(0.1 + (i % 3 - 1) * 0.001);
  const rs = st.summarizeIC(strong);
  assert.strictEqual(rs.significant2, true);
  assert.strictEqual(rs.significant3, true);

  // 构造纯噪声：均值为 0，|t| 应较小
  const noise = [];
  for (let i = 0; i < 40; i++) noise.push(i % 2 === 0 ? 0.05 : -0.05);
  const rn = st.summarizeIC(noise);
  assert.strictEqual(rn.significant3, false);
});
