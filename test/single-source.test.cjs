// ─────────────────────────────────────────────────────────────
// 口径单一源清单测试（shared/single-source.cjs）—— 这是一道**治理门**
//
//   门的意义在于"会红"：如果它永远绿，就等于没有。故本文件除"真实仓库全过"外，
//   必须用**合成目录**做两条对照：
//     · positive control：故意造一份重复定义 ⇒ 必须被抓出
//     · negative control：干净目录 ⇒ 不得误报
//   另加"清单不过期"的锁：文件必须在、导出符号必须在 —— 重构改名后清单立刻失效。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('../shared/single-source.cjs');

const ROOT = path.join(__dirname, '..');
const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清不掉不影响结论 */
    }
  }
});
const mkRoot = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sglsrc-'));
  tmpDirs.push(d);
  return d;
};
const write = (root, rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

// ═══ 一、清单自身的质量 ══════════════════════════════════════

test('清单结构：id 唯一、路径为相对形态（不得出现绝对路径）、每条都有说明', () => {
  const ids = S.SINGLE_SOURCES.map((e) => e.id);
  assert.strictEqual(new Set(ids).size, ids.length, '清单 id 必须唯一');
  for (const e of S.SINGLE_SOURCES) {
    assert.ok(!/[A-Za-z]:[\\/]/.test(e.source), `source 必须是相对路径：${e.source}`);
    assert.ok(!e.source.startsWith('/'), `source 不得是绝对路径：${e.source}`);
    assert.ok(e.label && e.label.length > 0, `${e.id} 缺 label`);
    assert.ok(e.note && e.note.length >= 10, `${e.id} 的 note 太短 —— 清单要能自解释"这个口径是什么"`);
    assert.ok(Array.isArray(e.exports), `${e.id} 的 exports 必须是数组`);
    for (const g of e.guards || []) {
      assert.ok(g.reason && g.reason.length > 0, `${e.id} 的 guard 缺 reason（违规时无法解释为什么不行）`);
      assert.ok(Array.isArray(g.allow), `${e.id} 的 guard 缺 allow（会把定义处也判违规）`);
      assert.doesNotThrow(() => new RegExp(g.pattern), `${e.id} 的 guard 正则非法：${g.pattern}`);
    }
  }
});

// ═══ 二、真实仓库：门必须通过 ════════════════════════════════

test('🔴 真实仓库全量校验通过（清单不过期 + 无重复定义）', () => {
  const r = S.verifySingleSources(ROOT);
  const bad = r.entries.filter((e) => !e.ok);
  assert.strictEqual(
    bad.length,
    0,
    `以下条目未通过 —— 要么清单已过期（文件/符号改名），要么确有口径被重写一份：\n` +
      bad.map((e) => `  · ${e.id}（${e.source}）：\n      ${e.issues.join('\n      ')}`).join('\n'),
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.passed, r.total);
  assert.ok(r.scannedFiles > 50, `扫描文件数异常少（${r.scannedFiles}）—— 目录跳过规则可能过宽，门会形同虚设`);
});

test('🔴 结果里不得出现绝对路径（公开仓库/公网红线）', () => {
  const r = S.verifySingleSources(ROOT);
  const json = JSON.stringify(r);
  assert.ok(!/[A-Za-z]:[\\/]/.test(json), '校验结果里出现了盘符路径');
  assert.ok(!json.includes(ROOT.replace(/\\/g, '\\\\')), '校验结果里出现了仓库绝对路径');
});

// ═══ 三、对照实验：门必须会红、也必须有分寸 ══════════════════

const ENTRY = {
  id: 't-fees',
  label: '测试费率',
  source: 'server/x.cjs',
  exports: ['RATE'],
  note: '测试用：费率只能定义一次',
  guards: [{ pattern: 'RATE\\s*=\\s*0\\.00025', reason: '费率只能一处', allow: ['server/x.cjs', 'test/'] }],
};

test('positive control：白名单之外重复定义 ⇒ 必须报违规（否则门是摆设）', () => {
  const root = mkRoot();
  write(root, 'server/x.cjs', "const RATE = 0.00025;\nmodule.exports = { RATE };\n");
  write(root, 'server/y.cjs', 'const copied = 1;\nconst RATE = 0.00025; // 抄了一份\nmodule.exports = { copied };\n');
  const r = S.verifyEntry(ENTRY, root, S.listRepoFiles(root));
  assert.strictEqual(r.ok, false, '重复定义必须被抓住');
  assert.ok(
    r.guards[0].violations.some((v) => v.file === 'server/y.cjs'),
    `违规文件应被点名，实际：${JSON.stringify(r.guards[0].violations)}`,
  );
  assert.ok(r.issues.some((s) => /又重新定义/.test(s)), 'issue 文案要说清"被违反了什么"');
});

test('negative control：干净目录不得误报（误报会让门被习惯性忽略）', () => {
  const root = mkRoot();
  write(root, 'server/x.cjs', "const RATE = 0.00025;\nmodule.exports = { RATE };\n");
  write(root, 'server/z.cjs', "const { RATE } = require('./x.cjs');\nmodule.exports = { RATE };\n");
  const r = S.verifyEntry(ENTRY, root, S.listRepoFiles(root));
  assert.strictEqual(r.ok, true, `干净引用不得被判违规：${JSON.stringify(r.issues)}`);
  assert.strictEqual(r.guards[0].violations.length, 0);
});

test('注释里提到数值不算违规（否则门会被噪声淹没）', () => {
  const root = mkRoot();
  write(root, 'server/x.cjs', "const RATE = 0.00025;\nmodule.exports = { RATE };\n");
  write(root, 'server/w.cjs', '// 费率 RATE = 0.00025（见 server/x.cjs）\nconst a = 1;\nmodule.exports = { a };\n');
  const r = S.verifyEntry(ENTRY, root, S.listRepoFiles(root));
  assert.strictEqual(r.ok, true, '注释行应被跳过');
});

test('白名单前缀生效：test/ 下的复述不被判违规（口径锁测试需要写死数值）', () => {
  const root = mkRoot();
  write(root, 'server/x.cjs', "const RATE = 0.00025;\nmodule.exports = { RATE };\n");
  write(root, 'test/lock.test.cjs', 'const RATE = 0.00025; // 口径锁\n');
  const r = S.verifyEntry(ENTRY, root, S.listRepoFiles(root));
  assert.strictEqual(r.ok, true, 'test/ 在白名单内应跳过');
});

test('🔴 清单过期会被抓住：文件不存在 / 导出符号改名', () => {
  const root = mkRoot();
  write(root, 'server/x.cjs', 'const NOT_RATE = 1;\nmodule.exports = { NOT_RATE };\n');
  // ① 导出符号不存在
  const r1 = S.verifyEntry(ENTRY, root, S.listRepoFiles(root));
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.issues.some((s) => /导出符号不存在/.test(s)), `应报"导出符号不存在"：${JSON.stringify(r1.issues)}`);
  // ② 文件整份消失
  const entry2 = { ...ENTRY, source: 'server/does-not-exist.cjs' };
  const r2 = S.verifyEntry(entry2, root, S.listRepoFiles(root));
  assert.ok(r2.issues.some((s) => /不存在/.test(s)), '应报"文件不存在"');
  // ③ mustExist 数据文件缺失
  const entry3 = { ...ENTRY, mustExist: ['shared/nope.json'] };
  const r3 = S.verifyEntry(entry3, root, S.listRepoFiles(root));
  assert.ok(r3.issues.some((s) => /必须存在的数据文件/.test(s)));
});

test('扫描器跳过点开头目录与已知产物目录（否则会把临时副本当成"重复定义"）', () => {
  const root = mkRoot();
  write(root, 'server/x.cjs', "const RATE = 0.00025;\nmodule.exports = { RATE };\n");
  // 这些都不该被扫到
  write(root, '.tmp-cisim/server/x.cjs', 'const RATE = 0.00025;\n');
  write(root, 'node_modules/pkg/x.cjs', 'const RATE = 0.00025;\n');
  write(root, 'dist/assets/a.js', 'const RATE = 0.00025;\n');
  const files = S.listRepoFiles(root);
  assert.ok(files.includes('server/x.cjs'));
  assert.ok(!files.some((f) => f.startsWith('.tmp')), `点开头目录被扫到了：${JSON.stringify(files)}`);
  assert.ok(!files.some((f) => f.startsWith('node_modules')), 'node_modules 被扫到了');
  assert.ok(!files.some((f) => f.startsWith('dist')), 'dist 被扫到了');
  const r = S.verifyEntry(ENTRY, root, files);
  assert.strictEqual(r.ok, true, '临时副本不得触发违规');
});

// ═══ 四、与前端共用：.mjs 壳必须同源 ════════════════════════

test('🔴 .mjs 转发壳与 .cjs 实现同源（前端按 .mjs 导入，两处行为必须一致）', async () => {
  const m = await import('../shared/single-source.mjs');
  assert.strictEqual(m.SINGLE_SOURCES.length, S.SINGLE_SOURCES.length);
  assert.deepStrictEqual(m.SINGLE_SOURCES.map((e) => e.id), S.SINGLE_SOURCES.map((e) => e.id));
  const root = mkRoot();
  write(root, 'server/x.cjs', "const RATE = 0.00025;\nmodule.exports = { RATE };\n");
  write(root, 'server/y.cjs', 'const RATE = 0.00025;\n');
  const a = S.verifyEntry(ENTRY, root, S.listRepoFiles(root));
  const b = m.verifyEntry(ENTRY, root, m.listRepoFiles(root));
  assert.deepStrictEqual(b.guards[0].violations, a.guards[0].violations, '.mjs 与 .cjs 的判定必须一致');
});

test('类型声明与实现同步（.d.mts 里声明的导出都真实存在）', () => {
  const dts = fs.readFileSync(path.join(ROOT, 'shared/single-source.d.mts'), 'utf8');
  const names = ['SINGLE_SOURCES', 'listRepoFiles', 'verifyEntry', 'verifySingleSources', 'SKIP_DIRS', 'SCAN_EXT'];
  for (const n of names) {
    assert.ok(new RegExp(`\\b${n}\\b`).test(dts), `.d.mts 缺 ${n}`);
    assert.ok(n in S, `实现缺导出 ${n}`);
  }
});
