// ─────────────────────────────────────────────────────────────
// 模型实验记录单测（Phase 1 第六刀）
//
//   两条主线：
//     ① 快照语义：「不可变留痕 + 复现承诺」——记录了就必须能拿回当时的模型与参数。
//     ② 跨栈兼容：前端对比逻辑（shared/experiments.cjs 的 paramKeyUnion/diffParams/
//        nextSelection）只认**扁平 params** 与 **ts 唯一键**，本模块产出的记录必须满足，
//        否则前端对比表会静默变成一堆 undefined（TS 不报错，UI 全空）。
// ─────────────────────────────────────────────────────────────
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'modelexp-test-'));
process.env.MODEL_EXP_DIR = TMP;
process.env.MODEL_EXP_QUOTA = '3'; // 小配额，便于验证"淘汰最旧"
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert');

const mx = require('../server/modelexperiments.cjs');
const shared = require('../shared/experiments.cjs');

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const baseResult = (over = {}) => ({
  totalReturn: 12.5,
  annualized: 8.1,
  maxDrawdownPct: -9.3,
  sharpe: 1.2,
  benchmarkReturn: 5,
  rebalances: 12,
  fills: 40,
  totalFees: 800,
  feeRatePct: 0.08,
  range: { start: '2024-01-01', end: '2025-01-01', bars: 240 },
  universeSize: 200,
  ic: { icMean: 0.03, icir: 0.4, icPositiveRate: 0.55, n: 12 },
  equity: Array.from({ length: 300 }, (_, i) => ({ date: `2024-01-${i}`, value: 1 + i / 1000 })),
  benchmark: Array.from({ length: 300 }, (_, i) => ({ date: `2024-01-${i}`, value: 1 + i / 2000 })),
  ...over,
});

const payload = (name = '单测模型', over = {}) => ({
  model: {
    schemaVersion: 1,
    name,
    factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: 1 }],
    transforms: [{ type: 'zscore' }],
    filters: [{ type: 'field_range', field: 'amount', min: 0 }],
    universe: { type: 'core_pool' },
    backtest: { rebalance: 'monthly', groups: 5, fees: true },
    meta: { author: 'tester' },
  },
  plan: {
    factors: [{ id: 'f1', expr: 'mom20', weight: 1, direction: 1 }],
    transforms: [{ type: 'zscore', args: {} }],
    filters: [{ type: 'field_range', field: 'amount', min: 0 }],
    combine: 'weighted_sum',
  },
  fingerprint: 'a'.repeat(64),
  engineVersion: 'crosssect-m1.0',
  modelHash: 'b'.repeat(64),
  result: baseResult(),
  ...over,
});

// ── 1. 快照语义 ───────────────────────────────────────────────
test('toRecord：字段齐备（ts/id/modelHash/fingerprint/params/metrics/modelSnapshot）', async () => {
  const r = await mx.record('sem_user', payload('快照校验'));
  assert.strictEqual(r.ok, true, r.error);
  const doc = await mx.get(r.id, 'sem_user');

  for (const k of ['id', 'ts', 'uid', 'modelName', 'modelHash', 'fingerprint', 'engineVersion', 'params', 'metrics', 'modelSnapshot', 'range']) {
    assert.ok(k in doc, `记录缺字段 ${k}`);
  }
  assert.match(doc.id, mx.ID_RE);
  assert.strictEqual(mx.ID_RE.test(`${doc.id}x`), false, 'id 形状必须严格（防构造型路径穿越）');
  assert.strictEqual(doc.modelName, '快照校验');
  assert.strictEqual(doc.modelHash, 'b'.repeat(64), 'modelHash 必须原样落库（调用方传入）');
  assert.strictEqual(doc.modelSnapshot.name, '快照校验', '必须存模型快照，否则"载入该实验的模型"不可实现');
  assert.ok(Array.isArray(doc.modelSnapshot.factors));
  assert.ok(doc.ts && !Number.isNaN(Date.parse(doc.ts)), 'ts 必须是可解析的 ISO 时间（前端 recKey 依赖它）');
});

test('toRecord：超额收益 = 总收益 − 等权基准；基准缺失时为 null（不伪造 0）', async () => {
  const a = await mx.record('ov_user', payload('超额', { result: baseResult({ totalReturn: 12.5, benchmarkReturn: 5 }) }));
  const da = await mx.get(a.id, 'ov_user');
  assert.strictEqual(da.metrics.excessReturn, 7.5);

  const b = await mx.record('ov_user', payload('无基准', { result: baseResult({ totalReturn: 12.5, benchmarkReturn: null }) }));
  const db = await mx.get(b.id, 'ov_user');
  assert.strictEqual(db.metrics.excessReturn, null, '基准缺失时不得算成 +12.5 或 0');
});

test('toRecord：净值与基准曲线降采样且保留首末（防存储膨胀）', async () => {
  const r = await mx.record('thumb_user', payload('缩略'));
  const d = await mx.get(r.id, 'thumb_user');
  assert.strictEqual(d.equityThumb.length, mx.THUMB_POINTS);
  assert.strictEqual(d.equityThumb[0].d, '2024-01-0');
  assert.strictEqual(d.equityThumb[d.equityThumb.length - 1].d, '2024-01-299', '必须保留末点');
  assert.ok(d.equityThumb.every((p) => 'd' in p && 'v' in p), '缩略点形状必须是 {d,v}');
});

test('downsample：短序列原样返回、空序列返回 undefined', () => {
  assert.strictEqual(mx.downsample([]), undefined);
  assert.strictEqual(mx.downsample(undefined), undefined);
  const short = mx.downsample([{ date: 'd1', value: 1 }, { date: 'd2', value: 2 }]);
  assert.deepStrictEqual(short, [{ d: 'd1', v: 1 }, { d: 'd2', v: 2 }]);
});

// ── 2. 跨栈兼容（前端对比逻辑的接口锁）────────────────────────
test('flatParams：必须**扁平**（值只能是 string/number/boolean/undefined）', () => {
  const p = mx.flatParams(payload().plan, payload().model, baseResult());
  for (const [k, v] of Object.entries(p)) {
    const ok = v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
    assert.ok(ok, `params.${k} 不是扁平值（${typeof v}）—— paramKeyUnion/diffParams 只做一层 Object.keys`);
  }
  assert.ok('factors' in p && 'transforms' in p && 'rebalance' in p && 'topN' in p);
});

test('兼容锁：本模块产出的记录可直接喂给 shared/experiments.cjs 的纯函数', async () => {
  const a = await mx.record('compat_user', payload('兼容 A', { result: baseResult({ totalReturn: 10 }) }));
  const b = await mx.record('compat_user', payload('兼容 B', { result: baseResult({ totalReturn: 20 }) }));
  const recs = await mx.getMany([a.id, b.id], 'compat_user');
  assert.strictEqual(recs.length, 2);

  // recKey 取 ts；nextSelection 用它在"已选集合"里增删
  const keys = recs.map(shared.recKey);
  assert.ok(keys.every((k) => typeof k === 'string' && k), 'recKey 必须返回非空字符串');
  assert.strictEqual(new Set(keys).size, 2, '两条记录的键必须不同（否则勾选逻辑会串）');

  const sel = shared.nextSelection([], recs[0]);
  assert.deepStrictEqual(sel.next, [shared.recKey(recs[0])]);
  assert.strictEqual(sel.warn, '');

  // 上限拦截：MAX_COMPARE 条之后再加 → 原样返回并给出可见提示（不静默丢）
  let cur = [];
  for (let i = 0; i < shared.MAX_COMPARE; i++) cur = shared.nextSelection(cur, { ts: `k${i}` }).next;
  const over = shared.nextSelection(cur, { ts: 'k-over' });
  assert.strictEqual(over.next.length, shared.MAX_COMPARE);
  assert.match(over.warn, /最多对比/);

  // 参数差异：两条记录只有 totalReturn 不同（params 完全一致）⇒ 不应误报差异
  const d = shared.diffParams(recs);
  assert.deepStrictEqual(d.differing, [], `params 相同却被判为差异：${d.differing.join(',')}`);
  assert.ok(d.identical.length > 0);
});

test('兼容锁：params 真正变化时能被 diffParams 识别为 differing', async () => {
  const a = await mx.record('diff_user', payload('差异 A'));
  const b = await mx.record('diff_user', payload('差异 B', {
    model: { ...payload().model, backtest: { rebalance: 'weekly', groups: 10, fees: true } },
  }));
  const recs = await mx.getMany([a.id, b.id], 'diff_user');
  const d = shared.diffParams(recs);
  assert.ok(d.differing.includes('rebalance'), '改调仓周期必须被判为差异');
  assert.ok(d.differing.includes('groups'), '改分组数必须被判为差异');
});

// ── 3. 所有权与配额 ──────────────────────────────────────────
test('所有权：他人读不到 / 删不掉（一律按不存在处理）', async () => {
  const r = await mx.record('owner_a', payload('A 的'));
  assert.strictEqual(await mx.get(r.id, 'owner_b'), null);
  const del = await mx.remove(r.id, 'owner_b');
  assert.strictEqual(del.removed, false);
  assert.ok(await mx.get(r.id, 'owner_a'), 'A 的数据必须没被 B 动过');

  const listB = await mx.list('owner_b');
  assert.deepStrictEqual(listB, []);
  const listA = await mx.list('owner_a');
  assert.strictEqual(listA.length, 1);
  assert.strictEqual(listA[0].id, r.id);
  // 列表行须带前端列表页要显示的指标（免解正文）
  for (const k of ['id', 'ts', 'modelName', 'fingerprint', 'totalReturn', 'excessReturn', 'maxDrawdownPct', 'sharpe']) {
    assert.ok(k in listA[0], `索引行缺字段 ${k}`);
  }
});

test('配额：超过 MODEL_EXP_QUOTA 时淘汰本 uid 最旧记录并显式回报 evicted', async () => {
  assert.strictEqual(mx.QUOTA_PER_UID, 3);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await mx.record('quota_user', payload(`配额 ${i}`));
    assert.strictEqual(r.evicted, 0, '未超限不应淘汰');
    ids.push(r.id);
    await new Promise((res) => setTimeout(res, 2)); // 保证 ts 单调递增，顺序确定
  }
  const over = await mx.record('quota_user', payload('配额 溢出'));
  assert.strictEqual(over.ok, true);
  assert.ok(over.evicted > 0, '超限必须淘汰并如实回报，不得静默丢弃新记录');

  const list = await mx.list('quota_user');
  assert.ok(list.length <= mx.QUOTA_PER_UID, `配额失效：${list.length} > ${mx.QUOTA_PER_UID}`);
  assert.strictEqual(list[0].id, over.id, '最新一条必须在最前');
  const remaining = new Set(list.map((x) => x.id));
  assert.ok(!remaining.has(ids[0]), '最旧的一条应被淘汰');

  // 淘汰只针对本 uid
  const other = await mx.record('quota_other', payload('别人'));
  assert.ok(await mx.get(other.id, 'quota_other'), '不得动其他 uid 的数据');
});

test('体积上限：畸形超大记录被显式拒绝（返回 ok:false，不落盘）', async () => {
  const huge = payload('超大', { model: { schemaVersion: 1, name: 'x'.repeat(300 * 1024), factors: [] } });
  const r = await mx.record('huge_user', huge);
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error), /体积超限/);
  assert.deepStrictEqual(await mx.list('huge_user'), [], '被拒绝的记录不得出现在索引里');
});

test('remove：非法 id → ok:false；不存在 → removed:false', async () => {
  const bad = await mx.remove('bad-id', 'rm_user');
  assert.strictEqual(bad.ok, false);
  const gone = await mx.remove('x-20260101-zzzzzz', 'rm_user');
  assert.strictEqual(gone.ok, true);
  assert.strictEqual(gone.removed, false);
});
