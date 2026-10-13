'use strict';
// ─────────────────────────────────────────────────────────────
// ECharts 生命周期守门（防实例泄漏）
//
// 🔴 为什么值得单独立门：
//   2026-10-13 审查发现 `CrossSectionTab.tsx` 的 useEffect **无 cleanup**，
//   而该 Tab 是条件渲染（normTab === '' 才挂载）⇒ 每次切走都泄漏一个
//   canvas + WebGL 上下文 + resize 监听。**这类泄漏没有任何编译期/运行期报错**，
//   只在长时间使用后表现为内存缓慢上涨 —— 极难定位。
//   ⇒ 用一条廉价断言守住：凡是 `echarts.init` 的文件，必须有 ≥ 次数的 `dispose()`。
//
// ⚠️ 本测试是**近似判据**（按文件计数比，不解析 AST）：
//   它抓得住"整个文件忘了写 cleanup"这一类（最常見），
//   抓不住"写了 cleanup 但 dispose 写在了错误分支里"。
//   后者靠 review。写这条时已明确其边界，别把它当成完备保证。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** 递归收集 src 下所有 .tsx */
function collect(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) collect(p, out);
    else if (f.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const FILES = collect(SRC);
const CHART_FILES = FILES.filter((f) => fs.readFileSync(f, 'utf8').includes('echarts.init'));

test('前置条件：确实找到了图表文件（否则本测试是空的，等于没测）', () => {
  assert.ok(CHART_FILES.length >= 5,
    `预期至少 5 个文件用 echarts.init，实际 ${CHART_FILES.length} —— 若为 0 说明 glob 写错了`);
});

test('🔴 每个用 echarts.init 的文件都必须有 ≥ 次数的 dispose()', () => {
  const bad = [];
  for (const f of CHART_FILES) {
    const src = fs.readFileSync(f, 'utf8');
    const inits = (src.match(/echarts\.init\(/g) || []).length;
    const disposes = (src.match(/\.dispose\(\)/g) || []).length;
    if (disposes < inits) {
      bad.push(`${path.relative(ROOT, f)}：init=${inits} 但 dispose=${disposes}`);
    }
  }
  assert.deepStrictEqual(bad, [],
    '以下文件 init 多于 dispose ⇒ 存在实例泄漏：\n  ' + bad.join('\n  '));
});

test('🔴 dispose 与 ref 置 null 必须成对出现（防止只置 null 不 dispose）', () => {
  // 2026-10-13 修的那个 bug 正是「chartInst.current = null」写了，
  // 但 `.dispose()` 没写 ⇒ 单看置 null 会以为清理过了。
  const bad = [];
  for (const f of CHART_FILES) {
    const src = fs.readFileSync(f, 'utf8');
    const nullSets = (src.match(/\w+Inst\.current\s*=\s*null/g) || []).length;
    const disposes = (src.match(/\w+Inst\.current\?\.dispose\(\)/g) || []).length;
    if (nullSets > disposes) {
      bad.push(`${path.relative(ROOT, f)}：置 null ${nullSets} 次，但 dispose ${disposes} 次`);
    }
  }
  assert.deepStrictEqual(bad, [],
    '以下文件置 null 多于 dispose ⇒ 典型的"假清理"：\n  ' + bad.join('\n  '));
});

test('🔴 正向破坏验证锚点：删掉 CrossSectionTab 的 dispose 必须让本测试红', () => {
  // 这条不删代码，只断言"该文件当前确实含 dispose"——
  // 若有人将来误删，上面那条会红；这里再确认锚点文件本身没被绕过。
  const f = path.join(SRC, 'pages', 'research', 'CrossSectionTab.tsx');
  assert.ok(fs.existsSync(f), 'CrossSectionTab.tsx 应存在');
  const src = fs.readFileSync(f, 'utf8');
  assert.match(src, /chartInst\.current\?\.dispose\(\)/,
    'CrossSectionTab 必须含 dispose —— 这是 2026-10-13 修的那个泄漏点');
  // 且 cleanup 必须是 useEffect 的 return（不是散落在别处）
  const effectIdx = src.indexOf('useEffect(() => {');
  const disposeIdx = src.indexOf('chartInst.current?.dispose()');
  assert.ok(effectIdx > 0 && disposeIdx > effectIdx,
    'dispose 必须出现在 useEffect 内部（作为 cleanup 返回）');
});