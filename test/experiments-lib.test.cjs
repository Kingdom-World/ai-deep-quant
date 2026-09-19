// ─────────────────────────────────────────────────────────────
// 实验对比纯函数测试（S 合并 · 红队建议）
//   锁死「多选对比」的三条边界：上限拦截可见不静默 / 参数缺失即视为不同 /
//   取值相同必须折叠——这是合并后最容易错、又最难靠手工点检覆盖的逻辑。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const { recKey, nextSelection, paramKeyUnion, diffParams, MAX_COMPARE } = require('../shared/experiments.mjs');

const rec = (ts, params = {}) => ({ ts, params });

test('recKey 以 ts 为唯一键', () => {
  assert.equal(recKey(rec('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00Z');
});

test('nextSelection：未达上限时正常加入', () => {
  const r = nextSelection([], rec('a'));
  assert.deepEqual(r.next, ['a']);
  assert.equal(r.warn, '');
});

test('nextSelection：重复点击同一记录 = 取消勾选', () => {
  const r = nextSelection(['a', 'b'], rec('a'));
  assert.deepEqual(r.next, ['b']);
  assert.equal(r.warn, '');
});

test('nextSelection：达到上限时拦截并给出可见提示（非静默）', () => {
  const full = ['a', 'b', 'c', 'd'];
  const r = nextSelection(full, rec('e'), MAX_COMPARE);
  assert.deepEqual(r.next, full, '不新增');
  assert.ok(r.warn.includes(`最多对比 ${MAX_COMPARE} 条`));
  assert.ok(r.warn.includes('先取消勾选'));
});

test('nextSelection：自定义上限生效', () => {
  const r = nextSelection(['a'], rec('b'), 1);
  assert.deepEqual(r.next, ['a']);
  assert.ok(r.warn.includes('最多对比 1 条'));
});

test('paramKeyUnion：并集保持首次出现顺序', () => {
  const u = paramKeyUnion([rec('a', { fast: 5, slow: 20 }), rec('b', { slow: 30, capital: 100 })]);
  assert.deepEqual(u, ['fast', 'slow', 'capital']);
});

test('diffParams：取值不同 → differing；取值一致 → identical 折叠', () => {
  const r = diffParams([
    rec('a', { fast: 5, slow: 20, market: 'CN' }),
    rec('b', { fast: 10, slow: 20, market: 'CN' }),
  ]);
  assert.deepEqual(r.differing, ['fast']);
  assert.deepEqual(r.identical, [
    { key: 'slow', value: 20 },
    { key: 'market', value: 'CN' },
  ]);
});

test('diffParams：任一实验缺失该参数 → 判为不同（不得静默折叠）', () => {
  const r = diffParams([rec('a', { fast: 5, slow: 20 }), rec('b', { slow: 20 })]);
  assert.deepEqual(r.differing, ['fast'], '缺失键必须进 differing');
});

test('diffParams：空记录集 → 无差异', () => {
  const r = diffParams([]);
  assert.deepEqual(r.differing, []);
  assert.deepEqual(r.identical, []);
});

test('diffParams：JSON 序列化判定对象取值（数组/对象参数）', () => {
  const r = diffParams([rec('a', { combo: ['ma', 'rsi'] }), rec('b', { combo: ['ma', 'rsi'] })]);
  assert.deepEqual(r.differing, []);
  assert.equal(r.identical[0].key, 'combo');
});
