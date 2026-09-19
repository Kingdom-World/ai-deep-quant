// ─────────────────────────────────────────────────────────────
// L1.3 / L1.4：Agent 能力档位与 T3 管理员闸门（集成测试）
//
//   起隔离实例（PAPER_DATA_DIR + PORT 隔离，遵守项目「单实例锁」约定），
//   端到端验证三种身份：
//     · 未登录      → 401（被鉴权中间件挡住）
//     · 普通用户    → capabilities 中 platform 档不可用；直调 LLM 分支被 403 拒绝
//     · 管理员      → platform 档可用
//
//   ⚠️ 需要 SITE_PASSWORD 才能开启鉴权（AUTH_ENABLED 依赖它），故本测试显式注入。
// ─────────────────────────────────────────────────────────────
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 30517;
// ⚠️ 用户名规则为 2-20 位中英文/数字/下划线（见 auth.cjs createUser 校验）——
//    连字符不合法，曾因此导致 ensureBootstrapAdmin 静默失败。
const ADMIN_USER = 'wbtest_admin';
const ADMIN_PASS = 'wbtest-admin-pass-123';
const USER_NAME = 'wbtest_user';
const INVITE = 'wbtest-invite';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
process.env.PAPER_DATA_DIR = tmpDir;
// ⚠️ 必须同时隔离认证库：否则测试会读写真实 data/auth/users.json，
//    且真实用户库非空时 ensureBootstrapAdmin 会跳过，导致管理员登录失败。
process.env.AUTH_DATA_DIR = path.join(tmpDir, 'auth');
process.env.PORT = String(PORT);
process.env.SITE_USERNAME = ADMIN_USER;
process.env.SITE_PASSWORD = ADMIN_PASS;
process.env.INVITE_CODE = INVITE;
process.env.NO_MAINTAIN = '1'; // 不启动自检调度，避免测试期外部请求

let server;
let base;

/** 极简 http 客户端：返回 { status, json, cookies } */
function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 非 JSON 保持 null */ }
        const setCookie = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          json,
          cookie: setCookie ? setCookie.map((c) => c.split(';')[0]).join('; ') : null,
        });
      });
    });
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  // server/index.cjs 导出 app 但不自行 listen（require.main !== module），
  // 故这里拿到 app 后自行监听测试端口 —— 比起子进程干净，且能精确关闭。
  const app = require('../server/index.cjs');
  server = app.listen(PORT);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${PORT}`;
  assert.ok(base);
});

test.after(() => {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    // 主模块启动的定时器（策略引擎/资讯刷新等）会持有事件循环句柄；
    // 本文件是独立测试进程，关闭监听后直接退出，避免拖住整个测试套件。
    setTimeout(() => process.exit(0), 300).unref();
  });
});

// ── 未登录：被鉴权中间件拦截 ──

test('未登录访问 capabilities → 401', async () => {
  const r = await req('GET', '/api/agents/capabilities');
  assert.equal(r.status, 401);
});

// ── 管理员身份 ──

let adminCookie = null;

test('管理员登录成功（AUTH_ENABLED 已开启）', async () => {
  const r = await req('POST', '/api/auth/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, `登录应成功，实际：${JSON.stringify(r.json)}`);
  assert.ok(r.cookie, '应返回会话 Cookie');
  adminCookie = r.cookie;
});

test('管理员：capabilities 中 platform 档可用', async () => {
  const r = await req('GET', '/api/agents/capabilities', { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const platform = r.json.tiers.find((t) => t.key === 'platform');
  assert.ok(platform, '应含 platform 档');
  assert.equal(platform.available, true, '管理员应可用 platform 档');
});

// ── 普通用户身份 ──

let userCookie = null;

test('普通用户注册成功', async () => {
  const r = await req('POST', '/api/auth/register', {
    body: { username: USER_NAME, password: 'wbtest-user-pass-456', invite: INVITE },
  });
  assert.equal(r.status, 200, `注册应成功，实际：${JSON.stringify(r.json)}`);
  assert.equal(r.json.ok, true);
  userCookie = r.cookie;
  assert.ok(userCookie);
});

test('普通用户：capabilities 中 platform 档不可用，rule/byok 可用', async () => {
  const r = await req('GET', '/api/agents/capabilities', { cookie: userCookie });
  assert.equal(r.status, 200);
  const byKey = Object.fromEntries(r.json.tiers.map((t) => [t.key, t]));
  assert.equal(byKey.rule.available, true, 'rule 档应对所有用户开放');
  assert.equal(byKey.byok.available, true, 'byok 档应对所有用户开放');
  assert.equal(byKey.platform.available, false, 'platform 档对普通用户应不可用');
  assert.equal(byKey.platform.adminOnly, true);
});

test('普通用户：capabilities 透出 runtime 与 byok 提示（不得泄露 key 相关敏感信息）', async () => {
  const r = await req('GET', '/api/agents/capabilities', { cookie: userCookie });
  assert.ok(['node', 'serverless'].includes(r.json.runtime), `runtime 取值异常：${r.json.runtime}`);
  assert.ok(String(r.json.hints.byok).includes('不保存'), '应说明本站不保存用户 Key');
  assert.equal(JSON.stringify(r.json).includes('AI_CLOUD_API_KEY'), false, '不得透出服务端密钥名');
});

test('普通用户直调 /api/agents/analyze（平台 LLM 档）→ 403 且给出可用档位', async () => {
  const r = await req('POST', '/api/agents/analyze', {
    cookie: userCookie,
    body: { symbol: 'sh600519', mode: 'single' },
  });
  // 服务器若未配置 AI_CLOUD_API_KEY，会先走规则引擎分支（200 且 tier=rule）——
  // 这属于环境差异，两种情况都合法，但**绝不能**是走了 LLM 分支。
  if (r.status === 403) {
    assert.equal(r.json.tier, 'platform');
    assert.ok(String(r.json.error).includes('管理员'), '应明确说明仅管理员可用');
    assert.deepEqual(r.json.availableTiers, ['rule', 'byok'], '应指引可用档位');
  } else {
    assert.equal(r.json.tier, 'rule', '非 403 时必须是规则引擎档，绝不能是 LLM 档');
  }
});

test('普通用户直调 /api/agent/research → 503（未配置云模型）或 403（已配置时被闸门拦）', async () => {
  const r = await req('POST', '/api/agent/research', {
    cookie: userCookie,
    body: { question: '什么是 PIT' },
  });
  assert.ok([403, 503].includes(r.status), `应以 403 或 503 拒绝，实际 ${r.status}`);
  assert.equal(r.json.ok, false);
  assert.equal(String(r.json.answer || '').length, 0, '被拒时不得返回任何答案内容');
});

// ── 模式可用性声明（serverless 分支）──

test('capabilities 声明 modes：node 环境下各模式均可用', async () => {
  const r = await req('GET', '/api/agents/capabilities', { cookie: adminCookie });
  assert.ok(r.json.modes, '应含 modes 声明');
  // 本测试运行在 node 环境（非 Vercel），故所有模式应可用
  for (const [m, info] of Object.entries(r.json.modes)) {
    assert.equal(info.available, true, `node 环境下 ${m} 应可用`);
  }
});

test('capabilities 为纯声明：连续调用结果一致（无副作用）', async () => {
  const a = await req('GET', '/api/agents/capabilities', { cookie: adminCookie });
  const b = await req('GET', '/api/agents/capabilities', { cookie: adminCookie });
  assert.deepEqual(a.json, b.json, '两次结果应完全一致');
});
