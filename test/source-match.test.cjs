// 出处匹配判定的单一源契约（2026-10-08 审查发现的分叉）
//
// 🔴 这条测试防的是**已发生过的分叉**：`titleSim` 曾在
//    tools/verify-sources.cjs 与 tools/backfill-doi.cjs 各写一份（逐字相同）。
//    当前一致 ≠ 将来一致 —— 而这两个工具用的是**相反方向**的同一把尺：
//      · verify-sources 用它"事后抓错 DOI"
//      · backfill-doi  用它"事前决定要不要写 DOI"
//    尺子一旦不一致，会出现"backfill 写进去、verify 又报错"的自相矛盾，
//    而两个工具各自都"看起来对"，排查极难定位。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SM = require('../shared/source-match.cjs');
const backfill = require('../tools/backfill-doi.cjs');

test('🔴 两工具必须用同一把尺（防止各自再定义一份）', () => {
  // 源码级检查：两个 tools 都不得**再定义** titleSim / SIM_GATE
  for (const f of ['tools/verify-sources.cjs', 'tools/backfill-doi.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/^function titleSim\s*\(/m.test(src),
      `${f} 不得再自己定义 titleSim —— 必须 require shared/source-match.cjs`);
    assert.ok(!/^const SIM_GATE\s*=/m.test(src),
      `${f} 不得再自己定义 SIM_GATE —— 阈值必须单一源`);
    assert.match(src, /source-match\.cjs/, `${f} 必须引用单一源`);
  }
});

test('backfill 导出的 titleSim/SIM_GATE 就是单一源的那份（同引用）', () => {
  assert.strictEqual(backfill.titleSim, SM.titleSim, '必须是同一个函数引用，不是副本');
  assert.strictEqual(backfill.SIM_GATE, SM.SIM_GATE);
  assert.strictEqual(SM.SIM_GATE, 0.75, '阈值改动必须是有意识的（且只改一处）');
});

test('titleSim：Jaccard 词级，边界行为明确', () => {
  assert.strictEqual(SM.titleSim('Efficient Capital Markets', 'efficient capital markets'), 1);
  assert.strictEqual(SM.titleSim('', 'x'), 0);
  assert.strictEqual(SM.titleSim('a', ''), 0);
  assert.strictEqual(SM.titleSim(null, undefined), 0, '空值不抛异常');
  const partial = SM.titleSim('Returns to Buying Winners and Selling Losers',
    'Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency');
  assert.ok(partial > 0.4 && partial < 1, `部分重叠应给中间分，实际 ${partial}`);
});

test('titleEquivalent：副标题关系必须等价（Ang 书的实测形状）', () => {
  assert.strictEqual(SM.titleEquivalent(
    'Asset Management: A Systematic Approach to Factor Investing', 'Asset Management'), true);
  assert.strictEqual(SM.titleEquivalent('X', 'X'), true);
  assert.strictEqual(SM.titleEquivalent('Momentum', 'Reversal'), false);
  assert.strictEqual(SM.titleEquivalent('', 'X'), false, '空值不判等价');
});

test('titleEquivalent：不能把"同一刊里的两篇不同论文"判成等价', () => {
  // 前缀关系必须**逐词**成立，不能是任意子串
  assert.strictEqual(SM.titleEquivalent('The Cross-Section of Expected Returns',
    'The Cross-Section of Expected Returns: Where We Stand Today'), true, '副标题关系应等价');
  assert.strictEqual(SM.titleEquivalent('Momentum Strategies', 'Momentum'),
    true, '前缀关系成立（逐词）');
  assert.strictEqual(SM.titleEquivalent('Market Liquidity and Funding Liquidity',
    'Market Liquidity'), true);
});
