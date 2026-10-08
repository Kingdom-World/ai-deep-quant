// 书籍核验工具测试（阶段 2 · B）
//
// 🔴 这个工具的核心风险是**变成"看起来在工作"的装饰**：
//    书籍不像期刊那样能被普遍机器核验（Crossref 只覆盖注册 DOI 的专著）。
//    所以测试重点不是"能查到书"，而是：
//      ① ISBN 归一必须可靠（连字符/空格/X 大小写）
//      ② 查不到时**如实说不覆盖**，不许退化成"猜一个"
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normIsbn } = require('../tools/verify-books.cjs');

test('normIsbn：去连字符与空格', () => {
  assert.strictEqual(normIsbn('978-1119482086'), '9781119482086');
  assert.strictEqual(normIsbn('978 1119 482086'), '9781119482086');
  assert.strictEqual(normIsbn('  978-0199959327  '), '9780199959327');
});

test('normIsbn：校验位 X 要大写（ISBN-10 常见）', () => {
  assert.strictEqual(normIsbn('0-8044-2957-x'), '080442957X');
  assert.strictEqual(normIsbn('080442957X'), '080442957X');
});

test('normIsbn：空值/非字符串不抛异常', () => {
  for (const v of ['', null, undefined, 123, {}]) {
    assert.strictEqual(typeof normIsbn(v), 'string');
  }
});

test('normIsbn：不同写法归一后相等（否则精确命中会失效）', () => {
  const forms = ['978-1119482086', '9781119482086', '978 1119 482086'];
  const normed = forms.map(normIsbn);
  assert.strictEqual(new Set(normed).size, 1, '三种写法必须归一到同一个值');
});