// ─────────────────────────────────────────────────────────────
// maybeRunMatcher（Vercel 惰性撮合，P1/D3）单元测试
//   覆盖：① 无挂单零成本跳过；② GFD 到期挂单触发撮合并撤销；
//   ③ 真正跑过后进入 60s 节流窗口（窗口内重复请求跳过）。
//   用「昨天的 validUntil」走 GFD 撤销路径 —— 不碰行情网络，纯本地可跑。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离数据目录 + 确保无 DB（测试进程不加载 .env，但显式清掉更稳）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lazy-test-'));
process.env.PAPER_DATA_DIR = TMP;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.DATABASE_URL_UNPOOLED;

const broker = require('../server/paper/broker.cjs');
const store = broker.store;

/** 造一个昨天的 GFD 限价单（resting） */
function expiredGfdOrder(id) {
  const d = new Date(Date.now() - 24 * 3600_000);
  return {
    id,
    symbol: 'sh600000',
    name: '浦发银行',
    side: 'buy',
    type: 'limit',
    qty: 100,
    limitPrice: 10,
    status: 'resting',
    validUntil: d.toISOString().slice(0, 10), // 昨天 ⇒ 惰性撮合应触发 GFD 到期撤销
    createdAt: d.toISOString(),
  };
}

test('maybeRunMatcher：无挂单零成本跳过（不触发 runMatcher）', async () => {
  const r = await broker.maybeRunMatcher('nobody-uid');
  assert.equal(r.skipped, true);
  assert.match(r.reason, /无 resting 挂单/);
});

test('maybeRunMatcher：GFD 到期挂单 ⇒ 真正跑撮合并撤销过期单', async () => {
  const uid = 'lazy-u1';
  store.ensureAccount(uid);
  store.state.orders[uid].push(expiredGfdOrder('LZ1'));
  const r = await broker.maybeRunMatcher(uid);
  assert.equal(r.skipped, undefined, '存在 resting 挂单 ⇒ 不应被跳过');
  const o = store.state.orders[uid].find((x) => x.id === 'LZ1');
  assert.equal(o.status, 'canceled', '过期 GFD 单应被惰性撮合撤销');
  assert.match(o.reason || '', /GFD/);
  clearInterval(broker.store.timer);
});

test('maybeRunMatcher：跑过后进入 60s 节流，窗口内重复请求跳过', async () => {
  const uid = 'lazy-u2';
  store.ensureAccount(uid);
  store.state.orders[uid].push(expiredGfdOrder('LZ2'));
  const r1 = await broker.maybeRunMatcher(uid);
  assert.equal(r1.skipped, undefined, '首次请求应真正执行');
  const r2 = await broker.maybeRunMatcher(uid);
  assert.equal(r2.skipped, true, '60s 窗口内第二次请求应被节流');
  assert.match(r2.reason, /节流/);
  clearInterval(broker.store.timer);
});
