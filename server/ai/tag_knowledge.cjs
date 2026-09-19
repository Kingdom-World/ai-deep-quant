// ─────────────────────────────────────────────────────────────
// CLI：为 knowledge.json 的 50 条问答生成标签映射（A2 任务产出之二）
//   运行：node server/ai/tag_knowledge.cjs
//   输出：data/ai/knowledge-tags.json + 控制台统计
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { tagsFor } = require('./knowledge-tags.cjs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'ai');
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');
const OUT_FILE = path.join(DATA_DIR, 'knowledge-tags.json');

// 与 brain.cjs 的 normalizeQ 完全一致
function normalizeQ(s) {
  return String(s || '').toLowerCase().replace(/[？?！!。，,、.\s：:（）()【】\[\]]+/g, '');
}

function main() {
  const raw = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
  const entries = Array.isArray(raw.entries) ? raw.entries : [];

  const map = {};
  const vocab = new Set();
  let totalTags = 0;
  let tagged = 0;

  for (const e of entries) {
    const key = normalizeQ(e.q);
    const tags = tagsFor(e.q);
    map[key] = tags;
    if (tags.length) tagged += 1;
    totalTags += tags.length;
    for (const t of tags) vocab.add(t);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    count: entries.length,
    tags: map,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  // ── 统计 ──
  console.log('==== 知识库标签生成统计 ====');
  console.log('总条数          :', entries.length);
  console.log('带标签条数      :', tagged, `/ ${entries.length}`);
  console.log('平均标签数      :', (totalTags / entries.length).toFixed(2));
  console.log('标签词表规模    :', vocab.size, '个去重标签');
  console.log('覆盖文件        :', OUT_FILE);
  console.log('\n---- 6 条示例（问题 → 标签）----');
  const samples = entries.slice(0, 6);
  for (const e of samples) {
    console.log(`· ${e.q}`);
    console.log(`  → ${JSON.stringify(tagsFor(e.q))}`);
  }
}

main();
