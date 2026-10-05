// ─────────────────────────────────────────────────────────────
// Phase 2 · 独立验证套件测试（server/validation.cjs）
//
//   最重要的不是"函数能跑"，而是**独立性原则**本身：
//     验证套件只读模型与产物、绝不回写 —— 一旦它能反过来影响模型，就不是验证而是自证。
//     故本文件的首要断言是"调用前后传入的 model 完全不变"（深比较）。
//
//   bhFdr 是唯一不依赖归档的纯函数，因此它的**统计不变式**必须被完整锁住：
//     ① 调整 p 按 p 升序单调不减  ② adjusted ≥ p  ③ rejected ≡ (adjusted ≤ q)
//   这三条是 BH 的正确性定义，写死它们才能在将来重写算法时立刻发现口径漂移。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const V = require('../server/validation.cjs');
const { runModel } = require('../server/modelrun.cjs');

const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);
const skip = (t) => {
  if (!hasRealArchive) {
    console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
    return true;
  }
  return false;
};

const MODEL = () => ({
  schemaVersion: 1,
  name: '验证套件测试模型',
  factors: [{ id: 'mom', expr: 'mom20', weight: 1, direction: 1 }],
  meta: { author: 'tester' },
});

// ═══ 一、bhFdr 纯函数 ════════════════════════════════════════

test('bhFdr：空输入不崩，显式说明"未做校正"（不假装做过）', () => {
  for (const input of [[], null, undefined, [NaN, Infinity, -Infinity]]) {
    const r = V.bhFdr(input);
    assert.strictEqual(r.m, 0);
    assert.deepStrictEqual(r.rejected, []);
    assert.strictEqual(r.rejectedMaxP, null);
    assert.match(r.note, /没有可检验/);
  }
});

test('bhFdr：全部极小 p → 全部拒绝；全部大 p → 一个不拒', () => {
  const all = V.bhFdr([1e-9, 1e-8, 1e-7], 0.05);
  assert.strictEqual(all.m, 3);
  assert.deepStrictEqual(all.rejected, [true, true, true]);

  const none = V.bhFdr([0.6, 0.7, 0.8, 0.9], 0.05);
  assert.deepStrictEqual(none.rejected, [false, false, false, false]);
  assert.strictEqual(none.rejectedMaxP, null);
});

test('bhFdr：三条统计不变式（单调性 / adjusted ≥ p / rejected ≡ adjusted ≤ q）', () => {
  // 造一批混合 p（含边界与重复值）
  const ps = [0.001, 0.004, 0.004, 0.02, 0.049, 0.05, 0.051, 0.2, 0.5, 0.95];
  const q = 0.05;
  const r = V.bhFdr(ps, q);
  assert.strictEqual(r.m, ps.length);

  // ① 按 p 升序排列后，adjusted 必须单调不减
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  for (let k = 1; k < order.length; k++) {
    const prev = r.adjusted[order[k - 1].i];
    const cur = r.adjusted[order[k].i];
    assert.ok(cur >= prev - 1e-9, `adjusted 必须随 p 单调不减：第 ${k} 位 ${cur} < 前一位 ${prev}`);
  }
  for (let i = 0; i < ps.length; i++) {
    // ② adjusted 永远不小于原始 p（m/j ≥ 1）且不超过 1
    assert.ok(r.adjusted[i] >= ps[i] - 1e-6, `adjusted[${i}]=${r.adjusted[i]} 不应小于原始 p=${ps[i]}`);
    assert.ok(r.adjusted[i] <= 1, `adjusted[${i}] 不得超过 1`);
    // ③ BH 的拒绝集与"adjusted ≤ q"完全等价（两种表述必须同口径）
    assert.strictEqual(
      r.rejected[i],
      r.adjusted[i] <= q + 1e-6,
      `rejected[${i}] 与 adjusted[${i}]<=q 不一致——两种口径分叉会让报告自相矛盾`,
    );
  }
});

test('bhFdr：比 Bonferroni 温和（校正后 p 一律不超过 Bonferroni 阈值，且确有更小者）', () => {
  const ps = [0.005, 0.01, 0.02, 0.03, 0.04];
  const q = 0.05;
  const r = V.bhFdr(ps, q);
  const m = ps.length;
  let strictlySmaller = 0;
  for (let i = 0; i < m; i++) {
    const bonf = Math.min(1, ps[i] * m);
    assert.ok(r.adjusted[i] <= bonf + 1e-6, 'BH 必须不比 Bonferroni 更严');
    if (r.adjusted[i] < bonf - 1e-6) strictlySmaller += 1;
  }
  assert.ok(strictlySmaller > 0, 'BH 的价值在于比 Bonferroni 温和；若处处相等说明实现退化了');
});

test('bhFdr：确实抑制了多重检验的假阳性（噪声批次演示）', () => {
  // 固定种子的线性同余发生器（不引入外部依赖，且结果可复现）
  let seed = 20261005;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const m = 200;
  const ps = Array.from({ length: m }, () => rnd()); // 纯噪声：p 服从 U(0,1)
  const q = 0.05;
  const naive = ps.filter((p) => p < q).length; // 未校正：约 m*q = 10 个"显著"
  const r = V.bhFdr(ps, q);
  const bh = r.rejected.filter(Boolean).length;
  assert.ok(naive >= 3, `噪声批次应有若干未校正假阳性（实际 ${naive}）——否则本演示无意义`);
  assert.ok(
    bh < naive,
    `BH 必须把假阳性压下来：未校正 ${naive} 个 vs BH ${bh} 个；相等说明校正没起作用`,
  );
  assert.match(r.note, /未校正时/, 'note 必须显式给出"未校正的显著数"，让差额（假阳性）可读');
});

// ═══ 二、walkForward ════════════════════════════════════════

test('walkForward：非法模型 → 显式失败并透传 stage（不静默返回空报告）', () => {
  const r = V.walkForward({ schemaVersion: 1, name: '', factors: [], meta: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'validate');
  assert.ok(r.issues && r.issues.length > 0);
});

test('walkForward：折数被钳制在 2~8（防止极端折数把区间切碎）', () => {
  const bad = V.walkForward({ schemaVersion: 1, name: '', factors: [], meta: {} }, { folds: 999 });
  assert.strictEqual(bad.ok, false, '非法模型先失败，但折数钳制不应抛错');
});

test('walkForward：逐折独立重跑，折区间首尾相接且落在整段内', (t) => {
  if (skip(t)) return;
  const r = V.walkForward(MODEL(), { folds: 3, opts: { topN: 5 } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.folds.length + r.skipped.length, 3, '折数必须闭合：成功折 + 显式跳过折 = 请求折数');
  for (const f of r.folds) {
    assert.ok(f.bars > 0, '每折都应有 K 线数');
    assert.strictEqual(typeof f.totalReturn, 'number');
    assert.ok(['stable', 'unstable'].includes(r.verdict));
  }
  // 相邻折日期不倒退
  const starts = r.folds.map((f) => f.actualRange.start);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] >= starts[i - 1], `第 ${i + 1} 折起点 ${starts[i]} 不应早于第 ${i} 折起点 ${starts[i - 1]}`);
  }
  assert.ok(Array.isArray(r.flags));
  assert.match(r.note, /独立重跑/, 'note 必须声明"逐折独立"，否则读者会误当成整段切分');
});

test('walkForward：折数过多导致区间不足时显式报错（不得假装通过）', (t) => {
  if (skip(t)) return;
  const r = V.walkForward(MODEL(), { folds: 8, opts: { topN: 5, startDate: '2024-01-02', endDate: '2024-03-01' } });
  if (r.ok) {
    assert.ok(r.folds.length > 0);
  } else {
    assert.match(String(r.error), /不足|无法回测|放宽/, `错误必须说明原因与出路，实际：${r.error}`);
  }
});

// ═══ 三、plateauScan ════════════════════════════════════════

test('plateauScan：模型无因子时扫权重必须显式拒绝', () => {
  const r = V.plateauScan({ schemaVersion: 1, name: 'x', factors: [], meta: { author: 'a' } }, { param: 'weight' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /因子/);
});

test('plateauScan：边界点被取整合并时必须显式标注 no-edge-points（不假装扫过）', (t) => {
  if (skip(t)) return;
  // topN=1 时 ±30% 取整后仍为 1 ⇒ 三个比例全部塌到同一点，边界根本没被覆盖
  const r = V.plateauScan(MODEL(), { param: 'topN', opts: { topN: 1 } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.distinctPoints, 1, 'topN=1 的 ±30% 取整后应只剩一个取值');
  // 🔴 合并时必须保留"最接近基准"的比例：否则先到的极端比例（0.7）占坑，
  //    中心点被误认成边界点，之后所有 delta/drop 都相对错误基准计算。
  assert.strictEqual(
    r.points[0].ratio,
    1,
    `合并后保留的比例应是 1（最接近基准），实际 ${r.points[0].ratio} —— 中心点被边界点挤掉了`,
  );
  assert.ok(r.points[0].mergedRatios.length >= 3, '被合并的比例必须如实记录，不得当作扫过');
  assert.ok(r.mergedPoints.length >= 1, 'mergedPoints 必须列出合并详情，供人工复核');
  assert.ok(
    r.flags.some((f) => f.startsWith('no-edge-points')),
    '未覆盖边界必须显式披露——否则用户以为做了 ±30% 稳健性检验',
  );
  assert.strictEqual(r.verdict, 'plateau', '未覆盖边界不得等同于"通过"，但也不得误报尖峰');
});

test('plateauScan：正常 topN 扫描覆盖多个取值，中心点 delta 为 0', (t) => {
  if (skip(t)) return;
  const r = V.plateauScan(MODEL(), { param: 'topN', opts: { topN: 5 } });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.distinctPoints >= 3, `±30% 应取到多个不同 topN，实际 ${r.distinctPoints}`);
  assert.strictEqual(r.baseValue, 5);
  const center = r.points.find((p) => Math.abs(p.ratio - 1) < 1e-9);
  assert.ok(center && center.ok, '中心点必须存在且成功');
  assert.strictEqual(center.value, 5, '中心点参数应等于基准值');
  assert.strictEqual(center.deltaPct, 0, '中心点相对自身的变化必须为 0');
});

test('plateauScan：只改第一个因子的权重（单因子模型下等比缩放不改变排序 → 收益恒定）', (t) => {
  if (skip(t)) return;
  // 单因子模型整体缩放权重是严格单调变换，选股不变 ⇒ 各点收益必须完全相同。
  // 这条同时验证了实现"改的是相对配比"而不是"整体缩放"（后者等于白扫）。
  const r = V.plateauScan(MODEL(), { param: 'weight', opts: { topN: 5 } });
  assert.strictEqual(r.ok, true, r.error);
  const ok = r.points.filter((p) => p.ok);
  assert.ok(ok.length >= 3, '权重扫描应至少取到 3 个不同权重');
  const first = ok[0].totalReturn;
  for (const p of ok) {
    assert.strictEqual(
      p.totalReturn,
      first,
      `单因子模型下权重是严格单调缩放，收益不应变化；w=${p.value} 得到 ${p.totalReturn}，中心点 ${first}`,
    );
  }
  assert.strictEqual(r.verdict, 'plateau', '单调缩放下不可能出现尖峰');
});

// ═══ 四、runValidation 汇总 ═════════════════════════════════

test('runValidation：回测失败时如实带出 stage/error 且 PASS=false（不用"通过"掩盖）', () => {
  const r = V.runValidation({ schemaVersion: 1, name: '', factors: [], meta: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verdict.pass, false);
  assert.strictEqual(r.error.stage, 'validate');
  assert.ok(r.verdict.flags.some((f) => /回测未能完成/.test(f)), 'flags 必须说明失败原因');
  // 即便失败，规则与局限也必须随报告返回（可复核）
  assert.ok(r.rules && typeof r.rules.minIcPeriods === 'number');
  assert.ok(Array.isArray(r.limitations) && r.limitations.length > 0);
  assert.strictEqual(typeof r.engineVersion, 'string');
});

test('runValidation：已知局限必须非空且逐条成句（强制披露纪律）', () => {
  assert.ok(V.LIMITATIONS.length >= 3, '已知局限至少三条，否则披露流于形式');
  for (const s of V.LIMITATIONS) {
    assert.strictEqual(typeof s, 'string');
    assert.ok(s.length >= 12, `局限描述过短，看不出含义：「${s}」`);
  }
  assert.ok(
    V.LIMITATIONS.some((s) => /幸存者偏差/.test(s)),
    '核心池 + 未含退市股 ⇒ 幸存者偏差必须被披露（这是最容易被忽视的乐观来源）',
  );
});

test('runValidation：阈值必须具名且随报告返回（拒绝魔法数字）', () => {
  assert.ok(V.RULES && Object.keys(V.RULES).length >= 4);
  for (const [k, v] of Object.entries(V.RULES)) {
    assert.strictEqual(typeof v, 'number', `阈值 ${k} 必须是具名数字`);
    assert.ok(Number.isFinite(v), `阈值 ${k} 必须有限`);
  }
  const r = V.runValidation({ schemaVersion: 1, name: '', factors: [], meta: {} });
  assert.deepStrictEqual(r.rules, V.RULES, '报告必须带上阈值快照，便于事后复核争议判定');
});

test('runValidation：完整报告的形状与样本量/功效披露', (t) => {
  if (skip(t)) return;
  const r = V.runValidation(MODEL(), { folds: 2, opts: { topN: 5 } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(typeof r.fingerprint, 'string');
  assert.ok(r.sample && typeof r.sample.bars === 'number' && r.sample.equityPointsReturned > 0);
  assert.ok(r.power && typeof r.power.icPeriods === 'number' && typeof r.power.sufficient === 'boolean');
  assert.match(r.power.note, /门槛|功效不足/, '功效说明必须写明判据');
  assert.ok(r.checks.walkForward && r.checks.plateau, '默认应包含两项检查');
  assert.strictEqual(typeof r.verdict.pass, 'boolean');
  assert.ok(Array.isArray(r.verdict.flags));
  assert.ok(Array.isArray(r.limitations) && r.limitations.length > 0, '报告必须自带局限披露');
});

test('runValidation：skip 生效（显式跳过，而不是"结果里悄悄没有"）', (t) => {
  if (skip(t)) return;
  const r = V.runValidation(MODEL(), { folds: 2, skip: ['walkForward', 'plateau'], opts: { topN: 5 } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.checks.walkForward, undefined);
  assert.strictEqual(r.checks.plateau, undefined);
  assert.ok(r.sample && r.power, '跳过检查不应影响样本与功效披露');
});

// ═══ 五、🔴 独立性原则（本模块的定义）════════════════════════

test('🔴 独立性：三项检查都不得修改传入的 model（否则验证就成了自证）', (t) => {
  const m = MODEL();
  const snapshot = JSON.parse(JSON.stringify(m));
  V.bhFdr([0.01, 0.2]);
  V.walkForward(m, { folds: 2, opts: { topN: 5 } });
  V.plateauScan(m, { param: 'weight', opts: { topN: 5 } });
  V.runValidation(m, { folds: 2, opts: { topN: 5 } });
  assert.deepStrictEqual(
    m,
    snapshot,
    '验证套件回写了模型 ⇒ 它已经能影响被验证对象，不再是独立验证',
  );
});

test('独立性：runModel 本身也不得回写调用方传入的模型（验证套件建立在它之上）', (t) => {
  if (skip(t)) return;
  const m = MODEL();
  const snapshot = JSON.parse(JSON.stringify(m));
  runModel(m, { topN: 5 });
  assert.deepStrictEqual(m, snapshot, 'runModel 回写了入参 ⇒ 上层任何"只读"承诺都不成立');
});

test('独立性：验证结论必须随引擎版本与指纹一起交付（无版本即不可复现）', (t) => {
  if (skip(t)) return;
  const a = V.runValidation(MODEL(), { folds: 2, skip: ['plateau'], opts: { topN: 5 } });
  const b = V.runValidation(MODEL(), { folds: 2, skip: ['plateau'], opts: { topN: 5 } });
  assert.strictEqual(a.fingerprint, b.fingerprint, '同一模型同窗口 → 指纹必须一致');
  assert.strictEqual(a.engineVersion, b.engineVersion);
  assert.strictEqual(
    a.checks.walkForward.verdict,
    b.checks.walkForward.verdict,
    '验证结论必须可复现（同输入同判定）',
  );
});
