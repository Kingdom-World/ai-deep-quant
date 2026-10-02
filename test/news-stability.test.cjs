const test = require('node:test');
const assert = require('node:assert/strict');
const sources = require('../server/news/sources.cjs');
const newsEngine = require('../server/news/index.cjs');

// ───────── withSource 熔断语义（专用测试键，避免污染真实源健康表） ─────────

test('withSource：loader 成功时透传返回值', async () => {
  const r = await sources.withSource('test-ok', async () => [1, 2, 3]);
  assert.deepEqual(r, [1, 2, 3]);
});

test('withSource：loader 失败时返回 fallback 且不抛出', async () => {
  const r = await sources.withSource('test-fail', async () => {
    throw new Error('boom');
  }, ['fb']);
  assert.deepEqual(r, ['fb']);
});

test('withSource：连续 3 次失败触发熔断，之后短路不再调用 loader', async () => {
  const name = 'test-circuit';
  const calls = { n: 0 };
  const badLoader = async () => {
    calls.n += 1;
    throw new Error('always down');
  };
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await sources.withSource(name, badLoader, []);
    assert.deepEqual(r, []);
  }
  assert.equal(calls.n, 3);
  assert.equal(sources.isDisabled(name), true, '连续 3 次失败后应熔断');
  // 熔断窗口内：loader 完全不被调用
  const r = await sources.withSource(name, badLoader, ['cached']);
  assert.deepEqual(r, ['cached']);
  assert.equal(calls.n, 3, '熔断期内 loader 不应被再次调用');
});

// ───────── 裸源包装后的入参守卫（无网络路径） ─────────

test('fetchEmSearch：空关键词直接返回空数组，不触网', async () => {
  assert.deepEqual(await sources.fetchEmSearch(''), []);
  assert.deepEqual(await sources.fetchEmSearch(null), []);
});

test('fetchEmStockNews：非法证券代码直接返回空数组，不触网', async () => {
  assert.deepEqual(await sources.fetchEmStockNews('abc'), []);
  assert.deepEqual(await sources.fetchEmStockNews(''), []);
});

test('fetchMarketFlash：pages=0 返回空数组', async () => {
  assert.deepEqual(await sources.fetchMarketFlash(0, 100), []);
});

// ───────── 编排层 allSettled 聚合：单源拒绝不拖垮整体 ─────────

test('settleSources：fulfilled 透传、rejected 记空数组，顺序保持', () => {
  const settled = [
    { status: 'fulfilled', value: ['a'] },
    { status: 'rejected', reason: new Error('sina down') },
    { status: 'fulfilled', value: ['b', 'c'] },
  ];
  const out = newsEngine.settleSources(settled, 'unit');
  assert.deepEqual(out, [['a'], [], ['b', 'c']]);
});
