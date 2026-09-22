// ─────────────────────────────────────────────────────────────
// 腾讯批量行情字段映射锁（2026-09-22）
//
//   为什么要这组测试：腾讯返回 **88 个 `~` 分隔字段**，而我们的解析靠 0-based 下标。
//   下标错一位不会报错、也不会让接口失败 —— 它会产出
//   「看起来完全正常、其实完全错误」的数字（比如把"成交额"读成"市盈率"）。
//   本项目最忌讳这种错（数值可信是根基），所以必须用**不变量 + 精确值**双重锁住。
//
//   ⚠️ 本测试**不联网**：用一段真实录制的响应做夹具（fixture），
//   调纯函数 `parseTencent`。这样 CI 稳定，且改下标会立刻红灯。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');

const { parseTencent } = require('../server/screener.cjs');

// 真实录制样本（2026-09-21 收盘后取自 https://qt.gtimg.cn/q=sh600519）
const FIXTURE =
  'v_sh600519="1~贵州茅台~600519~1252.57~1257.12~1259.00~25017~11200~13817~1252.57~1~1252.56~15~1252.55~110~1252.50~24~1252.45~1~1252.86~57~1252.97~1~1253.00~3~1253.12~1~1253.13~5~~20260921161437~-4.55~-0.36~1259.95~1250.80~1252.57/25017/3135910045~25017~313591~0.20~19.23~~1259.95~1250.80~0.73~15658.15~15658.15~6.23~1382.83~1131.41~1.26~84~1253.52~17.59~19.02~~~0.07~313591.0045~62.6285~5~   A~GP-A~-7.16~-1.99~4.15~32.41~27.30~1539.98~1151.01~-4.82~-3.99~4.82~1250081601~1250081601~38.53~-8.76~1250081601~~~-11.54~-0.06~~CNY~0~___D__F__N~1252.43~4~";';

const IND = new Map([['sh600519', '白酒Ⅱ']]);

function parseOne() {
  const rows = parseTencent(FIXTURE, IND);
  assert.strictEqual(rows.length, 1, '夹具应解析出 1 行');
  return rows[0];
}

test('代码：取纯 6 位数字（与东财口径一致，下游 limitPctOf 与前端导航都依赖它）', () => {
  const r = parseOne();
  assert.strictEqual(r.code, '600519');
  assert.doesNotMatch(r.code, /^[a-z]{2}/, '不得带 sh/sz 前缀');
});

test('名称与价格：取值正确', () => {
  const r = parseOne();
  assert.strictEqual(r.name, '贵州茅台');
  assert.strictEqual(r.price, 1252.57);
  assert.strictEqual(r.open, 1259.0);
});

test('🔴 不变量：现价必须落在 [最低, 最高] 之间（下标错位会立刻破）', () => {
  const r = parseOne();
  assert.ok(r.low <= r.price && r.price <= r.high, `low=${r.low} price=${r.price} high=${r.high}`);
  assert.strictEqual(r.low, 1250.8);
  assert.strictEqual(r.high, 1259.95);
});

test('🔴 不变量：涨跌% 必须与 价格/昨收 自洽（容差 0.02）', () => {
  const r = parseOne();
  const calc = (r.price / 1257.12 - 1) * 100;
  assert.ok(Math.abs(calc - r.pct) < 0.02, `字段=${r.pct} 算得=${calc.toFixed(3)}`);
  assert.strictEqual(r.pct, -0.36);
});

test('单位换算：成交额 万元→元、市值 亿元→元（与东财 f6/f20 同口径）', () => {
  const r = parseOne();
  assert.strictEqual(r.amount, 313591 * 1e4, '成交额应为 313591 万元 = 31.36 亿元');
  assert.strictEqual(r.mktCap, 15658.15 * 1e8, '总市值应为 15658.15 亿元');
  assert.ok(r.amount > 1e8, '量级必须是"元"，否则选股里的 amount>=1亿 阈值会全废');
  assert.ok(r.mktCap > 1e10, '量级必须是"元"，否则 bigCapMove 的 300亿 阈值会全废');
});

test('换手率与量比：取值正确（选股多个策略依赖量比）', () => {
  const r = parseOne();
  assert.strictEqual(r.turnover, 0.2);
  assert.strictEqual(r.volRatio, 1.26);
});

test('行业：来自外部注入的清单映射（腾讯不提供行业）', () => {
  const r = parseOne();
  assert.strictEqual(r.industry, '白酒Ⅱ');
  const noMap = parseTencent(FIXTURE)[0];
  assert.strictEqual(noMap.industry, '—', '没有映射时应回落为占位符，而不是 undefined');
});

test('健壮性：停牌/无效行被跳过，不产出畸形数据', () => {
  // 现价为 0 的停牌股
  assert.deepStrictEqual(parseTencent('v_sz000001="51~平安银行~000001~0.00~11.70~0~0~0~0~0~";'), []);
  // 非行情行（garbage）不应抛错
  assert.deepStrictEqual(parseTencent('随便写点什么;'), []);
  assert.deepStrictEqual(parseTencent(''), []);
  assert.deepStrictEqual(parseTencent(null), []);
});

test('多行：一次批量查询的多只股票都能解析', () => {
  const two = FIXTURE + 'v_sz000001="51~平安银行~000001~11.73~11.70~11.70~0~0~0~11.73~1~~20260921150000~0.03~0.26~11.73~11.60~~~~~0~0~0~~~~2276.29~2276.31~";';
  const rows = parseTencent(two, IND);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].code, '600519');
  assert.strictEqual(rows[1].code, '000001');
});
