// ─────────────────────────────────────────────────────────────
// P1 工具层测试：协议解析 + 工具箱契约
//
//   重点：
//   · 主格式必须支持**函数调用式**（R1 实测：模型 100% 输出这种，JSON 只有 0~5%）
//   · 含一条 **R1 回归锚点** —— 用实测中模型的真实输出作为用例，
//     若将来有人把主格式改回"必须纯 JSON"，这条会立刻失败
//   · 工具箱失败必须**可回灌**（返回 ok:false 而非抛异常），否则模型无法自我纠正
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { parseToolCall, renderToolSpec, bindArgs } = require('../server/agent/protocol.cjs');
const { createToolbox } = require('../server/agent/toolbox.cjs');

const TOOLS = [
  {
    name: 'get_klines',
    desc: '日K线',
    params: [
      { name: 'symbol', type: 'string', required: true },
      { name: 'count', type: 'number', required: false, default: 500 },
    ],
  },
  {
    name: 'run_backtest',
    desc: '回测',
    params: [
      { name: 'symbol', type: 'string', required: true },
      { name: 'strategy', type: 'string', required: false, default: 'ma' },
      { name: 'fast', type: 'number', required: false, default: 5 },
    ],
  },
];

const mkKlines = (len) =>
  Array.from({ length: len }, (_, i) => {
    const c = 10 + Math.sin(i / 9) * 2 + i * 0.01;
    return { date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c };
  });

// ── 协议解析 ──

test('【R1 回归锚点】实测中模型的真实输出必须能解析', () => {
  // 这是 R1 实测两轮 28 次里模型几乎完全一致的输出形态
  const r = parseToolCall('get_klines("sh600519", 500)', TOOLS);
  assert.ok(r, '若解析失败，说明协议层退化成"必须纯 JSON"——与实测结论相悖');
  assert.equal(r.action, 'get_klines');
  assert.equal(r.args.symbol, 'sh600519');
  assert.equal(r.args.count, 500, '字符串 "500" 应被强制为数字');
  assert.equal(r.format, 'funcCall');
  assert.deepEqual(r.errors, []);
});

test('函数调用式：单引号参数同样可解析', () => {
  const r = parseToolCall("get_klines('sh600519', 300)", TOOLS);
  assert.equal(r.args.symbol, 'sh600519');
  assert.equal(r.args.count, 300);
});

test('函数调用式：具名参数按名绑定，未给参数取默认值', () => {
  const r = parseToolCall('run_backtest(symbol="sh600519", fast=10)', TOOLS);
  assert.equal(r.args.symbol, 'sh600519');
  assert.equal(r.args.fast, 10);
  assert.equal(r.args.strategy, 'ma', '未提供应取契约默认值');
});

test('JSON 格式仍作为兼容分支可用（裸 JSON / 围栏 / 散文夹杂）', () => {
  const bare = parseToolCall('{"action":"get_klines","args":{"symbol":"sh600519","count":500}}', TOOLS);
  assert.equal(bare.format, 'json');
  assert.equal(bare.args.count, 500);

  const fenced = parseToolCall('```json\n{"action":"get_klines","args":{"symbol":"sh600519"}}\n```', TOOLS);
  assert.equal(fenced.action, 'get_klines');

  const noisy = parseToolCall('好的，我来取数据：{"action":"get_klines","args":{"symbol":"sh600519"}} 请稍候', TOOLS);
  assert.equal(noisy.action, 'get_klines');
  assert.equal(noisy.args.count, 500);
});

test('【防误判】JSON 输入不得被函数调用式抢先匹配', () => {
  // 踩过的坑：函数调用式正则若把括号写成可选，JSON 里的 "get_klines" 字符串会被抢先命中，
  // 结果 action 对了但 args 全丢（静默降级成默认值），比报错更危险。
  const r = parseToolCall('{"action":"get_klines","args":{"symbol":"sh600519","count":300}}', TOOLS);
  assert.equal(r.format, 'json', 'JSON 应走 json 分支');
  assert.equal(r.args.symbol, 'sh600519');
  assert.equal(r.args.count, 300, 'args 不得丢失');
});

test('位置参数超出工具签名时报错（不静默丢弃）', () => {
  const r = parseToolCall('get_klines("sh600519", 500, 999)', TOOLS);
  assert.ok(r.errors.some((e) => e.includes('超出工具签名')));
});

test('类型转换失败时报错', () => {
  const r = parseToolCall('get_klines("sh600519", abc)', TOOLS);
  assert.ok(r.errors.some((e) => e.includes('期望数字')));
});

test('缺少必填参数时报错', () => {
  const r = parseToolCall('run_backtest()', TOOLS);
  assert.ok(r.errors.some((e) => e.includes('缺少必填参数')));
});

test('未知参数被明确指出', () => {
  const r = parseToolCall('get_klines(symbol="x", bogus=1)', TOOLS);
  assert.ok(r.errors.some((e) => e.includes('未知参数')));
});

test('完全无法识别时返回 null（由上层决定如何追问）', () => {
  assert.equal(parseToolCall('你好，我不确定该做什么。', TOOLS), null);
  assert.equal(parseToolCall('', TOOLS), null);
});

test('renderToolSpec 输出含参数名与必填标记', () => {
  const s = renderToolSpec(TOOLS);
  assert.ok(s.includes('get_klines(symbol, count?)'));
  assert.ok(s.includes('run_backtest(symbol, strategy?, fast?)'));
});

// ── 工具箱 ──

test('工具箱契约完整：参数均声明 name 与 type（模型按位置传参，顺序即签名）', () => {
  const tb = createToolbox({});
  // 数量下限而非硬编码总数——新增工具不应让本测试失败（避免"改一次数量断一次"）
  assert.ok(tb.tools.length >= 6, `工具数 ${tb.tools.length} 少于基线 6`);
  for (const t of tb.tools) {
    assert.ok(t.name && t.desc, `${t.name} 缺少名称或描述`);
    assert.ok(Array.isArray(t.params) && t.params.length > 0, `${t.name} 无参数声明`);
    for (const p of t.params) assert.ok(p.name && p.type, `${t.name} 的参数缺 name/type`);
  }
  // spec 必须保持 params 顺序
  const spec = tb.spec;
  assert.equal(spec[0].params[0].name, 'symbol');
});

test('未知工具返回可回灌的失败，不抛异常', async () => {
  const tb = createToolbox({});
  const r = await tb.call('no_such_tool', {});
  assert.equal(r.ok, false);
  assert.ok(r.summary.includes('未知工具'));
});

test('依赖未接入时返回失败而非崩溃', async () => {
  const tb = createToolbox({}); // 未注入 fetchKlines
  const r = await tb.call('get_klines', { symbol: 'sh600519' });
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
});

test('run_backtest：进程内执行并返回 summary 与 data 双通道', async () => {
  const tb = createToolbox({ fetchKlines: async () => mkKlines(300), marketOf: () => 'CN' });
  const r = await tb.call('run_backtest', { symbol: 'sh600000', strategy: 'ma', fast: 5, slow: 20 });
  assert.equal(r.ok, true, r.summary);
  assert.ok(r.summary.includes('总收益'), 'summary 供模型阅读');
  assert.ok(r.data && Number.isFinite(r.data.totalReturn), 'data 供报告使用');
});

test('每个工具返回必须携带四要素指纹（A2）', async () => {
  const tb = createToolbox({ fetchKlines: async () => mkKlines(300), marketOf: () => 'CN' });
  const r = await tb.call('run_backtest', { symbol: 'sh600000', strategy: 'ma', fast: 5, slow: 20 });
  assert.ok(r.dataFingerprint, '缺少指纹');
  assert.ok(r.dataFingerprint.codeHash && Object.keys(r.dataFingerprint.codeHash).length > 0);
  assert.ok(r.dataFingerprint.params);
  assert.ok(r.dataFingerprint.data.rowsHash, '数据指纹应含序列哈希');
});
