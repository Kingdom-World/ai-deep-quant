'use strict';
// ─────────────────────────────────────────────────────────────
// Agent 工具 read_report 测试（Phase 3 · 读历史团队报告）
//
// 🔴 本文件最有价值的部分是**三种 degraded 形态**的覆盖：
//   核对全部 18 份历史报告后发现该字段有三种形态（不是一种）：
//     ① 字段缺失（8 份，早于降级标注上线）—— 缺失 ≠ 未降级
//     ② {degraded,llm,rule,seats,total}（6 份）
//     ③ 同②再加 reason（4 份，如「云端大模型未配置」）
//   按单一形态写死会渲染出「0 个角色中 0 个兜底」这类**误导表述**，
//   或把"未知"说成"未见降级" —— 两者都会让模型误判结论可信度。
//
// 🔴 第二条关键约束：**不得返回 stages**（单份完整 trace 实测最大 24.8KB）。
//
// ⚠️ 用注入的假 deps，不读 data/agents/*（gitignore，CI 里不存在）。
// ─────────────────────────────────────────────────────────────

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createToolbox } = require(path.join(__dirname, '..', 'server', 'agent', 'toolbox.cjs'));

/** 构造一份报告的最小 trace（stages 故意塞大内容，用于验证被剔除） */
function makeTrace(extra = {}) {
  return {
    ok: true,
    symbol: 'sh600519', name: '贵州茅台', mode: 'full',
    ranAt: '2026-10-01T07:50:58.490Z',
    price: 1258.62,
    final: { decision: '观望', note: '多空天平显示空头证据更完整。', teamScore: 58 },
    disclaimer: '本报告由 AI 多角色协作系统自动生成，不构成投资建议。',
    uid: 'admin',
    // 故意放大：验证工具不会把它带进上下文
    stages: { collect: { text: 'X'.repeat(5000) }, debate: { text: 'Y'.repeat(5000) } },
    ...extra,
  };
}

const LIST_ROWS = [
  { id: 'r-002', symbol: 'sh600519', name: '贵州茅台', mode: 'full', decision: '观望', ranAt: '2026-10-01T07:50:58.490Z' },
  { id: 'r-001', symbol: 'usAAPL', name: 'Apple', mode: 'single', decision: '——', ranAt: '2026-09-20T03:10:00.000Z' },
];

function makeTb({ trace = makeTrace(), rows = LIST_ROWS, onGet = null } = {}) {
  return createToolbox({
    getReport: async (id) => {
      if (onGet) return onGet(id);
      return id === 'r-002' ? trace : null;
    },
    listReports: async (opts) => rows.slice(0, opts.limit || rows.length),
  });
}
const toolOf = (tb) => tb.tools.find((t) => t.name === 'read_report');

test('前置：工具在箱中，spec 契约完整（参数顺序即模型的位置传参签名）', () => {
  const spec = makeTb().spec.find((s) => s.name === 'read_report');
  assert.ok(spec, 'spec 必须含 read_report');
  assert.ok(spec.desc.length > 20, 'desc 要能让模型判断何时该用');
  assert.deepStrictEqual(spec.params.map((p) => p.name), ['id', 'symbol', 'limit']);
  assert.strictEqual(spec.params[0].required, false, 'id 可选（不带则列清单）');
});

test('模式 B：不带 id 时列出报告清单（含 id/symbol/结论/日期）', async () => {
  const r = await toolOf(makeTb()).run({ limit: 5 });
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /共 2 份历史报告/);
  assert.match(r.summary, /r-002/);
  assert.match(r.summary, /观望/);
  assert.match(r.summary, /2026-10-01/);
  assert.strictEqual(r.data[0].id, 'r-002');
  assert.match(r.summary, /带上它的 id/, '应引导下一步动作');
});

test('模式 A：带 id 时给结论层（decision/note/teamScore/价格）', async () => {
  const r = await toolOf(makeTb()).run({ id: 'r-002' });
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /团队结论：观望/);
  assert.match(r.summary, /团队评分 58\.00/);
  assert.match(r.summary, /多空天平显示/);
  assert.match(r.summary, /1258\.62/);
  assert.strictEqual(r.data.final.decision, '观望');
});

test('🔴 不得返回 stages（单份完整 trace 可达 24.8KB）', async () => {
  const r = await toolOf(makeTb()).run({ id: 'r-002' });
  assert.ok(!JSON.stringify(r.data).includes('stages'), 'data 中不得含 stages');
  assert.ok(!r.summary.includes('XXXXX'), 'summary 中不得带出 stages 正文');
  // 结论层必须在
  assert.ok(r.data.final, '结论层必须保留');
});

test('🔴 降级形态①：字段缺失 ⇒ 必须说"无法判断"，不得说成"未见降级"', async () => {
  const trace = makeTrace();
  delete trace.degraded; // 老报告：字段不存在
  const r = await toolOf(makeTb({ trace })).run({ id: 'r-002' });
  assert.match(r.summary, /未记录降级信息/, '应如实说明字段缺失');
  assert.match(r.summary, /无法判断/, '不得把"未知"说成"没问题"');
  assert.ok(!/未见降级/.test(r.summary), '字段缺失时不得断言"未见降级"');
});

test('🔴 降级形态②：常规计数 ⇒ 呈现 N/M 与降级座位', async () => {
  const trace = makeTrace({
    degraded: { degraded: true, llm: 9, rule: 4, total: 13, seats: ['Ra · 激进风险分析师', 'Aegis · 风险主管'] },
  });
  const r = await toolOf(makeTb({ trace })).run({ id: 'r-002' });
  assert.match(r.summary, /13 个角色中 4 个由规则引擎兜底/);
  assert.match(r.summary, /激进风险分析师/);
  assert.match(r.summary, /可靠性边界/, '必须提醒模型说明边界');
});

test('🔴 降级形态③：带 reason ⇒ 优先呈现原因（且不渲染成"0 个角色中 0 个"）', async () => {
  const trace = makeTrace({
    degraded: { degraded: true, llm: 0, rule: 0, total: 0, seats: [], reason: '云端大模型未配置：本次全部角色由本地规则引擎产出' },
  });
  const r = await toolOf(makeTb({ trace })).run({ id: 'r-002' });
  assert.match(r.summary, /原因：云端大模型未配置/, '必须呈现 reason');
  assert.ok(!/0 个角色中 0 个/.test(r.summary),
    '不得把 total=0 渲染成「0 个角色中 0 个兜底」——这是误导表述');
});

test('未降级（字段存在且 degraded=false）⇒ 明确说明全部由模型完成', async () => {
  const trace = makeTrace({ degraded: { degraded: false, llm: 13, rule: 0, total: 13, seats: [] } });
  const r = await toolOf(makeTb({ trace })).run({ id: 'r-002' });
  assert.match(r.summary, /均由模型完成/);
});

test('报告不存在 / 归属不符（deps 返回 null）⇒ fail 且给可用路径', async () => {
  const r = await toolOf(makeTb()).run({ id: 'not-exist' });
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /未找到报告/);
  assert.match(r.summary, /列出可用报告/, 'fail 消息必须给下一步');
});

test('deps 抛错（DB 故障等）⇒ 转为 fail，不让异常中断编排循环', async () => {
  const tb = makeTb({ onGet: async () => { throw new Error('DB 连接失败'); } });
  const r = await toolOf(tb).run({ id: 'r-002' });
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /读取报告失败/);
  assert.match(r.summary, /DB 连接失败/);
});

test('空列表 ⇒ fail 并引导先发起分析', async () => {
  const r = await toolOf(makeTb({ rows: [] })).run({});
  assert.strictEqual(r.ok, false);
  assert.match(r.summary, /还没有任何 Agent 团队报告/);
  assert.match(r.summary, /发起一次团队分析/);
});

test('deps 未接入 ⇒ fail（不抛异常）', async () => {
  const tb = createToolbox({});
  const a = await toolOf(tb).run({ id: 'x' });
  assert.strictEqual(a.ok, false);
  assert.match(a.summary, /未接入/);
  const b = await toolOf(tb).run({});
  assert.strictEqual(b.ok, false);
});

test('limit 上限 30；返回带 dataFingerprint', async () => {
  let seen = null;
  const tb = createToolbox({
    listReports: async (opts) => { seen = opts.limit; return LIST_ROWS; },
  });
  const r = await toolOf(tb).run({ limit: 999 });
  assert.strictEqual(seen, 30, 'limit 应被夹到 30');
  assert.ok(r.dataFingerprint, '应带指纹供编排层做幂等判定');
});

test('⚠️ async 契约：漏 await 会拿到 Promise（deps 必须 await 的回归锚点）', async () => {
  // 这不是测工具，而是固化"reportstore 全函数 async"这一契约：
  //   若将来有人把 deps 改成同步返回，本测试仍会过；
  //   但若工具内部漏了 await，data 会变成 Promise 对象 ⇒ 下面的断言会失败。
  const r = await toolOf(makeTb()).run({ id: 'r-002' });
  assert.ok(!(r.data instanceof Promise), 'data 不得是未 await 的 Promise');
  assert.strictEqual(typeof r.data.final, 'object');
});
