// ─────────────────────────────────────────────────────────────
// 知识库「前端契约」测试（#70）
//
//   由来（同 models-ui-contract.test.cjs）：本机 Edge 无法以 CDP 启动，
//   做不了真浏览器渲染验证 ⇒ 用契约断言替代，专门抓**运行时字段错配**。
//   🔴 本项目吃过 6 次「臆造后端字段名」：TS 不报错、UI 处处 undefined。
//   本文件把「页面读取的每个字段都真实存在于真实响应里」钉死。
//
//   它与 knowledge-2.test.cjs 的分工：
//     前者锁**知识内容**（分层/发布门/教学模型语义）
//     本文件锁**接口形状**（前端读什么、后端是否给得出）
//   两边缺一不可：内容对但字段名错，UI 一样是空白。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.KNOWLEDGE_DIR = path.join(__dirname, '..', 'server', 'knowledge');
const kb = require('../server/knowledge.cjs');
const { registerKnowledgeScreenerRoutes } = require('../server/routes/knowledge-screener.cjs');
const { MODEL_TEMPLATES } = require('../shared/modelspec.cjs');
const layers = require('../shared/knowledge-layers.cjs');
const { parseSource, splitRefs } = require('../shared/knowledge-source.cjs');

// 用真实内容目录起路由，拿**真实响应体**做契约（不构造假 app/req-res 之外的东西）
const { LAYERS, AUX, CATEGORIES, LAYER_KEYS } = layers;
const templateKeys = new Set(MODEL_TEMPLATES.map((t) => t.key));

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
    delete: (p, h) => routes.set(`DELETE ${p}`, h),
  };
}
const app = () => {
  const a = fakeApp();
  registerKnowledgeScreenerRoutes(a, {
    knowledgeBase: kb,
    screener: { STRATEGIES: {} },
    watchlist: { list: () => [], add: () => ({}), remove: () => ({}) },
    broker: { uidOf: () => 'anon' },
    isAdmin: () => false,
  });
  return a;
};
const getSearch = async (q = '', category = '') => {
  const h = app().routes.get('GET /api/knowledge/search');
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  await h({ query: { q, category }, params: {} }, res);
  return res.body;
};

function assertHasKeys(obj, keys, label) {
  const missing = keys.filter((k) => !(k in (obj || {})));
  assert.deepStrictEqual(missing, [], `${label} 缺少字段：${missing.join(', ')}（前端会读成 undefined）`);
}

// ═══ 一、分类联合类型（#70 的起因：类型缺 3 个层）══════════════════

test('契约：全部分类都能被前端类型表达（此前联合类型缺 principle/case/cycle）', () => {
  // 单一源：前端 src/api/knowledge.ts 的 category 联合类型从 shared/knowledge-layers 派生。
  // 这里锁三件事：① 教学层 key 有序且都在 CATEGORIES 里；② 辅助类也在；
  // ③ **真实响应里的每个 category 都在 taxonomy 内**（taxonomy 漏层 ⇒ 前端渲染成"其他"）。
  assert.deepStrictEqual(Object.keys(LAYERS), LAYER_KEYS, 'LAYER_KEYS 顺序必须等于 LAYERS 的声明顺序（学习路径靠它）');
  for (const k of LAYER_KEYS) assert.ok(CATEGORIES[k], `教学层 ${k} 在 CATEGORIES 里缺 label`);
  for (const k of Object.keys(AUX)) assert.ok(CATEGORIES[k], `辅助类 ${k} 在 CATEGORIES 里缺 label`);
  assert.strictEqual(Object.keys(CATEGORIES).length, LAYER_KEYS.length + Object.keys(AUX).length, 'CATEGORIES = 五层 + 辅助类，不得有第四类');
  const all = kb.search('', { limit: 9999 }).items;
  const unknown = all.filter((e) => !CATEGORIES[e.category]).map((e) => `${e.id}:${e.category}`);
  assert.deepStrictEqual(unknown, [], `taxonomy 未覆盖的分类：${unknown.join(', ')}`);
});

test('契约：分层的两套口径都在响应里（#68：publishedBy* 不可省）', () => {
  // 前端要同时显示"内容工作量"与"学习路径可用量"，少一套就会出现虚高数字
  assertHasKeys(kb.stats(), [
    'total', 'published', 'draft', 'withSource',
    'byCategory', 'byLayer', 'publishedByCategory', 'publishedByLayer',
    'teachingTotal', 'withTeachingModel',
  ], 'stats');
});

test('契约：search 响应含页面渲染所需的全部字段（KnowledgeTab 逐个读取）', async () => {
  const r = await getSearch();
  assertHasKeys(r, ['ok', 'query', 'category', 'mode', 'total', 'items', 'stats', 'categories'], 'search');
  assert.ok(r.items.length > 0, '真实内容库应有条目');
  // 🔴 这一行就是"臆造字段"的克星：页面读什么，这里就断言什么
  assertHasKeys(r.items[0], [
    'id', 'category', 'categoryLabel', 'isTeachingLayer', 'title', 'body',
    'summary', 'formula', 'applicability', 'limitations',
    'teachingModel', 'teachingNote', 'source', 'draft',
    'tags', 'related', 'score', 'matched',
  ], 'search.items[0]');
  // 过滤器 chip 读的字段（#68：count 已发布 / total 全量 / draft 待办）
  assertHasKeys(r.categories[0], ['key', 'label', 'count', 'total', 'draft'], 'search.categories[0]');
});

test('契约：结构化字段类型稳定（缺失必须是空串，不是 undefined）', () => {
  // 🔴 前端判空用 truthiness（`entry.summary && …`）。若后端改成省略字段，
  //   `undefined && …` 恰好也是 falsy，**但** `undefined.length` 会炸、且类型声明说 string。
  //   钉死"空串"这条契约，前端才敢用 truthiness 判空。
  const all = kb.search('', { limit: 9999 }).items;
  for (const e of all) {
    for (const f of ['summary', 'formula', 'applicability', 'limitations', 'teachingNote']) {
      assert.strictEqual(typeof e[f], 'string', `${e.id}.${f} 必须是 string（缺失给空串），实际 ${typeof e[f]}`);
    }
    assert.ok(e.teachingModel === null || typeof e.teachingModel === 'string', `${e.id}.teachingModel 必须是 string|null`);
  }
});

test('契约：teachingModel 的 key 与 /api/models/schema 的模板对得上（#70 跳转不失效）', () => {
  // 知识库侧跳模型工坊只带 key，不做映射表 ⇒ 两边 key 必须一致，否则跳过去是死链。
  const linked = kb.search('', { limit: 9999 }).items.filter((e) => e.teachingModel);
  assert.ok(linked.length > 0, '应有挂教学模型的条目');
  for (const e of linked) {
    assert.ok(templateKeys.has(e.teachingModel), `${e.id} 的 teachingModel「${e.teachingModel}」不在 MODEL_TEMPLATES 里`);
  }
});

// ═══ 三、出处结构化字段（#71）══════════════════════════════════

test('契约：条目带出处结构化字段（citationStrength/sourceRefs）', async () => {
  // 🔴 为什么前端要读得到：页面据此显示「本条出处可核查到什么强度」。
  //   只说"有出处"（withSource）会让人误以为出处都是核过的 ——
  //   而实测只有 7/70 条真的能被机器逐字段比对。
  const r = await getSearch();
  assertHasKeys(r.items[0], ['citationStrength', 'sourceRefs'], 'search.items[0]');
  assert.ok(['none', 'existential', 'structured', 'verifiable'].includes(r.items[0].citationStrength), '强度取值必须在既定档位内');
  assert.ok(Array.isArray(r.items[0].sourceRefs), 'sourceRefs 必须是数组');
  // 每条 ref 的形状：前端要读 kind/strength 渲染徽标
  if (r.items[0].sourceRefs.length) {
    assertHasKeys(r.items[0].sourceRefs[0], ['kind', 'strength', 'doi', 'year', 'container', 'title'], 'items[0].sourceRefs[0]');
  }
});

test('契约：stats 暴露出处强度分布（内容质量指标，与 withSource 同级）', () => {
  const s = kb.stats();
  assertHasKeys(s, ['byCitationStrength'], 'stats');
  const b = s.byCitationStrength;
  assert.ok(typeof b.verifiable === 'number' && typeof b.structured === 'number', 'verifiable/structured 必须是数字');
  const sum = Object.values(b).reduce((a, c) => a + c, 0);
  assert.strictEqual(sum, s.published, `强度分布之和(${sum})必须等于已发布数(${s.published}) —— 否则有条目被漏统计`);
});

test('契约：sourceRefs 是派生的，不得与 source 文本分叉', () => {
  // 🔴 这是本设计最重要的一条：**不把结构化结果写进 JSON**（否则两份表示会分叉，
  //   且分叉后无法判定哪个是真的）。所以必须能证明 refs 确实来自当前 source 文本。
  const all = kb.search('', { limit: 9999 }).items;
  for (const e of all) {
    const parsed = parseSource(e.source);
    assert.strictEqual(e.sourceRefs.length, parsed.refs.length, `${e.id}: sourceRefs 条数与即时解析不一致（JSON 里可能存了派生值）`);
    assert.strictEqual(e.sourceRefs.length, splitRefs(e.source).length, `${e.id}: 与按分号拆分的条数不一致`);
  }
});

test('契约：教学层徽标可渲染（isTeachingLayer 与 LAYER_KEYS 口径一致）', () => {
  // KnowledgeTab 用 LAYER_BADGE[category] 渲染「教学层 · X」徽标；
  // 若 isTeachingLayer 为 true 却没有徽标文案，卡片上会出现光秃秃的虚线框。
  const all = kb.search('', { limit: 9999 }).items;
  const teaching = all.filter((e) => e.isTeachingLayer);
  assert.ok(teaching.length > 0, '应有教学层条目');
  for (const e of teaching) {
    assert.ok(LAYERS[e.category], `isTeachingLayer=true 但 taxonomy 无此层：${e.category}（徽标会渲染成空）`);
  }
  // 反向：辅助类不得被标成教学层（否则学习路径会混入"平台费率口径"）
  for (const e of all.filter((x) => !x.isTeachingLayer)) {
    assert.ok(AUX[e.category], `非教学层却不在 AUX 里：${e.category}`);
  }
});
