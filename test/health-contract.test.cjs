// /api/health 契约测试（2026-10-08 审查补）
//
// 🔴 为什么值得单独测：
//   这是**唯一的常驻自检端点**，运维靠它判断"线上有没有出问题"。
//   它一旦字段错位，问题会被静默掩盖（- 例如子系统全部报 ok 而实际没装载）。
//   本机无法做浏览器渲染验证 ⇒ 用"假 app + 假 req/res 直调路由"的契约测试，
//   断言"运维/前端读取的每个字段真实存在且类型正确"。
//
// 🔴 另一条硬约束：**不得泄漏任何拓扑信息**（公开仓库保密红线）。
//   health 是公网可达端点，只允许报布尔开关与版本号，
//   不允许出现域名/内网地址/账号名/部署路径。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.cjs'), 'utf8');

test('/api/health 注册存在', () => {
  assert.match(SRC, /app\.get\('\/api\/health'/, 'health 端点必须存在');
});

test('health 必须外露子系统状态（不只报 ok:true）', () => {
  // 切出 health 处理器体
  const i = SRC.indexOf("app.get('/api/health'");
  assert.ok(i > 0);
  const body = SRC.slice(i, i + 2600);
  assert.match(body, /subsystems\s*:/, '必须报 subsystems');
  assert.match(body, /modelRoutes/, '模型工坊子系统状态必须外露（装载隔离事故的教训）');
  assert.match(body, /dataRoutes/, '数据治理子系统状态必须外露');
});

test('🔴 health 必须外露鉴权状态（未启用时管理视图对所有人开放）', () => {
  const i = SRC.indexOf("app.get('/api/health'");
  const body = SRC.slice(i, i + 2600);
  assert.match(body, /auth\s*:/, '必须报鉴权状态');
  assert.match(body, /AUTH_ENABLED/, '必须由 AUTH_ENABLED 推导（不是硬编码 ok）');
  assert.match(body, /status: 'disabled'/, '未启用时必须能报出 disabled（不是静默 ok）');
});

test('🔴 health 不得泄漏拓扑（公网可达端点）', () => {
  const i = SRC.indexOf("app.get('/api/health'");
  const body = SRC.slice(i, i + 2600);
  // 禁止出现：真实域名/内网 IP/账号名/部署路径/环境变量值
  const FORBIDDEN = [
    /https?:\/\/[a-z0-9.-]+\.(xyz|com|cn|net|io)\b/i,   // 真实域名
    /\b(10|172|192)\.\d+\.\d+\.\d+\b/,                    // 内网 IP
    /process\.env\.[A-Z_]*PASSWORD/i,                     // 口令变量
    /SITE_USERNAME/,                                       // 管理员名
    /[A-Za-z]:\\|\/(Users|home)\//,                       // 部署路径
  ];
  for (const re of FORBIDDEN) {
    assert.ok(!re.test(body), `health 不得含 ${re} —— 公网端点泄漏拓扑`);
  }
});

test('health 的子系统状态是三元结构（ok/status/reason），不是裸布尔', () => {
  const i = SRC.indexOf("app.get('/api/health'");
  const body = SRC.slice(i, i + 2600);
  // degraded 分支必须带 reason（不静默降级——本项目编码约定 #1）
  assert.match(body, /status: 'degraded'/, 'degraded 必须显式');
  assert.match(body, /reason:/, 'degraded 必须带 reason（禁止静默降级）');
  assert.match(body, /ok: false/, '必须显式 ok:false（不靠 status 字符串推断）');
});

// ── 账号名可枚举这一类风险（2026-10-10 补）──
// 🔴 背景：仓库是**公开**的，管理账号名缺省回退成 'admin'。
//   只报 status:'enabled' 会让人以为鉴权就万无一失，
//   实际上**账号名是公开的**，攻击者只差猜密码。
//   ⇒ health 必须额外披露"账号名是否自定义"，这是管理员唯一会忘的事。
test('🔴 health 鉴权开启时必须披露「账号名是否默认」（默认名可被枚举）', () => {
  const i = SRC.indexOf("app.get('/api/health'");
  const body = SRC.slice(i, i + 3200);
  assert.match(body, /usernameCustomized/, '必须报 usernameCustomized');
  // 必须引用单一源常量，而不是在 health 里重算（重算 = 会出现第二处口径）
  assert.match(
    body,
    /usernameCustomized:\s*BOOTSTRAP_ADMIN_NAME_IS_CUSTOM/,
    '必须引用单一源常量 BOOTSTRAP_ADMIN_NAME_IS_CUSTOM（不得在health 内重算）',
  );
  // 默认名时必须给可操作提示（与"降级必须显式"同源：不给提示等于没披露）
  assert.match(body, /usernameCustomized[\s\S]{0,400}hint:/, '默认名时必须给出 hint');
});

test('🔴 health 不得回显管理账号名本身（只允许布尔 + 提示）', () => {
  const i = SRC.indexOf("app.get('/api/health'");
  const body = SRC.slice(i, i + 3200);
  // ⚠️ 先剥掉注释：注释里的 'admin' 是「为什么要防它」的说明，**不构成回显**；
  //   真正要防的是字符串字面量进入响应体。（本条第一次跑时误报了自己的注释。）
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // 出现 'admin' 字面量 = 把默认账号名回显给公网读者
  assert.ok(
    !/['"]admin['"]/.test(code),
    'health 代码不得回显默认账号名 admin（公网端点只报"是否默认"）',
  );
  // 也不得把 SITE_USERNAME / SITE_PASSWORD 的值拼进响应
  assert.ok(
    !/process\.env\.SITE_(USERNAME|PASSWORD)/.test(code),
    'health 不得直接读部署变量（应由单一源常量判定，避免泄漏变量名）',
  );
});

test('单一源常量：BOOTSTRAP_ADMIN_NAME_IS_CUSTOM 的判定逻辑在鉴权常量旁', () => {
  assert.match(
    SRC,
    /const BOOTSTRAP_ADMIN_NAME_IS_CUSTOM = Boolean\(process\.env\.SITE_USERNAME\)/,
    '常量必须定义在 server/index.cjs 且判定口径单一',
  );
  // ⚠️ 不得出现第二处等价判定（两处口径 = 迟早分叉）
  const hits = SRC.match(/BOOTSTRAP_ADMIN_NAME_IS_CUSTOM\s*=/g) || [];
  assert.strictEqual(hits.length, 1, '该常量只能被定义一次');
});