// ─────────────────────────────────────────────────────────────
// 知识库测试（M1-1.3）
//   锁死四条不变量：
//   ① 内容完整性——条目数 ≥30、每条必须有出处、id 全局唯一（G1 验收硬指标）
//   ② 检索语义——AND 多词、大小写不敏感、分类过滤、空查询为浏览模式
//   ③ 排序可解释——标题命中权重高于正文命中
//   ④ 容错——未命中返回空集不抛错；关联 id 不存在时静默忽略
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// 固定到真实内容目录（不依赖环境变量，确保测的就是线上内容）
process.env.KNOWLEDGE_DIR = path.join(__dirname, '..', 'server', 'knowledge');
const kb = require('../server/knowledge.cjs');

test('【G1 验收】条目数 ≥ 30', () => {
  const s = kb.stats();
  assert.ok(s.total >= 30, `实际 ${s.total} 条，要求 ≥30`);
});

test('【G1 验收】每条条目都必须带出处（source 非空且足够长）', () => {
  const miss = kb.search('').items.filter((e) => !e.source || e.source.length < 10);
  assert.equal(miss.length, 0, `缺出处的条目：${miss.map((e) => e.id).join(', ')}`);
});

test('【G1 验收】id 全局唯一', () => {
  const ids = kb.search('', { limit: 1000 }).items.map((e) => e.id);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.equal(dup.length, 0, `重复 id：${dup.join(', ')}`);
});

test('分类覆盖：术语/口径/方法论三类均非空（M1 内容规划）', () => {
  const cats = kb.categories().map((c) => c.key);
  for (const k of ['term', 'basis', 'method']) {
    assert.ok(cats.includes(k), `缺少分类 ${k}`);
  }
  const cat = kb.categories();
  const sum = cat.reduce((a, c) => a + c.count, 0);
  assert.equal(sum, kb.stats().total, '分类计数之和应等于总条目数');
});

test('检索：单词命中且结果包含该词的条目', () => {
  const r = kb.search('PIT');
  assert.ok(r.total > 0, 'PIT 应有命中');
  assert.ok(r.items.every((e) => e.matched.includes('pit')), '每条命中项的 matched 应包含查询词');
});

test('检索：大小写不敏感', () => {
  const a = kb.search('pit').items.map((e) => e.id);
  const b = kb.search('PIT').items.map((e) => e.id);
  const c = kb.search('Pit').items.map((e) => e.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test('检索：多词为 AND 语义（任一词未命中即淘汰）', () => {
  const both = kb.search('复权 收益');
  const only = kb.search('复权');
  assert.ok(both.total <= only.total, 'AND 结果不应多于单词结果');
  assert.ok(both.total > 0, '应存在同时含两词的条目');
  for (const e of both.items) {
    for (const t of ['复权', '收益']) assert.ok(e.matched.includes(t));
  }
});

test('检索：分类过滤生效', () => {
  const all = kb.search('复权');
  const basis = kb.search('复权', { category: 'basis' });
  assert.ok(basis.items.every((e) => e.category === 'basis'), '过滤后应只剩该分类');
  assert.ok(basis.total <= all.total);
});

test('检索：空查询 = 浏览模式，返回该分类全部条目', () => {
  const r = kb.search('', { category: 'basis' });
  assert.equal(r.total, kb.categories().find((c) => c.key === 'basis').count);
  assert.ok(r.items.every((e) => e.score === 0), '浏览模式不打分');
});

test('检索：空查询遍历全部分类时能覆盖全部条目', () => {
  const r = kb.search('', { limit: 1000 });
  assert.equal(r.total, kb.stats().total);
});

test('检索：明显无关的查询返回空集而非报错', () => {
  // 纯英文乱码：抽不出任何有效关键词 → 必须零命中
  const r = kb.search('qqqzzz');
  assert.equal(r.total, 0);
  assert.deepEqual(r.items, []);
});

test('检索：纯符号查询返回空集（不触发降级噪声）', () => {
  assert.equal(kb.search('!!!???').total, 0);
});

test('降级路径的噪声是显式标注的，不是伪装的精确结果', () => {
  // 混合输入（有效词 + 无义词）无法在物理上完全区分，故接受少量噪声，
  // 但必须带 mode='keyword' 与 matched 词项——调用方能识别这是放宽匹配。
  const r = kb.search('zzz绝对不存在的词zzz');
  if (r.total > 0) {
    assert.equal(r.mode, 'keyword', '噪声结果必须标注为关键词降级');
    assert.ok(r.items.every((e) => e.matched.length > 0), '必须给出命中词项供核查');
  }
});

test('检索：纯空白查询等同空查询', () => {
  assert.equal(kb.search('   ').total, kb.stats().total);
});

test('排序：标题命中优先于仅正文命中', () => {
  // "Newey-West" 同时出现在 term-newey-west 的标题与 term-stats-significance 的正文
  const r = kb.search('newey');
  assert.ok(r.total >= 2, 'newey 应至少命中 2 条');
  assert.equal(r.items[0].id, 'term-newey-west', '标题命中者应排第一');
});

test('排序：结果可复现（同分按 id 稳定排序）', () => {
  const a = kb.search('因子').items.map((e) => e.id);
  const b = kb.search('因子').items.map((e) => e.id);
  assert.deepEqual(a, b);
});

test('limit 截断生效且 total 仍为真实命中数', () => {
  const full = kb.search('因子', { limit: 1000 });
  const cut = kb.search('因子', { limit: 2 });
  assert.equal(cut.items.length, 2);
  assert.equal(cut.total, full.total, 'total 不应被 limit 影响');
});

test('byIds：按 id 取条目，缺失 id 静默忽略', () => {
  const one = kb.byIds(['term-pit']);
  assert.equal(one.length, 1);
  assert.equal(one[0].id, 'term-pit');
  const mixed = kb.byIds(['term-pit', '不存在的-id', 'term-ic']);
  assert.equal(mixed.length, 2);
});

test('关联完整性：related 指向的 id 必须在库内存在', () => {
  const all = kb.search('', { limit: 1000 }).items;
  const ids = new Set(all.map((e) => e.id));
  const broken = [];
  for (const e of all) {
    for (const r of e.related) if (!ids.has(r)) broken.push(`${e.id} → ${r}`);
  }
  assert.equal(broken.length, 0, `悬空关联：${broken.join(', ')}`);
});

test('检索性能：全库检索在 200ms 内（G1 验收口径）', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) kb.search('复权 收益 Newey-West');
  const avg = (Date.now() - t0) / 20;
  assert.ok(avg < 200, `平均 ${avg}ms，超出 200ms 口径`);
});

// ── 自然语言提问降级（M1 实测发现的真实缺陷）──
//   背景：模型/用户习惯把整句当查询（"PIT是什么意思"），严格 AND 必然零命中，
//   Agent 因此拿到"没有相关条目"并开始编造答案。降级路径是必需的，不是锦上添花。

test('【实测缺陷回归】整句提问「PIT是什么意思」必须命中 term-pit', () => {
  const r = kb.search('PIT是什么意思');
  assert.ok(r.total > 0, '整句提问不应零命中');
  assert.equal(r.mode, 'keyword', '应走关键词降级路径');
  assert.ok(r.items.some((e) => e.id === 'term-pit'), 'term-pit 应在结果中');
});

test('【实测缺陷回归】「涨跌停规则怎么处理的」命中涨跌停条目且排首位', () => {
  const r = kb.search('涨跌停规则怎么处理的');
  assert.ok(r.total > 0);
  assert.equal(r.items[0].id, 'term-limit-up-down', '最相关条目应排第一');
});

test('【实测缺陷回归】「什么是Newey-West调整」命中 newey-west', () => {
  const r = kb.search('什么是Newey-West调整');
  assert.ok(r.items.some((e) => e.id === 'term-newey-west'));
});

test('降级不破坏严格路径：多关键词命中时仍走 AND', () => {
  const r = kb.search('复权 收益');
  assert.equal(r.mode, 'and', '两个词都能命中时应走严格 AND');
});

test('extractKeywords：英文词块原样保留、中文长句切出 n-gram', () => {
  assert.deepEqual(kb.extractKeywords('PIT是什么意思'), ['pit']);
  const kws = kb.extractKeywords('涨跌停规则怎么处理的');
  assert.ok(kws.includes('涨跌停'), '应切出「涨跌停」');
  assert.ok(kws.includes('规则'), '应切出「规则」');
  assert.ok(!kws.some((k) => k.includes('怎么处理')), '疑问尾巴应被去除');
});

test('extractKeywords：纯停用词输入返回空数组（不产生噪声查询）', () => {
  assert.deepEqual(kb.extractKeywords('是什么意思'), []);
});

test('检索模式字段：browse / and / keyword 三态齐全', () => {
  assert.equal(kb.search('').mode, 'browse');
  assert.equal(kb.search('复权 收益').mode, 'and');
  assert.equal(kb.search('PIT是什么意思').mode, 'keyword');
});

test('【噪声控制】n-gram 不再产出跨词边界的 3-gram 碎片', () => {
  // 「绝对不存在」曾切出「对不存」——跨词边界碎片，会误命中正文
  const kws = kb.extractKeywords('zzz绝对不存在zzz');
  assert.ok(!kws.includes('对不存'), '不应产出跨边界的 3-gram 碎片');
  assert.ok(!kws.includes('绝对不存'), '不应产出跨边界的 4-gram 碎片');
  assert.ok(kws.includes('绝对'), '段首 2-gram 应保留');
  assert.ok(kws.includes('存在'), '段尾 2-gram 应保留');
});

test('【噪声控制】纯无意义串仍返回空集（不靠 n-gram 噪声凑数）', () => {
  for (const q of ['zzzqqqxxx', 'asdfghjkl', '完全无关的乱码句子']) {
    const r = kb.search(q);
    assert.equal(r.total, 0, `「${q}」不应命中任何条目`);
  }
});

test('【降级诚实性】命中放宽结果时必须带 mode=keyword 与 matched 词项', () => {
  // 「存在」是中文实词且正文含该词，命中本身是正确行为；
  // 关键是**必须标注为放宽匹配**，让调用方能判断可信度。
  const r = kb.search('zzz绝对不存在zzz');
  if (r.total > 0) {
    assert.equal(r.mode, 'keyword', '放宽匹配必须显式标注，不得伪装成精确结果');
    assert.ok(r.items.every((e) => Array.isArray(e.matched) && e.matched.length > 0), '每条都应带命中词项');
  }
});
