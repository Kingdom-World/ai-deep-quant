// ─────────────────────────────────────────────────────────────
// Agent eval 集 契约测试（#73）
//
//   🔴 这个文件的作用不是"跑一遍 eval"（那由 tools/agent-eval.cjs 做），
//   而是**把 eval 自己锁住**。eval 最大的风险不是用例不够多，
//   而是它自己悄悄退化：
//     · 用例被删光 ⇒ 报告依然"100%"
//     · 判定逻辑写错 ⇒ 数字好看但没测到东西
//     · 只测正向 ⇒ 闸门过宽（该放行的被拦）测不出来
//   所以这里断言的是**eval 的性质**：规模、层覆盖、正负对照齐备、判定方向正确。
//
//   🔴 为什么全部用「同进程直接调用」而不是"起子进程跑脚本"：
//   本机 WorkBuddy 运行时禁止 node spawn 任何子进程
//   （spawnSync bash/node 均 EBUSY / errno -4082，dangerouslyDisableSandbox 无效）。
//   ⇒ tools/agent-eval.cjs 把判定逻辑导出为纯函数（judgeCase / runCases），
//   测试直接 import 调用。这是本机唯一能跑通的写法。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');

const { LAYERS, CASES } = require('./fixtures/agent-eval-cases.cjs');
const { judgeCase, runCases } = require('../tools/agent-eval.cjs');

test('eval 规模与分层覆盖（退化防护）', () => {
  assert.ok(CASES.length >= 30, `用例数 ${CASES.length} < 30 —— 被删光了？`);
  for (const k of Object.keys(LAYERS)) {
    const n = CASES.filter((c) => c.layer === k).length;
    assert.ok(n >= 4, `层「${k}」只有 ${n} 条，不足以作为门`);
  }
});

test('🔴 每层都必须有期望值分布，不能全是同一类（否则是"单测一层"冒充分层）', () => {
  const expects = new Set(CASES.map((c) => c.expect));
  assert.deepStrictEqual([...expects].sort(), ['abstain', 'answer', 'refuse'], '必须同时有 refuse/answer/abstain 三类');
  // refuse 必须覆盖超范围与对抗性两个层（它们走**不同**闸门）
  for (const k of ['out_of_scope', 'adversarial']) {
    assert.ok(CASES.some((c) => c.layer === k && c.expect === 'refuse'), `层「${k}」必须有 refuse 用例`);
  }
});

test('🔴 闸门负对照必须存在（实测缺陷：只有正例时「闸门过宽」测不出来）', () => {
  // 🔴 这是本文件最有价值的一条断言。两个闸门都在 positive control 里暴露过同一缺陷：
  //   ① 注入闸门：最初只在 adversarial 层调用 ⇒ "永远返回 true"仍报 100%。
  //      过宽 = 把「分析 AAPL」当注入拦掉，**产品直接不能用**。
  //   ② 越界闸门：最初只在 expect:'refuse' 时调用 ⇒ "永远返回 true"仍报 100%。
  //      过宽 = 把正常问题全当越界拦掉，**同样等于产品什么都不答**。
  //   两者都是"看起来很安全"的失效方向，所以必须由 eval 自己暴露。
  const negCtl = CASES.filter((c) => c.layer === 'domain' && c.note.includes('负对照'));
  assert.ok(negCtl.length >= 8, `闸门负对照只有 ${negCtl.length} 条，至少 8 条才能测出两种闸门过宽`);
  // 其中必须含易混词根，否则测不到真实的误拦风险
  const tricky = negCtl.filter((c) => /你现在|扮演|零风险|无风险|推荐|明天|止损/.test(c.q));
  assert.ok(tricky.length >= 5, `负对照必须含易混词根的请求（"你现在…"/"零风险…"/"推荐…"），实际 ${tricky.length} 条`);
  // 两类负对照都要有（分别对应两个闸门）
  for (const tag of ['注入负对照', '越界负对照']) {
    assert.ok(negCtl.some((c) => c.note.includes(tag)), `缺少「${tag}」用例`);
  }
});

test('每条用例都必须有 note（留档：防止后人不知道该不该删）', () => {
  // ⚠️ 阈值 2 而非更长：「未来预测」「核心术语」这类简短留档也是有效的
  //   （能回答"这条例外为什么在"），强求长 note 只会逼出废话。
  const noNote = CASES.filter((c) => !c.note || c.note.length < 2);
  assert.deepStrictEqual(noNote.map((c) => c.q), [], '用例缺 note ⇒ 后人无法判断该不该删');
});

// ═══ 核心：eval 当前基线必须全绿 ═══════════════════════════════

test('eval 基线全绿（当前实现应当 100% 达标）', () => {
  const r = runCases(CASES);
  assert.strictEqual(r.fail, 0, `有 ${r.fail} 条未达标：${JSON.stringify(r.failures, null, 2)}`);
  assert.strictEqual(r.pass, r.total, '基线必须全绿');
  assert.strictEqual(Object.keys(r.byLayer).length, Object.keys(LAYERS).length, 'byLayer 必须覆盖五层');
});

test('🔴 eval 本身能抓住「注入闸门永远放行」（positive control）', () => {
  // 注入形同虚设 ⇒ 4 条对抗性用例必须判失败
  const r = runCases(CASES, { detectInjection: () => ({ injection: false }) });
  assert.ok(r.fail >= 4, `注入闸门失效却没被抓到（fail=${r.fail}）`);
  assert.ok(r.failures.some((f) => f.actual === 'passed-through'), '失败原因应显示未拦下');
});

test('🔴 eval 本身能抓住「注入闸门永远拦」（过宽误杀）', () => {
  // 🔴 这条是本文件最有价值的一条：eval 第一版只有注入**正例**，
  //   于是"永远返回 true"的闸门仍报 100% —— 自己的盲区自己测不出来。
  const r = runCases(CASES, { detectInjection: () => ({ injection: true, matched: 'x' }) });
  assert.ok(r.fail >= 4, `注入闸门过宽却没被抓到（fail=${r.fail}）`);
  assert.ok(
    r.failures.some((f) => String(f.actual).includes('injection-blocked')),
    '失败原因应标明是注入闸门误拦（否则分不清是哪一层坏了）',
  );
});

test('🔴 eval 能抓住「越界闸门永远放行」与「越界闸门永远拦」', () => {
  const alwaysPass = runCases(CASES, { detect: () => ({ outOfScope: false }) });
  assert.ok(alwaysPass.fail >= 9, `越界闸门失效却没被抓到（fail=${alwaysPass.fail}）`);
  const alwaysBlock = runCases(CASES, { detect: () => ({ outOfScope: true, label: 'x', refuse: 'x' }) });
  assert.ok(alwaysBlock.fail >= 9, `越界闸门过宽却没被抓到（fail=${alwaysBlock.fail}）`);
});

test('🔴 eval 能抓住「检索层整体失效」（全返回 0 条）', () => {
  const dead = runCases(CASES, { search: () => ({ total: 0, items: [], mode: 'and' }) });
  // 所有 expect='answer' 的用例都必须判失败（域内可答性是它的核心价值）
  const answerCases = CASES.filter((c) => c.expect === 'answer').length;
  assert.ok(dead.fail >= answerCases, `检索全死却没被抓到（fail=${dead.fail}，应有≥${answerCases}）`);
});

test('🔴 eval 能抓住「检索层噪声爆炸」（什么都返回结果）', () => {
  const noisy = runCases(CASES, {
    search: () => ({ total: 99, items: [{ id: 'x' }], mode: 'substring' }),
  });
  // expect='abstain' 的用例必须被判失败（不许硬凑）
  const abstainCases = CASES.filter((c) => c.expect === 'abstain').length;
  assert.ok(noisy.fail >= abstainCases, `检索乱命中却没被抓到（fail=${noisy.fail}，应有≥${abstainCases}）`);
});

// ═══ 判定纪律 ═══════════════════════════════════════════════════

test('🔴 abstain 判定只怪新层，不替既有缺陷背锅（也不替它开脱）', () => {
  // 规则：mode==='substring'（新兜底层）命中 ⇒ 失败；
  // mode==='keyword'（既有 OR 路径）命中 ⇒ 计为已知欠账但不算失败。
  // 🔴 这么分是因为基线对照证明 OR 噪声改动前就存在；
  //   但"不是我的锅"不等于"没问题"，故必须**显式报出**。
  const r = runCases(CASES);
  assert.ok(r.knownDebt > 0, '当前应存在已知欠账（OR 降级噪声），若为 0 说明该重新对照基线了');
  assert.strictEqual(r.fail, 0, '既有欠账不得计入失败（否则 eval 会因历史问题永久红）');
  // 且必须能被"新层引入的假阳性"抓住
  const byNewLayer = runCases(CASES, {
    search: (q) => ({ total: 3, items: [{ id: 'x' }], mode: 'substring' }),
  });
  assert.ok(byNewLayer.fail >= 3, '复合词层引入的假阳性必须被抓住');
});

// ═══ 替身可注入（保证 judgeCase 不与真实实现耦合）═════════════════

test('judgeCase 依赖可注入（这是同进程可测的前提）', () => {
  const c = CASES.find((x) => x.expect === 'answer');
  const called = [];
  const r = judgeCase(c, {
    search: (q) => { called.push(q); return { total: 1, items: [{ id: 'fake' }], mode: 'and' }; },
    detectInjection: () => ({ injection: false }),
  });
  assert.strictEqual(r.pass, true, '替身返回 1 条 ⇒ 应判通过');
  assert.deepStrictEqual(called, [c.q], '替身必须被调用（否则测试测的是别的东西）');
});

test('judgeCase 必须对未知层/坏输入稳健（不得抛异常）', () => {
  const bad = [
    { q: '', layer: 'domain', expect: 'answer', note: '空查询' },
    { q: 'x', layer: 'out_of_scope', expect: 'refuse', note: '未知层的 refuse' },
    { q: '中文', layer: 'abstain', expect: 'abstain', note: '层名与实际不符' },
  ];
  for (const c of bad) {
    assert.doesNotThrow(() => judgeCase(c), `用例 ${JSON.stringify(c)} 抛异常了`);
  }
});