// ─────────────────────────────────────────────────────────────
// 建模页「方向」视图层契约测试
//
//   为什么是**源码级**断言而不是行为断言：
//     `src/pages/studio/model-draft.ts` 是 TS/React 视图层，node --test 不能直接 require。
//     本机又无法启动 Edge 做 CDP 真渲染（见 models-ui-contract.test.cjs 的说明）。
//     因此这里退而锁"**缺陷的形状**"——即上一版真实存在过的写法。
//
//   要防的三件事（都是 2026-10-05 那个 direction 缺陷的具体成因）：
//     ① 草稿层把缺省方向当成 `1` 写回 → 规范层的"缺省即按名推导"永远到不了
//     ② 方向按钮只有两态 → 用户无法表达"跟随因子名"
//     ③ 只读流水线视图自己判方向 → `rev20` 显示成「正向」而实际按反向执行（同源缺失）
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const DRAFT_SRC = read('src/pages/studio/model-draft.ts');
const PAGE_SRC = read('src/pages/ModelStudioPage.tsx');
const PIPE_SRC = read('src/pages/studio/PipelineView.tsx');

/** 截取两个标记之间的源码片段（避免断言误命中文件别处的相似写法） */
function between(src, startMark, endMark, label) {
  const a = src.indexOf(startMark);
  assert.ok(a >= 0, `${label}：找不到起点标记 ${JSON.stringify(startMark)}`);
  const b = src.indexOf(endMark, a + startMark.length);
  assert.ok(b > a, `${label}：找不到终点标记 ${JSON.stringify(endMark)}`);
  return src.slice(a, b);
}

// ── ① 草稿层：方向必须是三态，且 'auto' 不进 JSON ──────────────
test('草稿层：方向类型必须是三态（含 auto 哨兵），不得退化成 1|-1', () => {
  const seg = between(DRAFT_SRC, 'export type DraftDirection', 'export interface DraftFactor', 'DraftDirection');
  assert.match(seg, /'auto'/, 'DraftDirection 必须包含 auto —— 两态无法表达"跟随因子名"');
  assert.match(seg, /\b1\b/, '应保留显式 1');
  assert.match(seg, /-1/, '应保留显式 -1');
});

test('草稿层：draftToModel 必须**省略** auto 的 direction（写死即固化推导结果）', () => {
  assert.match(
    DRAFT_SRC,
    /export const directionField\s*=\s*\([^)]*\)\s*:\s*\{[^}]*\}\s*=>\s*\n?\s*[^;]*'auto'\s*\?\s*\{\}\s*:/,
    'directionField 必须对 auto 返回空对象（不写 direction 字段）',
  );
  const body = between(DRAFT_SRC, 'export function draftToModel', '/** Model JSON → 草稿', 'draftToModel');
  assert.match(body, /directionField\(\s*f\.direction\s*\)/, 'draftToModel 必须经 directionField 写方向');
  assert.ok(
    !/direction:\s*f\.direction\b/.test(body),
    'draftToModel 不得无条件写出 direction（那样 auto 会被固化成具体值）',
  );
});

test('草稿层：modelToDraft 不得把缺省 direction 填成 1（必须映射为 auto）', () => {
  const body = between(DRAFT_SRC, 'export function modelToDraft', '// ── 编辑面分区', 'modelToDraft');
  assert.ok(
    !/f\.direction\s*===\s*undefined\s*\?\s*1\b/.test(body),
    '缺省映射为 1 会丢"缺省"这一信息，导入 {expr:"rev20"} 就变成追涨（缺陷原形）',
  );
  assert.match(body, /f\.direction\s*===\s*undefined\s*\?\s*'auto'/, '缺省必须映射为 auto');
});

test('草稿层：方向默认值必须与规范层同源（import defaultDirection，不另立一套规则）', () => {
  assert.match(DRAFT_SRC, /import\s*\{[^}]*defaultDirection[^}]*\}\s*from\s*'\.\.\/\.\.\/\.\.\/shared\/modelspec\.mjs'/,
    '必须从规范层取值：否则前端"反转"清单与后端分叉，又是同一个缺陷的翻版');
});

// ── ② 页面：方向按钮三态、新因子默认 auto ─────────────────────
test('页面：新增因子默认 direction 必须为 auto（不是 1）', () => {
  // ⚠️ 不能用 `\{[^}]*\}` 抓对象字面量：`${draft.factors.length + 1}` 里的 `}` 会提前截断。
  //    改为「定位到追加点，看其后一小段」。
  const i = PAGE_SRC.indexOf('...draft.factors,');
  assert.ok(i >= 0, '找不到「添加因子」的追加写法');
  const seg = PAGE_SRC.slice(i, i + 220);
  assert.match(seg, /direction:\s*'auto'/, `新增因子应默认 auto，实际片段：${seg.split('\n')[0]}`);
  assert.ok(
    !/direction:\s*1\s*[,}]/.test(seg),
    '新增因子不得默认写死 direction:1 —— 那样用户改了因子名方向不会跟随',
  );
});

test('页面：方向切换必须是三态循环（不得残留两态 toggle）', () => {
  assert.ok(
    !/direction:\s*f\.direction\s*===\s*1\s*\?\s*-1\s*:\s*1/.test(PAGE_SRC),
    '残留两态 toggle：用户点不到"自动"，也就改不回跟随因子名',
  );
  assert.match(PAGE_SRC, /nextDirection\(\s*f\.direction\s*\)/, '必须用三态循环函数');
  assert.match(PAGE_SRC, /effectiveDirection\(\s*f\s*\)/, '按钮上应显示"自动"时的生效方向，让用户看得见');
});

// ── ③ 只读流水线视图：方向必须同源推导 ───────────────────────
test('流水线视图：方向不得自己判 `=== -1`，必须走规范层推导', () => {
  assert.match(PIPE_SRC, /import\s*\{[^}]*defaultDirection[^}]*\}\s*from/, 
    '缺少 defaultDirection 导入 ⇒ rev20 会被显示成「正向」而实际反向执行');
  assert.ok(
    !/f\.direction\s*===\s*-1\s*\?\s*theme/.test(PIPE_SRC),
    '残留自判方向：只读视图与执行口径分叉，用户看到的结构图是错的',
  );
  assert.match(PIPE_SRC, /defaultDirection\(\s*f\.expr\s*\)/, '缺省方向应由因子名推导');
});
