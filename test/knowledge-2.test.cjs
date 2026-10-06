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

test('② 全库草稿数为 0（存量 withSource 100%，新条目必须都带出处）', () => {
  const s = kb.stats();
  assert.strictEqual(s.draft, 0, `存在未过审条目：${kb.search('', { includeDraft: true, limit: 999 }).items.filter((e) => e.draft).map((e) => e.id).join(', ')}`);
  assert.strictEqual(s.published, s.total, '已发布数应等于总数（无草稿时）');
  assert.strictEqual(s.withSource, s.total, '每条都必须有 source');
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

// ═══ 三、存量零回归 ══════════════════════════════════════════════

test('③ 存量 49 条全部仍在且 id 唯一（新增层不得挤掉旧内容）', () => {
  const s = kb.stats();
  assert.strictEqual(s.byCategory.term, 15, 'term 应仍为 15');
  assert.strictEqual(s.byCategory.method, 14, 'method 应仍为 14');
  assert.strictEqual(s.byCategory.basis, 10, 'basis 应仍为 10');
  assert.strictEqual(s.byCategory.paper, 10, 'paper 应仍为 10');
  const all = kb.search('', { limit: 9999 }).items;
  const ids = all.map((e) => e.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'id 必须全局唯一');
  // 存量 id 前缀不变
  for (const p of ['term-', 'method-', 'basis-', 'paper-']) {
    assert.ok(ids.some((i) => i.startsWith(p)), `存量前缀 ${p} 丢失`);
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

// ═══ 四、结构化字段 ══════════════════════════════════════════

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

test('🔴 每个 cycle/case 条目都挂了教学模型（§11.1「每个 cycle/case 可挂教学用模型」）', () => {
  for (const layer of ['cycle', 'case']) {
    const items = kb.listByLayer(layer);
    const missing = items.filter((e) => !e.teachingModel).map((e) => e.id);
    assert.strictEqual(missing.length, 0, `${layer} 层有条目未挂教学模型：${missing.join(', ')}`);
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
