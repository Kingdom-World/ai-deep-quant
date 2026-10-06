// ─────────────────────────────────────────────────────────────
// 研究包（shared/research-bundle.cjs）测试
//
//   本模块是**纯函数**：吃已算好的结果、吐自包含的证据快照 + 人可读报告。
//   因此这里能锁的比"能不能跑"多得多：
//     · 缺项必须**显式声明**（missing[]），不能留空让人误以为"这项通过"
//     · 报告里的表格必须扛得住**竖线与换行**（模型名/假设是自由文本，`|` 会撕开表格）
//     · 包必须**不含净值序列**（那是数据不是结论，塞进去会让包膨胀几十倍）
//     · 模型必须**原样可导回**（包里的 model 字段要与输入深相等）
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');

const R = require('../shared/research-bundle.cjs');

const MODEL = () => ({
  schemaVersion: 1,
  name: '动量+反转组合',
  hypothesis: '中期动量与短期反转相关性低',
  factors: [
    { id: 'a', expr: 'mom60', weight: 1, direction: 1 },
    { id: 'b', expr: 'rev20', weight: 0.8, direction: -1 },
  ],
  backtest: { rebalance: 'monthly', groups: 5, fees: true },
  meta: { author: 'tester', tags: ['动量'] },
});

/** 一次成功的回测响应（形状对着 modelsApi.run 的 ok:true 分支） */
const RUN = () => ({
  ok: true,
  engineVersion: '1.2.3',
  plan: { factors: [{ id: 'a', expr: 'mom60', weight: 1, direction: 1 }], transforms: [], filters: [], combine: 'weighted_sum' },
  fingerprint: 'f'.repeat(64),
  result: {
    range: { start: '2015-02-03', end: '2026-09-11', bars: 2822 },
    universeSize: 209,
    benchmarkUniverse: 202,
    topN: 5,
    rebalanceEvery: 20,
    capital: 1_000_000,
    slippage: 0.001,
    rebalances: 142,
    fills: 500,
    totalReturn: 94.32,
    annualized: 6.1,
    maxDrawdownPct: 55.2,
    sharpe: 0.44,
    benchmarkReturn: 30.0,
    totalFees: 12_345.67,
    feeRatePct: 0.08,
    blockedLimitUp: 3,
    blockedLimitDown: 1,
    ic: { icMean: 0.031, icir: 0.21, icPositiveRate: 0.55, n: 141, p: 0.03 },
    priceBasis: { momentum: 'qfq(fore)', execution: 'qfq(fore)' },
    // 以下两个是"不该进包"的大数组（抽稀后各 500+ 点）
    equity: Array.from({ length: 600 }, (_, i) => ({ date: `d${i}`, value: i })),
    benchmark: Array.from({ length: 600 }, (_, i) => ({ date: `d${i}`, value: i })),
  },
});

const VALIDATION = () => ({
  ok: true,
  engineVersion: '1.2.3',
  generatedAt: '2026-10-05T12:00:00.000Z',
  fingerprint: 'f'.repeat(64),
  /** 数据内容版本（验证路由默认现算 ⇒ 真实报告里通常都有） */
  dataVersion: { digest: 'a'.repeat(64), source: 'computed', stocks: 209, rows: 489024, lastDate: '2026-09-11' },
  verdict: { pass: false, flags: ['折间总收益离散度 76.05 个百分点（> 40）——分期表现不稳定'] },
  sample: { range: { start: '2015-02-03', end: '2026-09-11', bars: 2822 }, bars: 2822, universeSize: 209 },
  power: { icPeriods: 141, rebalances: 142, sufficient: true, note: 'IC 共 141 期，达到最低门槛 12 期' },
  cost: { backtests: 13 },
  rules: { minIcPeriods: 12, causalityMaxCuts: 8 },
  limitations: ['核心股票池（非全市场）……'],
  checks: {
    walkForward: {
      ok: true,
      folds: [{ fold: 1, startDate: '2015-02-03', endDate: '2018-12-28', totalReturn: -85.56, excessReturn: -90.1, maxDrawdownPct: 88, sharpe: -0.5 }],
      skipped: [],
      overall: { totalReturn: 94.32, maxDrawdownPct: 55.2, sharpe: 0.44 },
      dispersion: { mean: 10, min: -85.56, max: -9.51, spread: 76.05 },
      verdict: 'unstable',
      flags: [],
    },
    plateau: {
      ok: true,
      param: 'topN',
      points: [{ value: 5, ratio: 1, ok: true, totalReturn: -78.63, deltaPct: 0 }],
      coverage: { requested: [0.7, 1.3], actual: [0.85, 1.3] },
      verdict: 'plateau',
      flags: [],
    },
    causality: {
      ok: true,
      fullUniverseSize: 209,
      cuts: [{ cut: '2024-10-30', dailyBars: 2366, compared: 2366, totalReturn: -78.63, universeSize: 209, universeShift: false, mismatch: null }],
      pool: { stableFrom: '2022-12-09', stocks: 209 },
      verdict: 'causal',
      flags: [],
    },
  },
});

test('纯函数：同输入同输出（导出时间固定时逐字节一致）', () => {
  const args = {
    model: MODEL(),
    modelHash: 'h'.repeat(64),
    runOpts: { topN: '5', capital: '1000000', slippage: '0.001' },
    run: RUN(),
    validation: VALIDATION(),
    experiments: [],
    limitations: ['L1'],
    exportedAt: '2026-10-05T12:00:00.000Z',
    origin: 'local',
  };
  const a = JSON.stringify(R.buildResearchBundle(args));
  const b = JSON.stringify(R.buildResearchBundle(args));
  assert.strictEqual(a, b, '纯函数不得有隐含状态（时间也由入参决定，便于比对）');
  // 报告同理
  const ba = R.buildResearchBundle(args);
  assert.strictEqual(R.renderResearchReport(ba), R.renderResearchReport(ba));
});

test('身份锚点：modelHash / fingerprint 原样带上（复现时靠它们核对）', () => {
  const b = R.buildResearchBundle({ model: MODEL(), modelHash: 'HASH', run: RUN(), validation: VALIDATION() });
  assert.strictEqual(b.identity.modelHash, 'HASH');
  assert.strictEqual(b.identity.fingerprint, RUN().fingerprint);
  assert.strictEqual(b.identity.validationFingerprint, VALIDATION().fingerprint);
  assert.strictEqual(b.identity.dataVersion, 'a'.repeat(64));
  assert.strictEqual(b.engineVersion, '1.2.3');
});

test('🔴 数据版本：随包固化（复现三件套的第三件）；缺了必须显式说明', () => {
  // ① 有数据版本：进 identity，报告头部印出，且不报"缺"
  const b = R.buildResearchBundle({ model: MODEL(), run: RUN(), validation: VALIDATION() });
  assert.strictEqual(b.identity.dataVersion, 'a'.repeat(64));
  assert.ok(
    !b.missing.some((s) => /数据版本摘要/.test(s)),
    `有数据版本就不该报缺：${JSON.stringify(b.missing)}`,
  );
  const md = R.renderResearchReport(b);
  assert.ok(md.includes('a'.repeat(64)), '报告头部必须印出数据版本（否则读者无法核对数据底稿）');
  assert.ok(
    /engineVersion \+ fingerprint \+ dataVersion/.test(md),
    '报告必须说明"完整复现凭据 = 引擎版本 + 指纹 + 数据版本"三者',
  );

  // ② 无数据版本（旧报告 / 缓存未命中 / 公网）⇒ missing 显式说明 + 报告标"未取得"
  const noDv = { ...VALIDATION() };
  delete noDv.dataVersion;
  const b2 = R.buildResearchBundle({ model: MODEL(), validation: noDv });
  assert.strictEqual(b2.identity.dataVersion, null);
  assert.ok(
    b2.missing.some((s) => /数据版本摘要/.test(s)),
    '缺数据版本必须显式声明——沉默会让读者误以为"结论与数据版本无关"',
  );
  const md2 = R.renderResearchReport(b2);
  assert.ok(md2.includes('（未取得）'), '报告要显示"未取得"，不能留空');
  assert.ok(
    /无法逐字节核对数据底稿/.test(md2),
    '缺数据版本时要点明后果：复现时无法核对数据底稿',
  );

  // ③ 回测响应里也能带（将来 runModel 若直出数据版本，研究包同样认得）
  const fromRun = R.buildResearchBundle({
    model: MODEL(),
    run: { ...RUN(), dataVersion: { digest: 'b'.repeat(64) } },
  });
  assert.strictEqual(fromRun.identity.dataVersion, 'b'.repeat(64));
});

test('🔴 缺项必须显式声明：未跑回测/未跑验证/无实验时 missing 逐条说明原因', () => {
  const b = R.buildResearchBundle({ model: MODEL() });
  assert.strictEqual(b.baseline.present, false);
  assert.strictEqual(b.validation.present, false);
  assert.strictEqual(b.experiments.present, false);
  assert.strictEqual(b.missing.length, 3, `应逐条列出缺什么，实际：${JSON.stringify(b.missing)}`);
  assert.ok(b.missing.some((s) => /基准回测/.test(s)));
  assert.ok(b.missing.some((s) => /验证结论/.test(s)));
  assert.ok(b.missing.some((s) => /实验记录/.test(s)));
  // 归因要写清"为什么没跑"——公网不提供执行，不能只说"未执行"
  assert.ok(b.missing.some((s) => /公网/.test(s)));

  // 验证失败时把失败原因也带出来（不静默当作"没跑"）
  const failed = R.buildResearchBundle({
    model: MODEL(),
    validation: { ok: false, error: { stage: 'engine', message: '本地归档不足' } },
  });
  assert.ok(
    failed.missing.some((s) => /本地归档不足/.test(s)),
    '验证未成功时必须把原因写进 missing',
  );
});

test('回测指标映射：超额 = 总收益 − 等权基准；缺任一则为 null', () => {
  const b = R.buildResearchBundle({ model: MODEL(), run: RUN() });
  const m = b.baseline.metrics;
  assert.strictEqual(m.excessReturn, +(94.32 - 30.0).toFixed(2));
  assert.strictEqual(m.icN, 141);
  assert.strictEqual(m.range.start, '2015-02-03');
  assert.strictEqual(m.blockedLimitUp, 3);

  const noBench = RUN();
  noBench.result.benchmarkReturn = null;
  const m2 = R.buildResearchBundle({ model: MODEL(), run: noBench }).baseline.metrics;
  assert.strictEqual(m2.excessReturn, null, '没有基准就不该编一个超额出来');
});

test('🔴 包内不得携带净值序列（那是数据不是结论，会撑大几十倍）', () => {
  const b = R.buildResearchBundle({ model: MODEL(), run: RUN(), validation: VALIDATION() });
  const m = b.baseline.metrics;
  assert.ok(!('equity' in m) && !('benchmark' in m), '指标层不得混入曲线数组');
  const json = JSON.stringify(b);
  assert.ok(!json.includes('"equity"'), '整个包不得出现 equity 字段');
  assert.ok(!json.includes('"benchmark":['), '整个包不得出现 benchmark 曲线数组');
  assert.ok(json.length < 20_000, `包体积应远小于曲线（实际 ${json.length} 字节）——塞了曲线就说明映射写错了`);
});

test('模型原样可导回：bundle.model 与输入深相等（不受其它字段影响）', () => {
  const m = MODEL();
  const b = R.buildResearchBundle({ model: m, run: RUN() });
  assert.deepStrictEqual(b.model, m);
  // 回测参数不属于 Model JSON（规范只允许 meta.author/tags），必须单独一层
  assert.ok(b.runOptions && 'topN' in b.runOptions);
  assert.ok(!('topN' in b.model));
  assert.deepStrictEqual(Object.keys(b.model.meta).sort(), ['author', 'tags']);
});

test('🔴 Markdown 表格必须扛住竖线与换行（自由文本里两者都常见）', () => {
  const m = MODEL();
  m.name = 'A|B 组合\n第二行';
  m.hypothesis = '含 | 竖线\n与换行';
  const b = R.buildResearchBundle({
    model: m,
    run: RUN(),
    validation: VALIDATION(),
    experiments: [{ ts: '2026-10-05T01:02:03.000Z', fingerprint: 'x'.repeat(64), totalReturn: 1.5, maxDrawdownPct: 2.5, sharpe: 0.3 }],
  });
  const md = R.renderResearchReport(b);
  // 标题行里的竖线必须转义
  assert.ok(md.includes('A\\|B'), `标题中的竖线应转义，实际首行：${md.split('\n')[0]}`);
  // ⚠️ 只能对**表格行**校验"无未转义竖线"：JSON 代码块里原样打印模型是对的，
  //    在那里把 `|` 转义反而会破坏 JSON 的可导回性。
  const tableLines = md.split('\n').filter((l) => l.startsWith('|'));
  for (const l of tableLines) {
    assert.ok(!/(?<!\\)A\|B/.test(l), `表格行里出现了未转义的竖线：${l}`);
  }
  assert.ok(!/\n第二行/.test(md.split('## 一、')[0]), '标题内的换行必须被压平成一行');
  // 反过来：JSON 块里的模型必须保持原样（否则包不能导回）
  //   注意 JSON.stringify 会把换行转义成字面 `\n`，故只匹配到名称前半段
  assert.ok(md.includes('"A|B 组合'), 'JSON 代码块里的模型定义必须原样保留竖线（不得被表格转义规则污染）');
});

test('🔴 Markdown 表格每行的列数一致（转义/换行处理错会直接撕坏表格）', () => {
  const m = MODEL();
  m.name = '带|竖线';
  const b = R.buildResearchBundle({
    model: m,
    run: RUN(),
    validation: VALIDATION(),
    experiments: [
      { ts: '2026-10-05T01:02:03.000Z', fingerprint: 'x'.repeat(64), totalReturn: 1.5, maxDrawdownPct: 2.5, sharpe: 0.3 },
      { ts: '2026-10-05T02:02:03.000Z', fingerprint: 'y'.repeat(64), totalReturn: -1.5, maxDrawdownPct: 3.5, sharpe: -0.3 },
    ],
  });
  const md = R.renderResearchReport(b);
  // 解析出所有表格块，检查每块内各行列数一致（排除 `| --- |` 分隔行）
  const lines = md.split('\n');
  let block = [];
  const blocks = [];
  for (const line of lines) {
    if (line.startsWith('|')) block.push(line);
    else {
      if (block.length) blocks.push(block);
      block = [];
    }
  }
  if (block.length) blocks.push(block);
  assert.ok(blocks.length >= 4, `报告应含多张表，实际 ${blocks.length}`);
  for (const blk of blocks) {
    const cols = blk.map((l) => (l.match(/(?<!\\)\|/g) || []).length);
    assert.strictEqual(new Set(cols).size, 1, `同一张表的列数必须一致，实际 ${JSON.stringify(cols)}\n${blk.join('\n')}`);
  }
});

test('报告：缺项时给出可执行说明，而不是空白', () => {
  const md = R.renderResearchReport(R.buildResearchBundle({ model: MODEL() }));
  assert.match(md, /本次未执行回测/, '没有基准结果时必须明说');
  assert.match(md, /本次未运行验证/, '没有验证结论时必须明说，并给出下一步');
  assert.match(md, /本报告未包含/, '缺项清单必须出现在报告里');
  // 三张表的表头不该在缺项时仍然出现（否则读者以为数据是空的而不是没跑）
  assert.ok(!md.includes('| 折 | 区间 |'), '未跑验证时不得渲染样本外表格');
});

test('报告：验证结论必须自带"pass≠有效"的限定与不覆盖清单', () => {
  const md = R.renderResearchReport(R.buildResearchBundle({ model: MODEL(), run: RUN(), validation: VALIDATION() }));
  assert.match(md, /不等于模型有效/, '这是本套件最容易误读的地方，必须在报告里写明');
  assert.match(md, /不构成[^。]*保证/, '必须写明不构成收益保证（措辞可调整，但意思不能丢）');
  assert.match(md, /本套件不覆盖/);
  assert.match(md, /日内信息泄露/, '不覆盖清单必须包含日内泄露（日线归档物理不可检）');
  // 单一源：不覆盖清单在报告里只出现一次（避免两处各写一遍后分叉）
  assert.strictEqual(md.split('本套件不覆盖').length - 1, 1, '「本套件不覆盖」标题只应出现一次');
  assert.match(md, /怎样复现|如何复现/, '必须给出复现步骤');
  assert.match(md, /物理截断/, '因果性做法要写清"物理截断"而非只挪窗口');
  assert.match(md, /2022-12-09/, 'as-of 池子事实应进报告（判读 inconclusive 需要它）');
});

test('报告：已知局限优先取验证报告里的（那是随那次运行算出来的），无则回落到入参', () => {
  const withV = R.renderResearchReport(R.buildResearchBundle({ model: MODEL(), validation: VALIDATION(), limitations: ['入参的局限'] }));
  assert.match(withV, /核心股票池（非全市场）/, '有验证报告时应采用报告内的局限');
  assert.ok(!withV.includes('入参的局限'), '不得同时混入两份局限（会让读者分不清口径）');

  const noV = R.renderResearchReport(R.buildResearchBundle({ model: MODEL(), limitations: ['入参的局限'] }));
  assert.match(noV, /入参的局限/, '没有验证报告时回落到入参局限，而不是留空');
});

test('报告：实验记录表兼容"完整记录（metrics 嵌套）"与"列表行（扁平）"两种形状', () => {
  const flat = { ts: '2026-10-05T01:02:03.000Z', fingerprint: 'a'.repeat(64), totalReturn: 5, maxDrawdownPct: 6, sharpe: 0.7 };
  const nested = { ts: '2026-10-06T01:02:03.000Z', fingerprint: 'b'.repeat(64), metrics: { totalReturn: -5, maxDrawdownPct: 7, sharpe: -0.7 } };
  const md = R.renderResearchReport(R.buildResearchBundle({ model: MODEL(), experiments: [flat, nested] }));
  assert.match(md, /\+5\.00%/, '扁平形状应能渲染');
  assert.match(md, /-5\.00%/, '嵌套 metrics 形状也应能渲染（否则对比表会变成一堆 —）');
  assert.match(md, /关联实验记录/);
});

test('报告：缺项时不留"八、关联实验记录"这种空章节', () => {
  const md = R.renderResearchReport(R.buildResearchBundle({ model: MODEL() }));
  assert.ok(!md.includes('关联实验记录'), '没有实验记录就不该有这一章');
});

test('🔴 .mjs 转发壳与 .cjs 实现同源（前端按 .mjs 导入，两处行为必须一致）', async () => {
  // 前端 import 的是 research-bundle.mjs（转发壳）。壳写错/漏导出时 TS 与构建都未必报错，
  // 但运行期会 undefined ⇒ 在这里钉死"壳导出的与实现是同几个函数、行为一致"。
  const mjs = await import('../shared/research-bundle.mjs');
  assert.strictEqual(mjs.KIND, R.KIND);
  assert.strictEqual(mjs.BUNDLE_VERSION, R.BUNDLE_VERSION);
  assert.strictEqual(typeof mjs.buildResearchBundle, 'function');
  assert.strictEqual(typeof mjs.renderResearchReport, 'function');
  const args = { model: MODEL(), run: RUN(), exportedAt: '2026-10-05T12:00:00.000Z' };
  assert.deepStrictEqual(mjs.buildResearchBundle(args), R.buildResearchBundle(args), '壳与实现必须产出同一份包');
  assert.strictEqual(
    mjs.renderResearchReport(mjs.buildResearchBundle(args)),
    R.renderResearchReport(R.buildResearchBundle(args)),
    '壳与实现必须产出同一份报告',
  );
});

test('报告：章节编号连续（缺项时不得跳号，否则读者以为漏印一章）', () => {
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const check = (bundle, label) => {
    const md = R.renderResearchReport(bundle);
    const heads = [...md.matchAll(/^## (.)、/gm)].map((m) => m[1]);
    assert.ok(heads.length >= 4, `${label}：章节太少（${heads.join('')}）`);
    heads.forEach((h, i) => {
      assert.strictEqual(h, CN[i], `${label}：第 ${i + 1} 个章节编号应为「${CN[i]}」，实际「${h}」（章节序列 ${heads.join('')}）`);
    });
  };
  // 全有 / 全无 / 只有实验 —— 三种缺项组合都要连续
  check(R.buildResearchBundle({ model: MODEL(), run: RUN(), validation: VALIDATION(), experiments: [{ ts: 't', fingerprint: 'f', totalReturn: 1 }] }), '全有');
  check(R.buildResearchBundle({ model: MODEL() }), '全无');
  check(R.buildResearchBundle({ model: MODEL(), experiments: [{ ts: 't', fingerprint: 'f', totalReturn: 1 }] }), '只有实验');
});

test('类型声明与实现同步（.d.mts 里声明的导出都真实存在）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dts = fs.readFileSync(path.join(__dirname, '..', 'shared', 'research-bundle.d.mts'), 'utf8');
  const declared = [...dts.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 4, `.d.mts 应声明若干导出，实际 ${declared.join(',')}`);
  for (const name of declared) {
    assert.ok(name in R, `.d.mts 声明了 ${name}，但实现里没有 —— 前端会拿到 undefined`);
  }
});
