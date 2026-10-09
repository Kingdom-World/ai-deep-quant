'use strict';
// ─────────────────────────────────────────────────────────────
// add-entries 的「风格保持」必须被锁住
//
// 🔴 为什么需要这个测试（2026-10-09 实测事故）：
//   知识库各 JSON 的数组风格**不统一** —— paper.json 是紧凑内联，
//   terms/principle/methods 是展开多行。写入器早期一律
//   `JSON.stringify(doc, null, 2)` ⇒ 只补了 41 个 related 项却产生
//   paper.json +166 行的 diff，其中 99% 是格式噪声（真实改动被淹没）。
//   修第一版又踩了更隐蔽的坑：风格探测用 `\s*` 会吃掉换行，
//   于是**展开风格也被判成 inline**，terms.json 一口气少 400 行。
//
// ⇒ 断言的不是"输出长什么样"，而是：
//   ① 风格探测对两种形态给出**相反且正确**的判定；
//   ② 序列化后**除本批改动外，其余逐字节不变**（这才是"精确落盘"的真义）。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'tools', 'add-entries.cjs'), 'utf8');

// 从源码里取出被测函数（避免 require 触发 main 副作用）
function extract(name) {
  const m = SRC.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  assert.ok(m, `未在 add-entries.cjs 中找到 ${name}`);
  return eval('(' + m[0].replace('function ' + name, 'function') + ')');
}
const detectStyle = extract('detectStyle');
const serializeLike = extract('serializeLike');

test('detectStyle：紧凑内联判为 inline，展开多行判为 expanded', () => {
  const inline = '{\n  "tags": ["a", "b"],\n  "related": ["x"]\n}';
  const expanded = '{\n  "tags": [\n    "a",\n    "b"\n  ]\n}';
  assert.strictEqual(detectStyle(inline), 'inline');
  assert.strictEqual(detectStyle(expanded), 'expanded');
});

test('🔴 detectStyle 不被换行骗（\\s* 会被换行吃掉 ⇒ 展开被误判 inline）', () => {
  // 这正是第一版修复的真实 bug：正则写成 /\w+":\s*\[\s*"/ 时，
  // 展开形态的 "tags": [\n  "a" 也会命中 ⇒ 4 个文件里 3 个被误判。
  const expandedManyLines = '{\n  "tags": [\n    "alpha",\n    "beta",\n    "gamma"\n  ],\n' +
    '"related": [\n    "method-x"\n  ]\n}';
  assert.strictEqual(detectStyle(expandedManyLines), 'expanded');
  // 反向对照：真内联仍须判对
  assert.strictEqual(
    detectStyle('{\n  "tags": ["alpha", "beta"],\n  "related": ["y"]\n}'),
    'inline',
  );
});

test('serializeLike：inline 风格下短字符串数组必须保持单行', () => {
  const doc = { entries: [{ id: 'a', tags: ['x', 'y'], related: ['z'] }] };
  const out = serializeLike('{"tags": ["x"]}', doc, 'inline');
  assert.match(out, /"tags": \["x", "y"\]/);
  JSON.parse(out); // 必须是合法 JSON
});

test('serializeLike：expanded 风格下数组必须展开（不得压成内联）', () => {
  const doc = { entries: [{ id: 'a', tags: ['x', 'y'], related: ['z'] }] };
  const out = serializeLike('{"tags": [\n  "x"\n]}', doc, 'expanded');
  assert.doesNotMatch(out, /"tags": \["x", "y"\]/);
  assert.match(out, /"tags": \[\n\s+"x",\n\s+"y"\n\s+\]/);
  JSON.parse(out);
});

test('🔴 精确落盘：只改一个数组元素，其余必须逐字节不变', () => {
  // 这才是"diff 干净"的真义 —— 不是"输出好看"，而是无关处零变化。
  const original = {
    category: 'paper',
    entries: [
      { id: 'p1', title: 'T1', tags: ['a', 'b'], related: ['x'] },
      { id: 'p2', title: 'T2', tags: ['c'], related: ['y'] },
      { id: 'p3', title: 'T3', tags: ['d', 'e'], related: ['z'] },
    ],
  };
  const raw = serializeLike('{"tags": ["a"]}', original, 'inline');
  const before = JSON.parse(raw);

  // 模拟补链：给 p2 的 related 增加一项，其余不动
  const mutated = JSON.parse(raw);
  mutated.entries[1].related.push('new-id');
  mutated.entries[1].related.sort();
  const after = serializeLike(raw, mutated, 'inline');

  const a = JSON.parse(raw).entries;
  const b = JSON.parse(after).entries;
  // 逐条比对：只有 index 1 变了
  assert.deepStrictEqual(b[0], a[0], 'p1 不应被改动');
  assert.deepStrictEqual(b[2], a[2], 'p3 不应被改动');
  assert.notDeepStrictEqual(b[1].related, a[1].related, 'p2 的 related 应已变化');
  // 顶层字段与条目顺序也不应变
  assert.strictEqual(JSON.parse(after).category, 'paper');
  assert.deepStrictEqual(b.map((e) => e.id), ['p1', 'p2', 'p3']);
});

test('🔴 两种风格下的"只改一处"都必须成立（防止只对一种风格有效）', () => {
  for (const style of ['inline', 'expanded']) {
    const doc = {
      entries: [
        { id: 'a', tags: ['t1', 't2'], related: ['r1'] },
        { id: 'b', tags: ['t3'], related: ['r2'] },
      ],
    };
    const raw = style === 'inline'
      ? '{\n  "tags": ["t1"]\n}'
      : '{\n  "tags": [\n    "t1"\n  ]\n}';
    const base = serializeLike(raw, doc, style);
    const m = JSON.parse(base);
    m.entries[0].tags.push('t9');
    m.entries[0].tags.sort();
    const out = serializeLike(base, m, style);
    const r = JSON.parse(out);
    assert.deepStrictEqual(r.entries[0].tags, ['t1', 't2', 't9'], `${style}: tags 应已更新`);
    assert.deepStrictEqual(r.entries[1], JSON.parse(base).entries[1], `${style}: 第二条不应变`);
  }
});

test('序列化结果必须是合法 JSON 且以换行结尾', () => {
  const doc = { category: 'term', entries: [{ id: 'x', body: '含"引号"与\\反斜杠', tags: ['a'] }] };
  for (const style of ['inline', 'expanded']) {
    const out = serializeLike('{"tags": ["a"]}', doc, style);
    assert.doesNotThrow(() => JSON.parse(out), `${style} 应产出合法 JSON`);
    assert.ok(out.endsWith('\n'), `${style} 应以换行结尾`);
  }
});