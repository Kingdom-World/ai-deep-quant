// ─────────────────────────────────────────────────────────────
// P2 编排层测试 —— 覆盖红队（red-team-p2）点名的场景
//   mock chat（按脚本序列返回），验证循环控制 / 哨兵 / 降级 / 轨迹
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { runResearch, canonicalKey, truncateByLine } = require('../server/agent/orchestrator.cjs');
const { createToolbox } = require('../server/agent/toolbox.cjs');

const mkKlines = (len) =>
  Array.from({ length: len }, (_, i) => {
    const c = 10 + Math.sin(i / 9) * 2 + i * 0.01;
    return { date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c };
  });

const tb = createToolbox({ fetchKlines: async () => mkKlines(300), marketOf: () => 'CN' });

/** 按脚本序列返回的 mock chat（脚本元素为字符串 / {content,model} / null（模拟调用失败）） */
function mockChat(script) {
  let i = 0;
  return async () => {
    const item = script[Math.min(i, script.length - 1)];
    i += 1;
    if (item === null) return null; // 模拟云端不可用
    return typeof item === 'string'
      ? { content: item, model: 'mock-model' }
      : { content: item.content, model: item.model ?? 'mock-model' };
  };
}

test('直接 final：单轮结束，answer 正确', async () => {
  const r = await runResearch({
    question: '测试',
    toolbox: tb,
    chat: mockChat(['final("结论：一切正常。")']),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'final');
  assert.equal(r.answer, '结论：一切正常。');
  assert.equal(r.rounds, 1);
  assert.equal(r.degraded, false);
});

test('工具循环：get_klines → final，轨迹记录每步', async () => {
  const r = await runResearch({
    question: '测试',
    toolbox: tb,
    chat: mockChat(['get_klines("sh600519", 100)', 'final("基于K线得出结论。")']),
  });
  assert.equal(r.ok, true);
  assert.equal(r.rounds, 2);
  assert.ok(r.trace.some((t) => t.tool === 'get_klines' && t.ok), '工具调用应有轨迹');
  assert.ok(r.trace.some((t) => t.event === 'final'));
  assert.ok(r.traceFile && fs.existsSync(r.traceFile), '轨迹应增量落盘');
});

test('maxRounds 用尽：不硬编答案，如实返回未得出结论', async () => {
  const r = await runResearch({
    question: '测试',
    toolbox: tb,
    chat: mockChat(['get_klines("sh600519", 100)']), // 永远只调工具，不给 final
    maxRounds: 3,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'maxRounds');
  assert.equal(r.answer, null);
  assert.ok(r.draft !== null, '应有草稿供人工查看');
});

test('连续 2 次解析失败 → 转 finalize（F5），不再浪费轮次', async () => {
  const r = await runResearch({
    question: '测试',
    toolbox: tb,
    chat: mockChat(['你好，我不确定该做什么。', '我还是不确定。', 'final("最终结论")']),
    maxRounds: 6,
  });
  assert.equal(r.reason, 'finalize');
  assert.equal(r.degraded, true);
});

test('同参重复调用：幂等校验不误杀；trace 完整但 toolData 去重（F3 + 展示层）', async () => {
  const r = await runResearch({
    question: '测试',
    toolbox: tb,
    chat: mockChat([
      'get_klines("sh600519", 100)',
      'get_klines("sh600519", 100)', // 同参重复 → 幂等校验
      'final("完成")',
    ]),
  });
  assert.equal(r.reason, 'final', '指纹一致不应触发阻断');
  // trace 保留完整执行序列（审计真实性不受损）
  const dup = r.trace.filter((t) => t.tool === 'get_klines');
  assert.ok(dup.length >= 2, 'trace 应含同参的两次执行');
  // 展示层去重：同 (tool,args) 只保留最后一次结果并标注调用次数——
  // 用户实测反馈"同一卡片刷三遍很无厘头"，审计与展示必须分离
  assert.equal(r.toolData.length, 1, '同参工具卡片不得重复刷屏');
  assert.equal(r.toolData[0].calls, 2, '应标注真实调用次数');
});

test('参数错误不执行，回灌要求修正（F9）', async () => {
  let executed = 0;
  const spyTb = {
    spec: tb.spec,
    call: async (name, args) => {
      if (name === 'get_klines') executed += 1;
      return tb.call(name, args);
    },
  };
  const r = await runResearch({
    question: '测试',
    toolbox: spyTb,
    chat: mockChat(['get_klines()', 'get_klines("sh600519", 100)', 'final("ok")']),
  });
  assert.equal(executed, 1, '缺必填的调用不应执行');
  assert.equal(r.reason, 'final');
});

test('模型失败 → modelFail + degraded（F7 之一）', async () => {
  const r = await runResearch({
    question: '测试',
    toolbox: tb,
    chat: mockChat([null]),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'modelFail');
  assert.equal(r.degraded, true);
});

test('模型被回退 → degraded 置位并标注实际模型（F7）', async () => {
  const r = await runResearch({
    question: '测试',
    toolbox: tb,
    chat: mockChat([{ content: 'final("结论")', model: 'glm-4-flash-250414' }]),
    model: 'glm-4.7-flash', // 角色指定模型
  });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.equal(r.actualModel, 'glm-4-flash-250414');
});

test('上下文预算耗尽 → 不再执行新工具，转 finalize 引导（F10）', async () => {
  let executed = 0;
  const spyTb = {
    spec: tb.spec,
    call: async (name, args) => {
      if (name === 'get_klines') executed += 1;
      return tb.call(name, args);
    },
  };
  const r = await runResearch({
    question: '测试',
    toolbox: spyTb,
    chat: mockChat([
      'get_klines("sh600519", 100)',
      'get_klines("sh600519", 100)',
      'get_klines("sh600519", 100)', // 预算已耗尽 → 这一次不得执行
      'final("基于已有信息收尾")',
    ]),
    contextBudget: 120,
  });
  assert.ok(executed <= 2, `预算耗尽后仍执行了新工具（共 ${executed} 次）`);
  assert.equal(r.degraded, true);
});

test('墙钟超时 → timeout（F2）', async () => {
  // mock 每次调用延迟 5ms，墙钟只给 1ms → 第二轮必然触发
  let i = 0;
  const items = ['get_klines("sh600519", 100)', 'get_klines("sh600519", 100)', 'final("x")'];
  const slowChat = async () => {
    const content = items[Math.min(i, items.length - 1)];
    i += 1;
    await new Promise((res) => setTimeout(res, 5));
    return { content, model: 'mock-model' };
  };
  const r = await runResearch({
    question: '测试',
    toolbox: tb,
    chat: slowChat,
    maxRounds: 6,
    maxWallClockMs: 1,
  });
  assert.equal(r.reason, 'timeout');
  assert.equal(r.degraded, true);
});

test('canonicalKey 规范化：键序 / 数值字符串 / 大小写（F4）', () => {
  const a = canonicalKey('get_klines', { symbol: 'sh600519', count: 500 });
  const b = canonicalKey('get_klines', { count: '500', symbol: 'SH600519' });
  assert.equal(a, b, '键序不同、数值字符串化、大小写不同应归一');
});

test('truncateByLine 按行截断，不切半行（F6）', () => {
  const s = '第一行因子结论\n第二行因子结论\n第三行';
  const t = truncateByLine(s, 16);
  // 每个原始行要么完整保留、要么整体不出现——绝不允许出现被拦腰切断的残行
  const kept = t.split('\n').filter((x) => x && !x.includes('已省略'));
  assert.ok(kept.every((x) => s.includes(x)), `出现被切断的残行: ${JSON.stringify(kept)}`);
  assert.ok(t.includes('已省略'), '应注明剩余行数');
});

test('【P5 数值保真】toolData 应把工具原始数据原样带出', async () => {
  // P3 实测：模型 final 复述的数值（0%）与工具实际返回（约 -75%）不符——
  // 规则引擎算出的数字必须不经模型之手直达用户，本用例锁死这条通道。
  const r = await runResearch({
    question: '测试',
    toolbox: tb,
    chat: mockChat(['get_klines("sh600519", 100)', 'final("结论")']),
  });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.toolData) && r.toolData.length >= 1, '应有 toolData');
  const item = r.toolData[0];
  assert.equal(item.tool, 'get_klines');
  assert.ok(item.data && Number.isFinite(item.data.lastClose), 'data 应含原始数值');
  assert.ok(item.fingerprint?.rowsHash, '应含数据指纹');
});
