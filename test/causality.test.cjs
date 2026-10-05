// ─────────────────────────────────────────────────────────────
// 因果性 / 未来函数检验测试（Phase 2 §5.3 第 5 项）
//
//   🔴 本文件最重要的不是"干净模型能通过"，而是**这个检验真的能抓到泄露**。
//      一个永远返回"通过"的检验等于没有检验 —— 故有 positive control：
//      手工构造一个「用全样本标准差做标准化」的泄露截面（经典 look-ahead），
//      断言它**必须**被检出；干净截面必须不被误报。
//
//   🔴 方法论锁（本文件的核心教训）：**必须物理截断归档文件**。
//      只传 endDate 时 `universe`（原始 rows）仍是全量 ⇒ "读了窗口外那几行"的泄露
//      完全不可见，检验会永远返回通过。实测：同一份泄露截面，只传 endDate 检不出，
//      物理截断立刻检出。那条测试就是钉住这个区别的。
//
//   测试规模策略：真实归档约 90MB，一次截断要重写全部文件（本机约 10s）
//   ⇒ 绝大多数用例跑**合成归档**（十几只 × 数百行，毫秒级，且 CI 无归档时也真跑），
//      真实归档只保留 2 条冒烟用例。
//
//   另外锁住两个容易踩空的结构约定：
//     ① `equity` 末点是「期末强平追加点」，与末个交易日**同日** —— 比对前必须剥离，
//        否则每个截断点都会"不一致"（全线假阳性，实测踩过）
//     ② 引擎的 T-1 决策 / T 执行顺序（日内信息泄露的唯一防线，源码级契约锁）
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const V = require('../server/validation.cjs');
const { runModel } = require('../server/modelrun.cjs');
const crosssect = require('../server/crosssect.cjs');
const { runWithCrossSection } = crosssect;

const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasRealArchive = fs.existsSync(REAL_DIR);
const skipReal = (t) => {
  if (!hasRealArchive) {
    console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
    return true;
  }
  return false;
};

const MODEL = (over = {}) => ({
  schemaVersion: 1,
  name: '因果性测试模型',
  factors: [{ id: 'f', expr: 'mom20', weight: 1, direction: 1 }],
  meta: { author: 'tester' },
  ...over,
});

// ═══ 合成归档夹具 ═══════════════════════════════════════════
//   设计要点：**故意混入 2 只"晚上市"的标的**（从 lateStart 起才有数据），
//   用来精确构造三种情形：
//     · cut 在晚上市之前      → as-of 池子少 2 只，但两者都选不到它们 ⇒ 路径一致（causal）
//     · cut 在上市后、满 80 行前 → 全集能选到、截断池子选不到 ⇒ 路径不同 + 池子不同（inconclusive）
//     · cut 在满 80 行之后     → 池子一致 ⇒ 判读确定（causal）
const ARCH = { stocks: 12, rows: 520, lateStocks: 2, lateStart: 300 };

const dstr = (i) => new Date(Date.UTC(2015, 0, 5) + i * 86400000).toISOString().slice(0, 10);
/** 池子完整起点 = 晚上市标的第 UNIVERSE_MIN_ROWS 行的日期 */
const ARCH_POOL_STABLE = dstr(ARCH.lateStart + crosssect.UNIVERSE_MIN_ROWS - 1);

let archDir = null;
function makeArchive() {
  if (archDir) return archDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causality-arch-'));
  let seed = 20261005;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let k = 0; k < ARCH.stocks; k++) {
    const code = `sh${600000 + k}`;
    const late = k >= ARCH.stocks - ARCH.lateStocks;
    const from = late ? ARCH.lateStart : 0;
    let px = 10 + k;
    const rows = [];
    for (let i = from; i < ARCH.rows; i += 1) {
      px = Math.max(1, px * (1 + (rnd() - 0.47) * 0.05));
      const c = +px.toFixed(4);
      rows.push({
        date: dstr(i),
        open: +(c * 0.995).toFixed(4),
        high: +(c * 1.01).toFixed(4),
        low: +(c * 0.99).toFixed(4),
        close: c,
        volume: 1000,
        amount: 1_000_000,
        turn: 1,
        pctChg: 0,
      });
    }
    fs.writeFileSync(
      path.join(dir, `${code}.json`),
      JSON.stringify({ code, adjust: 'none+factor', rows, factors: [] }),
    );
  }
  archDir = dir;
  return dir;
}

/** 在指定归档目录下执行一段代码（切 env → 跑 → 还原） */
function withArchive(dir, fn) {
  const saved = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.LOCAL_HISTORY_DIR;
    else process.env.LOCAL_HISTORY_DIR = saved;
  }
}

/** 与 causalityCheck 同规则的前缀比对（剥离期末强平追加点后逐点比） */
function prefixMismatch(fullSeries, segSeries) {
  const f = V.stripTerminalArtifact(fullSeries).series;
  const s = V.stripTerminalArtifact(segSeries).series;
  for (let i = 0; i < s.length; i += 1) {
    if (!f[i]) return { index: i, date: s[i].date, reason: '截断段更长' };
    if (f[i].date !== s[i].date) return { index: i, date: s[i].date, reason: '日期错位' };
    if (f[i].value !== s[i].value) return { index: i, date: s[i].date, seg: s[i].value, full: f[i].value, reason: '净值不同' };
  }
  return null;
}

/** 干净截面：只用 prevDate 及其之前的 20 日动量（与引擎自己的口径一致） */
function makeCausalCrossSection() {
  return (universe, rowIndex, prevDate) => {
    const out = [];
    for (const [code, rows] of universe) {
      const i = rowIndex.get(code)?.get(prevDate);
      if (i === undefined || i < 20) continue;
      const p0 = rows[i - 20].adjClose;
      const p1 = rows[i].adjClose;
      if (Number.isFinite(p0) && p0 > 0 && Number.isFinite(p1) && p1 > 0) out.push({ code, mom: p1 / p0 - 1 });
    }
    return out;
  };
}

/**
 * 泄露截面：把动量除以该股**全期**动量的标准差（经典 look-ahead：用了全样本统计量）。
 *   为什么选它：它是"看起来更严谨"的做法，新手极容易这么写；
 *   且它确实改变排序（每只股票的标准差不同），故能被前缀一致性检出。
 *   ⚠️ 不能用"减全期均值"当泄露样本 —— 常数平移不改变排序，测不出差别。
 */
function makeLeakyCrossSection() {
  const causal = makeCausalCrossSection();
  return (universe, rowIndex, prevDate) => {
    const raw = causal(universe, rowIndex, prevDate);
    const sd = new Map();
    for (const [code, rows] of universe) {
      const vals = [];
      for (let k = 20; k < rows.length; k += 1) {
        const a = rows[k - 20].adjClose;
        const b = rows[k].adjClose;
        if (Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0) vals.push(b / a - 1);
      }
      if (vals.length > 1) {
        const mu = vals.reduce((x, y) => x + y, 0) / vals.length;
        const va = vals.reduce((x, y) => x + (y - mu) ** 2, 0) / (vals.length - 1);
        sd.set(code, Math.sqrt(va) || 1);
      }
    }
    return raw.map((x) => ({ code: x.code, mom: x.mom / (sd.get(x.code) || 1) }));
  };
}

const runCS = (cs, over = {}) =>
  runWithCrossSection(cs, {
    factorWin: 20,
    topN: 5,
    rebalanceEvery: 20,
    capital: 1_000_000,
    slippage: 0.001,
    rawEquity: true,
    ...over,
  });

test.after(() => {
  if (archDir) {
    try {
      fs.rmSync(archDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

// ═══ 一、结构约定：完整序列与期末强平追加点 ═══════════════════

test('engine：默认不返回未抽稀序列；rawEquity=true 才返回，且抽稀序列是它的抽样', () => {
  const dir = makeArchive();
  const a = withArchive(dir, () => runModel(MODEL(), { topN: 5 }));
  assert.strictEqual(a.result.equityFull, undefined, '默认不得返回完整序列（响应体会膨胀约 5 倍）');

  const b = withArchive(dir, () => runModel(MODEL(), { topN: 5, rawEquity: true }));
  assert.ok(Array.isArray(b.result.equityFull), 'rawEquity=true 必须返回 equityFull');
  assert.ok(b.result.equityFull.length > b.result.equity.length, '完整序列点数应多于抽稀序列');
  assert.strictEqual(b.result.equity.length, a.result.equity.length, '开不开 rawEquity 不得改变抽稀序列本身');

  // 抽稀规则 = 每 5 根 + 末根（黄金样本已锁）。
  // ⚠️ 末点是「期末强平追加点」，与倒数第二个抽稀点**同日** ⇒ 末点必须单独比。
  //    用日期查表（find）会命中同日的前一个逐日点，误判成"值不一致"——实测踩过。
  const full = b.result.equityFull;
  const thin = b.result.equity;
  const daily = V.stripTerminalArtifact(full).series;
  thin.slice(0, -1).forEach((p, i) => {
    assert.strictEqual(p.date, daily[i * 5].date, `第 ${i} 个抽稀点应是逐日序列的 i*5 位`);
    assert.strictEqual(p.value, daily[i * 5].value, '抽样点的值必须与逐日序列一致');
  });
  const lastThin = thin[thin.length - 1];
  assert.strictEqual(lastThin.date, full[full.length - 1].date, '末点应取完整序列的末点');
  assert.strictEqual(lastThin.value, full[full.length - 1].value, '末点值应等于期末强平后的终值');
});

test('🔴 结构约定：完整序列末两点**同日**（期末强平追加点），比对前必须剥离', () => {
  const dir = makeArchive();
  const b = withArchive(dir, () => runModel(MODEL(), { topN: 5, rawEquity: true }));
  const s = b.result.equityFull;
  assert.strictEqual(
    s[s.length - 1].date,
    s[s.length - 2].date,
    '末点应是「期末强平」在末个交易日追加的终值（与前一交易日同日）——结构变了必须同步改比对规则',
  );
  const r = V.stripTerminalArtifact(s);
  assert.strictEqual(r.stripped, true, '应识别出并剥离该追加点');
  assert.strictEqual(r.series.length, s.length - 1);
  assert.notStrictEqual(
    r.series[r.series.length - 1].date,
    r.series[r.series.length - 2].date,
    '剥离后不得再有同日相邻点（交易日唯一）',
  );
});

test('stripTerminalArtifact：无同日末点时不误剥（判据是"末尾同日"，不是"总是砍一个"）', () => {
  const clean = [
    { date: '2024-01-01', value: 1 },
    { date: '2024-01-02', value: 2 },
    { date: '2024-01-03', value: 3 },
  ];
  const r = V.stripTerminalArtifact(clean);
  assert.strictEqual(r.stripped, false);
  assert.strictEqual(r.series.length, 3);
  assert.deepStrictEqual(r.series, clean);

  const dup = [...clean, { date: '2024-01-03', value: 9 }];
  const r2 = V.stripTerminalArtifact(dup);
  assert.strictEqual(r2.stripped, true);
  assert.strictEqual(r2.series.length, 3);
});

// ═══ 二、causalityCheck 行为（合成归档）␤════════════════════

test('causalityCheck：非法模型 → 显式失败并透传 stage（不返回"通过"）', () => {
  const r = V.causalityCheck({ schemaVersion: 1, name: '', factors: [], meta: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'validate');
  assert.ok(r.issues && r.issues.length > 0);
});

test('🔴 顺序约定：归档不存在时，**模型非法**仍必须报 stage=validate（不得被"归档不存在"遮住）', () => {
  // 这正是 CI 环境（无 data/history）暴露出来的一个真缺陷：原实现先查归档再跑模型，
  // 于是"模型写错了"被"归档不存在"顶掉，报错指向错误的方向。
  const saved = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = path.join(os.tmpdir(), 'no-such-archive-xyz');
  try {
    const r = V.causalityCheck({ schemaVersion: 1, name: '', factors: [], meta: {} });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'validate', '模型非法必须优先于归档可用性报出来');
    assert.ok(r.issues && r.issues.length > 0);
  } finally {
    if (saved === undefined) delete process.env.LOCAL_HISTORY_DIR;
    else process.env.LOCAL_HISTORY_DIR = saved;
  }
});

test('causalityCheck：默认截断点一律取在池子完整之后 ⇒ 池子不缩水、判读确定', () => {
  const dir = makeArchive();
  const r = withArchive(dir, () => V.causalityCheck(MODEL(), { cuts: 1, opts: { topN: 5 } }));
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.pool.cutSelection, 'after-pool-stable');
  assert.strictEqual(r.pool.stableFrom, ARCH_POOL_STABLE, '池子完整起点应等于"晚上市标的第 80 行"的日期');
  const c = r.cuts[0];
  assert.ok(c.cut >= r.pool.stableFrom, `默认截断点 ${c.cut} 必须晚于池子完整起点 ${r.pool.stableFrom}`);
  assert.strictEqual(c.universeShift, false, '池子完整之后截断，池子不应变化');
  assert.strictEqual(c.mismatch, null);
  assert.strictEqual(r.verdict, 'causal');
  assert.deepStrictEqual(r.flags, [], '一致时不得有任何告警（假阳性会让这个检验失去信任）');
  assert.strictEqual(r.terminalPointStripped, true, '全集同样需要剥离期末强平追加点');
  assert.strictEqual(r.archiveTruncation.cuts, 1);
  assert.ok(r.archiveTruncation.kept > 0 && r.archiveTruncation.rowsKept > 0, '必须真的写出截断归档');
  assert.match(r.note, /前缀一致性/);
  assert.match(r.note, /物理截断/, 'note 必须写明"物理截断归档"，否则读者会以为是窗口截断');
  assert.match(r.note, /日内信息泄露/, '必须披露"检不出什么"——否则读者会以为它是万能的');
  assert.strictEqual(r.backtests, 2, '1 次全集 + 1 次截断');
});

test('🔴 判读纪律：cut 早于晚上市 ⇒ 池子变小但路径不变，应判 causal（不得误报 inconclusive）', () => {
  const dir = makeArchive();
  const cut = dstr(200); // 2 只标的尚未上市
  const r = withArchive(dir, () => V.causalityCheck(MODEL(), { cuts: [cut], opts: { topN: 5 } }));
  assert.strictEqual(r.ok, true, r.error);
  const c = r.cuts[0];
  assert.strictEqual(c.universeShift, true, '该日池子必然小于全集');
  assert.ok(c.universeSize < r.fullUniverseSize);
  assert.strictEqual(c.mismatch, null, '尚未上市的标的在两个口径下都选不到 ⇒ 净值路径应一致');
  assert.strictEqual(r.verdict, 'causal', '路径一致就是因果，池子变小本身不构成告警');
});

test('🔴 判读纪律：cut 在"已上市但不足门槛"之间 ⇒ 池子变小且路径不同，应判 inconclusive 而非泄露', () => {
  const dir = makeArchive();
  const cut = dstr(340); // 晚上市标的已有 40 行（≥20 可选）但 <80 ⇒ 不在截断池子里
  const r = withArchive(dir, () => V.causalityCheck(MODEL(), { cuts: [cut], opts: { topN: 5 } }));
  assert.strictEqual(r.ok, true, r.error);
  const c = r.cuts[0];
  assert.strictEqual(c.universeShift, true);
  assert.ok(c.mismatch, '全集能选到"已有 40 行"的标的，截断池子选不到 ⇒ 路径必然不同');
  assert.strictEqual(r.verdict, 'inconclusive', '池子同时变化时不得当泄露报');
  assert.ok(r.flags.some((f) => /股票池变化/.test(f)), '必须显式说明是池子变化');
  assert.ok(!r.flags.some((f) => /疑似未来函数/.test(f)), '不得混报成泄露');
});

test('causalityCheck：可指定截断日期数组；日期非法时该点显式列入 skipped', () => {
  const dir = makeArchive();
  const r = withArchive(dir, () =>
    V.causalityCheck(MODEL(), { cuts: [dstr(400), '1900-01-01'], opts: { topN: 5 } }),
  );
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.cuts.length + r.skipped.length, 2, '每个请求的截断点都必须有结论（成功或显式跳过）');
  assert.ok(r.cuts.some((c) => c.cut === dstr(400)));
  const bad = r.skipped.find((s) => s.cut === '1900-01-01');
  assert.ok(bad, '样本不足的截断点必须显式列出而不是静默丢弃');
  assert.match(bad.reason, /不足|无法回测/);
  assert.strictEqual(r.pool.cutSelection, 'explicit', '显式指定时应如实标注');
});

// ── 🔴 cuts 是**外部输入**：这一组锁住两道必做的校验 ────────────
test('🔴 normalizeCuts：拒绝路径穿越形态的"日期"（截断点会被 join 进临时目录）', () => {
  for (const evil of ['../../etc', '..\\..\\x', '/abs/path', 'C:/win', '2024-01-01/../..', 'a/b']) {
    const r = V.normalizeCuts([evil]);
    assert.strictEqual(r.ok, false, `${evil} 必须被拒 —— 否则 writeTruncatedArchive 会写到临时目录之外`);
    assert.match(r.error, /YYYY-MM-DD/);
  }
  // 形态正确但语义非法的日期不在本校验职责内（由"该日无数据 ⇒ skipped"显式回报）
  assert.strictEqual(V.normalizeCuts(['2024-13-45']).ok, true, '形态合法即通过；语义由回测结果显式回报');
});

test('🔴 normalizeCuts：非字符串 / 空数组 / 超上限一律显式拒绝（不静默截断）', () => {
  assert.strictEqual(V.normalizeCuts([20240101]).ok, false, '数字日期不算合法（形态必须严格）');
  assert.strictEqual(V.normalizeCuts([null]).ok, false);
  assert.strictEqual(V.normalizeCuts([]).ok, false, '空数组必须拒绝（省略即用默认等分点）');
  assert.match(V.normalizeCuts([]).error, /不能为空/);

  const many = Array.from({ length: V.RULES.causalityMaxCuts + 3 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, '0')}`);
  const over = V.normalizeCuts(many);
  assert.strictEqual(over.ok, false, '超出上限必须拒绝 —— 静默截断会让调用方以为扫过了全部日期');
  assert.match(over.error, /最多/);
});

test('normalizeCuts：去重 + 升序（重复日期等于白跑一遍整份归档）', () => {
  const r = V.normalizeCuts(['2024-05-20', '2023-01-03', '2024-05-20', '2022-12-09']);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.cuts, ['2022-12-09', '2023-01-03', '2024-05-20']);
});

test('causalityCheck：cuts 传非数组非数字 → 显式拒绝（不静默回落到默认值）', () => {
  const dir = makeArchive();
  for (const bad of ['2024-01-01', {}, true, 0, -1, NaN]) {
    const r = withArchive(dir, () => V.causalityCheck(MODEL(), { cuts: bad, opts: { topN: 5 } }));
    assert.strictEqual(r.ok, false, `cuts=${JSON.stringify(bad)} 应被拒绝`);
    assert.match(r.error, /只接受/);
    assert.strictEqual(r.backtests, 0, '输入不合法时不应白跑任何回测');
  }
  // 合法的数字形态（自动取 N 个等分点）必须被接受
  const okNum = withArchive(dir, () => V.causalityCheck(MODEL(), { cuts: 1, opts: { topN: 5 } }));
  assert.strictEqual(okNum.ok, true, okNum.error);
  assert.strictEqual(okNum.pool.cutSelection, 'after-pool-stable');
});

test('causalityCheck：非法 cuts 在**模型也非法**时仍优先报输入问题（且不跑回测）', () => {
  const dir = makeArchive();
  const r = withArchive(dir, () =>
    V.causalityCheck({ schemaVersion: 1, name: '', factors: [], meta: {} }, { cuts: ['../evil'], opts: { topN: 5 } }),
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /YYYY-MM-DD/, '输入校验是纯校验，先于任何执行');
  assert.strictEqual(r.backtests, 0);
});

test('causalityCheck：显式 cuts 也会带上 as-of 池子信息（判读 inconclusive 需要它）', () => {
  const dir = makeArchive();
  const r = withArchive(dir, () => V.causalityCheck(MODEL(), { cuts: [dstr(400)], opts: { topN: 5 } }));
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.pool.cutSelection, 'explicit');
  assert.strictEqual(r.pool.stableFrom, ARCH_POOL_STABLE, '显式指定也应照算池子完整起点');
  assert.strictEqual(r.pool.error, null);
  assert.match(r.note, /显式指定/);
});

test('causalityCheck：全部截断点都无法评估时不得返回"通过"', () => {
  const dir = makeArchive();
  const r = withArchive(dir, () => V.causalityCheck(MODEL(), { cuts: ['1900-01-01'], opts: { topN: 5 } }));
  assert.strictEqual(r.ok, false, '一个点都没评估出来，不能算通过');
  assert.match(r.error, /无法回测|放宽/);
});

test('runValidation：causality 默认执行；skip 生效', () => {
  const dir = makeArchive();
  const withIt = withArchive(dir, () =>
    V.runValidation(MODEL(), { folds: 2, cuts: 1, skip: ['plateau'], opts: { topN: 5 } }),
  );
  assert.strictEqual(withIt.ok, true, withIt.error);
  assert.ok(withIt.checks.causality, '默认应包含因果性检验');
  assert.strictEqual(withIt.checks.causality.verdict, 'causal');

  const without = withArchive(dir, () =>
    V.runValidation(MODEL(), { folds: 2, skip: ['plateau', 'causality'], opts: { topN: 5 } }),
  );
  assert.strictEqual(without.checks.causality, undefined, 'skip 必须真的跳过');
});

test('🔴 独立性：causalityCheck 不得回写传入的 model', () => {
  const dir = makeArchive();
  const m = MODEL({ transforms: [{ type: 'zscore' }] });
  const snap = JSON.parse(JSON.stringify(m));
  const envBefore = process.env.LOCAL_HISTORY_DIR;
  withArchive(dir, () => V.causalityCheck(m, { cuts: 1, opts: { topN: 5 } }));
  assert.deepStrictEqual(m, snap, '验证回写了模型 ⇒ 不再是独立验证');
  assert.strictEqual(
    process.env.LOCAL_HISTORY_DIR,
    envBefore,
    'withArchive 退出后环境必须回到进入前的值（不得把临时归档留在进程里）',
  );
});

test('causalityCheck：归档在检验后必须还原（不得污染进程环境）', () => {
  const dir = makeArchive();
  withArchive(dir, () => {
    const saved = process.env.LOCAL_HISTORY_DIR;
    V.causalityCheck(MODEL(), { cuts: 1, opts: { topN: 5 } });
    assert.strictEqual(process.env.LOCAL_HISTORY_DIR, saved, 'LOCAL_HISTORY_DIR 必须在 finally 中还原');
    assert.strictEqual(runModel(MODEL(), { topN: 5 }).ok, true, '检验之后正常回测应不受影响');
  });
});

// ═══ 三、🔴 检出力（positive control）：必须真能抓到泄露 ═══════

test('🔴 无假阳性：六类干净模型在同一截断下前缀必须一致', () => {
  const dir = makeArchive();
  const cut = dstr(420); // 池子完整之后
  const cases = [
    ['单因子 mom20', MODEL()],
    ['反转 rev20', MODEL({ factors: [{ id: 'f', expr: 'rev20', weight: 1 }] })],
    ['表达式', MODEL({ factors: [{ id: 'f', expr: 'mom60 - mom20', weight: 1 }] })],
    ['多因子+反向权重', MODEL({ factors: [{ id: 'a', expr: 'mom20', weight: 1 }, { id: 'b', expr: 'vol20', weight: -0.5 }] })],
    ['winsorize+rank', MODEL({ transforms: [{ type: 'winsorize', args: { method: 'mad', n: 3 } }, { type: 'rank' }] })],
    ['过滤器 amount>0', MODEL({ filters: [{ type: 'field_range', field: 'amount', min: 0 }] })],
  ];
  for (const [label, m] of cases) {
    const full = withArchive(dir, () => runModel(m, { topN: 5, rawEquity: true }));
    assert.strictEqual(full.ok, true, `${label}: ${full.error}`);
    const dst = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'causality-one-')), cut);
    V.writeTruncatedArchive(dir, dst, cut);
    const seg = withArchive(dst, () => runModel(m, { topN: 5, endDate: cut, rawEquity: true }));
    assert.strictEqual(seg.ok, true, `${label}: ${seg.error}`);
    assert.strictEqual(seg.result.universeSize, full.result.universeSize, `${label}: 池子应一致`);
    const mm = prefixMismatch(full.result.equityFull, seg.result.equityFull);
    assert.strictEqual(mm, null, `${label} 不应有不一致（假阳性会让检验失去信任）：${JSON.stringify(mm)}`);
    fs.rmSync(path.dirname(dst), { recursive: true, force: true });
  }
});

test('writeTruncatedArchive：只保留 rows、其余字段原样；行内容不得被改写', () => {
  const dir = makeArchive();
  const cut = dstr(420);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causality-arch-'));
  try {
    const dst = path.join(root, cut);
    const built = V.writeTruncatedArchive(dir, dst, cut);
    const srcFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.strictEqual(built.kept, srcFiles.length, '合成归档全部标的在 cut 之前均有数据');
    assert.strictEqual(built.emptied, 0);
    assert.strictEqual(fs.readdirSync(dst).filter((f) => f.endsWith('.json')).length, built.kept);

    const fn = srcFiles[0];
    const doc = JSON.parse(fs.readFileSync(path.join(dst, fn), 'utf8'));
    const src = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8'));
    assert.ok(doc.code && doc.adjust, '顶层字段必须原样保留');
    assert.ok(doc.rows.every((r) => String(r.date) <= cut), '不得留下晚于 cut 的行');
    assert.deepStrictEqual(doc.rows, src.rows.filter((r) => String(r.date) <= cut), '截断≠改写：行必须逐字段相同');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('🔴 检出力对照：泄露截面（全样本标准差标准化）必须被物理截断检出（positive control）', () => {
  const dir = makeArchive();
  const cut = dstr(420);
  const cs = makeLeakyCrossSection();
  const full = withArchive(dir, () => runCS(cs));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causality-ctl-'));
  try {
    const dst = path.join(root, cut);
    V.writeTruncatedArchive(dir, dst, cut);
    const trunc = withArchive(dst, () => runCS(cs, { endDate: cut }));
    assert.strictEqual(
      trunc.universeSize,
      full.universeSize,
      '对照样本要求池子不变（否则分不清"泄露"与"池子变了"）',
    );
    const mm = prefixMismatch(full.equityFull, trunc.equityFull);
    assert.ok(
      mm,
      '泄露截面必须被检出 —— 若这里通过，说明整个因果性检验是"永远绿"的摆设，必须修检验本身',
    );
    assert.strictEqual(mm.reason, '净值不同');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('🔴 方法论锁：只传 endDate（归档不截断）**检不出**归档级泄露，物理截断才检出', () => {
  const dir = makeArchive();
  const cut = dstr(420);
  const cs = makeLeakyCrossSection();
  const full = withArchive(dir, () => runCS(cs));

  // ① 只传 endDate：universe（原始 rows）仍是全量 ⇒ 读了窗口外那几行的泄露**完全看不见**
  const winOnly = withArchive(dir, () => runCS(cs, { endDate: cut }));
  assert.strictEqual(
    prefixMismatch(full.equityFull, winOnly.equityFull),
    null,
    '归档未变时该泄露确实不可见 —— 这正是"只传 endDate 的因果性检验"永远返回通过的原因',
  );

  // ② 物理截断归档：被读的"未来行"不存在了 ⇒ 立刻现形
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causality-method-'));
  try {
    const dst = path.join(root, cut);
    V.writeTruncatedArchive(dir, dst, cut);
    const trunc = withArchive(dst, () => runCS(cs, { endDate: cut }));
    assert.ok(
      prefixMismatch(full.equityFull, trunc.equityFull),
      '物理截断归档后必须检出 —— 这条锁住 methodology：任何人把实现改回"只传 endDate"都会在这里变红',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('🔴 检出力对照：干净截面在物理截断下必须一致（negative control）', () => {
  const dir = makeArchive();
  const cut = dstr(420);
  const cs = makeCausalCrossSection();
  const full = withArchive(dir, () => runCS(cs));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causality-clean-'));
  try {
    const dst = path.join(root, cut);
    V.writeTruncatedArchive(dir, dst, cut);
    const trunc = withArchive(dst, () => runCS(cs, { endDate: cut }));
    assert.strictEqual(trunc.error, undefined);
    assert.strictEqual(
      prefixMismatch(full.equityFull, trunc.equityFull),
      null,
      '干净截面在物理截断下必须一致 —— 否则检验有假阳性',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('computePoolStableFrom：等于"最晚上市标的第 UNIVERSE_MIN_ROWS 行"的日期', () => {
  const dir = makeArchive();
  const p = V.computePoolStableFrom(dir, crosssect.UNIVERSE_MIN_ROWS);
  assert.strictEqual(p.poolStableFrom, ARCH_POOL_STABLE);
  assert.strictEqual(p.poolStocks, ARCH.stocks, '所有标的最终都 ≥ 门槛 ⇒ 都应计入');
  // 该日之前，as-of 池子必然小于全集（晚上市标的不够行）
  const earlier = V.computePoolStableFrom(dir, crosssect.UNIVERSE_MIN_ROWS);
  assert.ok(earlier.poolStableFrom > dstr(0));
});

// ═══ 四、真实归档冒烟（规模验证：合成归档代替不了） ═══════════

test('【真实归档】默认截断点取在池子完整之后，且逐点一致', (t) => {
  if (skipReal(t)) return;
  const r = V.causalityCheck(MODEL(), { cuts: 1, opts: { topN: 5 } });
  assert.strictEqual(r.ok, true, r.error);
  assert.match(String(r.pool.stableFrom), /^\d{4}-\d{2}-\d{2}$/);
  const c = r.cuts[0];
  assert.ok(c.cut >= r.pool.stableFrom);
  assert.strictEqual(c.universeShift, false, '默认截断点在池子完整之后 ⇒ 池子不应缩水');
  assert.strictEqual(c.mismatch, null);
  assert.strictEqual(r.verdict, 'causal');
  assert.ok(r.fullDailyPoints > 2000, '真实归档应覆盖十年量级的交易日');
  assert.ok(r.archiveTruncation.rowsKept > 100000, '截断归档应保有十万量级的数据行');
});

test('【真实归档】核心池按**全期**行数选定 ⇒ 早于池子完整起点的截断池子是子集（as-of 事实）', (t) => {
  if (skipReal(t)) return;
  // 只读归档、不回测：确认这条 as-of 偏差确实存在，且被如实暴露
  const pool = V.computePoolStableFrom(crosssect.resolveArchiveDir(), crosssect.UNIVERSE_MIN_ROWS);
  assert.ok(pool.poolStableFrom > '2015-01-05', '核心池在第一根 K 线时不可能已完整');
  assert.ok(pool.poolStocks > 100, '核心池应有上百只');
  assert.match(
    V.LIMITATIONS.join('\n'),
    /幸存者偏差/,
    '局限性里应保留幸存者偏差这一条（与"事后选池"一同构成样本选择面的披露）',
  );
});

// ═══ 五、源码契约：T-1 决策 / T 执行（日内泄露的唯一防线）═══

test('🔴 引擎源码契约：排名取 T-1 收盘、执行取 T 日开盘（不得改成当日）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'crosssect.cjs'), 'utf8');
  assert.match(src, /const prevDate = dates\[di - 1\];/, '排名依据必须是 T-1 日（前一交易日）');
  assert.match(
    src,
    /const cands = crossSection\(universe, rowIndex, prevDate\);/,
    '截面必须用 prevDate 计算 —— 用当日 date 就是"用当日收盘决定并当日成交"的日内未来函数',
  );
  assert.ok(
    !/crossSection\(universe, rowIndex, date\)/.test(src),
    '不得出现用当日 date 计算的截面（日内未来函数）',
  );
  assert.match(src, /priceAt\(code, date, 'open'/, '成交价必须取 T 日开盘（T-1 决定、T 执行）');
  assert.match(src, /priceAt\(code, prevDate, 'close'\)/, '涨跌停判定需 T-1 收盘价作为前收（交易所规则）');
});

test('🔴 局限性必须写明"日内信息泄露检不出"（披露纪律）', () => {
  assert.ok(
    V.LIMITATIONS.some((s) => /日内/.test(s) && /tick|时间戳/.test(s)),
    '日线归档检不出日内泄露 —— 这条局限必须在报告里常驻，否则读者会高估本套件的覆盖范围',
  );
  assert.strictEqual(typeof V.RULES.causalityCuts, 'number', '截断点数必须是具名阈值（随报告返回可复核）');
});

// ═══ 六、归档路径单一源 ═════════════════════════════════════

test('归档路径单一源：resolveArchiveDir 是唯一拼接点，且受 LOCAL_HISTORY_DIR 覆盖', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'crosssect.cjs'), 'utf8');
  const dup = (src.match(/process\.env\.LOCAL_HISTORY_DIR \|\| path\.join/g) || []).length;
  assert.strictEqual(dup, 1, `归档路径拼接应只剩 resolveArchiveDir 一处，实际 ${dup} 处（多处拼接必分叉）`);
  const saved = process.env.LOCAL_HISTORY_DIR;
  try {
    process.env.LOCAL_HISTORY_DIR = 'X:/tmp/xxx';
    assert.strictEqual(crosssect.resolveArchiveDir(), 'X:/tmp/xxx', '应受环境变量覆盖（因果性检验靠它切数据源）');
  } finally {
    if (saved === undefined) delete process.env.LOCAL_HISTORY_DIR;
    else process.env.LOCAL_HISTORY_DIR = saved;
  }
});
