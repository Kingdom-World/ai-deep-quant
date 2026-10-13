'use strict';
// ─────────────────────────────────────────────────────────────
// 「CI 覆盖完整性」守门
//
// 🔴 为什么需要它（2026-10-13 v1.3 审计发现）：
//   CI 跑的是 `node --test test/*.test.cjs`（见 .github/workflows/ci.yml）。
//   审计时发现 `test/*.cjs` 有 83 个但 `test/*.test.cjs` 只有 80 个 ——
//   **3 个文件因命名不匹配这个 glob，从未在 CI 执行**，且一直是绿的也没人察觉。
//
//   经核实那 3 个是**有意的手动脚本**（依赖未入库的本地数据 / 需要运行中服务），
//   不是遗漏。但**这类问题一旦发生在"本该是测试"的文件上就是永久盲区**：
//   作者本地手动 `node test/xxx.cjs` 跑通了，以为 CI 也在保护它 —— 实际没有。
//
//   ⇒ 本测试把「test/ 下每个 .cjs 要么被 CI 跑到、要么显式登记为手动脚本」
//     变成机器可判的断言。新增文件若既不匹配 glob 又不在白名单 ⇒ **CI 红**。
//
// ⚠️ 本测试的边界：它只保证「文件被 CI 执行」，不保证「测试内容有效」。
//   后者由各测试自己负责。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');

/**
 * 已知的「有意手动运行」脚本白名单。
 * 🔴 加入白名单 = 一个有意识的决定：**该脚本无法在 CI 环境运行**。
 *   每项必须写明原因，否则后人不知道能否迁移进 CI。
 *   详见 plans/refactor-audit-plan.md §十一「手动验证清单」。
 */
const MANUAL_ONLY = {
  'agent-llm-verify.cjs': '需先启动服务（真实 HTTP 到 /api/agents/*）—— CI 无运行中服务',
  'agent-upgrade-verify.cjs':
    '依赖 data/ai/*、ai-training/dataset/*（均未入库）；CI 用 git archive 造环境，这些文件不存在',
  'news-verify.cjs': '需先启动服务（真实 HTTP 到 /api/news/*）—— CI 无运行中服务',
};

test('前置条件：确实扫到了测试文件（防 glob 写错导致空断言）', () => {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.cjs'));
  assert.ok(files.length >= 50, `预期至少 50 个 .cjs 文件，实际 ${files.length}`);
});

test('🔴 test/ 下每个 .cjs 要么被 CI 执行，要么显式登记为手动脚本', () => {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.cjs'));
  const notCovered = [];
  for (const f of files) {
    const inCiGlob = /\.test\.cjs$/.test(f);      // 匹配 test/*.test.cjs
    const isManual = Object.prototype.hasOwnProperty.call(MANUAL_ONLY, f);
    if (!inCiGlob && !isManual) {
      notCovered.push(f);
    }
  }
  assert.deepStrictEqual(notCovered, [],
    `以下文件既不被 CI 的 \`test/*.test.cjs\` 匹配、也不在 MANUAL_ONLY 白名单 ⇒ **不会被任何 CI 步骤执行**：\n` +
    `  ${notCovered.join('\n  ')}\n\n` +
    `处理方式（二选一）：\n` +
    `  · 它是**测试** ⇒ 重命名为 <name>.test.cjs（这样 CI 才会跑它）\n` +
    `  · 它是**需要本地数据/服务的手动脚本** ⇒ 加入本文件 MANUAL_ONLY 并写明原因`);
});

test('白名单项必须都真实存在（防删除后留下幽灵条目）', () => {
  const files = new Set(fs.readdirSync(TEST_DIR));
  const ghosts = Object.keys(MANUAL_ONLY).filter((f) => !files.has(f));
  assert.deepStrictEqual(ghosts, [],
    `白名单里的文件已不存在，应删除条目：${ghosts.join(', ')}`);
});

test('白名单项必须写明非空原因（防"顺手加进去"绕过门禁）', () => {
  for (const [f, reason] of Object.entries(MANUAL_ONLY)) {
    assert.ok(typeof reason === 'string' && reason.length >= 15,
      `白名单项 ${f} 的原因过短或缺失 —— 没有原因的豁免等于没有门禁`);
  }
});

test('白名单项不得是 .test.cjs（那说明它本就该被 CI 跑）', () => {
  for (const f of Object.keys(MANUAL_ONLY)) {
    assert.ok(!/\.test\.cjs$/.test(f),
      `${f} 匹配 CI glob，不该出现在手动白名单里`);
  }
});

test('测试命令仍为 test/*.test.cjs 口径（本门的前提，两处都要对）', () => {
  // ⚠️ 断言位置纠正（2026-10-13 第一次写错）：CI 跑的是 `npm test`，
  //   真正定义 glob 的是 package.json 的 scripts.test，**不是** ci.yml 里的 run 行。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /test\/\*\.test\.cjs/,
    'package.json 的 test 脚本需仍为 test/*.test.cjs —— 若改成跑整个 test/ 目录，本门的白名单逻辑需同步调整');

  // CI 侧确认它确实调用 npm test（而非自己写一套不同的 glob）
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(yml, /npm test/,
    'CI 应通过 npm test 调用同一套 glob，避免两处口径分叉');
});