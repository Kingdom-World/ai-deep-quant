// ─────────────────────────────────────────────────────────────
// PaperStore 跨实例新鲜度（dirtyAt/refreshIfStale）单元测试
//   背景：2026-09-22 线上实测——批量编辑丢了 constructor 的 dirtyAt 初始化，
//   hydrate 对 undefined 赋值 → whenReady 拒绝 → /api/paper 全线 503。
//   本地无 DATABASE_URL 时镜像路径整体旁路，常规测试**测不到**这条链路
//   ⇒ 本文件用 mock db 强制走 DB 路径，把该回归锁死在 CI。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离数据目录（必须在 require store 之前设置：constructor 读环境变量）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-mirror-test-'));
process.env.PAPER_DATA_DIR = TMP;

// ── mock db：强制 hasDb()=true，按 SQL 形状返回假数据 ──
const db = require('../server/db.cjs');
const realHasDb = db.hasDb;
const seen = [];
db.hasDb = () => true;
db.ready = async () => {};
db.query = async (text) => {
  seen.push(String(text).replace(/\s+/g, ' '));
  if (/SELECT uid, data, updated_at FROM paper_state/.test(text)) {
    return {
      rows: [
        {
          uid: 'zhengwj',
          data: { accounts: { cash: 999 }, positions: [], orders: [{ id: 'X1' }], equity: [], dailyPnl: {} },
          updated_at: '2026-09-22T12:00:00Z',
        },
      ],
    };
  }
  if (/SELECT updated_at FROM paper_state WHERE uid/.test(text)) {
    // DB 时钟比 hydrate 时晚 ⇒ 判定"别的实例写过"
    return { rows: [{ updated_at: new Date(Date.now() + 60_000).toISOString() }] };
  }
  if (/SELECT data FROM paper_state WHERE uid/.test(text)) {
    return {
      rows: [{ data: { accounts: { cash: 777 }, positions: [], orders: [{ id: 'X2' }], equity: [], dailyPnl: {} } }],
    };
  }
  if (/INSERT INTO paper_state/.test(text)) {
    return { rows: [{ updated_at: new Date().toISOString() }] };
  }
  return { rows: [] };
};

const { PaperStore } = require('../server/paper/store.cjs');

test('mock-db 下 whenReady() 完整走通：hydrate 填充内存且 dirtyAt 被初始化（回归：dirtyAt 未初始化曾致全线 503）', async () => {
  const store = new PaperStore();
  try {
    const ok = await store.whenReady(); // hydrate 若炸会在这里抛出
    assert.equal(ok, true);
    assert.equal(store.state.accounts.zhengwj.cash, 999, 'hydrate 应把 DB 版本填进内存');
    assert.equal(store.state.orders.zhengwj[0].id, 'X1');
    assert.ok(store.dirtyAt && typeof store.dirtyAt.zhengwj === 'number', 'hydrate 后 dirtyAt 必须已初始化');
  } finally {
    clearInterval(store.timer);
  }
});

test('refreshIfStale：DB 更新 ⇒ 用 DB 版本覆盖内存并推进 dirtyAt；DB 不比本地新 ⇒ 不动内存', async () => {
  const store = new PaperStore();
  try {
    await store.whenReady();
    // ① DB 更新 ⇒ 刷新
    await store.refreshIfStale('zhengwj');
    assert.equal(store.state.accounts.zhengwj.cash, 777, '应被 DB 新版本覆盖');
    assert.equal(store.state.orders.zhengwj[0].id, 'X2');
    // ② 把 dirtyAt 推到未来 ⇒ DB 不比本地新 ⇒ 内存保持不变
    store.state.accounts.zhengwj.cash = 12345;
    store.dirtyAt.zhengwj = Date.now() + 3_600_000;
    await store.refreshIfStale('zhengwj');
    assert.equal(store.state.accounts.zhengwj.cash, 12345, '本地不落后时不得被覆盖');
    assert.ok(seen.some((s) => s.includes('SELECT updated_at')), '应发起过新鲜度 SELECT');
  } finally {
    clearInterval(store.timer);
  }
});

test('persistUid：单 uid UPSERT 带 RETURNING updated_at，dirtyAt 取数据库时钟（syncToDb 全量回写已删除，P1）', async () => {
  const store = new PaperStore();
  try {
    await store.whenReady();
    const r = await store.persistUid('zhengwj');
    assert.equal(r.ok, true);
    assert.equal(r.persisted, true, 'mock DB 下必须报 persisted:true');
    assert.ok(
      seen.some((s) => s.includes('INSERT INTO paper_state') && s.includes('RETURNING updated_at')),
      'UPSERT 必须带 RETURNING updated_at（响应返回前落库的关键）',
    );
    assert.ok(typeof store.dirtyAt.zhengwj === 'number', 'persistUid 后 dirtyAt 应为 DB 时钟');
  } finally {
    clearInterval(store.timer);
  }
});

test('persistUid：DB 故障 ⇒ 显式降级 persisted:false 并进入重试队列；恢复后 retryDbFlush 出队（不抛 500、不静默）', async () => {
  const store = new PaperStore();
  const realQuery = db.query;
  try {
    await store.whenReady();
    db.query = async () => { throw new Error('mock: DB 不可用'); };
    const r = await store.persistUid('zhengwj');
    assert.equal(r.ok, false);
    assert.equal(r.persisted, false, '失败必须显式报 persisted:false');
    assert.ok(store.dbRetry.has('zhengwj'), '失败 uid 应进入 60s 重试队列');
    // 恢复 DB ⇒ retryDbFlush 重试成功出队
    db.query = realQuery;
    store.retryDbFlush();
    await new Promise((r2) => setTimeout(r2, 10));
    assert.ok(!store.dbRetry.has('zhengwj'), '重试成功后应出队');
  } finally {
    db.query = realQuery;
    clearInterval(store.timer);
  }
});

test('persistUid：无 DB ⇒ ok:true + persisted:false（本地 JSON 已落盘，行为兼容旧版；文件后端无需 DB）', async () => {
  const store = new PaperStore();
  const realHasDb = db.hasDb;
  try {
    await store.whenReady();
    db.hasDb = () => false;
    const r = await store.persistUid('zhengwj');
    assert.equal(r.ok, true);
    assert.equal(r.persisted, false, '无 DB 时显式报 persisted:false（不假装已落库）');
    assert.ok(!store.dbRetry.size, '无 DB 是正常路径，不得进重试队列');
  } finally {
    db.hasDb = realHasDb;
    clearInterval(store.timer);
  }
});
