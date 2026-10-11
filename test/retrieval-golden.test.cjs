'use strict';
// ─────────────────────────────────────────────────────────────
// 知识库检索质量**回归护栏**（跑在 CI 里）
//
// 🔴 为什么是这个形态：
//   `shared/retrieval-metrics.cjs` 提供指标，但指标本身不拦任何东西。
//   本文件把**人工给定的黄金集**（查询 → 期望命中条目 id）变成断言，
//   让「改检索逻辑 / 改分词 / 改排序 / 加条目」这些动作**一旦让检索变差就红**。
//
// 🔴 三条纪律：
//   ① **不硬编码指标绝对值**（如「P@5 必须= 1.0」）—— 那会在知识库扩容时合法地红。
//      只断言两件事：**期望条目必须被召回**（下限）、**且在前的必须是相关条目**（序）。
//      理由与既有约定一致（见test 里"禁硬编码绝对数量"那条）。
//   ② **黄金集用「用户真会打的字」**，不是条目标题。
//      2026-10-10 首版用标题当查询，全 P@5=1.0 ⇒ 测不出任何东西（假护栏）。
//      改用竞品词/俗语后才抓到真缺陷（见下）。
//   ③ verdict 是**规则代理判定**，这些断言防的是「召回退化」，不是「相关性正确」。
//
// 🔴 本文件抓到过的真实缺陷（留档，勿删）：
//   「怎么防止未来函数」→ R@5 = 0，完全召不回。
//   根因：库里标题写「前视偏差」，用户说「未来函数」；且 tags 只有 `look-ahead`
//   （带连字符）⇒ 搜 `lookahead` 断开。修法是**补 tags 别名**，
//   **不改检索逻辑**（检索本已匹配 tags，权重 6）—— 数据修数据，符合单一源纪律。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const knowledge = require(path.join(ROOT, 'server', 'knowledge.cjs'));
const M = require(path.join(ROOT, 'shared', 'retrieval-metrics.cjs'));

/**
 * 黄金集：**刻意用竞品词与俗语**，不用条目标题。
 * expect 只写「必须被召回的那几条」，不强求顺序。
 * 🔴 `topN` = 该问题允许 top1 不命中的条数。
 *   起因：「PIT 是什么」的 top1 曾是 basis 层（本项目财务 PIT 实现）、
 *   top2 才是 term 层（PIT 定义）——**两条都是好答案**，
 *   强行定谁第一属主观偏好，**不该为它改全局排序逻辑**（用户 2026-10-10 裁定）。
 *   ⇒ 放宽为「两条都必须进 top2」。
 */
const GOLDEN = [
  //—— 同义/俗语：库里写「前视偏差」，用户说「未来函数」——
  { q: '怎么防止未来函数', terms: ['未来函数'], expect: ['method-lookahead', 'method-lookahead-audit'] },
  { q: '未来函数', terms: ['未来函数'], expect: ['method-lookahead'] },
  // —— 连字符差异：库里 look-ahead，用户打 lookahead（实测曾召不回）——
  { q: 'lookahead', terms: ['lookahead'], expect: ['method-lookahead'] },
  // —— 定义类提问：term（定义）与 basis（本项目实现）**都算对**——
  { q: 'PIT 是什么', terms: ['pit'], expect: ['term-pit', 'basis-financial-pubdate'], topN: 2 },
  // —— 标题直接命中（最简单的一档，回归底线）——
  { q: '夏普比率', terms: ['夏普'], expect: ['term-sharpe'] },
  { q: '最大回撤怎么算', terms: ['最大回撤'], expect: ['term-maxdrawdown'] },
  { q: '换手率多少合适', terms: ['换手'], expect: ['term-turnover'] },
  // —— 概念性提问，期望落在原理层 ——
  { q: '相关性高是不是分散就没用了', terms: ['相关', '分散'], expect: ['principle-diversification'] },
];

test('🔴 黄金集：期望条目必须被召回（防检索退化）', () => {
  const failures = [];
  for (const c of GOLDEN) {
    const row = M.evaluateQuery(knowledge, { query: c.q, terms: c.terms, k: 5, expectedIds: c.expect });
    const missed = (row.missingIds || []).filter((id) => c.expect.includes(id));
    if (missed.length) failures.push(`「${c.q}」召不回：${missed.join(', ')}（实际 top3: ${row.ids.slice(0, 3).join(', ')}）`);
  }
  assert.deepStrictEqual(failures, [],
    '检索回归（期望条目未进入 top5）：\n    ' + failures.join('\n    '));
});

test('🔴 黄金集：期望条目必须进入前 N 名（防排序退化）', () => {
  // 断言「最相关条目不许掉出 topN」，默认 N=1。
  // topN>1 的用例表示**多个条目都算正确答案**（如定义类问题里
  // 「术语定义」与「本项目实现」都可接受）—— 见文件头说明。
  const failures = [];
  for (const c of GOLDEN) {
    const row = M.evaluateQuery(knowledge, { query: c.q, terms: c.terms, k: 5 });
    const n = c.topN || 1;
    const head = row.ids.slice(0, n);
    const ok = c.expect.some((id) => head.includes(id));
    if (!ok) {
      failures.push(`「${c.q}」期望 ${JSON.stringify(c.expect)} 之一进入 top${n}，实际 top${n}: ${head.join(', ') || '(空)'}`);
    }
  }
  assert.deepStrictEqual(failures, [],
    '排序回归（最相关条目掉出允许范围）：\n    ' + failures.join('\n    '));
});

test('🔴 黄金集：不应命中「仅正文偶然提及」的弱相关条目', () => {
  // 背景：2026-10-10 首轮实测里，「怎么防止未来函数」曾返回
  //   method-robust-regression（正文里提到过相关字眼，但条目本身与问题无关）。
  // 断言：稳健回归的**主标题**与本问题无关，因此不应进 top1。
  const row = M.evaluateQuery(knowledge, { query: '怎么防止未来函数', terms: ['未来函数'], k: 5 });
  assert.ok(row.ids[0] !== 'method-robust-regression',
    '未来函数问题的 top1 不应是稳健回归（弱相关靠正文偶然提及挤进首位）');
});

test('黄金集自身健全性：每条都得有 query/terms/expect 且 id 真实存在', () => {
  const ids = new Set();
  for (const f of ['terms', 'methods', 'principle', 'case', 'cycle', 'basis', 'paper']) {
    const doc = require(path.join(ROOT, 'server', 'knowledge', f + '.json'));
    for (const e of doc.entries) ids.add(e.id);
  }
  assert.ok(GOLDEN.length >= 6, '黄金集不应少于 6 条（太少测不出退化）');
  for (const c of GOLDEN) {
    assert.ok(c.q && Array.isArray(c.terms) && c.terms.length, `用例缺 query/terms：${JSON.stringify(c)}`);
    assert.ok(Array.isArray(c.expect) && c.expect.length, `用例缺 expect：${c.q}`);
    for (const id of c.expect) {
      assert.ok(ids.has(id), `黄金集引用了不存在的 id：${id}（知识库改名后要同步更新黄金集）`);
    }
  }
});

test('指标汇总可用于趋势对比（同一黄金集两次跑结果应一致）', () => {
  const run = () => M.aggregate(
    GOLDEN.map((c) => M.evaluateQuery(knowledge, { query: c.q, terms: c.terms, k: 5, expectedIds: c.expect })),
  );
  const a = run();
  const b = run();
  assert.strictEqual(a.queries, GOLDEN.length);
  // 检索是纯函数（无随机、无时间依赖）⇒ 两次跑必须完全一致
  assert.deepStrictEqual(a, b, '检索指标必须可复现 —— 不可复现则护栏无意义');
  // 当前基线（仅记录，不作为断言；断言在上面的召回/排序两条）
  console.log(`    [基线] P@5=${a.meanPrecisionAtK.toFixed(3)}AP=${a.meanAveragePrecision.toFixed(3)} R@5=${a.meanRecallAtK.toFixed(3)}`);
});