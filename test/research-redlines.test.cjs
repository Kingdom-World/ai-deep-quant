'use strict';
// ─────────────────────────────────────────────────────────────
// 借鉴红线的**可执行守门**（跑在 CI 里）
//
// 🔴 为什么不能只写在注释/记忆里：
//   2026-10-10 用户约定「借鉴 GitHub，不确定就去查，借鉴后要守正创新」。
//   「守正」如果没有断言，就是靠人记得 —— 而引入依赖那一下是顺手的事，
//   三个月后没人记得当初为什么不用向量检索。
//   ⇒ 把三条红线断言到 package.json 与源码形态上，抄进来就会被拦。
//
//   三条红线（与 tools/research-github.cjs 的筛查一致，判据从项目铁律倒推）：
//   ① 禁止引入向量检索依赖替换现有规则检索链
//   ② 禁止引入 LLM-as-Judge / 评估框架（LLM 评 LLM）
//   ③ 禁止引入 LLM SDK 进服务端（LLM 只解读，出网面最小化）
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const depNames = Object.keys(allDeps);

const hits = (re) => depNames.filter((d) => re.test(d));

test('红线①：未引入向量检索依赖（规则检索链是刻意选择，不是还没做）', () => {
  // 为什么严：向量检索会加 3+ 个重依赖，且把"命中"变成"相似度"，
  // 降低出处可核验性 —— 而本项目知识库每条都带 DOI 引用。
  const bad = hits(/^(faiss|chroma|qdrant|pinecone|weaviate|milvus|pgvector|@.*vector.*)$/i);
  assert.deepStrictEqual(bad, [],
    `禁止引入向量检索依赖（会替换 AND→OR→substring 规则链）：${bad.join(', ')}`);
  const embedded = hits(/^(hnswlib|annoy|faiss-node)$/i);
  assert.deepStrictEqual(embedded, [], `同类嵌入式向量库也不该引入：${embedded.join(', ')}`);
});

test('红线②：未引入 LLM-as-Judge / RAG 评估框架', () => {
  // 为什么严：本项目 eval 判定必须是导出纯函数（agent-eval.cjs 的 judgeCase），
  // 且「验证门永不读 LLM 输出」。让 LLM 评 LLM = 把被验证对象接进验证门。
  const bad = hits(/^(deepeval|ragas|llm-?as-?a-?judge|guardrails|langsmith)$/i);
  assert.deepStrictEqual(bad, [],
    `禁止引入 LLM 评估框架（验证门永不读 LLM 输出）：${bad.join(', ')}`);
});

test('红线③：未引入 LLM SDK 进服务端', () => {
  // 为什么严：LLM 出网必须走 cloud.cjs 的既定通道（含免费模型白名单硬拦截），
  //   绕过它就绕过了白名单 —— 那正是"付费模型被无声扣费"的入口。
  const bad = hits(/^(openai|langchain|@langchain\/.*|@anthropic-ai\/.*|google-generativeai)$/i);
  assert.deepStrictEqual(bad, [],
    `禁止直接引入 LLM SDK（必须走 cloud.cjs 以保留白名单拦截）：${bad.join(', ')}`);
});

test('agent-eval 的判定仍是导出纯函数（借鉴不得破坏它）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'agent-eval.cjs'), 'utf8');
  assert.match(src, /module\.exports\s*=\s*\{[^}]*judgeCase/, 'judgeCase 必须继续导出');
  assert.match(src, /module\.exports\s*=\s*\{[^}]*runCases/, 'runCases 必须继续导出');
  const body = src.slice(src.indexOf('function judgeCase'), src.indexOf('function runCases'));
  assert.ok(!/await\s+fetch|axios|http/i.test(body),
    'judgeCase 内不得有网络调用 —— 必须是可离线复现的纯函数');
});

test('知识库检索仍是规则三级降级（未被向量检索替换）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'knowledge.cjs'), 'utf8');
  assert.ok(/AND/.test(src), 'AND 语义仍在');
  assert.ok(/substring/i.test(src), 'substring 兜底仍在');
  assert.ok(!/embedding|cosineSimilarity|vectorSearch|topK/i.test(src),
    '检索链里不得出现向量检索调用');
});

test('🔴 借鉴工具不得被接入服务端或 Agent 工具链', () => {
  // 理由：接进 Agent = 给 LLM 开一个出网面（第二个 SSRF 入口）。
  const walk = (dir, out = []) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p, out);
      else if (/\.(cjs|mjs|ts|tsx)$/.test(f.name)) out.push(p);
    }
    return out;
  };
  const targets = [
    ...walk(path.join(ROOT, 'server')),
    ...(fs.existsSync(path.join(ROOT, 'src')) ? walk(path.join(ROOT, 'src')) : []),
  ];
  for (const f of targets) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!t.includes('research-github'),
      `服务端/前端不得引用借鉴工具：${path.relative(ROOT, f)}`);
  }
});