// ─────────────────────────────────────────────────────────────
// 因子表达式引擎测试（M3.4）
//
//   三类断言：
//     1. 解析器：合法表达式应通过，**非法/越界/危险输入必须全部拒绝**
//        —— 这是安全边界，不是功能测试。
//     2. 等价性锁：`mom20` 表达式结果 === 预置 mom20（逐位一致）
//        —— 防止两套动量口径悄悄分叉（项目曾因 5 套 RSI 吃亏）。
//     3. 接链：表达式须完整流入回测 / 分层 / IC 链路。
//
//   注意：本文件**不改 process.env.LOCAL_HISTORY_DIR**（避免污染同进程其他测试）；
//   所有需要真实归档的用例都显式判断归档是否存在，缺失则打印原因跳过（不伪装通过）。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fe = require('../server/factorexpr.cjs');
const crosssect = require('../server/crosssect.cjs');

const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);
function skipReal(name) {
  console.log(`  [skip] ${name}：真实归档不存在（${REAL_DIR}）`);
}

// ── 1. 解析器：合法输入 ───────────────────────────────────────

test('解析器：预置式简写与括号式等价（mom20 ≡ mom(20)）', () => {
  const a = fe.parseExpression('mom20');
  const b = fe.parseExpression('mom(20)');
  assert.ok(a.ok && b.ok);
  assert.deepStrictEqual(a.ast, b.ast, 'mom20 与 mom(20) 应解析为完全相同的 AST');
  assert.strictEqual(a.meta.maxWindow, 20);
});

test('解析器：四则运算的优先级正确（乘除先于加减）', () => {
  // 用真实算子构造可观测的优先级差异：mom20 与 rev20 数值相反，
  // 故 `mom20 + mom20 * 2` 应 = mom20*3 而非 mom20*4。
  const r = fe.parseExpression('mom20 + mom20 * 2');
  assert.ok(r.ok, r.error);
  const rows = [];
  for (let i = 0; i <= 20; i++) rows.push({ adjClose: i === 0 ? 100 : 100 + i });
  const v = fe.evalOnStock(r.ast, rows, 20);
  const mom = rows[20].adjClose / rows[0].adjClose - 1;
  assert.ok(Math.abs(v - mom * 3) < 1e-12, `应为 mom*3=${mom * 3}，实际 ${v}`);
});

test('解析器：括号改变优先级', () => {
  const r = fe.parseExpression('(mom20 + mom60) / 2');
  assert.ok(r.ok);
  assert.strictEqual(r.meta.maxWindow, 60, '最长窗口应决定 maxWindow');
  // (a+b)/2 与 a+b/2 应给出不同结果——验证括号真的生效
  const nested = fe.parseExpression('mom20 + mom60 / 2');
  assert.notDeepStrictEqual(r.ast, nested.ast, '括号应改变 AST 结构');
});

test('解析器：一元负号与减号均可解析', () => {
  assert.ok(fe.parseExpression('-mom20').ok);
  assert.ok(fe.parseExpression('mom60 - mom20').ok);
  assert.ok(fe.parseExpression('mom20 - mom60').ok);
});

test('解析器：多参数算子 volratio(n,m)', () => {
  const r = fe.parseExpression('volratio(5,60)');
  assert.ok(r.ok);
  assert.strictEqual(r.meta.maxWindow, 60);
});

test('解析器：全部白名单算子可用', () => {
  for (const op of ['mom', 'rev', 'vol', 'turnover', 'amount', 'lowvol', 'bias']) {
    const r = fe.parseExpression(`${op}(20)`);
    assert.ok(r.ok, `${op}(20) 应可解析：${r.error}`);
  }
});

// ── 2. 解析器：安全边界（必须全部拒绝）──────────────────────

test('安全：绝不 eval —— 危险标识符必须拒绝', () => {
  for (const s of ['eval(1)', 'require(1)', 'process.exit()', 'globalthis',
                   'Function("return 1")()', 'this.constructor', 'mom(20).constructor']) {
    const r = fe.parseExpression(s);
    assert.ok(!r.ok, `危险输入 "${s}" 必须被拒绝，却通过了`);
  }
});

test('安全：括号/逗号不能走私出算子调用', () => {
  for (const s of ['mom(20))', '(mom20', 'mom(20', 'mom 20', 'mom()', '1+', 'mom(20)+*2']) {
    assert.ok(!fe.parseExpression(s).ok, `畸形输入 "${s}" 必须被拒绝`);
  }
});

test('安全：窗口必须为正整数且不超上限', () => {
  assert.ok(!fe.parseExpression('mom(0)').ok, '窗口 0 应拒绝');
  assert.ok(!fe.parseExpression('mom(-5)').ok, '负窗口应拒绝');
  assert.ok(!fe.parseExpression(`mom(${fe.MAX_WINDOW + 1})`).ok, '超上限应拒绝');
  assert.ok(fe.parseExpression(`mom(${fe.MAX_WINDOW})`).ok, '恰好等于上限应通过');
});

test('安全：表达式长度与嵌套深度设上限', () => {
  const tooLong = 'mom20' + '+mom20'.repeat(fe.MAX_LEN);
  assert.ok(!fe.parseExpression(tooLong).ok, '超长表达式应拒绝');

  const deep = 'mom20' + '+mom20'.repeat(fe.MAX_DEPTH + 5);
  const r = fe.parseExpression(deep);
  assert.ok(!r.ok, '超深嵌套应拒绝');
  assert.match(r.error, /嵌套过深/);
});

test('安全：参数个数错误应拒绝', () => {
  assert.ok(!fe.parseExpression('mom(1,2)').ok, 'mom 只接受 1 个参数');
  assert.ok(!fe.parseExpression('volratio(5)').ok, 'volratio 需 2 个参数');
  assert.ok(!fe.parseExpression('volratio5').ok, '多参算子不支持简写');
});

test('安全：空表达式与纯常数应拒绝', () => {
  assert.ok(!fe.parseExpression('').ok);
  assert.ok(!fe.parseExpression('   ').ok);
  assert.ok(!fe.parseExpression('42').ok, '纯常数无选股意义，应拒绝');
});

// ── 3. 方向推断：宁缺毋滥 ────────────────────────────────────

test('方向推断：单一算子族可判，混合/非线性一律 null', () => {
  const dir = (s) => {
    const p = fe.parseExpression(s);
    assert.ok(p.ok, s);
    return fe.inferDirection(p.meta, p.ast);
  };
  assert.strictEqual(dir('mom20'), 'momentum');
  assert.strictEqual(dir('rev20'), 'reversal');
  assert.strictEqual(dir('mom20 * 2'), 'momentum');
  assert.strictEqual(dir('rev20 * 2'), 'reversal');
  // 以下都**不能**猜：猜错方向会给出与策略相反的结论
  assert.strictEqual(dir('mom60 - mom20'), null, '长减短语义即反转，不可判为 momentum');
  assert.strictEqual(dir('mom20 + rev60'), null, 'mom 与 rev 混用');
  assert.strictEqual(dir('vol20'), null, 'vol 与方向无关');
  assert.strictEqual(dir('bias20'), null, 'bias 与方向无关');
});

// ── 4. 等价性锁（核心）───────────────────────────────────────

test('等价性锁：mom20 表达式与预置 mom20 的截面值逐位一致', () => {
  // 与下方"全链路等价性"同一前提：等价性锁比对的是**本地归档**的真实截面，
  // CI/全新 clone 没有 data/history/kline ⇒ 显式跳过（否则 ENOENT 直接红）
  if (!hasRealArchive) return skipReal('等价性锁（mom20 截面逐位一致）');
  const r = fe.parseExpression('mom20');
  assert.ok(r.ok);
  let checked = 0;
  let mismatch = 0;
  for (const f of fs.readdirSync(REAL_DIR).filter((x) => x.endsWith('.json')).slice(0, 20)) {
    const doc = JSON.parse(fs.readFileSync(path.join(REAL_DIR, f), 'utf8'));
    const rows = (doc.rows || []).filter(
      (x) => x.date && Number.isFinite(x.close) && Number.isFinite(x.open) && x.close > 0 && x.open > 0,
    );
    for (const x of rows) x.adjClose = x.close; // 两边同源，只需验证 mom 定义一致
    for (let i = 20; i < rows.length; i++) {
      const c0 = rows[i - 20].adjClose;
      const c1 = rows[i].adjClose;
      const preset = c1 / c0 - 1;
      const expr = fe.evalOnStock(r.ast, rows, i);
      checked += 1;
      if (expr !== preset) mismatch += 1;
    }
  }
  assert.ok(checked > 1000, `样本量应足够，实际 ${checked}`);
  assert.strictEqual(mismatch, 0, `${checked} 个截面点中有 ${mismatch} 个与预置口径不一致`);
});

test('等价性锁（全链路）：预置 mom20 与表达式 mom(20) 的回测数值逐位一致', () => {
  if (!hasRealArchive) return skipReal('全链路等价性');
  const opts = { topN: 20, rebalanceEvery: 20, capital: 100000 };
  const p = crosssect.runCrossBacktest({ factor: 'mom20', ...opts });
  const q = crosssect.runCrossBacktest({ factor: 'mom(20)', ...opts });
  assert.ok(!p.error && !q.error, `回测不应报错：${p.error || q.error}`);
  // 只比数值口径字段——factor / factorKind / factorExprMeta 是"怎么算"的标识，必然不同
  for (const k of ['factorWindow', 'topN', 'rebalanceEvery', 'universeSize', 'capital', 'range',
                   'rebalances', 'fills', 'totalFees', 'turnover', 'finalValue', 'totalReturn',
                   'annualized', 'maxDrawdownPct', 'sharpe', 'equity']) {
    assert.deepStrictEqual(q[k], p[k], `字段 ${k} 在表达式与预置口径下不一致`);
  }
  // ic 块除 factor 标签外应完全一致
  const icp = { ...p.ic }; const icq = { ...q.ic };
  delete icp.factor; delete icq.factor;
  assert.deepStrictEqual(icq, icp, 'ic 块（除 factor 标签外）应完全一致');
});

test('等价性锁（分层）：预置 mom20 与表达式 mom(20) 的分层数值一致', () => {
  if (!hasRealArchive) return skipReal('分层等价性');
  const opts = { layers: 5, rebalanceEvery: 20 };
  const p = crosssect.layerAnalysis({ factor: 'mom20', ...opts });
  const q = crosssect.layerAnalysis({ factor: 'mom(20)', ...opts });
  assert.ok(!p.error && !q.error);
  assert.deepStrictEqual(q.layers, p.layers, '逐层结果应完全一致');
  assert.strictEqual(q.mono.spearman, p.mono.spearman);
  assert.strictEqual(q.mono.longShortSpreadPct, p.mono.longShortSpreadPct);
});

// ── 5. 接链：表达式须完整进入回测/分层/IC ────────────────────

test('接链：自定义表达式可进入回测链路并产出 IC', () => {
  if (!hasRealArchive) return skipReal('表达式接链');
  const r = crosssect.runCrossBacktest({ factor: 'mom60 - mom20', topN: 20, rebalanceEvery: 20, capital: 100000 });
  assert.ok(!r.error, `表达式应可用：${r.error}`);
  assert.strictEqual(r.factorKind, 'expr');
  assert.strictEqual(r.factorWindow, 60, 'maxWindow 应决定因子窗口');
  assert.ok(r.ic && r.ic.n > 20, `应产出 IC 序列，实际 n=${r.ic?.n}`);
});

test('接链：表达式可进入分层链路', () => {
  if (!hasRealArchive) return skipReal('表达式分层');
  const r = crosssect.layerAnalysis({ factor: 'mom60 - mom20', layers: 5, rebalanceEvery: 20 });
  assert.ok(!r.error, `表达式应可用：${r.error}`);
  assert.strictEqual(r.layers.length, 5);
  // 方向不定时必须显式标注，且 aligned 为 null（不猜）
  assert.strictEqual(r.directionUncertain, true);
  assert.strictEqual(r.mono.strategyAligned, null, '方向不定的表达式不可声称"与策略一致/相反"');
  assert.match(r.mono.strategyNote, /方向不定/);
});

test('接链：非线性算子可组合出可用因子', () => {
  if (!hasRealArchive) return skipReal('非线性算子');
  for (const f of ['-vol20', 'bias20', '(mom20 + rev60) / 2', 'turnover(5) * -1']) {
    const r = crosssect.runCrossBacktest({ factor: f, topN: 10, rebalanceEvery: 20, capital: 100000 });
    assert.ok(!r.error, `${f} 应可用：${r.error}`);
    assert.ok(Number.isFinite(r.totalReturn), `${f} 应产出数值净值`);
  }
});

// ── 6. 空截面守卫（铁律 #4：降级必须显式）────────────────────

test('守卫：恒除零表达式必须显式报错，不得静默返回 0 收益', () => {
  if (!hasRealArchive) return skipReal('空截面守卫');
  // rev60 ≡ −mom60，故 (mom60 + rev60) ≡ 0 → 恒除零 → 全截面为空
  const r = crosssect.runCrossBacktest({
    factor: 'rev20 * mom20 / (mom60 + rev60)', topN: 10, rebalanceEvery: 20, capital: 100000,
  });
  assert.ok(r.error, '恒除零应报错，而非返回 totalReturn=0 的"成功"');
  assert.match(r.error, /截面.*全为空|恒零分母/);
});

test('守卫：分层链路同样拒绝恒除零表达式', () => {
  if (!hasRealArchive) return skipReal('分层空截面守卫');
  const r = crosssect.layerAnalysis({ factor: 'mom20 / (mom60 + rev60)' });
  assert.ok(r.error, '分层也应显式报错');
});

test('守卫：非法表达式回显解析原因，不静默回退到默认因子', () => {
  // 该守卫验证的是"归档已加载后，解析错误先于回测发生"的报错文案；
  // 无归档时 runCrossBacktest 在解析前就因缺数据报错，文案必然不同 ⇒ 显式跳过
  if (!hasRealArchive) return skipReal('非法表达式守卫（报错文案依赖归档先行加载）');
  const r = crosssect.runCrossBacktest({ factor: 'eval(1)', topN: 10, rebalanceEvery: 20 });
  assert.ok(r.error, '非法表达式应报错');
  assert.match(r.error, /表达式解析失败/, '应说明是解析问题');
  // 关键：不得静默当成 mom20 跑出一个看似正常的净值
  assert.strictEqual(r.totalReturn, undefined, '不应返回净值');
});

// ── 7. 回归：预置因子行为未被改动 ────────────────────────────

test('回归：预置因子仍走 preset 路径且数值不变', () => {
  if (!hasRealArchive) return skipReal('预置因子回归');
  const r = crosssect.runCrossBacktest({ factor: 'mom20', topN: 20, rebalanceEvery: 20, capital: 100000 });
  assert.strictEqual(r.factorKind, 'preset');
  assert.strictEqual(r.factorExprMeta, null, '预置因子不应有表达式元数据');
  assert.strictEqual(r.totalReturn, -73.02, '预置 mom20 的净值与接入表达式前应一致');
  assert.strictEqual(r.fills, 3469);
});

test('回归：预置因子方向分判保持不变（mom20 → 相反、rev20 → 一致）', () => {
  if (!hasRealArchive) return skipReal('方向分判回归');
  const m = crosssect.layerAnalysis({ factor: 'mom20', layers: 5, rebalanceEvery: 20 });
  const v = crosssect.layerAnalysis({ factor: 'rev20', layers: 5, rebalanceEvery: 20 });
  assert.strictEqual(m.directionUncertain, false);
  assert.strictEqual(v.directionUncertain, false);
  // 同一 rho 符号，因因子族不同给出相反结论——这正是方向分判存在的意义
  assert.strictEqual(m.mono.spearman, v.mono.spearman);
  assert.notStrictEqual(m.mono.strategyAligned, v.mono.strategyAligned);
});

// ── 8. resolveFactor 契约 ────────────────────────────────────

test('resolveFactor：预置与表达式两条路都能解析，未知输入报错', () => {
  const preset = crosssect.resolveFactor('mom20');
  assert.ok(preset.ok && preset.kind === 'preset' && preset.isReversal === false);

  const rev = crosssect.resolveFactor('rev60');
  assert.ok(rev.ok && rev.isReversal === true);

  const expr = crosssect.resolveFactor('mom60 - mom20');
  assert.ok(expr.ok && expr.kind === 'expr');

  const empty = crosssect.resolveFactor('');
  assert.ok(!empty.ok && /因子为空/.test(empty.error));

  const bad = crosssect.resolveFactor('notanop(5)');
  assert.ok(!bad.ok && /解析失败/.test(bad.error));
});
