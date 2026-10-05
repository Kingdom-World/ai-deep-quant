// ─────────────────────────────────────────────────────────────
// 因子方向（direction）口径测试 —— 2026-10-05 修的一个真缺陷的回归锁
//
//   缺陷：`rev20` 在两条执行路径上口径不同
//     · 单因子路径（crosssect.runCrossBacktest）：靠 `isReversal` 决定升/降序 → 真反转
//     · 模型路径（modelrun 复合截面）：方向只由 `direction` 表达，缺省为 1 → **等价于 mom20**
//   实测（真实归档，topN=5）：单因子 rev20=94.32、单因子 mom20=-78.63；
//   而模型路径 `{expr:'rev20'}` 缺省 direction 得到 **-78.63（与 mom20 一模一样）**。
//   用户从预置下拉框选了「反转」期望抄底，实际在追涨，且界面无任何提示。
//
//   修法：**方向归一到一个字段**。`direction` 缺省 ⇒ 由因子名推导（rev* → -1）。
//   本文件把这条规则钉死在四个层面：纯函数 / 规范层 / 校验层 / 跨路径执行。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ms = require('../shared/modelspec.cjs');
const crosssect = require('../server/crosssect.cjs');
const fe = require('../server/factorexpr.cjs');
const { runModel, modelHash } = require('../server/modelrun.cjs');

const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);

const wrap = (factors, over = {}) => ({
  schemaVersion: 1,
  name: '方向口径测试',
  factors,
  meta: { author: 'tester' },
  ...over,
});
const norm = (m) => ms.normalizeModel(m, { parseExpr: fe.parseExpression });
const warningsAt = (v, path) => v.warnings.filter((w) => w.path === path);

// ── ① 等价锁：反转预置名只有一份真相 ─────────────────────────
test('等价锁：modelspec.REVERSAL_PRESETS ≡ crosssect.REVERSAL_FACTORS', () => {
  const a = [...ms.REVERSAL_PRESETS].sort();
  const b = [...crosssect.REVERSAL_FACTORS].sort();
  assert.deepStrictEqual(
    a,
    b,
    '反转因子清单在两处各写一份就会再次分叉——必须完全一致（改一处必须改另一处）',
  );
  assert.ok(a.length > 0, '反转清单不应为空');
});

test('等价锁：反转预置名 ⊆ 预置因子名 ∩ 名称为 rev 形式', () => {
  for (const name of ms.REVERSAL_PRESETS) {
    assert.ok(ms.PRESET_FACTORS.includes(name), `${name} 是反转预置就必须在预置清单里`);
    assert.match(name, /^rev\d+$/, `${name} 命名应形如 rev<窗口>`);
  }
  // 反向：mom* 预置一律不得被误判为反转
  for (const name of ms.PRESET_FACTORS.filter((x) => x.startsWith('mom'))) {
    assert.strictEqual(ms.defaultDirection(name), 1, `${name} 是动量预置，默认方向必须为正向`);
  }
});

// ── ② 纯函数：defaultDirection ───────────────────────────────
test('defaultDirection：反转预置 -1、动量预置 1、表达式一律 1', () => {
  for (const name of ms.REVERSAL_PRESETS) {
    assert.strictEqual(ms.defaultDirection(name), -1, `${name} 应默认反向`);
    assert.strictEqual(ms.defaultDirection(` ${name} `), -1, '应容忍首尾空白（用户手输常见）');
  }
  assert.strictEqual(ms.defaultDirection('mom20'), 1);
  assert.strictEqual(ms.defaultDirection('mom60 - mom20'), 1, '表达式不参与命名推导，默认正向');
  assert.strictEqual(ms.defaultDirection(''), 1);
  assert.strictEqual(ms.defaultDirection(undefined), 1, '缺值不得抛错（校验层要能安全调用）');
  assert.strictEqual(ms.defaultDirection(null), 1);
});

// ── ③ 规范层：缺省推导、显式不被覆盖 ─────────────────────────
test('normalizeModel：direction 缺省时由因子名推导（rev* → -1）', () => {
  const r = norm(wrap([{ id: 'a', expr: 'rev20', weight: 1 }, { id: 'b', expr: 'mom20', weight: 1 }]));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.model.factors[0].direction, -1, 'rev20 缺省必须落到 -1；落 1 就等价于 mom20（原缺陷）');
  assert.strictEqual(r.model.factors[1].direction, 1);
});

test('normalizeModel：显式 direction 优先，不被命名推导覆盖', () => {
  const r = norm(wrap([{ id: 'a', expr: 'rev20', weight: 1, direction: 1 }, { id: 'b', expr: 'mom20', weight: 1, direction: -1 }]));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.model.factors[0].direction, 1, '用户显式指定必须尊重（此时它被当作动量用）');
  assert.strictEqual(r.model.factors[1].direction, -1);
});

test('normalizeModel 幂等：推导过的模型再规范化方向不变', () => {
  const once = norm(wrap([{ id: 'a', expr: 'rev20', weight: 1 }])).model;
  const twice = norm(once).model;
  assert.strictEqual(twice.factors[0].direction, -1);
  assert.strictEqual(ms.canonicalJSON(once), ms.canonicalJSON(twice), '规范化必须幂等，否则指纹会漂移');
});

// ── ④ 校验层：名字与行为不一致必须披露 ───────────────────────
test('validateModel：显式 direction=1 + 反转预置名 → 必须给出 warning（披露而非篡改）', () => {
  const v = ms.validateModel(wrap([{ id: 'a', expr: 'rev20', weight: 1, direction: 1 }]), { parseExpr: fe.parseExpression });
  assert.strictEqual(v.ok, true, '这不是错误（用户可能就想当动量用），必须是 warning 而非 error');
  const w = warningsAt(v, 'factors[0].direction');
  assert.strictEqual(w.length, 1, '必须恰好一条方向提示');
  assert.match(w[0].message, /反转/, '提示要说清"这是反转因子"');
  assert.match(w[0].message, /当动量用|设为 1/, '提示要说清"当前等同当动量用"');
});

test('validateModel：不设 direction 的 rev20 不得产生方向 warning（缺省即正确）', () => {
  const v = ms.validateModel(wrap([{ id: 'a', expr: 'rev20', weight: 1 }]), { parseExpr: fe.parseExpression });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(warningsAt(v, 'factors[0].direction'), [], '缺省走推导是对的，不该报噪声');
});

test('validateModel：显式 direction=-1 的 rev20 同样不得产生方向 warning', () => {
  const v = ms.validateModel(wrap([{ id: 'a', expr: 'rev20', weight: 1, direction: -1 }]), { parseExpr: fe.parseExpression });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(warningsAt(v, 'factors[0].direction'), []);
});

test('validateModel：direction 非 ±1 仍必须是 error（原行为不变）', () => {
  const v = ms.validateModel(wrap([{ id: 'a', expr: 'mom20', weight: 1, direction: 0 }]), { parseExpr: fe.parseExpression });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.path === 'factors[0].direction'));
});

// ── ⑤ 模板不得再写错（模板写错是最难查的一类缺陷）─────────────
test('模板完整性：所有模板的因子方向都必须与因子名一致（无方向 warning）', () => {
  assert.ok(ms.MODEL_TEMPLATES.length > 0);
  for (const t of ms.MODEL_TEMPLATES) {
    const v = ms.validateModel(t.model, { parseExpr: fe.parseExpression });
    assert.strictEqual(v.ok, true, `模板 ${t.key} 不合法：${JSON.stringify(v.errors)}`);
    for (let i = 0; i < t.model.factors.length; i += 1) {
      const w = warningsAt(v, `factors[${i}].direction`);
      assert.deepStrictEqual(
        w,
        [],
        `模板 ${t.key} 的 factors[${i}] 名称与方向不一致：${JSON.stringify(w)}`,
      );
    }
  }
});

test('模板 mom-rev-combo 的 rev20 必须真的反向（曾被误写为 1）', () => {
  const t = ms.MODEL_TEMPLATES.find((x) => x.key === 'mom-rev-combo');
  assert.ok(t, '模板 mom-rev-combo 应存在');
  const f = t.model.factors.find((x) => x.expr === 'rev20');
  assert.ok(f, '该模板应含 rev20 因子');
  const n = norm(t.model);
  assert.strictEqual(n.ok, true, JSON.stringify(n.errors));
  const nf = n.model.factors.find((x) => x.expr === 'rev20');
  assert.strictEqual(nf.direction, -1, '写成 1 会让这个模板变成"两份 mom"，与"反转做辅"的描述不符');
});

// ── ⑥ 身份：语义不同的两份模型不得同 hash ────────────────────
test('modelHash：rev20（缺省=-1）与 rev20(direction:1) 必须是两份不同的模型', () => {
  const a = norm(wrap([{ id: 'a', expr: 'rev20', weight: 1 }])).model;
  const b = norm(wrap([{ id: 'a', expr: 'rev20', weight: 1, direction: 1 }])).model;
  assert.notStrictEqual(
    modelHash(a),
    modelHash(b),
    '方向不同 ⇒ 语义不同 ⇒ hash 必须不同；否则模型库会把"反转"和"追涨"判成同一份，实验留痕失真',
  );
  // 而"缺省"与"显式写出推导值"是同一种语义 → 必须同 hash
  const c = norm(wrap([{ id: 'a', expr: 'rev20', weight: 1, direction: -1 }])).model;
  assert.strictEqual(
    modelHash(a),
    modelHash(c),
    '缺省与显式 -1 语义相同，hash 应一致（否则同一份模型会有两个身份）',
  );
});

// ── ⑦ 跨路径口径一致（需真实归档）───────────────────────────
const skip = (t) => {
  if (!hasRealArchive) {
    console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
    return true;
  }
  return false;
};

const single = (factor) => {
  const r = crosssect.runCrossBacktest({ factor, topN: 5, rebalanceEvery: 20, capital: 1_000_000, slippage: 0.001 });
  assert.ok(!r.error, `${factor} 单因子回测失败：${r.error}`);
  return r.totalReturn;
};

test('🔴 跨路径口径锁：模型 {expr:"rev20"}（不写 direction）≡ 单因子 rev20', (t) => {
  if (skip(t)) return;
  const m = runModel(wrap([{ id: 'a', expr: 'rev20', weight: 1 }]), { topN: 5 });
  assert.strictEqual(m.ok, true, m.error);
  assert.strictEqual(
    m.result.totalReturn,
    single('rev20'),
    '同名字必须同口径：模型路径的 rev20 与单因子路径的 rev20 收益必须一模一样',
  );
});

test('🔴 跨路径口径锁：rev20 不得与 mom20 等价（原缺陷的实锤断言）', (t) => {
  if (skip(t)) return;
  const rev = runModel(wrap([{ id: 'a', expr: 'rev20', weight: 1 }]), { topN: 5 });
  const mom = runModel(wrap([{ id: 'a', expr: 'mom20', weight: 1 }]), { topN: 5 });
  assert.strictEqual(rev.ok && mom.ok, true);
  assert.notStrictEqual(
    rev.result.totalReturn,
    mom.result.totalReturn,
    '若两者收益相同 ⇒ 反转又被当成动量了（这就是缺陷原形）',
  );
});

test('跨路径口径锁：模型显式 direction=-1 与缺省推导给出同一结果', (t) => {
  if (skip(t)) return;
  const a = runModel(wrap([{ id: 'a', expr: 'rev20', weight: 1 }]), { topN: 5 });
  const b = runModel(wrap([{ id: 'a', expr: 'rev20', weight: 1, direction: -1 }]), { topN: 5 });
  assert.strictEqual(a.ok && b.ok, true);
  assert.deepStrictEqual(a.result.equity, b.result.equity, '缺省推导的结果必须逐点等于显式指定');
  assert.strictEqual(a.fingerprint, b.fingerprint, '同一语义 → 同一实验指纹');
});

test('跨路径口径锁：显式 direction=1 的 rev20 必需确实等于 mom20（尊重用户选择）', (t) => {
  if (skip(t)) return;
  const a = runModel(wrap([{ id: 'a', expr: 'rev20', weight: 1, direction: 1 }]), { topN: 5 });
  const b = runModel(wrap([{ id: 'a', expr: 'mom20', weight: 1 }]), { topN: 5 });
  assert.strictEqual(a.ok && b.ok, true);
  assert.deepStrictEqual(
    a.result.equity,
    b.result.equity,
    '用户显式当成动量用是被允许的（校验层已给 warning 披露），执行必须忠实',
  );
});
