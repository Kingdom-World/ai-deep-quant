'use strict';
// ─────────────────────────────────────────────────────────────
// test/helpers/source-scan.cjs 的单元测试
//
// 🔴 为什么工具本身也要测：
//   它是「给测试用的工具」—— 一旦它有 bug，**用它的测试会集体假绿**，
//   而且假绿极难发现（绿的就是绿的，不会引起注意）。
//   尤其 `stripComments` 剥错东西时，断言会扫到不该扫的文本，静默失效。
//
//   ⚠️ 放在 test/ 顶层（而非 test/helpers/）是**有意的**：
//     CI 跑的是 `node --test test/*.test.cjs`，只匹配顶层文件。
//     若放进 helpers 子目录，这个测试**根本不会被执行**。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { stripComments, extractRoutePaths, extractLinkTargets } =
  require(path.join(__dirname, 'helpers', 'source-scan.cjs'));

test('stripComments：剥掉块注释与行注释', () => {
  const src = 'const a = 1; /* 块注释含 <Navigate /> */\nconst b = 2; // 行注释含 <Navigate />\nconst c = 3;';
  const out = stripComments(src);
  assert.ok(out.includes('const a = 1;'), '块注释前的代码应保留');
  assert.ok(out.includes('const b = 2;'), '行注释前的代码应保留');
  assert.ok(out.includes('const c = 3;'), '注释后的代码应保留');
  assert.ok(!out.includes('<Navigate'), '两条注释里的关键词都应被剥掉');
});

test('🔴 stripComments 不得误剥 URL 里的 //（最容易犯的错）', () => {
  // 若把 `https://` 的 `//` 当行注释起点，URL 会被从中间截断，
  // 依赖它的断言会静默失效。这是本模块特意用 `[^:]` 前缀断言规避的情况。
  const src = "const u = 'https://api.example.com/v1';\nconst v = 1;";
  const out = stripComments(src);
  assert.ok(out.includes('https://api.example.com/v1'),
    `URL 不应被截断，实际输出：${out}`);
  assert.ok(out.includes('const v = 1;'), 'URL 之后的代码不应被吞掉');
});

test('stripComments：JSDoc 也应被剥（它同样是注释）', () => {
  const src = '/**\n * @desc 含 <Navigate 的说明\n */\nconst x = 1;';
  const out = stripComments(src);
  assert.ok(!out.includes('<Navigate'), 'JSDoc 内容应被剥掉');
  assert.ok(out.includes('const x = 1;'));
});

test('stripComments：空输入与无注释输入不应抛错', () => {
  assert.strictEqual(stripComments(''), '');
  assert.strictEqual(stripComments('const a = 1;'), 'const a = 1;');
  assert.strictEqual(stripComments(null), '');
  assert.strictEqual(stripComments(undefined), '');
});

test('extractRoutePaths：提取静态路由 path', () => {
  const src = `
    <Route path="/" element={<A />} />
    <Route path="/stock/:symbol" element={<B />} />
    <Route path="*" element={<NotFoundPage />} />
    {/* <Route path="/commented" element={<C />} /> */}
  `;
  const got = extractRoutePaths(src);
  assert.ok(got.has('/'), '应含 /');
  assert.ok(got.has('/stock/:symbol'), '应含动态段');
  assert.ok(got.has('*'), '应含通配');
  assert.ok(!got.has('/commented'), '注释里的路由不应被提取');
});

test('🔴 extractLinkTargets 必须支持数据驱动写法（否则测试会假绿）', () => {
  // 项目里列表型出口普遍写成 EXITS.map(it => <Link to={it.to}>)。
  // 只匹配字面量会漏掉绝大多数链接 —— 第一次写 404 测试时就漏了，
  // 只匹配到 1 个链接，差点让断言空跑。
  const src = `
    const EXITS = [
      { to: '/', label: '首页' },
      { to: '/features', label: '功能总览' },
    ];
    <Link to="/legal">法务</Link>
    <Link key={it.to} to={it.to}>{it.label}</Link>
  `;
  const got = extractLinkTargets(src);
  assert.ok(got.includes('/'), '应含数据数组里的 /');
  assert.ok(got.includes('/features'), '应含数据数组里的 /features');
  assert.ok(got.includes('/legal'), '应含字面量写法');
  assert.ok(!got.includes('it.to'), '不得把动态表达式当成路径');
  assert.strictEqual(new Set(got).size, got.length, '结果应去重');
});

test('extractLinkTargets：空输入不抛错', () => {
  assert.deepStrictEqual(extractLinkTargets(''), []);
  assert.deepStrictEqual(extractLinkTargets('<div>纯静态</div>'), []);
});