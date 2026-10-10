'use strict';
// ─────────────────────────────────────────────────────────────
// 检索质量指标测试
//
// 🔴 关键一条：`averagePrecision` 必须与借鉴来源 ragas 的
//   `_calculate_average_precision` **同构** —— 用同一组 verdicts 手算比对。
//   「借鉴」必须留下可核对的证据，否则下一任会怀疑公式被改错了。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'shared', 'retrieval-metrics.cjs'));
const knowledge = require(path.join(ROOT, 'server', 'knowledge.cjs'));

// ── 公式：与 ragas 同构验证 ──
test('averagePrecision：与 ragas 同构（手算比对，非"看着对"）', () => {
  // ragas 的算法：cumsum 累加命中数；每次命中把 cumsum/(i+1) 加进分子；
  //   最终 分子 / cumsum。
  // 场景A：命中在第1、3 位（1-based），共 2 条命中，检索长度 4
  //   cumsum: i=0 →1 → 分子 += 1/1 = 1.0
  //   i=1 → 未命中
  //   i=2 → cumsum=2 → 分子 += 2/3 ≈ 0.6667
  //   i=3 → 未命中
  //   AP = 1.6667 / 2 = 0.83333
  assert.ok(Math.abs(M.averagePrecision([true, false, true, false]) - 5 / 6) < 1e-9,
    `期望 5/6≈0.8333，实际 ${M.averagePrecision([true, false, true, false])}`);

  // 场景 B：全部命中且只有 2 条 ⇒ AP = 1（完美排序）
  assert.ok(Math.abs(M.averagePrecision([true, true]) - 1) < 1e-9);

  // 场景 C：全不命中 ⇒ 0
  assert.strictEqual(M.averagePrecision([false, false, false]), 0);

  // 场景 D：命中全部排在后面（最差排序）⇒ 明显低于 1
  const worst = M.averagePrecision([false, false, true]);
  assert.ok(worst < 0.5 && worst > 0, `全不命中为 0、命中垫底应介于 0 与 0.5：${worst}`);

  // 场景 E：空输入不得抛
  assert.strictEqual(M.averagePrecision([]), 0);
  assert.strictEqual(M.averagePrecision(null), 0);
});

test('🔴 averagePrecision 对排序敏感（这是它比 precision@k 强的地方）', () => {
  const hitFirst = M.averagePrecision([true, false, false, true]);
  const hitLast = M.averagePrecision([false, false, true, true]);
  assert.ok(hitFirst > hitLast,
    `命中在前的AP 必须更高：${hitFirst} vs ${hitLast}`);
  // 而 precision@k 对二者无差别 ⇒ 正好说明为什么两个指标都要有
  assert.strictEqual(M.precisionAtK([true, false, false, true], 4),
    M.precisionAtK([false, false, true, true], 4));
});

test('precisionAtK：只看前 k，且空数组不炸', () => {
  assert.strictEqual(M.precisionAtK([true, false, true], 2), 0.5);
  assert.strictEqual(M.precisionAtK([true, true], 5), 1);   // 分母是实际返回条数
  assert.strictEqual(M.precisionAtK([], 5), 0);
});

// ── 规则版 verdict（替代 ragas 的 LLM 判定）──
test('verdictFor：标题命中 / tags 命中 / 正文命中 三级', () => {
  const byTitle = { title: '动量崩溃与反转', tags: [], body: '正文提到别的东西' };
  const byTag = { title: '无关标题', tags: ['动量因子'], body: '' };
  const byBody = { title: '无关标题', tags: [], body: '本文讨论动量崩溃的机制' };
  assert.strictEqual(M.verdictFor(byTitle, ['动量']), true);
  assert.strictEqual(M.verdictFor(byTag, ['动量']), true);
  assert.strictEqual(M.verdictFor(byBody, ['动量']), true);
});

test('verdictFor：全不命中与边界输入', () => {
  assert.strictEqual(M.verdictFor({ title: 'abc', tags: [], body: 'xyz' }, ['动量']), false);
  assert.strictEqual(M.verdictFor(null, ['动量']), false);
  assert.strictEqual(M.verdictFor({ title: 'x' }, []), false, '空词项不得全判相关');
  assert.strictEqual(M.verdictFor({ title: 'x' }, null), false);
});

test('🔴 verdict 判定是纯函数（不含网络/LLM，可离线复现）', () => {
  const src = require('node:fs').readFileSync(
    path.join(ROOT, 'shared', 'retrieval-metrics.cjs'), 'utf8');
  // ⚠️ 先剥注释再扫：注释里会解释"为什么不用 LLM"，那正是本文件要说的，
  //   扫全文会误报自己（第一次跑就误报了一次）。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/\bfetch\s*\(|\baxios\b|require\(['"]openai/i.test(code),
    '检索指标必须零出网、零 LLM —— 这是它能进 CI 的前提');
});

// ── 端到端：跑真实知识库 ──
test('端到端：对真实知识库跑检索并产出指标', () => {
  const spec = {
    query: '动量崩溃',
    terms: ['动量', '崩溃'],
    k: 5,
    expectedIds: ['method-momentum-crash'],
  };
  // ⚠️ 传**整个模块**而不是 knowledge.search ——
  //   evaluateQuery 内部按 `kb.search(...)` 取方法，
  //   传函数本身会导致 `fn.search is not a function`（第一次跑就踩了）。
  const row = M.evaluateQuery(knowledge, spec);
  assert.ok(row.returned > 0, '真实知识库应能检索到条目');
  assert.ok(row.precisionAtK >= 0 && row.precisionAtK <= 1);
  assert.ok(row.averagePrecision >= 0 && row.averagePrecision <= 1);
  // 我们刚写的动量崩溃条目必须能被"动量崩溃"检索到（自己也验证召回）
  assert.ok(row.ids.includes('method-momentum-crash'),
    `应召回 method-momentum-crash，实际召回：${row.ids.join(', ')}`);
  assert.ok(row.recallAtK > 0, '黄金集命中应产生 recall');
});

test('aggregate：多次评估取 macro 平均', () => {
  const agg = M.aggregate([
    { precisionAtK: 1, averagePrecision: 1, recallAtK: 1 },
    { precisionAtK: 0, averagePrecision: 0, recallAtK: 0 },
  ]);
  assert.strictEqual(agg.queries, 2);
  assert.strictEqual(agg.meanPrecisionAtK, 0.5);
  assert.strictEqual(agg.meanAveragePrecision, 0.5);
  assert.strictEqual(agg.meanRecallAtK, 0.5);
  assert.deepStrictEqual(M.aggregate([]), { queries: 0 });
});

test('aggregate：无recall 字段时不得凭空造 meanRecallAtK', () => {
  const agg = M.aggregate([{ precisionAtK: 1, averagePrecision: 1 }]);
  assert.ok(!('meanRecallAtK' in agg),
    '没有黄金集时不应输出 recall（否则会被误读成"检索准确率"）');
});

test('🔴 指标文件必须明说 verdict 是代理判定而非 ground truth', () => {
  const src = require('node:fs').readFileSync(
    path.join(ROOT, 'shared', 'retrieval-metrics.cjs'), 'utf8');
  assert.match(src, /代理判定/,
    '必须写清 verdict 是规则代理判定，否则指标会被当成准确率宣传');
  assert.match(src, /不适合宣称|回归护栏/,
    '必须写清适用边界（回归护栏，不是准确率）');
});