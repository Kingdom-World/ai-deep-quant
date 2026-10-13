'use strict';
// ─────────────────────────────────────────────────────────────
// 未找到页（404）契约测试
//
// 🔴 为什么值得测：
//   2026-10-13 之前 `path="*"` 是 `<Navigate to="/" replace />` —— 未知路径**静默跳回首页**。
//   用户 URL 被改掉且无任何提示，他会以为"我点错了"或"网站坏了"，
//   而实际上可能只是收藏了已改名的旧地址（本项目恰有路由迁移史：
//   /experiments → /research/experiments、/factor-eval → /research/factors）。
//
//   🔴 本文件最重要的一条是「出口必须指向真实路由」：
//     404 页里列出的链接若指向不存在的路由，用户会**从 404 跳到另一个 404** ——
//     这是最容易犯、且人工 review 几乎必漏的错误（因为两边的字面量看起来都对）。
//
// ⚠️ 能力边界（诚实声明）：
//   这是**字符串契约测试**，不是渲染测试。它能验证「结构正确」，
//   不能验证「渲染出来好不好看」。
//   补充证据：`vite build` 产物中已确认含 4 条关键文案
//   （「没有这个页面」「你访问的地址」「返回上一页」「功能总览」）
//   ⇒ 若路由未引用该组件，Rolldown 会 tree-shake ⇒ 文案不可能出现在产物里。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments, extractRoutePaths, extractLinkTargets } =
  require(path.join(__dirname, 'helpers', 'source-scan.cjs'));

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src', 'App.tsx'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'NotFoundPage.tsx'), 'utf8');
// 🔴 先剥注释再断言：本文件注释里引用了旧实现 `<Navigate to="/" replace />`
//   作为背景说明 —— 不剥注释会让「不得用 Navigate」的断言误报自己。
//   （这是本项目第四次踩同款坑，故抽了 test/helpers/source-scan.cjs。）
const PAGE_CODE = stripComments(PAGE);
const APP_CODE = stripComments(APP);

test('🔴 path="*" 必须指向 NotFoundPage（不得退回静默重定向）', () => {
  assert.match(APP_CODE, /<Route path="\*" element=\{<NotFoundPage \/>\} \/>/,
    '通配路由必须渲染 NotFoundPage');
  assert.ok(!/<Route path="\*" element=\{<Navigate/.test(APP_CODE),
    '通配路由不得改回 <Navigate> —— 静默重定向正是本页要消除的行为');
});

test('NotFoundPage 必须存在、默认导出、且被 App.tsx 引入', () => {
  const f = path.join(ROOT, 'src', 'pages', 'NotFoundPage.tsx');
  assert.ok(fs.existsSync(f), '文件必须存在');
  assert.match(PAGE, /export default function NotFoundPage/, '必须是默认导出的组件');
  assert.match(APP, /import NotFoundPage from '\.\/pages\/NotFoundPage'/, 'App.tsx 必须引入它');
});

test('🔴 必须回显用户访问的路径（否则用户无法自查拼写）', () => {
  assert.match(PAGE, /useLocation/, '必须用 useLocation 取当前路径');
  assert.match(PAGE, /location\.pathname/, '必须回显 pathname');
  // 查询串也要带上（有些路由靠 ?tab= 区分，只回显 path 会误导）
  assert.match(PAGE, /location\.search/, '应同时回显查询串');
});

test('🔴 出口链接必须指向真实存在的路由（防"从 404 跳到另一个 404"）', () => {
  const routes = extractRoutePaths(APP);
  // 同时支持字面量与数据驱动（EXITS.map(it => <Link to={it.to}>)）写法
  const links = extractLinkTargets(PAGE);
  assert.ok(links.length >= 2, `404 页应至少提供 2 个出口，实际 ${links.length} 个`);

  const bad = links.filter((l) => !routes.has(l));
  assert.deepStrictEqual(bad, [],
    `以下出口指向不存在的路由（会把用户导到另一个 404）：\n  ${bad.join('\n  ')}\n` +
    `现有静态路由：${[...routes].join(', ')}`);
});

test('🔴 不得含自动跳转（自动跳转正是本页要消除的行为）', () => {
  assert.ok(!/<Navigate/.test(PAGE_CODE), '页面代码内不得用 <Navigate> 自动跳转');
  assert.ok(!/navigate\(\s*['"]\//.test(PAGE_CODE), '不得用 navigate("/...") 自动跳转');
  // navigate(-1)（返回上一页）是用户主动触发，允许
  assert.ok(!/setTimeout|useEffect/.test(PAGE_CODE),
    '不得用定时器/effect 做延时跳转 —— 那等于变相自动跳转');
});

test('样式必须用 theme 令牌，不得硬编码色值（与全站一致）', () => {
  assert.match(PAGE_CODE, /from '\.\.\/lib\/theme'/, '必须引入 theme');
  // 允许 rgba(…) 用于半透明叠加（项目既有惯例），但禁止裸 hex 色值
  const hex = PAGE_CODE.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  // '#fff' 是白色按钮文字，属可接受的通用值；其余 hex 必须来自令牌
  const offenders = hex.filter((h) => !/^#fff(f{3})?$/i.test(h));
  assert.deepStrictEqual(offenders, [],
    `404 页出现硬编码色值（应改用 theme.color）：${offenders.join(', ')}`);
});

test('一个反直觉的边界：本页不追求 HTTP 404 状态码', () => {
  // 记录这个**有意的取舍**，防止后人"顺手修好"：
  // 静态托管下后端 SPA 回退对所有非 /api GET 返回 index.html(200)。
  // 要返回真 404 需动 server 静态层，而本平台邀请制、无 SEO 需求 ⇒ 不值得。
  // 若将来引入 SSR/预渲染，此处需重新评估。
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.cjs'), 'utf8');
  assert.match(serverSrc, /SPA 路由回退/,
    '后端 SPA 回退逻辑应仍在（本页的状态码取舍依赖它）');
});