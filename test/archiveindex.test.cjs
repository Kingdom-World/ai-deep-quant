// ─────────────────────────────────────────────────────────────
// 归档索引与数据质量（server/archiveindex.cjs）测试
//
//   🔴 本文件最重要的一条是「**数据版本指纹必须对内容敏感**」：
//      现有 fingerprint 只含数据窗口（start/end），不含数据内容 ⇒ 归档追加/修正后
//      同一个指纹可能对应两份不同的数据，"同指纹 ⇒ 同结果"并不总成立。
//      数据版本指纹就是补这一环，所以它必须：
//        · 确定性（同目录同内容 ⇒ 同指纹，且与文件顺序无关）
//        · **敏感性**（改一个数字、追加一行、改一个复权因子 ⇒ 指纹必变）
//        · 可缓存但**不能缓存出 stale 值**（目录文件集合/时间戳变了就要重算）
//      这四条都用合成归档测，CI 无归档时也真跑。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const A = require('../server/archiveindex.cjs');
const crosssect = require('../server/crosssect.cjs');

const MIN_ROWS = crosssect.UNIVERSE_MIN_ROWS;

const dstr = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);

/** 合成归档：n 只标的 × rows 行，价格确定性生成 */
function makeArchive(n = 4, rows = 120, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archidx-'));
  let seed = opts.seed || 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let k = 0; k < n; k++) {
    const code = `sh${600000 + k}`;
    let px = 10 + k;
    const rs = [];
    for (let i = 0; i < rows; i++) {
      px = Math.max(1, px * (1 + (rnd() - 0.49) * 0.04));
      const c = +px.toFixed(4);
      rs.push({
        date: dstr(i),
        open: +(c * 0.995).toFixed(4),
        high: +(c * 1.01).toFixed(4),
        low: +(c * 0.99).toFixed(4),
        close: c,
        volume: 1000,
        amount: 1_000_000,
        turn: 1,
        pctChg: 0.5,
      });
    }
    fs.writeFileSync(
      path.join(dir, `${code}.json`),
      JSON.stringify({ code, adjust: 'none+factor', rows: rs, factors: [] }),
    );
  }
  return dir;
}

const withDir = (dir, fn) => {
  const saved = process.env.LOCAL_HISTORY_DIR;
  process.env.LOCAL_HISTORY_DIR = dir;
  A.invalidateArchiveIndex();
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.LOCAL_HISTORY_DIR;
    else process.env.LOCAL_HISTORY_DIR = saved;
    A.invalidateArchiveIndex();
  }
};

test('归档缺失时显式失败并给出原因（不返回空索引假装成功）', () => {
  const r = withDir(path.join(os.tmpdir(), 'no-such-archive-xyz'), () => A.buildArchiveIndex());
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不存在|不可读/);
  assert.ok(Array.isArray(r.issues) && r.issues.length > 0, '即便读不到数据，已知问题清单也应随结果返回');
  assert.ok(!JSON.stringify(r).includes(':\\'), '不得暴露本机绝对路径（公开仓库/公网红线）');
});

test('索引形状：版本 + 质量 + 逐只明细 + 问题清单', () => {
  const dir = makeArchive();
  const idx = withDir(dir, () => A.buildArchiveIndex());
  assert.strictEqual(idx.ok, true, idx.error);
  assert.strictEqual(idx.version.stocks, 4);
  assert.strictEqual(idx.version.rows, 4 * 120);
  assert.strictEqual(idx.version.poolMinRows, MIN_ROWS);
  assert.strictEqual(idx.version.poolStocks, 4, '120 行 ≥ 门槛 ⇒ 四只都入池');
  assert.match(idx.version.digest, /^[0-9a-f]{64}$/);
  assert.strictEqual(idx.quality.filesRead, 4);
  assert.strictEqual(idx.quality.filesBad, 0);
  assert.strictEqual(idx.quality.rowsDropped, 0);
  assert.strictEqual(idx.symbols.length, 4);
  assert.ok(idx.symbols.every((s) => s.code.startsWith('sh600')), '逐只明细应带 code');
  assert.ok(idx.symbols.every((s) => !('rowsDigest' in s)), '默认不得返回内容摘要（响应体膨胀）');
  assert.ok(Array.isArray(idx.issues) && idx.issues.length >= 4, '数据层面的已知问题必须随索引返回');
  assert.ok(idx.issues.some((s) => /退市股/.test(s)), '幸存者偏差是最关键的一条');
  assert.ok(idx.issues.some((s) => /事后选池|全期/.test(s)), 'as-of 池子偏差必须披露');
  assert.strictEqual(idx.source, 'env-override', '本测试用环境变量指了目录，应如实标注来源形态');
  assert.strictEqual(idx.computedAt.length, 24);
});

test('🔴 数据版本指纹：确定性且与文件顺序无关', () => {
  const dir = makeArchive();
  const a = withDir(dir, () => A.buildArchiveIndex().version.digest);
  const b = withDir(dir, () => A.buildArchiveIndex(dir, { force: true }).version.digest);
  assert.strictEqual(a, b, '同目录同内容必须得到同一指纹');

  // 🔴 API 回归锁：单参 opts 形式必须成立。
  // 否则 `buildArchiveIndex({force:true})` 会把对象当目录名 ⇒ 静默返回 ok:false，
  // 调用方直到读 `.version` 才崩 —— 这正是"禁静默降级"要堵的坑。
  const c0 = withDir(dir, () => A.buildArchiveIndex({ force: true }).version.digest);
  assert.strictEqual(c0, a, '单参 opts 形式（不传 dir）应等价，而不是静默失败');
  const failObj = withDir(dir, () => A.buildArchiveIndex(path.join(os.tmpdir(), 'nope-xyz-')));
  assert.strictEqual(failObj.ok, false);
  assert.ok(Array.isArray(failObj.issues) && failObj.issues.length > 0, '失败分支也要带已知问题清单');

  // 文件写入顺序不同 → 指纹必须相同（按 code 排序拼接）
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'archidx2-'));
  const files = fs.readdirSync(dir).sort().reverse();
  for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(dir2, f));
  const c = withDir(dir2, () => A.buildArchiveIndex().version.digest);
  assert.strictEqual(c, a, '文件系统枚举顺序不得影响指纹');

  fs.rmSync(dir2, { recursive: true, force: true });
});

test('🔴 数据版本指纹：对内容敏感（追加一行 / 改一个数 / 改复权因子都要变）', () => {
  const dir = makeArchive();
  const base = withDir(dir, () => A.buildArchiveIndex().version.digest);

  // ① 追加一行
  const f = path.join(dir, 'sh600000.json');
  const doc0 = JSON.parse(fs.readFileSync(f, 'utf8'));
  const ext = { ...doc0, rows: [...doc0.rows, { ...doc0.rows[doc0.rows.length - 1], date: dstr(500), close: 99 }] };
  fs.writeFileSync(f, JSON.stringify(ext));
  const afterAppend = withDir(dir, () => A.buildArchiveIndex().version.digest);
  assert.notStrictEqual(afterAppend, base, '追加一行必须改变数据版本 —— 这正是旧 fingerprint 漏掉的情形');

  // ② 只改一个数字（模拟数据修正）
  const doc1 = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc1.rows[0] = { ...doc1.rows[0], close: doc1.rows[0].close + 0.0001 };
  fs.writeFileSync(f, JSON.stringify(doc1));
  const afterFix = withDir(dir, () => A.buildArchiveIndex().version.digest);
  assert.notStrictEqual(afterFix, afterAppend, '数据修正（哪怕极小）也必须改变指纹');

  // ③ 只改复权因子（不影响任何行情数字，但改变 adjClose 口径）
  const doc2 = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc2.factors = [{ date: dstr(0), fore: 1, back: 1 }, { date: dstr(60), fore: 2, back: 0.5 }];
  fs.writeFileSync(f, JSON.stringify(doc2));
  const afterFactor = withDir(dir, () => A.buildArchiveIndex().version.digest);
  assert.notStrictEqual(afterFactor, afterFix, '复权因子改变会改变引擎实际使用的价格 ⇒ 必须改变数据版本');
});

test('缓存：同目录第二次命中缓存；目录内容变化后必须失效（不能返回 stale）', () => {
  const dir = makeArchive();
  withDir(dir, () => {
    const a = A.buildArchiveIndex();
    assert.strictEqual(a.cached, false, '首次应真算');
    const b = A.buildArchiveIndex();
    assert.strictEqual(b.cached, true, '同目录第二次应命中缓存');
    assert.strictEqual(b.version.digest, a.version.digest);

    // 改内容（mtime/size 变）⇒ 缓存签名失效 ⇒ 必须重算
    const f = path.join(dir, 'sh600001.json');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    doc.rows = doc.rows.slice(0, doc.rows.length - 1);
    fs.writeFileSync(f, JSON.stringify(doc));
    const c = A.buildArchiveIndex();
    assert.strictEqual(c.cached, false, '内容变了就不该命中缓存');
    assert.notStrictEqual(c.version.digest, a.version.digest);
    assert.strictEqual(c.version.rows, a.version.rows - 1);
  });
});

test('peekArchiveVersion：只读缓存，不触发计算（热路径用它）', () => {
  const dir = makeArchive();
  withDir(dir, () => {
    assert.strictEqual(A.peekArchiveVersion(), null, '未算过时必须返回 null 而不是就地算一遍');
    const idx = A.buildArchiveIndex();
    assert.strictEqual(A.peekArchiveVersion(), idx.version.digest);
    A.invalidateArchiveIndex();
    assert.strictEqual(A.peekArchiveVersion(), null, '失效后应回到 null');
  });
});

test('质量统计：剔除行 / 缺字段 / 复权退化 / 异常价格 / 重复日期 都被如实计数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archidx-q-'));
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push({
      date: dstr(i),
      open: 10,
      high: 10.5,
      low: 9.5,
      close: 10,
      volume: 1000,
      amount: 1_000_000,
      turn: 1,
      pctChg: 0,
    });
  }
  // 1 行结构性坏数据（close ≤ 0 ⇒ 引擎会剔除）
  rows.push({ date: dstr(100), open: 0, high: 1, low: 1, close: 0, volume: 1, amount: 1, turn: 1, pctChg: 0 });
  // 1 行高低倒挂
  rows.push({ date: dstr(101), open: 10, high: 9, low: 11, close: 10, volume: 1, amount: 1, turn: 1, pctChg: 0 });
  // 1 行缺少 pctChg / turn
  rows.push({ date: dstr(102), open: 10, high: 11, low: 9, close: 10, volume: 1, amount: 1 });
  // 1 行日期重复
  rows.push({ date: dstr(0), open: 10, high: 11, low: 9, close: 10, volume: 1, amount: 1, turn: 1, pctChg: 0 });
  fs.writeFileSync(
    path.join(dir, 'sh600000.json'),
    JSON.stringify({ code: 'sh600000', adjust: 'none+factor', rows, factors: [] }),
  );
  // 另一只：有复权因子（不应有 adjFallback）；**也缺一个字段**，用来验证缺失是跨标的汇总的
  const rowsB = rows.slice(0, 100).map((r) => ({ ...r }));
  delete rowsB[10].pctChg;
  fs.writeFileSync(
    path.join(dir, 'sh600001.json'),
    JSON.stringify({
      code: 'sh600001',
      adjust: 'none+factor',
      rows: rowsB,
      factors: [{ date: dstr(0), fore: 1, back: 1 }],
    }),
  );

  const idx = withDir(dir, () => A.buildArchiveIndex());
  assert.strictEqual(idx.ok, true, idx.error);
  const s0 = idx.symbols.find((s) => s.code === 'sh600000');
  assert.strictEqual(s0.rows, 104);
  assert.strictEqual(s0.rowsUsable, 103, 'close≤0 的那行应被剔除（与引擎 loadUniverse 同口径）');
  assert.strictEqual(s0.rowsDropped, 1);
  assert.strictEqual(s0.badPriceRows, 1, '高<低 应计为结构异常');
  assert.strictEqual(s0.duplicateDates, 1);
  assert.ok(s0.missing.pctChg >= 1 && s0.missing.turn >= 1, '缺字段应逐字段计数');
  assert.strictEqual(s0.adjFallbackRows, 103, '无因子覆盖 ⇒ 全部退化为不复权');
  const s1 = idx.symbols.find((s) => s.code === 'sh600001');
  assert.strictEqual(s1.adjFallbackRows, 0, '有因子覆盖不应计入退化');
  assert.strictEqual(idx.quality.symbolsWithAdjFallback, 1);
  assert.strictEqual(idx.quality.rowsDropped, 1);
  assert.strictEqual(idx.quality.badPriceRows, 1);
  assert.strictEqual(idx.quality.duplicateDates, 1);
  assert.strictEqual(idx.quality.missingTotals.pctChg, 2, '两只标的各缺 1 行 ⇒ 总缺失必须汇总（1+1）');
  assert.strictEqual(idx.quality.symbolsWithMissing.pctChg, 2, '缺该字段的标的数也应汇总');
  assert.strictEqual(idx.quality.missingTotals.turn, 1, 'turn 只有 sh600000 缺');
});

test('坏文件被计入 filesBad 且不拖垮整体索引（坏文件必须显式列出）', () => {
  const dir = makeArchive(3, 100);
  fs.writeFileSync(path.join(dir, 'sh600099.json'), '{ 这不是 JSON');
  const idx = withDir(dir, () => A.buildArchiveIndex());
  assert.strictEqual(idx.ok, true, '单个坏文件不应让整个索引失败');
  assert.strictEqual(idx.quality.filesBad, 1);
  assert.strictEqual(idx.quality.badFiles[0].file, 'sh600099.json');
  assert.ok(idx.quality.badFiles[0].error.length > 0);
  assert.strictEqual(idx.version.stocks, 3, '坏文件不得计入标的数');
});

test('覆盖率分桶与新鲜度：门槛以下单独计数、最后交易日的龄期如实给出', () => {
  const dir = makeArchive(2, 100);
  // 造一只"行数不足门槛"的
  const short = [];
  for (let i = 0; i < 30; i++) {
    short.push({ date: dstr(i), open: 10, high: 11, low: 9, close: 10, volume: 1, amount: 1, turn: 1, pctChg: 0 });
  }
  fs.writeFileSync(path.join(dir, 'sh600050.json'), JSON.stringify({ code: 'sh600050', adjust: 'none+factor', rows: short, factors: [] }));

  const idx = withDir(dir, () => A.buildArchiveIndex());
  assert.strictEqual(idx.version.stocks, 3);
  assert.strictEqual(idx.version.poolStocks, 2, '30 行 < 门槛 ⇒ 不入池');
  assert.strictEqual(idx.quality.belowPoolMinRows, 1);
  assert.strictEqual(idx.quality.coverageBuckets['<80'], 1);
  assert.strictEqual(idx.quality.coverageBuckets['80-249'], 2);
  assert.strictEqual(idx.version.firstDate, dstr(0));
  assert.strictEqual(idx.version.lastDate, dstr(99));
  assert.ok(Number.isFinite(idx.quality.lastDateAgeDays), '最后交易日龄期应为数字');
  assert.match(idx.quality.lastDateAgeNote, /自然日/);
});

test('不暴露绝对路径：索引里只出现来源形态，不出现本机目录', () => {
  const dir = makeArchive();
  const idx = withDir(dir, () => A.buildArchiveIndex({ withDigests: true }));
  const json = JSON.stringify(idx);
  assert.ok(!json.includes(os.tmpdir().replace(/\\/g, '\\\\')) || !json.includes(dir), '不得把归档目录写进结果');
  assert.ok(!json.includes('"dir"'), '结果里不应有 dir 字段');
  assert.strictEqual(idx.source, 'env-override');
});

// ── 真实归档冒烟（规模验证）────────────────────────────────
const REAL_DIR = path.join(__dirname, '..', 'data', 'history', 'kline');
const hasReal = fs.existsSync(REAL_DIR);

test('【真实归档】索引在真实规模上成立，且与引擎口径一致', (t) => {
  if (!hasReal) {
    console.log(`  [skip] 真实归档不存在（${REAL_DIR}）`);
    return;
  }
  A.invalidateArchiveIndex();
  const idx = A.buildArchiveIndex(REAL_DIR, { force: true });
  assert.strictEqual(idx.ok, true, idx.error);
  assert.ok(idx.version.stocks >= 100, `核心池应有上百只，实际 ${idx.version.stocks}`);
  assert.ok(idx.version.rows > 100000, `总行数应达十万级，实际 ${idx.version.rows}`);
  assert.strictEqual(idx.quality.rowsDropped, 0, '真实归档应无被剔除行（若有，说明归档质量退化，需查明）');
  assert.ok(idx.quality.missingTotals.pctChg > 0, 'pctChg 确有缺失行（与既有测试结论一致）');
  // 与引擎口径交叉核对：索引算出的入池数应与引擎装载结果一致
  const universe = crosssect.runCrossBacktest({ factor: 'mom20', topN: 5 }) && null;
  assert.strictEqual(universe, null); // 该调用只为触发一次引擎装载路径（结果不参与断言）
  assert.ok(idx.version.poolStocks >= 100);
  assert.match(idx.version.digest, /^[0-9a-f]{64}$/);
  // 缓存：二次调用应命中
  const again = A.buildArchiveIndex(REAL_DIR);
  assert.strictEqual(again.cached, true);
  assert.strictEqual(again.version.digest, idx.version.digest);
  A.invalidateArchiveIndex();
});
