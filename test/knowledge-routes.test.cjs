// ─────────────────────────────────────────────────────────────
// 知识库路由 · 草稿视图闸门（2026-10-07 新增）
//
//   锁的是一个**越权口子**：/api/knowledge/entries?includeDraft=1 能读出
//   未过审的草稿全文。原实现里 byIds 走全量 load()，等于知道 id 就能读草稿，
//   审核流程形同虚设（草稿的存在本身意味着"还没审完"）。
//
//   两条防线都要在：
//     ① byIds 默认过滤草稿（防"忘了传参"）
//     ② 路由把 includeDraft 绑到 isAdmin（防"故意传参"）
//   本文件锁 ②，并顺带锁住 ① 在路由这一层的实际效果。
//
//   不启 HTTP 服务：用假 app 捕获 (method,path,handler)，再以假 req/res 调用。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 临时知识库：1 条已发布 + 1 条草稿（真实库 draft=0，测不出闸门）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-routes-test-'));
fs.writeFileSync(
  path.join(TMP, 'x.json'),
  JSON.stringify({
    category: 'principle',
    categoryLabel: '原理',
    description: 't',
    entries: [
      { id: 'has-src', title: '有出处', body: 'ok', source: 'Someone (2020). A Book. Publisher.', tags: [] },
      { id: 'no-src', title: '无出处', body: '草稿正文', source: '', tags: [] },
    ],
  }),
);
process.env.KNOWLEDGE_DIR = TMP;

const { registerKnowledgeScreenerRoutes } = require('../server/routes/knowledge-screener.cjs');
const knowledgeBase = require('../server/knowledge.cjs');

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
    delete: (p, h) => routes.set(`DELETE ${p}`, h),
  };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const appFor = (isAdmin) => {
  const app = fakeApp();
  registerKnowledgeScreenerRoutes(app, {
    knowledgeBase,
    screener: { STRATEGIES: {} },
    watchlist: { list: () => [], add: () => ({}), remove: () => ({}) },
    broker: { uidOf: () => 'anon' },
    isAdmin,
  });
  return app;
};
const get = async (app, query) => {
  const h = app.routes.get('GET /api/knowledge/entries');
  assert.ok(h, '路由未注册：GET /api/knowledge/entries');
  const res = fakeRes();
  await h({ query, params: {} }, res);
  return res;
};

test('🔴 非管理员请求 includeDraft ⇒ 403，草稿不得外泄', async () => {
  const res = await get(appFor(() => false), { ids: 'no-src', includeDraft: '1' });
  assert.strictEqual(res.statusCode, 403, '必须 403，不能是 200 带草稿');
  assert.ok(!JSON.stringify(res.body).includes('草稿正文'), '🔴 403 响应里绝不能带草稿内容');
});

test('🔴 includeDraft 各种真值写法都要被拦住（不只挡 "1"）', async () => {
  for (const v of ['1', 'true', 'TRUE', 'yes']) {
    const res = await get(appFor(() => false), { ids: 'no-src', includeDraft: v });
    assert.strictEqual(res.statusCode, 403, `includeDraft=${v} 应被拦`);
  }
  // 假值写法视为未开启草稿视图 ⇒ 走默认过滤，不报错
  for (const v of ['0', 'false', '', 'no']) {
    const res = await get(appFor(() => false), { ids: 'no-src', includeDraft: v });
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.items, [], `includeDraft=${v} 不应开启草稿视图`);
  }
});

test('管理员可读草稿（审核视图是真实需求，不是空门）', async () => {
  const res = await get(appFor(() => true), { ids: 'no-src,has-src', includeDraft: '1' });
  assert.strictEqual(res.body.ok, true);
  assert.deepStrictEqual(res.body.items.map((e) => e.id).sort(), ['has-src', 'no-src']);
});

test('未传 includeDraft ⇒ 只返回已发布（默认路径就是安全的）', async () => {
  const res = await get(appFor(() => true), { ids: 'no-src,has-src' });
  assert.deepStrictEqual(res.body.items.map((e) => e.id), ['has-src'], '不传参时草稿不得出现');
});

test('未注入 isAdmin 时 fail closed（防"忘注入"变成静默越权）', async () => {
  const app = fakeApp();
  // 故意不传 isAdmin —— 模拟改代码时漏注入
  registerKnowledgeScreenerRoutes(app, {
    knowledgeBase,
    screener: { STRATEGIES: {} },
    watchlist: { list: () => [], add: () => ({}), remove: () => ({}) },
    broker: { uidOf: () => 'anon' },
  });
  const res = await get(app, { ids: 'no-src', includeDraft: '1' });
  assert.strictEqual(res.statusCode, 403, '🔴 漏注入 isAdmin 必须拒绝，而不是默认放行');
});

test('路由层拿到的形状与 knowledgeBase 一致（含 categoryLabel，前端直接渲染）', async () => {
  const res = await get(appFor(() => false), { ids: 'has-src' });
  const e = res.body.items[0];
  assert.ok(e, '应返回该条目');
  assert.strictEqual(typeof e.categoryLabel, 'string');
  assert.ok(e.categoryLabel.length > 0, 'categoryLabel 必须存在（前端 EntryCard 读它上色）');
});
