// AI 助手推理引擎 v3 测试：意图矩阵 / skillExplain 口径 / skillMood 显式降级
// （2026-09-26 子代理评审要求补齐；只测 reasoning 层，qa 路由顺序用 CDP 线上验证）
const { test } = require('node:test');
const assert = require('node:assert');
const reasoning = require('../server/ai/reasoning.cjs');

const tools = (overrides = {}) => ({
  indices: async () => [
    { name: '上证指数', price: 3000, chg: 0.5 },
    { name: '深证成指', price: 9800, chg: -0.3 },
    { name: '沪深300', price: 3900, chg: 0.2 },
  ],
  sectorFlow: async () => ({ inflow: ['电子 +10 亿'], outflow: ['地产 -5 亿'] }),
  extractSymbol: async () => null,
  knowledgeSearch: async () => ({ mode: 'browse', total: 48, items: [] }),
  marketMood: async () => ({ ok: true, total: 4593, up: 3000, down: 1500, flat: 93, limitUp: 60, limitDown: 5, score: 62 }),
  ...overrides,
});

test('detectIntent 意图矩阵（优先级：sector > mood > stock > explain > market）', () => {
  assert.equal(reasoning.detectIntent('行业板块资金流向怎么样'), 'sector');
  assert.equal(reasoning.detectIntent('市场情绪怎么样'), 'mood');
  assert.equal(reasoning.detectIntent('今天的赚钱效应如何'), 'mood');
  assert.equal(reasoning.detectIntent('分析一下什么是600519的市盈率'), 'stock'); // 代码是最强信号
  assert.equal(reasoning.detectIntent('分析 AAPL'), 'stock');
  assert.equal(reasoning.detectIntent('解释一下夏普比率'), 'explain');
  assert.equal(reasoning.detectIntent('什么是前复权'), 'explain');
  assert.equal(reasoning.detectIntent('大盘今天怎么样'), 'market');
});

test('detectIntent：英文 ticker 收紧（词边界 + 动词语境）', () => {
  // 无动词语境的英文句不再误入 stock
  assert.notEqual(reasoning.detectIntent('what is p/e ratio'), 'stock');
});

test('skillExplain：标题命中（score≥10）作答并强制带出处', async () => {
  const t = tools({
    knowledgeSearch: async () => ({
      mode: 'or', total: 48,
      items: [{ title: '夏普比率', body: '夏普比率 = (组合收益 - 无风险利率) / 组合波动率，衡量单位风险溢价。', source: 'Bodie Kane Marcus《Investments》Ch.5', tags: ['夏普'], score: 13, matched: ['夏普'] }],
    }),
  });
  const r = await reasoning.route('什么是夏普比率', t);
  assert.equal(r.type, 'knowledge-explain');
  assert.ok(r.answer.includes('夏普比率 = '));
  assert.ok(r.answer.includes('出处：Bodie'), '必须带出处');
});

test('skillExplain：score<10 只提示相关条目，不冒充答案；browse 模式拒绝', async () => {
  // 低分：仅正文/出处偶然命中 → 提示相关条目
  const low = await reasoning.route('什么是夏普比率', tools({
    knowledgeSearch: async () => ({
      mode: 'or', total: 48,
      items: [{ title: '其他条目', body: '……夏普……', source: 'x', tags: [], score: 3, matched: ['夏普'] }],
    }),
  }));
  assert.ok(low.answer.includes('没有找到标题完全匹配'));
  assert.ok(!low.answer.includes('📖'));
  // browse（空查询/停用词吃光）→ null 落兜底，绝不输出全量条目
  const browse = await reasoning.route('什么是？？？', tools());
  assert.equal(browse, null);
});

test('skillMood：正常输出温度计解读', async () => {
  const r = await reasoning.route('市场情绪怎么样', tools());
  assert.equal(r.type, 'market-mood');
  assert.ok(r.answer.includes('上涨 3000 家'));
  assert.ok(r.answer.includes('市场温度：62°'));
});

test('skillMood：工具抛错 → route 返回 skill-error + degraded（显式降级，不静默）', async () => {
  const r = await reasoning.route('市场情绪怎么样', tools({
    marketMood: async () => { throw new Error('snapshot unavailable'); },
  }));
  assert.equal(r.type, 'skill-error');
  assert.equal(r.answer, null);
  assert.ok(r.degraded && r.degraded.includes('兜底'));
});

test('skillMood：数据字段不齐 → null 落兜底，不硬编', async () => {
  const r = await reasoning.route('市场情绪怎么样', tools({ marketMood: async () => ({}) }));
  assert.equal(r, null);
});
