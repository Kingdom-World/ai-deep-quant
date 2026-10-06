// ─────────────────────────────────────────────────────────────
// modeldag 测试（shared/modeldag.cjs）—— Model JSON ↔ DAG 图模型
//
//   放在 shared/ 的回报：这里能**真实跑行为**（不是源码级断言）。
//   覆盖：派生正确性 / 边界不崩 / 编辑往返 / 越界在编辑期被拒 / 纯函数不改入参 /
//        方向三态的"auto 必须删键" / 两组动作的语义边界。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/modeldag.cjs');
const { LIMITS, PRESET_FACTORS } = require('../shared/modelspec.cjs');

const MODEL = (over = {}) => ({
  schemaVersion: 1,
  name: 'DAG 测试',
  factors: [
    { id: 'mom20', expr: 'mom20', weight: 1 },
    { id: 'rev60', expr: 'rev60', weight: 2 },
  ],
  transforms: [{ type: 'zscore', args: {} }],
  filters: [{ field: 'close', op: '>', value: 3 }],
  combine: { method: 'weighted_sum' },
  universe: { type: 'core_pool' },
  backtest: { rebalance: 'monthly', groups: 5, fees: true },
  meta: { author: 'tester' },
  ...over,
});
const ids = (g) => g.nodes.map((n) => n.id);

// ═══ 一、派生 ══════════════════════════════════════════════════

test('派生：固定形态六层齐全，节点 id 稳定', () => {
  const g = D.buildDag(MODEL());
  assert.deepStrictEqual(ids(g), ['data', 'f:mom20', 'f:rev60', 'f:add', 't:0', 'ft:0', 'combine', 'backtest']);
  assert.strictEqual(g.nodes.find((n) => n.id === 'f:mom20').kind, 'factor');
  assert.strictEqual(g.nodes.find((n) => n.id === 'combine').kind, 'combine');
  // 纯函数：同一输入两次派生必须完全一致（无随机/无时间）
  assert.deepStrictEqual(D.buildDag(MODEL()), D.buildDag(MODEL()));
});

test('派生：因子节点带可编辑字段（权重 + 方向三态），上限来自规范', () => {
  const g = D.buildDag(MODEL());
  const f = g.nodes.find((n) => n.id === 'f:mom20');
  assert.deepStrictEqual(f.fields.map((x) => x.kind), ['weight', 'direction']);
  assert.strictEqual(f.fields[0].max, LIMITS.maxWeight, '权重上限必须取自规范，不硬编码');
  assert.strictEqual(f.fields[1].value, 'auto', '缺省方向必须是 auto（交给规范按名推导）');
  const rev = g.nodes.find((n) => n.id === 'f:rev60');
  assert.strictEqual(rev.fields[1].value, 'auto');
});

test('派生：方向三态如实反映文档（显式 1/-1 分别读出）', () => {
  const g = D.buildDag(MODEL({
    factors: [{ id: 'a', expr: 'mom20', weight: 1, direction: 1 }, { id: 'b', expr: 'rev60', weight: 1, direction: -1 }],
  }));
  assert.strictEqual(g.nodes.find((n) => n.id === 'f:a').fields[1].value, 1);
  assert.strictEqual(g.nodes.find((n) => n.id === 'f:b').fields[1].value, -1);
});

test('派生：回测节点字段的枚举与区间取自规范', () => {
  const bt = D.buildDag(MODEL()).nodes.find((n) => n.id === 'backtest');
  const rebal = bt.fields.find((x) => x.kind === 'select' && x.path.endsWith('rebalance'));
  const groups = bt.fields.find((x) => x.kind === 'number');
  assert.deepStrictEqual(rebal.options, Object.keys(require('../shared/modelspec.cjs').REBALANCE_BARS));
  assert.strictEqual(groups.min, LIMITS.minGroups);
  assert.strictEqual(groups.max, LIMITS.maxGroups);
});

test('派生：空/残缺模型不崩（老数据防御）', () => {
  for (const bad of [null, undefined, {}, { factors: null }, { factors: 'x' }, 42, 'str']) {
    const g = D.buildDag(bad);
    assert.ok(Array.isArray(g.nodes) && g.nodes.length >= 3, `残缺输入应仍产出基础骨架：${JSON.stringify(bad)}`);
    assert.ok(Array.isArray(g.edges));
  }
});

test('派生：某层为空时连线跳过该层，不留悬空端点', () => {
  // 无 transform / 无 filter
  const g1 = D.buildDag(MODEL({ transforms: [], filters: [] }));
  assert.ok(g1.edges.some((e) => e.from === 'f:mom20' && e.to === 'combine'), '因子应直连组合');
  assert.ok(!g1.nodes.some((n) => n.kind === 'transform'));
  // 有 transform 无 filter
  const g2 = D.buildDag(MODEL({ filters: [] }));
  assert.ok(g2.edges.some((e) => e.from === 't:0' && e.to === 'combine'), '变换应直连组合');
  // 悬空检查：每条边的两端都必须存在
  for (const g of [g1, g2, D.buildDag(MODEL())]) {
    const set = new Set(ids(g));
    for (const e of g.edges) {
      assert.ok(set.has(e.from) && set.has(e.to), `悬空连线：${e.from} → ${e.to}`);
    }
  }
});

test('派生：stats 如实统计，并识别等权', () => {
  const eq = D.buildDag(MODEL({ factors: [{ id: 'a', expr: 'mom20', weight: 1 }, { id: 'b', expr: 'mom60', weight: 1 }] }));
  assert.strictEqual(eq.stats.equalWeight, true);
  const ne = D.buildDag(MODEL());
  assert.strictEqual(ne.stats.equalWeight, false);
  assert.strictEqual(D.buildDag(MODEL()).stats.factors, 2);
});

// ═══ 二、编辑 ══════════════════════════════════════════════════

test('编辑：改权重生效，且**不改入参**', () => {
  const m = MODEL();
  const snap = JSON.parse(JSON.stringify(m));
  const r = D.applyEdit(m, { type: 'setFactorWeight', id: 'f:mom20', value: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.model.factors[0].weight, 3);
  assert.deepStrictEqual(m, snap, '🔴 applyEdit 不得改入参（纯函数）');
  assert.notStrictEqual(r.model, m, '返回值必须是新对象');
});

test('🔴 编辑：方向 auto ⇒ **删除** direction 键（不得写 1/-1）', () => {
  const m = MODEL({ factors: [{ id: 'rev60', expr: 'rev60', weight: 1, direction: -1 }] });
  const r = D.applyEdit(m, { type: 'setFactorDirection', id: 'f:rev60', value: 'auto' });
  assert.strictEqual(r.ok, true);
  assert.ok(!('direction' in r.model.factors[0]), 'auto 必须删键——写死会固化此刻推导结果、改名不再跟随');
  // 显式值正常写入
  const r2 = D.applyEdit(m, { type: 'setFactorDirection', id: 'f:rev60', value: 1 });
  assert.strictEqual(r2.model.factors[0].direction, 1);
});

test('编辑：增删因子（可选项取自规范，重复与超限被拒）', () => {
  const m = MODEL({ factors: [{ id: 'mom20', expr: 'mom20', weight: 1 }] });
  const add = D.applyEdit(m, { type: 'addFactor', expr: 'mom60' });
  assert.strictEqual(add.ok, true);
  assert.strictEqual(add.model.factors.length, 2);
  assert.strictEqual(D.applyEdit(m, { type: 'addFactor', expr: 'mom60' }).ok, true);
  // 重复
  assert.strictEqual(D.applyEdit(add.model, { type: 'addFactor', expr: 'mom60' }).ok, false, '重复因子应被拒');
  // 非预置
  assert.strictEqual(D.applyEdit(m, { type: 'addFactor', expr: 'my_hack' }).ok, false, '非预置因子应被拒（白名单）');
  // 超限：注意 PRESET_FACTORS(6) < LIMITS.maxFactors(8) ⇒ 白名单下"加满上限"其实做不到，
  // 这里直接构造一个满额模型来验证**上限守卫**本身有效。
  const full = { ...m, factors: Array.from({ length: LIMITS.maxFactors }, (_, i) => ({ id: `x${i}`, expr: 'mom20', weight: 1 })) };
  assert.strictEqual(full.factors.length, LIMITS.maxFactors);
  assert.strictEqual(D.applyEdit(full, { type: 'addFactor', expr: 'mom60' }).ok, false, '超上限应被拒');
  // 留档事实：白名单比上限更紧 ⇒ 用户实际可选的因子数是 6 而非 8
  assert.ok(PRESET_FACTORS.length <= LIMITS.maxFactors, '预置因子数不应超过上限');
  assert.strictEqual(PRESET_FACTORS.length, 6, '当前预置因子为 6 个（低于上限 8，白名单更紧）');
  // 至少留一个
  assert.strictEqual(D.applyEdit(m, { type: 'removeFactor', id: 'f:mom20' }).ok, false, '不能删到零个因子');
  // 正常删
  const rm = D.applyEdit(add.model, { type: 'removeFactor', id: 'f:mom60' });
  assert.strictEqual(rm.ok, true);
  assert.strictEqual(rm.model.factors.length, 1);
});

test('🔴 编辑：越界值在**编辑期**被拒（不等点保存才报错）', () => {
  const m = MODEL();
  const cases = [
    [{ type: 'setFactorWeight', id: 'f:mom20', value: LIMITS.maxWeight + 1 }, '权重超上限'],
    [{ type: 'setFactorWeight', id: 'f:mom20', value: -1 }, '负权重'],
    [{ type: 'setFactorWeight', id: 'f:mom20', value: 'abc' }, '非数值'],
    [{ type: 'setBacktest', key: 'groups', value: LIMITS.maxGroups + 1 }, '组数超上限'],
    [{ type: 'setBacktest', key: 'groups', value: LIMITS.minGroups - 1 }, '组数低于下限'],
    [{ type: 'setBacktest', key: 'groups', value: 3.5 }, '组数非整数'],
    [{ type: 'setBacktest', key: 'rebalance', value: 'hourly' }, '非法调仓周期'],
    [{ type: 'removeFactor', id: 'f:不存在' }, '删不存在的因子'],
    [{ type: 'removeTransform', index: 99 }, '删不存在的变换'],
    [{ type: 'removeFilter', index: 99 }, '删不存在的过滤'],
    [{ type: '瞎写的动作' }, '未知动作'],
  ];
  for (const [edit, label] of cases) {
    const r = D.applyEdit(m, edit);
    assert.strictEqual(r.ok, false, `${label} 应被拒（收到 ${JSON.stringify(r).slice(0, 60)}）`);
    assert.ok(r.error && r.error.length > 0, `${label} 的失败必须带原因`);
  }
});

test('编辑：停用 = 从模型移除（不是打"禁用"标记）', () => {
  const m = MODEL();
  const r = D.applyEdit(m, { type: 'removeTransform', index: 0 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.model.transforms.length, 0, '停用即移除');
  assert.ok(!JSON.stringify(r.model).includes('"disabled"'), '不得引入规范之外的字段');
  const f = D.applyEdit(m, { type: 'removeFilter', index: 0 });
  assert.strictEqual(f.model.filters.length, 0);
});

test('编辑：回测参数可改，fee 开关接受 on/off/boolean', () => {
  const m = MODEL();
  assert.strictEqual(D.applyEdit(m, { type: 'setBacktest', key: 'rebalance', value: 'weekly' }).model.backtest.rebalance, 'weekly');
  assert.strictEqual(D.applyEdit(m, { type: 'setBacktest', key: 'groups', value: 8 }).model.backtest.groups, 8);
  assert.strictEqual(D.applyEdit(m, { type: 'setBacktest', key: 'fees', value: 'off' }).model.backtest.fees, false);
  assert.strictEqual(D.applyEdit(m, { type: 'setBacktest', key: 'fees', value: false }).model.backtest.fees, false);
  assert.strictEqual(D.applyEdit(m, { type: 'setBacktest', key: 'fees', value: 'on' }).model.backtest.fees, true);
});

test('编辑往返：改完再派生，图与模型一致（编辑真的落到 JSON 上）', () => {
  const m = MODEL();
  const edited = D.applyEdit(m, { type: 'setFactorWeight', id: 'f:mom20', value: 7 }).model;
  const g = D.buildDag(edited);
  assert.strictEqual(g.nodes.find((n) => n.id === 'f:mom20').sub, '权重 7', '图必须反映编辑结果');
  assert.strictEqual(D.dagStats(g).factors, 2);
});

test('编辑产物**仍是声明式 JSON**：可 JSON 序列化且不含函数', () => {
  const r = D.applyEdit(MODEL(), { type: 'setFactorWeight', id: 'f:mom20', value: 2 });
  const round = JSON.parse(JSON.stringify(r.model));
  assert.deepStrictEqual(round, r.model);
  // 不允许出现可执行内容
  const s = JSON.stringify(r.model);
  assert.ok(!/\bfunction\b|=>/.test(s), '产物不得含函数或箭头函数');
});

// ═══ 三、单一源一致性 ═════════════════════════════════════════

test('🔴 .mjs 转发壳与 .cjs 同源（前端按 .mjs 导入，行为必须一致）', async () => {
  const m = await import('../shared/modeldag.mjs');
  const a = MODEL();
  assert.deepStrictEqual(m.buildDag(a), D.buildDag(a));
  assert.deepStrictEqual(
    m.applyEdit(a, { type: 'setFactorWeight', id: 'f:mom20', value: 5 }),
    D.applyEdit(a, { type: 'setFactorWeight', id: 'f:mom20', value: 5 }),
  );
  assert.deepStrictEqual(m.PRESET_FACTORS, PRESET_FACTORS);
});

test('类型声明与实现同步（.d.mts 里声明的导出都真实存在）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dts = fs.readFileSync(path.join(__dirname, '..', 'shared', 'modeldag.d.mts'), 'utf8');
  for (const n of ['buildDag', 'applyEdit', 'dagStats', 'LIMITS', 'PRESET_FACTORS']) {
    assert.ok(new RegExp(`\\b${n}\\b`).test(dts), `.d.mts 缺 ${n}`);
    assert.ok(n in D, `实现缺导出 ${n}`);
  }
});
