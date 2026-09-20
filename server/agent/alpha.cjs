// ─────────────────────────────────────────────────────────────
// P3 试点：Alpha（技术分析师）接入工具循环
//
//   范围（有意收窄）：本轮只接 Alpha 一个角色、只开 4 个工具，
//   目的是端到端验证「自然语言 → 查 K 线 → 回测 → 参数稳健性 → 结论」能跑通，
//   验证通过再铺给其余 12 角色（避免一次性全铺、出问题排查面太大）。
//
//   ⚠️ 协议冲突的显式处理：roles.cjs 的 BOUNDARIES 第 5 条要求"最终回复必须是严格 JSON"，
//   那是**无工具时代**的约定；接入函数调用式协议后两者直接冲突。
//   这里用 TOOL_RULES **显式覆盖**第 5 条（其余铁律继续有效），并在注释里留痕——
//   不做含糊的"两套都遵守"，那会让模型无所适从。
// ─────────────────────────────────────────────────────────────
const { createToolbox } = require('./toolbox.cjs');
const { runResearch } = require('./orchestrator.cjs');
const { ROLES, BOUNDARIES } = require('../agents/roles.cjs');

/** P3 试点启用的工具（其余工具未注入依赖，启用只会产生"未接入"失败） */
//   M1 追加 knowledge_search：知识库是平台口径的权威源，模型涉及定义/口径时必须先查。
const ENABLED_TOOLS = ['get_klines', 'run_backtest', 'run_param_scan', 'eval_factors', 'factor_ic', 'knowledge_search'];

const TOOL_RULES = [
  '【输出格式规则 · 本次会话以本节为准，铁律第 5 条在本会话临时失效】',
  '你已被授权调用工具：',
  '1. 需要数据时，只输出一行函数调用，例如：get_klines("sh600519", 500)',
  '2. 同一工具同一参数只调用一次；结果会以工具消息返回给你，直接使用，不要重复调用；',
  '3. 【典型流程与调用预算】整个会话总共只允许约 4-5 次工具调用，典型流程：',
  '   get_klines(标的, 500) → run_backtest(标的, "ma", 5, 20) → （可选）run_param_scan(标的, 5, 20, 20, 60) → final(结论)',
  '   涉及定义或口径（如"什么是 PIT""费率怎么算""复权什么意思"）时，先调 knowledge_search("关键词") 再作答；',
  '   被问"某个因子有没有用/有没有预测力"时，必须调 factor_ic("因子名或表达式") 取实测统计量，不得凭因子的名字或教科书认知作答；',
  '   factor_ic 的两条语义红线（违反即算编造）：①degraded=true 意为"不可检验"（如 IC 方差为 0 导致 t 无定义），**不可说成"无效/没有效果"**；②strategyAligned 为 null 意为"方向不可判"（如 mom60 - mom20 这类混合语义），**不可说成"方向相反"**；',
  '   超过 5 次工具调用属于浪费；拿到回测结果后就应准备收尾；',
  '4. 拿到足够数据后，【必须】调用 final 给出结论。写法与示例如下（函数式，不是 JSON 对象）：',
  '   final("sh600519 双均线 fast=5/slow=20 回测总收益 -28.8%，最大回撤 44.6%；参数扫描判定为平原/孤峰，理由……；综合结论……")',
  '5. 禁止用 {"结论": ...} 这类 JSON 对象代替 final(...)；',
  '6. 结论中的数字必须来自工具返回的数据，不得编造；引用知识库时须标注条目 id（如 term-pit），并保持出处口径不变；',
  '7. 铁律其余条款（严禁荐股、数据不足必须明说、只基于数据发言）继续严格有效。',
].join('\n');

/**
 * 创建 Alpha 研究执行器
 * @param deps { fetchKlines, marketOf, priceLimitPct } —— 由 index.cjs 注入在线抓取能力
 * @returns (question, chat) => runResearch(...)
 */
function createAlphaRunner(deps = {}) {
  const full = createToolbox({
    fetchKlines: deps.fetchKlines ?? null,
    fetchQuote: null, // P3 试点未接实时报价
    fetchNews: null, // P3 试点未接资讯
    marketOf: deps.marketOf,
    priceLimitPct: deps.priceLimitPct,
  });
  const toolbox = {
    spec: full.spec.filter((t) => ENABLED_TOOLS.includes(t.name)),
    call: full.call,
  };
  const role = ROLES.alpha;
  const roleCard = [
    BOUNDARIES,
    `【你的角色】${role.seat}\n${role.system}`,
    TOOL_RULES,
  ].join('\n\n');

  return async function runAlphaResearch(question, chat) {
    return runResearch({
      question,
      toolbox,
      chat,
      roleCard,
      model: role.model, // 用于 F7 回退检测
    });
  };
}

module.exports = { createAlphaRunner, TOOL_RULES, ENABLED_TOOLS };
