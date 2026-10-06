// ─────────────────────────────────────────────────────────────
// 模型分享测试（shared/modelshare.cjs + server/modelstore.cjs + 路由闸门）
//
//   覆盖任务 #61 的六部分：状态机 / 角色闸门 / 脱敏 / 契约锁 / 存储层 / 路由级越权回归。
//
//   🔴 本文件最要紧的一条是「角色闸门」：owner 端点曾不校验动作角色，
//      而状态机是纯函数、不知调用者是谁 ⇒ 用户只要处于 pending 就能自己给自己过审。
//      端到端实测抓到过，这里用测试钉死。
//
//   ⚠️ 全部用合成数据，不需要归档、不需要 DB、不写仓库 data/。
// ─────────────────────────────────────────────────────────────
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠️ modelstore 在**模块加载时**读 MODEL_STORE_DIR ⇒ 必须先设再 require
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mshare-'));
process.env.MODEL_STORE_DIR = path.join(TMP, 'models');
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 清不掉不影响结论 */
  }
});

const S = require('../shared/modelshare.cjs');
const modelstore = require('../server/modelstore.cjs');
const ms = require('../shared/modelspec.cjs');
const fe = require('../server/factorexpr.cjs');

const NOW = '2026-10-06T00:00:00.000Z';
const V = (uid, isAdmin = false) => ({ uid, isAdmin });
const anon = null;

const doc = (over = {}) => ({
  id: 'm-20260101-abcdef',
  uid: 'alice',
  name: '测试模型',
  schemaVersion: 1,
  factors: [{ id: 'mom', expr: 'mom20', weight: 1, direction: 1 }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});
/** 依次应用动作，返回新 doc（不改入参） */
const evolve = (d, ...steps) => {
  let cur = { ...d };
  for (const [action, opts] of steps) {
    const r = S.applyShareAction(cur, action, { now: NOW, ...(opts || {}) });
    assert.ok(r.ok, `动作 ${action} 应当成功，实际：${r.error}`);
    cur = { ...cur, ...r.patch };
  }
  return cur;
};

// ═══ 一、状态机 ══════════════════════════════════════════════

test('① 默认私有：只有本人可见；admin 也不可见（最小权限）', () => {
  const d = doc();
  assert.strictEqual(S.shareOf(d).visibility, 'private');
  assert.strictEqual(S.shareOf(d).reviewState, 'none');
  assert.strictEqual(S.canView(d, anon), false, '匿名');
  assert.strictEqual(S.canView(d, V('alice')), true, '本人');
  assert.strictEqual(S.canView(d, V('bob')), false, '他人');
  assert.strictEqual(S.canView(d, V('admin1', true)), false, 'admin 不得翻看未申请公开的私有模型');
});

test('② 老数据无分享字段时归一化为私有（无需数据迁移）', () => {
  const d = doc({ visibility: '瞎写的', reviewState: 123 });
  const s = S.shareOf(d);
  assert.strictEqual(s.visibility, 'private');
  assert.strictEqual(s.reviewState, 'none');
});

test('③ 设为圈内：登录用户可见、匿名不可见', () => {
  const d = evolve(doc(), ['set-circle']);
  assert.strictEqual(S.shareOf(d).visibility, 'circle');
  assert.strictEqual(S.canView(d, anon), false);
  assert.strictEqual(S.canView(d, V('bob')), true);
});

test('④ 🔴 申请公开**不改可见性**（公开此刻还看不到）', () => {
  const d = evolve(doc(), ['set-circle'], ['request-public']);
  assert.strictEqual(S.shareOf(d).visibility, 'circle', 'visibility 必须仍是 circle');
  assert.strictEqual(S.shareOf(d).reviewState, 'pending');
  assert.strictEqual(S.canView(d, anon), false, '待审阶段匿名仍不可见');
  assert.strictEqual(S.canView(d, V('admin1', true)), true, 'admin 必须能看到待审模型，否则无从审核');
});

test('⑤ 审核通过后：visibility=public，匿名可见', () => {
  const d = evolve(doc(), ['set-circle'], ['request-public'], ['approve']);
  assert.strictEqual(S.shareOf(d).visibility, 'public');
  assert.strictEqual(S.shareOf(d).reviewState, 'approved');
  assert.strictEqual(S.shareOf(d).publishedAt, NOW, '通过时刻应被记录（供公开广场排序）');
  assert.strictEqual(S.canView(d, anon), true, '公开示例对匿名可见');
});

test('⑥ 驳回**不改可见性**（不降级也不误升级），理由截断到 200', () => {
  const d = evolve(doc(), ['set-circle'], ['request-public'], ['reject', { note: 'x'.repeat(500) }]);
  assert.strictEqual(S.shareOf(d).visibility, 'circle', '驳回后必须仍是 circle');
  assert.strictEqual(S.shareOf(d).reviewState, 'rejected');
  assert.strictEqual(S.shareOf(d).reviewNote.length, S.REVIEW_NOTE_MAX, '理由必须有界');
  assert.strictEqual(S.canView(d, V('bob')), true, '驳回后圈内可见性不受影响');
});

test('⑦ 撤回为私有：分享状态全部归零', () => {
  const d = evolve(doc(), ['set-circle'], ['request-public'], ['approve'], ['set-private']);
  const s = S.shareOf(d);
  assert.deepStrictEqual(
    { v: s.visibility, r: s.reviewState, note: s.reviewNote, req: s.requestedAt, pub: s.publishedAt },
    { v: 'private', r: 'none', note: '', req: null, pub: null },
  );
  assert.strictEqual(S.canView(d, anon), false, '撤回后立刻对匿名不可见');
});

test('⑧ 非法状态转换一律拒绝（不得静默通过）', () => {
  const cases = [
    ['approve', doc(), '无 pending 时 approve'],
    ['reject', doc(), '无 pending 时 reject'],
    ['withdraw-request', doc(), '无 pending 时 withdraw'],
    ['request-public', doc(), '已 approved 时再申请'],
  ];
  for (const [action, d, label] of cases) {
    if (label === '已 approved 时再申请') {
      const ok = evolve(doc(), ['set-circle'], ['request-public'], ['approve']);
      const r = S.applyShareAction(ok, action, { now: NOW });
      assert.strictEqual(r.ok, false, label);
      continue;
    }
    const r = S.applyShareAction(d, action, { now: NOW });
    assert.strictEqual(r.ok, false, `${label} 应被拒绝`);
    assert.ok(r.error && r.error.length > 0, '失败必须带原因');
  }
  assert.strictEqual(S.applyShareAction(doc(), '乱写的动作', {}).ok, false, '未知动作');
  assert.strictEqual(S.applyShareAction(doc(), '', {}).ok, false, '空动作');
  assert.strictEqual(S.applyShareAction(doc(), null, {}).ok, false, 'null 动作');
});

test('⑨ effectiveVisibility 防御：数据被改坏时按更保守的私有处理', () => {
  const bad = doc({ visibility: 'public', reviewState: 'none' });
  assert.strictEqual(S.effectiveVisibility(bad), 'private', 'public 但未过审 ⇒ 按私有');
  assert.strictEqual(S.canView(bad, anon), false, '坏数据不得让内容外泄');
});

// ═══ 二、🔴 角色闸门（端到端实测抓到的真漏洞）═════════════════

test('🔴 actionBy：审核类动作归属 admin，其余归属 owner，未知为 null', () => {
  assert.strictEqual(S.actionBy('approve'), 'admin');
  assert.strictEqual(S.actionBy('reject'), 'admin');
  assert.strictEqual(S.actionBy('set-circle'), 'owner');
  assert.strictEqual(S.actionBy('request-public'), 'owner');
  assert.strictEqual(S.actionBy('乱写'), null);
  assert.strictEqual(S.actionBy(''), null);
});

test('🔴 OWNER_ACTIONS 与 ADMIN_ACTIONS 必须互补且无交集', () => {
  assert.deepStrictEqual([...S.OWNER_ACTIONS].filter((a) => S.ADMIN_ACTIONS.includes(a)), [], '不得有交集');
  assert.deepStrictEqual(
    [...S.OWNER_ACTIONS, ...S.ADMIN_ACTIONS].sort(),
    Object.keys(S.ACTIONS).sort(),
    '两组并集必须等于全部动作（新增动作漏进任一组 ⇒ 闸门会放行或误拒）',
  );
  // 每个动作的 by 字段必须与所在分组一致
  for (const a of S.OWNER_ACTIONS) assert.strictEqual(S.ACTIONS[a].by, 'owner', `${a} 标注不一致`);
  for (const a of S.ADMIN_ACTIONS) assert.strictEqual(S.ACTIONS[a].by, 'admin', `${a} 标注不一致`);
});

test('🔴 状态机本身**不**阻止 owner 自审（这正是必须有路由闸门的原因）', () => {
  // 这条断言是"为什么要闸门"的证据：若哪天状态机自己挡住了，说明该加的防御在纯函数里，值得记一笔
  const pending = evolve(doc(), ['set-circle'], ['request-public']);
  const r = S.applyShareAction(pending, 'approve', { now: NOW });
  assert.strictEqual(r.ok, true, '纯函数不知道调用者是谁，故会放行 —— 身份校验必须在路由层');
});

// ═══ 三、脱敏（🔴 公开仓库/公网红线）═════════════════════════

test('🔴 shareView 绝不含 uid / ip / 任意存储字段', () => {
  const d = doc({ secret: 'LEAK-ME', uid: 'ip:10.0.0.7' });
  const v = S.shareView(d, { author: S.authorNameOf(d.uid), modelHash: 'h'.repeat(64), includeReview: true });
  const json = JSON.stringify(v);
  assert.ok(!json.includes('LEAK-ME'), '白名单外的存储字段不得出现在分享物里');
  assert.ok(!/"uid"/.test(json), '分享物不得含 uid 键');
  assert.ok(!json.includes('ip:'), '不得外露 IP 形态的 uid');
  assert.strictEqual(v.author, '匿名用户');
  assert.deepStrictEqual(Object.keys(v.model).sort(), [...S.MODEL_FIELDS].filter((k) => k in d).sort());
});

test('🔴 authorNameOf：ip: 前缀一律脱敏为「匿名用户」', () => {
  assert.strictEqual(S.authorNameOf('ip:1.2.3.4'), '匿名用户', 'IP 绝不外露（未启用鉴权时 uid 就是 IP）');
  assert.strictEqual(S.authorNameOf('ip:'), '匿名用户');
  assert.strictEqual(S.authorNameOf(''), '匿名用户');
  assert.strictEqual(S.authorNameOf(null), '匿名用户');
  assert.strictEqual(S.authorNameOf('default'), '本机');
  assert.strictEqual(S.authorNameOf('alice'), 'alice', '用户名可展示（归属可追溯是计划书要求）');
});

test('shareSummary：effective 字段如实反映"当前真正生效"的档位', () => {
  const pending = evolve(doc(), ['set-circle'], ['request-public']);
  const s = S.shareSummary(pending, { author: 'alice', includeReview: true });
  assert.strictEqual(s.visibility, 'circle');
  assert.strictEqual(s.effective, 'circle', 'pending 不改变生效档位');
  assert.strictEqual(s.reviewState, 'pending');
  const bad = doc({ visibility: 'public', reviewState: 'none' });
  assert.strictEqual(S.shareSummary(bad).effective, 'private', '坏数据按私有报');
  assert.strictEqual(S.shareSummary({ id: 'x', name: 'y' }).factorCount, null, '无正文时因子数报 null 而不是 0');
});

// ═══ 四、契约锁 ══════════════════════════════════════════════

test('🔴 MODEL_FIELDS 必须与 modelspec 的规范化产出同源（防两处分叉）', () => {
  const r = ms.normalizeModel(
    { schemaVersion: 1, name: '契约锁', factors: [{ id: 'mom', expr: 'mom20', weight: 1, direction: 1 }], meta: { author: 'tester' } },
    { parseExpr: fe.parseExpression },
  );
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual(
    [...S.MODEL_FIELDS].sort(),
    Object.keys(r.model).sort(),
    '分享物白名单与模型规范字段不一致 —— 将来 modelspec 改字段会静默漏字段或漏脱敏',
  );
});

test('🔴 .mjs 转发壳与 .cjs 实现同源（前端按 .mjs 导入，行为必须一致）', async () => {
  const m = await import('../shared/modelshare.mjs');
  assert.deepStrictEqual(m.OWNER_ACTIONS, S.OWNER_ACTIONS);
  assert.deepStrictEqual(m.ADMIN_ACTIONS, S.ADMIN_ACTIONS);
  const d = evolve(doc(), ['set-circle'], ['request-public']);
  assert.deepStrictEqual(m.shareOf(d), S.shareOf(d));
  assert.deepStrictEqual(m.shareView(d, { author: 'x' }), S.shareView(d, { author: 'x' }));
  assert.strictEqual(m.actionBy('approve'), S.actionBy('approve'));
});

// ═══ 五、存储层 ══════════════════════════════════════════════

const MODEL = () => ({
  schemaVersion: 1,
  name: '存储层测试',
  factors: [{ id: 'mom', expr: 'mom20', weight: 1, direction: 1 }],
  meta: { author: 'tester' },
});

test('存储层：新建默认私有/未申请', async () => {
  const r = await modelstore.save('alice', MODEL());
  assert.strictEqual(r.ok, true, r.error);
  const d = await modelstore.getRaw(r.id);
  assert.strictEqual(d.visibility, 'private');
  assert.strictEqual(d.reviewState, 'none');
  assert.strictEqual((await modelstore.listShared({ scope: 'public' })).length, 0, '私有模型不得进公开广场');
});

test('🔴 存储层：覆盖保存必须继承可见性（改个参数不该悄悄下架）', async () => {
  const r = await modelstore.save('bob', { ...MODEL(), name: '继承测试' });
  await modelstore.setShareState(r.id, 'bob', { visibility: 'circle', reviewState: 'none' });
  const again = await modelstore.save('bob', { ...MODEL(), name: '继承测试v2' }, r.id);
  assert.strictEqual(again.ok, true, again.error);
  const d = await modelstore.getRaw(r.id);
  assert.strictEqual(d.name, '继承测试v2', '模型语义字段应更新');
  assert.strictEqual(d.visibility, 'circle', '🔴 可见性必须继承，不得被重置为 private');
});

test('存储层：setShareState 越权 ⇒ 报"不存在"（不泄露存在性）', async () => {
  const r = await modelstore.save('carol', MODEL());
  const bad = await modelstore.setShareState(r.id, 'dave', { visibility: 'public' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, '模型不存在', '越权与不存在必须同样报，否则可探测他人 id');
  assert.strictEqual((await modelstore.getRaw(r.id)).visibility, 'private', '越权写入不得生效');
});

test('存储层：patch 白名单 —— 分享操作改不了模型语义字段', async () => {
  const r = await modelstore.save('erin', MODEL());
  const res = await modelstore.setShareState(r.id, 'erin', { visibility: 'circle', reviewState: 'none', name: '被篡改' });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual((await modelstore.getRaw(r.id)).name, '存储层测试', 'name 不在白名单内，必须被忽略');
  const empty = await modelstore.setShareState(r.id, 'erin', { 不存在的键: 1 });
  assert.strictEqual(empty.ok, false, '无有效字段应显式拒绝');
});

test('存储层：listShared 三档互斥（circle 不进 public、pending 不进任何广场）', async () => {
  const r = await modelstore.save('frank', { ...MODEL(), name: '互斥测试' });
  await modelstore.setShareState(r.id, 'frank', { visibility: 'circle', reviewState: 'none' });
  assert.strictEqual((await modelstore.listShared({ scope: 'circle' })).some((x) => x.id === r.id), true);
  assert.strictEqual((await modelstore.listShared({ scope: 'public' })).some((x) => x.id === r.id), false);

  await modelstore.setShareState(r.id, 'frank', { reviewState: 'pending', requestedAt: NOW });
  assert.strictEqual((await modelstore.listShared({ scope: 'pending' })).some((x) => x.id === r.id), true, '待审应进队列');
  assert.strictEqual((await modelstore.listShared({ scope: 'public' })).some((x) => x.id === r.id), false, '🔴 待审绝不进公开广场');

  await modelstore.setShareState(r.id, 'frank', { visibility: 'public', reviewState: 'approved', publishedAt: NOW });
  assert.strictEqual((await modelstore.listShared({ scope: 'public' })).some((x) => x.id === r.id), true, '过审后应进公开');
  assert.strictEqual((await modelstore.listShared({ scope: 'circle' })).some((x) => x.id === r.id), false, '公开档不应重复出现在圈内');
});

test('存储层：list() 返回行带可见性（前端模型库要渲染徽章）', async () => {
  const r = await modelstore.save('gina', { ...MODEL(), name: '列表测试' });
  await modelstore.setShareState(r.id, 'gina', { visibility: 'circle', reviewState: 'none' });
  const row = (await modelstore.list('gina')).find((x) => x.id === r.id);
  assert.ok(row, '本人列表应含该模型');
  assert.strictEqual(row.visibility, 'circle');
  assert.strictEqual(row.reviewState, 'none');
});

// ═══ 六、路由级闸门（端到端抓到的漏洞，钉在这里）═════════════

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
    delete: (p, h) => routes.set(`DELETE ${p}`, h),
  };
}
function fakeRes() {
  // Express 里 res.json() 不显式设状态码时就是 200；这里对齐该语义，
  // 否则成功路径的 statusCode 会是 null，断言 200 反而失败。
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const shareApp = (isAdmin = false) => {
  const app = fakeApp();
  require('../server/routes/models.cjs').registerModelRoutes(app, {
    modelrun: require('../server/modelrun.cjs'),
    modelspec: ms,
    modelstore,
    modelexp: {},
    validation: {},
    uidOf: (req) => (req && req.user && req.user.username) || 'ip:127.0.0.1',
    isAdmin: () => isAdmin,
    IS_VERCEL: false,
  });
  return app;
};
const hit = async (app, key, { id, body, user } = {}) => {
  const h = app.routes.get(key);
  assert.ok(h, `路由未注册：${key}`);
  const res = fakeRes();
  await h({ body: body || {}, params: { id }, query: {}, user: user ? { username: user } : undefined }, res);
  return res;
};

test('🔴 路由：owner 走 /share 传 approve ⇒ 400，且模型仍 pending、未外流', async () => {
  const app = shareApp(false);
  const created = await hit(app, 'POST /api/models', { body: { model: { ...MODEL(), name: '越权自审' } } });
  assert.strictEqual(created.body.ok, true, created.body.error);
  const id = created.body.id;

  const req = await hit(app, `POST /api/models/:id/share`, { id, body: { action: 'request-public' } });
  assert.strictEqual(req.statusCode, 200, JSON.stringify(req.body));
  assert.strictEqual(req.body.share.reviewState, 'pending');

  // 🔴 越权自审：owner 试图自己批准
  const atk = await hit(app, `POST /api/models/:id/share`, { id, body: { action: 'approve' } });
  assert.strictEqual(atk.statusCode, 400, '审核类动作不得从 owner 端点通过');
  assert.match(atk.body.error, /不允许|管理员/);

  const after = await modelstore.getRaw(id);
  assert.strictEqual(S.shareOf(after).reviewState, 'pending', '🔴 状态必须仍是 pending');
  assert.strictEqual(S.shareOf(after).visibility, 'private', '🔴 可见性不得被改动');
  const pub = await hit(app, 'GET /api/models/public');
  assert.strictEqual(pub.body.items.some((x) => x.id === id), false, '🔴 绝不能出现在公开广场');
});

test('路由：admin 过审后模型进公开广场；驳回则不进', async () => {
  const adminApp = shareApp(true);
  const created = await hit(adminApp, 'POST /api/models', { body: { model: { ...MODEL(), name: '审核流' } } });
  const id = created.body.id;

  await hit(adminApp, `POST /api/models/:id/share`, { id, body: { action: 'set-circle' } });
  await hit(adminApp, `POST /api/models/:id/share`, { id, body: { action: 'request-public' } });

  const q1 = await hit(adminApp, 'GET /api/models/review-queue');
  assert.strictEqual(q1.body.items.some((x) => x.id === id), true, '待审队列应含它');

  const rej = await hit(adminApp, `POST /api/models/:id/review`, { id, body: { action: 'reject', note: '不合规' } });
  assert.strictEqual(rej.statusCode, 200, JSON.stringify(rej.body));
  assert.strictEqual(rej.body.share.visibility, 'circle', '驳回不改可见性');
  assert.strictEqual((await hit(adminApp, 'GET /api/models/public')).body.items.some((x) => x.id === id), false);

  await hit(adminApp, `POST /api/models/:id/share`, { id, body: { action: 'request-public' } });
  const ok = await hit(adminApp, `POST /api/models/:id/review`, { id, body: { action: 'approve' } });
  assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.share.visibility, 'public');

  const pub = await hit(adminApp, 'GET /api/models/public');
  const item = pub.body.items.find((x) => x.id === id);
  assert.ok(item, '过审后应出现在公开广场');
  const raw = JSON.stringify(pub.body);
  assert.ok(!/"uid"/.test(raw) && !raw.includes('ip:'), '🔴 广场响应不得外露 uid/IP');
  const detail = await hit(adminApp, 'GET /api/models/public/:id', { id });
  assert.strictEqual(detail.statusCode, 200);
  assert.strictEqual(detail.body.view.name, '审核流');
});

test('路由：非管理员访问待审队列 ⇒ 403；owner 改他人模型 ⇒ 404', async () => {
  const userApp = shareApp(false);
  const q = await hit(userApp, 'GET /api/models/review-queue');
  assert.strictEqual(q.statusCode, 403, '非管理员不得看待审队列');

  const victim = await modelstore.save('victim', { ...MODEL(), name: '受害者' });
  const atk = await hit(userApp, 'POST /api/models/:id/share', {
    id: victim.id,
    body: { action: 'set-circle' },
    user: 'attacker',
  });
  assert.strictEqual(atk.statusCode, 404, '越权必须报"不存在"而非"无权限"');
  assert.strictEqual(S.shareOf(await modelstore.getRaw(victim.id)).visibility, 'private', '越权写入不得生效');
});

test('路由：公开详情只给已过审公开模型（未过审/非公开一律 404）', async () => {
  const app = shareApp(true);
  const created = await hit(app, 'POST /api/models', { body: { model: { ...MODEL(), name: '详情闸门' } } });
  const id = created.body.id;
  // 🔴 fakeApp 的 key 是注册时的字面量（:id），不做路径替换 ⇒ 断言要打在 '.../:id' 上
  const pubGet = () => hit(app, 'GET /api/models/public/:id', { id });
  assert.strictEqual((await pubGet()).statusCode, 404, '私有模型不得从公开口读到');
  await hit(app, `POST /api/models/:id/share`, { id, body: { action: 'request-public' } });
  assert.strictEqual((await pubGet()).statusCode, 404, '🔴 待审不得从公开口读到');
  await hit(app, `POST /api/models/:id/review`, { id, body: { action: 'approve' } });
  assert.strictEqual((await pubGet()).statusCode, 200, '过审后可读');
});
