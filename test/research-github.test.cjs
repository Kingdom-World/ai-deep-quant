'use strict';
// ─────────────────────────────────────────────────────────────
// GitHub 借鉴工具的**红线判据**测试
//
// 🔴 为什么测这个而不是测"能跑通"：
//   这工具的价值不在"能搜到东西"（那是 GitHub API 的事），
//   而在**它拦下的是不是该拦的**。判据写错了会出现两种失败：
//     ① 漏拦 —— 把该警告的项目当干净方案照抄 ⇒ 直接引入退步；
//     ② 误拦 —— 把无害项目也标红 ⇒ 噪声（比没门更糟，会被习惯性忽略）。
//   ⇒ 两种失败都要测，且用**本轮真实遇到的项目形态**做样本。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'research-github.cjs');
const { RED_LINES } = require(TOOL);

const src = fs.readFileSync(TOOL, 'utf8');

/** 按某个 id 取判据函数 */
function rule(id) {
  const r = RED_LINES.find((x) => x.id === id);
  assert.ok(r, `未找到红线规则 ${id}`);
  return r;
}
/** 构造一个候选仓库对象 */
function repo(tech, name = 'x/y') {
  return { name, tech };
}

test('红线规则表完整（每条都有 id/rule/why/check）', () => {
  assert.ok(RED_LINES.length >= 3, '至少要有三条红线');
  for (const r of RED_LINES) {
    assert.ok(r.id && r.rule && r.why && typeof r.check === 'function', `规则 ${r.id} 缺字段`);
    assert.ok(r.why.length >= 20, `规则 ${r.id} 的 why 太短 —— 后人会看不懂而删掉它`);
  }
});

// ── ① 禁止让 LLM 做确定性计算 ──
test('红线①：检出「让 LLM 做计算/分析决策」的项目形态', () => {
  const check = rule('no-llm-math').check;
  assert.ok(check(repo(['Python', 'agent-compute', 'LLM 自主计算估值'])),
    '应拦住「agent 自算」形态');
  assert.ok(check(repo(['TypeScript', 'llm-calculation'])), '应拦住 llm-calculation 形态');
});

test('红线①：普通 RAG 项目不该被误拦', () => {
  const check = rule('no-llm-math').check;
  assert.ok(!check(repo(['Python', 'rag', 'bm25', 'faiss'])),
    '普通检索项目不该命中这条');
  assert.ok(!check(repo(['Python', 'agent', 'tool-calling'])),
    'agent/tool-calling 本身不等于「让 LLM 算数」');
});

// ── ② 不要用向量检索替换规则检索链 ──
test('红线②：检出「纯向量库、无关键词检索」的项目形态', () => {
  const check = rule('no-vector-over-rule').check;
  assert.ok(check(repo(['Python', 'faiss'])), '纯 FAISS 应被拦');
  assert.ok(check(repo(['Python', 'chroma', 'pgvector'])), '纯向量库应被拦');
  assert.ok(check(repo(['Python', 'Qdrant'])), 'Qdrant 应被拦');
});

test('红线②：混合检索（向量+关键词）不该被拦 —— 那是好做法', () => {
  const check = rule('no-vector-over-rule').check;
  assert.ok(!check(repo(['Python', 'faiss', 'bm25', 'hybrid retrieval'])),
    'hybrid/BM25 出现即视为混合检索，不该拦');
  assert.ok(!check(repo(['Python', 'keyword search'])), '纯关键词检索不该被拦');
});

// ── ③ 不用 LLM 评 LLM ──
test('红线③：检出 LLM-as-Judge 形态', () => {
  const check = rule('no-llm-as-judge').check;
  assert.ok(check(repo(['Python', 'deepeval', 'ragas'])), 'DeepEval 应被拦');
  assert.ok(check(repo(['Python', 'LLM-as-Judge'])), 'LLM-as-Judge 应被拦');
});

test('红线③：规则化 eval 形态不该被拦', () => {
  const check = rule('no-llm-as-judge').check;
  assert.ok(!check(repo(['Python', 'pytest', 'golden dataset', 'exact match'])),
    '黄金集 + 精确匹配是本项目自己的做法，绝不能被拦');
});

// ── 定位纪律（写死它，避免有人悄悄改成默认行为）──
test('🔴 工具不得进入 Agent 工具链 / 服务端 require', () => {
  // 理由：接进 Agent = 给 LLM 开一个出网面（第二个 SSRF 入口），
  //   与「确定性计算全在规则层 / 出网面最小化」冲突。
  assert.ok(!/server\//.test(path.relative(ROOT, TOOL)), '工具必须放在 tools/ 下');
  const serverFiles = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(cjs|mjs|ts|tsx)$/.test(f.name)) serverFiles.push(p);
    }
  };
  walk(path.join(ROOT, 'server'));
  const src2 = path.join(ROOT, 'src');
  const walk2 = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk2(p);
      else if (/\.(cjs|mjs|ts|tsx)$/.test(f.name)) serverFiles.push(p);
    }
  };
  if (fs.existsSync(src2)) walk2(src2);
  for (const f of serverFiles) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!t.includes('research-github'), `服务端/前端不得引用该工具：${path.relative(ROOT, f)}`);
  }
});

test('🔴 工具必须走 api.github.com（github.com 常被 SNI 阻断）', () => {
  assert.match(src, /https:\/\/api\.github\.com/, '必须硬编码 API 基址');
  assert.ok(!/github\.com\/[^']*\/search/.test(src.replace(/api\.github\.com/g, '')),
    '不得直接抓 github.com 网页端');
});

test('工具须导出可测函数且不在被 require 时执行主流程', () => {
  assert.match(src, /require\.main === module/,
    '必须靠 require.main 守卫，否则被 require 时会跑主流程');
  assert.match(src, /module\.exports = \{/, '必须导出 searchRepos 等供测试');
});