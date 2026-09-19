// ─────────────────────────────────────────────────────────────
// 知识库 Agent 工具测试（M1-1.5）
//   锁死三件事：
//   ① 工具在 toolbox 的 spec 中可见、可被协议层解析并调用
//   ② 命中时 summary 必须**带条目 id**——引用可核查是这一环的全部意义；
//      未命中必须返回 ok:false 且可回灌（模型能自我纠正，不是抛异常）
//   ③ Alpha 的启用清单与 TOOL_RULES 必须与工具箱同步（防止"工具加了但没开"）
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.KNOWLEDGE_DIR = path.join(__dirname, '..', 'server', 'knowledge');
const { createToolbox } = require('../server/agent/toolbox.cjs');
const { parseToolCall } = require('../server/agent/protocol.cjs');
const { extractAnswerFromText } = require('../server/agent/orchestrator.cjs');
const { ENABLED_TOOLS, TOOL_RULES } = require('../server/agent/alpha.cjs');

const tb = createToolbox({});

test('工具箱暴露 knowledge_search，且参数契约为 query + category', () => {
  const t = tb.spec.find((x) => x.name === 'knowledge_search');
  assert.ok(t, '工具箱必须包含 knowledge_search');
  assert.equal(t.params[0].name, 'query');
  assert.equal(t.params[0].required, true);
  assert.equal(t.params[1].name, 'category');
  assert.equal(t.params[1].required, false);
});

test('协议层能解析函数调用式 knowledge_search("PIT")', () => {
  const r = parseToolCall('knowledge_search("PIT")', tb.spec);
  assert.ok(r, '解析失败');
  assert.equal(r.action, 'knowledge_search');
  assert.equal(r.args.query, 'PIT');
});

test('命中：summary 必须包含条目 id（引用可核查）', async () => {
  const r = await tb.call('knowledge_search', { query: 'PIT' });
  assert.equal(r.ok, true);
  assert.ok(r.data.length > 0, '应命中条目');
  assert.ok(/term-pit|basis-financial-pubdate/.test(r.summary), 'summary 必须带条目 id，否则模型无法引用');
  assert.ok(r.summary.includes('出处'), 'summary 应提示出处存在');
});

test('命中：data 保留完整字段（含 source，供报告层使用）', async () => {
  const r = await tb.call('knowledge_search', { query: 'Newey-West' });
  assert.equal(r.ok, true);
  const e = r.data.find((x) => x.id === 'term-newey-west');
  assert.ok(e, '应命中 term-newey-west');
  assert.ok(e.source && e.source.length > 10, '出处必须完整带出');
  assert.ok(e.body.includes('Bartlett'), '正文应原样带出，不被截断');
});

test('分类过滤参数生效', async () => {
  const r = await tb.call('knowledge_search', { query: '复权', category: 'basis' });
  assert.equal(r.ok, true);
  assert.ok(r.data.every((x) => x.category === 'basis'), '过滤后应只剩 basis 类');
});

test('非法分类被忽略（不报错，降级为全库检索）', async () => {
  const r = await tb.call('knowledge_search', { query: '复权', category: '随便写的' });
  assert.equal(r.ok, true);
  assert.ok(r.data.length > 0);
});

test('未命中：返回 ok:false 且可回灌（不抛异常）', async () => {
  const r = await tb.call('knowledge_search', { query: 'qqqzzz' });
  assert.equal(r.ok, false);
  assert.ok(r.summary.includes('没有与'), '失败说明应含改进提示');
  assert.equal(r.data, null);
});

test('空 query 且无 category：明确失败，不返回全库', async () => {
  const r = await tb.call('knowledge_search', { query: '   ' });
  assert.equal(r.ok, false);
  assert.ok(r.summary.includes('至少需要一个'), '失败说明应给出可用参数提示');
});

test('只给 category：按分类浏览（M1 实测补强——Agent 常问「方法论都有哪些」）', async () => {
  const r = await tb.call('knowledge_search', { category: 'method' });
  assert.equal(r.ok, true, '只给 category 应能浏览，不应被 query 必填挡住');
  assert.ok(r.data.length > 0);
  assert.ok(r.data.every((x) => x.category === 'method'), '应只剩 method 类');
  assert.ok(r.summary.includes('分类 method'), 'summary 应说明检索范围');
});

test('只给非法 category：明确失败（不静默返回全库）', async () => {
  const r = await tb.call('knowledge_search', { category: '随便写的' });
  assert.equal(r.ok, false);
  assert.ok(r.summary.includes('至少需要一个'));
});

test('每条工具返回都带指纹（A2 可追溯）', async () => {
  const r = await tb.call('knowledge_search', { query: 'PIT' });
  assert.ok(r.dataFingerprint, '必须有指纹');
  assert.equal(r.dataFingerprint.params.query, 'PIT');
});

test('未知工具调用返回可回灌失败而非异常', async () => {
  const r = await tb.call('knowledge_search_v2', { query: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.summary.includes('未知工具'));
});

// ── 与 Alpha 的接线一致性（防"工具加了但没启用"）──

test('【接线一致性】knowledge_search 必须在 Alpha 的 ENABLED_TOOLS 中', () => {
  assert.ok(ENABLED_TOOLS.includes('knowledge_search'), 'ENABLED_TOOLS 未包含 knowledge_search');
});

test('【接线一致性】ENABLED_TOOLS 中的每个工具都真实存在于工具箱', () => {
  const names = new Set(tb.spec.map((t) => t.name));
  for (const n of ENABLED_TOOLS) assert.ok(names.has(n), `ENABLED_TOOLS 声明了不存在的工具 ${n}`);
});

test('【接线一致性】TOOL_RULES 必须提及 knowledge_search（否则模型不知道可用）', () => {
  assert.ok(TOOL_RULES.includes('knowledge_search'), 'TOOL_RULES 未告知模型该工具');
  assert.ok(TOOL_RULES.includes('条目 id'), 'TOOL_RULES 应要求引用条目 id');
});

// ── 中文别名容错（M1 实测：模型输出「知识_search("PIT")」被判 parseFail）──

test('【实测缺陷回归】中文别名「知识_search」应归一为 knowledge_search 并保留参数', () => {
  const r = parseToolCall('知识_search("PIT")', tb.spec);
  assert.ok(r, '别名调用不应解析失败');
  assert.equal(r.action, 'knowledge_search');
  assert.equal(r.args.query, 'PIT', '参数必须保留');
  assert.deepEqual(r.errors, []);
});

test('中文别名：JSON 形态同样归一', () => {
  const r = parseToolCall('{"action":"知识库检索","args":{"query":"复权"}}', tb.spec);
  assert.ok(r);
  assert.equal(r.action, 'knowledge_search');
  assert.equal(r.args.query, '复权');
});

test('别名表只收录意图唯一的词（不做模糊匹配，避免误绑定）', () => {
  // 未登记的近义词不应被绑定
  const r = parseToolCall('知识问答("x")', tb.spec);
  assert.equal(r, null, '未登记的词不应被解析成工具调用');
});

test('别名不影响规范名解析', () => {
  const r = parseToolCall('knowledge_search("PIT")', tb.spec);
  assert.equal(r.action, 'knowledge_search');
  assert.equal(r.args.query, 'PIT');
});

// ── 不守协议输出的结论提取（M1 实测：模型输出 {"结论": "..."} 而非 final(...)）──

test('【实测缺陷回归】{"结论": "..."} 应提取出结论正文，而非把 JSON 丢给用户', () => {
  const r = extractAnswerFromText('{"结论": "PIT 是时点数据……"}');
  assert.equal(r, 'PIT 是时点数据……');
});

test('结论提取：兼容 answer / result / final 三个键', () => {
  assert.equal(extractAnswerFromText('{"answer": "A"}'), 'A');
  assert.equal(extractAnswerFromText('{"result": "B"}'), 'B');
  assert.equal(extractAnswerFromText('{"final": "C"}'), 'C');
});

test('结论提取：可解出 markdown 围栏内的 JSON', () => {
  assert.equal(extractAnswerFromText('```json\n{"结论": "围栏内"}\n```'), '围栏内');
});

test('结论提取：非 JSON 文本原样返回（不裁剪、不猜测）', () => {
  assert.equal(extractAnswerFromText('直接写的结论'), '直接写的结论');
});

test('结论提取：JSON 里没有已知结论键时原样返回（避免猜错字段）', () => {
  const raw = '{"foo": "bar"}';
  assert.equal(extractAnswerFromText(raw), raw);
});

test('结论提取：结论键非字符串时原样返回', () => {
  const raw = '{"结论": {"nested": 1}}';
  assert.equal(extractAnswerFromText(raw), raw);
});

test('结论提取：空输入不抛错', () => {
  assert.equal(extractAnswerFromText(''), '');
  assert.equal(extractAnswerFromText(null), '');
});
