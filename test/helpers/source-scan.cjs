'use strict';
// ─────────────────────────────────────────────────────────────
// 源码扫描辅助（给「字符串契约测试」用）
//
// 🔴 为什么要有这个文件：
//   本项目有一类测试是「读源码文本做结构断言」（契约测试）——
//   它们不启动浏览器、不跑 React，只读 .tsx/.cjs 文本断言结构与纪律。
//   这类测试有一个**反复踩了四次的坑**：
//
//     **注释里出现的关键词会让断言误报。**
//
//   实测案例（2026-10-13 前累计四次）：
//     ① health-contract：注释里写 `'admin'`（在解释"为什么回显它危险"）
//        ⇒ 「不得回显 admin」的断言误报自己。
//     ② retrieval-metrics：「纯函数」断言扫全文，命中注释里的 "LLM" 字样。
//     ③ check-public-docs：`no-auth-off-switch` 判据把「**必须**启用鉴权」的
//        警告句也报了 —— 虽是判据问题，但同族（不区分代码与说明文字）。
//     ④ notfound-page：注释里引用旧实现 `<Navigate to="/" replace />`
//        ⇒ 「页面内不得用 <>Navigate」的断言误报。
//
//   ⇒ 但凡「扫源码找禁用项」，**必须先剥注释**。本模块把这一步做成单一实现，
//     避免第五次复制粘贴。
//
// ⚠️ 迁移状态（诚实记录）：**只有新测试用本模块**；
//   health-contract / retrieval-metrics / check-public-docs 里的同类逻辑
//   暂未迁移（避免为重构测试而引入回归风险 —— 它们当前是绿的）。
//   将来改动那几处时，顺手迁过来。
// ─────────────────────────────────────────────────────────────

/**
 * 剥掉源码里的注释，只留可执行文本。
 *
 * ⚠️ 这是**词法级近似**（正则），不是语法级解析：
 *   · 字符串字面量里的 `//`（如 URL `https://x`）**不会**被误剥 ——
 *     通过 `[^:]` 前缀断言规避（`https:` 的 `:` 会挡住）。
 *   · 但字符串里若出现 `/*` 或独立 `//`，仍可能被误剥。
 *   · 本项目用途（找禁用关键词）下这个精度足够；**别用它做安全判定**。
 *
 * @param {string} src 源码
 * @returns {string} 剥注释后的文本
 */
function stripComments(src) {
  // ⚠️ 必须先挡 null/undefined：`String(null)` 会得到字符串 'null' 而非空串，
  //   调用方拿到 'null' 会以为源码就长这样（本条由 source-scan.test.cjs 抓到）。
  if (src == null) return '';
  return String(src)
    // 块注释（含 JSDoc）
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 行注释：前面不能是 `:`（避免吃掉 `https://`）
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 从源码抽取全部静态路由 path（App.tsx 的 `<Route path="...">`）。
 * @param {string} src App.tsx 源码
 * @returns {Set<string>}
 */
function extractRoutePaths(src) {
  const out = new Set();
  for (const m of stripComments(src).matchAll(/<Route\s+path="([^"]+)"/g)) out.add(m[1]);
  return out;
}

/**
 * 从源码抽取全部 Link 目标，**同时支持两种写法**：
 *   ① 字面量：`<Link to="/foo">`
 *   ② 数据驱动：`{ to: '/foo', label: … }`（配 `<Link to={it.to}>` 使用）
 *
 * 🔴 为什么必须支持 ②：项目里列表型出口普遍写成 `EXITS.map(it => <Link to={it.to}>)`。
 *   只匹配字面量会漏掉绝大多数链接，测试会变成**假绿**
 *   （第一次写 notfound-page 测试时就漏了，只匹配到 1 个链接）。
 *
 * @param {string} src 组件源码
 * @returns {string[]} 去重后的目标列表
 */
function extractLinkTargets(src) {
  const code = stripComments(src);
  const out = new Set();
  // ① 字面量 <Link to="/foo">
  for (const m of code.matchAll(/<Link\s+[^>]*?to="([^"]+)"/g)) out.add(m[1]);
  // ② 数据数组里的 { to: '/foo', ... }
  for (const m of code.matchAll(/\{\s*to:\s*'([^']+)'/g)) out.add(m[1]);
  return [...out];
}

module.exports = { stripComments, extractRoutePaths, extractLinkTargets };
