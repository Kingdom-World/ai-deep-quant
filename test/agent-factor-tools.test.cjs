'use strict';
// ─────────────────────────────────────────────────────────────
// Agent 工具 list_factors / check_factor_expr 测试（Phase 3 · 查因子 + 表达式沙箱）
//
// 两个工具的共同前提：**零 deps**（数据全部来自纯函数模块的静态常量），
// 所以测试里 `createToolbox({})` 就能跑 —— 这也是一道契约：
// 若将来有人给它们加了外部依赖，这些断言会立刻暴露。
//
// 🔴 三条关键约束：
//   ① **单一源**：因子清单必须来自 `crosssect.FACTOR_WINDOWS`、算子来自 `factorexpr.OPS`，
//      测试**对照源码常量**断言，而不是硬编码数字 —— 防止"口径第二副本"
//      （未来扩容因子时，硬编码的 6 会让人被迫改测试，最终习惯性忽略断言）。
//   ② **方向判定必须保守**：`mom60 - mom20` 这类同类相减必须判为"不定"。
//      实测教训（factorexpr.cjs 注释）：判成 momentum 会让分层输出
//      「因子方向与策略相反，继续按此方向选股将系统性亏损」—— **方向本身就是错的结论**。
//   ③ **校验器不计算数值**：输出必须明确声明这一点，否则模型会以为它验过效果。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createToolbox } = require(path.join(__dirname, '..', 'server', 'agent', 'toolbox.cjs'));
const crosssect = require(path.join(__dirname, '..', 'server', 'crosssect.cjs'));
const factorexpr = require(path.join(__dirname, '..', 'server', 'factorexpr.cjs'));

/** 两个工具都不需要 deps */
const tb = () => createToolbox({});
const factorTool = () => tb().tools.find((t) => t.name === 'list_factors');
const exprTool = () => tb().tools.find((t) => t.name === 'check_factor_expr');

test('契约：两个工具都在 spec 中，参数声明正确', () => {
  const spec = tb().spec;
  const lf = spec.find((s) => s.name === 'list_factors');
  const ce = spec.find((s) => s.name === 'check_factor_expr');
  assert.ok(lf, 'spec 必须含 list_factors');
  assert.deepStrictEqual(lf.params, [], 'list_factors 不需要参数');
  assert.ok(ce, 'spec 必须含 check_factor_expr');
  assert.deepStrictEqual(ce.params.map((p) => p.name), ['expr']);
  assert.strictEqual(ce.params[0].required, true);
});

test('🔴 零 deps：不传任何依赖也能工作（数据来自静态常量）', async () => {
  const a = await factorTool().run({});
  assert.strictEqual(a.ok, true, 'list_factors 不应依赖注入');
  const b = await exprTool().run({ expr: 'mom20' });
  assert.strictEqual(b.ok, true, 'check_factor_expr 不应依赖注入');
});

test('🔴 单一源：因子数/名称必须与 crosssect.FACTOR_WINDOWS 一致（不得硬编码）', async () => {
  const r = await factorTool().run({});
  const expected = Object.keys(crosssect.FACTOR_WINDOWS);
  assert.strictEqual(r.data.factors.length, expected.length,
    `因子数应与 FACTOR_WINDOWS 一致（源码 ${expected.length} 个），实际 ${r.data.factors.length}`);
  assert.deepStrictEqual(r.data.factors.map((f) => f.name), expected);
  // 窗口也要对得上
  for (const f of r.data.factors) {
    assert.strictEqual(f.window, crosssect.FACTOR_WINDOWS[f.name], `${f.name} 的窗口应与源码一致`);
  }
});

test('🔴 单一源：算子清单必须与 factorexpr.OPS 一致', async () => {
  const r = await factorTool().run({});
  assert.deepStrictEqual([...r.data.ops].sort(), Object.keys(factorexpr.OPS).sort());
});

test('list_factors 输出含上限常量（与源码一致）与示例', async () => {
  const r = await factorTool().run({});
  assert.match(r.summary, new RegExp(`窗口 ≤ ${factorexpr.MAX_WINDOW}`));
  assert.match(r.summary, new RegExp(`长度 ≤ ${factorexpr.MAX_LEN}`));
  assert.match(r.summary, /mom60 - mom20/, '应给出可直接抄的示例');
  assert.match(r.summary, /不是 eval|白名单/, '应说明是白名单 AST 而非 eval');
  assert.match(r.summary, /默认评估集/);
});

test('list_factors 声明方向判定规则（含"宁可不判"）', async () => {
  const r = await factorTool().run({});
  assert.match(r.summary, /方向不定/);
  assert.match(r.summary, /宁可不判|不猜/, '必须表明保守立场');
});

test('🔴 方向判定：mom 类 → momentum，rev 类 → reversal', async () => {
  const a = await exprTool().run({ expr: 'mom20' });
  assert.strictEqual(a.data.direction, 'momentum');
  const b = await exprTool().run({ expr: 'rev60' });
  assert.strictEqual(b.data.direction, 'reversal');
});

test('🔴 方向判定保守：同类相减 `mom60 - mom20` 必须为 null（不得判成 momentum）', async () => {
  const r = await exprTool().run({ expr: 'mom60 - mom20' });
  assert.strictEqual(r.data.direction, null,
    '长动量减短动量经济含义近似反转，判成 momentum 会给出与策略相反的结论');
  assert.match(r.summary, /不定/);
});

test('🔴 方向判定保守：mom + rev 混合 → null', async () => {
  const r = await exprTool().run({ expr: 'mom20 + rev20' });
  assert.strictEqual(r.data.direction, null);
});

test('方向判定保守：含非线性算子（vol 等）→ null', async () => {
  const r = await exprTool().run({ expr: 'vol20' });
  assert.strictEqual(r.data.direction, null, 'vol 与动量方向无关，不应猜');
});

test('返回所需最大窗口（供上层判断热身长度）', async () => {
  const r = await exprTool().run({ expr: 'mom120 + mom20' });
  assert.strictEqual(r.data.maxWindow, 120);
  assert.match(r.summary, /120 个交易日/);
});

test('🔴 明确声明"不计算数值"（否则模型会以为验过效果）', async () => {
  const r = await exprTool().run({ expr: 'mom20' });
  assert.match(r.summary, /不计算|只校验语法/, '必须说明不含数值计算');
  assert.match(r.summary, /factor_ic/, '应引导到真正能验证预测力的工具');
});

test('非法表达式：未知算子 ⇒ fail，且列出可用算子', async () => {
  const r = await exprTool().run({ expr: 'foo(20)' });
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /未知算子|不合法/);
  assert.match(r.summary, /mom/, '错误信息应给出可用算子');
});

test('非法表达式：窗口超上限 ⇒ fail 并指出上限', async () => {
  const r = await exprTool().run({ expr: `mom${factorexpr.MAX_WINDOW + 1}` });
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, new RegExp(String(factorexpr.MAX_WINDOW)));
});

test('非法表达式：空串 / 空白 ⇒ fail 并给示例', async () => {
  for (const v of ['', '   ']) {
    const r = await exprTool().run({ expr: v });
    assert.strictEqual(r.ok, false);
    assert.match(r.summary, /不能为空/);
  }
});

test('非法表达式：纯常数（未引用算子）⇒ fail（无选股意义）', async () => {
  const r = await exprTool().run({ expr: '42' });
  assert.strictEqual(r.ok, false);
});

test('返回带 dataFingerprint（供编排层幂等判定）', async () => {
  const a = await factorTool().run({});
  assert.ok(a.dataFingerprint);
  const b = await exprTool().run({ expr: 'mom20' });
  assert.ok(b.dataFingerprint);
  const c = await exprTool().run({ expr: 'mom20' });
  assert.deepStrictEqual(b.dataFingerprint, c.dataFingerprint, '同表达式指纹应稳定');
});
