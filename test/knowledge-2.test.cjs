// ─────────────────────────────────────────────────────────────
// 知识库 2.0 测试（计划书 §11.1）
//
//   锁死五件事：
//   ① 两个维度（教学五层 vs 平台辅助类）不得混淆 —— basis/paper 不是教学层
//   ② **发布门**：无出处的条目标记草稿且不进检索；全库草稿数须为 0（存量 withSource 100%）
//   ③ 存量 49 条零回归（不因新增字段与发布门而失效）
//   ④ 结构化字段只对**新层**强制，存量条目降级到 body 仍可读
//   ⑤ 🔴 teachingModel 必须是**真实存在**的预置模板 key —— 防"编造不存在的模型 id"
//
//   ⚠️ 为什么 ② 要单独测：发布门让草稿从 search 结果消失，
//      于是「每条必带出处」这条断言在 search 结果上**永远绿**，会失去发现能力。
//      正确做法是断言 stats().draft === 0（把待办显式化）。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
process.env.KNOWLEDGE_DIR = path.join(ROOT, 'server', 'knowledge');
const kb = require('../server/knowledge.cjs');
const { MODEL_TEMPLATES } = require('../shared/modelspec.cjs');
const templateKeys = new Set(MODEL_TEMPLATES.map((t) => t.key));

// ═══ 一、两个维度 ══════════════════════════════════════════════

test('① 教学五层齐全且顺序固定（顺序 = 学习路径的自然顺序）', () => {
  assert.deepStrictEqual(kb.LAYER_KEYS, ['term', 'method', 'principle', 'case', 'cycle']);
  for (const k of kb.LAYER_KEYS) assert.ok(kb.LAYERS[k], `五层缺 label：${k}`);
});

test('① 平台辅助类（basis/paper）**不是**教学层 —— 混进去会污染学习路径', () => {
  for (const k of ['term', 'method', 'principle', 'case', 'cycle']) {
    assert.strictEqual(kb.isTeachingLayer(k), true, `${k} 应是教学层`);
  }
  for (const k of ['basis', 'paper']) {
    assert.strictEqual(kb.isTeachingLayer(k), false, `${k} 不该是教学层（它是平台口径/文献）`);
    assert.ok(kb.AUX[k], `${k} 应归入 AUX`);
  }
});

test('① 每个教学层都有内容（空层 = 学习路径会出现空章节）', () => {
  const s = kb.stats();
  for (const k of kb.LAYER_KEYS) {
    assert.ok(s.byLayer[k] > 0, `教学层 ${k} 为空`);
  }
});

// ═══ 二、发布门 ══════════════════════════════════════════════

test('② 已发布条目必须都带 source（发布门真正要保证的东西）', () => {
  const s = kb.stats();
  // 🔴 **不**把 draft === 0 写成断言。独立审查的结论：计划书的流程是
  //    「AI 生成初稿 → 人工审核补出处 → 发布」⇒ 草稿必须能先存在。
  //    把它断言成 0 等于宣布「本仓库永远不许有草稿」，与发布门的用途直接对立。
  //    正确分工：已发布条目的出处是**门禁**（行为断言）；草稿数是**待办量**（页面展示）。
  const published = kb.search('', { limit: 9999 }).items;
  const miss = published.filter((e) => !e.source || e.source.length < 10);
  assert.strictEqual(miss.length, 0, `已发布条目缺出处：${miss.map((e) => e.id).join(', ')}`);
  assert.strictEqual(s.published, published.length, 'search 返回的应全部是已发布条目');
  assert.ok(s.draft >= 0 && s.published > 0, `draft=${s.draft} published=${s.published}`);
});

test('② 发布门行为：无 source ⇒ draft=true 且不进默认检索', () => {
  // 用临时目录构造一条无出处条目（不动真实内容）
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb2-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'x.json'),
      JSON.stringify({
        category: 'principle',
        categoryLabel: '原理',
        description: 't',
        entries: [
          { id: 'has-src', title: '有出处', body: 'x', source: 'Someone (2020). A Book. Publisher.', tags: [] },
          { id: 'no-src', title: '无出处', body: 'x', source: '', tags: [] },
        ],
      }),
    );
    const saved = process.env.KNOWLEDGE_DIR;
    process.env.KNOWLEDGE_DIR = dir;
    delete require.cache[require.resolve('../server/knowledge.cjs')];
    const k2 = require('../server/knowledge.cjs');
    try {
      const s = k2.stats();
      assert.strictEqual(s.total, 2, '两条都应被加载');
      assert.strictEqual(s.draft, 1, '无出处那条应计为草稿');
      assert.strictEqual(s.published, 1);
      const shown = k2.search('', { limit: 99 }).items.map((e) => e.id);
      assert.deepStrictEqual(shown, ['has-src'], '🔴 草稿不得出现在默认检索结果里');
      const withDraft = k2.search('', { includeDraft: true, limit: 99 }).items.map((e) => e.id).sort();
      assert.deepStrictEqual(withDraft, ['has-src', 'no-src'], 'includeDraft 才能看到草稿（管理视图用）');
    } finally {
      process.env.KNOWLEDGE_DIR = saved;
      delete require.cache[require.resolve('../server/knowledge.cjs')];
      require('../server/knowledge.cjs');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── byIds 的发布门（原缺陷 #68）──
//   🔴 为什么必须造草稿来测：真实内容当前 draft=0，拿真实数据断言"byIds 过滤草稿"
//      会永远绿——正是「断言打在永真条件上、失去发现能力」的那类假测试。
//      下面用临时知识库（1 条已发布 + 1 条草稿）把绕过路径真正走一遍。
function withTempKb(fn) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb2-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'x.json'),
      JSON.stringify({
        category: 'principle',
        categoryLabel: '原理',
        description: 't',
        entries: [
          { id: 'has-src', title: '有出处', body: 'x', source: 'Someone (2020). A Book. Publisher.', tags: [] },
          { id: 'no-src', title: '无出处', body: '草稿正文', source: '', tags: [] },
        ],
      }),
    );
    const saved = process.env.KNOWLEDGE_DIR;
    process.env.KNOWLEDGE_DIR = dir;
    delete require.cache[require.resolve('../server/knowledge.cjs')];
    const k2 = require('../server/knowledge.cjs');
    try {
      return fn(k2);
    } finally {
      process.env.KNOWLEDGE_DIR = saved;
      delete require.cache[require.resolve('../server/knowledge.cjs')];
      require('../server/knowledge.cjs');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('🔴 byIds 默认过滤草稿（修复前：知道 id 就能读出未过审全文）', () => {
  withTempKb((k2) => {
    assert.deepStrictEqual(k2.byIds(['no-src']), [], '🔴 草稿不得被 byIds 默认读出');
    assert.deepStrictEqual(k2.byIds(['no-src', 'has-src']).map((e) => e.id), ['has-src'], '混合查询只返回已发布那条');
    // 管理视图：显式 includeDraft 才拿得到
    assert.deepStrictEqual(k2.byIds(['no-src'], { includeDraft: true }).map((e) => e.id), ['no-src']);
  });
});

test('🔴 byIds 与 search 的发布门口径一致（同一把尺子，不许一个严一个松）', () => {
  withTempKb((k2) => {
    const bySearch = new Set(k2.search('', { limit: 99 }).items.map((e) => e.id));
    for (const e of k2.byIds(['has-src', 'no-src'])) {
      assert.ok(bySearch.has(e.id), `byIds 返回了 search 看不到的条目：${e.id}（发布门被绕过了）`);
    }
  });
});

test('categories 的 count 是已发布数（过滤器数字必须点得出来）', () => {
  withTempKb((k2) => {
    const c = k2.categories().find((x) => x.key === 'principle');
    assert.strictEqual(c.count, 1, 'count 应为已发布数（1 条草稿不算）');
    assert.strictEqual(c.total, 2, 'total 应为全量');
    assert.strictEqual(c.draft, 1, 'draft 应显式给出待办量');
    // 口径等式：count 恒等于 search 能检索到的条数
    const searchable = k2.search('', { category: 'principle', limit: 99 }).total;
    assert.strictEqual(c.count, searchable, '🔴 count 与 search 可检索数必须一致，否则过滤器是假数字');
  });
});

test('categories 不列出「零已发布」的分类（避免渲染出点不动的死 chip）', () => {
  withTempKb((k2) => {
    const keys = k2.categories().map((c) => c.key);
    assert.ok(keys.includes('principle'), '有已发布条目的分类必须在列表里');
    for (const k of ['term', 'method', 'case', 'cycle', 'basis', 'paper']) {
      assert.ok(!keys.includes(k), `${k} 在本临时库无任何条目（含草稿），不该出现在过滤器里`);
    }
  });
});

test('stats 的 publishedByLayer 是已发布口径（学习路径编排不得按全量排章）', () => {
  withTempKb((k2) => {
    const s = k2.stats();
    assert.strictEqual(s.byLayer.principle, 2, 'byLayer 是工作量视角（含草稿）');
    assert.strictEqual(s.publishedByLayer.principle, 1, 'publishedByLayer 是可用量视角');
    // 不变量：五层已发布之和 = 总已发布（临时库里只有 principle，其余层为 0）
    const layerSum = kb.LAYER_KEYS.reduce((a, k) => a + (s.publishedByLayer[k] || 0), 0);
    assert.strictEqual(layerSum, s.published, '各层已发布之和 = 总已发布数（本库无辅助类）');
    // 不变量：全量 = 五层全量 + 辅助类全量（byCategory 才是覆盖全部分类的那个）
    const layerTotal = kb.LAYER_KEYS.reduce((a, k) => a + (s.byLayer[k] || 0), 0);
    const auxTotal = kb.AUX ? Object.keys(kb.AUX).reduce((a, k) => a + (s.byCategory[k] || 0), 0) : 0;
    assert.strictEqual(layerTotal + auxTotal, s.total, '五层全量 + 辅助类全量 = 总条目数');
    assert.strictEqual(s.teachingTotal, 1, 'teachingTotal 只算已发布的教学层条目');
    assert.strictEqual(s.withSource, 1, 'withSource = 已发布数（草稿恒无 source）');
  });
});

test('真实内容库：过滤器 count 与实际可检索条数逐类对齐（防口径再漂移）', () => {
  // 这条跑在**真实内容**上（draft=0），所以它锁的是"实现没跑偏"；
  // 草稿场景由上面 withTempKb 那几条负责。两者缺一不可。
  for (const c of kb.categories()) {
    const r = kb.search('', { category: c.key, limit: 999 });
    assert.strictEqual(c.count, r.total, `分类 ${c.key} 的 count 与可检索条数不一致`);
  }
});

// ═══ 三、存量零回归 ══════════════════════════════════════════════

test('③ 存量条目全部仍在且 id 唯一（新增层不得挤掉旧内容）', () => {
  // 🔴 修法说明（2026-10-08 扩容时暴露）：
  //   原写法是 `assert.strictEqual(s.byCategory.term, 15)` —— **锁死绝对数量**。
  //   它想守的是"存量不得被挤掉"，但写成了"不许增长"：任何合法扩容都会让它红，
  //   而红之后最省事的做法是**改数字**，于是这条门就退化成"跟着现状改"的摆设。
  //   ⇒ 改为断言**存量 id 仍存在**（精确守住原意），数量只做下界约束。
  const all = kb.search('', { limit: 9999 }).items;
  const ids = new Set(all.map((e) => e.id));
  assert.strictEqual(ids.size, all.length, 'id 必须全局唯一');

  // 存量基线的**锚点 id**（选各层最有代表性的；扩容不得删掉任何一个）
  const ANCHORS = [
    'term-sharpe', 'term-ic', 'term-pit',           // term 层
    'method-cross-section', 'method-lookahead',      // method 层
    'basis-fee-cn', 'basis-calendar',                // basis 层
    'paper-fama-french-1993', 'paper-newey-west-1987', // paper 层
    'principle-capm', 'principle-emh',               // principle 层
    'case-2008-crisis', 'cycle-kitchin',             // case / cycle 层
  ];
  const lost = ANCHORS.filter((a) => !ids.has(a));
  assert.deepStrictEqual(lost, [], `存量条目丢失：${lost.join(', ')}`);

  // 各层只设**下界**（不得低于扩容前水平），不设上界 —— 扩容是合法的
  const FLOOR = { term: 15, method: 16, basis: 10, paper: 10, principle: 7, case: 8, cycle: 4 };
  for (const [cat, floor] of Object.entries(FLOOR)) {
    const n = kb.stats().byCategory[cat] || 0;
    assert.ok(n >= floor, `${cat} 层 ${n} 条 < 下界 ${floor}（存量被挤掉了？）`);
  }
  // 存量 id 前缀不变
  for (const p of ['term-', 'method-', 'basis-', 'paper-']) {
    assert.ok([...ids].some((i) => i.startsWith(p)), `存量前缀 ${p} 丢失`);
  }
});

// 🔴 分类归属回归（#69）：两条内容属统计检验/因子构造方法论，此前误放在 principle 层。
//   锁 id 前缀 = 层的归属约定：改了前缀而忘了改文件，读起来会像"内容层与 id 层打架"。
test('③ 分类归属与 id 前缀一致（#69：2 条从 principle 移入 method）', () => {
  for (const id of ['method-nice-vs-meaningful', 'method-time-series-momentum']) {
    const e = kb.search('', { limit: 9999 }).items.find((x) => x.id === id);
    assert.ok(e, `${id} 应存在`);
    assert.strictEqual(e.category, 'method', `${id} 应归 method 层`);
  }
  // 旧 id 不得残留（残留 = 同一条内容有两个身份，related 会出现幽灵引用）
  const ids = new Set(kb.search('', { limit: 9999 }).items.map((e) => e.id));
  for (const dead of ['principle-nice-vs-meaningful', 'principle-time-series-momentum']) {
    assert.ok(!ids.has(dead), `旧 id ${dead} 仍存在（移动应改 id，不是复制）`);
  }
  // 跨层移动后 related 必须双向闭合（不能只改一半）
  for (const e of kb.search('', { limit: 9999 }).items) {
    for (const rid of e.related || []) {
      const t = kb.byIds([rid])[0];
      assert.ok(t, `断链：${e.id} → ${rid}（#69 移动时漏改引用）`);
    }
  }
});

test('③ 存量条目不因新字段而失效：body/source/tags/related 仍可读', () => {
  const t = kb.search('', { layers: ['term'], limit: 999 }).items.find((e) => e.id === 'term-pit');
  assert.ok(t, 'term-pit 应仍可检索到');
  assert.ok(t.body.length > 50, 'body 应完好');
  assert.ok(t.source.includes('Lopez') || t.source.includes('López'), 'source 应完好');
  assert.ok(Array.isArray(t.tags) && t.tags.length > 0, 'tags 应完好');
  // 新字段在存量条目上是空串（降级到 body），不是 undefined
  assert.strictEqual(t.summary, '', '存量条目 summary 应为空串而非 undefined');
  assert.strictEqual(t.draft, false);
  assert.strictEqual(t.isTeachingLayer, true);
});

// ═══ 四、复合词兜底（#72）═══════════════════════════════════

test('③ 复合词：「基钦周期」这类跨词边界的查询必须能命中（实测缺陷回归）', () => {
  // 实测缺陷：'基钦周期' → tokens ['基钦','钦周','周期']，其中'钦周'是跨词边界垃圾，
  // 任何条目都不含它 ⇒ AND 语义下整条被淘汰 ⇒ total=0。
  // 而条目 cycle-kitchin「基钦库存周期」确实存在、'基钦' 单独查也命中 ⇒ 是检索缺陷不是内容缺失。
  for (const q of ['基钦周期', '朱格拉周期']) {
    const r = kb.search(q, { limit: 5 });
    assert.ok(r.total > 0, `「${q}」应能命中（跨词边界的 2-gram 拖垮了 AND）`);
  }
  const r = kb.search('基钦周期', { limit: 5 });
  assert.ok(
    r.items.some((e) => e.id === 'cycle-kitchin'),
    `「基钦周期」应命中 cycle-kitchin，实际 ${r.items.map((e) => e.id).join(',')}`,
  );
});

test('③ 复合词：同义译名也能命中（科钦 = 基钦）', () => {
  // Kitchin 在中文文献里有「基钦/科钦」两种译名，条目只写了「基钦」。
  // 这类同义译名靠枚举维护是打地鼠，靠片段匹配才能自然覆盖。
  const r = kb.search('科钦周期', { limit: 5 });
  assert.ok(r.total > 0, '「科钦」（同义译名）应能命中');
});

test('🔴 复合词层不得抢走既有排序（实测回归，必须留门）', () => {
  // 🔴 这条是本段最贵的教训：复合词层最初插在 OR 降级**之前**，
  //   结果「PIT是什么意思」原本的排序被改动（term-pit 被挤到第 2、
  //   basis-financial-pubdate 抢到第 1），「涨跌停规则怎么处理的」也丢了首位。
  //   根因：OR 降级按**词项覆盖度**打分，质量高于片段层；
  //   片段层只按片段数累加，长条目容易虚高。
  //   ⇒ 顺序必须是 AND → OR → 复合词兜底。
  //   本测试锁住「既有排序不因新增兜底层而改变」。
  //   ⚠️ 只锁前 3 名：limit 给 5 时第 4/5 名本就是同一 OR 路径产出的，不在本门范围。
  const pit = kb.search('PIT是什么意思', { limit: 5 });
  assert.strictEqual(pit.mode, 'keyword', '既有整句提问应仍走 keyword（OR 降级）路径，不该被新层接管');
  assert.deepStrictEqual(
    pit.items.slice(0, 3).map((e) => e.id),
    ['basis-financial-pubdate', 'term-pit', 'method-lookahead'],
    '「PIT是什么意思」的前 3 名排序被复合词层改变了（这是实测过的真实回归）',
  );
  const guard = kb.search('涨跌停规则怎么处理的', { limit: 5 });
  assert.deepStrictEqual(
    guard.items.slice(0, 3).map((e) => e.id),
    ['term-limit-up-down', 'basis-limit-guard', 'case-2015-ashare'],
    '「涨跌停规则怎么处理的」前 3 名排序被改变了',
  );
});

test('🔴 复合词层不得把无关查询变成有结果（防假阳性）', () => {
  // ⚠️ 残留疑问词会制造假阳性：「米哈游是什么」切出的「什么」
  //   曾命中标题「多重比较：**什么**是试得越多越容易骗自己」。
  //   ⇒ 必须剥离疑问尾巴后再切片段。
  //   这两条走 AND/OR 既有路径（mode!=='substring'）⇒ 由新层引入的假阳性才算本门的锅。
  for (const q of ['米哈游是什么', '12345678']) {
    const r = kb.search(q, { limit: 5 });
    assert.ok(
      r.mode !== 'substring',
      `「${q}」不该由复合词层命中（mode=${r.mode}，ids=${r.items.map((e) => e.id).join(',')}）`,
    );
    assert.strictEqual(r.total, 0, `「${q}」不该命中任何条目，实际 ${r.items.map((e) => e.id).join(',')}`);
  }
  // ⚠️ 「今天中午吃什么」命中 1 条是**既有缺陷**（OR 降级路径，改动前就是如此），
  //   已用 git archive 基线对照确认 ⇒ 不在本门范围，另立欠账跟踪。
  //   这里只锁一条：它不得是 substring 模式（否则说明是新层引入的）。
  const lunch = kb.search('今天中午吃什么', { limit: 5 });
  assert.notStrictEqual(lunch.mode, 'substring', '「今天中午吃什么」不该走复合词层');
});

test('③ 检索模式字段：新增 substring 档位（供前端区分置信度）', () => {
  // mode='substring' 与 mode='keyword' 语义不同：
  //   keyword = 放宽到词项匹配（置信度较低）；substring = 识别出复合词（置信度较高）。
  //   前端需要区分二者才能给不同的提示文案。
  const r = kb.search('基钦周期', { limit: 3 });
  assert.strictEqual(r.mode, 'substring', `复合词命中应标substring，实际 ${r.mode}`);
  // 既有三态不能消失
  assert.strictEqual(kb.search('', { limit: 3 }).mode, 'browse', 'browse 档位必须仍在');
});

// ═══ 五、结构化字段 ══════════════════════════════════════════

test('④ 新层条目带结构化字段（定义/公式/局限），这是 §11.1 的显式要求', () => {
  for (const layer of ['principle', 'case', 'cycle']) {
    const items = kb.listByLayer(layer);
    assert.ok(items.length > 0, `${layer} 应有条目`);
    for (const e of items) {
      assert.ok(e.summary && e.summary.length > 5, `${e.id} 缺 summary（定义）`);
      assert.ok(e.limitations && e.limitations.length > 5, `${e.id} 缺 limitations（局限）`);
      assert.ok(e.applicability && e.applicability.length > 5, `${e.id} 缺 applicability（适用场景）`);
      assert.ok(e.source && e.source.length > 10, `${e.id} 缺出处`);
    }
  }
});

test('④ listByLayer 只返回教学层；非教学层传入一律空（学习路径的边界）', () => {
  assert.ok(kb.listByLayer('cycle').length > 0);
  for (const aux of ['basis', 'paper']) {
    assert.strictEqual(kb.listByLayer(aux).length, 0, `${aux} 不是教学层，应返回空`);
  }
  assert.strictEqual(kb.listByLayer('不存在的层').length, 0);
});

test('④ search 支持 layers 多值过滤（学习路径批量取用）', () => {
  const r = kb.search('', { layers: ['principle', 'cycle'], limit: 99 });
  const cats = new Set(r.items.map((e) => e.category));
  assert.deepStrictEqual([...cats].sort(), ['cycle', 'principle'], '只应返回指定的两层');
});

// ═══ 五、🔴 防编造 ═════════════════════════════════════════════

test('🔴 teachingModel 必须是真实存在的预置模板 key（防编造模型 id）', () => {
  const all = kb.search('', { limit: 9999 }).items;
  const linked = all.filter((e) => e.teachingModel);
  assert.ok(linked.length > 0, 'cycle/case 条目应挂教学模型（§11.1 教学因子联动）');
  for (const e of linked) {
    assert.ok(
      templateKeys.has(e.teachingModel),
      `${e.id} 指向不存在的模板「${e.teachingModel}」—— 可选模板：${[...templateKeys].join(', ')}`,
    );
  }
});

// ⚠️ 原「每个 cycle/case 条目都挂了教学模型」已删除：它要求 100% 覆盖率，
//   与「模板不适用时应显式置 null」直接对立 —— 那条断言会逼着人给每条硬凑一个
//   语义不匹配的模板，正是独立审查发现的假通过根源。
//   替代物：下面两条 —— 有模型必须写清观察什么 / 无模型必须说明为何不挂。

// 🔴 独立审查的判定：旧那条「每个条目都挂了模型」是**假通过**。
//   它只校验 key 存在，区分不了"语义贴切"与"随便挑一个存在的 key" ——
//   4 条 case 讲崩盘机制/杠杆/估值重定价却全挂 mom20-baseline，照样全绿。
//   下面两条把它升级为真验证。
test('🔴 teachingModel 必须有教学说明，且所有说明互不相同（防"随便挑一个 key"）', () => {
  const linked = kb.search('', { limit: 9999 }).items.filter((e) => e.teachingModel);
  const seen = new Map();
  for (const e of linked) {
    const note = e.teachingNote || '';
    assert.ok(note.length >= 20, `${e.id} 挂了模型却没写教学说明（学生到底观察什么？）—— 这正是假通过的入口`);
    if (seen.has(note)) {
      assert.fail(`🔴 ${e.id} 的 teachingNote 与 ${seen.get(note)} 完全相同：模板可复用，**观察说明**不能复制`);
    }
    seen.set(note, e.id);
  }
  assert.strictEqual(seen.size, linked.length, '每条挂模型的条目都应有独一无二的观察说明');
});

test('🔴 教学模型不适用的条目必须显式置 null 并说明理由（宁缺勿硬凑）', () => {
  // case-ltcm-1998 是跨资产相对价值 + 高杠杆，而本平台 4 个模板全是 A 股单资产动量族，
  // 挂任何一个都是教错 ⇒ 正确做法是置 null 并在 note 里讲清为什么。
  const ltcm = kb.search('', { limit: 9999 }).items.find((e) => e.id === 'case-ltcm-1998');
  assert.ok(ltcm, 'case-ltcm-1998 应存在');
  assert.strictEqual(ltcm.teachingModel, null, '🔴 语义不适配却挂了模板 —— 比不挂更糟（学生会跑出错误结论）');
  const note = ltcm.teachingNote || '';
  assert.ok(note.length >= 20 && note.includes('不挂'), '置 null 时必须在 teachingNote 说明为何不挂，否则只是"忘了填"');
});

test('🔴 cycle/case 每条要么挂真实模板+说明，要么置 null+理由（不许糊弄条目）', () => {
  for (const layer of ['cycle', 'case']) {
    const items = kb.listByLayer(layer);
    assert.ok(items.length > 0, `${layer} 应有条目`);
    for (const e of items) {
      if (e.teachingModel) {
        assert.ok(templateKeys.has(e.teachingModel), `${e.id} 指向不存在的模板`);
        assert.ok((e.teachingNote || '').length >= 20, `${e.id} 缺教学说明`);
      } else {
        assert.ok((e.teachingNote || '').length >= 20, `${e.id} 既无教学模型也无说明理由`);
      }
    }
  }
});

test('🔴 related 只引用真实存在的 id（防死链）', () => {
  const all = kb.search('', { limit: 9999 }).items;
  const ids = new Set(all.map((e) => e.id));
  const dead = [];
  for (const e of all) {
    for (const r of e.related || []) if (!ids.has(r)) dead.push(`${e.id} → ${r}`);
  }
  assert.strictEqual(dead.length, 0, `related 死链：${dead.join('; ')}`);
});
